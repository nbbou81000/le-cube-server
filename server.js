// =====================================================================
//  LE CUBE — serveur autonome (PC à la maison ou VPS loué)
//  Remplace Supabase : comptes, moteur de jeu (le même script SQL),
//  temps réel entre joueurs, sauvegardes, tunnel Internet gratuit,
//  musique de fond, statistiques détaillées et outils d'administration
//  accessibles depuis le jeu (👑 et 📊).
//
//  Windows : double-clic sur 2-DEMARRER.bat
//  VPS     : installé et lancé automatiquement par vps-installation.yaml
// =====================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { spawn, execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { WebSocketServer } from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));            // le programme
const STATE = path.resolve(process.env.LECUBE_DATA || DIR);          // la partie, les sauvegardes, les réglages
// 🧪 deuxième serveur sur le même PC : fichier instance.json à côté du programme ({"port": 8081, "tunnel": false, "name": "…"})
let INSTANCE = {};
try { INSTANCE = JSON.parse(fs.readFileSync(path.join(DIR, 'instance.json'), 'utf8')) || {}; } catch (e) {}
const PORT = +process.env.PORT || +INSTANCE.port || 8080;
const INSTANCE_NAME = String(INSTANCE.name || '').slice(0, 60);
const HOST = process.env.HOST || undefined;                          // VPS : 127.0.0.1 (accès seulement via le tunnel)
const STATUS_PORT = +process.env.STATUS_PORT || 0;                   // VPS : petite page « adresse du jeu » sur le port 80
const DATA = path.join(STATE, 'donnees');
const BACKUPS = path.join(STATE, 'sauvegardes');
const RESTORE = path.join(STATE, 'restaurer.tar.gz');
const TOKEN_FILE = path.join(STATE, 'tunnel-jeton.txt');
const ADDRESS_FILE = path.join(STATE, 'ADRESSE-DU-JEU.txt');
const MUSIC_DIR = path.join(STATE, 'musique');
const HISTORY_FILE = path.join(STATE, 'historique-serveur.json');
const VAPID_FILE = path.join(STATE, 'notifications-cles.json');         // clés des notifications sur téléphone (secrètes)
const REPLAY_DIR = path.join(STATE, 'rejeux');
const PHOTO_FILE = path.join(STATE, 'photo-du-cube.jpg');                // 🖼️ photo du thème « Ma photo »                          // 🎬 films des cubes (les 6 derniers)
const KEEP_BACKUPS = 10;
const GAME_VERSION = '15.4';
const UPDATE_NOTE = 'Nouveaux bruitages au choix dans ⚙️ › Son : sons d’origine du jeu ou pack de l’organisateur.';
const PREV_DIR = path.join(STATE, 'version-precedente');                // 📦 copie de la version d'avant une mise à jour
const UPDATE_FLAG = path.join(STATE, 'mise-a-jour-en-cours.json');
// Ce qu'une mise à jour a le droit de remplacer (jamais la partie, les sauvegardes, la musique, les films, la photo, les clés)
const UPDATABLE = /^(server\.js|schema\.sql|package\.json|package-lock\.json|LISEZ-MOI\.txt|NOUVEAUTES\.txt|public\/[^\0]+|node_modules\/[^\0]+)$/;
const STARTED = Date.now();
fs.mkdirSync(STATE, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleTimeString('fr-FR'), ...a);
let PGLITE_VERSION = '?';
try { PGLITE_VERSION = JSON.parse(fs.readFileSync(path.join(DIR, 'node_modules/@electric-sql/pglite/package.json'), 'utf8')).version; } catch (e) {}

// ---------- Base de données (Postgres intégré, stocké dans le dossier « donnees ») ----------
const STUB = `
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
create schema if not exists auth; create schema if not exists storage; create schema if not exists realtime;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb,
  password_hash text, created_at timestamptz not null default now());
create table if not exists auth.sessions (
  token_hash text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now());
alter table auth.sessions add column if not exists last_used timestamptz not null default now();
alter table auth.users add column if not exists email_verified_at timestamptz;
create or replace function auth.uid() returns uuid language sql stable as
  $f$ select nullif(current_setting('lecube.uid', true), '')::uuid $f$;
create table if not exists storage.buckets (id text primary key, name text, public boolean);
create table if not exists storage.objects (id serial primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
create table if not exists realtime.messages (id serial primary key, topic text);
alter table realtime.messages enable row level security;`;

log('Démarrage du moteur de jeu…');
// Restauration : si le dossier « donnees » n'existe pas et qu'un fichier restaurer.tar.gz est présent
let db;
if (!fs.existsSync(DATA) && fs.existsSync(RESTORE)) {
  log('Restauration de la sauvegarde restaurer.tar.gz…');
  db = await PGlite.create(DATA, { loadDataDir: new Blob([fs.readFileSync(RESTORE)]) });
  fs.renameSync(RESTORE, path.join(STATE, `restaurer-FAIT-${stamp()}.tar.gz`));
  log('✅ Sauvegarde restaurée.');
} else {
  if (fs.existsSync(RESTORE)) log('⚠️  restaurer.tar.gz ignoré : renomme d’abord le dossier « donnees » (voir le guide).');
  db = await PGlite.create(DATA);
}
await db.exec(STUB);
try { await db.exec(fs.readFileSync(path.join(DIR, 'schema.sql'), 'utf8')); }
catch (e) {
  // 📦 une mise à jour qui empêche le démarrage est annulée toute seule (la version d'avant revient)
  log('❌ Le moteur de jeu n’a pas pu démarrer :', e.message);
  if (fs.existsSync(UPDATE_FLAG) && rollbackFiles()) { log('↩️  Mise à jour annulée : retour à la version d’avant, redémarrage…'); fs.rmSync(UPDATE_FLAG, { force: true }); process.exit(1); }
  throw e;
}
// démarrage réussi après une mise à jour : 30 s plus tard (le temps que les joueurs reviennent), on prévient tout le monde
let updateDone = null;
try { updateDone = JSON.parse(fs.readFileSync(UPDATE_FLAG, 'utf8')); } catch (e) {}
setTimeout(() => {
  fs.rmSync(UPDATE_FLAG, { force: true });
  if (!updateDone || updateDone.notified || updateDone.notify === false) return;
  const note = String(updateDone.note || UPDATE_NOTE || '').slice(0, 300);
  broadcastAll({ type: 'update_notice', version: GAME_VERSION, note });
  pushTo(null, FR_EN({ title: `🆕 Le Cube a été mis à jour (${GAME_VERSION})`, body: note || 'Viens voir les nouveautés !' },
                     { title: `🆕 The Cube has been updated (${GAME_VERSION})`, body: note || 'Come and see what’s new!' }), { tag: 'maj' }).catch(() => {});
  log(`🔔 Joueurs prévenus de la mise à jour ${GAME_VERSION}`);
}, 30e3).unref();
// les sessions inutilisées depuis plus de 6 mois sont effacées
await db.query("delete from auth.sessions where last_used < now() - interval '180 days'").catch(() => {});
log('Moteur prêt.');

// Un seul accès à la base à la fois. PGlite n'a qu'une connexion : sans ce verrou, une petite requête
// (connexion, inscription…) pourrait se glisser au milieu de la transaction d'un autre joueur
// et être annulée avec elle si celle-ci échoue.
let dbChain = Promise.resolve(), dbBusySince = 0, dbWaiting = 0;
function exclusive(fn) {
  dbWaiting++;
  const run = dbChain.then(async () => { dbWaiting--; dbBusySince = performance.now(); try { return await fn(); } finally { dbBusySince = 0; } },
                           async () => { dbWaiting--; dbBusySince = performance.now(); try { return await fn(); } finally { dbBusySince = 0; } });
  dbChain = run.then(() => {}, () => {});
  return run;
}
const sql = (text, params, opts) => exclusive(() => db.query(text, params, opts));

function stamp() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}h${z(d.getMinutes())}`;
}

// Fonctions appelables depuis le jeu (les fonctions internes « _… » ne le sont jamais)
const RPC = new Set(['me', 'game_state', 'get_blocks', 'hit_blocks', 'use_artifact', 'get_inventory', 'give_item',
  'give_artifact', 'get_leaderboard', 'get_treasure', 'set_treasure', 'admin_players', 'admin_set_status',
  'admin_new_cube', 'admin_artifacts', 'admin_add_artifacts', 'admin_remove_artifacts', 'admin_set_inventory',
  'admin_set_config', 'admin_set_price', 'shop_buy', 'craft', 'market_list', 'market_create', 'market_cancel',
  'market_accept', 'get_missions', 'deliver_mission', 'reroll_mission',
  'chat_send', 'chat_list', 'admin_chat_delete', 'admin_chat_clear', 'admin_db_size',
  'admin_set_status_many', 'admin_limits', 'admin_set_limits', 'admin_pending_count',
  'set_profile', 'admin_set_week', 'admin_set_events', 'admin_start_event', 'admin_set_announce', 'week_board', 'admin_activity', 'admin_set_prize',
  // version 8
  'admin_events', 'admin_event_save', 'admin_event_delete', 'admin_event_start',
  'chat_report', 'mod_action', 'mod_player', 'mod_overview', 'mod_settings', 'mod_report_close', 'admin_badges',
  'set_pseudo', 'admin_set_pseudo', 'admin_auto_plan', 'admin_auto_apply', 'admin_set_traps',
  // version 9
  'admin_recipes', 'admin_set_recipe', 'admin_set_materials',
  // version 10
  'auction_list', 'auction_create', 'auction_bid', 'auction_cancel', 'pm_send', 'pm_threads', 'pm_list', 'pm_unread', 'pm_report',
  'chat_react', 'hall_list', 'admin_set_theme', 'admin_set_daily', 'push_subscribe', 'push_unsubscribe', 'player_levels', 'chat_delete_own', 'pm_delete_own',
  // version 12
  'daily_chest_open', 'buy_freeze', 'season_info', 'season_claim', 'my_style', 'set_badge', 'player_badges', 'admin_style_lib',
  'duel_create', 'duel_respond', 'duel_cancel', 'duel_state', 'admin_economy', 'admin_set_eco', 'global_board', 'admin_set_global_prize',
  // version 13 : robots
  'robot_info', 'robot_buy', 'robot_launch', 'admin_robots', 'admin_robot_save', 'admin_robot_delete', 'admin_robot_config', 'admin_robot_stop']);
const TABLE_FNS = new Set(['get_leaderboard', 'admin_players']);

async function callAs(uid, fn, args = {}) {
  return exclusive(() => db.transaction(async tx => {
    await tx.query("select set_config('lecube.uid', $1, true)", [uid || '']);
    if (TABLE_FNS.has(fn)) return (await tx.query(`select * from public.${fn}()`)).rows;
    const keys = Object.keys(args).filter(k => /^[a-z_]+$/.test(k));
    const q = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    return (await tx.query(q, keys.map(k => args[k] ?? null))).rows[0].r;
  }));
}

// ---------- Comptes ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const scrypt = promisify(crypto.scrypt);
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(pw, salt, 64)).toString('hex');
}
async function checkPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const test = await scrypt(pw, salt, 64);
  const ref = Buffer.from(h, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(test, ref);
}
async function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  await sql('insert into auth.sessions (token_hash, user_id) values ($1, $2)', [sha(token), uid]);
  return token;
}
// Jetons gardés en mémoire une minute : la base n'est pas interrogée à chaque requête
const tokCache = new Map();
async function userOf(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const h = sha(token), c = tokCache.get(h), now = Date.now();
  if (c && now - c.at < 60000) return c.uid;
  const r = await sql('update auth.sessions set last_used = now() where token_hash = $1 returning user_id', [h]);
  const uid = r.rows[0]?.user_id || null;
  tokCache.set(h, { uid, at: now });
  if (tokCache.size > 5000) tokCache.delete(tokCache.keys().next().value);
  return uid;
}
const forgetUser = uid => { for (const [h, c] of tokCache) if (c.uid === uid) tokCache.delete(h); meCache.delete(uid); };
// Profil (« me ») gardé 15 secondes
const meCache = new Map();
async function meOf(uid, fresh = false) {
  if (!uid) return null;
  const c = meCache.get(uid);
  if (!fresh && c && Date.now() - c.at < 15000) return c.me;
  const me = await callAs(uid, 'me').catch(() => null);
  meCache.set(uid, { me, at: Date.now() });
  return me;
}
const isBanned = me => !!(me && !me.is_admin && (me.banned_forever || (me.banned_until && new Date(me.banned_until) > new Date())));
const canPlay = me => !!(me && me.status === 'approved' && !isBanned(me));
async function isAdmin(token) {
  const me = await meOf(await userOf(token));
  return !!(me && me.is_admin && me.status === 'approved');
}

// ---------- Limiteurs (essais de mot de passe, inscriptions, requêtes) ----------
const buckets = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
const failed = (key, windowMs) => { const b = buckets.get(key); return b && Date.now() - b.start <= windowMs ? b.n : 0; };
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.start > 3600e3) buckets.delete(k); }, 600e3).unref();
const ipOf = req => String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '?').trim();

// ---------- 🛡️ Journal de sécurité : connexions, refus, actions sensibles (gardé sur le disque, 1 000 derniers) ----------
// Les adresses sont raccourcies (81.250.x.x) : assez pour repérer une même source, sans garder l'adresse complète.
const SEC_FILE = path.join(STATE, 'journal-securite.json');
let secLog = [];
try { secLog = JSON.parse(fs.readFileSync(SEC_FILE, 'utf8')); if (!Array.isArray(secLog)) secLog = []; } catch (e) {}
let secTimer = null;
const maskIp = ip => { ip = String(ip || '?').replace(/^::ffff:/, ''); if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…'; const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.x.x` : ip; };
const maskMail = e => { e = String(e || ''); const [u, d] = e.split('@'); return d ? `${u.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}` : '?'; };
function secEvent(type, req, info = {}) {
  const e = { at: Date.now(), type, ...info };
  if (req) { e.ip = maskIp(ipOf(req)); e.c = String(req.headers['cf-ipcountry'] || '').slice(0, 2); e.dev = deviceOf(req.headers['user-agent']); }
  secLog.push(e);
  if (secLog.length > 1000) secLog.splice(0, secLog.length - 1000);
  clearTimeout(secTimer);
  secTimer = setTimeout(() => { secTimer = null; try { fs.writeFileSync(SEC_FILE, JSON.stringify(secLog)); } catch (er) {} }, 5000);
}
process.on('exit', () => { if (secTimer) { try { fs.writeFileSync(SEC_FILE, JSON.stringify(secLog)); } catch (e) {} } });
// chemins inconnus demandés (404) : les plus fréquents sur 24 h
let notFound = new Map(), notFoundDay = Date.now();
function noteNotFound(p) {
  if (Date.now() - notFoundDay > 864e5) { notFound = new Map(); notFoundDay = Date.now(); }
  const k = String(p).slice(0, 80);
  if (notFound.size < 2000 || notFound.has(k)) notFound.set(k, (notFound.get(k) || 0) + 1);
}
const SEC_ADMIN_PATHS = { '/api/admin/update': 'Mise à jour du jeu installée', '/api/admin/restore': 'Sauvegarde restaurée', '/api/admin/dash-upload': 'Tableau de bord envoyé',
  '/api/admin/reset-password': 'Mot de passe d’un joueur changé', '/api/admin/delete-accounts': 'Comptes supprimés', '/api/admin/tunnel-token': 'Adresse du tunnel changée',
  '/api/admin/update-rollback': 'Retour à la version précédente', '/api/admin/download-backup': 'Sauvegarde téléchargée', '/api/admin/export-prepare': 'Copie complète préparée' };

// ---------- Outils d'administration du serveur ----------
let tunnelUrl = '', tunnelMode = 'aucun', tunnelOk = false, tunnelSince = null, tunnelDrops = 0;
function listBackups() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs.readdirSync(BACKUPS).filter(f => /^sauvegarde-.*\.tar\.gz$/.test(f)).sort()
    .map(f => { const s = fs.statSync(path.join(BACKUPS, f)); return { name: f, size: s.size, at: s.mtime.toISOString() }; });
}
function version() {
  try {
    const out = execFileSync('git', ['-C', DIR, 'log', '-1', '--format=%h|%cI'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [h, d] = out.split('|');
    return { ref: h, date: d };
  } catch (e) {
    try { return { ref: 'local', date: fs.statSync(path.join(DIR, 'server.js')).mtime.toISOString() }; } catch (e2) { return { ref: '?', date: null }; }
  }
}
const VERSION = version();
function diskInfo() {
  try { const s = fs.statfsSync(STATE); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch (e) { return null; }
}
function dirSize(d) {
  let n = 0;
  try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch (e) {}
  return n;
}
let dataSizeCache = { at: 0, v: 0 };
const dataSize = () => { if (Date.now() - dataSizeCache.at > 60000) dataSizeCache = { at: Date.now(), v: dirSize(DATA) }; return dataSizeCache.v; };

// ---------- 📊 Statistiques du serveur ----------
const ZERO = () => ({ http: 0, rpc: 0, rpcMs: 0, rpcMax: 0, hits: 0, rej: 0, ws: 0, wsOut: 0, bin: 0, bout: 0, logins: 0, loginFails: 0, signups: 0, err: 0, gc: 0, gcMs: 0, lat: [],
  s4xx: 0, s5xx: 0, s404: 0, s429: 0, wsDeny: 0, loginLock: 0 });
const total = ZERO();          // depuis le démarrage
let minute = ZERO();           // minute en cours
const count = (k, n = 1) => { total[k] += n; minute[k] += n; };
const rpcStats = new Map();    // par fonction : appels, erreurs, temps
const wsTypes = new Map();     // messages reçus par type
const httpCodes = { '2xx': 0, '4xx': 0, '5xx': 0 };
const errors = [];             // les 100 dernières erreurs
function noteError(where, msg) {
  count('err');
  errors.push({ at: new Date().toISOString(), where, msg: String(msg || '').slice(0, 300) });
  if (errors.length > 100) errors.shift();
}
function noteRpc(fn, ms, ok) {
  let s = rpcStats.get(fn);
  if (!s) { s = { n: 0, err: 0, ms: 0, max: 0, lat: new Float32Array(256), li: 0, ln: 0 }; rpcStats.set(fn, s); }
  s.n++; if (!ok) s.err++;
  s.ms += ms; s.max = Math.max(s.max, ms);
  s.lat[s.li] = ms; s.li = (s.li + 1) & 255; s.ln = Math.min(256, s.ln + 1);
  count('rpc'); count('rpcMs', ms); minute.rpcMax = Math.max(minute.rpcMax, ms);
  if (minute.lat.length < 5000) minute.lat.push(ms);
}
const quant = (arr, f) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * f))]; };
const playerStats = new Map(); // par joueur : coups, coups refusés, dernière action
function notePlayer(uid, hits, rej) {
  let p = playerStats.get(uid);
  if (!p) { p = { hits: 0, rej: 0, min: 0, minRej: 0, last: 0, cps: 0 }; playerStats.set(uid, p); }
  p.hits += hits; p.rej += rej; p.min += hits; p.minRej += rej; p.last = Date.now();
}
// retard de la boucle d'événements (si le serveur « rame », ce chiffre monte)
const LAG_RES = 10, eld = monitorEventLoopDelay({ resolution: LAG_RES }); eld.enable();
const lagMs = ns => Math.max(0, Math.round((ns / 1e6 - LAG_RES) * 10) / 10);
try {
  new PerformanceObserver(list => { for (const e of list.getEntries()) { count('gc'); count('gcMs', e.duration); } }).observe({ entryTypes: ['gc'] });
} catch (e) {}
const PEAK_FILE = path.join(STATE, 'stats-serveur.json');
let peak = { max: 0, at: null };
try { peak = JSON.parse(fs.readFileSync(PEAK_FILE, 'utf8')); } catch (e) {}
let peakToday = 0, peakDay = new Date().toDateString();
let cpuPct = 0, procPct = 0, corePct = [], cpuPrev = os.cpus(), procPrev = process.cpuUsage(), procPrevT = process.hrtime.bigint();
function sampleCpu() {
  const now = os.cpus();
  let idle = 0, tot = 0;
  corePct = now.map((c, k) => {
    const a = c.times, b = cpuPrev[k]?.times; if (!b) return 0;
    const t = (a.user + a.nice + a.sys + a.idle + a.irq) - (b.user + b.nice + b.sys + b.idle + b.irq);
    tot += t; idle += a.idle - b.idle;
    return t > 0 ? Math.round(100 * (1 - (a.idle - b.idle) / t)) : 0;
  });
  if (tot > 0) cpuPct = Math.max(0, Math.min(100, 100 * (1 - idle / tot)));
  cpuPrev = now;
  const pu = process.cpuUsage(), t = process.hrtime.bigint();
  const us = (pu.user + pu.system) - (procPrev.user + procPrev.system), el = Number(t - procPrevT) / 1000;
  if (el > 0) procPct = Math.max(0, Math.min(100, 100 * us / el / os.cpus().length));
  procPrev = pu; procPrevT = t;
}
setInterval(sampleCpu, 5000).unref();
const uniqueOnline = () => new Set([...clients.values()].map(c => c.id)).size;
function onlineIds() { return new Set([...clients.values()].filter(c => !c.admin).map(c => c.id)); }
function notePeak() {
  const n = uniqueOnline();
  const day = new Date().toDateString();
  if (day !== peakDay) { peakDay = day; peakToday = 0; }
  peakToday = Math.max(peakToday, n);
  if (n > peak.max) { peak = { max: n, at: new Date().toISOString() }; try { fs.writeFileSync(PEAK_FILE, JSON.stringify(peak)); } catch (e) {} }
}
// Historique : un relevé par minute sur 24 h, un relevé par 10 minutes sur 7 jours (gardés sur le disque)
let history = [], week = [];
try { const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); history = h.day || []; week = h.week || []; } catch (e) {}
const saveHistory = () => { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify({ day: history, week })); } catch (e) {} };
setInterval(() => {
  const mu = process.memoryUsage();
  history.push({ t: Date.now(), online: uniqueOnline(), cpu: Math.round(cpuPct), proc: Math.round(procPct),
    mem: Math.round(100 * (1 - os.freemem() / os.totalmem())), rss: Math.round(mu.rss / 1048576), heap: Math.round(mu.heapUsed / 1048576),
    hits: minute.hits, rej: minute.rej, rpc: minute.rpc, ms: minute.rpc ? Math.round(minute.rpcMs / minute.rpc) : 0,
    p95: Math.round(quant(minute.lat, 0.95)), max: Math.round(minute.rpcMax), bout: minute.bout + minute.wsOut, bin: minute.bin,
    lag: lagMs(eld.mean), lag99: Math.round(lagMs(eld.percentile(99))), ws: minute.ws, err: minute.err,
    gc: Math.round(minute.gcMs), bat: battery ? battery.pct : null, ac: battery ? battery.ac : null,
    lo: minute.logins, lf: minute.loginFails, ll: minute.loginLock, su: minute.signups, s4: minute.s4xx, s5: minute.s5xx, nf: minute.s404, rl: minute.s429, wd: minute.wsDeny });
  if (history.length > 1440) history.splice(0, history.length - 1440);
  eld.reset();
  for (const p of playerStats.values()) { p.cps = Math.round(p.min / 60 * 10) / 10; p.min = 0; p.minRej = 0; }
  minute = ZERO();
  // toutes les 10 minutes : un point pour la semaine, et sauvegarde sur le disque
  const last = history.slice(-10);
  if (new Date().getMinutes() % 10 === 0 && last.length) {
    const avg = k => Math.round(last.reduce((a, h) => a + (h[k] || 0), 0) / last.length);
    const sum = k => last.reduce((a, h) => a + (h[k] || 0), 0);
    const mx = k => Math.max(...last.map(h => h[k] || 0));
    week.push({ t: Date.now(), online: mx('online'), cpu: avg('cpu'), mem: avg('mem'), rss: avg('rss'), hits: sum('hits'), rpc: sum('rpc'),
      ms: avg('ms'), p95: mx('p95'), lag: mx('lag99'), bout: sum('bout'), err: sum('err'),
      lo: sum('lo'), lf: sum('lf'), s4: sum('s4'), s5: sum('s5'), nf: sum('nf'), rl: sum('rl'), wd: sum('wd'), rej: sum('rej') });
    if (week.length > 1008) week.splice(0, week.length - 1008);
    saveHistory();
  }
}, 60000).unref();
// Batterie (portable) : niveau et secteur, relu toutes les minutes sans bloquer le jeu
let battery = null;
function readBattery() {
  if (process.platform === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 15000 }, (err, out) => {
        if (err) return;
        try { const j = JSON.parse(String(out).trim() || 'null'); battery = j ? { pct: j.EstimatedChargeRemaining, ac: j.BatteryStatus !== 1 && j.BatteryStatus !== 4 && j.BatteryStatus !== 5 } : null; } catch (e) {}
      });
  } else if (process.platform === 'linux') {
    try {
      const dir = fs.readdirSync('/sys/class/power_supply').find(d => /^BAT/.test(d));
      if (!dir) { battery = null; return; }
      const r = f => fs.readFileSync(`/sys/class/power_supply/${dir}/${f}`, 'utf8').trim();
      battery = { pct: +r('capacity'), ac: r('status') !== 'Discharging' };
    } catch (e) { battery = null; }
  }
}
readBattery(); setInterval(readBattery, 60000).unref();
async function serverStatus() {
  const q = async (text) => { try { return (await sql(text)).rows[0]; } catch (e) { return {}; } };
  const acc = await q(`select count(*) filter (where status = 'approved' and not is_admin)::int approved,
    count(*) filter (where status = 'pending')::int pending, count(*) filter (where status = 'refused')::int refused from public.profiles`);
  const act = await q(`select count(*) filter (where last_seen > now() - interval '24 hours')::int d1,
    count(*) filter (where last_seen > now() - interval '7 days')::int d7 from public.stats`);
  const g = await q('select size, destroyed, max_online, max_players from public.game where id = 1');
  const cpus = os.cpus(), mu = process.memoryUsage(), bk = listBackups();
  const up = Math.round((Date.now() - STARTED) / 1000);
  const H = history.slice(-60);
  return {
    version: VERSION, node: process.version, platform: `${os.type()} ${os.release()}`, hostname: os.hostname(),
    started: new Date(STARTED).toISOString(), uptime_s: up, os_uptime_s: Math.round(os.uptime()),
    load: os.loadavg(), cpus: cpus.length, cpu_model: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim(),
    cpu_pct: Math.round(cpuPct), proc_pct: Math.round(procPct * 10) / 10,
    mem_total: os.totalmem(), mem_free: os.freemem(), rss: mu.rss, heap: mu.heapUsed,
    disk: diskInfo(), data_size: dataSize(), backups_size: bk.reduce((a, b) => a + b.size, 0),
    tunnel: { mode: tunnelMode, url: tunnelUrl, ok: tunnelOk, since: tunnelSince },
    players_online: uniqueOnline(), sockets: clients.size, queue: typeof waitQueue !== 'undefined' ? waitQueue.length : 0, instance: INSTANCE_NAME || null,
    guard: guardPublic(),
    peak_today: peakToday, peak: peak.max, peak_at: peak.at,
    accounts: acc, active: act, game: g,
    totals: { http: total.http, rpc: total.rpc, hits: total.hits, ws: total.ws, bytes_in: total.bin, bytes_out: total.bout + total.wsOut,
              logins: total.logins, signups: total.signups, rpc_avg_ms: total.rpc ? Math.round(10 * total.rpcMs / total.rpc) / 10 : 0 },
    last_minute: H[H.length - 1] || null,
    rpc_max_ms: Math.round(Math.max(minute.rpcMax, ...H.slice(-5).map(h => h.max || 0))),
    history: H, battery, backups: bk, vps: !!process.env.LECUBE_DATA,
    game_version: GAME_VERSION, prev_version: prevInfo(),
  };
}
// Mesures détaillées (📊) : base, joueurs, requêtes, système, journal des erreurs
let dbStatsCache = { at: 0, v: null };
async function dbStats() {
  if (dbStatsCache.v && Date.now() - dbStatsCache.at < 60000) return dbStatsCache.v;
  const t0 = performance.now();
  const tables = (await sql(`select n.nspname || '.' || c.relname as name, pg_total_relation_size(c.oid)::bigint as size, greatest(c.reltuples, 0)::bigint as rows
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'auth') and c.relkind = 'r'
    order by 2 desc limit 30`)).rows;
  // nombre exact de lignes (sauf les blocs, trop nombreux : estimation)
  const small = tables.filter(t => t.name !== 'public.blocks' && /^[a-z_.]+$/.test(t.name));
  if (small.length) {
    const r = (await sql(small.map((t, k) => `select ${k} as k, count(*)::bigint as n from ${t.name}`).join(' union all '))).rows;
    for (const x of r) small[x.k].rows = x.n;
  }
  const bt = tables.find(t => t.name === 'public.blocks');
  if (bt && !(+bt.rows > 0)) bt.rows = (await sql('select destroyed from public.game where id = 1')).rows[0]?.destroyed || 0;
  const one = (await sql(`select pg_database_size(current_database())::bigint as total,
    (select count(*) from public.chat)::int as chat, (select count(*) from public.profiles)::int as players,
    (select count(*) from public.artifacts where found_by is null)::int as hidden, (select count(*) from public.chests where opened_by is null)::int as chests,
    (select count(*) from auth.sessions)::int as sessions, (select destroyed from public.game where id = 1)::bigint as destroyed,
    (select size from public.game where id = 1) as size`)).rows[0];
  const layers = (await sql('select d, n from public.layer_done where n > 0 order by d')).rows;
  dbStatsCache = { at: Date.now(), v: { ...one, tables, layers, query_ms: Math.round(performance.now() - t0), vacuum: lastVacuum } };
  return dbStatsCache.v;
}
async function metrics() {
  const mu = process.memoryUsage(), cpus = os.cpus(), bk = listBackups();
  const rpc = [...rpcStats].map(([fn, s]) => {
    const lat = Array.from(s.lat.subarray(0, s.ln));
    return { fn, n: s.n, err: s.err, avg: s.n ? Math.round(s.ms / s.n * 10) / 10 : 0, p50: Math.round(quant(lat, 0.5)), p95: Math.round(quant(lat, 0.95)), max: Math.round(s.max), total_s: Math.round(s.ms / 100) / 10 };
  }).sort((a, b) => b.total_s - a.total_s);
  const conns = [...clients.values()].map(c => ({ id: c.id, pseudo: c.pseudo, admin: c.admin, mod: c.mod, since: c.since, country: c.country, device: c.device, msgs: c.msgs }));
  const players = [...playerStats].map(([id, p]) => ({ id, pseudo: pseudoCache.get(id) || '?', hits: p.hits, rej: p.rej, cps: p.cps, last: p.last }))
    .sort((a, b) => b.last - a.last).slice(0, 60);
  let dbs = null; try { dbs = await dbStats(); } catch (e) { noteError('stats base', e.message); }
  return {
    now: Date.now(), started: STARTED, version: VERSION, node: process.version, pglite: PGLITE_VERSION, platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(), cpu_model: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim(), cpus: cpus.length, cpu_mhz: cpus[0]?.speed || 0,
    cpu_pct: Math.round(cpuPct), proc_pct: Math.round(procPct * 10) / 10, cores: corePct, load: os.loadavg(),
    mem: { total: os.totalmem(), free: os.freemem(), rss: mu.rss, heap: mu.heapUsed, heap_total: mu.heapTotal, external: mu.external, buffers: mu.arrayBuffers },
    lag: { mean: lagMs(eld.mean), p50: lagMs(eld.percentile(50)), p99: lagMs(eld.percentile(99)), max: Math.round(lagMs(eld.max)) },
    db_busy_ms: dbBusySince ? Math.round(performance.now() - dbBusySince) : 0, db_waiting: dbWaiting,
    uptime_s: Math.round((Date.now() - STARTED) / 1000), os_uptime_s: Math.round(os.uptime()),
    handles: process.getActiveResourcesInfo ? process.getActiveResourcesInfo().length : null,
    disk: diskInfo(), data_size: dataSize(), music_size: dirSize(MUSIC_DIR), backups: bk, backups_size: bk.reduce((a, b) => a + b.size, 0), last_backup: lastBackup,
    battery, tunnel: { mode: tunnelMode, url: tunnelUrl, ok: tunnelOk, since: tunnelSince, drops: tunnelDrops },
    online: uniqueOnline(), sockets: clients.size, queue: typeof waitQueue !== 'undefined' ? waitQueue.length : 0, peak_today: peakToday, peak: peak.max, peak_at: peak.at,
    totals: { ...total, lat: undefined, rpc_avg_ms: total.rpc ? Math.round(10 * total.rpcMs / total.rpc) / 10 : 0 },
    minute: { ...minute, lat: undefined, p95: Math.round(quant(minute.lat, 0.95)) },
    http: httpCodes, rpc, ws: Object.fromEntries(wsTypes), conns, players, errors: errors.slice(-50).reverse(),
    blocks_cache: { ready: !!grid.data, size: grid.size, built_ms: grid.builtMs, gz: grid.gz ? grid.gz.length : 0, served: grid.served, deltas: grid.deltas },
    db: dbs, day: history, week,
    push: { on: !!webpush, ...pushSent, subs: Number((await sql('select count(*) n from public.push_subs').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) },
    replay: { id: replay.id, bytes: replay.bytes, files: replayList().length },
  };
}
// ---------- 🧪 Test de capacité : de faux joueurs qui frappent, sans rien changer à la partie ----------
// Chaque coup simulé est vraiment calculé par le moteur, puis annulé (ROLLBACK) : blocs, or, stats intacts.
let loadTest = null;
async function simulatedHit(uid, size) {
  const idx = [], n = [];
  for (let k = 0; k < 10; k++) { idx.push(Math.floor(Math.random() * size ** 3)); n.push(1); }
  return exclusive(() => db.transaction(async tx => {
    await tx.query("select set_config('lecube.uid', $1, true)", [uid]);
    await tx.query('update public.stats set hit_tokens = 40 where player = $1', [uid]);     // pas de limite pour le test
    await tx.query('select public.hit_blocks(idx => $1, n => $2, combo => 12) as r', [idx, n]);
    await tx.rollback();
  }));
}
async function runLoadTest(uid, steps, seconds) {
  const g = (await sql('select size from public.game where id = 1')).rows[0];
  const size = g?.size || 128;
  loadTest = { running: true, step: 0, steps, seconds, results: [], started: Date.now() };
  for (const bots of steps) {
    if (!loadTest.running) break;
    loadTest.step = bots;
    const lat = [], t0 = Date.now(), cpu0 = process.cpuUsage(), h0 = process.hrtime.bigint();
    const real = uniqueOnline();
    let sent = 0, done = 0, bytes = 0;
    const timers = [];
    for (let b = 0; b < bots; b++) {
      timers.push(setTimeout(function tick() {
        if (!loadTest.running || Date.now() - t0 > seconds * 1000) return;
        const s0 = performance.now(); sent++;
        simulatedHit(uid, size).then(() => { lat.push(performance.now() - s0); done++; }, () => {});
        // ce que coûterait le relais de ces coups vers tous les autres joueurs
        bytes += 140 * (bots + real - 1);
        timers.push(setTimeout(tick, 1000));
      }, Math.random() * 1000));
    }
    await new Promise(r => setTimeout(r, seconds * 1000 + 300));
    while (done < sent && Date.now() - t0 < seconds * 1000 + 15000) await new Promise(r => setTimeout(r, 100));
    timers.forEach(clearTimeout);
    const el = (Date.now() - t0) / 1000, cu = process.cpuUsage(cpu0), wall = Number(process.hrtime.bigint() - h0) / 1000;
    lat.sort((a, b) => a - b);
    const q = f => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * f))]) : 0;
    const r = { bots, batches_s: Math.round(done / el * 10) / 10, avg_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      p95_ms: q(0.95), max_ms: q(1), cpu_pct: Math.round(100 * (cu.user + cu.system) / wall), upload_mbit: Math.round(bytes * 8 / el / 1e5) / 10, lost: sent - done };
    loadTest.results.push(r);
    log(`🧪 Test : ${bots} faux joueurs → ${r.avg_ms} ms en moyenne, ${r.p95_ms} ms (95 %), processeur ${r.cpu_pct} %`);
    if (r.p95_ms > 600) break;                     // inutile d'aller plus loin : c'est déjà saturé
  }
  loadTest.running = false; loadTest.step = 0;
}

// Annonce aux joueurs connectés puis redémarre (systemd ou 2-DEMARRER.bat relancent le serveur)
function restartSoon(text, f) {
  const msg = JSON.stringify({ type: 'reload', text, f, delay: 15000 });
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(msg);
  setTimeout(() => stop(), 800);
}

// ---------- 🧊 Cube en mémoire : l'état de tous les blocs, prêt à être envoyé d'un coup ----------
// Un octet par bloc (255 = intact), compressé : même un cube 160³ à moitié détruit pèse quelques centaines de Ko,
// au lieu de plusieurs dizaines de Mo de texte. Tenu à jour avec les résultats des coups et des artefacts.
const grid = { data: null, size: 0, maxHp: 10, building: null, queue: null, gz: null, dirty: true, builtMs: 0, served: 0, gen: 0, deltas: 0 };
// Journal des derniers changements : un joueur qui revient après une pause ne reçoit que ce qui a changé
const LOG_N = 1 << 20, logI = new Int32Array(LOG_N), logV = new Uint8Array(LOG_N);
let logSeq = 0;                     // nombre total de changements notés depuis le chargement du cube
function gridPatch(i, v) {
  if (grid.queue) grid.queue.push(i, v);
  if (grid.data && i >= 0 && i < grid.data.length) {
    const b = Math.min(254, Math.max(0, v | 0));
    grid.data[i] = b; grid.dirty = true;
    logI[logSeq & (LOG_N - 1)] = i; logV[logSeq & (LOG_N - 1)] = b; logSeq++;
  }
}
// changements depuis « since » (null si trop ancien : il faudra tout renvoyer)
function gridDelta(since) {
  if (!(since >= 0) || since > logSeq || logSeq - since > LOG_N) return null;
  const n = logSeq - since, out = new Int32Array(n * 2);
  for (let k = 0; k < n; k++) { const j = (since + k) & (LOG_N - 1); out[2 * k] = logI[j]; out[2 * k + 1] = logV[j]; }
  return out;
}
function gridInvalidate() { grid.data = null; grid.gz = null; grid.dirty = true; grid.gen++; logSeq = 0; }
async function gridBuild() {
  if (grid.building) return grid.building;
  grid.building = (async () => {
    const t0 = performance.now(), gen = grid.gen;
    const g = (await sql('select size, max_hp, peeled from public.game where id = 1')).rows[0];
    const s = g.size, totalCells = s * s * s, data = new Uint8Array(totalCells).fill(255);
    grid.queue = [];
    const STEP = 1 << 19;                         // par morceaux : les joueurs peuvent jouer pendant ce temps
    for (let a = 0; a < totalCells; a += STEP) {
      const t = (await sql("select string_agg(i::text || ':' || hp::text, ',') as t from public.blocks where i >= $1 and i < $2", [a, a + STEP])).rows[0].t;
      if (!t) continue;
      let num = 0, idx = 0;
      for (let k = 0, L = t.length; k <= L; k++) {
        const c = k < L ? t.charCodeAt(k) : 44;
        if (c === 58) { idx = num; num = 0; }                       // ':'
        else if (c === 44) { if (idx < totalCells) data[idx] = Math.min(254, num); num = 0; }  // ','
        else num = num * 10 + (c - 48);
      }
    }
    const q = grid.queue; grid.queue = null;
    if (gen !== grid.gen) { grid.building = null; return gridBuild(); }          // le cube a changé pendant le chargement
    // couches arrachées par l'Écorce du Monde : détruites, même sans ligne dans la base
    for (let L = 0; L < (g.peeled || 0); L++) shellCells(s, L, i => { data[i] = 0; });
    for (let k = 0; k + 1 < q.length; k += 2) if (q[k] < totalCells) data[q[k]] = Math.min(254, q[k + 1]);
    logSeq = 0;
    Object.assign(grid, { data, size: s, maxHp: g.max_hp, gz: null, dirty: true, builtMs: Math.round(performance.now() - t0) });
    log(`Cube ${s}³ chargé en mémoire (${grid.builtMs} ms)`);
  })().finally(() => { grid.building = null; });
  return grid.building;
}
function gridGz() {
  if (!grid.gz || grid.dirty) { grid.gz = zlib.gzipSync(Buffer.from(grid.data.buffer, grid.data.byteOffset, grid.data.length), { level: 1 }); grid.dirty = false; }
  return grid.gz;
}
// tous les blocs de la couche L (0 = surface)
function shellCells(s, L, fn) {
  const a = L, b = s - 1 - L;
  if (a > b) return;
  for (let z = a; z <= b; z++) for (let y = a; y <= b; y++) {
    const row = y * s + z * s * s;
    if (z === a || z === b || y === a || y === b) for (let x = a; x <= b; x++) fn(x + row);
    else { fn(a + row); fn(b + row); }
  }
}
// la couche L entière vient d'être arrachée (🧅 Écorce du Monde)
function gridPeel(L) { if (grid.data) shellCells(grid.size, L, i => { if (grid.data[i] !== 0) gridPatch(i, 0); }); }

// ---------- 🎵 Musique de fond (mode radio : l'organisateur choisit, tout le monde entend la même chose) ----------
fs.mkdirSync(MUSIC_DIR, { recursive: true });
// 🔊 Pack de bruitages de l'organisateur : des WAV courts (préparés dans son navigateur), un dossier par… nom de fichier
//    pierre_brk_1a2b3c4d.wav = un son de casse de la pierre · _hit_ = un son de coup. Plusieurs variantes par matière.
const SFX_DIR = path.join(STATE, 'bruitages');
fs.mkdirSync(SFX_DIR, { recursive: true });
const SFX_MATS = ['pierre', 'brique', 'marbre', 'carrelage', 'lave', 'bois', 'planches', 'plastique', 'glace', 'cristal', 'gemme'];
const SFX_RE = /^([a-z]+)_(brk|hit|place)_([a-f0-9]{8})\.wav$/;
function sfxList() {
  let names = []; try { names = fs.readdirSync(SFX_DIR); } catch (e) {}
  return names.map(n => n.match(SFX_RE)).filter(m => m && SFX_MATS.includes(m[1]))
    .map(m => { let size = 0, at = 0; try { const st = fs.statSync(path.join(SFX_DIR, m[0])); size = st.size; at = st.mtimeMs; } catch (e) {} return { mat: m[1], ev: m[2], name: m[0], size, at }; })
    .sort((a, b) => a.at - b.at);
}
// 📦 pack de départ livré avec le jeu (public/pack-depart), rangé par groupes (pierre, bois…) : chaque groupe n'est
//    installé qu'une fois ; ensuite l'organisateur en fait ce qu'il veut (un son retiré ne revient pas tout seul).
function sfxStarter(force) {
  const dir = path.join(DIR, 'public', 'pack-depart'), mark = path.join(SFX_DIR, '.pack-depart');
  let man; try { man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { return 0; }
  const groups = man.groups || [{ id: 'pierre', v: man.v, mats: man.mats, files: man.files }];
  let done = [];
  try { const t = fs.readFileSync(mark, 'utf8').trim(); done = t.startsWith('[') ? JSON.parse(t) : t ? ['pierre'] : []; } catch (e) {}
  let n = 0;
  for (const g of groups) {
    const key = g.id + '@' + (g.v || 1);
    if (!force && (done.includes(key) || (g.id === 'pierre' && done.includes('pierre')))) continue;
    for (const f of g.files || []) {
      if (!/^[a-z0-9_-]+\.wav$/.test(f.f) || !['brk', 'hit', 'place'].includes(f.ev)) continue;
      let buf; try { buf = fs.readFileSync(path.join(dir, f.f)); } catch (e) { continue; }
      for (const m of g.mats || []) {
        if (!SFX_MATS.includes(m)) continue;
        const nm = `${m}_${f.ev}_${crypto.createHash('md5').update(m + f.f + (g.v || 1)).digest('hex').slice(0, 8)}.wav`;
        if (!fs.existsSync(path.join(SFX_DIR, nm))) { fs.writeFileSync(path.join(SFX_DIR, nm), buf); n++; }
      }
    }
    if (!done.includes(key)) done.push(key);
  }
  try { fs.writeFileSync(mark, JSON.stringify(done)); } catch (e) {}
  if (n) log(`🔊 Pack de bruitages de départ : ${n} son${n > 1 ? 's' : ''} installé${n > 1 ? 's' : ''}`);
  return n;
}
sfxStarter(false);
const PLAYLIST = path.join(MUSIC_DIR, 'playlist.json');
let music = { tracks: [], radio: { id: null, playing: false, startedAt: 0, pos: 0, mode: 'all' } };
try { music = { ...music, ...JSON.parse(fs.readFileSync(PLAYLIST, 'utf8')) }; } catch (e) {}
const trackFile = t => path.join(MUSIC_DIR, t.id + '.' + (t.ext === 'm4a' ? 'm4a' : 'mp3'));
music.tracks = (music.tracks || []).filter(t => fs.existsSync(trackFile(t)));
const saveMusic = () => { try { fs.writeFileSync(PLAYLIST, JSON.stringify(music, null, 1)); } catch (e) { noteError('musique', e.message); } };
const trackOf = id => music.tracks.find(t => t.id === id);
function radioPos() {
  const r = music.radio;
  return r.playing ? (Date.now() - r.startedAt) / 1000 : r.pos;
}
function radioState() {
  const r = music.radio, t = trackOf(r.id);
  return { id: t ? t.id : null, ext: t ? (t.ext || 'mp3') : 'mp3', title: t ? t.title : '', dur: t ? t.dur : 0, playing: !!(t && r.playing), pos: t ? Math.max(0, radioPos()) : 0,
           mode: r.mode, at: Date.now(), n: music.tracks.length };
}
let radioTimer = null;
function radioSchedule() {
  clearTimeout(radioTimer);
  const r = music.radio, t = trackOf(r.id);
  if (!t || !r.playing || !t.dur) return;
  const left = (t.dur - radioPos()) * 1000;
  radioTimer = setTimeout(radioNext, Math.max(500, left + 400));
}
function radioPlay(id, pos = 0) {
  const t = trackOf(id);
  if (!t) return;
  music.radio = { ...music.radio, id, playing: true, startedAt: Date.now() - pos * 1000, pos };
  saveMusic(); radioSchedule(); radioBroadcast();
}
function radioNext(manual = false, dir = 1) {
  const list = music.tracks, r = music.radio;
  if (!list.length) { radioStop(); return; }
  const k = Math.max(0, list.findIndex(t => t.id === r.id));
  let next;
  if (!manual && r.mode === 'one') next = list[k];
  else if (r.mode === 'shuffle' && list.length > 1) { do { next = list[Math.floor(Math.random() * list.length)]; } while (next.id === r.id); }
  else if (!manual && r.mode === 'once' && k === list.length - 1) { radioStop(); return; }
  else next = list[(k + dir + list.length) % list.length];
  radioPlay(next.id, 0);
}
function radioStop() {
  clearTimeout(radioTimer);
  music.radio = { ...music.radio, playing: false, pos: 0, startedAt: 0 };
  saveMusic(); radioBroadcast();
}
function radioBroadcast() { broadcastAll({ type: '__radio', state: radioState() }); }
if (music.radio.playing) { music.radio.startedAt = Date.now() - (music.radio.pos || 0) * 1000; radioSchedule(); }
// Durée d'un M4A : lue dans l'en-tête « mvhd » du fichier
function m4aDuration(buf) {
  try {
    const k = buf.indexOf('mvhd', 0, 'latin1');
    if (k < 0) return 0;
    const v = buf[k + 4], o = k + 8;
    const scale = v === 1 ? buf.readUInt32BE(o + 16) : buf.readUInt32BE(o + 8);
    const dur = v === 1 ? Number(buf.readBigUInt64BE(o + 20)) : buf.readUInt32BE(o + 12);
    return scale ? Math.round(dur / scale) : 0;
  } catch (e) { return 0; }
}
// Durée d'un MP3 (pour enchaîner les morceaux) : en-tête Xing/VBRI si présent, sinon débit constant
function mp3Duration(buf) {
  try {
    let o = 0;
    if (buf.toString('latin1', 0, 3) === 'ID3') o = 10 + ((buf[6] & 127) << 21 | (buf[7] & 127) << 14 | (buf[8] & 127) << 7 | (buf[9] & 127));
    while (o < buf.length - 4 && !(buf[o] === 0xFF && (buf[o + 1] & 0xE0) === 0xE0)) o++;
    if (o >= buf.length - 4) return 0;
    const b1 = buf[o + 1], b2 = buf[o + 2], b3 = buf[o + 3];
    const ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, bri = b2 >> 4, sri = (b2 >> 2) & 3, mono = (b3 >> 6) === 3;
    const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[ver]?.[sri];
    const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const br = (ver === 3 ? BR1 : BR2)[bri];
    if (!SR || layer !== 1) return 0;
    const spf = ver === 3 ? 1152 : 576;
    const side = ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const x = o + 4 + side, tag = buf.toString('latin1', x, x + 4);
    if ((tag === 'Xing' || tag === 'Info') && (buf.readUInt32BE(x + 4) & 1)) return Math.round(buf.readUInt32BE(x + 8) * spf / SR);
    if (buf.toString('latin1', o + 36, o + 40) === 'VBRI') return Math.round(buf.readUInt32BE(o + 36 + 14) * spf / SR);
    return br ? Math.round((buf.length - o) * 8 / (br * 1000)) : 0;
  } catch (e) { return 0; }
}

// ---------- 🔔 Notifications sur le téléphone (Web Push, gratuit, sans application à installer) ----------
let webpush = null, vapid = null;
try {
  webpush = (await import('web-push')).default;
  try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch (e) {}
  if (!vapid?.publicKey) { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 }); }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com/nbbou81000/le-cube-server', vapid.publicKey, vapid.privateKey);
} catch (e) { webpush = null; log('ℹ️  Notifications sur téléphone indisponibles :', e.message); }
const pushSent = { ok: 0, fail: 0, gone: 0 }, pushLast = new Map();
// « dans le jeu » = le jeu est affiché à l'écran sur au moins un appareil. Un onglet caché, une appli en arrière-plan
// ou un PC resté allumé sur le jeu ne comptent plus : sinon le téléphone ne recevait jamais rien.
const onlineAll = () => new Set([...clients.values()].filter(c => c.vis !== false).map(c => c.id));
// make(lang) → { title, body } · uids : liste de joueurs (null = tout le monde) · même jeu ouvert, rien n'est envoyé (sauf test)
async function pushTo(uids, make, opt = {}) {
  if (!webpush || !vapid || (uids && !uids.length)) return 0;
  const online = opt.evenOnline ? new Set() : onlineAll();
  const r = uids ? await sql('select endpoint, player, keys, lang from public.push_subs where player = any($1::uuid[])', [uids])
                 : await sql('select endpoint, player, keys, lang from public.push_subs');
  let n = 0;
  const waits = [];
  for (const s of r.rows) {
    if (online.has(s.player) || s.player === opt.except) continue;
    // pas plus d'une notification du même genre toutes les 30 s par joueur (les messages privés en rafale, par ex.)
    const key = s.endpoint + '|' + (opt.tag || '');
    if (!opt.evenOnline && Date.now() - (pushLast.get(key) || 0) < 30e3) continue;
    pushLast.set(key, Date.now());
    const m = make(s.lang === 'en' ? 'en' : 'fr');
    const payload = JSON.stringify({ title: m.title, body: String(m.body || '').slice(0, 300), tag: opt.tag, url: m.url || './' });
    n++;
    const svc = /fcm\.googleapis|android\.googleapis/.test(s.endpoint) ? 'Google' : /push\.apple\.com/.test(s.endpoint) ? 'Apple'
              : /mozilla|push\.services/.test(s.endpoint) ? 'Mozilla' : /notify\.windows/.test(s.endpoint) ? 'Microsoft' : '?';
    waits.push(webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: opt.ttl || 6 * 3600, urgency: opt.urgent ? 'high' : 'normal', timeout: 15000 })
      .then(() => { pushSent.ok++; return { ok: true, svc }; })
      .catch(e => {
        // 404/410 : abonnement périmé ; 401/403 : abonnement fait avec d'anciennes clés → on l'oublie, l'appareil se réabonnera tout seul
        if ([404, 410, 401, 403].includes(e.statusCode)) { pushSent.gone++; sql('delete from public.push_subs where endpoint = $1', [s.endpoint]).catch(() => {}); }
        else { pushSent.fail++; noteError('notification', `${e.statusCode || ''} ${String(e.body || e.message).slice(0, 120)}`); }
        return { ok: false, svc, code: e.statusCode || 0, err: String(e.body || e.message || '').slice(0, 160) };
      }));
  }
  if (pushLast.size > 5000) pushLast.clear();
  if (opt.wait) return { sent: n, results: await Promise.all(waits) };
  return n;
}
const FR_EN = (fr, en) => lang => lang === 'en' ? en : fr;

// ---------- 🎬 Rejeu : film de chaque cube (les blocs cassés minute par minute) ----------
// Fichier binaire de nombres : [MARQUE, secondes] puis les blocs : i = cassé, -(i+1) = reconstruit, PEEL - L = couche L arrachée
const R_MARK = -2147483648, R_PEEL = -1073741824;
fs.mkdirSync(REPLAY_DIR, { recursive: true });
const replay = { id: null, size: 0, start: 0, buf: [], bytes: 0 };
async function replayOpen() {
  await replayFlush();
  const g = (await sql('select size, started_at from public.game where id = 1')).rows[0];
  const id = new Date(g.started_at).getTime();
  replay.id = id; replay.size = g.size; replay.start = id; replay.buf = [];
  const meta = path.join(REPLAY_DIR, id + '.json');
  if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ id, size: g.size, started: g.started_at }));
  try { replay.bytes = fs.statSync(path.join(REPLAY_DIR, id + '.bin')).size; } catch (e) { replay.bytes = 0; }
  // on garde les 6 derniers films
  const ids = fs.readdirSync(REPLAY_DIR).filter(f => f.endsWith('.json')).map(f => +f.slice(0, -5)).filter(Boolean).sort((a, b) => b - a);
  for (const old of ids.slice(6)) for (const ext of ['.json', '.bin']) fs.rmSync(path.join(REPLAY_DIR, old + ext), { force: true });
}
function replayAdd(v) { if (replay.id) replay.buf.push(v); }
async function replayFlush() {
  if (!replay.id || !replay.buf.length) return;
  if (replay.bytes > 64e6) { replay.buf = []; return; }               // garde-fou : 64 Mo par cube au maximum
  const t = Math.max(0, Math.round((Date.now() - replay.start) / 1000));
  const arr = new Int32Array(replay.buf.length + 2);
  arr[0] = R_MARK; arr[1] = t; arr.set(replay.buf, 2);
  replay.buf = [];
  const b = Buffer.from(arr.buffer);
  replay.bytes += b.length;
  await fs.promises.appendFile(path.join(REPLAY_DIR, replay.id + '.bin'), b).catch(e => noteError('rejeu', e.message));
}
setInterval(() => replayFlush(), 10e3);
function replayList() {
  return fs.readdirSync(REPLAY_DIR).filter(f => f.endsWith('.json')).map(f => {
    try { const m = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, f), 'utf8')); let size = 0;
      try { size = fs.statSync(path.join(REPLAY_DIR, m.id + '.bin')).size; } catch (e) {}
      return { ...m, bytes: size, current: m.id === replay.id }; } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => b.id - a.id);
}

// ---------- 📈 Tableau de bord de l'organisateur (page à part, dans son propre dossier) ----------
// La page vit dans « tableau-de-bord » : elle est envoyée depuis 👑 sans toucher au jeu, et ne fait que LIRE (aucune écriture dans la partie).
const DASH_DIR = path.join(STATE, 'tableau-de-bord');
const DASH_FILE = path.join(DASH_DIR, 'index.html'), DASH_PREV = path.join(DASH_DIR, 'index-precedent.html');
function dashInfo() {
  const st = f => { try { const x = fs.statSync(f); return { size: x.size, at: x.mtime.toISOString() }; } catch (e) { return null; } };
  return { installed: st(DASH_FILE), previous: st(DASH_PREV) };
}
const DASH_EMPTY = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tableau de bord</title>
<body style="font-family:system-ui;background:#f3efe6;color:#2b2722;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">
<div><p style="font-size:40px;margin:0">📈</p><h1 style="font-size:1.3rem">Aucun tableau de bord installé</h1>
<p>Envoie le fichier <b>tableau-de-bord.html</b> depuis le jeu : 👑 › Serveur › 📈 Tableau de bord.</p><p><a href="/">← Retour au jeu</a></p></div>`;
// 🧱 blocs cassés heure par heure, relus dans le film du cube en cours (lecture du fichier par morceaux, au fur et à mesure)
const hourly = { id: null, off: 0, t: 0, b: new Map() };
function replayHourly() {
  if (!replay.id) return [];
  if (hourly.id !== replay.id) { hourly.id = replay.id; hourly.off = 0; hourly.t = 0; hourly.b = new Map(); hourly.pendingMark = false; }
  const f = path.join(REPLAY_DIR, replay.id + '.bin');
  let size = 0; try { size = fs.statSync(f).size; } catch (e) {}
  if (size > hourly.off) {
    const fd = fs.openSync(f, 'r');
    try {
      const CH = 4 << 20, buf = Buffer.alloc(CH);
      while (hourly.off + 4 <= size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CH, (size - hourly.off) & ~3), hourly.off);
        if (n < 4) break;
        const a = new Int32Array(buf.buffer, buf.byteOffset, n >> 2);
        let k = 0;
        if (hourly.pendingMark) { hourly.t = a[0]; k = 1; hourly.pendingMark = false; }
        for (; k < a.length; k++) {
          const v = a[k];
          if (v === R_MARK) { if (k + 1 < a.length) hourly.t = a[++k]; else hourly.pendingMark = true; continue; }
          if (v >= 0) { const h = Math.floor((replay.start + hourly.t * 1000) / 3600e3); hourly.b.set(h, (hourly.b.get(h) || 0) + 1); }
        }
        hourly.off += n & ~3;
      }
    } finally { fs.closeSync(fd); }
  }
  const out = new Map(hourly.b);
  const h = Math.floor(Date.now() / 3600e3);
  for (const v of replay.buf) if (v >= 0) out.set(h, (out.get(h) || 0) + 1);     // coups pas encore écrits sur le disque
  return [...out].sort((x, y) => x[0] - y[0]).map(([k, n]) => [k * 3600e3, n]);
}
// 👥 journal des sessions de jeu (qui, quand, combien de temps, combien de blocs) : gardé sur le disque, 3 000 dernières
const SESSIONS_FILE = path.join(STATE, 'journal-sessions.json');
let sessionLog = [];
try { sessionLog = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); if (!Array.isArray(sessionLog)) sessionLog = []; } catch (e) {}
let sessionLogTimer = null;
process.on('exit', () => { if (sessionLogTimer) { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionLog)); } catch (e) {} } });
function logSession(e) {
  sessionLog.push(e);
  if (sessionLog.length > 3000) sessionLog.splice(0, sessionLog.length - 3000);
  clearTimeout(sessionLogTimer);
  sessionLogTimer = setTimeout(() => { sessionLogTimer = null; try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionLog)); } catch (er) {} }, 5000);
}
// 🎮 les chiffres de la partie, en lecture seule (calculés au plus une fois toutes les 15 secondes)
let dashCache = { at: 0, v: null, busy: null };
async function dashGame() {
  if (dashCache.v && Date.now() - dashCache.at < 15000) return dashCache.v;
  if (dashCache.busy) return dashCache.busy;
  dashCache.busy = (async () => {
    const t0 = performance.now();
    const all = async (text) => { try { return (await sql(text)).rows; } catch (e) { noteError('tableau de bord', e.message); return []; } };
    const one = async (text) => (await all(text))[0] || {};
    const PARIS = `at time zone 'Europe/Paris'`;
    const v = {
      game: await one(`select size, destroyed, started_at, revealed_at, max_hp, gold_every, mat_every, peeled, week_start, week_base, week_goal, week_reward, week_done,
          last_winner, last_winner_blocks, event_kind, event_until, events_on, traps_on, robots_max, signups_open, auto_approve, max_players, max_online, chat_locked, bot_on
        from public.game where id = 1`),
      players: await all(`select p.id, p.pseudo, p.status, p.is_admin, p.is_mod, p.created_at, p.avatar, p.color, p.warnings,
          coalesce(st.hits, 0)::bigint hits, coalesce(st.blocks, 0)::bigint blocks, coalesce(st.week_blocks, 0)::bigint week_blocks, coalesce(st.artifacts_found, 0) arts_found,
          coalesce(st.artifacts_used, 0) arts_used, coalesce(st.gold_found, 0) gold_found, coalesce(st.materials_found, 0) mats_found, coalesce(st.chests, 0) chests,
          coalesce(st.missions_done, 0) missions, coalesce(st.crafted, 0) crafted, coalesce(st.trades, 0) trades, coalesce(st.deepest, 0) deepest,
          coalesce(st.best_combo, 0) combo, coalesce(st.best_cps, 0) best_cps, st.best_break_ms, coalesce(st.trophies, 0) trophies, coalesce(st.peels, 0) peels, st.last_seen,
          coalesce((select qty from public.inventory i where i.player = p.id and i.kind = 'or'), 0) purse,
          coalesce((select sum(qty) from public.inventory i where i.player = p.id and i.kind not in ('or', 'silex', 'fer', 'poudre', 'cristal') and i.kind not like 'robot%'), 0)::int bag_arts,
          (select count(*) from public.chat c where c.player = p.id)::int chat_n
        from public.profiles p left join public.stats st on st.player = p.id order by coalesce(st.blocks, 0) desc`),
      signups: await all(`select (date_trunc('day', created_at ${PARIS}))::date d, count(*)::int n from public.profiles group by 1 order by 1`),
      activity_kinds: await all(`select kind, count(*)::int n from public.activity group by kind order by n desc`),
      activity_days: await all(`select (date_trunc('day', at ${PARIS}))::date d, count(*)::int n from public.activity where at > now() - interval '60 days' group by 1 order by 1`),
      activity_last: await all(`select a.kind, a.detail, a.at, p.pseudo from public.activity a left join public.profiles p on p.id = a.player order by a.id desc limit 40`),
      chat: await one(`select count(*)::int total, count(*) filter (where hidden)::int hidden, count(*) filter (where shadow)::int shadow,
          count(*) filter (where created_at > now() - interval '24 hours')::int d1, count(*) filter (where created_at > now() - interval '7 days')::int d7,
          (select count(*) from public.pm)::int pm, (select count(*) from public.pm where at > now() - interval '7 days')::int pm7,
          (select count(*) from public.chat_reactions)::int reactions from public.chat`),
      chat_days: await all(`select (date_trunc('day', created_at ${PARIS}))::date d, count(*)::int n from public.chat where created_at > now() - interval '60 days' group by 1 order by 1`),
      chat_hours: await all(`select extract(hour from created_at ${PARIS})::int h, count(*)::int n from public.chat group by 1 order by 1`),
      chat_emojis: await all(`select emoji, count(*)::int n from public.chat_reactions group by emoji order by n desc limit 12`),
      inventory: await all(`select kind, sum(qty)::bigint n, count(*) filter (where qty > 0)::int owners from public.inventory where qty > 0 group by kind order by n desc`),
      artifacts: await all(`select kind, count(*)::int total, count(found_by)::int found from public.artifacts group by kind order by total desc`),
      artifacts_days: await all(`select (date_trunc('day', found_at ${PARIS}))::date d, count(*)::int n from public.artifacts where found_at is not null group by 1 order by 1`),
      chests: await one(`select count(*)::int total, count(opened_by)::int opened, count(*) filter (where trap)::int traps, count(*) filter (where trap and opened_by is not null)::int traps_opened from public.chests`),
      layers: await all(`select d, n from public.layer_done where n > 0 order by d`),
      market: await one(`select (select count(*) from public.market)::int offers,
          (select count(*) from public.auctions where status = 'open')::int auctions_open, (select count(*) from public.auctions)::int auctions,
          (select coalesce(sum(bid), 0) from public.auctions where status <> 'open' and bidder is not null)::bigint auctions_gold`),
      duels: await all(`select status, count(*)::int n, coalesce(sum(stake), 0)::int stakes from public.duels group by status`),
      robots: await all(`select r.id, r.name, r.icon, r.kind, r.rate, r.status, r.hits, r.blocks, r.traps, r.started_at, r.ended_at, r.left_sec, r.total_sec, p.pseudo
        from public.robots r left join public.profiles p on p.id = r.owner order by r.id desc limit 60`),
      robot_models: await all(`select id, name, icon, kind, minutes, rate, price, stock, enabled, sold from public.robot_models order by id`),
      events: await all(`select id, name, icon, sched, minutes from public.events order by id`),
      hall: await all(`select id, size, started_at, ended_at, destroyed, total, revealed, winner, players from public.hall order by id desc limit 20`),
      moderation: await one(`select (select count(*) from public.reports where status = 'open')::int reports_open, (select count(*) from public.reports)::int reports,
          (select count(*) from public.mod_log where at > now() - interval '30 days')::int actions30,
          (select count(*) from public.mod_log where moderator is null and at > now() - interval '30 days')::int bot30,
          (select count(*) from public.push_subs)::int push_subs`),
      mod_actions: await all(`select action, count(*)::int n from public.mod_log where at > now() - interval '30 days' group by action order by n desc`),
    };
    v.activity_last = v.activity_last.map(a => ({ at: a.at, kind: a.kind, text: activityFr(a) })).filter(a => a.text);
    v.game_version = GAME_VERSION;
    v.hourly = replayHourly();
    v.sessions = sessionLog.slice(-600);
    const on = new Set([...clients.values()].map(c => c.id));
    v.open_sessions = [...sessions].map(([id, x]) => ({ id, p: x.pseudo, s: x.start, dev: x.device, c: x.country, online: on.has(id) }));
    v.query_ms = Math.round(performance.now() - t0);
    v.at = Date.now();
    dashCache = { at: Date.now(), v, busy: null };
    return v;
  })();
  try { return await dashCache.busy; } finally { dashCache.busy = null; }
}

// 🗄️ Explorateur de la base (comme dans Supabase), en LECTURE SEULE : tables, colonnes, index, liens, contenu, code des fonctions
const DB_SCHEMAS = ['public', 'auth'];
const DB_SECRET = /^(password_hash|token_hash|secret_hash|keys)$/;            // jamais montrés, même à l'organisateur
const qid = n => '"' + String(n).replace(/"/g, '""') + '"';
let dbSchemaCache = { at: 0, v: null };
async function dbSchema() {
  if (dbSchemaCache.v && Date.now() - dbSchemaCache.at < 60000) return dbSchemaCache.v;
  const t0 = performance.now();
  const rows = async (q, a) => (await sql(q, a)).rows;
  const tables = await rows(`select c.oid::int oid, n.nspname sch, c.relname name, greatest(c.reltuples, 0)::bigint est, pg_total_relation_size(c.oid)::bigint size,
      pg_relation_size(c.oid)::bigint data, pg_indexes_size(c.oid)::bigint idx, c.relrowsecurity rls, obj_description(c.oid, 'pg_class') comment
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname = any($1::text[]) order by n.nspname, c.relname`, [`{${DB_SCHEMAS}}`]);
  const cols = await rows(`select a.attrelid::int oid, a.attnum::int num, a.attname name, format_type(a.atttypid, a.atttypmod) type, a.attnotnull nn,
      pg_get_expr(d.adbin, d.adrelid) def, col_description(a.attrelid, a.attnum) comment
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relkind = 'r' and n.nspname = any($1::text[]) and a.attnum > 0 and not a.attisdropped order by a.attrelid, a.attnum`, [`{${DB_SCHEMAS}}`]);
  const cons = await rows(`select co.conrelid::int oid, co.conname name, co.contype type, pg_get_constraintdef(co.oid) def,
      (select array_agg(a.attname order by k.o) from unnest(co.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = co.conrelid and a.attnum = k.n) cols,
      fn.nspname || '.' || fc.relname ref
    from pg_constraint co join pg_class c on c.oid = co.conrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_class fc on fc.oid = co.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace
    where n.nspname = any($1::text[]) order by co.conrelid, co.contype, co.conname`, [`{${DB_SCHEMAS}}`]);
  const idx = await rows(`select i.indrelid::int oid, ic.relname name, pg_get_indexdef(i.indexrelid) def, i.indisunique uniq, i.indisprimary pk,
      pg_relation_size(i.indexrelid)::bigint size
    from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any($1::text[]) order by i.indrelid, ic.relname`, [`{${DB_SCHEMAS}}`]);
  const trg = await rows(`select t.tgrelid::int oid, t.tgname name, pg_get_triggerdef(t.oid) def from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname = any($1::text[])`, [`{${DB_SCHEMAS}}`]);
  const funcs = await rows(`select p.oid::int oid, n.nspname sch, p.proname name, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) result,
      l.lanname lang, p.prosecdef secdef, p.provolatile vol, length(p.prosrc)::int len, obj_description(p.oid, 'pg_proc') comment
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' order by p.proname`);
  // nombre exact de lignes pour les tables raisonnables (estimation pour les très grosses, comme les blocs)
  const exact = tables.filter(t => +t.est < 200000);
  if (exact.length) {
    const r = await rows(exact.map((t, k) => `select ${k} k, count(*)::bigint n from ${qid(t.sch)}.${qid(t.name)}`).join(' union all '));
    for (const x of r) exact[x.k].count = +x.n;
  }
  const by = (list, oid) => list.filter(x => x.oid === oid);
  const info = (await rows(`select version() v, pg_database_size(current_database())::bigint size, current_database() db,
      (select count(*) from pg_extension)::int ext, current_setting('server_encoding') enc, current_setting('TimeZone') tz`))[0];
  const v = {
    info: { ...info, pglite: PGLITE_VERSION },
    tables: tables.map(t => ({ ...t, rows: t.count ?? +t.est, exact: t.count != null,
      columns: by(cols, t.oid).map(c => ({ ...c, secret: DB_SECRET.test(c.name) })), constraints: by(cons, t.oid), indexes: by(idx, t.oid), triggers: by(trg, t.oid) })),
    functions: funcs.map(f => ({ ...f, internal: f.name.startsWith('_') })),
    ms: Math.round(performance.now() - t0),
  };
  dbSchemaCache = { at: Date.now(), v };
  return v;
}
async function dbRows(b) {
  const sc = await dbSchema();
  const t = sc.tables.find(x => `${x.sch}.${x.name}` === String(b.table || ''));
  if (!t) throw new Error('Table inconnue');
  const cols = t.columns, names = new Set(cols.map(c => c.name));
  const pk = (t.constraints.find(c => c.type === 'p')?.cols) || [cols[0].name];
  const order = names.has(b.order) ? [b.order] : pk;
  const dir = b.dir === 'asc' ? 'asc' : b.dir === 'desc' ? 'desc' : (names.has(b.order) ? 'asc' : 'desc');
  const limit = Math.max(1, Math.min(200, +b.limit || 50)), offset = Math.max(0, Math.min(1e7, +b.offset || 0));
  const args = []; let where = '';
  const f = String(b.filter || '').slice(0, 200);
  if (f && names.has(b.fcol) && !DB_SECRET.test(b.fcol)) { args.push('%' + f + '%'); where = `where ${qid(b.fcol)}::text ilike $1`; }
  else if (f) { args.push('%' + f + '%'); where = 'where ' + cols.filter(c => !DB_SECRET.test(c.name)).map(c => `${qid(c.name)}::text ilike $1`).join(' or '); }
  // chaque valeur est lue comme texte, coupée si elle est très longue (images, gros JSON) ; les secrets ne sortent jamais
  const sel = cols.map(c => DB_SECRET.test(c.name) ? `null::text ${qid(c.name)}`
    : `case when length(${qid(c.name)}::text) > 400 then left(${qid(c.name)}::text, 400) || ' … (' || length(${qid(c.name)}::text) || ' caractères)' else ${qid(c.name)}::text end ${qid(c.name)}`).join(', ');
  const from = `${qid(t.sch)}.${qid(t.name)}`;
  const t0 = performance.now();
  const r = await sql(`select ${sel} from ${from} ${where} order by ${order.map(o => `${qid(o)} ${dir} nulls last`).join(', ')} limit ${limit} offset ${offset}`, args);
  let total = t.rows;
  if (where) total = +(await sql(`select count(*)::bigint n from (select 1 from ${from} ${where} limit 100001) x`, args)).rows[0].n;
  return { table: `${t.sch}.${t.name}`, columns: cols.map(c => ({ name: c.name, type: c.type, secret: DB_SECRET.test(c.name) })), rows: r.rows,
    total, exact: where ? total <= 100000 : t.exact, offset, limit, order: order[0], dir, ms: Math.round(performance.now() - t0) };
}
async function dbFunction(oid) {
  const r = await sql(`select n.nspname || '.' || p.proname name, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.oid = $1 and n.nspname = 'public'`, [+oid || 0]);
  if (!r.rows.length) throw new Error('Fonction inconnue');
  return r.rows[0];
}

// ---------- 📦 Mise à jour du jeu depuis 👑 (un zip envoyé depuis le téléphone) ----------
// Lecture d'un zip (sans module en plus) : liste des fichiers et leur contenu
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Ce fichier n’est pas un zip');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip abîmé');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28),
          xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const ls = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(ls, ls + csize);
    if (method !== 0 && method !== 8) throw new Error('Zip non pris en charge');
    out.push({ name, get data() { return method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw); } });
  }
  return out;
}
function safeTarget(rel) {
  if (!UPDATABLE.test(rel) || rel.split('/').some(x => x === '..' || x === '')) return null;
  const t = path.resolve(DIR, rel);
  return t.startsWith(path.resolve(DIR) + path.sep) ? t : null;
}
function rollbackFiles() {
  try {
    const man = JSON.parse(fs.readFileSync(path.join(PREV_DIR, 'manifeste.json'), 'utf8'));
    for (const rel of man.replaced) { const t = safeTarget(rel); if (t) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(path.join(PREV_DIR, 'fichiers', rel), t); } }
    for (const rel of man.added) { const t = safeTarget(rel); if (t) fs.rmSync(t, { force: true }); }
    fs.rmSync(PREV_DIR, { recursive: true, force: true });
    return true;
  } catch (e) { log('Retour à la version d’avant impossible :', e.message); return false; }
}
function prevInfo() {
  try { const m = JSON.parse(fs.readFileSync(path.join(PREV_DIR, 'manifeste.json'), 'utf8')); return { at: m.at, from: m.from, to: m.to }; } catch (e) { return null; }
}
async function applyUpdate(buf, opts = {}) {
  const entries = readZip(buf);
  // le zip contient un dossier (LeCube/…) : on l'enlève
  const tops = new Set(entries.map(x => x.name.split('/')[0]));
  const strip = tops.size === 1 && entries.every(x => x.name.includes('/')) ? [...tops][0].length + 1 : 0;
  const files = [];
  for (const x of entries) {
    const rel = x.name.slice(strip);
    if (safeTarget(rel)) files.push({ rel, x });
  }
  const has = r => files.some(f => f.rel === r);
  if (!has('server.js') || !has('schema.sql') || !has('public/index.html')) throw new Error('Ce zip n’est pas une mise à jour du Cube (server.js, schema.sql ou public/index.html manquant)');
  // vérification du nouveau programme avant de toucher à quoi que ce soit
  const tmp = path.join(STATE, 'verif-server.mjs');
  fs.writeFileSync(tmp, files.find(f => f.rel === 'server.js').x.data);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { throw new Error('Le programme de cette mise à jour est abîmé : rien n’a été changé'); }
  finally { fs.rmSync(tmp, { force: true }); }
  const newVer = (String(files.find(f => f.rel === 'server.js').x.data).match(/GAME_VERSION = '([^']+)'/) || [])[1] || '?';
  if (!(await backup('avant-maj'))) throw new Error('Sauvegarde impossible : mise à jour annulée par prudence');
  // la version actuelle est mise de côté (pour « Revenir à la version d'avant »)
  fs.rmSync(PREV_DIR, { recursive: true, force: true });
  const replaced = [], added = [];
  for (const f of files) {
    const t = safeTarget(f.rel);
    if (fs.existsSync(t)) {
      const keep = path.join(PREV_DIR, 'fichiers', f.rel);
      fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.copyFileSync(t, keep); replaced.push(f.rel);
    } else added.push(f.rel);
  }
  fs.writeFileSync(path.join(PREV_DIR, 'manifeste.json'), JSON.stringify({ at: new Date().toISOString(), from: GAME_VERSION, to: newVer, replaced, added }));
  let n = 0;
  for (const f of files) { const t = safeTarget(f.rel); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, f.x.data); n++; }
  // message pour les joueurs : celui écrit dans 👑, sinon le début de NOUVEAUTES.txt
  let note = String(opts.note || '').trim();
  const nf = files.find(f => f.rel === 'NOUVEAUTES.txt');
  if (!note && nf) note = String(nf.x.data).trim().split(/\r?\n\s*\r?\n/)[0].replace(/\s+/g, ' ').trim();
  fs.writeFileSync(UPDATE_FLAG, JSON.stringify({ at: new Date().toISOString(), to: newVer, note: note.slice(0, 300), notify: opts.notify !== false }));
  log(`📦 Mise à jour installée (${n} fichiers, version ${newVer}) : redémarrage…`);
  return { files: n, version: newVer };
}

// ---------- Serveur web ----------
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('Requête trop grosse')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Requête invalide')); } });
    req.on('error', reject);
  });
}
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  count('bout', Buffer.byteLength(body));
  httpCodes[code >= 500 ? '5xx' : code >= 400 ? '4xx' : '2xx']++;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
  res.end(body);
}
const emailOk = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length < 200;

// ---------- ✉️ Réglages du serveur public : e-mails (code d'inscription, mot de passe oublié), confidentialité ----------
const esc = t => String(t ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const PUB_FILE = path.join(STATE, 'reglages-publics.json');
const PUB_DEFAULT = { email: { provider: '', key: '', from: '', name: 'Le Cube', verify: false, reset: false }, devices: 'full', contact: '', sent: 0, sentDay: '',
  // ℹ️ bouton « À propos » (affiché d'office sur un 2ᵉ serveur, celui qui a un instance.json)
  // 🔥 protection anti-surchauffe (active d'office sur un 2ᵉ serveur) : seuils, durée avant déclenchement, durée de la pause
  guard: { on: null, cpu: 92, lag: 300, mem: 96, mins: 2, pause: 15 },
  about: { on: null, name: '', email: '', github: '', kofi: '' } };
let PUB = JSON.parse(JSON.stringify(PUB_DEFAULT));
try { const j = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8')); PUB = { ...PUB, ...j, email: { ...PUB.email, ...(j.email || {}) }, about: { ...PUB.about, ...(j.about || {}) }, guard: { ...PUB.guard, ...(j.guard || {}) } }; } catch (e) {}
const aboutOn = () => !!(PUB.about.name || PUB.about.email || PUB.about.github || PUB.about.kofi) && (PUB.about.on === null || PUB.about.on === undefined ? !!INSTANCE_NAME : !!PUB.about.on);
const pubSave = () => { try { fs.writeFileSync(PUB_FILE + '.tmp', JSON.stringify(PUB, null, 1)); fs.renameSync(PUB_FILE + '.tmp', PUB_FILE); } catch (e) { noteError('réglages publics', e.message); } };
const mailReady = () => !!(PUB.email.provider && PUB.email.key && emailOk(PUB.email.from));
const mailOn = what => mailReady() && !!PUB.email[what];
function pubPublic(admin) {                               // ce que voit l'écran de connexion (et, en entier, l'organisateur)
  const A = PUB.about;
  const o = { verify: mailOn('verify'), reset: mailOn('reset'), name: INSTANCE_NAME, devices: PUB.devices, contact: PUB.contact || '',
    about: aboutOn() ? { name: A.name, email: A.email, github: A.github, kofi: A.kofi } : null };
  if (admin) o.aboutCfg = { on: aboutOn(), name: A.name, email: A.email, github: A.github, kofi: A.kofi };
  if (admin) Object.assign(o, { provider: PUB.email.provider, hasKey: !!PUB.email.key, keyEnd: PUB.email.key ? PUB.email.key.slice(-4) : '', from: PUB.email.from,
    senderName: PUB.email.name, verifyWanted: !!PUB.email.verify, resetWanted: !!PUB.email.reset, ready: mailReady(), sentToday: PUB.sentDay === new Date().toISOString().slice(0, 10) ? PUB.sent : 0 });
  return o;
}
async function sendMail(to, subject, text) {
  if (!mailReady()) throw new Error('E-mails pas encore réglés');
  const day = new Date().toISOString().slice(0, 10);
  if (PUB.sentDay !== day) { PUB.sentDay = day; PUB.sent = 0; }
  if (PUB.sent >= 280) throw new Error('Limite d’e-mails du jour atteinte : réessaie demain');   // le forfait gratuit de Brevo : 300 par jour
  const name = PUB.email.name || 'Le Cube', html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">${esc(text).replace(/\n/g, '<br>')}</div>`;
  if (process.env.LECUBE_MAIL_FILE) { fs.appendFileSync(process.env.LECUBE_MAIL_FILE, JSON.stringify({ to, subject, text }) + '\n'); PUB.sent++; return; }   // essais sans envoi réel
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  let r;
  try {
    r = PUB.email.provider === 'resend'
      ? await fetch('https://api.resend.com/emails', { method: 'POST', signal: ctl.signal, headers: { Authorization: 'Bearer ' + PUB.email.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: `${name} <${PUB.email.from}>`, to: [to], subject, text, html }) })
      : await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: ctl.signal, headers: { 'api-key': PUB.email.key, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ sender: { name, email: PUB.email.from }, to: [{ email: to }], subject, textContent: text, htmlContent: html }) });
  } catch (e) { throw new Error('Service d’e-mails injoignable'); } finally { clearTimeout(timer); }
  if (!r.ok) {
    let why = ''; try { const j = await r.json(); why = j.message || j.error?.message || j.name || ''; } catch (e) {}
    noteError('e-mail', `${r.status} ${why}`);
    throw new Error(r.status === 401 || r.status === 403 ? 'Clé du service d’e-mails refusée' : `Envoi refusé par le service d’e-mails (${r.status}${why ? ' : ' + String(why).slice(0, 120) : ''})`);
  }
  PUB.sent++; pubSave();
}
const MAIL_CODES = new Map();                             // `${type}:${email}` → { h, exp, tries }
function codeMake(type, email) { const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); MAIL_CODES.set(type + ':' + email, { h: sha(code), exp: Date.now() + 15 * 60e3, tries: 0 }); return code; }
function codeCheck(type, email, code, keep) {
  const k = type + ':' + email, c = MAIL_CODES.get(k);
  if (!c && !String(code || '').trim()) return 'Demande d’abord ton code par e-mail';
  if (!c || c.exp < Date.now()) { MAIL_CODES.delete(k); return 'Code expiré : demande un nouveau code'; }
  if (++c.tries > 5) { MAIL_CODES.delete(k); return 'Trop d’essais : demande un nouveau code'; }
  if (sha(String(code || '').replace(/\D/g, '')) !== c.h) return 'Code incorrect';
  if (!keep) MAIL_CODES.delete(k);
  return '';
}
setInterval(() => { const t = Date.now(); for (const [k, c] of MAIL_CODES) if (c.exp < t) MAIL_CODES.delete(k); }, 300e3).unref();
const mailSign = () => `\n\n— ${PUB.email.name || 'Le Cube'}${INSTANCE_NAME ? ' · ' + INSTANCE_NAME : ''}\nSi tu n’es pas à l’origine de cette demande, ignore simplement ce message.\nIf you didn’t ask for this, just ignore this message.`;

function privacyPage() {
  const dev = PUB.devices, nm = esc(INSTANCE_NAME || 'Le Cube'), contact = PUB.contact ? esc(PUB.contact) : '';
  const devFr = dev === 'off' ? 'Aucune information sur ton appareil n’est enregistrée.'
    : dev === 'basic' ? 'Des informations de base sur ton appareil (type de navigateur et de système, taille d’écran, langue) pour savoir sur quoi le jeu tourne et l’améliorer.'
    : 'Des informations techniques sur ton appareil (navigateur, système, modèle si le navigateur le donne, écran, carte graphique, langue, fuseau horaire, type de connexion, niveau de batterie, fluidité du jeu) et la ville approximative de ta connexion, pour savoir sur quoi le jeu tourne, l’améliorer et repérer les connexions inhabituelles.';
  const devEn = dev === 'off' ? 'No information about your device is stored.'
    : dev === 'basic' ? 'Basic information about your device (browser and system type, screen size, language) to know what the game runs on and improve it.'
    : 'Technical information about your device (browser, system, model if your browser reports it, screen, graphics card, language, time zone, connection type, battery level, game smoothness) and the approximate city of your connection, to know what the game runs on, improve it and spot unusual sign-ins.';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confidentialité · ${nm}</title>
<style>body{margin:0;background:#11131a;color:#e8e8ee;font:16px/1.6 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:28px 18px 60px}h1{font-size:26px}h2{font-size:18px;margin-top:28px}
a{color:#ffc83d}.en{opacity:.8;border-top:1px solid #ffffff22;margin-top:40px;padding-top:10px}li{margin:4px 0}</style></head><body><main>
<h1>🔒 Confidentialité · ${nm}</h1>
<p>Le Cube est un petit jeu amateur, hébergé sur l’ordinateur personnel de son organisateur. Il n’y a ni publicité, ni revente, ni partage de données avec qui que ce soit.</p>
<h2>Ce qui est enregistré</h2><ul>
<li>Ton adresse e-mail (pour te connecter${mailOn('verify') || mailOn('reset') ? ', recevoir un code d’inscription ou de mot de passe oublié' : ''}) et ton mot de passe, chiffré : personne ne peut le lire.</li>
<li>Ton pseudo, ta progression dans le jeu et tes messages dans le salon.</li>
<li>Les dates de tes connexions et une version masquée de ton adresse IP, pour la sécurité du serveur (essais de mots de passe, abus).</li>
<li>${devFr}</li></ul>
<h2>Qui y a accès</h2><p>Seulement l’organisateur du jeu. Les e-mails${mailReady() ? ` sont envoyés par le service ${PUB.email.provider === 'resend' ? 'Resend' : 'Brevo'}, qui ne reçoit que l’adresse et le message à envoyer` : ', s’il y en a, passent par un service d’envoi qui ne reçoit que l’adresse et le message'}. La connexion passe par Cloudflare, qui protège le serveur.</p>
<h2>Tes droits</h2><p>Tu peux supprimer ton compte à tout moment, avec tout ce qu’il contient : dans le jeu, ⚙️ Réglages › Supprimer mon compte.${contact ? ` Pour toute question : ${contact}.` : ''}</p>
<div class="en" lang="en"><h1>🔒 Privacy</h1>
<p>The Cube is a small hobby game hosted on its organizer’s personal computer. No ads, no data selling, no sharing with anyone.</p>
<h2>What is stored</h2><ul><li>Your e-mail address (to log in) and your password, encrypted: nobody can read it.</li>
<li>Your nickname, your game progress and your chat messages.</li><li>Your sign-in dates and a masked version of your IP address, for server security.</li><li>${devEn}</li></ul>
<h2>Who can see it</h2><p>Only the game organizer. E-mails go through a sending service that only receives the address and the message. Traffic goes through Cloudflare, which protects the server.</p>
<h2>Your rights</h2><p>You can delete your account and everything in it at any time: in the game, ⚙️ Settings › Delete my account.${contact ? ` Questions: ${contact}.` : ''}</p></div>
<p><a href="/">← Retour au jeu · Back to the game</a></p></main></body></html>`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  count('http');
  res.on('finish', () => {                             // 🛡️ codes de réponse et actions sensibles
    const c = res.statusCode;
    if (c >= 500) count('s5xx');
    else if (c >= 400) { count('s4xx'); if (c === 404) { count('s404'); noteNotFound(p); } if (c === 429) count('s429'); }
    if (c === 200 && SEC_ADMIN_PATHS[p]) secEvent('admin', req, { what: SEC_ADMIN_PATHS[p] });
  });
  count('bin', +req.headers['content-length'] || 0);       // (sans lire le flux ici : les envois de fichiers le liront eux-mêmes)
  try {
    // Fichiers de l'application installable (icônes, manifeste, service worker)
    const STATIC = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript; charset=utf-8',
      '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-maskable.png': 'image/png' };
    if (req.method === 'GET' && STATIC[p]) {
      const f = path.join(DIR, 'public', p.slice(1));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': STATIC[p], 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400', ...SECURITY });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY });
      try { count('bout', fs.statSync(path.join(DIR, 'public', 'index.html')).size); } catch (e) {}
      return fs.createReadStream(path.join(DIR, 'public', 'index.html')).pipe(res);
    }
    // 📈 tableau de bord de l'organisateur (la page elle-même ; ses données ne sont données qu'à l'organisateur connecté)
    if (req.method === 'GET' && (p === '/confidentialite' || p === '/privacy')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY }); return res.end(privacyPage());
    }
    if (req.method === 'GET' && (p === '/tableau' || p === '/tableau/' || p === '/tableau/index.html')) {
      if (p === '/tableau') { res.writeHead(301, { Location: '/tableau/' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY });
      if (!fs.existsSync(DASH_FILE)) return res.end(DASH_EMPTY);
      return fs.createReadStream(DASH_FILE).pipe(res);
    }
    // 🛟 téléchargement de la copie de secours complète (lien à usage unique, valable 10 minutes)
    const cx = req.method === 'GET' && p.match(/^\/copie-complete\/([a-f0-9]{32})\/[a-z0-9-]+\.zip$/);
    if (cx) {
      const tk = exportTickets.get(cx[1]);
      exportTickets.delete(cx[1]);
      if (!tk || tk.exp < Date.now()) { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Lien expiré : relance la copie depuis 👑 › Serveur.'); }
      return sendFullExport(res, tk.opts);
    }
    // 📟 Écran TRMNL de l'organisateur (adresse secrète)
    const tm = req.method === 'GET' && p.match(/^\/trmnl\/([a-f0-9]{32})(\.json|\/cube\.png)$/);
    if (tm) {
      if (tm[1] !== trmnlKey || !allow('trmnl', 120, 3600e3)) { res.writeHead(404); return res.end(); }
      if (tm[2] === '.json') return send(res, 200, await trmnlPayload(req, String(url.searchParams.get('ecran') || 'tableau').toLowerCase()));
      const png = await trmnlCubeImage(Math.max(0, Math.min(5, +url.searchParams.get('vue') || 0)));
      count('bout', png.length); httpCodes['2xx']++;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=120' });
      return res.end(png);
    }
    // 🔊 Sons du pack de bruitages (réservés aux joueurs connectés)
    const sx = req.method === 'GET' && p.match(/^\/bruitages\/([a-z]+_(?:brk|hit|place)_[a-f0-9]{8}\.wav)$/);
    if (sx) {
      const me = await meOf(await userOf(url.searchParams.get('t')));
      if (!canPlay(me)) { res.writeHead(403); return res.end(); }
      const f = path.join(SFX_DIR, sx[1]);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const size = fs.statSync(f).size;
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': size, 'Cache-Control': 'private, max-age=2592000, immutable', ...SECURITY });
      count('bout', size);
      return fs.createReadStream(f).pipe(res);
    }
    // 🎵 Morceaux de musique (réservés aux joueurs connectés ; lecture en continu avec avance rapide)
    const mm = req.method === 'GET' && p.match(/^\/musique\/([a-f0-9]{12})\.(mp3|m4a)$/);
    if (mm) {
      const me = await meOf(await userOf(url.searchParams.get('t')));
      if (!canPlay(me)) { res.writeHead(403); return res.end(); }
      const f = path.join(MUSIC_DIR, mm[1] + '.' + mm[2]);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const size = fs.statSync(f).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const head = { 'Content-Type': mm[2] === 'm4a' ? 'audio/mp4' : 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=604800', ...SECURITY };
      if (range) {
        let a = range[1] === '' ? size - +range[2] : +range[1], b = range[1] !== '' && range[2] !== '' ? +range[2] : size - 1;
        a = Math.max(0, a); b = Math.min(size - 1, b);
        if (a > b) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
        count('bout', b - a + 1);
        return fs.createReadStream(f, { start: a, end: b }).pipe(res);
      }
      res.writeHead(200, { ...head, 'Content-Length': size });
      count('bout', size);
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method !== 'POST' || !p.startsWith('/api/')) { res.writeHead(404); return res.end('Introuvable'); }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const ip = ipOf(req);

    // --- Envoi d'une sauvegarde à restaurer (fichier brut, lu en flux) ---
    if (p === '/api/admin/restore') {
      // le fichier est lu dès le début (avant toute attente), sinon le début de l'envoi serait perdu
      const tmp = path.join(STATE, 'restaurer-envoi.tmp');
      let size = 0;
      req.on('data', c => { size += c.length; if (size > 4e9) req.destroy(); });
      const done = pipeline(req, fs.createWriteStream(tmp)).then(() => true, () => false);
      const okAdmin = await isAdmin(token);
      const ok = await done;
      if (!okAdmin) { fs.rmSync(tmp, { force: true }); return send(res, 403, { error: 'Réservé à l’administrateur' }); }
      if (!ok) { fs.rmSync(tmp, { force: true }); return send(res, 400, { error: 'Envoi interrompu' }); }
      const head = Buffer.alloc(2); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
      if (size < 1000 || head[0] !== 0x1f || head[1] !== 0x8b) { fs.rmSync(tmp, { force: true }); return send(res, 400, { error: 'Ce fichier n’est pas une sauvegarde du Cube (.tar.gz)' }); }
      fs.renameSync(tmp, RESTORE);
      send(res, 200, { ok: true });
      log('Sauvegarde reçue depuis 👑 : restauration au redémarrage…');
      stopping = true;
      setTimeout(async () => {
        try { await exclusive(() => db.close()); } catch (e) {}
        fs.renameSync(DATA, path.join(STATE, `donnees-ancien-${stamp()}`));
        restartSoon('🔄 Restauration d’une sauvegarde : le jeu revient dans quelques secondes…', 'restore');
      }, 300);
      return;
    }
    // --- 📦 Mise à jour du jeu (zip) ---
    if (p === '/api/admin/update') {
      const chunks = []; let size = 0, tooBig = false;
      const received = new Promise(ok => {
        req.on('data', c => { size += c.length; if (size > 200e6) { tooBig = true; req.destroy(); ok(); } else chunks.push(c); });
        req.on('end', ok); req.on('error', ok); req.on('close', ok);
      });
      const okAdmin = await isAdmin(token);
      await received;
      if (!okAdmin) return send(res, 403, { error: 'Réservé à l’administrateur' });
      if (tooBig) return send(res, 400, { error: 'Fichier trop gros (200 Mo au maximum)' });
      let r;
      try { r = await applyUpdate(Buffer.concat(chunks), { note: url.searchParams.get('note') || '', notify: url.searchParams.get('notify') !== '0' }); }
      catch (e) { log('📦 Mise à jour refusée :', e.message); return send(res, 400, { error: e.message }); }
      send(res, 200, { ok: true, ...r });
      restartSoon('🔄 Mise à jour du jeu : il revient dans quelques secondes…', 'update');
      return;
    }
    // --- 🖼️ Photo du thème « Ma photo » (image déjà réduite et recadrée par le jeu) ---
    if (p === '/api/admin/theme-photo') {
      const chunks = []; let size = 0, tooBig = false;
      const received = new Promise(ok => {
        req.on('data', c => { size += c.length; if (size > 5e6) { tooBig = true; req.destroy(); ok(); } else chunks.push(c); });
        req.on('end', ok); req.on('error', ok); req.on('close', ok);
      });
      const okAdmin = await isAdmin(token);
      await received;
      if (!okAdmin) return send(res, 403, { error: 'Réservé à l’administrateur' });
      if (tooBig) return send(res, 400, { error: 'Photo trop grosse (5 Mo au maximum)' });
      const buf = Buffer.concat(chunks);
      if (!(buf.length > 500 && buf[0] === 0xFF && buf[1] === 0xD8)) return send(res, 400, { error: 'Ce fichier n’est pas une photo JPEG' });
      fs.writeFileSync(PHOTO_FILE, buf);
      log(`🖼️ Photo du cube changée (${Math.round(buf.length / 1024)} Ko)`);
      broadcastAll({ type: 'theme', theme: 'photo', photo: Date.now() });
      return send(res, 200, { ok: true });
    }
    // --- 🔊 Envoi d'un son du pack de bruitages (WAV brut, pour une ou plusieurs matières) ---
    // 📈 nouvelle version du tableau de bord (un seul fichier .html) : rangée à part, le jeu n'est pas touché
    if (p === '/api/admin/dash-upload') {
      const chunks = []; let size = 0, tooBig = false;
      const received = new Promise(ok => {
        req.on('data', c => { size += c.length; if (size > 5e6) { tooBig = true; req.destroy(); ok(); } else chunks.push(c); });
        req.on('end', ok); req.on('error', ok); req.on('close', ok);
      });
      const okAdmin = await isAdmin(token);
      await received;
      if (!okAdmin) return send(res, 403, { error: 'Réservé à l’administrateur' });
      if (tooBig) return send(res, 400, { error: 'Fichier trop gros (5 Mo au maximum)' });
      const buf = Buffer.concat(chunks), head = buf.toString('utf8', 0, 2000).toLowerCase();
      if (buf.length < 100 || !(head.includes('<!doctype html') || head.includes('<html'))) return send(res, 400, { error: 'Ce fichier n’est pas une page HTML' });
      fs.mkdirSync(DASH_DIR, { recursive: true });
      if (fs.existsSync(DASH_FILE)) fs.copyFileSync(DASH_FILE, DASH_PREV);
      fs.writeFileSync(DASH_FILE + '.tmp', buf); fs.renameSync(DASH_FILE + '.tmp', DASH_FILE);
      log(`📈 Tableau de bord installé (${Math.round(buf.length / 1024)} Ko)`);
      return send(res, 200, dashInfo());
    }
    if (p === '/api/admin/sfx-upload') {
      const chunks = []; let size = 0, tooBig = false;
      const received = new Promise(ok => {
        req.on('data', c => { size += c.length; if (size > 3e6) { tooBig = true; req.destroy(); ok(); } else chunks.push(c); });
        req.on('end', ok); req.on('error', ok); req.on('close', ok);
      });
      const okAdmin = await isAdmin(token);
      await received;
      if (!okAdmin) return send(res, 403, { error: 'Réservé à l’administrateur' });
      if (tooBig) return send(res, 400, { error: 'Son trop long (3 Mo au maximum)' });
      const buf = Buffer.concat(chunks);
      if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return send(res, 400, { error: 'Ce fichier n’est pas un son WAV' });
      const ev = ['hit', 'place'].includes(url.searchParams.get('ev')) ? url.searchParams.get('ev') : 'brk';
      const mats = String(url.searchParams.get('mats') || '').split(',').filter(m => SFX_MATS.includes(m));
      if (!mats.length) return send(res, 400, { error: 'Choisis au moins une matière' });
      if (dirSize(SFX_DIR) > 200e6) return send(res, 400, { error: 'Plus de place pour les bruitages (200 Mo au maximum)' });
      const have = sfxList();
      for (const m of mats) {
        if (have.filter(x => x.mat === m && x.ev === ev).length >= 8) continue;      // 8 variantes au plus par matière
        fs.writeFileSync(path.join(SFX_DIR, `${m}_${ev}_${crypto.randomBytes(4).toString('hex')}.wav`), buf);
      }
      broadcastAll({ type: 'sfxpack' });
      return send(res, 200, { files: sfxList() });
    }
    // --- 🎵 Envoi d'un morceau MP3 (fichier brut) ---
    if (p === '/api/admin/music-upload') {
      // le morceau est lu dès le début (avant toute attente), sinon le début de l'envoi serait perdu
      const chunks = []; let size = 0, tooBig = false;
      const received = new Promise(ok => {
        req.on('data', c => { size += c.length; if (size > 60e6) { tooBig = true; req.destroy(); ok(); } else chunks.push(c); });
        req.on('end', ok); req.on('error', ok); req.on('close', ok);
      });
      const okAdmin = await isAdmin(token);
      await received;
      if (!okAdmin) return send(res, 403, { error: 'Réservé à l’administrateur' });
      if (dirSize(MUSIC_DIR) > 3e9) return send(res, 400, { error: 'Plus de place pour la musique (3 Go au maximum) : supprime d’abord des morceaux' });
      if (tooBig) return send(res, 400, { error: 'Morceau trop gros (60 Mo au maximum)' });
      const buf = Buffer.concat(chunks);
      const isMp3 = buf.length > 2000 && (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0));
      const isM4a = buf.length > 2000 && buf.toString('latin1', 4, 8) === 'ftyp';           // M4A / AAC (conteneur MP4)
      if (!isMp3 && !isM4a) return send(res, 400, { error: 'Ce fichier n’est ni un MP3 ni un M4A' });
      const id = crypto.randomBytes(6).toString('hex'), ext = isM4a ? 'm4a' : 'mp3';
      fs.writeFileSync(path.join(MUSIC_DIR, id + '.' + ext), buf);
      const title = String(url.searchParams.get('name') || 'Morceau').replace(/\.(mp3|m4a|mp4|aac)$/i, '').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'Morceau';
      const dur = Math.round(+url.searchParams.get('dur') || 0) || (isM4a ? m4aDuration(buf) : mp3Duration(buf));
      music.tracks.push({ id, ext, title, dur, size: buf.length, added: new Date().toISOString() });
      saveMusic();
      log(`🎵 Morceau ajouté : ${title} (${Math.round(buf.length / 1048576)} Mo)`);
      broadcastAll({ type: '__radio', state: radioState() });
      return send(res, 200, { ok: true, id, tracks: music.tracks });
    }

    const body = await readBody(req, p === '/api/rpc/set_treasure' ? 3e6 : 1e6);

    if (p === '/api/signup') {
      const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || ''), pseudo = String(body.pseudo || '').trim();
      if (!emailOk(email)) return send(res, 400, { error: 'Adresse e-mail invalide' });
      if (password.length < 6) return send(res, 400, { error: 'Mot de passe trop court (6 caractères minimum)' });
      if (password.length > 200) return send(res, 400, { error: 'Mot de passe trop long' });
      if (!pseudo) return send(res, 400, { error: 'Choisis un pseudo' });
      if (!allow('signup:' + ip, 5, 3600e3)) { secEvent('signup_block', req); return send(res, 429, { error: 'Trop d’inscriptions depuis cette connexion : réessaie dans une heure' }); }
      const exists = await sql('select 1 from auth.users where email = $1', [email]);
      if (exists.rows.length) return send(res, 400, { error: 'Cet e-mail est déjà utilisé' });
      const verified = mailOn('verify');
      if (verified) { const bad = codeCheck('signup', email, body.code, true); if (bad) return send(res, 400, { error: bad, code: true }); }
      const clean = pseudo.replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
      if (clean.length < 2) return send(res, 400, { error: 'Pseudo invalide (2 à 20 caractères)' });
      const taken = await sql('select 1 from public.profiles where lower(pseudo) = lower($1)', [clean]);
      if (taken.rows.length) return send(res, 400, { error: 'Ce pseudo est déjà pris' });
      const u = await sql('insert into auth.users (email, raw_user_meta_data, password_hash, email_verified_at) values ($1, $2, $3, $4) returning id',
        [email, JSON.stringify({ pseudo: clean }), await hashPassword(password), verified ? new Date().toISOString() : null]);
      if (verified) MAIL_CODES.delete('signup:' + email);
      log('Nouvelle inscription :', clean);
      count('signups'); secEvent('signup', req, { who: clean });
      signupAlert(u.rows[0].id).catch(e => noteError('alerte inscription', e.message));
      return send(res, 200, { token: await newSession(u.rows[0].id) });
    }
    if (p === '/api/auth-config') return send(res, 200, pubPublic(false));
    // ✉️ code à 6 chiffres envoyé par e-mail avant l'inscription (si l'organisateur l'a activé)
    if (p === '/api/signup-code') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!mailOn('verify')) return send(res, 400, { error: 'Pas de code nécessaire sur ce serveur' });
      if (!emailOk(email)) return send(res, 400, { error: 'Adresse e-mail invalide' });
      if (!allow('code-ip:' + ip, 8, 3600e3) || !allow('code-mail:' + email, 3, 900e3)) { secEvent('signup_block', req, { mail: maskMail(email) }); return send(res, 429, { error: 'Trop de codes demandés : réessaie dans un quart d’heure' }); }
      if ((await sql('select 1 from auth.users where email = $1', [email])).rows.length) return send(res, 400, { error: 'Cet e-mail est déjà utilisé : connecte-toi (ou « Mot de passe oublié ? »)' });
      const code = codeMake('signup', email);
      try { await sendMail(email, `${code} · ton code d’inscription au Cube`, `Bonjour !\n\nVoici ton code pour terminer ton inscription au Cube : ${code}\nIl est valable 15 minutes.\n\nHi! Here is your code to finish signing up to The Cube: ${code}\nIt is valid for 15 minutes.` + mailSign()); }
      catch (e) { MAIL_CODES.delete('signup:' + email); return send(res, 502, { error: e.message }); }
      secEvent('mail_code', req, { mail: maskMail(email) });
      return send(res, 200, { ok: true });
    }
    // 🔑 mot de passe oublié : code par e-mail (réponse identique que le compte existe ou non)
    if (p === '/api/reset-code') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!mailOn('reset')) return send(res, 400, { error: 'Demande à l’organisateur de te donner un nouveau mot de passe' });
      if (!emailOk(email)) return send(res, 400, { error: 'Adresse e-mail invalide' });
      if (!allow('reset-ip:' + ip, 6, 3600e3) || !allow('reset-mail:' + email, 3, 3600e3)) { secEvent('reset_block', req, { mail: maskMail(email) }); return send(res, 429, { error: 'Trop de demandes : réessaie dans une heure' }); }
      const r = await sql('select u.id, p.pseudo, p.is_admin from auth.users u left join public.profiles p on p.id = u.id where u.email = $1', [email]);
      if (r.rows.length) {
        const code = codeMake('reset', email);
        sendMail(email, `${code} · nouveau mot de passe pour le Cube`, `Bonjour ${r.rows[0].pseudo || ''} !\n\nVoici ton code pour choisir un nouveau mot de passe : ${code}\nIl est valable 15 minutes.\n\nHi! Here is your code to choose a new password: ${code}\nIt is valid for 15 minutes.` + mailSign())
          .catch(e => noteError('e-mail mot de passe', e.message));
        secEvent('reset_ask', req, { who: r.rows[0].pseudo, mail: maskMail(email) });
      } else secEvent('reset_ask', req, { mail: maskMail(email), known: false });
      await new Promise(ok => setTimeout(ok, 400));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/reset-password') {
      const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
      if (!mailOn('reset')) return send(res, 400, { error: 'Non disponible sur ce serveur' });
      if (pw.length < 6) return send(res, 400, { error: 'Mot de passe trop court (6 caractères minimum)' });
      if (pw.length > 200) return send(res, 400, { error: 'Mot de passe trop long' });
      if (!allow('reset-try:' + ip, 20, 900e3)) return send(res, 429, { error: 'Trop d’essais : réessaie dans quelques minutes' });
      const bad = codeCheck('reset', email, body.code);
      if (bad) { secEvent('reset_fail', req, { mail: maskMail(email) }); return send(res, 400, { error: bad }); }
      const r = await sql('update auth.users set password_hash = $1, email_verified_at = coalesce(email_verified_at, now()) where email = $2 returning id', [await hashPassword(pw), email]);
      if (!r.rows.length) return send(res, 400, { error: 'Compte introuvable' });
      const uid = r.rows[0].id;
      await sql('delete from auth.sessions where user_id = $1', [uid]); forgetUser(uid);
      const prof = (await sql('select pseudo, is_admin from public.profiles where id = $1', [uid])).rows[0] || {};
      secEvent('reset_done', req, { who: prof.pseudo });
      log(`🔑 Mot de passe changé par e-mail : ${prof.pseudo || '?'}`);
      if (prof.is_admin) pushTo([uid], () => ({ title: '🔑 Le mot de passe organisateur vient d’être changé', body: 'Par code e-mail · si ce n’est pas toi, reprends la main tout de suite' }), { evenOnline: true, tag: 'admin-reset', urgent: true }).catch(() => {});
      return send(res, 200, { token: await newSession(uid) });
    }
    // 🗑️ le joueur supprime lui-même son compte (mot de passe demandé)
    if (p === '/api/delete-me') {
      const uid = await userOf(token);
      if (!uid) return send(res, 401, { error: 'Non connecté' });
      if (!allow('delme:' + ip, 10, 3600e3)) return send(res, 429, { error: 'Trop d’essais' });
      const r = await sql('select u.password_hash, p.pseudo, p.is_admin from auth.users u left join public.profiles p on p.id = u.id where u.id = $1', [uid]);
      const row = r.rows[0];
      if (!row) return send(res, 400, { error: 'Compte introuvable' });
      if (row.is_admin) return send(res, 400, { error: 'Le compte de l’organisateur ne peut pas être supprimé' });
      if (!(await checkPassword(String(body.password || ''), row.password_hash))) { await new Promise(ok => setTimeout(ok, 800)); return send(res, 400, { error: 'Mot de passe incorrect' }); }
      closeUser(uid, { type: '__banned', reason: 'deleted' }, 4003);
      await sql('delete from auth.users where id = $1', [uid]); forgetUser(uid);
      log(`🗑️ Compte supprimé par son joueur : ${row.pseudo}`); secEvent('delete_me', req, { who: row.pseudo });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/login') {
      const email = String(body.email || '').trim().toLowerCase();
      // freine les essais de mots de passe : 20 erreurs par connexion et 8 par compte en 15 minutes
      if (failed('fail-ip:' + ip, 900e3) >= 20 || failed('fail-mail:' + email, 900e3) >= 8) {
        count('loginLock'); secEvent('login_lock', req, { mail: maskMail(email) });
        return send(res, 429, { error: 'Trop d’essais : réessaie dans quelques minutes' });
      }
      const r = await sql('select id, password_hash from auth.users where email = $1', [email]);
      if (!r.rows.length || !(await checkPassword(String(body.password || ''), r.rows[0].password_hash))) {
        allow('fail-ip:' + ip, 1e9, 900e3); allow('fail-mail:' + email, 1e9, 900e3); count('loginFails');
        const known = r.rows.length > 0, adm = known && (await sql('select is_admin from public.profiles where id = $1', [r.rows[0].id])).rows[0]?.is_admin;
        secEvent(adm ? 'admin_fail' : 'login_fail', req, { mail: maskMail(email), known });
        await new Promise(ok => setTimeout(ok, 800));
        return send(res, 400, { error: 'E-mail ou mot de passe incorrect' });
      }
      count('logins');
      const prof = (await sql('select pseudo, is_admin from public.profiles where id = $1', [r.rows[0].id])).rows[0] || {};
      secEvent(prof.is_admin ? 'admin_login' : 'login', req, { who: prof.pseudo });
      if (prof.is_admin) {                               // 🔐 quelqu'un vient d'ouvrir une session sur le compte de l'organisateur : il est prévenu
        const where = [deviceOf(req.headers['user-agent']), String(req.headers['cf-ipcountry'] || '')].filter(x => x && x !== '?').join(' · ');
        pushTo([r.rows[0].id], () => ({ title: '🔐 Nouvelle connexion à ton compte d’organisateur', body: `${where || 'appareil inconnu'} · si ce n’est pas toi, change ton mot de passe tout de suite` }),
          { evenOnline: true, tag: 'admin-login', urgent: true }).catch(() => {});
      }
      return send(res, 200, { token: await newSession(r.rows[0].id) });
    }
    if (p === '/api/logout') {
      if (token) { await sql('delete from auth.sessions where token_hash = $1', [sha(token)]); tokCache.delete(sha(token)); }
      return send(res, 200, {});
    }
    // --- 🧊 Tout le cube d'un coup (format compact) ---
    if (p === '/api/blocks') {
      const me = await meOf(await userOf(token));
      if (!canPlay(me)) return send(res, 403, { error: 'Accès non autorisé' });
      if (!grid.data) await gridBuild();
      const head = { 'Cache-Control': 'no-store', 'X-Cube-Size': String(grid.size), 'X-Max-Hp': String(grid.maxHp),
        'X-Seq': String(logSeq), 'X-Gen': String(grid.gen), 'Access-Control-Expose-Headers': 'X-Cube-Size, X-Max-Hp, X-Seq, X-Gen', ...SECURITY };
      // retour après une pause : seulement les changements (deux nombres par bloc changé)
      const since = +url.searchParams.get('since'), sgen = +url.searchParams.get('gen');
      if (url.searchParams.has('since') && sgen === grid.gen) {
        const d = gridDelta(since);
        if (d) {
          const gz = zlib.gzipSync(Buffer.from(d.buffer), { level: 1 });
          grid.deltas++; count('bout', gz.length); httpCodes['2xx']++;
          res.writeHead(200, { ...head, 'Content-Type': 'application/x-cube-delta', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
          return res.end(gz);
        }
      }
      const gz = gridGz();
      grid.served++;
      count('bout', gz.length);
      httpCodes['2xx']++;
      res.writeHead(200, { ...head, 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      return res.end(gz);
    }
    // --- 🔔 Notifications : clé publique, essai ---
    if (p === '/api/theme-photo') {
      const me = await meOf(await userOf(token));
      if (!canPlay(me)) return send(res, 403, { error: 'Accès non autorisé' });
      if (!fs.existsSync(PHOTO_FILE)) return send(res, 404, { error: 'Aucune photo' });
      const buf = fs.readFileSync(PHOTO_FILE);
      count('bout', buf.length); httpCodes['2xx']++;
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...SECURITY });
      return res.end(buf);
    }
    if (p === '/api/push-key') return send(res, 200, { key: webpush && vapid ? vapid.publicKey : null });
    if (p === '/api/push-test') {
      const uid = await userOf(token), me = await meOf(uid);
      if (!canPlay(me)) return send(res, 403, { error: 'Accès non autorisé' });
      if (!allow('push-test:' + uid, 5, 60e3)) return send(res, 429, { error: 'Trop d’essais : attends une minute' });
      if (!webpush || !vapid) return send(res, 200, { sent: 0, results: [], off: true });
      const r = await pushTo([uid], FR_EN({ title: '🧊 Le Cube', body: 'Les notifications marchent ! 🎉' }, { title: '🧊 The Cube', body: 'Notifications work! 🎉' }), { evenOnline: true, tag: 'test', wait: true, urgent: true });
      return send(res, 200, r);
    }
    // --- 🎬 Rejeux ---
    if (p === '/api/replays' || p === '/api/replay') {
      const me = await meOf(await userOf(token));
      if (!canPlay(me)) return send(res, 403, { error: 'Accès non autorisé' });
      await replayFlush();
      const list = replayList();
      if (p === '/api/replays') return send(res, 200, { list });
      const want = +body.id || replay.id;
      const m = list.reduce((b, x) => Math.abs(x.id - want) < 3000 && (!b || Math.abs(x.id - want) < Math.abs(b.id - want)) ? x : b, null);
      if (!m) return send(res, 404, { error: 'Pas de film pour ce cube (les films existent depuis la version 10)' });
      let raw = Buffer.alloc(0);
      try { raw = fs.readFileSync(path.join(REPLAY_DIR, m.id + '.bin')); } catch (e) {}
      const gz = zlib.gzipSync(raw, { level: 4 });
      count('bout', gz.length); httpCodes['2xx']++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': gz.length, 'Cache-Control': 'no-store',
        'X-Cube-Size': String(m.size), 'X-Started': String(m.id), 'Access-Control-Expose-Headers': 'X-Cube-Size, X-Started', ...SECURITY });
      return res.end(gz);
    }
    // --- 🎵 Ce que joue la radio ---
    if (p === '/api/sfx-pack') {                     // 🔊 liste des sons du pack de bruitages
      const me = await meOf(await userOf(token));
      if (!canPlay(me)) return send(res, 403, { error: 'Accès non autorisé' });
      return send(res, 200, { files: sfxList().map(({ mat, ev, name, size }) => ({ mat, ev, name, size })) });
    }
    if (p === '/api/radio') {
      const me = await meOf(await userOf(token));
      if (!canPlay(me)) return send(res, 403, { error: 'Accès non autorisé' });
      return send(res, 200, { state: radioState(), tracks: me.is_admin ? music.tracks : undefined });
    }

    // --- Administration ---
    if (p.startsWith('/api/admin/')) {
      if (!(await isAdmin(token))) return send(res, 403, { error: 'Réservé à l’administrateur' });
      const action = p.slice(11);
      if (action === 'reset-password') {
        const target = String(body.user_id || ''), pw = String(body.password || '');
        if (pw.length < 6) return send(res, 400, { error: 'Mot de passe trop court (6 caractères minimum)' });
        const r = await sql('update auth.users set password_hash = $1 where id::text = $2 returning id', [await hashPassword(pw), target]);
        if (!r.rows.length) return send(res, 400, { error: 'Joueur introuvable' });
        await sql('delete from auth.sessions where user_id::text = $1', [target]);   // le joueur devra se reconnecter
        forgetUser(target);
        log('Mot de passe réinitialisé par l’administrateur');
        return send(res, 200, {});
      }
      // 🗑️ supprimer pour de bon des comptes refusés (comptes d'essai, inscriptions indésirables…) : tout ce qui leur appartient part avec
      if (action === 'delete-accounts') {
        const ids = (Array.isArray(body.ids) ? body.ids : [body.user_id]).map(String).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
        if (!ids.length) return send(res, 400, { error: 'Aucun compte choisi' });
        const r = await sql(`select id, pseudo from public.profiles where id::text = any($1::text[]) and status = 'refused' and not is_admin`, [`{${ids.join(',')}}`]);
        if (!r.rows.length) return send(res, 400, { error: 'Seuls les comptes refusés peuvent être supprimés (retire-leur d’abord l’accès)' });
        for (const u of r.rows) {
          closeUser(u.id, { type: '__banned', reason: 'refused' }, 4003);
          await sql('delete from auth.users where id = $1', [u.id]);
          forgetUser(u.id);
          log(`🗑️ Compte supprimé : ${u.pseudo}`);
        }
        return send(res, 200, { deleted: r.rows.length, skipped: ids.length - r.rows.length });
      }
      // 🧭 pilote automatique
      if (action === 'autopilot') {
        if (body.op === 'start') {
          const days = Math.floor(+body.days);
          if (!(days >= 1 && days <= 3650)) return send(res, 400, { error: 'Durée entre 1 et 3 650 jours' });
          await apStart(days, !!body.prices);
        } else if (body.op === 'stop') await apStop(!!body.restore);
        else if (body.op === 'now') { if (!ap?.on) return send(res, 400, { error: 'Le pilote n’est pas lancé' }); await apStep(true); }
        else if (!ap) await apLoad();
        const out = apPublic(!!body.full);
        if (body.full) {                               // pour le tableau de bord : les réglages actuels (lecture seule)
          const g = (await sql('select size, mat_w, mat_shift, mat_every, gold_every from public.game where id = 1')).rows[0];
          out.current = { ...g, shop: Object.fromEntries((await sql('select kind, price from public.shop')).rows.map(r => [r.kind, +r.price])),
            recipes: Object.fromEntries((await sql('select result, ingredients from public.recipes where enabled')).rows.map(r => [r.result, r.ingredients])) };
        }
        return send(res, 200, out);
      }
      if (action === 'security') {                     // 🛡️ pour l'onglet Sécurité du tableau de bord
        const since = Date.now() - 864e5, ev24 = secLog.filter(e => e.at >= since);
        const by = (list, f) => { const m = new Map(); for (const e of list) { const k = f(e); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
        return send(res, 200, {
          events: secLog.slice(-400).reverse(),
          counts24: Object.fromEntries(by(ev24, e => e.type)),
          failIps: by(ev24.filter(e => /^(login_fail|admin_fail|login_lock)$/.test(e.type)), e => `${e.ip}|${e.c || ''}`).slice(0, 15).map(([k, n]) => { const [ip, c] = k.split('|'); return { ip, c, n }; }),
          loginCountries: by(secLog.filter(e => e.at >= Date.now() - 30 * 864e5 && /login$/.test(e.type)), e => e.c || '?').slice(0, 10),
          notFound: [...notFound].sort((a, b) => b[1] - a[1]).slice(0, 20), notFoundSince: notFoundDay,
          adminLogins: secLog.filter(e => e.type === 'admin_login' || e.type === 'admin_fail').slice(-20).reverse(),
          sessions: (await sql(`select count(*)::int n, count(*) filter (where last_used > now() - interval '30 days')::int active from auth.sessions`)).rows[0],
          adminSessions: (await sql(`select count(*)::int n from auth.sessions s join public.profiles p on p.id = s.user_id where p.is_admin`)).rows[0].n,
          totals: { logins: total.logins, loginFails: total.loginFails, loginLock: total.loginLock, signups: total.signups, s4xx: total.s4xx, s5xx: total.s5xx, s404: total.s404, s429: total.s429, wsDeny: total.wsDeny, rej: total.rej },
          started: STARTED,
        });
      }
      if (action === 'public-settings') {               // ✉️ réglages e-mail / confidentialité
        if (body.set) {
          const e = body.set.email || {};
          if (e.provider !== undefined) PUB.email.provider = ['brevo', 'resend'].includes(e.provider) ? e.provider : '';
          if (typeof e.key === 'string' && e.key.trim()) PUB.email.key = e.key.trim().slice(0, 300);
          if (e.clearKey) PUB.email.key = '';
          if (typeof e.from === 'string') { const f = e.from.trim().toLowerCase(); if (f && !emailOk(f)) return send(res, 400, { error: 'Adresse d’envoi invalide' }); PUB.email.from = f; }
          if (typeof e.name === 'string') PUB.email.name = e.name.replace(/[\u0000-\u001f<>"]/g, '').trim().slice(0, 40) || 'Le Cube';
          if (e.verify !== undefined) PUB.email.verify = !!e.verify;
          if (e.reset !== undefined) PUB.email.reset = !!e.reset;
          if (['full', 'basic', 'off'].includes(body.set.devices)) PUB.devices = body.set.devices;
          const ab = body.set.about;
          if (ab && typeof ab === 'object') {
            const url = u => { u = String(u || '').trim().slice(0, 200); return !u || /^https:\/\/[^\s<>"]+$/.test(u) ? u : null; };
            if (ab.on !== undefined) PUB.about.on = !!ab.on;
            if (typeof ab.name === 'string') PUB.about.name = ab.name.replace(/[\u0000-\u001f<>"]/g, '').trim().slice(0, 60);
            if (typeof ab.email === 'string') { const m = ab.email.trim().toLowerCase(); if (m && !emailOk(m)) return send(res, 400, { error: 'Adresse e-mail du « À propos » invalide' }); PUB.about.email = m; }
            for (const k of ['github', 'kofi']) if (ab[k] !== undefined) { const v = url(ab[k]); if (v === null) return send(res, 400, { error: 'Les liens doivent commencer par https://' }); PUB.about[k] = v; }
          }
          if (typeof body.set.contact === 'string') PUB.contact = body.set.contact.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);
          pubSave(); log('✉️ Réglages publics modifiés');
        }
        return send(res, 200, pubPublic(true));
      }
      if (action === 'guard') {                        // 🔥 protection anti-surchauffe
        const b = body.set;
        if (b && typeof b === 'object') {
          const G = PUB.guard, n = (v, lo, hi) => { v = Math.round(+v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; };
          if (b.on !== undefined) G.on = !!b.on;
          for (const [k, lo, hi] of [['cpu', 50, 100], ['lag', 50, 5000], ['mem', 50, 100], ['mins', 1, 30], ['pause', 1, 120]]) if (b[k] !== undefined && n(b[k], lo, hi) !== null) G[k] = n(b[k], lo, hi);
          pubSave(); log('🔥 Réglages anti-surchauffe modifiés');
        }
        if (body.op === 'reopen') guardReopen('admin');
        if (body.op === 'test') {
          const ids = await adminIds();
          const n = await pushTo(ids, () => ({ title: `🔥 ${INSTANCE_NAME || 'Le Cube'} : test de l’alerte surchauffe`, body: 'C’est ici que tu seras prévenu si le serveur sature (rien n’est arrêté, c’est un essai).' }), { evenOnline: true, tag: 'overload-test', urgent: true });
          if (!n) return send(res, 400, { error: 'Aucun téléphone à prévenir : active d’abord les notifications dans ⚙️ › 🔔' });
        }
        return send(res, 200, guardPublic());
      }
      if (action === 'mail-test') {
        const to = String(body.to || '').trim().toLowerCase();
        if (!emailOk(to)) return send(res, 400, { error: 'Adresse invalide' });
        try { await sendMail(to, 'Test du Cube ✓', `Bravo, les e-mails du Cube fonctionnent !\n\nCongrats, The Cube’s e-mails work!` + mailSign()); }
        catch (e) { return send(res, 400, { error: e.message }); }
        return send(res, 200, { ok: true, settings: pubPublic(true) });
      }
      if (action === 'devices') {                      // 📱 pour l'onglet Appareils du tableau de bord
        const on = new Set([...clients.values()].map(c => c.id + ':' + (c.devid || '')));
        const rows = (await sql(`select d.*, p.pseudo, p.avatar, p.status, p.is_admin from public.devices d join public.profiles p on p.id = d.player order by d.last_seen desc limit 500`)).rows;
        return send(res, 200, { devices: rows.map(r => ({ ...r, online: on.has(r.player + ':' + r.devid) })) });
      }
      if (action === 'dash-info') return send(res, 200, dashInfo());
      if (action === 'dash-game') return send(res, 200, await dashGame());
      if (action === 'db-schema') return send(res, 200, await dbSchema());
      if (action === 'db-rows') { try { return send(res, 200, await dbRows(body)); } catch (e) { return send(res, 400, { error: e.message }); } }
      if (action === 'db-function') { try { return send(res, 200, await dbFunction(body.oid)); } catch (e) { return send(res, 400, { error: e.message }); } }
      if (action === 'dash-rollback') {
        if (!fs.existsSync(DASH_PREV)) return send(res, 400, { error: 'Pas de version précédente' });
        const cur = fs.existsSync(DASH_FILE) ? fs.readFileSync(DASH_FILE) : null;
        fs.copyFileSync(DASH_PREV, DASH_FILE);
        if (cur) fs.writeFileSync(DASH_PREV, cur);
        return send(res, 200, dashInfo());
      }
      if (action === 'status') return send(res, 200, await serverStatus());
      if (action === 'metrics') return send(res, 200, await metrics());
      if (action === 'vacuum') {
        const r = await vacuum();
        if (!r) return send(res, 500, { error: 'Optimisation impossible (voir la fenêtre du serveur)' });
        return send(res, 200, r);
      }
      if (action === 'kick-socket') {            // couper la connexion d'un joueur (sans le bannir)
        const uid = String(body.user_id || '');
        closeUser(uid, { type: '__kicked' }, 4004);
        return send(res, 200, { ok: true });
      }
      if (action === 'backup-now') {
        const name = await backup('manuelle');
        if (!name) return send(res, 500, { error: 'Sauvegarde impossible (voir la fenêtre du serveur)' });
        return send(res, 200, { name, backups: listBackups() });
      }
      if (action === 'sfx-starter') {                                              // 🔊 remettre le pack de départ
        const n = sfxStarter(true);
        broadcastAll({ type: 'sfxpack' });
        return send(res, 200, { n, files: sfxList() });
      }
      if (action === 'sfx-delete') {                                               // 🔊 retirer des sons du pack
        const all = sfxList();
        const del = body.all ? all : body.name ? all.filter(x => x.name === body.name) : all.filter(x => x.mat === body.mat && (!body.ev || x.ev === body.ev));
        for (const x of del) fs.rmSync(path.join(SFX_DIR, x.name), { force: true });
        broadcastAll({ type: 'sfxpack' });
        return send(res, 200, { files: sfxList() });
      }
      if (action === 'export-info') return send(res, 200, exportInfo());          // 🛟 copie de secours complète
      if (action === 'export-prepare') {
        const t = crypto.randomBytes(16).toString('hex');
        for (const [k, v] of exportTickets) if (v.exp < Date.now()) exportTickets.delete(k);
        exportTickets.set(t, { opts: { music: !!body.music, films: !!body.films, backups: !!body.backups }, exp: Date.now() + 10 * 60e3 });
        return send(res, 200, { url: `/copie-complete/${t}/le-cube-complet.zip` });
      }
      if (action === 'download-backup') {
        const name = String(body.name || '');
        const list = listBackups();
        const pick = name ? list.find(b => b.name === name) : list[list.length - 1];
        if (!pick) return send(res, 404, { error: 'Aucune sauvegarde pour l’instant : clique d’abord sur « Sauvegarder maintenant »' });
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': pick.size,
          'Content-Disposition': `attachment; filename="le-cube-${pick.name}"`, 'Cache-Control': 'no-store' });
        return fs.createReadStream(path.join(BACKUPS, pick.name)).pipe(res);
      }
      if (action === 'tunnel-token') {
        const raw = String(body.token || '');
        if (!raw.trim()) { fs.rmSync(TOKEN_FILE, { force: true }); log('Jeton de tunnel retiré depuis 👑'); }
        else {
          const tok = (raw.match(/eyJ[A-Za-z0-9_\-=.]{40,}/) || [''])[0];
          if (!tok) return send(res, 400, { error: 'Jeton introuvable : colle la commande copiée depuis Cloudflare (elle contient « eyJ… »)' });
          fs.writeFileSync(TOKEN_FILE, tok + '\n', { mode: 0o600 });
          log('Jeton de tunnel enregistré depuis 👑');
        }
        send(res, 200, { ok: true });
        restartSoon('🔄 Le serveur change d’adresse et redémarre…', 'tunnel');
        return;
      }
      if (action === 'load-test') {
        if (loadTest?.running) return send(res, 400, { error: 'Un test est déjà en cours' });
        const steps = (Array.isArray(body.steps) ? body.steps : [20, 40, 60, 80]).map(n => Math.max(1, Math.min(300, +n || 0))).slice(0, 6);
        runLoadTest(await userOf(token), steps, Math.max(10, Math.min(60, +body.seconds || 20))).catch(e => { log('Test impossible :', e.message); if (loadTest) loadTest.running = false; });
        return send(res, 200, { ok: true });
      }
      if (action === 'load-test-status') return send(res, 200, loadTest || { running: false, results: [] });
      if (action === 'load-test-stop') { if (loadTest) loadTest.running = false; return send(res, 200, { ok: true }); }
      if (action === 'trmnl') {                  // 📟 adresse de l'écran TRMNL (et nouvelle clé si demandé)
        if (body.reset) { trmnlNewKey(); trmnl.data = null; }
        return send(res, 200, { key: trmnlKey, hits: trmnl.hits, last: trmnl.last || null, build_ms: trmnl.buildMs ?? null, png_ms: trmnl.pngMs ?? null });
      }
      if (action === 'presence-alerts') {        // 👑 alertes « un joueur se connecte / se déconnecte »
        if (body.set && typeof body.set === 'object') {
          for (const k of ['connect', 'disconnect']) if (typeof body.set[k] === 'boolean') presAlerts[k] = body.set[k];
          if (Number.isFinite(+body.set.minMinutes)) presAlerts.minMinutes = Math.max(0, Math.min(60, Math.round(+body.set.minMinutes)));
          try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(presAlerts)); } catch (e) {}
        }
        return send(res, 200, { ...presAlerts, live: [...sessions.entries()].filter(([, s]) => !s.endTimer).map(([, s]) => ({ pseudo: s.pseudo, since: s.start })) });
      }
      if (action === 'notify') {                 // 📣 annonce envoyée sur les téléphones
        const title = String(body.title || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) || '📣 Le Cube';
        const text = String(body.body || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, 300);
        if (!text) return send(res, 400, { error: 'Écris d’abord le message' });
        if (!allow('notify', 20, 3600e3)) return send(res, 429, { error: 'Trop d’annonces : attends un peu' });
        broadcastAll({ type: 'notice', title, body: text });
        const n = await pushTo(null, () => ({ title, body: text }), { tag: 'annonce-' + Date.now(), ttl: 24 * 3600 });
        const subs = Number((await sql('select count(*) n from public.push_subs')).rows[0].n);
        log(`📣 Annonce envoyée : ${n} notification(s)`);
        return send(res, 200, { sent: n, subs, online: uniqueOnline() });
      }
      if (action === 'update-rollback') {
        if (!prevInfo()) return send(res, 400, { error: 'Aucune version précédente à remettre' });
        if (!rollbackFiles()) return send(res, 500, { error: 'Retour impossible (voir la fenêtre du serveur)' });
        log('↩️  Retour à la version d’avant demandé depuis 👑');
        send(res, 200, { ok: true });
        restartSoon('🔄 Retour à la version précédente du jeu : il revient dans quelques secondes…', 'update');
        return;
      }
      if (action === 'restart') {
        send(res, 200, { ok: true });
        restartSoon('🔄 Le serveur redémarre : le jeu revient dans quelques secondes…', 'restart');
        return;
      }
      if (action === 'music') {                  // 🎵 télécommande de la radio
        const a = String(body.action || ''), id = String(body.id || '');
        if (a === 'play') radioPlay(id || music.tracks[0]?.id, Math.max(0, +body.pos || 0));
        else if (a === 'pause') { if (music.radio.playing) { music.radio = { ...music.radio, playing: false, pos: radioPos() }; clearTimeout(radioTimer); saveMusic(); radioBroadcast(); } }
        else if (a === 'resume') { if (trackOf(music.radio.id)) radioPlay(music.radio.id, music.radio.pos || 0); else radioPlay(music.tracks[0]?.id); }
        else if (a === 'next') radioNext(true, 1);
        else if (a === 'prev') radioNext(true, -1);
        else if (a === 'stop') radioStop();
        else if (a === 'seek') { if (trackOf(music.radio.id)) { const pos = Math.max(0, +body.pos || 0); if (music.radio.playing) radioPlay(music.radio.id, pos); else { music.radio.pos = pos; saveMusic(); radioBroadcast(); } } }
        else if (a === 'mode') { if (['all', 'one', 'shuffle', 'once'].includes(body.mode)) { music.radio.mode = body.mode; saveMusic(); radioSchedule(); radioBroadcast(); } }
        else if (a === 'rename') { const t = trackOf(id); if (t) { t.title = String(body.title || t.title).replace(/[\u0000-\u001f]/g, '').slice(0, 80) || t.title; saveMusic(); radioBroadcast(); } }
        else if (a === 'move') {
          const k = music.tracks.findIndex(t => t.id === id), j = k + (+body.dir > 0 ? 1 : -1);
          if (k >= 0 && j >= 0 && j < music.tracks.length) { [music.tracks[k], music.tracks[j]] = [music.tracks[j], music.tracks[k]]; saveMusic(); }
        }
        else if (a === 'delete') {
          const t = trackOf(id);
          if (t) {
            if (music.radio.id === id) { music.tracks.length > 1 ? radioNext(true, 1) : radioStop(); }
            music.tracks = music.tracks.filter(x => x.id !== id);
            fs.rmSync(trackFile(t), { force: true });
            if (music.radio.id === id) music.radio.id = null;
            saveMusic(); radioBroadcast();
          }
        }
        else return send(res, 400, { error: 'Action inconnue' });
        return send(res, 200, { state: radioState(), tracks: music.tracks });
      }
      return send(res, 404, { error: 'Action inconnue' });
    }

    if (guard.until && ((p.startsWith('/api/rpc/') && p !== '/api/rpc/me') || p === '/api/blocks') && !(await isAdmin(token)))
      return send(res, 503, { error: 'Serveur saturé : le jeu est en pause quelques minutes', overload: guard.until });
    if (p.startsWith('/api/rpc/')) {
      const fn = p.slice(9);
      if (!RPC.has(fn)) return send(res, 404, { error: 'Fonction inconnue' });
      const uid = await userOf(token);
      if (!allow('rpc:' + (uid || ip), 600, 60e3)) { if (failed('rpc:' + (uid || ip), 60e3) === 601) secEvent('flood', req, { who: uid ? pseudoCache.get(uid) || '?' : null }); return send(res, 429, { error: 'Trop de requêtes : ralentis un peu' }); }
      const t0 = performance.now();
      let data;
      try { data = await callAs(uid, fn, body); }
      catch (e) { noteRpc(fn, performance.now() - t0, false); if (!/^(Pas assez|Accès non autorisé|Doucement|Tu |Le salon|Mode lent|Les |Ce |Aucun|Il ne reste|Plus aucune|Trop|Message)/.test(e.message)) noteError(fn, e.message); throw e; }
      noteRpc(fn, performance.now() - t0, true);
      try { data = await afterRpc(fn, uid, body, data); } catch (e) { noteError('après ' + fn, e.message); }
      return send(res, 200, { data });
    }
    send(res, 404, { error: 'Introuvable' });
  } catch (e) {
    if (!res.headersSent) send(res, /trop grosse/.test(e.message) ? 413 : 400, { error: e.message || String(e) });
  }
});

// ---------- Après chaque action : relais en direct vers les autres joueurs (fait par le serveur, pas par le jeu) ----------
const pseudoCache = new Map();
async function pseudoOf(uid) {
  if (!uid || !UUID.test(uid)) return '';
  if (pseudoCache.has(uid)) return pseudoCache.get(uid);
  const r = await sql('select pseudo from public.profiles where id = $1', [uid]).catch(() => null);
  const ps = r?.rows[0]?.pseudo || '';
  pseudoCache.set(uid, ps);
  return ps;
}
async function afterRpc(fn, uid, args, data) {
  const by = uid ? await pseudoOf(uid) : '';
  if (fn === 'hit_blocks' && data) {
    const flat = [], grow = [];
    let hits = 0;
    for (const e of data.r || []) {
      if (typeof e[1] !== 'number') continue;
      gridPatch(e[0], e[1]);
      if (e[3] !== 'refus' && e[3] !== 'scelle') flat.push(e[0], e[1]);
    }
    for (const [i, v] of data.g || []) { gridPatch(i, v); grow.push(i, v); }
    if (Array.isArray(args.n)) hits = args.n.reduce((a, b) => a + (+b || 0), 0);
    count('hits', hits); count('rej', data.rej || 0); notePlayer(uid, hits, data.rej || 0);
    if (flat.length) broadcastAll({ type: 'hits', r: flat });
    if (grow.length) broadcastAll({ type: 'grow', r: grow });
    for (const e of data.r || []) if (e[1] === 0 && e[3] !== 'refus' && e[3] !== 'scelle') replayAdd(e[0]);
    for (const [i, v] of data.g || []) if (v > 0) replayAdd(-(i + 1));
    dailyNews(data.msgs, by);
    if (data.duel && data.duel.status === 'live') notifyUser(data.duel.a === uid ? data.duel.b : data.duel.a, { type: '__duel', d: data.duel });   // ⚔️ score en direct
  } else if (fn === 'duel_create' && data) {
    notifyUser(data.b, { type: '__duel', d: data });
    pushTo([data.b], FR_EN({ title: `⚔️ ${by} te lance un défi !`, body: `${data.minutes} min${data.stake ? ` · mise ${data.stake} 🪙` : ''} · tu as 10 minutes pour accepter` },
                           { title: `⚔️ ${by} challenges you!`, body: `${data.minutes} min${data.stake ? ` · stake ${data.stake} 🪙` : ''} · you have 10 minutes to accept` }), { tag: 'duel', urgent: true, ttl: 600 }).catch(() => {});
  } else if ((fn === 'duel_respond' || fn === 'duel_cancel') && data) {
    notifyUser(data.a, { type: '__duel', d: data }); notifyUser(data.b, { type: '__duel', d: data });
    if (fn === 'duel_respond') pushTo([data.a], FR_EN({ title: data.status === 'live' ? `⚔️ ${by} accepte ton défi : ça commence !` : `⚔️ ${by} refuse ton défi`, body: data.status === 'live' ? 'Reviens vite dans le jeu !' : 'Ta mise t’est rendue.' },
                                                     { title: data.status === 'live' ? `⚔️ ${by} accepted your challenge: it’s starting!` : `⚔️ ${by} declined your challenge`, body: data.status === 'live' ? 'Come back to the game now!' : 'Your stake was returned.' }), { tag: 'duel', urgent: true, ttl: 120 }).catch(() => {});
  } else if (fn === 'robot_launch' && data) {                // 🤖 un robot se met au travail
    const fr = data.kind === 'offline' ? `🌙 ${by} a activé son robot hors ligne « ${data.name} » (${Math.round(data.total / 60)} min de travail pendant ses absences)`
                                       : `${data.icon} ${by} a lancé son robot « ${data.name} » pour ${Math.round(data.total / 60)} min`;
    const en = data.kind === 'offline' ? `🌙 ${by} turned on their offline robot “${data.name}” (${Math.round(data.total / 60)} min of work while away)`
                                       : `${data.icon} ${by} started their robot “${data.name}” for ${Math.round(data.total / 60)} min`;
    broadcastAll({ type: 'robotfeed', fr, en });
    setTimeout(robotTick, 300);
  } else if (fn === 'admin_robot_stop') {
    setTimeout(robotTick, 300);
  } else if (fn === 'use_artifact' && data) {
    const flat = [];
    for (const i of data.destroyed || []) { gridPatch(i, 0); flat.push(i, 0); replayAdd(i); }
    if (data.layer != null && data.peeled > 0) replayAdd(R_PEEL - data.layer);
    dailyNews(data.msgs, by);
    for (const [i, v] of data.damaged || []) { gridPatch(i, v); flat.push(i, v); }
    if (flat.length) broadcastAll({ type: 'hits', r: flat });
    if (data.layer != null && data.peeled > 0) { gridPeel(data.layer); broadcastAll({ type: 'peel', layer: data.layer, by }); }
    if (Array.isArray(data.eye)) broadcastAll({ type: 'eye', cells: data.eye, left: 300, by });
    if (args.k === 'cor') broadcastAll({ type: 'rally', left: data.rally_left || 60, by });
  } else if (fn === 'chat_send' && data && data.id) {
    const shadow = !!data._s;
    delete data._s;
    const out = JSON.stringify({ type: 'chat', m: data }), outMod = JSON.stringify({ type: 'chat', m: { ...data, shadow: shadow || undefined } });
    for (const [ws, c] of clients) {
      if (ws.readyState !== 1) continue;
      if (c.admin || c.mod) { ws.send(outMod); count('wsOut', outMod.length); }
      else if (!shadow || c.id === uid) { ws.send(out); count('wsOut', out.length); }
    }
    // @pseudo : le joueur mentionné reçoit une notification sur son téléphone s'il n'est pas dans le jeu
    // ↩️ réponse : l'auteur du message cité est prévenu sur son téléphone s'il n'est pas dans le jeu
    if (!shadow && data.reply?.player && data.reply.player !== uid)
      pushTo([data.reply.player], FR_EN({ title: `↩️ ${by} t’a répondu`, body: data.body }, { title: `↩️ ${by} replied to you`, body: data.body }), { tag: 'mention' }).catch(() => {});
    if (!shadow && data.body.includes('@')) {
      const r = await sql(`select id from public.profiles where status = 'approved' and id <> $2 and position(lower('@' || pseudo) in lower($1)) > 0 limit 10`, [data.body, uid]);
      const ids = r.rows.map(x => x.id);
      if (ids.length) pushTo(ids, FR_EN({ title: `💬 ${by} t’a mentionné`, body: data.body }, { title: `💬 ${by} mentioned you`, body: data.body }), { tag: 'mention' }).catch(() => {});
    }
  } else if (fn === 'chat_react' && data) {
    broadcastAll({ type: 'react', id: data.id, reactions: data.reactions });
  } else if (fn === 'pm_send' && data && data.id) {
    const out = { type: '__pm', m: data };
    notifyUser(data.to, out); notifyUser(uid, out);
    pushTo([data.to], FR_EN({ title: `✉️ ${by}`, body: data.body }, { title: `✉️ ${by}`, body: data.body }), { tag: 'pm-' + uid }).catch(() => {});
  } else if (fn === 'pm_report') {
    notifyMods({ type: '__report' });
  } else if ((fn === 'auction_create' || fn === 'auction_cancel') && data !== undefined) {
    broadcastAll({ type: 'auction' });
  } else if (fn === 'auction_bid' && data) {
    broadcastAll({ type: 'auction' });
    if (data.outbid && data.outbid !== uid) {
      notifyUser(data.outbid, { type: '__outbid', a: data });
      pushTo([data.outbid], FR_EN({ title: '🔨 Enchère dépassée', body: `${by} a offert ${data.bid} 🪙 pour ${data.qty} × ${data.kind}` },
                                  { title: '🔨 You were outbid', body: `${by} bid ${data.bid} 🪙 for ${data.qty} × ${data.kind}` }), { tag: 'auction-' + data.id }).catch(() => {});
    }
  } else if ((fn === 'give_item' || fn === 'give_artifact') && args.to_player) {
    const q = fn === 'give_item' ? (+args.qty || 1) : 1;
    pushTo([String(args.to_player)], FR_EN({ title: '🎁 Cadeau !', body: `${by} t’a envoyé ${q} × ${args.k}` }, { title: '🎁 A gift!', body: `${by} sent you ${q} × ${args.k}` }), { tag: 'gift' }).catch(() => {});
  } else if (fn === 'admin_set_inventory' && args.p && +args.delta > 0 && args.p !== uid) {
    pushTo([String(args.p)], FR_EN({ title: '🎁 Cadeau de l’organisateur', body: `+${+args.delta} × ${args.k}` }, { title: '🎁 A gift from the organizer', body: `+${+args.delta} × ${args.k}` }), { tag: 'gift' }).catch(() => {});
  } else if (fn === 'admin_set_theme') {
    broadcastAll({ type: 'theme', theme: args.p_theme });
  } else if (fn === 'admin_set_daily') {
    broadcastAll({ type: 'daily', d: data });
  } else if (fn === 'admin_chat_delete' || fn === 'chat_delete_own') {
    broadcastAll({ type: 'chatdel', ids: [args.p_id] });
  } else if (fn === 'pm_delete_own' && data) {
    const out = { type: '__pmdel', id: data.id, with: uid };
    notifyUser(data.to, out); notifyUser(uid, { ...out, with: data.to });
  } else if (fn === 'admin_chat_clear') {
    broadcastAll({ type: 'chatclear' });
  } else if (fn === 'mod_action' && data) {
    const t = data.target;
    if (data.deleted?.length) broadcastAll({ type: 'chatdel', ids: data.deleted });
    meCache.delete(t);
    if (data.close) closeUser(t, { type: '__banned', until: data.until, reason: args.p_reason || '' }, 4003);
    else if (!['shadow', 'unshadow', 'purge'].includes(data.action)) notifyUser(t, { type: '__mod', action: data.action, minutes: args.p_minutes || 0, reason: args.p_reason || '', state: data.state });   // (la sourdine fantôme reste secrète)
    if (data.action === 'mod' || data.action === 'unmod') for (const c of clients.values()) if (c.id === t) c.mod = data.action === 'mod';
    if (['warn', 'mute', 'chatban', 'kick', 'ban'].includes(data.action)) notifyMods({ type: '__modlog' });
  } else if (fn === 'chat_report') {
    notifyMods({ type: '__report' });
  } else if (fn === 'admin_set_status' || fn === 'admin_set_status_many') {
    const ids = fn === 'admin_set_status' ? [args.p] : (args.ids || []);
    for (const id of ids) { meCache.delete(id); if (args.s !== 'approved') closeUser(id, { type: '__banned', reason: 'refused' }, 4003); }
  } else if ((fn === 'set_pseudo' || fn === 'admin_set_pseudo') && data?.pseudo) {
    const t = fn === 'set_pseudo' ? uid : args.p;
    pseudoCache.set(t, data.pseudo); meCache.delete(t);
    for (const c of clients.values()) if (c.id === t) c.pseudo = data.pseudo;
    broadcastPresence();
  } else if (fn === 'admin_new_cube' || fn === 'admin_set_config') {
    gridInvalidate();
    if (fn === 'admin_new_cube') {
      await replayOpen();
      if (ap?.on) {                                  // 🧭 nouveau cube : le pilote s'arrête (sa date de fin visait l'ancien cube)
        ap.on = false; delete ap.base; ap.samples = []; ap.hist = []; ap.dig = {}; ap.layerSnap = null; ap.A = 1; ap.P = 1; ap.C = 1;
        apLog('⏹ Nouveau cube : pilote arrêté, relance-le avec la durée voulue pour ce cube', 'stop');
        await apSave().catch(() => {});
        await sql('update public.game set mat_shift = 0 where id = 1').catch(() => {});
      }
      pushTo(null, FR_EN({ title: '🧊 Nouveau cube !', body: `Un cube ${args.new_size}³ tout neuf vous attend.` }, { title: '🧊 New cube!', body: `A brand-new ${args.new_size}³ cube is waiting.` }), { tag: 'cube', except: uid }).catch(() => {});
    }
  } else if (fn === 'set_profile') {
    meCache.delete(uid);
  }
  return data;
}

// ---------- 📟 Écran TRMNL de l'organisateur : stats complètes, état du cube, serveur ----------
// Le TRMNL vient lire une adresse secrète (/trmnl/<clé>.json) quelques fois par heure. Tout est préparé à l'avance
// et gardé 2 minutes (chaque image du cube : jusqu'à ce que le cube change) : aucun effet sur la vitesse du PC.
const TRMNL_FILE = path.join(STATE, 'trmnl-cle.txt');
let trmnlKey = '';
try { trmnlKey = fs.readFileSync(TRMNL_FILE, 'utf8').trim(); } catch (e) {}
function trmnlNewKey() { trmnlKey = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(TRMNL_FILE, trmnlKey, { mode: 0o600 }); }
if (!/^[a-f0-9]{32}$/.test(trmnlKey)) trmnlNewKey();
const trmnl = { data: null, at: 0, building: null, rot: 0, hits: 0, last: 0, views: {} };
const TRMNL_SCREENS = ['tableau', 'cube', 'joueurs', 'classements', 'activite', 'serveur'];
const nfr = n => Math.round(+n || 0).toLocaleString('fr-FR').replace(/\s/g, ' ');
const dfr = (n, d = 1) => (+n || 0).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const hmFr = d => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const dayFr = d => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
function agoFr(d) {
  if (!d) return 'jamais';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 90) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
const durFr = s => { s = Math.round(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} j ${h} h` : h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
const TITLES_FR = [[1, 'Apprenti mineur'], [3, 'Piocheur'], [6, 'Mineur'], [10, 'Tailleur de pierre'], [15, 'Foreur'], [20, 'Démolisseur'], [26, 'Sapeur'],
  [33, 'Maître carrier'], [40, 'Maître des profondeurs'], [50, 'Seigneur du cube'], [65, 'Titan'], [80, 'Légende du cube']];
const lvlFromXp = xp => { let lv = 1; while (lv < 999 && Math.round(50 * Math.pow(lv, 2.2)) <= xp) lv++; return lv; };
const titleFr = lv => TITLES_FR.reduce((t, x) => lv >= x[0] ? x[1] : t, TITLES_FR[0][1]);
const ITEM_FR = { or: 'or', silex: 'silex', fer: 'fer', poudre: 'poudre', cristal: 'cristal', bombe: 'Bombe', foreuse: 'Laser', marteau: "Marteau d'or", radar: 'Radar',
  megabombe: 'Météore', scie: 'Scie', seisme: 'Séisme', aimant: 'Aimant', cor: 'Cor', sonde: 'Sonde', ecorce: 'Écorce du Monde', oeil: 'Œil du Cube', dynamite: 'Dynamite',
  trefle: 'Trèfle', sablier: 'Sablier', fontaine: 'Fontaine', vrille: 'Vrille', grappe: 'Grappe', givre: 'Givre', chaine: 'Chaîne', tornade: 'Tornade', pilier: 'Pilier',
  toile: 'Toile', lenteur: 'Engourdissement', brouillard: 'Brouillard', macon: 'Maçon fou', durci: 'Durcissement', pickpocket: 'Pickpocket' };
const DAILY_FR = { blocs: n => `Casser ${nfr(n)} blocs`, artefacts: n => `Utiliser ${n} artefacts`, or: n => `Trouver ${n} pièces d'or`, combo: n => `Faire un combo de ${n}`,
  coffres: n => `Ouvrir ${n} coffres dorés`, glace: n => `Casser ${nfr(n)} blocs de glace`, lave: n => `Casser ${nfr(n)} blocs de lave`, cristal: n => `Casser ${nfr(n)} blocs de cristal` };
const MAT_FR = ['Pierre', 'Brique', 'Bois', 'Marbre', 'Carrelage', 'Plastique', 'Planches', 'Gemme'];
function layerName(d, s) {
  if (d === 0) return 'Marbre';
  const t = d / Math.max(1, Math.floor((s - 1) / 2));
  if (t > 0.28 && t < 0.34) return 'Glace';
  if (t > 0.53 && t < 0.59) return 'Lave';
  if (t > 0.78 && t < 0.84) return 'Cristal';
  return MAT_FR[(d - 1) % 8];
}
function activityFr(a) {
  const p = a.pseudo || '?', d = a.detail || {};
  switch (a.kind) {
    case 'legendary': return `${p} a trouvé l'artefact légendaire ${ITEM_FR[d.kind] || d.kind}`;
    case 'craft': return `${p} a fabriqué : ${ITEM_FR[d.kind] || d.kind}`;
    case 'trade': return `${p} a fait un échange avec ${d.seller || '?'}`;
    case 'auction': return `${p} remporte une enchère : ${d.qty} ${ITEM_FR[d.kind] || d.kind} pour ${d.bid} or`;
    case 'week_winner': return `${p} gagne la semaine (${nfr(d.blocks)} blocs)`;
    case 'week_goal': return `Objectif de la semaine atteint`;
    case 'daily': return `Défi du jour réussi par tous`;
    case 'prize_won': return `${p} remporte le lot du trésor`;
    case 'daily_chest': return `${p} ouvre son coffre du jour (série de ${d.streak} j)`;
    case 'season_tier': return `${p} atteint le palier de saison ${d.tier}`;
    case 'duel': return d.a == null ? null : `Duel terminé : ${d.a} - ${d.b}${p !== '?' ? `, victoire de ${p}` : ', égalité'}`;
    case 'new_cube': return `Nouveau cube ${d.size}³`;
    case 'season_end': return `Fin de la saison ${d.season}`;
    case 'signup': return `${p} s'est inscrit`;
    case 'trap': return `${p} est tombé dans un piège (${ITEM_FR[d.kind] || d.kind})`;
    case 'chest': return d.got === 'piege' ? `${p} a ouvert un faux coffre` : `${p} a ouvert un coffre doré`;
    default: return null;
  }
}
// ---- image du cube : vue en 3D isométrique, trous creusés en relief (plus c'est sombre, plus c'est profond) ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  if (!crc32.t) { crc32.t = new Int32Array(256); for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.t[n] = c; } }
  for (let i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngGray(w, h, px) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; px.copy ? px.copy(raw, y * (w + 1) + 1, y * w, y * w + w) : raw.set(px.subarray(y * w, y * w + w), y * (w + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// 6 vues : le cube est tourné pour que chaque face passe à son tour au premier plan (en bas à gauche de l'image).
// Pour chaque axe de la vue (X à droite, Y en haut, Z vers nous) : [axe du cube 0/1/2, sens +1/-1]. Rotations vraies (pas de miroir).
const CUBE_VIEWS = [
  { name: 'face avant', ax: [[0, 1], [1, 1], [2, 1]] }, { name: 'face droite', ax: [[2, -1], [1, 1], [0, 1]] },
  { name: 'face arrière', ax: [[0, -1], [1, 1], [2, -1]] }, { name: 'face gauche', ax: [[2, 1], [1, 1], [0, -1]] },
  { name: 'dessus', ax: [[0, 1], [2, -1], [1, 1]] }, { name: 'dessous', ax: [[0, 1], [2, 1], [1, -1]] }];
function cubePng(view = 0) {
  const s = grid.size, D = grid.data, ss = s * s, ax = CUBE_VIEWS[view % 6].ax;
  const cid = (X, Y, Z) => { const c = [0, 0, 0], v = [X, Y, Z]; for (let i = 0; i < 3; i++) c[ax[i][0]] = ax[i][1] > 0 ? v[i] : s - 1 - v[i]; return c[0] + c[1] * s + c[2] * ss; };
  // profondeur creusée vue de chacune des 3 faces visibles (dessus, face avant, face droite de la vue)
  const top = new Uint16Array(ss), front = new Uint16Array(ss), right = new Uint16Array(ss);
  for (let a = 0; a < s; a++) for (let b = 0; b < s; b++) {
    let d = 0; while (d < s && D[cid(a, s - 1 - d, b)] === 0) d++; top[a + b * s] = d;          // dessus : X = a, Z = b, on descend
    d = 0; while (d < s && D[cid(a, b, s - 1 - d)] === 0) d++; front[a + b * s] = d;             // avant : X = a, Y = b, on recule
    d = 0; while (d < s && D[cid(s - 1 - d, b, a)] === 0) d++; right[a + b * s] = d;             // droite : Z = a, Y = b, on recule
  }
  const W = 520, H = 600, k = (H - 40) / (2 * s), c = Math.cos(Math.PI / 6), ox = W / 2, oy = 20 + s * k;
  const img = Buffer.alloc(W * H, 255), half = Math.max(1, (s - 1) / 2);
  const shade = (base, map, u, v) => {
    const d = map[u + v * s];
    if (d >= s) return 18;                                                   // percé de part en part
    const g = ((u > 0 ? map[u - 1 + v * s] : d) - (u < s - 1 ? map[u + 1 + v * s] : d)) + ((v > 0 ? map[u + (v - 1) * s] : d) - (v < s - 1 ? map[u + (v + 1) * s] : d));
    return Math.max(10, Math.min(255, base * (1 - 0.8 * Math.sqrt(Math.min(1, d / half))) + g * 10));
  };
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const X = (px - ox) / (k * c), Y = (py - oy) / k;                         // X = x - z (en cellules), Y = (x + z)/2 - y
    let v = -1;
    // dessus (y = s) : x - z = X, x + z = 2(Y + s)
    let x = (X + 2 * (Y + s)) / 2, z = (2 * (Y + s) - X) / 2;
    if (x >= 0 && x < s && z >= 0 && z < s) v = shade(250, top, x | 0, z | 0);
    else {
      // face avant (z = s) : x = X + s, y = (x + s)/2 - Y
      x = X + s; let y = (x + s) / 2 - Y;
      if (x >= 0 && x < s && y >= 0 && y < s) v = shade(205, front, x | 0, y | 0);
      else {
        // face droite (x = s) : z = s - X, y = (s + z)/2 - Y
        z = s - X; y = (s + z) / 2 - Y;
        if (z >= 0 && z < s && y >= 0 && y < s) v = shade(150, right, z | 0, y | 0);
      }
    }
    if (v >= 0) img[px + py * W] = v;
  }
  // arêtes du cube en noir
  const P = (x, y, z) => [ox + (x - z) * c * k, oy + ((x + z) / 2 - y) * k];
  const line = (a, b) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])); for (let i = 0; i <= n; i++) { const xx = Math.round(a[0] + (b[0] - a[0]) * i / n), yy = Math.round(a[1] + (b[1] - a[1]) * i / n);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const qx = xx + dx, qy = yy + dy; if (qx >= 0 && qx < W && qy >= 0 && qy < H && Math.abs(dx) + Math.abs(dy) < 2) img[qx + qy * W] = 0; } } };
  const A = P(0, s, 0), B = P(s, s, 0), C = P(s, s, s), Dd = P(0, s, s), E = P(s, 0, s), F = P(0, 0, s), G = P(s, 0, 0);
  [[A, B], [B, C], [C, Dd], [Dd, A], [Dd, F], [F, E], [E, G], [G, B], [C, E]].forEach(([a, b]) => line(a, b));
  return pngGray(W, H, img);
}
const trmnlPngs = new Map();          // vue → { png, key, at }
async function trmnlCubeImage(view) {
  if (!grid.data) await gridBuild();
  const key = `${grid.gen}:${logSeq}`, c = trmnlPngs.get(view);
  // chaque vue est refaite seulement si le cube a changé, et au plus une fois toutes les 2 minutes
  if (c && (c.key === key || Date.now() - c.at < 120e3)) return c.png;
  const t0 = performance.now(), png = cubePng(view);
  trmnlPngs.set(view, { png, key, at: Date.now() });
  trmnl.pngMs = Math.round(performance.now() - t0);
  return png;
}
// ---- toutes les données, en un seul passage ----
async function trmnlBuild(base) {
  const q = async (text, params) => (await sql(text, params)).rows;
  const g = (await q(`select g.*, public._week_goal() as wgoal, public._daily_info() as daily, public._event_info() as event from public.game g where id = 1`))[0];
  const pl = await q(`select p.id, p.pseudo, p.is_admin, p.xp_bank, p.blocks_bank, p.streak, p.streak_best, p.streak_day, p.medals, p.duel_wins, p.duel_played, p.seasons,
      coalesce(s.blocks, 0)::bigint blocks, coalesce(s.hits, 0)::bigint hits, coalesce(s.artifacts_found, 0) arts_found, coalesce(s.artifacts_used, 0) arts_used,
      coalesce(s.chests, 0) chests, coalesce(s.best_combo, 0) combo, coalesce(s.deepest, 0) deepest, coalesce(s.gold_found, 0) gold_found, coalesce(s.missions_done, 0) missions,
      coalesce(s.week_blocks, 0)::bigint week_blocks, coalesce(s.trophies, 0) trophies, coalesce(s.crafted, 0) crafted, s.last_seen, coalesce(public._xp(s), 0)::bigint sxp,
      coalesce((select qty from public.inventory i where i.player = p.id and i.kind = 'or'), 0) gold,
      coalesce((select sum(qty) from public.inventory i where i.player = p.id and i.kind not in ('or', 'silex', 'fer', 'poudre', 'cristal')), 0)::int arts_held
    from public.profiles p left join public.stats s on s.player = p.id where p.status = 'approved'`);
  const layers = await q('select d, n from public.layer_done');
  const duels = await q(`select d.*, pa.pseudo ap, pb.pseudo bp from public.duels d join public.profiles pa on pa.id = d.a join public.profiles pb on pb.id = d.b
    where d.status in ('live', 'done') order by d.id desc limit 6`).catch(() => []);
  const hall = await q('select season, size, ended_at, winner, top from public.hall order by id desc limit 4');
  const act = await q(`select a.kind, a.detail, a.at, p.pseudo from public.activity a left join public.profiles p on p.id = a.player
    where a.kind in ('legendary', 'craft', 'auction', 'week_winner', 'week_goal', 'daily', 'prize_won', 'daily_chest', 'season_tier', 'duel', 'new_cube', 'season_end', 'signup', 'trap', 'chest')
    order by a.id desc limit 40`);
  const hid = (await q(`select (select count(*) from public.artifacts where found_by is null and not public._is_trap(kind))::int arts,
    (select count(*) from public.artifacts where found_by is null and public._is_trap(kind))::int traps,
    (select count(*) from public.chests where opened_by is null and not trap)::int chests`))[0];
  const st = await serverStatus().catch(() => ({}));

  const s = g.size, total = s ** 3, destroyed = +g.destroyed, left = total - destroyed, half = Math.floor((s - 1) / 2);
  const days = Math.max(0.01, (Date.now() - new Date(g.started_at).getTime()) / 864e5);
  const wDays = g.week_start ? Math.max(0.01, (Date.now() - new Date(g.week_start).getTime()) / 864e5) : days;
  const rate = wDays > 0.5 ? 0.6 * (destroyed - g.week_base) / wDays + 0.4 * destroyed / days : destroyed / days;
  const eta = rate > 0 ? left / rate : null;
  const online = new Set([...clients.values()].map(c => c.id));
  const today = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
  const yest = new Date(Date.now() - 864e5).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
  const medal = m => { const a = m || [], n = f => a.filter(f).length; return [[x => x.r === 1, 'Or'], [x => x.r === 2, 'Argent'], [x => x.r === 3, 'Bronze'], [x => x.g, 'Global']]
    .map(([f, t]) => n(f) ? `${t} ${n(f)}` : '').filter(Boolean).join(' · '); };
  const players = pl.map(p => {
    const xp = +p.xp_bank + +p.sxp, lv = lvlFromXp(xp), sd = p.streak_day ? new Date(p.streak_day).toISOString().slice(0, 10) : null;
    return { id: p.id, pseudo: p.pseudo, admin: p.is_admin, blocks: +p.blocks, blocks_fmt: nfr(p.blocks), total: +p.blocks_bank + +p.blocks, total_fmt: nfr(+p.blocks_bank + +p.blocks),
      hits_fmt: nfr(p.hits), level: lv, title: titleFr(lv), xp_fmt: nfr(xp), gold_fmt: nfr(p.gold), arts_held: p.arts_held, arts_found: p.arts_found, arts_used: p.arts_used,
      chests: p.chests, combo_fmt: nfr(p.combo), deepest: +p.deepest + 1, missions: p.missions, crafted: p.crafted, week_fmt: nfr(p.week_blocks), week: +p.week_blocks,
      streak: sd === today || sd === yest ? p.streak : 0, streak_best: p.streak_best, duels: `${p.duel_wins}/${p.duel_played}`, medals: medal(p.medals), trophies: p.trophies,
      online: online.has(p.id), seen: online.has(p.id) ? 'en ligne' : agoFr(p.last_seen), seasons: +p.seasons + (+p.blocks > 0 ? 1 : 0) };
  });
  const season = [...players].filter(p => p.blocks > 0).sort((a, b) => b.blocks - a.blocks).map((p, i) => ({ ...p, rank: i + 1 }));
  const global = [...players].filter(p => p.total > 0).sort((a, b) => b.total - a.total).map((p, i) => ({ ...p, rank: i + 1 }));
  const week = [...players].filter(p => p.week > 0).sort((a, b) => b.week - a.week);
  // couches : avancement des couches en cours (la plus extérieure non finie et les suivantes)
  const done = new Map(layers.map(r => [+r.d, +r.n])), Ls = [];
  for (let d = 0; d <= half; d++) {
    const vol = (s - 2 * d) ** 3 - Math.max(0, s - 2 * d - 2) ** 3, n = d < g.peeled ? vol : Math.min(vol, done.get(d) || 0);
    Ls.push({ n: d + 1, name: layerName(d, s), pct: Math.floor(n / vol * 100), left_fmt: nfr(vol - n), vol });
  }
  const cur = Ls.find(l => l.pct < 100) || Ls[Ls.length - 1];
  const lay = Ls.filter(l => l.n >= cur.n).slice(0, 8);
  const rec = [];
  const combos = pl.filter(p => +p.combo > 0).sort((a, b) => b.combo - a.combo)[0]; if (combos) rec.push({ label: 'Meilleur combo', who: combos.pseudo, value: nfr(combos.combo) });
  const deep = pl.filter(p => +p.blocks > 0).sort((a, b) => b.deepest - a.deepest)[0]; if (deep) rec.push({ label: 'Le plus profond', who: deep.pseudo, value: `couche ${+deep.deepest + 1}` });
  const rich = pl.filter(p => +p.gold > 0).sort((a, b) => b.gold - a.gold)[0]; if (rich) rec.push({ label: 'Le plus riche', who: rich.pseudo, value: `${nfr(rich.gold)} or` });
  const hunter = pl.filter(p => +p.arts_found > 0).sort((a, b) => b.arts_found - a.arts_found)[0]; if (hunter) rec.push({ label: "Chasseur d'artefacts", who: hunter.pseudo, value: nfr(hunter.arts_found) });
  const streak = players.filter(p => p.streak > 0).sort((a, b) => b.streak - a.streak)[0]; if (streak) rec.push({ label: 'Plus longue série', who: streak.pseudo, value: `${streak.streak} jour${streak.streak > 1 ? 's' : ''}` });
  const duelist = pl.filter(p => +p.duel_wins > 0).sort((a, b) => b.duel_wins - a.duel_wins)[0]; if (duelist) rec.push({ label: 'Roi des duels', who: duelist.pseudo, value: `${duelist.duel_wins} victoire${duelist.duel_wins > 1 ? 's' : ''}` });
  const d = g.daily, ev = g.event, wgoal = +g.wgoal || 1, wprog = destroyed - g.week_base;
  const H = st.history || [];
  const mem = st.mem_total ? Math.round((1 - st.mem_free / st.mem_total) * 100) : null;
  const bk = (st.backups || []).slice(-1)[0];
  return {
    updated: hmFr(Date.now()), date: dayFr(Date.now()), version: GAME_VERSION,
    cube: { size: s, total_fmt: nfr(total), destroyed_fmt: nfr(destroyed), left_fmt: nfr(left), pct: dfr(destroyed / total * 100, destroyed / total < 0.1 ? 2 : 1), pct_int: Math.floor(destroyed / total * 100),
      season: g.season, since: dayFr(g.started_at), days: dfr(days, 1), rate_fmt: nfr(rate), eta: eta == null ? '—' : eta < 1 ? "moins d'un jour" : `${nfr(eta)} jour${eta >= 1.5 ? 's' : ''}`,
      layer: cur.n, layers: half + 1, layer_name: cur.name, revealed: !!g.revealed_at, core: g.revealed_at ? 'Trésor révélé' : left <= 27 ? 'Cœur ouvert' : 'Cœur scellé',
      hidden_arts: nfr(hid.arts), hidden_traps: nfr(hid.traps), hidden_chests: nfr(hid.chests), image: `${base}/trmnl/${trmnlKey}/cube.png?v=${grid.gen}-${logSeq}` },
    layers: lay,
    online: { count: online.size, names: [...new Set([...clients.values()].map(c => c.pseudo))].join(', ') || 'personne', peak: st.peak_today || 0 },
    event: ev ? { name: ev.name, mult: Object.entries(ev.mult || {}).filter(([, v]) => v > 1).map(([k, v]) => `${({ or: 'or', mat: 'matériaux', force: 'force', art: 'artefacts', coffre: 'coffres' })[k] || k} x${v}`).join(', '), left: durFr(ev.left || 0) } : null,
    daily: d ? { text: (DAILY_FR[d.kind] || (n => d.kind))(d.target), progress_fmt: nfr(Math.min(d.progress, d.target)), target_fmt: nfr(d.target), pct: Math.min(100, Math.floor(d.progress / Math.max(1, d.target) * 100)), done: d.done, reward: d.reward } : null,
    week: { progress_fmt: nfr(Math.min(wprog, wgoal)), goal_fmt: nfr(wgoal), pct: Math.min(100, Math.floor(wprog / wgoal * 100)), done: g.week_done, reward: g.week_reward,
      leader: week[0] ? week[0].pseudo : '—', leader_fmt: week[0] ? week[0].week_fmt : '0', last_winner: g.last_winner || '—' },
    players: season.slice(0, 12), players_count: players.length, active_7d: players.filter(p => p.seen !== 'jamais' && !/il y a ([8-9]|\d\d+) j/.test(p.seen)).length,
    global: global.slice(0, 10), week_top: week.slice(0, 5).map((p, i) => ({ rank: i + 1, pseudo: p.pseudo, blocks_fmt: p.week_fmt })),
    records: rec.filter(Boolean),
    duels: duels.map(x => ({ a: x.ap, b: x.bp, score: `${x.a_score} - ${x.b_score}`, live: x.status === 'live', winner: x.winner ? (x.winner === x.a ? x.ap : x.bp) : (x.status === 'live' ? 'en cours' : 'égalité'),
      stake: x.stake, when: agoFr(x.settled_at || x.created_at) })),
    hall: hall.map(h => ({ season: h.season || '—', size: h.size, ended: dayFr(h.ended_at), winner: h.winner || '—', podium: (h.top || []).slice(0, 3).map(t => t.pseudo).join(', ') })),
    activity: act.map(a => ({ text: activityFr(a), when: agoFr(a.at), at: hmFr(a.at) })).filter((a, i, l) => a.text && !(i > 0 && l[i - 1].text === a.text)).slice(0, 12),
    server: { cpu: st.cpu_pct ?? 0, proc: st.proc_pct ?? 0, mem, rss_fmt: st.rss ? nfr(st.rss / 1048576) : '—', uptime: st.uptime_s ? durFr(st.uptime_s) : '—',
      os_uptime: st.os_uptime_s ? durFr(st.os_uptime_s) : '—', online: st.players_online ?? 0, peak_today: st.peak_today ?? 0, peak: st.peak ?? 0,
      accounts: st.accounts?.approved ?? 0, pending: st.accounts?.pending ?? 0, active_24h: st.active?.d1 ?? 0, active_7d: st.active?.d7 ?? 0,
      rpc_avg: st.totals?.rpc_avg_ms ?? 0, rpc_max: st.rpc_max_ms ?? 0, requests_fmt: nfr(st.totals?.rpc ?? 0), hits_fmt: nfr(st.totals?.hits ?? 0),
      disk_free: st.disk?.free ? `${dfr(st.disk.free / 1073741824, 1)} Go` : '—', disk_pct: st.disk?.total ? Math.round((1 - st.disk.free / st.disk.total) * 100) : null,
      data_fmt: st.data_size ? `${nfr(st.data_size / 1048576)} Mo` : '—', backup: bk ? `${dayFr(bk.at)} à ${hmFr(bk.at)}` : 'aucune', backups: (st.backups || []).length,
      battery: st.battery ? `${st.battery.pct} %${st.battery.ac ? ' (secteur)' : ' (sur batterie)'}` : 'secteur', tunnel: st.tunnel?.ok ? 'en ligne' : (st.tunnel?.mode ? 'coupé' : '—'),
      load: H.slice(-60).map(h => h.cpu || 0), players_hist: H.slice(-60).map(h => h.online || 0),
      trmnl_ms: trmnl.buildMs ?? 0, png_ms: trmnl.pngMs ?? 0 },
  };
}
async function trmnlPayload(req, screen) {
  if (!trmnl.data || Date.now() - trmnl.at > 110e3) {
    if (!trmnl.building) {
      const base = `https://${String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').replace(/[^\w.:-]/g, '')}`;
      trmnl.building = (async () => { const t0 = performance.now(); try { trmnl.data = await trmnlBuild(base); trmnl.at = Date.now(); trmnl.buildMs = Math.round(performance.now() - t0); } finally { trmnl.building = null; } })();
    }
    await trmnl.building;
  }
  // « rotation » : un écran différent à chaque passage du TRMNL
  let sc = TRMNL_SCREENS.includes(screen) ? screen : 'tableau';
  if (screen === 'rotation') sc = TRMNL_SCREENS[trmnl.rot++ % TRMNL_SCREENS.length];
  trmnl.hits++; trmnl.last = Date.now();
  // 🧊 l'image du cube tourne : une face différente au premier plan à chaque passage (compté écran par écran)
  const v = (trmnl.views[sc] = ((trmnl.views[sc] ?? -1) + 1) % 6);
  const cube = { ...trmnl.data.cube, view: v + 1, view_name: CUBE_VIEWS[v].name, image: `${trmnl.data.cube.image}&vue=${v}` };
  return { screen: sc, ...trmnl.data, cube };
}

// 🎯 Défi du jour réussi : tout le monde le voit
function dailyNews(msgs, by) {
  const m = (msgs || []).find(x => typeof x === 'string' && x.startsWith('🌟'));
  if (m) sql('select public._daily_info() d').then(r => { lastDaily = JSON.stringify(r.rows[0].d); broadcastAll({ type: 'daily', d: r.rows[0].d, done: true, by }); }).catch(() => {});
}
// Toutes les 15 s : enchères terminées, avancée du défi du jour, début d'un événement, trésor révélé
let lastDaily = '', lastEvent = undefined, lastRevealed = undefined;
async function watch() {
  if (stopping) return;
  try {
    const st = (await sql('select public._auctions_settle() a, public._daily_info() d, public._event_info() e, (select revealed_at is not null from public.game where id = 1) r, public._duels_settle() du')).rows[0];
    // ⚔️ duels terminés (ou défis expirés) : les deux joueurs sont prévenus
    for (const d of st.du || []) {
      notifyUser(d.a, { type: '__duel', d }); notifyUser(d.b, { type: '__duel', d });
      if (d.status !== 'done') continue;
      for (const [me_, other, mine, theirs] of [[d.a, d.bp, d.as, d.bs], [d.b, d.ap, d.bs, d.as]]) {
        const res = !d.winner ? 'égalité' : d.winner === me_ ? 'gagné' : 'perdu', resEn = !d.winner ? 'draw' : d.winner === me_ ? 'won' : 'lost';
        pushTo([me_], FR_EN({ title: `⚔️ Duel contre ${other} : ${res} !`, body: `${mine} blocs contre ${theirs}${d.stake ? (d.winner === me_ ? ` · +${d.stake * 2} 🪙` : !d.winner ? ' · mise rendue' : '') : ''}` },
                            { title: `⚔️ Duel against ${other}: ${resEn}!`, body: `${mine} blocks vs ${theirs}${d.stake ? (d.winner === me_ ? ` · +${d.stake * 2} 🪙` : !d.winner ? ' · stake returned' : '') : ''}` }), { tag: 'duel-' + d.id }).catch(() => {});
      }
    }
    for (const a of st.a || []) {
      notifyUser(a.seller, { type: '__auction', a }); if (a.bidder) notifyUser(a.bidder, { type: '__auction', a });
      if (a.status === 'sold') {
        pushTo([a.bidder], FR_EN({ title: '🔨 Enchère gagnée !', body: `${a.qty} × ${a.kind} pour ${a.bid} 🪙` }, { title: '🔨 Auction won!', body: `${a.qty} × ${a.kind} for ${a.bid} 🪙` }), { tag: 'auction-' + a.id }).catch(() => {});
        pushTo([a.seller], FR_EN({ title: '🔨 Vendu !', body: `${a.bidder_pseudo} achète ${a.qty} × ${a.kind} pour ${a.bid} 🪙` }, { title: '🔨 Sold!', body: `${a.bidder_pseudo} buys ${a.qty} × ${a.kind} for ${a.bid} 🪙` }), { tag: 'auction-' + a.id }).catch(() => {});
      }
    }
    if (st.a?.length) broadcastAll({ type: 'auction' });
    const d = JSON.stringify(st.d);
    if (d !== lastDaily) { lastDaily = d; broadcastAll({ type: 'daily', d: st.d }); }
    const ev = st.e ? st.e.name : null;
    if (lastEvent !== undefined && ev && ev !== lastEvent) {
      const mins = Math.max(1, Math.round((st.e.left || 0) / 60));
      pushTo(null, FR_EN({ title: `${st.e.icon || '🎉'} ${ev} commence !`, body: (st.e.message ? st.e.message + ' · ' : '') + `encore ${mins} min` },
                         { title: `${st.e.icon || '🎉'} ${ev} has started!`, body: (st.e.message ? st.e.message + ' · ' : '') + `${mins} min left` }), { tag: 'event', ttl: (st.e.left || 600) | 0 }).catch(() => {});
    }
    lastEvent = ev;
    if (lastRevealed === false && st.r) pushTo(null, FR_EN({ title: '💎 Le trésor est révélé !', body: 'Le cœur du cube est ouvert : viens voir ce qu’il cachait.' }, { title: '💎 The treasure is revealed!', body: 'The heart of the cube is open: come and see what it was hiding.' }), { tag: 'treasure' }).catch(() => {});
    lastRevealed = !!st.r;
  } catch (e) { noteError('surveillance', e.message); }
}
setInterval(watch, 15e3);
await replayOpen().catch(e => noteError('rejeu', e.message));

// ---------- Temps réel (coups des autres, présence, salon, radio) ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
const clients = new Map();
function broadcastPresence() {
  const names = [...new Set([...clients.values()].map(c => c.pseudo))];
  broadcastAll({ type: '__presence', names, robots: robotNames });          // 🤖 robots au travail : « Robot de … »
  notePeak();
}
function broadcastAll(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients.keys()) if (ws.readyState === 1) { ws.send(msg); count('wsOut', msg.length); }
}
function notifyAdmins(obj) {
  const msg = JSON.stringify(obj);
  for (const [ws, c] of clients) if (c.admin && ws.readyState === 1) ws.send(msg);
}
function notifyMods(obj) {
  const msg = JSON.stringify(obj);
  for (const [ws, c] of clients) if ((c.admin || c.mod) && ws.readyState === 1) ws.send(msg);
}
function notifyUser(uid, obj) {
  const msg = JSON.stringify(obj);
  for (const [ws, c] of clients) if (c.id === uid && ws.readyState === 1) ws.send(msg);
}
function closeUser(uid, obj, code) {
  const msg = JSON.stringify(obj);
  for (const [ws, c] of clients) if (c.id === uid) { try { if (ws.readyState === 1) ws.send(msg); ws.close(code, 'exclu'); } catch (e) {} }
}
const deviceOf = ua => {
  ua = String(ua || '');
  const os_ = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux|CrOS/.test(ua) ? 'Linux' : '?';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os_} · ${br}` : os_;
};
// Ce que les joueurs peuvent relayer eux-mêmes (le reste vient du serveur) : tout est vérifié et signé du vrai pseudo
const FEEDS = new Set(['found', 'purse', 'mission', 'used', 'crafted', 'gave', 'offer', 'accept', 'chest', 'ach', 'goal', 'trap', 'lvl', 'auction']);
const word = v => typeof v === 'string' && /^[a-z_]{1,20}$/.test(v) ? v : undefined;
const num = v => v !== undefined && v !== null && Number.isFinite(+v) ? Math.max(-1e9, Math.min(1e9, Math.round(+v))) : undefined;
async function cleanFeed(a, c) {
  a = a && typeof a === 'object' ? a : {};
  const o = { p: c.pseudo };
  for (const k of ['k', 'g', 'w']) if (a[k] !== undefined) o[k] = word(a[k]);
  for (const k of ['n', 'q', 'gq', 'wq', 'layer', 'bonus']) if (a[k] !== undefined) o[k] = num(a[k]);
  if (typeof a.got === 'string' && /^[a-z_]+(:[a-z_0-9]+){1,2}$/.test(a.got)) o.got = a.got;
  if (typeof a.id === 'string' && /^[a-z0-9]{1,12}$/.test(a.id)) o.id = a.id;
  if (a.toId) o.to = await pseudoOf(String(a.toId));
  if (a.sId) o.s = await pseudoOf(String(a.sId));
  return o;
}
// 📱 fiche technique d'un appareil (envoyée par le jeu à chaque connexion, puis ses performances toutes les 5 minutes)
const devClean = (v, d = 0) => {
  if (v == null || d > 5) return null;
  if (typeof v === 'string') return v.slice(0, 300);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map(x => devClean(x, d + 1));
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).slice(0, 60)) o[String(k).slice(0, 40)] = devClean(v[k], d + 1); return o; }
  return null;
};
async function deviceSave(c, m) {
  const id = String(m.id || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
  if (id.length < 8) return;
  if (m.type === 'devp') {
    const perf = devClean(m.p) || {};
    if (JSON.stringify(perf).length > 2000) return;
    await sql(`update public.devices set perf = $3, last_seen = now() where player = $1 and devid = $2`, [c.id, id, JSON.stringify(perf)]);
    return;
  }
  if (PUB.devices === 'off') return;
  let info = devClean(m.d) || {};
  if (JSON.stringify(info).length > 8000) return;
  const basic = PUB.devices === 'basic';
  if (basic) { const s = info.screen || {}; info = { ua: info.ua, lang: info.lang, touch: info.touch, screen: { w: s.w, h: s.h, dpr: s.dpr }, uach: info.uach ? { mobile: info.uach.mobile, platform: info.uach.platform } : undefined }; }
  c.devid = id;
  const r = await sql(`insert into public.devices as d (player, devid, sessions, info, ip, ips, country, region, city)
      values ($1, $2, 1, $3, $4, jsonb_build_array($4::text), $5, $6, $7)
      on conflict (player, devid) do update set sessions = d.sessions + 1, last_seen = now(), info = excluded.info, ip = excluded.ip,
        ips = (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select distinct on (x) x from jsonb_array_elements_text(jsonb_build_array($4::text) || d.ips) x limit 10) q),
        country = excluded.country, region = case when excluded.region <> '' then excluded.region else d.region end, city = case when excluded.city <> '' then excluded.city else d.city end
      returning (xmax = 0) as fresh, (select count(*) from public.devices x where x.player = $1)::int n`,
    [c.id, id, JSON.stringify(info), basic ? '' : c.ip || '', c.country || '', basic ? '' : c.region || '', basic ? '' : c.city || '']);
  const row = r.rows[0];
  if (row?.fresh && row.n > 1) {                       // nouvel appareil pour un joueur qui en avait déjà un
    secLog.push({ at: Date.now(), type: 'new_device', who: c.pseudo, dev: c.device, c: c.country, ip: maskIp(c.ip) });
    if (secLog.length > 1000) secLog.splice(0, secLog.length - 1000);
  }
}
async function relay(ws, c, m) {
  const t = m.type;
  let out = null;
  if (t === 'dev' || t === 'devp') {
    const k = 'dev:' + c.id + ':' + t;
    if (allow(k, t === 'dev' ? 6 : 20, 600e3)) await deviceSave(c, m).catch(e => noteError('appareils', e.message));
    return;
  }
  if (t === 'feed') { if (FEEDS.has(m.f)) out = { type: 'feed', f: m.f, a: await cleanFeed(m.a, c) }; }
  else if (t === 'market') {
    out = { type: 'market' };
    if (FEEDS.has(m.f)) { out.f = m.f; out.a = await cleanFeed(m.a, c); }
    if (typeof m.to === 'string' && UUID.test(m.to)) out.to = m.to;
  }
  else if (t === 'inv') {
    if (typeof m.to === 'string' && UUID.test(m.to)) out = { type: 'inv', to: m.to, kind: word(m.kind), delta: num(m.delta) || 0, from: c.pseudo, org: c.admin || undefined };
  }
  else if (['config', 'reload', 'reset'].includes(t) && c.admin) {
    out = { type: t, f: word(m.f), a: m.a && typeof m.a === 'object' ? { h: num(m.a.h) } : undefined };
  }
  if (!out) return;
  const s = JSON.stringify(out);
  count('bin', s.length);
  for (const other of clients.keys()) if (other !== ws && other.readyState === 1) { other.send(s); count('wsOut', s.length); }
}
// ---------- 🚪 File d'attente : quand le serveur est complet, on attend son tour (position en direct, entrée automatique) ----------
const waitQueue = [];                    // { ws, me, req, at }
const departures = [];                   // départs récents de joueurs (pour estimer l'attente)
const justLeft = new Map();              // joueur → heure de départ : une petite coupure réseau ne renvoie pas au bout de la file
async function maxOnline() { try { return (await sql('select max_online from public.game where id = 1')).rows[0]?.max_online || 0; } catch (e) { return 0; } }
function queueEta(pos) {
  const now = Date.now(); while (departures.length && now - departures[0] > 3600e3) departures.shift();
  const recent = departures.filter(t => now - t < 1800e3).length;
  if (recent >= 2) return Math.max(1, Math.round(pos * 30 / recent));                  // minutes, d'après les départs des 30 dernières minutes
  const S = sessionLog.slice(-200), lim = Math.max(1, onlineIds().size);
  if (S.length >= 5) { const avg = S.reduce((a, x) => a + x.d, 0) / S.length / 60e3; return Math.max(1, Math.round(pos * avg / lim)); }
  return null;
}
function queueNotify() {
  waitQueue.forEach((q, k) => { try { q.ws.send(JSON.stringify({ type: '__queue', pos: k + 1, total: waitQueue.length, eta: queueEta(k + 1), online: onlineIds().size, max: q.max })); } catch (e) {} });
}
let pumping = false;
async function queuePump() {
  if (pumping || !waitQueue.length) return;
  pumping = true;
  try {
    const lim = await maxOnline();
    while (waitQueue.length && (lim === 0 || onlineIds().size < lim)) {
      const q = waitQueue.shift();
      if (q.ws.readyState !== 1) continue;
      try { q.ws.send(JSON.stringify({ type: '__queue', go: true })); } catch (e) {}
      await admit(q.ws, q.me, q.req);
    }
    for (const q of waitQueue) q.max = lim;
    queueNotify();
  } finally { pumping = false; }
}
setInterval(() => { queuePump().catch(() => {}); idleSweep().catch(() => {}); }, 15000).unref();
// quand des joueurs attendent : les joueurs inactifs (jeu caché depuis 3 min, ou aucune action depuis 10 min) libèrent leur place
async function idleSweep() {
  if (!waitQueue.length) return;
  const lim = await maxOnline(); if (!lim) return;
  const now = Date.now(), byUser = new Map();
  for (const [ws, c] of clients) if (!c.admin) (byUser.get(c.id) || byUser.set(c.id, []).get(c.id)).push([ws, c]);
  let freed = 0;
  for (const [, socks] of byUser) {
    if (freed >= waitQueue.length) break;
    const active = socks.some(([, c]) => c.vis !== false && now - (c.lastAct || c.since) < 600e3);
    const hiddenLong = socks.every(([, c]) => c.vis === false && now - (c.hiddenAt || now) > 180e3);
    if (active && !hiddenLong) continue;
    for (const [ws, c] of socks) { c.idleOut = true; try { ws.send(JSON.stringify({ type: '__idle' })); } catch (e) {} ws.close(4005, 'inactif'); }
    freed++;
  }
  if (freed) log(`🚪 ${freed} joueur(s) inactif(s) ont laissé leur place à la file d'attente`);
}
// ---------- 🔥 Protection anti-surchauffe : si le PC est à bout de souffle trop longtemps, le jeu se met en pause ----------
const eldG = monitorEventLoopDelay({ resolution: 20 }); eldG.enable();
const guard = { bad: 0, until: 0, reason: '', since: 0, trips: [], last: null };
const guardOn = () => PUB.guard.on === null || PUB.guard.on === undefined ? !!INSTANCE_NAME : !!PUB.guard.on;
function guardCheck() {
  const lag = Math.max(0, Math.round(eldG.mean / 1e6 - 20)); eldG.reset();
  const mem = Math.round(100 * (1 - os.freemem() / os.totalmem()));
  guard.last = { cpu: Math.round(cpuPct), lag, mem, at: Date.now() };
  if (guard.until && Date.now() >= guard.until) guardReopen('auto');
  if (!guardOn() || guard.until || loadTest?.running || !clients.size) { guard.bad = 0; return; }
  const G = PUB.guard;
  const why = cpuPct >= G.cpu ? `processeur du PC à ${Math.round(cpuPct)} %`
    : lag >= G.lag ? `le jeu rame (${lag} ms de retard)`
    : mem >= G.mem ? `mémoire du PC pleine à ${mem} %` : '';
  if (!why) { guard.bad = 0; return; }
  guard.bad++;
  if (guard.bad * 5 >= G.mins * 60) guardTrip(why).catch(e => noteError('surchauffe', e.message));
}
setInterval(guardCheck, 5000).unref();
const overloadMsg = () => JSON.stringify({ type: '__overload', until: guard.until, reason: guard.reason });
async function guardTrip(why, manual) {
  const now = Date.now();
  guard.trips = guard.trips.filter(t => now - t < 3 * 3600e3); guard.trips.push(now);
  const mins = Math.min(120, Math.round(PUB.guard.pause * 2 ** (guard.trips.length - 1)));   // pauses de plus en plus longues si ça recommence
  guard.until = now + mins * 60e3; guard.reason = why; guard.since = now; guard.bad = 0;
  log(`🔥 Serveur saturé (${why}) : jeu mis en pause pour les joueurs pendant ${mins} min`);
  secLog.push({ at: now, type: 'overload', info: why }); if (secLog.length > 1000) secLog.splice(0, secLog.length - 1000);
  const msg = overloadMsg();
  let kicked = 0;
  for (const [ws, c] of clients) if (!c.admin) { c.idleOut = true; kicked++; try { ws.send(msg); } catch (e) {} ws.close(4006, 'saturé'); }
  for (const q of waitQueue.splice(0)) { try { q.ws.send(msg); } catch (e) {} q.ws.close(4006, 'saturé'); }
  notifyAdmins({ type: '__presalert', kind: 'overload', title: '🔥 Serveur saturé', body: `${why} · jeu en pause ${mins} min` });
  const ids = await adminIds();
  if (ids.length) await pushTo(ids, () => ({ title: `🔥 ${INSTANCE_NAME || 'Le Cube'} : serveur saturé, jeu en pause`,
    body: `${why} · ${kicked} joueur${kicked > 1 ? 's' : ''} déconnecté${kicked > 1 ? 's' : ''} · réouverture automatique dans ${mins} min (ou 👑 › Serveur)` }),
    { evenOnline: true, tag: 'overload', urgent: true });
}
function guardReopen(by) {
  if (!guard.until) return;
  guard.until = 0; guard.reason = ''; guard.bad = 0;
  log(by === 'auto' ? '🔥 Fin de la pause : le jeu est rouvert aux joueurs' : '🔥 Jeu rouvert par l’organisateur');
}
function guardPublic() {
  return { on: guardOn(), ...PUB.guard, onWanted: PUB.guard.on, paused: !!guard.until, until: guard.until || null, reason: guard.reason, since: guard.since || null,
    trips: guard.trips.length, last: guard.last, building: guard.bad * 5 };
}
wss.on('connection', async (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const uid = await userOf(token).catch(() => null);
  const me = uid ? await meOf(uid, true) : null;
  if (!me || me.status !== 'approved') { count('wsDeny'); if (token) secEvent('ws_deny', req, { why: uid ? 'compte non validé' : 'jeton inconnu' }); ws.close(4001, 'non autorisé'); return; }
  if (isBanned(me)) {
    count('wsDeny'); secEvent('ws_deny', req, { why: 'joueur exclu', who: me.pseudo });
    try { ws.send(JSON.stringify({ type: '__banned', until: me.banned_until, reason: me.ban_reason })); } catch (e) {}
    ws.close(4003, 'exclu'); return;
  }
  // Limite de joueurs connectés en même temps (réglable dans 👑). L'organisateur passe toujours,
  // et un joueur déjà connecté peut ouvrir un 2e onglet.
  if (!me.is_admin && guard.until) { try { ws.send(overloadMsg()); } catch (e) {} ws.close(4006, 'saturé'); return; }
  if (!me.is_admin) {
    const lim = await maxOnline();
    const ids = onlineIds();
    const back = Date.now() - (justLeft.get(me.id) || 0) < 90e3;
    if (back) justLeft.delete(me.id);
    if (lim > 0 && !ids.has(me.id) && !back && (ids.size >= lim || waitQueue.length)) {
      // complet : on prend sa place dans la file (une seule place par joueur, la plus ancienne est gardée)
      const old = waitQueue.findIndex(q => q.me.id === me.id);
      const entry = { ws, me, req, at: Date.now(), max: lim };
      if (old >= 0) { try { waitQueue[old].ws.close(4002, 'remplacé'); } catch (e) {} waitQueue[old] = entry; }
      else if (waitQueue.length < 500) waitQueue.push(entry);
      else { try { ws.send(JSON.stringify({ type: '__full', max: lim, online: ids.size })); } catch (e) {} ws.close(4002, 'complet'); return; }
      ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => { const k = waitQueue.findIndex(q => q.ws === ws); if (k >= 0) { waitQueue.splice(k, 1); queueNotify(); } });
      queueNotify();
      queuePump().catch(() => {});
      return;
    }
  }
  await admit(ws, me, req);
});
async function admit(ws, me, req) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const c = { id: me.id, pseudo: me.pseudo, admin: !!me.is_admin, mod: !!me.is_mod, since: Date.now(), msgs: 0, ip: ipOf(req),
              city: String(req.headers['cf-ipcity'] || '').slice(0, 60), region: String(req.headers['cf-region'] || '').slice(0, 60),
              country: String(req.headers['cf-ipcountry'] || '').slice(0, 2), device: deviceOf(req.headers['user-agent']), tokens: 40, tAt: Date.now(), vis: true };
  let first = false;
  try { first = (await sql('update public.profiles set first_seen = now() where id = $1 and first_seen is null returning 1', [me.id])).rows.length > 0; } catch (e) {}
  if (ws.readyState !== 1) return;
  clients.set(ws, c);
  sessionOpen(c, first);
  pseudoCache.set(me.id, me.pseudo);
  broadcastPresence();
  if (music.tracks.length) ws.send(JSON.stringify({ type: '__radio', state: radioState() }));
  ws.on('message', data => {
    // au plus 20 messages par seconde par connexion (40 d'avance)
    const now = Date.now();
    c.tokens = Math.min(40, c.tokens + (now - c.tAt) / 50); c.tAt = now;
    if (c.tokens < 1) return;
    c.tokens--; c.msgs++;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.type !== 'string' || m.type.length > 20) return;
    if (m.type === 'vis') { c.vis = m.v !== false; c.hiddenAt = c.vis ? null : (c.hiddenAt || Date.now()); return; }      // le jeu est-il affiché à l'écran ?
    if (m.type !== 'dev' && m.type !== 'devp') c.lastAct = now;      // dernière vraie action (pour la file d'attente)
    count('ws');
    wsTypes.set(m.type, (wsTypes.get(m.type) || 0) + 1);
    relay(ws, c, m).catch(e => noteError('relais', e.message));
  });
  ws.on('close', () => {
    clients.delete(ws); broadcastPresence(); sessionMaybeClose(c.id);
    if (!c.admin && ![...clients.values()].some(x => x.id === c.id)) {
      departures.push(Date.now());
      if (!c.idleOut && Date.now() - c.since > 20e3) { justLeft.set(c.id, Date.now()); if (justLeft.size > 2000) justLeft.delete(justLeft.keys().next().value); }
      queuePump().catch(() => {});
    }
  });
}

// ---------- 👑 Alertes pour l'organisateur : un joueur se connecte, puis se déconnecte (durée et stats de sa session) ----------
// Une coupure de moins d'une minute (page rechargée, réseau qui saute, mise à jour) ne compte pas comme une nouvelle session.
const ALERTS_FILE = path.join(STATE, 'alertes-connexion.json');
const presAlerts = { connect: true, disconnect: true, minMinutes: 0 };
try { Object.assign(presAlerts, JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'))); } catch (e) {}
const sessions = new Map();          // joueur → { start, pseudo, device, country, snap, endTimer, last }
const SESSION_GRACE = 60e3;
async function statSnap(uid) {
  const r = await sql(`select coalesce(st.blocks, 0)::bigint blocks, coalesce(st.hits, 0)::bigint hits, coalesce(st.artifacts_found, 0) arts,
      coalesce(st.gold_found, 0) gold, coalesce(st.materials_found, 0) mats, coalesce(st.chests, 0) chests, coalesce(st.missions_done, 0) missions,
      coalesce(st.crafted, 0) crafted, coalesce(st.trades, 0) trades, coalesce(st.deepest, 0) deepest, coalesce(st.best_combo, 0) combo,
      coalesce((select qty from public.inventory where player = $1 and kind = 'or'), 0) purse
    from (select 1) x left join public.stats st on st.player = $1`, [uid]);
  const o = r.rows[0] || {};
  for (const k in o) o[k] = Number(o[k]) || 0;
  return o;
}
async function adminIds() { return (await sql('select id from public.profiles where is_admin')).rows.map(r => r.id); }
async function alertAdmins(kind, uid, title, body) {
  notifyAdmins({ type: '__presalert', kind, title, body });           // dans le jeu (si l'organisateur y est)
  const ids = (await adminIds()).filter(id => id !== uid);
  if (ids.length) await pushTo(ids, () => ({ title, body }), { tag: `co-${kind}-${uid}`, ttl: 3600 });   // sur le téléphone sinon
}
const fmtN = n => Number(n).toLocaleString('fr-FR');
const fmtDur = ms => {
  const m = Math.round(ms / 60e3);
  if (m < 1) return 'moins d’une minute';
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
};
// 🆕 Un inconnu s'inscrit : l'organisateur est prévenu (dans le jeu, ou sur son téléphone s'il n'y est pas)
async function signupAlert(uid) {
  const r = (await sql(`select p.pseudo, p.status, g.max_players,
      (select count(*) from public.profiles where status = 'approved' and not is_admin)::int n
    from public.profiles p, public.game g where p.id = $1 and g.id = 1`, [uid])).rows[0];
  if (!r) return;
  const auto = r.status === 'approved';
  const places = r.max_players ? ` · ${r.n} / ${r.max_players} places prises` : '';
  const title = auto ? `🆕 ${r.pseudo} vient de s’inscrire` : `🆕 ${r.pseudo} attend ta validation`;
  const body = auto ? `Validé automatiquement${places}` : `Nouvelle inscription à accepter ou refuser dans 👑${places}`;
  notifyAdmins({ type: '__signup', pseudo: r.pseudo, auto, n: r.n, max: r.max_players });
  const ids = (await adminIds()).filter(id => id !== uid);
  if (ids.length) await pushTo(ids, () => ({ title, body }), { tag: 'signup-' + uid, ttl: 24 * 3600, urgent: true });
}
function sessionOpen(c, first) {
  if (c.admin) return;
  const s = sessions.get(c.id);
  if (s) { if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null; } return; }   // revenu tout de suite : même session
  const ses = { start: Date.now(), pseudo: c.pseudo, device: c.device, country: c.country, snap: null, endTimer: null, last: 0 };
  sessions.set(c.id, ses);
  statSnap(c.id).then(snap => { ses.snap = snap;
    // ✨ tout premier passage dans le cube : toujours signalé, même si les alertes de connexion sont coupées
    if (first) return alertAdmins('first', c.id, `✨ ${c.pseudo} entre dans le cube pour la première fois`,
      [c.device !== '?' && c.device, c.country, 'Nouveau joueur'].filter(Boolean).join(' · '));
    if (presAlerts.connect)
    return alertAdmins('in', c.id, `🟢 ${c.pseudo} vient de se connecter`,
      [c.device !== '?' && c.device, c.country, `${fmtN(snap.blocks)} blocs cassés au total`].filter(Boolean).join(' · ')); })
    .catch(e => noteError('alerte connexion', e.message));
}
function sessionMaybeClose(uid) {
  const s = sessions.get(uid);
  if (!s || [...clients.values()].some(c => c.id === uid)) return;
  s.last = Date.now();
  clearTimeout(s.endTimer);
  s.endTimer = setTimeout(() => sessionClose(uid).catch(e => noteError('alerte déconnexion', e.message)), SESSION_GRACE);
}
async function sessionClose(uid) {
  const s = sessions.get(uid);
  if (!s || [...clients.values()].some(c => c.id === uid)) return;
  sessions.delete(uid);
  const dur = (s.last || Date.now()) - s.start;
  const a = s.snap || {}, b = await statSnap(uid), d = k => Math.max(0, (b[k] || 0) - (a[k] || 0));
  logSession({ id: uid, p: s.pseudo, s: s.start, d: dur, b: d('blocks'), h: d('hits'), g: d('gold'), dev: s.device, c: s.country });
  if (!presAlerts.disconnect || dur < (presAlerts.minMinutes || 0) * 60e3) return;
  const parts = [`⛏️ ${fmtN(d('blocks'))} bloc${d('blocks') > 1 ? 's' : ''}`];
  if (d('gold')) parts.push(`🪙 +${fmtN(d('gold'))} trouvés`);
  const purse = (b.purse || 0) - (a.purse || 0);
  if (purse) parts.push(`👛 ${purse > 0 ? '+' : ''}${fmtN(purse)}`);
  if (d('arts')) parts.push(`🏺 ${d('arts')} artefact${d('arts') > 1 ? 's' : ''}`);
  if (d('mats')) parts.push(`🧱 ${fmtN(d('mats'))} matériau${d('mats') > 1 ? 'x' : ''}`);
  if (d('chests')) parts.push(`📦 ${d('chests')} coffre${d('chests') > 1 ? 's' : ''}`);
  if (d('missions')) parts.push(`🎯 ${d('missions')} mission${d('missions') > 1 ? 's' : ''}`);
  if (d('crafted')) parts.push(`⚒️ ${d('crafted')} fabriqué${d('crafted') > 1 ? 's' : ''}`);
  if (d('trades')) parts.push(`🤝 ${d('trades')} échange${d('trades') > 1 ? 's' : ''}`);
  if (b.deepest > (a.deepest || 0)) parts.push(`⬇️ record : couche ${b.deepest}`);
  if (b.combo > (a.combo || 0)) parts.push(`🔥 record combo ${b.combo}`);
  const mins = dur / 60e3, rate = mins >= 1 ? Math.round(d('blocks') / mins) : 0;
  if (rate) parts.push(`⚡ ${fmtN(rate)} blocs/min`);
  await alertAdmins('out', uid, `🔴 ${s.pseudo} s’est déconnecté · ${fmtDur(dur)}`, parts.join(' · '));
  log(`👋 ${s.pseudo} : session de ${fmtDur(dur)}, ${d('blocks')} blocs`);
}
setInterval(() => {
  for (const ws of [...clients.keys(), ...waitQueue.map(q => q.ws)]) { if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); } }
}, 30000);

// ---------- Entretien de la base (chaque nuit à 4 h 45) et sauvegardes (chaque nuit à 5 h, les 10 dernières gardées) ----------
// PGlite ne nettoie pas tout seul les anciennes versions des lignes : sans cet entretien, la base grossit et ralentit.
let lastVacuum = null, lastBackup = null;
async function vacuum() {
  if (stopping) return null;
  const t0 = performance.now(), before = dataSize();
  try {
    await exclusive(() => db.exec('vacuum analyze'));
    dataSizeCache.at = 0;
    lastVacuum = { at: new Date().toISOString(), ms: Math.round(performance.now() - t0), before, after: dataSize() };
    dbStatsCache.at = 0;
    log(`Base optimisée en ${Math.round(lastVacuum.ms / 1000)} s`);
    return lastVacuum;
  } catch (e) { log('Optimisation impossible :', e.message); noteError('optimisation', e.message); return null; }
}
let backingUp = false;
async function backup(kind = 'auto') {
  if (backingUp || stopping) return null;
  backingUp = true;
  const t0 = performance.now();
  try {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const file = await exclusive(() => db.dumpDataDir('gzip'));
    let name = `sauvegarde-${stamp()}${kind !== 'auto' ? '-' + kind : ''}.tar.gz`;
    for (let k = 2; fs.existsSync(path.join(BACKUPS, name)); k++) name = name.replace(/(-\d+)?\.tar\.gz$/, `-${k}.tar.gz`);
    fs.writeFileSync(path.join(BACKUPS, name), Buffer.from(await file.arrayBuffer()));
    const all = listBackups();
    for (const old of all.slice(0, -KEEP_BACKUPS)) fs.unlinkSync(path.join(BACKUPS, old.name));
    lastBackup = { at: new Date().toISOString(), ms: Math.round(performance.now() - t0), ok: true, name };
    log('Sauvegarde faite :', name);
    return name;
  } catch (e) {
    lastBackup = { at: new Date().toISOString(), ms: Math.round(performance.now() - t0), ok: false, error: e.message };
    log('Sauvegarde impossible :', e.message); noteError('sauvegarde', e.message); return null;
  }
  finally { backingUp = false; }
}
// au démarrage : une sauvegarde si la dernière date de plus de 20 heures
setTimeout(() => { const l = listBackups().pop(); if (!l || Date.now() - new Date(l.at) > 20 * 3600e3) backup(); }, 60 * 1000);
let nightDone = '';
setInterval(() => {
  const d = new Date(), day = d.toDateString();
  if (d.getHours() === 4 && d.getMinutes() >= 45 && nightDone !== day + 'v') { nightDone = day + 'v'; vacuum(); }
  if (d.getHours() === 5 && nightDone !== day + 'b') { nightDone = day + 'b'; backup(); }
}, 60 * 1000).unref();

// ---------- Tunnel Internet gratuit (Cloudflare) ----------
function startTunnel() {
  if (process.env.TUNNEL === '0' || stopping) return;
  if (INSTANCE.tunnel === false) {                       // passe par le tunnel du premier serveur (adresse ajoutée dans Cloudflare)
    tunnelMode = 'partagé'; tunnelOk = true; tunnelSince = new Date().toISOString();
    log(`🔗 Pas de tunnel ici : ce serveur (port ${PORT}) passe par le tunnel du premier serveur`);
    return;
  }
  const local = path.join(DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const bin = fs.existsSync(local) ? local : 'cloudflared';
  // Tunnel permanent : jeton Cloudflare (fichier tunnel-jeton.txt, ou collé dans 👑 › Serveur)
  // on accepte le jeton seul ou la commande entière copiée depuis Cloudflare : on y repère le jeton (il commence par « eyJ »)
  const tok = fs.existsSync(TOKEN_FILE) ? (fs.readFileSync(TOKEN_FILE, 'utf8').match(/eyJ[A-Za-z0-9_\-=.]{40,}/) || [''])[0] : '';
  const args = tok ? ['tunnel', '--no-autoupdate', 'run', '--token', tok] : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`];
  tunnelMode = tok ? 'permanent' : 'gratuit'; tunnelOk = false;
  if (tok) log('Tunnel permanent : utilisation du jeton enregistré');
  let proc;
  try { proc = spawn(bin, args, { windowsHide: true }); }
  catch (e) { log('Tunnel non lancé :', e.message); return; }
  proc.on('error', () => { tunnelMode = 'aucun'; log('⚠️  cloudflared introuvable : le jeu n’est accessible que sur le réseau local.'); });
  let shown = false;
  const onData = d => {
    const t = String(d);
    if (/Registered tunnel connection/i.test(t)) { if (!tunnelOk) tunnelSince = new Date().toISOString(); tunnelOk = true; }      // vraiment relié à Cloudflare
    if (/Unregistered tunnel connection|Connection terminated|Retrying connection/i.test(t)) tunnelDrops++;
    if (tok && tunnelOk) {
      if (!shown) { shown = true; console.log('\n  🌍  Tunnel permanent connecté : le jeu est en ligne à l’adresse que tu as choisie dans Cloudflare.\n'); }
    }
    const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true; tunnelUrl = m[0];
      fs.writeFileSync(ADDRESS_FILE, m[0] + '\n');
      console.log('\n' + '='.repeat(64));
      console.log('  🌍  ADRESSE DU JEU À ENVOYER AUX JOUEURS :');
      console.log('      ' + m[0]);
      console.log('  (aussi enregistrée dans le fichier ADRESSE-DU-JEU.txt)');
      console.log('='.repeat(64) + '\n');
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', code => {
    tunnelOk = false; tunnelSince = null;
    if (!stopping) { log('Tunnel arrêté (code ' + code + '), relance dans 10 s…'); noteError('tunnel', 'arrêté (code ' + code + ')'); setTimeout(startTunnel, 10000); }
  });
  tunnelProc = proc;
}
let tunnelProc = null, stopping = false;

// ---------- 🤖 Robots-mineurs : c'est le serveur qui les fait travailler, toutes les 2 secondes ----------
// Chaque robot regroupe ses coups (1 seul passage par la base toutes les 2 s) : très léger pour le PC.
const ROBOT_TICK = 2000;
const robotMem = new Map();            // n° du robot → { carry, target, last, working, waiting }
let robotNames = [], robotBusy = false;
const ROBOT_MAT = { silex: '🪨', fer: '🔩', poudre: '🧪', cristal: '💎' };
function robotIsCore(i, s) {
  const lo = s % 2 === 0 ? s / 2 - 1 : (s - 1) / 2 - 1, hi = s % 2 === 0 ? s / 2 : (s - 1) / 2 + 1;
  const x = i % s, y = Math.floor(i / s) % s, z = Math.floor(i / (s * s));
  return x >= lo && x <= hi && y >= lo && y <= hi && z >= lo && z <= hi;
}
// un bloc de la surface, au hasard : on vise depuis une face du cube et on avance jusqu'au premier bloc encore là
function robotPick(s) {
  const d = grid.data;
  for (let t = 0; t < 60; t++) {
    const face = Math.floor(Math.random() * 6), u = Math.floor(Math.random() * s), v = Math.floor(Math.random() * s);
    for (let w = 0; w < s; w++) {
      const a = face % 2 === 0 ? w : s - 1 - w;
      const x = face < 2 ? a : u, y = face < 2 ? u : face < 4 ? a : v, z = face < 4 ? v : a;
      const i = x + y * s + z * s * s;
      if (d[i] === 0) continue;
      if (robotIsCore(i, s)) break;                 // le cœur : on cherche ailleurs
      return i;
    }
  }
  return -1;
}
// un bloc « à l'air libre » : sur le bord du cube, ou à côté d'un bloc déjà cassé
function robotExposed(i, s) {
  const d = grid.data, x = i % s, y = Math.floor(i / s) % s, z = Math.floor(i / (s * s)), ss = s * s;
  if (x === 0 || y === 0 || z === 0 || x === s - 1 || y === s - 1 || z === s - 1) return true;
  return d[i - 1] === 0 || d[i + 1] === 0 || d[i - s] === 0 || d[i + s] === 0 || d[i - ss] === 0 || d[i + ss] === 0;
}
// 🧑‍🔧 comme un joueur : le bloc suivant est juste à côté du précédent (il creuse son coin)
function robotNear(c, s, local) {
  if (!(c >= 0) || c >= grid.data.length) return -1;
  const d = grid.data, cx = c % s, cy = Math.floor(c / s) % s, cz = Math.floor(c / (s * s));
  for (let R = 1; R <= 3; R++) {
    const cand = [];
    for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== R) continue;
      const x = cx + dx, y = cy + dy, z = cz + dz;
      if (x < 0 || y < 0 || z < 0 || x >= s || y >= s || z >= s) continue;
      const i = x + y * s + z * s * s;
      if (d[i] === 0 || local.get(i) === 0 || robotIsCore(i, s) || !robotExposed(i, s)) continue;
      cand.push(i);
    }
    if (cand.length) return cand[Math.floor(Math.random() * cand.length)];
  }
  return -1;
}
// changer de coin, mais pas trop loin : on vise depuis la face la plus proche, à quelques blocs de là
function robotAround(c, s) {
  if (!(c >= 0) || c >= grid.data.length) return -1;
  const d = grid.data, h = (s - 1) / 2, p = [c % s, Math.floor(c / s) % s, Math.floor(c / (s * s))];
  let ax = 0; for (let k = 1; k < 3; k++) if (Math.abs(p[k] - h) > Math.abs(p[ax] - h)) ax = k;
  const from0 = p[ax] < h, o = [0, 1, 2].filter(k => k !== ax), R = 6;
  for (let t = 0; t < 30; t++) {
    const q = [0, 0, 0];
    q[o[0]] = Math.max(0, Math.min(s - 1, p[o[0]] + Math.round((Math.random() * 2 - 1) * R)));
    q[o[1]] = Math.max(0, Math.min(s - 1, p[o[1]] + Math.round((Math.random() * 2 - 1) * R)));
    for (let w = 0; w < s; w++) {
      q[ax] = from0 ? w : s - 1 - w;
      const i = q[0] + q[1] * s + q[2] * s * s;
      if (d[i] === 0) continue;
      if (robotIsCore(i, s)) break;
      return i;
    }
  }
  return -1;
}
// répartit les coups : le robot s'acharne sur un bloc jusqu'à le casser, puis prend le voisin
function robotPlan(mem, hits, s) {
  const idx = [], n = [], local = new Map();
  for (let guard = 0; hits > 0 && guard < 200; guard++) {
    let i = mem.target;
    if (!(i >= 0) || i >= grid.data.length || grid.data[i] === 0 || local.get(i) === 0) {
      // de temps en temps (ou quand son coin est fini) il se déplace un peu ; au tout début, il choisit un endroit au hasard
      i = Math.random() < 0.03 ? -1 : robotNear(mem.pos, s, local);
      if (i < 0) i = robotAround(mem.pos, s);
      if (i < 0) i = robotPick(s);
      mem.target = i; if (i >= 0) mem.pos = i;
    }
    if (i < 0) break;
    let hp = local.has(i) ? local.get(i) : (grid.data[i] === 255 ? grid.maxHp : grid.data[i]);
    const m = Math.max(1, Math.min(hp, hits));
    idx.push(i); n.push(m); hits -= m; hp -= m; local.set(i, Math.max(0, hp));
    if (hp <= 0) mem.target = -1;
  }
  return { idx, n };
}
function robotLootText(l, lang) {
  const en = lang === 'en', parts = [];
  if (l.or) parts.push(`${l.or} 🪙`);
  for (const [k, ic] of Object.entries(ROBOT_MAT)) if (l[k]) parts.push(`${l[k]} ${ic}`);
  const arts = Object.entries(l).filter(([k]) => !['or', '_coffres', '_blocs', ...Object.keys(ROBOT_MAT)].includes(k)).reduce((a, [, q]) => a + (+q || 0), 0);
  if (arts) parts.push(en ? `${arts} artifact${arts > 1 ? 's' : ''}` : `${arts} artefact${arts > 1 ? 's' : ''}`);
  return parts.join(' · ');
}
const robotPublic = d => { const o = { ...d }; delete o.r; return o; };
async function robotTick() {
  if (stopping || robotBusy || grid.building) return;
  if (!grid.data) { gridBuild().catch(e => noteError('cube en mémoire', e.message)); return; }   // cube pas encore chargé (nouveau cube…)
  robotBusy = true;
  try {
    const rows = (await sql(`select r.id, r.owner, r.kind, r.rate, r.name, r.icon, coalesce(r.broke_until > now(), false) as broke, p.pseudo,
                               (select robots_max from public.game where id = 1) as mx
                             from public.robots r join public.profiles p on p.id = r.owner where r.status = 'active' order by r.started_at, r.id`)).rows;
    const online = new Set([...clients.values()].map(c => c.id)), now = performance.now(), seen = new Set(), names = [];
    let slots = rows[0]?.mx || 10;
    for (const r of rows) {
      const id = +r.id; seen.add(id);
      let mem = robotMem.get(id);
      if (!mem) robotMem.set(id, mem = { carry: 0, target: -1, pos: -1, last: now, working: null, waiting: false });
      const ownerOn = online.has(r.owner);
      let work = r.kind === 'offline' ? !ownerOn : true;
      mem.waiting = work && slots <= 0;              // trop de robots en même temps : il attend son tour (son temps ne compte pas)
      if (mem.waiting) work = false;
      if (work) slots--;
      const dt = Math.max(0, Math.min(10, (now - mem.last) / 1000)); mem.last = now;
      // 🌙 le propriétaire revient : bilan de son absence
      if (r.kind === 'offline' && mem.working === true && !work && ownerOn) {
        const ses = (await sql('select public._robot_session_take($1) s', [id])).rows[0]?.s || {};
        if (+ses._blocs > 0) notifyUser(r.owner, { type: '__robot', ev: 'back', ses });
      }
      mem.working = work;
      if (work) names.push(r.pseudo);
      if (!work) {
        if (ownerOn) {
          const st = (await sql('select public._robot_json(x) j from public.robots x where id = $1', [id])).rows[0]?.j;
          if (st) notifyUser(r.owner, { type: '__robot', r: { ...st, paused: true, waiting: mem.waiting } });
        }
        continue;
      }
      let plan = { idx: [], n: [] };
      if (!r.broke) {
        mem.carry += +r.rate * dt;
        const h = Math.min(200, Math.floor(mem.carry)); mem.carry -= h;
        if (h > 0) plan = robotPlan(mem, h, grid.size);
      }
      const d = (await sql('select public._robot_strike($1, $2::int[], $3::int[], $4) r',
        [id, `{${plan.idx.join(',')}}`, `{${plan.n.join(',')}}`, dt])).rows[0]?.r;
      if (!d) continue;
      const flat = [];
      for (const [i, v] of d.r || []) { gridPatch(i, v); flat.push(i, v); if (v === 0) replayAdd(i); }
      if (flat.length) { broadcastAll({ type: 'hits', r: flat, rb: 1 }); count('hits', plan.n.reduce((a, b) => a + b, 0)); }
      // 📍 où travaille le robot (pour l'afficher dans le cube de tout le monde)
      if (mem.pos >= 0) broadcastAll({ type: 'rpos', id, n: r.pseudo, ic: r.icon, i: mem.target >= 0 ? mem.target : mem.pos, broke: !!r.broke || !!d.trap, own: r.owner });
      dailyNews(d.msgs, '🤖 ' + r.pseudo);
      for (const m of d.msgs || []) if (typeof m === 'string' && m.startsWith('🎯')) broadcastAll({ type: 'feed', text: m });
      if (ownerOn) notifyUser(r.owner, { type: '__robot', r: robotPublic(d), ev: d.trap ? 'trap' : undefined });
      if (d.status === 'done') await robotFinished(d, r.pseudo, ownerOn);
    }
    // robots arrêtés par l'organisateur (ou effacés) depuis le dernier passage
    const gone = [...robotMem.keys()].filter(id => !seen.has(id));
    for (const id of gone) robotMem.delete(id);
    if (gone.length) {
      const ended = (await sql(`select public._robot_json(r) j, p.pseudo from public.robots r join public.profiles p on p.id = r.owner where r.id = any($1::bigint[]) and r.status = 'stopped'`, [`{${gone.join(',')}}`])).rows;
      for (const e of ended) await robotFinished(e.j, e.pseudo, online.has(e.j.owner));
    }
    const key = [...new Set(names)].sort().join('|');
    if (key !== robotNames.join('|')) { robotNames = key ? key.split('|') : []; broadcastPresence(); }
  } catch (e) { noteError('robots', e.message); if (e.message !== robotTick.lastErr) { robotTick.lastErr = e.message; log('⚠️  Robots : ' + e.message); } }
  finally { robotBusy = false; }
}
async function robotFinished(d, pseudo, ownerOn) {
  if (ownerOn) {
    notifyUser(d.owner, { type: '__robot', ev: d.status === 'stopped' ? 'stopped' : 'end', r: robotPublic(d) });
    await sql('update public.robots set seen_end = true where id = $1', [d.id]).catch(() => {});
  }
  const fr = `${d.icon} Le robot de ${pseudo} a terminé : ${d.blocks} bloc${d.blocks > 1 ? 's' : ''} cassé${d.blocks > 1 ? 's' : ''}`;
  const en = `${d.icon} ${pseudo}’s robot is done: ${d.blocks} block${d.blocks > 1 ? 's' : ''} broken`;
  broadcastAll({ type: 'robotfeed', fr, en });
  pushTo([d.owner], FR_EN({ title: `${d.icon} ${d.status === 'stopped' ? 'Ton robot a été arrêté' : 'Ton robot a fini son travail'}`, body: `${d.blocks} blocs cassés${robotLootText(d.loot || {}) ? ' · ' + robotLootText(d.loot || {}) : ''}` },
                          { title: `${d.icon} ${d.status === 'stopped' ? 'Your robot was stopped' : 'Your robot finished its work'}`, body: `${d.blocks} blocks broken${robotLootText(d.loot || {}, 'en') ? ' · ' + robotLootText(d.loot || {}, 'en') : ''}` }),
         { tag: 'robot' }).catch(() => {});
}
setInterval(robotTick, ROBOT_TICK);

// ---------- 🧭 Pilote automatique de l'organisateur : garde la partie au bon rythme ----------
// Toutes les 10 minutes, et seulement quand des joueurs sont connectés, il compare le rythme réel de la partie
// à la date de fin choisie, puis ajuste en douceur : artefacts et coffres encore cachés, fréquence de l'or et des
// matériaux, profondeur où l'on trouve les matériaux rares, et (en option) prix de la boutique et recettes de l'atelier.
// Il ne touche jamais aux blocs, aux sacs des joueurs, ni à ce qui est visible à l'écran.
const AP_STEP = 10 * 60e3;              // un réglage toutes les 10 minutes de jeu
const AP_ECO = 30 * 60e3;               // or et matériaux : au plus toutes les 30 minutes
const AP_PRICE = 6 * 3600e3;            // prix : au plus toutes les 6 heures
const AP_RECIPE = 12 * 3600e3;          // recettes : au plus toutes les 12 heures
const AP_MATS = ['silex', 'fer', 'poudre', 'cristal'];
const AP_MATVAL = { silex: 1, fer: 2, poudre: 3, cristal: 5 };
const AP_LEGEND = ['ecorce', 'oeil'];
const AP_TRAPS = ['toile', 'lenteur', 'brouillard', 'macon', 'durci', 'pickpocket'];
let ap = null, apBusy = false, apLastSample = 0;
const apClamp = (x, a, b) => Math.min(b, Math.max(a, x));
const apNice = x => x < 20 ? Math.round(x) : x < 100 ? Math.round(x / 5) * 5 : x < 1000 ? Math.round(x / 10) * 10 : Math.round(x / 50) * 50;
const apMedian = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const apFmt = n => Math.round(n).toLocaleString('fr-FR');
const apDec = (n, d = 2) => (+n).toLocaleString('fr-FR', { maximumFractionDigits: d });
async function apLoad() {
  try { ap = (await sql('select autopilot from public.game where id = 1')).rows[0]?.autopilot || {}; } catch (e) { ap = {}; }
  return ap;
}
async function apSave() { await sql('update public.game set autopilot = $1 where id = 1', [JSON.stringify(ap)]); }
function apLog(txt, kind = 'info') {
  ap.log = [{ at: new Date().toISOString(), txt, kind }, ...(ap.log || [])].slice(0, 80);
}
// rythme mesuré : blocs par jour sur les 48 dernières heures (relevés toutes les 10 minutes)
function apPace(D, T) {
  const now = Date.now(), S = ap.samples || [];
  const win = S.filter(s => now - s[0] <= 48 * 3600e3);
  const first = win[0] || S[0];
  const spanH = first ? (now - first[0]) / 3600e3 : 0;
  const rate = spanH > 0.4 ? Math.max(0, D - first[1]) / (spanH / 24) : 0;          // blocs / jour
  const daysLeft = Math.max(0.25, (new Date(ap.end) - now) / 864e5);
  const left = Math.max(0, T - D), need = left / daysLeft;                             // blocs / jour qu'il faudrait
  const R = need > 0 ? rate / need : 1;                                                // > 1 : trop vite · < 1 : trop lent
  const conf = apClamp(spanH / 12, 0, 1);                                              // fiable après une douzaine d'heures de relevés
  const Reff = Math.pow(apClamp(R || 0.05, 0.05, 20), conf);
  return { rate, need, R, Reff, conf, spanH, daysLeft, left, eta: rate > 0 ? left / rate : Infinity };
}
function apExposed(i) {
  const d = grid.data, s = grid.size; if (!d || !s) return true;
  const x = i % s, y = Math.floor(i / s) % s, z = Math.floor(i / (s * s));
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const X = x + dx, Y = y + dy, Z = z + dz;
    if (X < 0 || Y < 0 || Z < 0 || X >= s || Y >= s || Z >= s) return true;
    if (d[X + Y * s + Z * s * s] === 0) return true;
  }
  return false;
}
async function apStep(force) {
  if (apBusy || !ap?.on || stopping) return;
  apBusy = true;
  try {
    const now = Date.now();
    const g = (await sql(`select size, destroyed, gold_every, mat_every, mat_w, mat_shift, peeled, started_at from public.game where id = 1`)).rows[0];
    const T = g.size ** 3, D = +g.destroyed;
    // relevé du rythme (même sans joueur connecté : c'est une seule petite lecture)
    let dirty = false;
    if (now - apLastSample >= AP_STEP - 5000 || !(ap.samples || []).length) {
      apLastSample = now; dirty = true;
      ap.samples = [...(ap.samples || []), [now, D]].filter(s => now - s[0] <= 7 * 864e5).slice(-1100);
    }
    const players = new Set([...clients.values()].map(c => c.id));   // quelqu'un est connecté (l'organisateur compte aussi)
    if (!players.size && !force) { if (dirty || !ap.waiting) { ap.waiting = true; await apSave(); } return; }
    ap.waiting = false;
    if (!force && now - (ap.last || 0) < AP_STEP - 5000) { if (dirty) await apSave(); return; }
    ap.last = now; ap.steps = (ap.steps || 0) + 1;
    if (!grid.data && !grid.building) await gridBuild();     // pour savoir ce qui est encore enfoui (jamais retirer un objet visible)
    const P = apPace(D, T);
    ap.pace = { rate: Math.round(P.rate), need: Math.round(P.need), R: +P.R.toFixed(3), conf: +P.conf.toFixed(2), eta: isFinite(P.eta) ? +P.eta.toFixed(1) : null, daysLeft: +P.daysLeft.toFixed(1), at: now };
    const changes = [];
    let refresh = false;
    // ---------- 1) artefacts et coffres encore cachés ----------
    const Atarget = apClamp(Math.pow(P.Reff, -0.6), 0.35, 2.5);
    const A0 = ap.A || 1, A = +(A0 * apClamp(Atarget / A0, 0.87, 1.15)).toFixed(3);
    ap.A = A;
    const Ch = +apClamp(Math.sqrt(A), 0.6, 1.6).toFixed(3);
    ap.Ch = Ch;
    const plan = (await sql('select public._plan(null) p')).rows[0].p || {};
    const hidden = Object.fromEntries((await sql(`select kind, count(*)::int n from public.artifacts where found_by is null group by kind`)).rows.map(r => [r.kind, r.n]));
    const ch = (await sql(`select count(*) filter (where not trap)::int c, count(*) filter (where trap)::int f from public.chests where opened_by is null`)).rows[0];
    hidden.coffre = ch.c; hidden.faux_coffre = ch.f;
    let added = 0, removed = 0, chAdd = 0, chDel = 0;
    for (const [k, v] of Object.entries(plan)) {
      if (AP_TRAPS.includes(k) || k === 'faux_coffre') continue;           // pièges : on n'y touche pas
      const base = +v.n || 0; if (base <= 0) continue;
      const mult = AP_LEGEND.includes(k) ? 1 : k === 'coffre' ? Ch : A;
      const want = Math.max(AP_LEGEND.includes(k) ? Math.min(1, base) : 0, Math.round(base * mult));
      const have = hidden[k] || 0, tol = Math.max(1, Math.round(want * 0.1)), cap = Math.max(2, Math.round(Math.max(want, have) * 0.3));
      if (have < want - tol) {
        const n = Math.min(cap, want - have);
        const got = +(await sql('select public._place($1, $2, $3, $4, $5) n', [k, n, v.lo, v.hi, k === 'coffre' ? 'chest' : 'art'])).rows[0].n || 0;
        if (k === 'coffre') chAdd += got; else added += got;
      } else if (have > want + tol && !AP_LEGEND.includes(k)) {
        const n = Math.min(cap, have - want);
        // on ne retire que ce qui est encore enfoui (jamais un coffre déjà visible à l'écran)
        const cand = k === 'coffre' ? (await sql('select i from public.chests where opened_by is null and not trap')).rows.map(r => r.i)
                                    : (await sql('select i from public.artifacts where found_by is null and kind = $1', [k])).rows.map(r => r.i);
        const pick = cand.filter(i => !apExposed(i)).sort(() => Math.random() - 0.5).slice(0, n);
        if (pick.length) {
          if (k === 'coffre') await sql('delete from public.chests where opened_by is null and not trap and i = any($1::int[])', [`{${pick}}`]);
          else await sql('delete from public.artifacts where found_by is null and kind = $1 and i = any($2::int[])', [k, `{${pick}}`]);
          if (k === 'coffre') chDel += pick.length; else removed += pick.length;
        }
      }
    }
    if (added || removed) changes.push(`🎲 artefacts cachés ×${apDec(A)} (${added ? '+' + added : ''}${added && removed ? ' / ' : ''}${removed ? '−' + removed : ''})`);
    if (chAdd || chDel) { changes.push(`🎁 coffres ×${apDec(Ch)} (${chAdd ? '+' + chAdd : ''}${chAdd && chDel ? ' / ' : ''}${chDel ? '−' + chDel : ''})`); refresh = true; }
    // ---------- 2) or, matériaux et profondeur des matériaux rares ----------
    const act = (await sql(`select p.id, coalesce((select json_object_agg(kind, qty) from public.inventory i where i.player = p.id and i.qty > 0), '{}') inv
        from public.profiles p left join public.stats st on st.player = p.id
        where p.status = 'approved'                     -- l'organisateur compte comme un joueur à part entière
          and (greatest(st.last_seen, st.seen_at) > now() - interval '3 days' or p.id = any($1::uuid[]))`, [`{${[...players]}}`])).rows;
    const recipes = (await sql('select result, ingredients from public.recipes where enabled')).rows;
    const shopRows = (await sql('select kind, price from public.shop')).rows, shop = Object.fromEntries(shopRows.map(r => [r.kind, +r.price]));
    const basePrices = ap.base?.prices || shop;
    const Pm = apMedian(Object.values(basePrices).filter(x => x > 0)) || 40;
    const worth = inv => Object.entries(inv || {}).reduce((a, [k, q]) => a + q * (k === 'or' ? 1 : AP_MATVAL[k] ?? (shop[k] || 25)), 0);
    const Q = act.length ? apClamp(apMedian(act.map(p => worth(p.inv))) / (4 * Pm), 0.15, 8) : 1;
    ap.Q = +Q.toFixed(3);
    // profondeur où l'on creuse en ce moment (moyenne glissante des couches qui avancent)
    const layers = Object.fromEntries((await sql('select d, n from public.layer_done')).rows.map(r => [r.d, +r.n]));
    const prevL = ap.layerSnap || layers, dig = ap.dig || {};
    for (const k in dig) dig[k] *= 0.85;
    for (const [d, n] of Object.entries(layers)) { const dd = n - (prevL[d] || 0); if (dd > 0) dig[d] = (dig[d] || 0) + dd; }
    ap.layerSnap = layers; ap.dig = Object.fromEntries(Object.entries(dig).filter(([, v]) => v > 0.5));
    const lm = Math.max(1, Math.floor((g.size - 1) / 2));
    let tot = 0, acc = 0, dMed = null; const digList = Object.entries(ap.dig).map(([d, v]) => [+d, v]).sort((a, b) => a[0] - b[0]);
    for (const [, v] of digList) tot += v;
    for (const [d, v] of digList) { acc += v; if (acc >= tot / 2) { dMed = d; break; } }
    ap.digT = dMed == null ? null : +(dMed / lm).toFixed(3);
    if (force || now - (ap.ecoAt || 0) >= AP_ECO - 5000) {
      ap.ecoAt = now;
      const base = ap.base || {};
      const w = { ...(g.mat_w || {}) }; for (const m of AP_MATS) w[m] = +(w[m] ?? 1);
      const need = {};
      for (const m of AP_MATS) { const q = recipes.map(r => +(r.ingredients?.[m] || 0)).filter(x => x > 0); need[m] = q.length ? q.reduce((a, b) => a + b, 0) / q.length : 2; }
      const X = {};
      const mm = [];
      for (const m of AP_MATS) {
        const hold = apMedian(act.map(p => +(p.inv?.[m] || 0)));
        X[m] = act.length ? hold / Math.max(1, 2 * need[m] * Math.sqrt(A)) : 1;
        const bw = +(base.mat_w?.[m] ?? 1);
        if (bw <= 0) continue;                                             // matériau coupé par l'organisateur : on n'y touche pas
        // le rythme passe avant tout : partie trop rapide → jamais plus de matériaux ; trop lente → jamais moins (sauf gros stocks)
        let f = X[m] < 0.5 ? 1.1 : X[m] > 3 ? 0.9 : 1;
        if (P.Reff > 1.25 && f > 1) f = 1;
        if (P.Reff > 2 && X[m] > 1) f = 0.9;
        if (f !== 1) { const nw = +apClamp(w[m] * f, bw / 3, Math.min(5, bw * 3)).toFixed(2); if (nw !== w[m]) { mm.push(`${({ silex: '🪨', fer: '🔩', poudre: '🧪', cristal: '💎' })[m]} ${f > 1 ? '↑' : '↓'}`); w[m] = nw; } }
      }
      ap.X = Object.fromEntries(Object.entries(X).map(([k, v]) => [k, +v.toFixed(2)]));
      // fréquence globale des matériaux : partie lente → un peu plus, partie rapide → un peu moins
      const xs = AP_MATS.map(m => X[m]), xm = apMedian(xs);
      let me = +g.mat_every, fme = P.Reff > 1.25 ? 1.06 : P.Reff < 0.8 ? (xm > 3 ? 1 : 0.94) : xm < 0.5 ? 0.94 : xm > 3 ? 1.06 : 1;
      const bme = +(base.mat_every || g.mat_every);
      me = Math.round(apClamp(me * fme, Math.max(15, bme * 0.5), bme * 2));
      // or : bourse médiane comparée aux prix
      const purse = apMedian(act.map(p => +(p.inv?.or || 0))), y = act.length ? purse / (1.5 * Pm) : 1;
      let ge = +g.gold_every; const bge = +(base.gold_every || g.gold_every);
      let fg = y < 0.4 ? 0.92 : y > 3 ? 1.08 : 1;
      if (P.Reff > 1.25) fg = Math.max(fg, 1.04);                // trop rapide : l'or se fait un peu plus rare (moins d'achats)
      else if (P.Reff < 0.8 && fg > 1 && y < 6) fg = 1;           // trop lent : on ne rend pas l'or plus rare
      if (bge > 0) ge = Math.round(apClamp(ge * fg, Math.max(40, bge * 0.4), bge * 2.5));
      ap.gold = act.length ? { purse: Math.round(purse), y: +y.toFixed(2) } : null;
      // profondeur : si les joueurs creusent au-dessus de la zone du 💎 et en manquent, on la fait remonter (et redescendre ensuite)
      let sh = +g.mat_shift || 0;
      if (ap.digT != null) {
        if (X.cristal < 0.6 && ap.digT + sh < 0.5) sh = Math.min(0.4, sh + 0.05);
        else if (sh > 0 && (X.cristal > 2.5 || ap.digT + sh > 0.85)) sh = Math.max(0, sh - 0.05);
      }
      sh = +sh.toFixed(2);
      if (JSON.stringify(w) !== JSON.stringify(g.mat_w) || me !== +g.mat_every || ge !== +g.gold_every || sh !== +(+g.mat_shift).toFixed(2)) {
        await sql('update public.game set mat_w = $1, mat_every = $2, gold_every = $3, mat_shift = $4 where id = 1', [JSON.stringify(w), me, ge, sh]);
        if (mm.length) changes.push(`⛏️ matériaux ${mm.join(' ')}`);
        if (me !== +g.mat_every) changes.push(`⛏️ 1 bloc sur ${me} cache un matériau (avant ${g.mat_every})`);
        if (ge !== +g.gold_every) changes.push(`🪙 1 bloc sur ${ge} cache de l’or (avant ${g.gold_every})`);
        if (sh !== +(+g.mat_shift).toFixed(2)) changes.push(sh > +g.mat_shift ? `💎 les matériaux rares remontent (décalage ${Math.round(sh * 100)} %)` : `💎 les matériaux rares redescendent (décalage ${Math.round(sh * 100)} %)`);
        refresh = true;
      }
    }
    // ---------- 3) option : prix de la boutique et recettes de l'atelier ----------
    if (ap.prices) {
      let Pt = apClamp(Math.pow(Q, 0.3) * Math.pow(P.Reff, 0.15), 0.6, 1.8);
      if (P.Reff > 1.25) Pt = Math.max(Pt, 1); else if (P.Reff < 0.8) Pt = Math.min(Pt, 1);     // le rythme d'abord, la richesse ensuite
      if (now - (ap.priceAt || 0) >= AP_PRICE - 5000 && P.conf >= 0.25) {
        ap.priceAt = now;
        const P0 = ap.P || 1, Pn = +(P0 * apClamp(Pt / P0, 0.9, 1.1)).toFixed(3);
        let n = 0;
        for (const [k, bp] of Object.entries(basePrices)) {
          if (!(bp > 0) || AP_LEGEND.includes(k)) continue;              // pas en vente : choix de l'organisateur
          const cur = shop[k] || bp, want = apNice(bp * Pn);
          if (Math.abs(want - cur) / cur < 0.08) continue;                 // petits écarts : on ne bouge pas (pas de prix qui sautillent)
          const nv = Math.max(1, apNice(cur * apClamp(want / cur, 0.88, 1.12)));
          if (nv !== cur) { await sql('insert into public.shop (kind, price) values ($1, $2) on conflict (kind) do update set price = excluded.price', [k, nv]); n++; }
        }
        ap.P = Pn;
        if (n) { changes.push(`🏪 ${n} prix ajusté${n > 1 ? 's' : ''} (×${apDec(Pn)} par rapport au départ)`); refresh = true; }
      }
      let Ct = apClamp(Math.pow(P.Reff, 0.3) * Math.pow(Q, 0.2), 0.7, 1.6);
      if (P.Reff > 1.25) Ct = Math.max(Ct, 1); else if (P.Reff < 0.8) Ct = Math.min(Ct, 1);
      if (now - (ap.recipeAt || 0) >= AP_RECIPE - 5000 && P.conf >= 0.5) {
        ap.recipeAt = now;
        const C0 = ap.C || 1, Cn = +(C0 * apClamp(Ct / C0, 0.9, 1.1)).toFixed(3);
        let n = 0;
        if (Math.abs(Cn - C0) >= 0.03) {
          const cur = Object.fromEntries(recipes.map(r => [r.result, r.ingredients]));
          for (const [k, ing] of Object.entries(ap.base?.recipes || {})) {
            if (!cur[k]) continue;                                          // recette désactivée : on la laisse
            const nr = {}; for (const [i, q] of Object.entries(ing)) nr[i] = Math.max(1, Math.round(q * Cn));
            if (JSON.stringify(Object.entries(nr).sort()) === JSON.stringify(Object.entries(cur[k]).sort())) continue;
            await sql('update public.recipes set ingredients = $2 where result = $1', [k, JSON.stringify(nr)]); n++;
          }
        }
        ap.C = Cn;
        if (n) { changes.push(`🛠️ ${n} recette${n > 1 ? 's' : ''} ${Cn > C0 ? 'un peu plus chère' : 'un peu moins chère'}${n > 1 ? 's' : ''} (×${apDec(Cn)})`); refresh = true; }
      }
    }
    // ---------- historique (pour le tableau de bord) ----------
    const gNow = (await sql('select gold_every, mat_every, mat_shift from public.game where id = 1')).rows[0];
    ap.hist = [...(ap.hist || []), { t: now, R: +P.R.toFixed(3), conf: +P.conf.toFixed(2), A: ap.A, Ch: ap.Ch, P: ap.P ?? 1, C: ap.C ?? 1, Q: ap.Q,
      me: +gNow.mat_every, ge: +gNow.gold_every, sh: +(+gNow.mat_shift).toFixed(2), rate: Math.round(P.rate), need: Math.round(P.need), dig: ap.digT, n: changes.length }].slice(-1500);
    // ---------- journal ----------
    const verdict = P.conf < 0.25 ? 'mesure du rythme en cours' : P.R > 1.25 ? 'trop rapide' : P.R < 0.8 ? 'trop lent' : 'bon rythme';
    const etaTxt = isFinite(P.eta) ? `${apFmt(P.eta)} j` : '∞';
    if (changes.length) apLog(`${verdict} (fin estimée ${etaTxt}, visée ${apFmt(P.daysLeft)} j) → ${changes.join(' · ')}`, 'act');
    else if (ap.steps % 6 === 1) apLog(`${verdict} (fin estimée ${etaTxt}, visée ${apFmt(P.daysLeft)} j) : rien à changer`, 'ok');
    await apSave();
    if (refresh) broadcastAll({ type: 'config', f: 'eco' });
  } catch (e) { noteError('pilote automatique', e.message); }
  finally { apBusy = false; }
}
async function apStart(days, prices) {
  const g = (await sql('select gold_every, mat_every, mat_w, mat_shift from public.game where id = 1')).rows[0];
  const shop = Object.fromEntries((await sql('select kind, price from public.shop')).rows.map(r => [r.kind, +r.price]));
  const recipes = Object.fromEntries((await sql('select result, ingredients from public.recipes')).rows.map(r => [r.result, r.ingredients]));
  const keepBase = ap?.base && ap.on;
  ap = {
    ...(ap || {}), on: true, days, prices: !!prices, start: new Date().toISOString(), end: new Date(Date.now() + days * 864e5).toISOString(),
    base: keepBase ? ap.base : { gold_every: g.gold_every, mat_every: g.mat_every, mat_w: g.mat_w, mat_shift: g.mat_shift, prices: shop, recipes },
    hist: keepBase ? ap.hist : [], A: keepBase ? ap.A : 1, P: keepBase ? ap.P : 1, C: keepBase ? ap.C : 1, last: 0, ecoAt: 0, priceAt: Date.now(), recipeAt: Date.now(),
  };
  apLog(`▶️ Pilote lancé : fin du cube visée dans ${days} jour${days > 1 ? 's' : ''}${prices ? ', prix et atelier compris' : ''}`, 'start');
  await apSave();
  log(`🧭 Pilote automatique lancé (${days} j)`);
  setTimeout(() => apStep(), 1000);
}
async function apStop(restore) {
  if (!ap) await apLoad();
  ap.on = false;
  if (restore && ap.base) {
    const b = ap.base;
    await sql('update public.game set gold_every = $1, mat_every = $2, mat_w = $3, mat_shift = $4 where id = 1', [b.gold_every, b.mat_every, JSON.stringify(b.mat_w), b.mat_shift || 0]);
    if (ap.prices) {
      for (const [k, p] of Object.entries(b.prices || {})) await sql('insert into public.shop (kind, price) values ($1, $2) on conflict (kind) do update set price = excluded.price', [k, p]);
      for (const [k, ing] of Object.entries(b.recipes || {})) await sql('update public.recipes set ingredients = $2 where result = $1', [k, JSON.stringify(ing)]);
    }
    apLog('⏹ Pilote arrêté : or, matériaux' + (ap.prices ? ', prix et recettes' : '') + ' remis comme avant son lancement (les artefacts cachés restent où ils sont)', 'stop');
    broadcastAll({ type: 'config', f: 'eco' });
  } else apLog('⏹ Pilote arrêté : les réglages actuels sont gardés', 'stop');
  delete ap.base;
  await apSave();
  log('🧭 Pilote automatique arrêté');
}
function apPublic(full) {
  const a = ap || {};
  return { on: !!a.on, days: a.days, prices: !!a.prices, start: a.start, end: a.end, waiting: !!a.waiting, steps: a.steps || 0, last: a.last || null,
    A: a.A ?? 1, Ch: a.Ch ?? 1, P: a.P ?? 1, C: a.C ?? 1, Q: a.Q ?? null, X: a.X || null, gold: a.gold || null, digT: a.digT ?? null,
    pace: a.pace || null, log: (a.log || []).slice(0, full ? 80 : 40),
    samples: full ? (a.samples || []) : (a.samples || []).filter((s, k, l) => k % 3 === 0 || k === l.length - 1).slice(-200),
    ...(full ? { hist: a.hist || [], base: a.base ? { prices: a.base.prices, recipes: a.base.recipes, mat_w: a.base.mat_w, gold_every: a.base.gold_every, mat_every: a.base.mat_every } : null } : {}),
    next: a.on && a.last ? a.last + AP_STEP : null };
}
apLoad().then(() => { if (ap?.on) log('🧭 Pilote automatique actif'); });
setInterval(() => { if (ap?.on) apStep(); }, 60e3).unref();

// ---------- 🛟 Copie de secours complète : tout le jeu dans un seul zip, à relancer sur un autre PC ----------
// Le programme + la partie (instantané de la base, restauré tout seul au premier démarrage) + les réglages, clés,
// musique, films, photo et sauvegardes. Le zip est envoyé petit à petit (jamais entièrement en mémoire), sans
// compression (musique, films et sauvegardes sont déjà compressés) : sa taille exacte est connue d'avance.
const EXPORT_FILE = path.join(STATE, 'derniere-copie-complete.json');
const exportTickets = new Map();        // ticket → { opts, exp }
let exporting = false;
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32Fast = typeof zlib.crc32 === 'function' ? (b, c = 0) => zlib.crc32(b, c) : (b, c = 0) => {
  let crc = (c ^ 0xffffffff) >>> 0;
  for (let i = 0; i < b.length; i++) crc = CRC_T[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
function walkFiles(dir, rel, out, skip) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of list) {
    const r = rel ? rel + '/' + d.name : d.name, full = path.join(dir, d.name);
    if (skip && skip(r, d)) continue;
    if (d.isDirectory()) walkFiles(full, r, out, skip);
    else if (d.isFile()) { try { const st = fs.statSync(full); out.push({ name: r, path: full, size: st.size, mtime: st.mtime }); } catch (e) {} }
  }
  return out;
}
const sizeOf = files => files.reduce((a, f) => a + f.size, 0);
// ce qui part dans le zip (sauf l'instantané de la base, fait au moment du téléchargement)
function exportParts() {
  const progSkip = (r, d) => /^(node_modules|donnees|donnees-ancien-.*|sauvegardes|musique|rejeux|bruitages|version-precedente)$/.test(r.split('/')[0])
    || /^(cloudflared(\.exe)?|restaurer.*|verif-server\.mjs|mise-a-jour-en-cours\.json|derniere-copie-complete\.json|le-cube-.*\.zip)$/i.test(r) || r.startsWith('.git/');
  const prog = walkFiles(DIR, '', [], progSkip);
  const names = new Set(prog.map(f => f.name));
  const one = f => { try { const st = fs.statSync(f); return { name: path.basename(f), path: f, size: st.size, mtime: st.mtime }; } catch (e) { return null; } };
  // réglages et clés (rangés à côté du programme, comme sur le PC d'origine)
  const settings = [TOKEN_FILE, ADDRESS_FILE, HISTORY_FILE, VAPID_FILE, PHOTO_FILE, TRMNL_FILE, PEAK_FILE, ALERTS_FILE, PUB_FILE].map(one).filter(f => f && !names.has(f.name));
  return {
    prog: [...prog, ...settings, ...walkFiles(SFX_DIR, 'bruitages', [])],
    music: walkFiles(MUSIC_DIR, 'musique', []),
    films: walkFiles(REPLAY_DIR, 'rejeux', []),
    backups: walkFiles(BACKUPS, 'sauvegardes', []),
  };
}
const GUIDE_FR = (when, opts) => `LE CUBE — COPIE DE SECOURS COMPLÈTE
====================================
Faite le ${when}.

Ce zip contient TOUT ton jeu : le programme, la partie telle qu’elle était à ce moment-là
(fichier restaurer.tar.gz), les comptes, les réglages, les clés des notifications${opts.music ? ', la musique' : ''}${opts.films ? ', les films' : ''}${opts.backups ? ', les sauvegardes' : ''}
et, si tu en avais un, le jeton du tunnel Cloudflare (même adresse Internet qu’avant).

⚠️ Garde ce fichier en lieu sûr et ne le partage avec personne : il contient les mots de passe
   (chiffrés) des joueurs et tes clés secrètes.

RELANCER LE JEU SUR UN AUTRE PC (Windows)
1. Copie ce zip sur le nouveau PC, clic droit › « Extraire tout… ».
   Tu obtiens un dossier LeCube.
2. Dans ce dossier, double-clic sur 1-INSTALLER.bat (il installe Node.js si besoin,
   le tunnel Cloudflare et les composants du jeu).
3. Double-clic sur 2-DEMARRER.bat.
   Au premier démarrage, le jeu voit le fichier restaurer.tar.gz et remet la partie
   exactement comme elle était (message « ✅ Sauvegarde restaurée » dans la fenêtre).
4. Facultatif : 3-DEMARRAGE-AUTO-ACTIVER.bat pour qu’il démarre avec Windows.

Si tu avais une adresse permanente (jeton Cloudflare), les joueurs n’ont rien à changer.
Sinon, la nouvelle adresse est dans ADRESSE-DU-JEU.txt.

Important : n’allume jamais l’ancien et le nouveau PC en même temps avec le même jeton.
`;
function dosTime(d) {
  d = d instanceof Date && !isNaN(d) ? d : new Date();
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dt = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [t & 0xffff, dt & 0xffff];
}
// plan du zip : chaque entrée « stockée » (sans compression), avec ses positions
function zipPlan(entries) {
  let off = 0;
  for (const e of entries) {
    e.nameBuf = Buffer.from(e.name, 'utf8');
    e.offset = off;
    off += 30 + e.nameBuf.length + e.size;
  }
  const cdStart = off;
  let cdSize = 0;
  for (const e of entries) cdSize += 46 + e.nameBuf.length + (e.offset >= 0xffffffff ? 12 : 0);
  const z64 = cdStart >= 0xffffffff || cdStart + cdSize >= 0xffffffff || entries.length >= 0xffff;
  return { cdStart, cdSize, z64, total: cdStart + cdSize + (z64 ? 56 + 20 : 0) + 22 };
}
async function writeOut(res, buf) { if (!res.write(buf)) await new Promise(r => res.once('drain', r)); }
async function crcOfFile(f) {
  let c = 0;
  if (f.buf) return crc32Fast(f.buf, 0);
  for await (const chunk of fs.createReadStream(f.path, { start: 0, end: Math.max(0, f.size - 1), highWaterMark: 1 << 20 })) c = crc32Fast(chunk, c);
  return f.size ? c : 0;
}
async function sendFullExport(res, opts) {
  if (exporting) return send(res, 429, { error: 'Une copie complète est déjà en cours' });
  exporting = true;
  const t0 = performance.now();
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) aborted = true; });
  try {
    const when = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
    const parts = exportParts();
    // instantané de la base, exactement comme une sauvegarde (quelques secondes)
    const dump = Buffer.from(await (await exclusive(() => db.dumpDataDir('gzip'))).arrayBuffer());
    const guide = Buffer.from(GUIDE_FR(when, opts).replace(/\n/g, '\r\n'), 'utf8');
    const files = [
      ...parts.prog,
      { name: 'restaurer.tar.gz', buf: dump, size: dump.length, mtime: new Date() },
      { name: 'RELANCER-SUR-UN-NOUVEAU-PC.txt', buf: guide, size: guide.length, mtime: new Date() },
      ...(opts.music ? parts.music : []), ...(opts.films ? parts.films : []), ...(opts.backups ? parts.backups : []),
    ].map(f => ({ ...f, name: 'LeCube/' + f.name }));
    const plan = zipPlan(files);
    const stamp_ = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 16).replace(/[ :]/g, '-');   // heure de Paris
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': plan.total, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="le-cube-complet-${stamp_}.zip"`, ...SECURITY });
    log(`🛟 Copie complète : ${files.length} fichiers, ${Math.round(plan.total / 1e6)} Mo…`);
    for (const f of files) {
      if (aborted) break;
      f.crc = await crcOfFile(f);
      const [tm, dt] = dosTime(f.mtime);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
      h.writeUInt16LE(tm, 10); h.writeUInt16LE(dt, 12); h.writeUInt32LE(f.crc >>> 0, 14);
      h.writeUInt32LE(f.size, 18); h.writeUInt32LE(f.size, 22); h.writeUInt16LE(f.nameBuf.length, 26); h.writeUInt16LE(0, 28);
      await writeOut(res, h); await writeOut(res, f.nameBuf);
      if (f.buf) await writeOut(res, f.buf);
      else {
        let sent = 0;
        for await (const chunk of fs.createReadStream(f.path, { start: 0, end: Math.max(0, f.size - 1), highWaterMark: 1 << 20 })) {
          if (!f.size || aborted) break;
          const c = chunk.length + sent > f.size ? chunk.subarray(0, f.size - sent) : chunk;
          sent += c.length; await writeOut(res, c);
        }
        if (f.size && sent < f.size) await writeOut(res, Buffer.alloc(f.size - sent));   // fichier raccourci entre-temps (très rare)
      }
      f.time = [tm, dt];
    }
    if (aborted) { log('🛟 Copie complète interrompue (téléchargement arrêté)'); return; }
    // répertoire central
    for (const f of files) {
      const big = f.offset >= 0xffffffff;
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(big ? 45 : 20, 4); c.writeUInt16LE(big ? 45 : 20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(f.time[0], 12); c.writeUInt16LE(f.time[1], 14); c.writeUInt32LE(f.crc >>> 0, 16);
      c.writeUInt32LE(f.size, 20); c.writeUInt32LE(f.size, 24); c.writeUInt16LE(f.nameBuf.length, 28); c.writeUInt16LE(big ? 12 : 0, 30);
      c.writeUInt32LE(0, 34); c.writeUInt32LE(0, 38); c.writeUInt32LE(big ? 0xffffffff : f.offset, 42);
      await writeOut(res, c); await writeOut(res, f.nameBuf);
      if (big) { const x = Buffer.alloc(12); x.writeUInt16LE(1, 0); x.writeUInt16LE(8, 2); x.writeBigUInt64LE(BigInt(f.offset), 4); await writeOut(res, x); }
    }
    const n = files.length, endCd = plan.cdStart + plan.cdSize;
    if (plan.z64) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
      z.writeUInt32LE(0, 16); z.writeUInt32LE(0, 20); z.writeBigUInt64LE(BigInt(n), 24); z.writeBigUInt64LE(BigInt(n), 32);
      z.writeBigUInt64LE(BigInt(plan.cdSize), 40); z.writeBigUInt64LE(BigInt(plan.cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); loc.writeBigUInt64LE(BigInt(endCd), 8); loc.writeUInt32LE(1, 16);
      await writeOut(res, z); await writeOut(res, loc);
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(0, 4); e.writeUInt16LE(0, 6);
    e.writeUInt16LE(Math.min(n, 0xffff), 8); e.writeUInt16LE(Math.min(n, 0xffff), 10);
    e.writeUInt32LE(plan.z64 ? 0xffffffff : plan.cdSize, 12); e.writeUInt32LE(plan.z64 ? 0xffffffff : plan.cdStart, 16); e.writeUInt16LE(0, 20);
    await writeOut(res, e);
    res.end();
    const info = { at: new Date().toISOString(), size: plan.total, files: n, s: Math.round((performance.now() - t0) / 1000), ...opts };
    try { fs.writeFileSync(EXPORT_FILE, JSON.stringify(info)); } catch (e2) {}
    log(`🛟 Copie complète envoyée (${Math.round(plan.total / 1e6)} Mo en ${info.s} s)`);
  } catch (e) {
    noteError('copie complète', e.message); log('⚠️  Copie complète impossible :', e.message);
    if (!res.headersSent) send(res, 500, { error: 'Copie complète impossible : ' + e.message }); else res.destroy();
  } finally { exporting = false; }
}
function exportInfo() {
  const p = exportParts();
  let last = null; try { last = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8')); } catch (e) {}
  const dbGuess = listBackups().slice(-1)[0]?.size || 0;
  return { prog: sizeOf(p.prog) + dbGuess, music: sizeOf(p.music), music_n: p.music.length, films: sizeOf(p.films), films_n: p.films.length,
    backups: sizeOf(p.backups), backups_n: p.backups.length, last, has_token: fs.existsSync(TOKEN_FILE) };
}

// ---------- VPS : petite page d'accueil sur http://adresse-IP (port 80) ----------
// Elle n'affiche que l'adresse sécurisée du jeu : aucune donnée, aucun mot de passe ne passe par là.
function startStatusPage() {
  if (!STATUS_PORT) return;
  const page = () => {
    const link = tunnelMode === 'permanent'
      ? '<p>Le jeu utilise une <b>adresse permanente</b> (celle que tu as choisie dans Cloudflare).</p>'
      : tunnelUrl ? `<p>Adresse du jeu :</p><p><a href="${tunnelUrl}">${tunnelUrl}</a></p><p class="s">Cette adresse change si le serveur redémarre : reviens ici pour la retrouver.</p>`
      : '<p>Le tunnel démarre… recharge cette page dans 30 secondes.</p>';
    return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Le Cube</title><style>body{font-family:system-ui,sans-serif;background:#0d0f14;color:#eef1f8;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:520px;padding:24px;text-align:center}a{color:#ffd34d;font-size:20px;word-break:break-all}.s{opacity:.6;font-size:13px}</style>
<main><h1>🧊 Le Cube</h1><p>Le serveur est en marche.</p>${link}</main></html>`;
  };
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page());
  }).on('error', e => log('Page d’accueil (port ' + STATUS_PORT + ') indisponible :', e.message)).listen(STATUS_PORT);
}

server.listen(PORT, HOST, () => {
  log(`Jeu disponible sur ce PC : http://localhost:${PORT}`);
  if (!HOST) for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) log(`Depuis un appareil de la maison (même Wi-Fi) : http://${a.address}:${PORT}`);
  startTunnel();
  startStatusPage();
  setTimeout(() => gridBuild().catch(e => noteError('cube en mémoire', e.message)), 3000);
  if (!process.env.LECUBE_DATA) console.log('Laisse cette fenêtre ouverte tant que le jeu doit être accessible.\n');
});
process.on('uncaughtException', e => { noteError('serveur', e.stack || e.message); log('⚠️  Erreur inattendue :', e.message); });
process.on('unhandledRejection', e => { noteError('serveur', e?.message || String(e)); });
async function stop() {
  if (stop.done) return; stop.done = true;
  stopping = true;
  log('Arrêt…');
  saveHistory();
  try { await replayFlush(); } catch (e) {}
  try { tunnelProc?.kill(); } catch (e) {}
  try { await exclusive(() => db.close()); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);     // Windows : fermeture de la fenêtre
process.on('SIGBREAK', stop);   // Windows : Ctrl+Pause
