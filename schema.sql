-- =====================================================================
--  LE CUBE — installation / mise à jour Supabase  (version 2)
--  À coller EN ENTIER dans Supabase > SQL Editor > New query, puis "Run".
--  Relançable sans danger : la partie en cours, les comptes et les
--  inventaires sont conservés lors d'une mise à jour.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. JOUEURS ET VALIDATION
--    Le tout premier inscrit devient automatiquement administrateur.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  pseudo     text not null,
  status     text not null default 'pending' check (status in ('pending', 'approved', 'refused')),
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Réglages d'accès (dans la table game) : inscriptions ouvertes, validation automatique,
-- nombre maximum de joueurs validés. Le tout premier inscrit est toujours accepté (admin).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare premier boolean; g record; st text := 'pending'; ps text; n int := 1;
begin
  select not exists (select 1 from public.profiles) into premier;
  if not premier and to_regclass('public.game') is not null then
    select * into g from public.game where id = 1;
    if found then
      if not g.signups_open then raise exception 'Les inscriptions sont fermées pour le moment'; end if;
      if g.auto_approve and (g.max_players = 0 or
         (select count(*) from public.profiles where status = 'approved' and not is_admin) < g.max_players) then
        st := 'approved';
      end if;
    end if;
  end if;
  ps := public._clean_pseudo(coalesce(nullif(trim(new.raw_user_meta_data ->> 'pseudo'), ''), split_part(new.email, '@', 1)));
  if char_length(ps) < 2 then ps := 'Joueur'; end if;
  -- pseudo déjà pris : on ajoute un numéro
  while exists (select 1 from public.profiles where lower(pseudo) = lower(ps)) and n < 999 loop
    n := n + 1; ps := left(public._clean_pseudo(coalesce(nullif(trim(new.raw_user_meta_data ->> 'pseudo'), ''), 'Joueur')), 16) || n;
  end loop;
  insert into public.profiles (id, pseudo, status, is_admin, approved_at)
  values (new.id, ps, case when premier then 'approved' else st end, premier,
          case when premier or st = 'approved' then now() end);
  if to_regclass('public.activity') is not null then
    insert into public.activity (player, kind, detail) values (new.id, 'signup', jsonb_build_object('status', case when premier then 'approved' else st end));
  end if;
  return new;
end $$;

drop trigger if exists le_cube_new_user on auth.users;
create trigger le_cube_new_user after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profil : avatar (emoji) et couleur du pseudo (version 6)
alter table public.profiles add column if not exists avatar text not null default '';
alter table public.profiles add column if not exists color  text not null default '';
-- Pseudo et modération (version 8)
alter table public.profiles add column if not exists approved_at       timestamptz;
alter table public.profiles add column if not exists pseudo_changed_at timestamptz;
alter table public.profiles add column if not exists pseudo_locked     boolean not null default false;
alter table public.profiles add column if not exists is_mod            boolean not null default false;   -- modérateur du salon
alter table public.profiles add column if not exists warnings          int not null default 0;
alter table public.profiles add column if not exists chat_muted_until  timestamptz;                      -- sourdine
alter table public.profiles add column if not exists chat_banned       boolean not null default false;   -- interdit de salon
alter table public.profiles add column if not exists shadow            boolean not null default false;   -- sourdine fantôme
alter table public.profiles add column if not exists banned_until      timestamptz;                      -- exclu du jeu ('infinity' = définitif)
alter table public.profiles add column if not exists ban_reason        text not null default '';

-- Validé, et pas exclu du jeu
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'approved'
                 and (banned_until is null or banned_until <= now() or is_admin));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'approved' and is_admin);
$$;

-- Organisateur ou modérateur du salon
create or replace function public._can_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'approved' and (is_admin or is_mod)
                 and (banned_until is null or banned_until <= now() or is_admin));
$$;

-- Pseudo nettoyé : sans caractères invisibles ni espaces en trop, 20 caractères au plus
create or replace function public._clean_pseudo(p text) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[\x00-\x1F\x7F\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]', '', 'g'), '\s+', ' ', 'g')), 20);
$$;


-- ---------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------
create table if not exists public.game (
  id          int primary key default 1 check (id = 1),
  size        int not null default 128,
  started_at  timestamptz not null default now(),
  revealed_at timestamptz
);
-- Règles réglables par l'admin (ajoutées en version 2)
alter table public.game add column if not exists max_hp     int not null default 10;   -- clics pour casser un bloc
alter table public.game add column if not exists gold_every int not null default 200;  -- 1 bloc sur X contient de l'or (0 = jamais)
alter table public.game add column if not exists mat_every  int not null default 60;   -- 1 bloc sur X contient un matériau (0 = jamais)
alter table public.game add column if not exists seed       int not null default floor(random() * 2000000000)::int;
alter table public.game add column if not exists destroyed  bigint not null default 0;  -- blocs détruits (tenu à jour)
-- Effets en cours pour tout le monde (version 4)
alter table public.game add column if not exists rally_until timestamptz;   -- 📯 Cor de ralliement
alter table public.game add column if not exists eye_until   timestamptz;   -- 👁️ Œil du Cube
alter table public.game add column if not exists arts_v4     boolean not null default false;
-- Accès au serveur (version 5)
alter table public.game add column if not exists signups_open boolean not null default true;   -- inscriptions ouvertes
alter table public.game add column if not exists auto_approve boolean not null default false;  -- validation automatique
alter table public.game add column if not exists max_players  int not null default 0;          -- joueurs validés max (organisateur non compris, 0 = illimité)
alter table public.game add column if not exists max_online   int not null default 0;          -- connectés en même temps max (serveur maison, 0 = illimité)
-- Semaine, événements, coffres, annonce (version 6)
alter table public.game add column if not exists week_start   timestamptz;                      -- lundi 0 h (heure de Paris) de la semaine en cours
alter table public.game add column if not exists week_base    bigint not null default 0;        -- blocs détruits au début de la semaine
alter table public.game add column if not exists week_goal    int not null default 0;           -- objectif commun (0 = automatique)
alter table public.game add column if not exists week_reward  int not null default 30;          -- 🪙 pour chaque participant
alter table public.game add column if not exists week_done    boolean not null default false;
alter table public.game add column if not exists last_winner  text;
alter table public.game add column if not exists last_winner_blocks bigint;
alter table public.game add column if not exists events_on    boolean not null default true;    -- heures dorées automatiques
alter table public.game add column if not exists event_kind   text;                             -- événement lancé à la main
alter table public.game add column if not exists event_until  timestamptz;
alter table public.game add column if not exists announce     text not null default '';         -- annonce épinglée
alter table public.game add column if not exists announce_at  timestamptz;
alter table public.game add column if not exists chests_v6    boolean not null default false;

create table if not exists public.treasure (
  id         int primary key default 1 check (id = 1),
  kind       text not null default 'noeud',
  message    text not null default '',
  image      text not null default '',
  updated_at timestamptz not null default now()
);

-- Lot du trésor (version 7) : artefacts choisis par l'organisateur, gagnés à la fin du cube,
-- livrés dans le sac du gagnant au début du cube suivant
alter table public.treasure add column if not exists prize         jsonb not null default '{}'::jsonb;  -- {"megabombe": 2, "or": 100, ...}
alter table public.treasure add column if not exists prize_rule    text not null default 'last';         -- last = dernier bloc, top = meilleur casseur
alter table public.treasure add column if not exists prize_visible boolean not null default true;        -- les joueurs voient le lot à l'avance
alter table public.treasure add column if not exists winner        uuid;
alter table public.treasure add column if not exists winner_pseudo text;
alter table public.treasure add column if not exists won_prize     jsonb;                                -- lot figé au moment de la victoire
alter table public.treasure add column if not exists prize_given   boolean not null default false;
alter table public.game add column if not exists prize_note    text not null default '';                 -- « X a reçu le lot » (affiché une fois)
alter table public.game add column if not exists prize_note_at timestamptz;
-- Récompenses du classement (version 10) : les 2 meilleurs casseurs, en dehors du gagnant du lot
alter table public.treasure add column if not exists prize_podium jsonb not null default '[{}, {}]'::jsonb;  -- [lot du 1er, lot du 2e]
alter table public.treasure add column if not exists won_podium   jsonb;                                    -- [{id, pseudo, rank, prize}] figé à la fin
alter table public.game add column if not exists podium_note jsonb not null default '[]'::jsonb;              -- « X a reçu sa récompense » (affiché une fois)
-- Version 8 : pièges, événements composés, pseudo, modération du salon
alter table public.game add column if not exists arts_v8        boolean not null default false;
alter table public.game add column if not exists traps_on       boolean not null default true;   -- pièges cachés dans le cube
alter table public.game add column if not exists event_id       int;                              -- événement lancé à la main
alter table public.game add column if not exists pseudo_days    int not null default 7;           -- délai entre deux changements de pseudo
alter table public.game add column if not exists chat_locked    boolean not null default false;   -- salon verrouillé
alter table public.game add column if not exists chat_slow      int not null default 0;           -- mode lent : secondes entre deux messages
alter table public.game add column if not exists chat_links     boolean not null default true;    -- liens autorisés
alter table public.game add column if not exists chat_newbie_min int not null default 0;          -- minutes d'attente avant de pouvoir écrire
alter table public.game add column if not exists bot_on         boolean not null default true;    -- 🤖 bot de modération
alter table public.game add column if not exists bot_words      text not null default '';         -- mots interdits ajoutés par l'organisateur
alter table public.game add column if not exists bot_allow      text not null default '';         -- mots de la liste par défaut à autoriser
alter table public.game add column if not exists esc_mute1      int not null default 3;           -- avertissements → sourdine courte
alter table public.game add column if not exists esc_mute1_min  int not null default 15;
alter table public.game add column if not exists esc_mute2      int not null default 5;           -- avertissements → sourdine longue
alter table public.game add column if not exists esc_mute2_min  int not null default 1440;
alter table public.game add column if not exists esc_ban        int not null default 8;           -- avertissements → interdit de salon (0 = jamais)

-- Événements composés par l'organisateur (version 8)
create table if not exists public.events (
  id       serial primary key,
  name     text not null,
  icon     text not null default '🌟',
  message  text not null default '',
  mult     jsonb not null default '{}'::jsonb,       -- {"or": 2, "mat": 2, "force": 2, "art": 3, "coffre": 2}
  minutes  int not null default 60,
  sched    text not null default 'none',             -- none | once | daily | weekly
  at       timestamptz,                              -- once : début
  dow      int,                                      -- weekly : 1 = lundi … 7 = dimanche
  hh       int, mi int,                              -- daily / weekly : heure de Paris
  enabled  boolean not null default true,
  builtin  text
);
alter table public.events enable row level security;
insert into public.events (name, icon, message, mult, minutes, sched, dow, hh, mi, builtin)
  select * from (values
    ('Heure dorée', '🌟', '', '{"or": 2}'::jsonb, 60, 'weekly', 6, 20, 0, 'or'),
    ('Heure des artisans', '🛠️', '', '{"mat": 2}'::jsonb, 60, 'weekly', 3, 18, 0, 'mat')) v
  where not exists (select 1 from public.events);

-- Blocs détruits par couche (tenu à jour) : sert à l'Écorce du Monde et à la répartition automatique
create table if not exists public.layer_done (d int primary key, n bigint not null default 0);
alter table public.layer_done enable row level security;
alter table public.game add column if not exists layers_v8 boolean not null default false;
-- Version 9 : couches entièrement arrachées (toute coordonnée moins profonde est détruite, sans ligne dans blocks),
-- quantité de chaque matériau (×0 à ×5) réglable par l'organisateur, recettes activables
alter table public.game add column if not exists peeled int not null default 0;
alter table public.game add column if not exists mat_w jsonb not null default '{"silex": 1, "fer": 1, "poudre": 1, "cristal": 1}'::jsonb;

-- Historique des pseudos, journal de modération, signalements
create table if not exists public.pseudo_history (
  id bigserial primary key, player uuid references public.profiles(id) on delete cascade,
  old text, new text, at timestamptz not null default now(), by_admin boolean not null default false);
create table if not exists public.mod_log (
  id bigserial primary key, at timestamptz not null default now(),
  moderator uuid references public.profiles(id) on delete set null,     -- null = 🤖 bot
  target uuid references public.profiles(id) on delete cascade,
  action text not null, reason text not null default '', detail jsonb not null default '{}'::jsonb);
create table if not exists public.reports (
  id bigserial primary key, at timestamptz not null default now(),
  reporter uuid references public.profiles(id) on delete cascade,
  target uuid references public.profiles(id) on delete cascade,
  message_id bigint, body text not null default '', reason text not null default '',
  status text not null default 'open');
alter table public.pseudo_history enable row level security;
alter table public.mod_log enable row level security;
alter table public.reports enable row level security;
create index if not exists mod_log_target on public.mod_log (target, id);
create index if not exists reports_status on public.reports (status, id);

-- Seuls les blocs abîmés ou détruits sont stockés (absent = intact)
create table if not exists public.blocks (
  i  int primary key,
  hp smallint not null
);

-- Positions secrètes des artefacts (identiques pour tout le monde)
create table if not exists public.artifacts (
  i        int primary key,
  kind     text not null,
  found_by uuid references public.profiles(id) on delete set null,
  found_at timestamptz
);

-- Inventaire : artefacts, matériaux et pièces d'or ('or')
create table if not exists public.inventory (
  player uuid not null references public.profiles(id) on delete cascade,
  kind   text not null,
  qty    int  not null default 0,
  primary key (player, kind)
);

create table if not exists public.stats (
  player          uuid primary key references public.profiles(id) on delete cascade,
  hits            bigint not null default 0,
  blocks          bigint not null default 0,
  artifacts_found int not null default 0,
  artifacts_used  int not null default 0,
  best_break_ms   int,
  best_cps        int not null default 0,
  deepest         int not null default 0,
  last_seen       timestamptz
);
alter table public.stats add column if not exists gold_found      int not null default 0;
alter table public.stats add column if not exists materials_found int not null default 0;
alter table public.stats add column if not exists crafted         int not null default 0;
alter table public.stats add column if not exists trades          int not null default 0;
alter table public.stats add column if not exists missions_done   int not null default 0;
alter table public.stats add column if not exists peels           int not null default 0;  -- 🧅 Écorces arrachées
alter table public.stats add column if not exists magnet_until    timestamptz;              -- 🧲 Aimant actif jusqu'à
alter table public.stats add column if not exists week_blocks     bigint not null default 0; -- blocs cassés cette semaine
alter table public.stats add column if not exists trophies        int not null default 0;    -- semaines gagnées
alter table public.stats add column if not exists chests          int not null default 0;    -- coffres ouverts
alter table public.stats add column if not exists best_combo      int not null default 0;    -- plus long combo
-- Effets personnels en cours, tenus par le serveur (version 8)
alter table public.stats add column if not exists hammer_until    timestamptz;               -- 🔨 Marteau d'or
alter table public.stats add column if not exists tornado_until   timestamptz;               -- 🌪️ Tornade
alter table public.stats add column if not exists clover_until    timestamptz;               -- 🍀 Trèfle
alter table public.stats add column if not exists web_until       timestamptz;               -- 🕸️ piège : Toile
alter table public.stats add column if not exists numb_until      timestamptz;               -- 🐌 piège : Engourdissement
alter table public.stats add column if not exists fog_until       timestamptz;               -- 🌫️ piège : Brouillard
alter table public.stats add column if not exists traps           int not null default 0;    -- pièges déclenchés
-- Anti-triche : réserve de coups (20 par seconde au plus, 40 d'avance), combo mesuré par le serveur
alter table public.stats add column if not exists hit_tokens      real;
alter table public.stats add column if not exists hit_at          timestamptz;
alter table public.stats add column if not exists combo_srv       int not null default 0;
alter table public.stats add column if not exists rejected        bigint not null default 0; -- coups refusés (trop rapides)
alter table public.stats add column if not exists seen_at         timestamptz;               -- dernière présence (jeu ouvert)

-- Boutique : prix en pièces d'or (0 = pas en vente)
create table if not exists public.shop (
  kind  text primary key,
  price int not null default 0
);
insert into public.shop (kind, price) values
  ('radar', 15), ('marteau', 20), ('foreuse', 25), ('bombe', 30), ('megabombe', 200),
  ('sonde', 10), ('scie', 25), ('aimant', 30), ('seisme', 35), ('cor', 40),
  ('ecorce', 0), ('oeil', 0),                  -- les deux légendaires ne se vendent jamais
  -- version 8 : classiques, puissants, très puissants
  ('dynamite', 35), ('trefle', 30), ('sablier', 25), ('fontaine', 40),
  ('vrille', 60), ('grappe', 75), ('givre', 70),
  ('chaine', 150), ('tornade', 180), ('pilier', 220)
on conflict (kind) do nothing;

-- Recettes de l'atelier
create table if not exists public.recipes (
  result      text primary key,
  ingredients jsonb not null
);
alter table public.recipes add column if not exists enabled boolean not null default true;   -- fabricable ou non (version 9)
insert into public.recipes (result, ingredients) values
  ('radar',     '{"silex": 4, "fer": 1}'),
  ('marteau',   '{"fer": 4, "or": 3}'),
  ('bombe',     '{"poudre": 3, "fer": 2}'),
  ('foreuse',   '{"cristal": 2, "fer": 3}'),
  ('megabombe', '{"bombe": 3, "cristal": 3}'),
  ('scie',      '{"fer": 3, "silex": 2}'),
  ('seisme',    '{"poudre": 3, "cristal": 1}'),
  ('aimant',    '{"fer": 4, "cristal": 1}'),
  ('cor',       '{"or": 2, "cristal": 2, "fer": 2}'),
  ('sonde',     '{"silex": 3, "fer": 1}'),
  ('ecorce',    '{"megabombe": 2, "cristal": 10, "or": 100}'),
  ('oeil',      '{"radar": 3, "cristal": 5, "or": 50}'),
  ('dynamite',  '{"poudre": 4, "silex": 2}'),
  ('trefle',    '{"silex": 4, "fer": 1, "cristal": 1}'),
  ('sablier',   '{"silex": 3, "cristal": 2}'),
  ('fontaine',  '{"or": 15, "fer": 2}'),
  ('vrille',    '{"foreuse": 1, "fer": 4, "cristal": 1}'),
  ('grappe',    '{"bombe": 2, "poudre": 3}'),
  ('givre',     '{"cristal": 3, "poudre": 1}'),
  ('chaine',    '{"cristal": 4, "poudre": 4, "fer": 4}'),
  ('tornade',   '{"marteau": 2, "cristal": 4}'),
  ('pilier',    '{"vrille": 2, "cristal": 5}')
on conflict (result) do nothing;

-- Marché entre joueurs : l'objet proposé est mis de côté jusqu'à la vente
create table if not exists public.market (
  id         bigserial primary key,
  seller     uuid not null references public.profiles(id) on delete cascade,
  give_kind  text not null,
  give_qty   int  not null check (give_qty > 0),
  want_kind  text not null,
  want_qty   int  not null check (want_qty > 0),
  created_at timestamptz not null default now()
);

-- Missions personnelles (3 par joueur)
create table if not exists public.missions (
  player     uuid not null references public.profiles(id) on delete cascade,
  slot       int  not null check (slot between 1 and 3),
  typ        text not null,             -- creuser | utiliser | livrer | trouver
  item       text,
  param      int  not null default 0,   -- creuser : couche minimale (0 = surface)
  target     int  not null,
  progress   int  not null default 0,
  reward     int  not null,
  created_at timestamptz not null default now(),
  primary key (player, slot)
);

-- Coffres dorés visibles dans le cube (version 6)
create table if not exists public.chests (
  i         int primary key,
  opened_by uuid references public.profiles(id) on delete set null,
  opened_at timestamptz
);
-- Journal d'activité (les 3 000 dernières lignes)
create table if not exists public.activity (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  player uuid references public.profiles(id) on delete set null,
  kind   text not null,
  detail jsonb not null default '{}'::jsonb
);
alter table public.chests add column if not exists trap boolean not null default false;   -- 🎭 faux coffre (piège)
alter table public.chests   enable row level security;
alter table public.activity enable row level security;

-- Aucun accès direct aux tables : tout passe par les fonctions ci-dessous.
alter table public.profiles  enable row level security;
alter table public.game      enable row level security;
alter table public.treasure  enable row level security;
alter table public.blocks    enable row level security;
alter table public.artifacts enable row level security;
alter table public.inventory enable row level security;
alter table public.stats     enable row level security;
alter table public.shop      enable row level security;
alter table public.recipes   enable row level security;
alter table public.market    enable row level security;
alter table public.missions  enable row level security;

-- Salon de discussion (les 5 000 derniers messages au maximum, environ 1 Mo)
create table if not exists public.chat (
  id         bigserial primary key,
  player     uuid references public.profiles(id) on delete set null,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
alter table public.chat enable row level security;
alter table public.chat add column if not exists hidden  boolean not null default false;  -- masqué par le 🤖 bot (visible seulement en modération)
alter table public.chat add column if not exists shadow  boolean not null default false;  -- sourdine fantôme : visible par l'auteur et les modérateurs
alter table public.chat add column if not exists flagged text;
alter table public.chat add column if not exists reply_to bigint;                         -- ↩️ réponse à un message (version 10.5)                             -- raison du masquage
create index if not exists chat_player on public.chat (player, id);
create index if not exists artifacts_open on public.artifacts (kind) where found_by is null;

insert into public.game (id) values (1) on conflict (id) do nothing;
insert into public.treasure (id) values (1) on conflict (id) do nothing;
-- (le compteur de blocs détruits est recalculé tout à la fin de ce fichier)


-- ---------------------------------------------------------------------
-- 3. OUTILS INTERNES
-- ---------------------------------------------------------------------
-- Anciennes versions dont le format change
drop function if exists public._destroy(int, uuid);
drop function if exists public.get_leaderboard();
drop function if exists public._loot(int);
drop function if exists public._reward(int, uuid);
drop function if exists public._destroy(int, uuid);

-- Listes des objets du jeu
create or replace function public._arts() returns text[] language sql immutable as $$
  select array['bombe', 'foreuse', 'marteau', 'radar', 'megabombe', 'scie', 'seisme', 'aimant', 'cor', 'sonde', 'ecorce', 'oeil',
               'dynamite', 'trefle', 'sablier', 'fontaine', 'vrille', 'grappe', 'givre', 'chaine', 'tornade', 'pilier'];
$$;
-- artefacts « classiques » (coffres, missions, bonus du 🍀 Trèfle)
create or replace function public._classics() returns text[] language sql immutable as $$
  select array['bombe', 'foreuse', 'marteau', 'radar', 'scie', 'sonde', 'aimant', 'dynamite', 'trefle', 'sablier', 'fontaine', 'seisme', 'cor'];
$$;
-- pièges cachés (le 🎭 faux coffre, lui, est un coffre)
create or replace function public._traps() returns text[] language sql immutable as $$
  select array['toile', 'lenteur', 'brouillard', 'macon', 'durci', 'pickpocket'];
$$;
create or replace function public._is_trap(k text) returns boolean language sql immutable as $$ select k = any(public._traps()); $$;

create or replace function public._check_kind(k text) returns void
language plpgsql immutable as $$
begin
  if k is null or not (k = any(public._arts())) then
    raise exception 'Type d''artefact inconnu';
  end if;
end $$;

create or replace function public._check_item(k text) returns void
language plpgsql immutable as $$
begin
  if k is null or not (k = any(public._arts() || array['or', 'silex', 'fer', 'poudre', 'cristal'])) then
    raise exception 'Objet inconnu';
  end if;
end $$;

-- Artefacts légendaires : jamais en vente contre de l'or
create or replace function public._legendary(k text) returns boolean
language sql immutable as $$ select k in ('ecorce', 'oeil'); $$;

-- Couche d'un bloc : 0 = surface
create or replace function public._depth(idx int, s int) returns int
language sql immutable as $$
  select least(idx % s, s - 1 - idx % s, (idx / s) % s, s - 1 - (idx / s) % s, idx / (s*s), s - 1 - idx / (s*s));
$$;

-- Compte des blocs détruits par couche : + (sign = 1) ou - (sign = -1) pour une liste de blocs
create or replace function public._layer_add(cells int[], sign int default 1) returns void
language plpgsql security definer set search_path = public as $$
declare s int;
begin
  if coalesce(array_length(cells, 1), 0) = 0 then return; end if;
  select size into s from public.game where id = 1;
  insert into public.layer_done as ld (d, n)
  select public._depth(x, s), count(*) * sign from unnest(cells) x group by 1
  on conflict (d) do update set n = greatest(ld.n + excluded.n, 0);
end $$;

create or replace function public._is_core(idx int, s int) returns boolean
language sql immutable as $$
  with b as (
    select case when s % 2 = 0 then s/2 - 1 else (s-1)/2 - 1 end as lo,
           case when s % 2 = 0 then s/2     else (s-1)/2 + 1 end as hi
  )
  select (idx % s) between b.lo and b.hi
     and ((idx / s) % s) between b.lo and b.hi
     and (idx / (s*s)) between b.lo and b.hi
  from b;
$$;

create or replace function public.core_done() returns boolean
language sql stable security definer set search_path = public as $$
  with g as (
    select size as s,
           case when size % 2 = 0 then size/2 - 1 else (size-1)/2 - 1 end as lo,
           case when size % 2 = 0 then size/2     else (size-1)/2 + 1 end as hi
    from public.game where id = 1
  ), cells as (
    select x + y*g.s + z*g.s*g.s as i
    from g, generate_series(g.lo, g.hi) as x, generate_series(g.lo, g.hi) as y, generate_series(g.lo, g.hi) as z
  )
  select not exists (
    select 1 from cells left join public.blocks b on b.i = cells.i where coalesce(b.hp, 1) > 0
  );
$$;

-- Nombre de blocs du cœur (2×2×2 si la taille est paire, 3×3×3 sinon)
create or replace function public._core_count(s int) returns int
language sql immutable as $$ select case when s % 2 = 0 then 8 else 27 end; $$;

-- Le cœur est scellé tant qu'il reste des blocs ailleurs dans le cube
create or replace function public._sealed() returns boolean
language sql stable security definer set search_path = public as $$
  select destroyed < size::bigint * size * size - public._core_count(size) from public.game where id = 1;
$$;

-- Fin de partie : absolument tous les blocs sont détruits
create or replace function public.all_done() returns boolean
language sql stable security definer set search_path = public as $$
  select destroyed >= size::bigint * size * size from public.game where id = 1;
$$;

-- Valeur indicative d'un objet en pièces d'or (missions)
create or replace function public._value(k text) returns int
language sql stable security definer set search_path = public as $$
  select case k when 'silex' then 1 when 'fer' then 2 when 'poudre' then 3 when 'cristal' then 5 when 'or' then 1
         else coalesce((select nullif(price, 0) from public.shop where kind = k), 20) end;
$$;

create or replace function public._add(p_uid uuid, p_kind text, p_qty int) returns void
language sql security definer set search_path = public as $$
  insert into public.inventory as inv (player, kind, qty) values (p_uid, p_kind, greatest(p_qty, 0))
  on conflict (player, kind) do update set qty = greatest(inv.qty + p_qty, 0);
$$;

create or replace function public._take(p_uid uuid, p_kind text, p_qty int) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.inventory set qty = qty - p_qty where player = p_uid and kind = p_kind and qty >= p_qty;
  if not found then raise exception 'Pas assez de « % »', p_kind; end if;
end $$;

create or replace function public._stats(uid uuid, h int, b int, af int, au int, bms int, cps int, deep int)
returns void language sql security definer set search_path = public as $$
  insert into public.stats as st (player, hits, blocks, week_blocks, artifacts_found, artifacts_used, best_break_ms, best_cps, deepest, last_seen)
  values (uid, h, b, b, af, au, bms, coalesce(cps, 0), coalesce(deep, 0), now())
  on conflict (player) do update set
    hits            = st.hits + excluded.hits,
    blocks          = st.blocks + excluded.blocks,
    week_blocks     = st.week_blocks + excluded.blocks,
    artifacts_found = st.artifacts_found + excluded.artifacts_found,
    artifacts_used  = st.artifacts_used + excluded.artifacts_used,
    best_break_ms   = least(st.best_break_ms, excluded.best_break_ms),
    best_cps        = greatest(st.best_cps, excluded.best_cps),
    deepest         = greatest(st.deepest, excluded.deepest),
    last_seen       = now();
$$;

create or replace function public._bump(p_uid uuid, p_gold int, p_mats int, p_craft int, p_trades int, p_missions int)
returns void language sql security definer set search_path = public as $$
  insert into public.stats as st (player, gold_found, materials_found, crafted, trades, missions_done, last_seen)
  values (p_uid, p_gold, p_mats, p_craft, p_trades, p_missions, now())
  on conflict (player) do update set
    gold_found      = st.gold_found + excluded.gold_found,
    materials_found = st.materials_found + excluded.materials_found,
    crafted         = st.crafted + excluded.crafted,
    trades          = st.trades + excluded.trades,
    missions_done   = st.missions_done + excluded.missions_done,
    last_seen       = now();
$$;

-- Journal d'activité
create or replace function public._log(p_player uuid, p_kind text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  insert into public.activity (player, kind, detail) values (p_player, p_kind, coalesce(p_detail, '{}'::jsonb)) returning id into nid;
  if nid % 200 = 0 then delete from public.activity where id < nid - 3000; end if;
end $$;

-- Événements en cours (version 8) : ceux lancés à la main + ceux programmés (heure de Paris).
-- Chaque événement a des multiplicateurs : or, mat (matériaux), force (coups), art (artefacts bonus), coffre.
create or replace function public._events_now() returns table (id int, name text, icon text, message text, mult jsonb, left_s float8)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare g record; e record; t timestamp := now() at time zone 'Europe/Paris'; st timestamp; w int;
begin
  select events_on, event_id, event_until into g from public.game where public.game.id = 1;
  for e in select * from public.events loop
    st := null;
    if g.event_id = e.id and g.event_until > now() then
      id := e.id; name := e.name; icon := e.icon; message := e.message; mult := e.mult;
      left_s := extract(epoch from g.event_until - now()); return next; continue;
    end if;
    if not coalesce(g.events_on, true) or not e.enabled then continue; end if;
    if e.sched = 'once' and e.at is not null then st := e.at at time zone 'Europe/Paris';
    elsif e.sched = 'daily' then
      st := date_trunc('day', t) + make_interval(hours => coalesce(e.hh, 0), mins => coalesce(e.mi, 0));
      if st > t then st := st - interval '1 day'; end if;
    elsif e.sched = 'weekly' then
      st := date_trunc('week', t) + make_interval(days => coalesce(e.dow, 1) - 1, hours => coalesce(e.hh, 0), mins => coalesce(e.mi, 0));
      if st > t then st := st - interval '7 days'; end if;
    elsif e.sched = 'random' then
      -- ⏰ chaque jour à une heure tirée au hasard entre hh et hh_to (la même pour tout le monde, secrète jusqu'au début)
      w := greatest(0, (greatest(coalesce(e.hh_to, 22), coalesce(e.hh, 10) + 1) - coalesce(e.hh, 10)) * 60 - e.minutes);
      st := date_trunc('day', t) + make_interval(hours => coalesce(e.hh, 10),
              mins => abs(hashint4(to_char(t, 'YYYYMMDD')::int # (e.id * 7919))) % (w + 1));
    end if;
    if st is not null and st <= t and t < st + make_interval(mins => e.minutes) then
      id := e.id; name := e.name; icon := e.icon; message := e.message; mult := e.mult;
      left_s := extract(epoch from st + make_interval(mins => e.minutes) - t); return next;
    end if;
  end loop;
end $$;
-- Multiplicateurs combinés (le plus fort de chaque sorte)
create or replace function public._ev() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'or',     coalesce(max(least(greatest((e.mult->>'or')::numeric, 1), 5)), 1),
    'mat',    coalesce(max(least(greatest((e.mult->>'mat')::numeric, 1), 5)), 1),
    'force',  coalesce(max(least(greatest((e.mult->>'force')::numeric, 1), 3)), 1),
    'art',    coalesce(max(least(greatest((e.mult->>'art')::numeric, 1), 5)), 1),
    'coffre', coalesce(max(least(greatest((e.mult->>'coffre')::numeric, 1), 5)), 1))
  from public._events_now() e;
$$;
-- (ancienne version, gardée pour compatibilité) : 'or', 'mat' ou null
create or replace function public._event() returns text
language sql stable security definer set search_path = public as $$
  select case when (public._ev()->>'or')::numeric > 1 then 'or' when (public._ev()->>'mat')::numeric > 1 then 'mat' end;
$$;
-- Ce que voient les joueurs : null ou { kind, name, icon, message, mult, left, list: [...] }
create or replace function public._event_info() returns json
language sql stable security definer set search_path = public as $$
  select case when count(*) = 0 then null else json_build_object(
    'kind', 'custom', 'name', string_agg(e.name, ' + ' order by e.id), 'icon', (array_agg(e.icon order by e.id))[1],
    'message', string_agg(nullif(e.message, ''), ' · ' order by e.id), 'mult', public._ev(),
    'left', round(min(e.left_s)), 'ids', json_agg(e.id order by e.id)) end
  from public._events_now() e;
$$;

-- Coffre doré : s'il y en a un sur ce bloc, l'ouvre et donne son contenu.
-- Renvoie 'or:25', 'cristal:3', 'art:bombe', 'piege' (🎭 faux coffre : l'appelant déclenche le piège) ou null.
-- cm = multiplicateur des coffres (événement)
drop function if exists public._chest_open(int, uuid);
create or replace function public._chest_open(idx int, uid uuid, cm int default 1) returns text
language plpgsql security definer set search_path = public as $$
declare sd int; h1 float8; h2 float8; arts text[] := public._classics();
  mats text[] := array['silex', 'fer', 'poudre', 'cristal']; r text; q int; tr boolean;
begin
  update public.chests set opened_by = uid, opened_at = now() where i = idx and opened_by is null returning trap into tr;
  if not found then return null; end if;
  if tr then perform public._log(uid, 'chest', jsonb_build_object('got', 'piege')); return 'piege'; end if;
  cm := greatest(1, least(coalesce(cm, 1), 5));
  select ((seed::bigint * 7 + 424243) % 2147483647)::int into sd from public.game where id = 1;
  h1 := (hashint4(idx # sd)::bigint + 2147483648) / 4294967296.0;
  h2 := (hashint4(idx # (sd # 977))::bigint + 2147483648) / 4294967296.0;
  if h1 < 0.5 then q := (15 + floor(h2 * 26)::int) * cm; perform public._add(uid, 'or', q); perform public._bump(uid, q, 0, 0, 0, 0); r := 'or:' || q;
  elsif h1 < 0.85 then r := mats[1 + floor(h2 * 4)::int]; perform public._add(uid, r, 3 * cm); perform public._bump(uid, 0, 3 * cm, 0, 0, 0); r := r || ':' || (3 * cm);
  else r := arts[1 + floor(h2 * array_length(arts, 1))::int]; perform public._add(uid, r, cm); r := 'art:' || r || case when cm > 1 then ':' || cm else '' end;
  end if;
  update public.stats set chests = chests + 1 where player = uid;
  if not found then insert into public.stats (player, chests) values (uid, 1); end if;
  perform public._log(uid, 'chest', jsonb_build_object('got', r));
  return r;
end $$;

-- Coffres cachés au hasard dans les blocs intacts (environ 1 bloc sur 4 000, au moins 3)
create or replace function public._chests_regen(s int) returns void
language sql security definer set search_path = public as $$
  insert into public.chests (i)
  select c.cell from (select floor(random() * (s::bigint * s * s))::int as cell
                      from generate_series(1, greatest(3, (s::bigint * s * s / 4000)::int))) c
  where not exists (select 1 from public.blocks b where b.i = c.cell and b.hp = 0)
    and not public._is_core(c.cell, s)
  on conflict (i) do nothing;
$$;

-- Piège déclenché par un joueur (en cassant le bloc à la main). Renvoie ce qui s'est passé :
-- { k, sec, grow: [[bloc, pv], …], gold } — toujours +5 🪙 de dédommagement.
create or replace function public._trap(uid uuid, k text, idx int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; s int; cx int; cy int; cz int; n int; grow jsonb := '[]'::jsonb; q int := 0; sec int := 0; sealed boolean;
begin
  select * into g from public.game where id = 1;
  s := g.size; cx := idx % s; cy := (idx / s) % s; cz := idx / (s*s);
  insert into public.stats (player) values (uid) on conflict (player) do nothing;
  if k = 'toile' then
    sec := 15; update public.stats set web_until = now() + interval '15 seconds' where player = uid;
  elsif k = 'lenteur' then
    sec := 45; update public.stats set numb_until = now() + interval '45 seconds' where player = uid;
  elsif k = 'brouillard' then
    sec := 30; update public.stats set fog_until = now() + interval '30 seconds' where player = uid;
  elsif k = 'macon' then
    -- 🧱 reconstruit 20 à 40 blocs déjà cassés tout près (jamais quand il ne reste que le cœur)
    sealed := public._sealed();
    if g.revealed_at is null and sealed then
      n := 20 + floor(random() * 21)::int;
      with c as (
        select (cx + ox) + (cy + oy)*s + (cz + oz)*s*s as i
        from generate_series(-4, 4) ox, generate_series(-4, 4) oy, generate_series(-4, 4) oz
        where ox*ox + oy*oy + oz*oz <= 16
          and cx + ox between 0 and s - 1 and cy + oy between 0 and s - 1 and cz + oz between 0 and s - 1
      ), pick as (
        select b.i from public.blocks b join c on c.i = b.i
        where b.hp = 0 and not public._is_core(b.i, s) and public._depth(b.i, s) >= g.peeled order by random() limit n
      ), del as (delete from public.blocks b using pick where b.i = pick.i returning b.i)
      select coalesce(jsonb_agg(jsonb_build_array(del.i, g.max_hp)), '[]'::jsonb), count(*) into grow, n from del;
      update public.game set destroyed = greatest(0, destroyed - n) where id = 1;
      perform public._layer_add(array(select (x->>0)::int from jsonb_array_elements(grow) x), -1);
    end if;
  elsif k = 'durci' then
    -- 🪨 les blocs tout autour deviennent deux fois plus solides
    with c as (
      select (cx + ox) + (cy + oy)*s + (cz + oz)*s*s as i
      from generate_series(-4, 4) ox, generate_series(-4, 4) oy, generate_series(-4, 4) oz
      where ox*ox + oy*oy + oz*oz <= 16
        and cx + ox between 0 and s - 1 and cy + oy between 0 and s - 1 and cz + oz between 0 and s - 1
    ), up as (
      insert into public.blocks as b (i, hp)
      select c.i, (g.max_hp * 2)::smallint from c where not public._is_core(c.i, s) and public._depth(c.i, s) >= g.peeled
      on conflict (i) do update set hp = least(b.hp * 2, g.max_hp * 2)::smallint where b.hp > 0 and b.hp < g.max_hp * 2
      returning b.i, b.hp
    )
    select coalesce(jsonb_agg(jsonb_build_array(up.i, up.hp)), '[]'::jsonb) into grow from up;
  elsif k = 'pickpocket' then
    select least(30, floor(coalesce(qty, 0) * 0.10))::int into q from public.inventory where player = uid and kind = 'or';
    q := coalesce(q, 0);
    if q > 0 then update public.inventory set qty = qty - q where player = uid and kind = 'or'; end if;
  end if;
  perform public._add(uid, 'or', 5);                     -- dédommagement
  update public.stats set traps = traps + 1 where player = uid;
  perform public._log(uid, 'trap', jsonb_build_object('kind', k));
  return jsonb_build_object('k', k, 'i', idx, 'sec', sec, 'grow', grow, 'gold', -q, 'comp', 5);
end $$;

-- Nouvelle semaine (lundi 0 h, heure de Paris) : sacre le meilleur casseur, remet les compteurs à zéro
create or replace function public._week_roll() returns void
language plpgsql security definer set search_path = public as $$
declare g record; ws timestamptz := date_trunc('week', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'; w record;
begin
  select week_start, destroyed into g from public.game where id = 1;
  if g.week_start is not null and g.week_start >= ws then return; end if;
  if g.week_start is not null then
    select st.player, st.week_blocks, p.pseudo into w from public.stats st join public.profiles p on p.id = st.player
      where st.week_blocks > 0 order by st.week_blocks desc limit 1;
    if found then
      update public.stats set trophies = trophies + 1 where player = w.player;
      update public.game set last_winner = w.pseudo, last_winner_blocks = w.week_blocks where id = 1;
      perform public._log(w.player, 'week_winner', jsonb_build_object('blocks', w.week_blocks));
    end if;
    update public.stats set week_blocks = 0 where week_blocks <> 0;
  end if;
  update public.game set week_start = ws, week_base = g.destroyed, week_done = false where id = 1;
end $$;

-- Objectif commun : nombre de blocs à casser ensemble cette semaine
create or replace function public._week_goal() returns int
language sql stable security definer set search_path = public as $$
  -- automatique : 2 % du cube (au moins 500 blocs), sans dépasser ce qu'il restait lundi
  select case when week_goal > 0 then week_goal
    else greatest(1, least(size::bigint * size * size - week_base, greatest(500, round(size::numeric * size * size * 0.02))))::int end
  from public.game where id = 1;
$$;
-- Vérifie si l'objectif est atteint ; si oui, paie chaque participant. Renvoie le message ou null.
create or replace function public._week_check() returns text
language plpgsql security definer set search_path = public as $$
declare g record; n int;
begin
  select * into g from public.game where id = 1 for update;
  if g.week_done or g.destroyed - g.week_base < public._week_goal() then return null; end if;
  update public.game set week_done = true where id = 1;
  -- participants : tous ceux qui ont joué depuis lundi
  update public.inventory iv set qty = qty + g.week_reward
    from public.stats st where st.player = iv.player and iv.kind = 'or' and st.last_seen >= g.week_start;
  insert into public.inventory (player, kind, qty)
    select st.player, 'or', g.week_reward from public.stats st
    where st.last_seen >= g.week_start and not exists (select 1 from public.inventory iv where iv.player = st.player and iv.kind = 'or');
  get diagnostics n = row_count;
  perform public._log(null, 'week_goal', jsonb_build_object('reward', g.week_reward));
  return '🎯 Objectif de la semaine atteint ! +' || g.week_reward || ' 🪙';
end $$;

-- Révélation du trésor : quand tout est détruit, désigne le gagnant du lot (une seule fois)
create or replace function public._maybe_reveal(uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t record; w uuid; wp text;
begin
  update public.game set revealed_at = now() where id = 1 and revealed_at is null and public.all_done();
  if not found then return; end if;
  select * into t from public.treasure where id = 1;
  if t.prize_rule = 'top' then
    select st.player into w from public.stats st join public.profiles p on p.id = st.player
      where p.status = 'approved' order by st.blocks desc, st.hits desc limit 1;
  end if;
  w := coalesce(w, uid);
  select pseudo into wp from public.profiles where id = w;
  update public.treasure set winner = w, winner_pseudo = wp, won_prize = prize, prize_given = false where id = 1;
  perform public._log(w, 'prize_won', jsonb_build_object('prize', t.prize, 'rule', t.prize_rule));
  -- 🥈 les deux meilleurs du classement, en dehors du gagnant du lot
  update public.treasure set won_podium = (
    select coalesce(jsonb_agg(jsonb_build_object('id', x.player, 'pseudo', x.pseudo, 'rank', x.rk,
             'prize', coalesce(t.prize_podium -> (x.rk - 1), '{}'::jsonb)) order by x.rk), '[]'::jsonb)
    from (select st.player, p.pseudo, row_number() over (order by st.blocks desc, st.hits desc)::int as rk
          from public.stats st join public.profiles p on p.id = st.player
          where p.status = 'approved' and st.blocks > 0 and st.player <> w
          order by st.blocks desc, st.hits desc limit 2) x) where id = 1;
end $$;

-- Butin d'un bloc : calculé à partir de sa position et d'une graine secrète,
-- donc identique quel que soit le joueur qui le casse. Renvoie 'or:5', 'fer:1'… ou null.
-- gm / mm = multiplicateurs de l'or et des matériaux (🧲 Aimant, combo, événements)
drop function if exists public._loot_at(int, int, int, int, int, float8, float8);
drop function if exists public._loot_at(int, int, int, int, int, float8, float8, jsonb);
-- 🧭 Pilote automatique (version 14.4) : réglages qu'il tient à jour, et décalage de profondeur des matériaux
alter table public.game add column if not exists mat_shift real not null default 0;        -- 0 = normal ; 0,2 = les matériaux « profonds » remontent de 20 %
alter table public.game add column if not exists autopilot jsonb not null default '{}'::jsonb;
-- mw : poids de chaque matériau réglés par l'organisateur (1 = normal, 2 = deux fois plus, 0 = jamais)
create or replace function public._loot_at(idx int, s int, seed int, gold_every int, mat_every int, gm float8, mm float8,
                                           mw jsonb default '{}'::jsonb, mshift float8 default 0) returns text
language plpgsql immutable as $$
declare h1 float8; h2 float8; h3 float8; t float8; seed2 int; seed3 int;
  ws float8; wf float8; wp float8; wc float8; tot float8;
begin
  seed2 := ((seed::bigint * 31 + 7) % 2147483647)::int;
  seed3 := ((seed::bigint + 99991) % 2147483647)::int;
  h1 := (hashint4(idx # seed)::bigint + 2147483648) / 4294967296.0;
  if gold_every > 0 and h1 < gm / gold_every then
    h3 := (hashint4(idx # seed3)::bigint + 2147483648) / 4294967296.0;
    return 'or:' || case when h3 < 0.025 then 20 when h3 < 0.2 then 5 else 1 end;   -- 2,5 % de bourses de 20
  end if;
  h2 := (hashint4(idx # seed2)::bigint + 2147483648) / 4294967296.0;
  if mat_every <= 0 then return null; end if;
  -- part de chaque matériau selon la profondeur, multipliée par le réglage de l'organisateur
  t := least(1, public._depth(idx, s)::float8 / greatest(1, (s - 1) / 2) + greatest(0, least(0.5, coalesce(mshift, 0))));
  if t < 0.25 then ws := 0.7; wf := 0.3; wp := 0; wc := 0;
  elsif t < 0.5 then ws := 0.25; wf := 0.5; wp := 0.25; wc := 0;
  elsif t < 0.75 then ws := 0; wf := 0.3; wp := 0.5; wc := 0.2;
  else ws := 0; wf := 0; wp := 0.4; wc := 0.6; end if;
  ws := ws * coalesce((mw->>'silex')::float8, 1); wf := wf * coalesce((mw->>'fer')::float8, 1);
  wp := wp * coalesce((mw->>'poudre')::float8, 1); wc := wc * coalesce((mw->>'cristal')::float8, 1);
  tot := ws + wf + wp + wc;
  if tot <= 0 or h2 >= mm * tot / mat_every then return null; end if;
  h3 := h2 * mat_every / (mm * tot) * tot;          -- entre 0 et tot
  return case when h3 < ws then 'silex' when h3 < ws + wf then 'fer' when h3 < ws + wf + wp then 'poudre' else 'cristal' end || ':1';
end $$;
create or replace function public._loot(idx int, mult int default 1) returns text
language plpgsql stable security definer set search_path = public as $$
declare g record; ev jsonb := public._ev();
begin
  select size, seed, gold_every, mat_every, mat_w, mat_shift into g from public.game where id = 1;
  return public._loot_at(idx, g.size, g.seed, g.gold_every, g.mat_every, mult * (ev->>'or')::float8, mult * (ev->>'mat')::float8, g.mat_w, g.mat_shift);
end $$;

-- Récompenses d'un groupe de blocs qui viennent d'être détruits par le joueur uid.
-- hand = cassés à la main (les pièges se déclenchent) ; sinon par un artefact (les pièges sont désamorcés).
-- Renvoie { a: {bloc: artefact}, l: {bloc: butin}, c: {bloc: coffre}, b: {bloc: artefact bonus}, t: [pièges], loots: [...], nf }
drop function if exists public._destroy(int, uuid, int);
drop function if exists public._reward(int, uuid, int);
create or replace function public._reward_set(p_cells int[], uid uuid, mult int, hand boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; ev jsonb := public._ev(); gm float8; mm float8; e record; tk text; ch text;
  a jsonb := '{}'; l jsonb := '{}'; c jsonb := '{}'; b jsonb := '{}'; traps jsonb := '[]';
  loots text[] := '{}'; nf int := 0; clover boolean; pbonus float8; arts text[] := public._classics(); gsum int := 0; msum int := 0;
begin
  if coalesce(array_length(p_cells, 1), 0) = 0 then
    return jsonb_build_object('a', a, 'l', l, 'c', c, 'b', b, 't', traps, 'loots', '[]'::jsonb, 'nf', 0);
  end if;
  select * into g from public.game where id = 1;
  gm := mult * (ev->>'or')::float8; mm := mult * (ev->>'mat')::float8;
  perform public._layer_add(p_cells, 1);
  -- artefacts et pièges cachés
  for e in update public.artifacts set found_by = uid, found_at = now()
           where i = any(p_cells) and found_by is null returning i, kind loop
    if public._is_trap(e.kind) then
      if hand then traps := traps || jsonb_build_array(public._trap(uid, e.kind, e.i));
      else traps := traps || jsonb_build_array(jsonb_build_object('k', e.kind, 'i', e.i, 'off', true)); end if;
    else
      perform public._add(uid, e.kind, 1); nf := nf + 1;
      a := a || jsonb_build_object(e.i::text, e.kind);
      if public._legendary(e.kind) then perform public._log(uid, 'legendary', jsonb_build_object('kind', e.kind)); end if;
    end if;
  end loop;
  -- coffres dorés (dont les 🎭 faux coffres)
  for e in select ch0.i from public.chests ch0 where ch0.i = any(p_cells) and ch0.opened_by is null loop
    ch := public._chest_open(e.i, uid, (ev->>'coffre')::numeric::int);
    if ch = 'piege' then
      tk := (public._traps())[1 + floor(random() * 6)::int];
      if hand then traps := traps || jsonb_build_array(public._trap(uid, tk, e.i) || jsonb_build_object('fake', true));
      else traps := traps || jsonb_build_array(jsonb_build_object('k', tk, 'i', e.i, 'off', true, 'fake', true)); end if;
      c := c || jsonb_build_object(e.i::text, 'piege:' || tk);
    elsif ch is not null then c := c || jsonb_build_object(e.i::text, ch); end if;
  end loop;
  -- butin (or et matériaux)
  select coalesce(jsonb_object_agg(q.i, q.lt), '{}'::jsonb), coalesce(array_agg(q.lt), '{}') into l, loots
  from (select x.i, public._loot_at(x.i, g.size, g.seed, g.gold_every, g.mat_every, gm, mm, g.mat_w, g.mat_shift) as lt from unnest(p_cells) as x(i)) q
  where q.lt is not null;
  for e in select split_part(x, ':', 1) as k, sum(split_part(x, ':', 2)::int)::int as q from unnest(loots) x group by 1 loop
    perform public._add(uid, e.k, e.q);
    if e.k = 'or' then gsum := gsum + e.q; else msum := msum + e.q; end if;
  end loop;
  if gsum + msum > 0 then perform public._bump(uid, gsum, msum, 0, 0, 0); end if;
  -- 🍀 Trèfle et événements « artefacts » : artefacts bonus (seulement en cassant à la main)
  if hand then
    select coalesce(st.clover_until > now(), false) into clover from public.stats st where st.player = uid;
    pbonus := (case when clover then 1.0 / 150 else 0 end) + ((ev->>'art')::float8 - 1) / 400;
    if pbonus > 0 then
      for e in select x.i from unnest(p_cells) as x(i) where random() < pbonus loop
        tk := arts[1 + floor(random() * array_length(arts, 1))::int];
        perform public._add(uid, tk, 1); nf := nf + 1;
        b := b || jsonb_build_object(e.i::text, tk);
      end loop;
    end if;
  end if;
  return jsonb_build_object('a', a, 'l', l, 'c', c, 'b', b, 't', traps, 'loots', to_jsonb(loots), 'nf', nf);
end $$;

-- Détruit d'un coup un groupe de blocs (artefacts). Le cœur scellé est épargné.
-- Renvoie les récompenses (voir _reward_set) + d : les blocs vraiment détruits.
create or replace function public._destroy_set(p_cells int[], uid uuid, mult int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s int; pl int; sealed boolean; dd int[];
begin
  select size, peeled into s, pl from public.game where id = 1;
  sealed := public._sealed();
  with c as (select distinct u as i from unnest(p_cells) u
             where u >= 0 and u < s * s * s and not (sealed and public._is_core(u, s)) and public._depth(u, s) >= pl),
  ins as (insert into public.blocks as b (i, hp) select c.i, 0 from c
          on conflict (i) do update set hp = 0 where b.hp > 0 returning b.i)
  select coalesce(array_agg(ins.i), '{}') into dd from ins;
  return public._reward_set(dd, uid, mult, false) || jsonb_build_object('d', to_jsonb(dd));
end $$;

-- Multiplicateur de butin du joueur (🧲 Aimant : ×3 pendant 3 minutes)
create or replace function public._mult(uid uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.stats where player = uid and magnet_until > now()) then 3 else 1 end;
$$;

-- ----- Répartition des artefacts, pièges et coffres (version 8) -----
-- Densité : nombre pour un cube 128³ (2 097 152 blocs), proportionnel au volume du cube.
-- t0-t1 : bande de profondeur (0 = surface, 1 = juste avant le cœur). Les plus puissants sont cachés plus profond.
create or replace function public._plan_table() returns table (kind text, dens numeric, t0 numeric, t1 numeric, minimum int, trap boolean)
language sql immutable as $$
  values
    ('bombe', 40, 0, 0.6, 1, false), ('foreuse', 30, 0, 0.6, 1, false), ('marteau', 25, 0, 0.6, 1, false),
    ('radar', 20, 0, 0.6, 1, false), ('scie', 25, 0, 0.6, 1, false), ('sonde', 25, 0, 0.6, 1, false),
    ('aimant', 15, 0, 0.6, 1, false), ('dynamite', 30, 0, 0.6, 1, false), ('trefle', 15, 0, 0.6, 1, false),
    ('sablier', 12, 0, 0.6, 1, false), ('fontaine', 12, 0, 0.6, 1, false),
    ('seisme', 15, 0.25, 0.9, 1, false), ('cor', 10, 0.25, 0.9, 1, false), ('vrille', 14, 0.25, 0.9, 1, false),
    ('grappe', 12, 0.25, 0.9, 1, false), ('givre', 12, 0.25, 0.9, 1, false),
    ('megabombe', 6, 0.5, 1, 1, false), ('chaine', 6, 0.5, 1, 1, false), ('tornade', 5, 0.5, 1, 1, false), ('pilier', 4, 0.5, 1, 1, false),
    ('ecorce', 1, 0.7, 1, 1, false), ('oeil', 2, 0.7, 1, 1, false),
    ('toile', 15, 0.05, 0.85, 1, true), ('lenteur', 15, 0.05, 0.85, 1, true), ('brouillard', 12, 0.05, 0.85, 1, true),
    ('macon', 10, 0.05, 0.85, 1, true), ('durci', 12, 0.05, 0.85, 1, true), ('pickpocket', 10, 0.05, 0.85, 1, true),
    ('coffre', 524, 0, 1, 3, false), ('faux_coffre', 52, 0, 1, 1, true)
$$;
-- Plan pour le cube actuel : { sorte: { n, lo, hi } } (couches lo à hi, 0 = surface).
-- Tient compte de ce qui est déjà détruit : une couche à moitié creusée reçoit moitié moins.
create or replace function public._plan(only_kinds text[] default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g record; s int; cd int; lm int; dl bigint[]; r record; lo int; hi int; vol numeric; intact numeric; n int; o jsonb := '{}'; k int; f numeric;
begin
  select * into g from public.game where id = 1;
  s := g.size;
  cd := case when s % 2 = 0 then s/2 - 1 else (s-1)/2 - 1 end;     -- couche du cœur
  lm := greatest(cd - 1, 0);
  dl := array_fill(0::bigint, array[cd + 2]);
  for r in select ld.d, ld.n as c from public.layer_done ld where ld.d between 0 and cd loop
    dl[r.d + 1] := r.c;
  end loop;
  for r in select * from public._plan_table() loop
    continue when only_kinds is not null and not (r.kind = any(only_kinds));
    continue when r.trap and not g.traps_on;
    lo := floor(r.t0 * lm); hi := floor(r.t1 * lm);
    vol := 0; intact := 0;
    for k in lo .. hi loop
      f := (s - 2*k)::numeric ^ 3 - greatest(s - 2*k - 2, 0)::numeric ^ 3;
      vol := vol + f; intact := intact + greatest(0, f - dl[k + 1]);
    end loop;
    n := round(r.dens * s::numeric ^ 3 / 2097152 * case when vol > 0 then intact / vol else 0 end);
    if intact > 0 and (s >= 40 or r.t0 < 0.5) then n := greatest(n, r.minimum); end if;   -- petits cubes : au moins 1 de chaque (sauf les plus rares)
    o := o || jsonb_build_object(r.kind, jsonb_build_object('n', n, 'lo', lo, 'hi', hi));
  end loop;
  return o;
end $$;
-- Cache cnt objets entre les couches lo et hi, dans des blocs intacts.
-- what : 'art' (artefact ou piège k), 'chest' (coffre doré) ou 'fake' (🎭 faux coffre). Renvoie le nombre caché.
create or replace function public._place(k text, cnt int, lo int, hi int, what text default 'art') returns int
language plpgsql security definer set search_path = public as $$
declare s int; added int := 0; tries int := 0; side int; got int;
begin
  if coalesce(cnt, 0) <= 0 then return 0; end if;
  select size into s from public.game where id = 1;
  lo := greatest(lo, 0, (select peeled from public.game where id = 1)); side := greatest(s - 2 * lo, 1);
  if lo > hi then return 0; end if;
  while added < cnt and tries < 8 loop
    tries := tries + 1;
    if what = 'art' then
      with cand as (
        select distinct (lo + floor(random() * side)::int) + (lo + floor(random() * side)::int) * s
                      + (lo + floor(random() * side)::int) * s * s as cell
        from generate_series(1, (cnt - added) * 4 * tries + 50)
      )
      insert into public.artifacts (i, kind)
      select cand.cell, k from cand
      where public._depth(cand.cell, s) between lo and hi and not public._is_core(cand.cell, s)
        and not exists (select 1 from public.blocks b where b.i = cand.cell and b.hp = 0)
        and not exists (select 1 from public.chests c where c.i = cand.cell)
      limit cnt - added
      on conflict (i) do nothing;
    else
      with cand as (
        select distinct (lo + floor(random() * side)::int) + (lo + floor(random() * side)::int) * s
                      + (lo + floor(random() * side)::int) * s * s as cell
        from generate_series(1, (cnt - added) * 4 * tries + 50)
      )
      insert into public.chests (i, trap)
      select cand.cell, what = 'fake' from cand
      where public._depth(cand.cell, s) between lo and hi and not public._is_core(cand.cell, s)
        and not exists (select 1 from public.blocks b where b.i = cand.cell and b.hp = 0)
        and not exists (select 1 from public.artifacts a where a.i = cand.cell)
      limit cnt - added
      on conflict (i) do nothing;
    end if;
    get diagnostics got = row_count;
    added := added + got;
  end loop;
  return added;
end $$;
-- Cache tout ce que prévoit le plan (only_kinds = seulement ces sortes). Renvoie {sorte: nombre caché}.
drop function if exists public._regen(int);
create or replace function public._apply_plan(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e record; o jsonb := '{}'; n int;
begin
  for e in select key, value from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    continue when not (e.key = any(public._arts() || public._traps() || array['coffre', 'faux_coffre']));
    n := public._place(e.key, least(greatest(coalesce((e.value->>'n')::int, 0), 0), 20000),
                       coalesce((e.value->>'lo')::int, 0), coalesce((e.value->>'hi')::int, 999),
                       case e.key when 'coffre' then 'chest' when 'faux_coffre' then 'fake' else 'art' end);
    o := o || jsonb_build_object(e.key, n);
  end loop;
  return o;
end $$;
drop function if exists public._regen(int, text[]);
create or replace function public._regen(s int, only_kinds text[] default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._apply_plan(public._plan(only_kinds));
end $$;

-- Nouvelle mission pour un joueur
create or replace function public._new_mission(p_uid uuid, p_slot int) returns void
language plpgsql security definer set search_path = public as $$
declare r float8 := random(); s int; dp int; t text; it text := null; pa int := 0; tg int; rw int;
  arts text[] := public._classics();
  mats text[] := array['silex', 'fer', 'poudre', 'cristal'];
begin
  select size into s from public.game where id = 1;
  select coalesce(max(deepest), 0) into dp from public.stats where player = p_uid;
  if r < 0.35 then
    t := 'creuser'; pa := least(greatest((s - 1) / 2 - 3, 0), dp + floor(random() * 4)::int);
    tg := 15 + floor(random() * 31)::int; rw := greatest(2, tg / 6 + pa / 3);
  elsif r < 0.55 then
    t := 'utiliser'; it := arts[1 + floor(random() * array_length(arts, 1))::int]; tg := 1; rw := public._value(it) / 2 + 5;
  elsif r < 0.8 then
    t := 'livrer';
    if random() < 0.75 then
      it := mats[1 + floor(random() * 4)::int]; tg := 2 + floor(random() * 4)::int; rw := tg * public._value(it) * 2 + 2;
    else
      it := arts[1 + floor(random() * array_length(arts, 1))::int]; tg := 1; rw := (public._value(it) * 3) / 2;
    end if;
  else
    t := 'trouver'; it := mats[1 + floor(random() * 4)::int]; tg := 1 + floor(random() * 3)::int;
    rw := tg * public._value(it) * 2 + 3;
  end if;
  insert into public.missions as ms (player, slot, typ, item, param, target, progress, reward, created_at)
  values (p_uid, p_slot, t, it, pa, tg, 0, rw, now())
  on conflict (player, slot) do update set typ = excluded.typ, item = excluded.item, param = excluded.param,
    target = excluded.target, progress = 0, reward = excluded.reward, created_at = now();
end $$;

-- Fait avancer les missions et paie celles qui sont terminées. Renvoie les messages à afficher.
create or replace function public._missions_progress(p_uid uuid, p_depths int[], p_loots text[], p_used text)
returns text[] language plpgsql security definer set search_path = public as $$
declare r record; msgs text[] := '{}';
begin
  if coalesce(array_length(p_depths, 1), 0) > 0 then
    update public.missions m set progress = m.progress + (select count(*) from unnest(p_depths) as dd where dd >= m.param)
     where m.player = p_uid and m.typ = 'creuser';
  end if;
  if coalesce(array_length(p_loots, 1), 0) > 0 then
    update public.missions m set progress = m.progress + coalesce((
        select sum(split_part(l, ':', 2)::int) from unnest(p_loots) as l where split_part(l, ':', 1) = m.item), 0)
     where m.player = p_uid and m.typ = 'trouver';
  end if;
  if p_used is not null then
    update public.missions set progress = progress + 1 where player = p_uid and typ = 'utiliser' and item = p_used;
  end if;
  for r in select * from public.missions
           where player = p_uid and typ in ('creuser', 'trouver', 'utiliser') and progress >= target loop
    perform public._add(p_uid, 'or', r.reward);
    perform public._bump(p_uid, r.reward, 0, 0, 0, 1);
    msgs := msgs || ('📜 Mission accomplie ! +' || r.reward || ' 🪙');
    perform public._new_mission(p_uid, r.slot);
  end loop;
  return msgs;
end $$;



-- ---------------------------------------------------------------------
-- 4. FONCTIONS DU JEU
-- ---------------------------------------------------------------------
create or replace function public.me() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('id', p.id, 'pseudo', p.pseudo, 'status', p.status, 'is_admin', p.is_admin, 'avatar', p.avatar, 'color', p.color,
    'is_mod', p.is_mod, 'warnings', p.warnings, 'chat_muted_until', p.chat_muted_until, 'chat_banned', p.chat_banned,
    'banned_until', case when p.banned_until > now() and not p.is_admin then p.banned_until end,
    'banned_forever', p.banned_until = 'infinity'::timestamptz and not p.is_admin, 'ban_reason', p.ban_reason,
    'pseudo_changed_at', p.pseudo_changed_at, 'pseudo_locked', p.pseudo_locked,
    'pseudo_days', (select pseudo_days from public.game where id = 1), 'now', now())
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.game_state() returns json
language plpgsql security definer set search_path = public as $$
begin
  if public.is_approved() then
    perform public._week_roll();
    perform public._daily_roll();
    -- présence (le jeu interroge l'état toutes les minutes) : sert à la ⛲ Fontaine
    insert into public.stats as st (player, seen_at) values (auth.uid(), now())
      on conflict (player) do update set seen_at = now();
    perform public._streak_touch(auth.uid());                  -- 🔥 série de jours
  end if;
  return (select case when public.is_approved() then json_build_object(
    'size', size, 'revealed', revealed_at is not null, 'max_hp', max_hp, 'destroyed', destroyed,
    'gold_every', gold_every, 'mat_every', mat_every,
    'rally_left', greatest(0, extract(epoch from rally_until - now())),
    'eye_left', greatest(0, extract(epoch from eye_until - now())),
    'eye', case when eye_until > now() then
      (select coalesce(json_agg(a.i), '[]'::json) from (select ar.i from public.artifacts ar
        where ar.found_by is null and not public._is_trap(ar.kind) limit 3000) a) end,
    'magnet_left', (select greatest(0, extract(epoch from st.magnet_until - now())) from public.stats st where st.player = auth.uid()),
    'fx', (select json_build_object(
        'hammer', greatest(0, extract(epoch from st.hammer_until - now())), 'tornado', greatest(0, extract(epoch from st.tornado_until - now())),
        'clover', greatest(0, extract(epoch from st.clover_until - now())), 'web', greatest(0, extract(epoch from st.web_until - now())),
        'numb', greatest(0, extract(epoch from st.numb_until - now())), 'fog', greatest(0, extract(epoch from st.fog_until - now())))
      from public.stats st where st.player = auth.uid()),
    'shop', (select coalesce(json_object_agg(kind, price), '{}'::json) from public.shop),
    'recipes', (select coalesce(json_object_agg(result, ingredients), '{}'::json) from public.recipes where enabled),
    'event', public._event_info(), 'events_on', events_on, 'traps_on', traps_on, 'peeled', peeled, 'mat_w', mat_w, 'mat_shift', mat_shift,
    'autopilot', case when coalesce((autopilot->>'on')::boolean, false) then true else false end,
    'week', json_build_object('goal', public._week_goal(), 'progress', destroyed - week_base, 'reward', week_reward, 'done', week_done,
      'auto', week_goal = 0, 'start', week_start, 'last_winner', last_winner, 'last_winner_blocks', last_winner_blocks),
    'chests', (select coalesce(json_agg(c.i), '[]'::json) from public.chests c where c.opened_by is null),
    'announce', announce, 'announce_at', announce_at,
    'prize', (select case when t.prize_visible then t.prize end from public.treasure t where t.id = 1),
    'prize_rule', (select t.prize_rule from public.treasure t where t.id = 1),
    'prize_podium', (select case when t.prize_visible then t.prize_podium end from public.treasure t where t.id = 1),
    'podium_note', podium_note,
    'prize_note', prize_note, 'prize_note_at', prize_note_at,
    'chat', json_build_object('locked', chat_locked, 'slow', chat_slow, 'links', chat_links, 'newbie', chat_newbie_min),
    'pseudo_days', pseudo_days, 'theme', theme, 'daily', public._daily_info(), 'daily_on', daily_on, 'daily_reward', daily_reward,
    'pm_unread', public.pm_unread(), 'season', season, 'my', public._my_daily(auth.uid()),
    'prize_global', (select case when t.prize_visible then t.prize_global end from public.treasure t where t.id = 1), 'global_note', global_note
  ) end
  from public.game where id = 1);
end $$;

create or replace function public.get_blocks() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select string_agg(i::text || ':' || hp::text, ',') from public.blocks);
end $$;

-- Effets en cours du joueur (secondes restantes)
create or replace function public._fx(uid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'hammer', greatest(0, extract(epoch from st.hammer_until - now())), 'tornado', greatest(0, extract(epoch from st.tornado_until - now())),
    'clover', greatest(0, extract(epoch from st.clover_until - now())), 'magnet', greatest(0, extract(epoch from st.magnet_until - now())),
    'web', greatest(0, extract(epoch from st.web_until - now())), 'numb', greatest(0, extract(epoch from st.numb_until - now())),
    'fog', greatest(0, extract(epoch from st.fog_until - now())))
  from public.stats st where st.player = uid;
$$;

-- Coups groupés (le jeu envoie au plus un paquet par seconde). Renvoie
--   r : [[bloc, pv, artefact, butin, coffre], …]  (butin = 'scelle' : cœur scellé, 'refus' : coup refusé)
--   g : [[bloc, pv], …] blocs reconstruits ou durcis par un piège · t : pièges · msgs · rej · fx
-- Anti-triche : la force des coups est calculée ici (pas par le jeu) et leur nombre est limité
-- à 20 par seconde (40 d'avance). Le combo (butin ×2) est vérifié de la même façon.
drop function if exists public.hit_blocks(int[], int[], int, int, int);
create or replace function public.hit_blocks(idx int[], n int[], best_ms int default null, cps int default null, deep int default null, combo int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); g record; st record; s int; k int; m int; v smallint; ev jsonb;
  dmg float8; tokens float8; need int; clicks int := 0; rej int := 0; total int := 0;
  cells int[] := '{}'; vals int[] := '{}'; tags text[] := '{}'; broke int[] := '{}'; td int[] := '{}'; tc int[];
  sealed boolean; hammer boolean; tornado boolean; webbed boolean;
  rw jsonb; tw jsonb := null; res jsonb[] := '{}'; grow jsonb; traps jsonb; lts text[]; x int;
  depths int[]; msgs text[]; mult int; cmb int; wk text; nbroke int; dp int; ms int; dl text;
  vc int; cp int; ml int; bn int; cmsgs text[] := '{}'; nhand int;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if idx is null or coalesce(array_length(idx, 1), 0) = 0 then return jsonb_build_object('r', '[]'::jsonb, 'msgs', '[]'::jsonb); end if;
  if array_length(idx, 1) > 500 then raise exception 'Trop de coups envoyés en même temps'; end if;
  perform public._week_roll();
  select * into g from public.game where id = 1;
  s := g.size;
  insert into public.stats (player) values (uid) on conflict (player) do nothing;
  select * into st from public.stats where player = uid for update;
  ev := public._ev();
  hammer := coalesce(st.hammer_until > now() - interval '2 seconds', false);
  tornado := coalesce(st.tornado_until > now() - interval '2 seconds', false);
  webbed := coalesce(st.web_until > now(), false);
  if hammer or tornado then dmg := g.max_hp;
  else
    dmg := least(g.max_hp, (case when g.rally_until > now() - interval '2 seconds' then 2 else 1 end) * (ev->>'force')::float8);
    if st.numb_until > now() then dmg := greatest(0.5, dmg / 2); end if;
  end if;
  tokens := least(40, coalesce(st.hit_tokens, 40) + greatest(0, extract(epoch from now() - coalesce(st.hit_at, now() - interval '1 hour'))) * 20);
  sealed := public._sealed();
  for k in 1 .. array_length(idx, 1) loop
    continue when idx[k] is null or idx[k] < 0 or idx[k] >= s * s * s;
    if sealed and public._is_core(idx[k], s) then              -- cœur scellé : le coup ne compte pas
      cells := cells || idx[k]; tags := tags || 'scelle'::text;
      vals := vals || coalesce((select b.hp from public.blocks b where b.i = idx[k]), g.max_hp)::int;
      continue;
    end if;
    if public._depth(idx[k], s) < g.peeled then                  -- couche déjà arrachée
      cells := cells || idx[k]; vals := vals || 0; tags := tags || ''::text;
      continue;
    end if;
    m := least(greatest(coalesce(n[k], 1), 1), g.max_hp * 2);
    need := ceil(m / dmg)::int;
    if webbed or need > tokens then                            -- refusé (🕸️ toile ou trop rapide) : on renvoie les vrais PV
      rej := rej + need;
      cells := cells || idx[k]; tags := tags || 'refus'::text;
      vals := vals || coalesce((select b.hp from public.blocks b where b.i = idx[k]), g.max_hp)::int;
      continue;
    end if;
    tokens := tokens - need; clicks := clicks + need;
    v := null;
    insert into public.blocks as b (i, hp) values (idx[k], greatest(g.max_hp - m, 0))
      on conflict (i) do update set hp = greatest(b.hp - m, 0) where b.hp > 0
      returning b.hp into v;
    cells := cells || idx[k]; vals := vals || coalesce(v, 0)::int; tags := tags || ''::text;
    if v is null then continue; end if;
    total := total + m;
    if v = 0 then broke := broke || idx[k]; end if;
  end loop;
  -- combo vérifié : coups enchaînés sans pause de plus de 2,5 s entre deux paquets
  cmb := case when st.hit_at > now() - interval '2.5 seconds' then st.combo_srv + clicks else clicks end;
  -- 🔥 butin selon le combo : ×2 dès 30, ×3 dès 80, ×4 dès 160, ×5 dès 300 (plafond)
  vc := least(coalesce(combo, 0), cmb);
  mult := public._mult(uid) * public._combo_mult(vc);
  -- 🌪️ Tornade : chaque coup détruit aussi les 26 blocs autour
  if tornado and clicks > 0 then
    select coalesce(array_agg(distinct q.nb), '{}') into tc from (
      select (u.cc % s + ox) + ((u.cc / s) % s + oy) * s + (u.cc / (s*s) + oz) * s * s as nb
      from unnest(cells, tags) as u(cc, tg), generate_series(-1, 1) ox, generate_series(-1, 1) oy, generate_series(-1, 1) oz
      where u.tg = '' and u.cc % s + ox between 0 and s - 1 and (u.cc / s) % s + oy between 0 and s - 1 and u.cc / (s*s) + oz between 0 and s - 1
    ) q where not (q.nb = any(cells));
    tw := public._destroy_set(tc, uid, mult);
    td := array(select jsonb_array_elements_text(tw->'d')::int);
  end if;
  rw := public._reward_set(broke, uid, mult, true);
  for k in 1 .. coalesce(array_length(cells, 1), 0) loop
    res := res || jsonb_build_array(cells[k], vals[k],
      coalesce(rw->'a'->>(cells[k]::text), rw->'b'->>(cells[k]::text), ''),
      case when tags[k] <> '' then tags[k] else coalesce(rw->'l'->>(cells[k]::text), '') end,
      coalesce(rw->'c'->>(cells[k]::text), ''));
  end loop;
  foreach x in array td loop
    res := res || jsonb_build_array(x, 0, coalesce(tw->'a'->>(x::text), ''), coalesce(tw->'l'->>(x::text), ''), coalesce(tw->'c'->>(x::text), ''));
  end loop;
  traps := coalesce(rw->'t', '[]'::jsonb) || coalesce(tw->'t', '[]'::jsonb);
  select coalesce(jsonb_agg(gg), '[]'::jsonb) into grow
    from jsonb_array_elements(traps) t, jsonb_array_elements(coalesce(t->'grow', '[]'::jsonb)) gg;
  nbroke := coalesce(array_length(broke, 1), 0) + coalesce(array_length(td, 1), 0);
  depths := array(select public._depth(z, s) from unnest(broke || td) z);
  select max(z) into dp from unnest(depths) z;
  -- record du bloc le plus vite cassé : ignoré s'il est impossible pour un humain
  ms := case when best_ms >= greatest(40, (ceil(g.max_hp / 2.0) - 1) * 45) then best_ms end;
  perform public._stats(uid, total, nbroke, (rw->>'nf')::int + coalesce((tw->>'nf')::int, 0), 0, ms, least(greatest(coalesce(cps, 0), 0), 200), dp);
  update public.stats set hit_tokens = tokens, hit_at = now(), combo_srv = cmb, rejected = rejected + rej,
         best_combo = greatest(best_combo, least(greatest(coalesce(combo, 0), 0), cmb, 100000)) where player = uid;
  if rej >= 30 then perform public._log(uid, 'speed', jsonb_build_object('rej', rej)); end if;
  -- 🔥 primes de combo : une seule fois par combo, à 100, 250, 500 et 1 000 coups (rien de plus au-delà)
  cp := case when st.hit_at > now() - interval '2.5 seconds' then st.combo_paid else 0 end;
  foreach ml in array array[100, 250, 500, 1000] loop
    if vc >= ml and cp < ml then
      bn := public._combo_bonus(ml);
      perform public._add(uid, 'or', bn); perform public._bump(uid, bn, 0, 0, 0, 0);
      cmsgs := cmsgs || ('🔥 Combo ' || ml || ' ! +' || bn || ' 🪙');
      cp := ml;
    end if;
  end loop;
  update public.stats set combo_paid = cp where player = uid;
  if vc > 0 then update public.profiles set combo_best = least(vc, 100000) where id = uid and combo_best < vc; end if;
  -- ⚔️ duel en cours : les blocs cassés à la main comptent
  nhand := coalesce(array_length(broke, 1), 0);
  if nhand > 0 then
    update public.duels set a_score = a_score + nhand where status = 'live' and a = uid and now() between start_at and end_at;
    update public.duels set b_score = b_score + nhand where status = 'live' and b = uid and now() between start_at and end_at;
  end if;
  lts := array(select jsonb_array_elements_text(coalesce(rw->'loots', '[]'::jsonb)) union all select jsonb_array_elements_text(coalesce(tw->'loots', '[]'::jsonb)));
  msgs := public._missions_progress(uid, depths, lts, null);
  dl := public._daily_track(nbroke, depths, lts,
          (select count(*)::int from jsonb_object_keys(coalesce(rw->'c', '{}'::jsonb))) + (select count(*)::int from jsonb_object_keys(coalesce(tw->'c', '{}'::jsonb))), 0, cmb);
  if dl is not null then msgs := coalesce(msgs, '{}') || dl; end if;
  msgs := coalesce(msgs, '{}') || cmsgs;
  if nbroke > 0 then
    update public.game set destroyed = destroyed + nbroke where id = 1;
    perform public._maybe_reveal(uid);
    wk := public._week_check();
    if wk is not null then msgs := coalesce(msgs, '{}') || wk; end if;
  end if;
  return jsonb_build_object('r', to_jsonb(res), 'g', grow, 't', traps, 'msgs', to_jsonb(coalesce(msgs, '{}')),
                            'rej', rej, 'fx', public._fx(uid), 'mult', public._combo_mult(vc),
                            'duel', case when nhand > 0 then public._duel_live(uid) end);
end $$;

-- Utiliser un artefact.
--   dir : laser, dynamite, vrille, pilier = sens du regard 0..5 (+x, -x, +y, -y, +z, -z) ; scie = axe de la ligne (0 = x, 1 = y, 2 = z)
-- 🧅 l'Écorce du Monde ne donne plus le contenu de la couche : ce qui y était caché s'enfonce plus profond (sinon la partie s'emballe)
alter table public.game add column if not exists peel_at timestamptz;
create or replace function public._relocate_deeper(layer int, s int) returns int
language plpgsql security definer set search_path = public as $$
declare r record; lo int := layer + 1; hi int := s - layer - 2; tries int; c int; moved int := 0;
begin
  for r in select a.i from public.artifacts a where a.found_by is null and public._depth(a.i, s) = layer loop
    c := null; tries := 0;
    while hi >= lo and tries < 12 loop
      c := (lo + floor(random() * (hi - lo + 1)))::int + (lo + floor(random() * (hi - lo + 1)))::int * s + (lo + floor(random() * (hi - lo + 1)))::int * s * s;
      exit when not public._is_core(c, s) and not exists (select 1 from public.blocks b where b.i = c and b.hp = 0)
        and not exists (select 1 from public.artifacts a2 where a2.i = c) and not exists (select 1 from public.chests h where h.i = c);
      c := null; tries := tries + 1;
    end loop;
    if c is null then delete from public.artifacts where i = r.i; else update public.artifacts set i = c where i = r.i; moved := moved + 1; end if;
  end loop;
  for r in select h.i from public.chests h where h.opened_by is null and public._depth(h.i, s) = layer loop
    c := null; tries := 0;
    while hi >= lo and tries < 12 loop
      c := (lo + floor(random() * (hi - lo + 1)))::int + (lo + floor(random() * (hi - lo + 1)))::int * s + (lo + floor(random() * (hi - lo + 1)))::int * s * s;
      exit when not public._is_core(c, s) and not exists (select 1 from public.blocks b where b.i = c and b.hp = 0)
        and not exists (select 1 from public.artifacts a2 where a2.i = c) and not exists (select 1 from public.chests h2 where h2.i = c);
      c := null; tries := tries + 1;
    end loop;
    if c is null then delete from public.chests where i = r.i; else update public.chests set i = c where i = r.i; moved := moved + 1; end if;
  end loop;
  return moved;
end $$;

create or replace function public.use_artifact(k text, center int, dir int default 0)
returns json language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); g record; s int; cx int; cy int; cz int; r int;
  dx int := 0; dy int := 0; dz int := 0; px int; py int; pz int; e record; ev jsonb;
  cells int[] := '{}'; mult int; sealed boolean; ax int; sg int; w int; a1 int; a2 int; q int := 0; ld int;
  rw jsonb := null; destroyed int[] := '{}'; found_list jsonb := '[]'::jsonb; loots text[] := '{}'; nf int := 0;
  chests jsonb := '[]'::jsonb; traps jsonb := '[]'::jsonb; damaged jsonb := '[]'::jsonb; probe jsonb := null; eye jsonb := null;
  radar int := -1; layer int := null; npeel int := 0; bonus int := 0; core_d int; fa int; fb int;
  depths int[]; msgs text[]; nd int; wk text; dl text; chx text; extra jsonb := '{}'::jsonb; visited int[]; frontier int[]; nxt int[];
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._check_kind(k);
  perform public._art_check_use(uid, k);
  perform public._take(uid, k, 1);
  perform public._week_roll();
  select * into g from public.game where id = 1;
  s := g.size;
  mult := public._mult(uid);
  sealed := public._sealed();
  ev := public._ev();
  insert into public.stats (player) values (uid) on conflict (player) do nothing;
  if center is null or center < 0 or center >= s*s*s then
    center := (s/2) + (s/2)*s + (s/2)*s*s;
  end if;
  cx := center % s; cy := (center / s) % s; cz := center / (s*s);
  dir := least(greatest(coalesce(dir, 0), 0), 5);
  ax := dir / 2; sg := case when dir % 2 = 0 then 1 else -1 end;      -- axe et sens du regard

  if k in ('bombe', 'megabombe') then
    r := case when k = 'bombe' then 1 else 3 end;
    for pz in greatest(cz - r, 0) .. least(cz + r, s - 1) loop
      for py in greatest(cy - r, 0) .. least(cy + r, s - 1) loop
        for px in greatest(cx - r, 0) .. least(cx + r, s - 1) loop
          cells := cells || (px + py*s + pz*s*s);
        end loop;
      end loop;
    end loop;
  elsif k = 'foreuse' then
    dx := case dir when 0 then 1 when 1 then -1 else 0 end;
    dy := case dir when 2 then 1 when 3 then -1 else 0 end;
    dz := case dir when 4 then 1 when 5 then -1 else 0 end;
    for r in 0 .. 14 loop
      px := cx + dx*r; py := cy + dy*r; pz := cz + dz*r;
      exit when px < 0 or py < 0 or pz < 0 or px >= s or py >= s or pz >= s;
      cells := cells || (px + py*s + pz*s*s);
    end loop;
  elsif k = 'scie' then
    -- 🪚 une ligne entière, d'un bord à l'autre du cube
    for r in 0 .. s - 1 loop
      cells := cells || case dir when 1 then cx + r*s + cz*s*s
                                 when 2 then cx + cy*s + r*s*s
                                 else r + cy*s + cz*s*s end;
    end loop;
  elsif k in ('dynamite', 'vrille', 'pilier') then
    -- 🧨 plaque 5×5 sur 2 blocs · 🌀 tunnel 3×3 sur 20 blocs · 🎯 colonne 5×5 à travers tout le cube
    r := case k when 'vrille' then 1 else 2 end;
    select coalesce(array_agg(t.x + t.y*s + t.z*s*s), '{}') into cells from (
        select case ax when 0 then (case when k = 'pilier' then ww else cx + sg*ww end) else cx + b1 end as x,
               case ax when 1 then (case when k = 'pilier' then ww else cy + sg*ww end) when 0 then cy + b1 else cy + b2 end as y,
               case ax when 2 then (case when k = 'pilier' then ww else cz + sg*ww end) else cz + b2 end as z
        from generate_series(0, case k when 'dynamite' then 1 when 'vrille' then 19 else s - 1 end) ww,
             generate_series(-r, r) b1, generate_series(-r, r) b2
      ) t where t.x between 0 and s - 1 and t.y between 0 and s - 1 and t.z between 0 and s - 1;
  elsif k = 'grappe' then
    -- 💥 six petites bombes 3×3×3 au hasard autour du point visé
    for q in 1 .. 6 loop
      px := least(greatest(cx + floor(random() * 17)::int - 8, 0), s - 1);
      py := least(greatest(cy + floor(random() * 17)::int - 8, 0), s - 1);
      pz := least(greatest(cz + floor(random() * 17)::int - 8, 0), s - 1);
      cells := cells || array(select (px + ox) + (py + oy)*s + (pz + oz)*s*s
        from generate_series(-1, 1) ox, generate_series(-1, 1) oy, generate_series(-1, 1) oz
        where px + ox between 0 and s - 1 and py + oy between 0 and s - 1 and pz + oz between 0 and s - 1);
    end loop;
    q := 0;
  elsif k = 'chaine' then
    -- ⛓️ réaction en chaîne : le bloc visé et tous les blocs de la même couche qui le touchent (400 au plus)
    ld := public._depth(center, s);
    visited := array[center]; frontier := case when ld < g.peeled then '{}'::int[] else array[center] end;
    while coalesce(array_length(frontier, 1), 0) > 0 and array_length(visited, 1) < 400 loop
      select coalesce(array_agg(distinct q2.nb), '{}') into nxt from (
        select (c.x + o.ox) + (c.y + o.oy)*s + (c.z + o.oz)*s*s as nb
        from (select f % s as x, (f / s) % s as y, f / (s*s) as z from unnest(frontier) f) c,
             (values (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)) o(ox, oy, oz)
        where c.x + o.ox between 0 and s - 1 and c.y + o.oy between 0 and s - 1 and c.z + o.oz between 0 and s - 1
      ) q2
      where public._depth(q2.nb, s) = ld and not (q2.nb = any(visited))
        and not exists (select 1 from public.blocks b where b.i = q2.nb and b.hp = 0);
      nxt := nxt[1 : 400 - array_length(visited, 1)];
      visited := visited || nxt; frontier := nxt;
    end loop;
    cells := visited;
  elsif k = 'givre' then
    -- ❄️ tous les blocs dans un rayon de 5 deviennent fragiles : il ne leur reste qu'un coup
    with c as (
      select (cx + ox) + (cy + oy)*s + (cz + oz)*s*s as i
      from generate_series(-5, 5) ox, generate_series(-5, 5) oy, generate_series(-5, 5) oz
      where ox*ox + oy*oy + oz*oz <= 25
        and cx + ox between 0 and s - 1 and cy + oy between 0 and s - 1 and cz + oz between 0 and s - 1
    ), up as (
      insert into public.blocks as b (i, hp)
      select c.i, 1 from c where not (sealed and public._is_core(c.i, s)) and public._depth(c.i, s) >= g.peeled
      on conflict (i) do update set hp = 1 where b.hp > 1
      returning b.i, b.hp
    )
    select coalesce(jsonb_agg(jsonb_build_array(up.i, up.hp)), '[]'::jsonb) into damaged from up;
  elsif k = 'radar' then
    select ar.i into radar from public.artifacts ar
      where ar.found_by is null and not public._is_trap(ar.kind)
      order by abs(ar.i % s - cx) + abs((ar.i / s) % s - cy) + abs(ar.i / (s*s) - cz)
      limit 1;
    radar := coalesce(radar, -1);
  elsif k = 'seisme' then
    -- 🌋 tous les blocs dans un rayon de 6 perdent la moitié de leurs points de vie
    with c as (
      select (cx + ox) + (cy + oy)*s + (cz + oz)*s*s as i
      from generate_series(-6, 6) ox, generate_series(-6, 6) oy, generate_series(-6, 6) oz
      where ox*ox + oy*oy + oz*oz <= 36
        and cx + ox between 0 and s - 1 and cy + oy between 0 and s - 1 and cz + oz between 0 and s - 1
    ), up as (
      insert into public.blocks as b (i, hp)
      select c.i, (g.max_hp / 2)::smallint from c
      where not (sealed and public._is_core(c.i, s)) and public._depth(c.i, s) >= g.peeled
      on conflict (i) do update set hp = (b.hp / 2)::smallint where b.hp > 0
      returning b.i, b.hp
    )
    select coalesce(array_agg(up.i) filter (where up.hp = 0), '{}'),
           coalesce(jsonb_agg(jsonb_build_array(up.i, up.hp)) filter (where up.hp > 0), '[]'::jsonb)
      into destroyed, damaged from up;
    rw := public._reward_set(destroyed, uid, mult, false);
  elsif k = 'sonde' then
    -- 🔍 butin caché dans un cube de 11×11×11 autour du point visé
    select coalesce(jsonb_agg(jsonb_build_array(q2.i, q2.l)), '[]'::jsonb) into probe from (
      select c.i, public._loot_at(c.i, s, g.seed, g.gold_every, g.mat_every, mult * (ev->>'or')::float8, mult * (ev->>'mat')::float8, g.mat_w, g.mat_shift) as l
      from (select (cx + ox) + (cy + oy)*s + (cz + oz)*s*s as i
            from generate_series(-5, 5) ox, generate_series(-5, 5) oy, generate_series(-5, 5) oz
            where cx + ox between 0 and s - 1 and cy + oy between 0 and s - 1 and cz + oz between 0 and s - 1) c
      where not exists (select 1 from public.blocks b where b.i = c.i and b.hp = 0) and public._depth(c.i, s) >= g.peeled
    ) q2 where q2.l is not null;
  elsif k = 'aimant' then
    update public.stats set magnet_until = greatest(coalesce(magnet_until, now()), now()) + interval '3 minutes' where player = uid;
  elsif k = 'marteau' then
    update public.stats set hammer_until = greatest(coalesce(hammer_until, now()), now()) + interval '45 seconds' where player = uid;
  elsif k = 'tornade' then
    update public.stats set tornado_until = greatest(coalesce(tornado_until, now()), now()) + interval '20 seconds' where player = uid;
  elsif k = 'trefle' then
    update public.stats set clover_until = greatest(coalesce(clover_until, now()), now()) + interval '5 minutes' where player = uid;
  elsif k = 'sablier' then
    -- ⏳ +60 s à tous tes effets en cours
    update public.stats set
      magnet_until  = case when magnet_until  > now() then magnet_until  + interval '60 seconds' else magnet_until end,
      hammer_until  = case when hammer_until  > now() then hammer_until  + interval '60 seconds' else hammer_until end,
      tornado_until = case when tornado_until > now() then tornado_until + interval '60 seconds' else tornado_until end,
      clover_until  = case when clover_until  > now() then clover_until  + interval '60 seconds' else clover_until end
    where player = uid and (magnet_until > now() or hammer_until > now() or tornado_until > now() or clover_until > now());
    if not found then raise exception 'Aucun effet en cours à prolonger (Marteau, Aimant, Trèfle ou Tornade)'; end if;
  elsif k = 'fontaine' then
    -- ⛲ 10 🪙 pour chaque joueur actif ces 5 dernières minutes (toi compris)
    for e in select st.player from public.stats st join public.profiles p on p.id = st.player
             where p.status = 'approved' and (st.last_seen > now() - interval '5 minutes' or st.seen_at > now() - interval '3 minutes' or st.player = uid) loop
      perform public._add(e.player, 'or', 10);
      perform public._bump(e.player, 10, 0, 0, 0, 0);
      q := q + 1;
    end loop;
    extra := jsonb_build_object('players', q, 'gold', 10);
  elsif k = 'cor' then
    update public.game set rally_until = greatest(coalesce(rally_until, now()), now()) + interval '60 seconds' where id = 1;
  elsif k = 'oeil' then
    update public.game set eye_until = greatest(coalesce(eye_until, now()), now()) + interval '5 minutes' where id = 1;
    select coalesce(jsonb_agg(a.i), '[]'::jsonb) into eye
      from (select ar.i from public.artifacts ar where ar.found_by is null and not public._is_trap(ar.kind) limit 3000) a;
  elsif k = 'ecorce' then
    -- 🧅 arrache toute la couche la plus extérieure qui reste (jamais le cœur)
    core_d := case when s % 2 = 0 then s/2 - 1 else (s-1)/2 - 1 end;   -- première couche du cœur
    if not sealed then raise exception 'Il ne reste plus que le cœur : l''Écorce du Monde ne peut pas l''arracher'; end if;
    if g.peel_at > now() - interval '6 hours' then
      raise exception 'L''Écorce du Monde se recharge : prochaine possible dans % min', ceil(extract(epoch from g.peel_at + interval '6 hours' - now()) / 60)::int;
    end if;
    select min(l.dp) into layer
      from generate_series(0, core_d - 1) as l(dp) left join public.layer_done dd on dd.d = l.dp
     where coalesce(dd.n, 0) < (s - 2*l.dp)::bigint ^ 3 - greatest(s - 2*l.dp - 2, 0)::bigint ^ 3;
    if layer is null then raise exception 'Plus aucune couche à arracher'; end if;
    -- plus besoin d'écrire chaque bloc : toute la couche (et celles au-dessus) est marquée « arrachée »
    npeel := ((s - 2*layer)::bigint ^ 3 - greatest(s - 2*layer - 2, 0)::bigint ^ 3)::int
              - coalesce((select n from public.layer_done where d = layer), 0)::int;
    update public.game gm set peeled = greatest(gm.peeled, layer + 1), peel_at = now() where gm.id = 1;
    -- ce que cachait la couche (artefacts, coffres, pièges) s'enfonce dans les couches plus profondes : rien n'est donné d'un coup
    perform public._relocate_deeper(layer, s);
    insert into public.layer_done as ld (d, n) values (layer, (s - 2*layer)::bigint ^ 3 - greatest(s - 2*layer - 2, 0)::bigint ^ 3)
      on conflict (d) do update set n = excluded.n;
    -- pas de butin bloc par bloc (l'économie exploserait) : une prime fixe à la place
    bonus := 50;
    perform public._add(uid, 'or', bonus);
    perform public._bump(uid, bonus, 0, 0, 0, 0);
  end if;

  if coalesce(array_length(cells, 1), 0) > 0 then
    rw := public._destroy_set(cells, uid, mult);
    destroyed := array(select jsonb_array_elements_text(rw->'d')::int);
  end if;
  if rw is not null then
    found_list := found_list || (select coalesce(jsonb_agg(jsonb_build_object('i', key::int, 'kind', value)), '[]'::jsonb) from jsonb_each_text(rw->'a'));
    chests := chests || (select coalesce(jsonb_agg(jsonb_build_object('i', key::int, 'got', value)), '[]'::jsonb) from jsonb_each_text(rw->'c'));
    loots := array(select jsonb_array_elements_text(rw->'loots'));
    traps := rw->'t';
    nf := nf + (rw->>'nf')::int;
  end if;

  nd := coalesce(array_length(destroyed, 1), 0);
  depths := array(select public._depth(z, s) from unnest(destroyed) z);
  -- (les blocs de l'Écorce ne comptent pas dans « blocs cassés » du classement)
  perform public._stats(uid, 0, nd, nf, 1, null, null, (select max(z) from unnest(depths) z));
  if k = 'ecorce' then update public.stats set peels = peels + 1 where player = uid; end if;
  msgs := public._missions_progress(uid, depths, loots, k);
  dl := public._daily_track(nd, depths, loots, jsonb_array_length(coalesce(chests, '[]'::jsonb)), 1, 0);
  if dl is not null then msgs := coalesce(msgs, '{}') || dl; end if;
  if nd + npeel > 0 then
    update public.game as gm set destroyed = gm.destroyed + nd + npeel, peel_total = gm.peel_total + npeel where gm.id = 1;   -- npeel = 0 sauf pour l'Écorce du Monde
    perform public._maybe_reveal(uid);
    wk := public._week_check();
    if wk is not null then msgs := coalesce(msgs, '{}') || wk; end if;
  end if;
  perform public._log(uid, 'use', jsonb_build_object('kind', k, 'n', nd + npeel));
  return json_build_object('destroyed', destroyed, 'found', found_list, 'loot', loots, 'radar', radar,
                           'damaged', damaged, 'probe', probe, 'eye', eye, 'traps', traps, 'extra', extra,
                           'layer', layer, 'peeled', npeel, 'bonus', bonus, 'chests', chests,
                           'fx', public._fx(uid), 'msgs', coalesce(msgs, '{}'),
                           'rally_left', (select greatest(0, extract(epoch from rally_until - now())) from public.game where id = 1));
end $$;

create or replace function public.get_inventory() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(kind, qty), '{}'::json)
  from public.inventory where player = auth.uid() and qty > 0;
$$;

-- Donner n'importe quel objet (artefact, matériau, or) à un autre joueur
create or replace function public.give_item(to_player uuid, k text, qty int default 1) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._check_item(k);
  if qty is null or qty < 1 or qty > 9999 then raise exception 'Quantité invalide'; end if;
  if to_player = auth.uid() then raise exception 'Tu ne peux pas te faire un cadeau à toi-même'; end if;
  if not exists (select 1 from public.profiles where id = to_player and status = 'approved') then
    raise exception 'Joueur inconnu';
  end if;
  perform public._take(auth.uid(), k, qty);
  perform public._add(to_player, k, qty);
end $$;

-- (ancienne version, gardée pour compatibilité)
create or replace function public.give_artifact(to_player uuid, k text) returns void
language sql security definer set search_path = public as $$
  select public.give_item(to_player, k, 1);
$$;

-- ----- Boutique et atelier -----
-- ⚖️ Régulation des artefacts puissants (version 15.8) : temps de recharge à l'utilisation, quota par jour à l'achat et à la fabrication.
--    game.art_rules = { "level": "off" | "modere" | "strict", "emerg": true/false (freinage d'urgence du pilote : passe en strict) }
alter table public.game add column if not exists art_rules jsonb not null default '{}'::jsonb;
alter table public.game add column if not exists peel_total bigint not null default 0;  -- blocs retirés par l'Écorce (exclus du calcul du rythme : ce ne sont pas des blocs minés)
create table if not exists public.art_use (player uuid not null references public.profiles(id) on delete cascade, kind text not null, at timestamptz not null default now(), primary key (player, kind));
create table if not exists public.art_get (player uuid not null references public.profiles(id) on delete cascade, day date not null, tier text not null, n int not null default 0, primary key (player, day, tier));
-- usage et acquisition par joueur et par jour (version 16.1) : « used » = utilisations, « got » = achetés + fabriqués
create table if not exists public.art_day (player uuid not null references public.profiles(id) on delete cascade, day date not null, tier text not null, used int not null default 0, got int not null default 0, primary key (player, day, tier));
alter table public.art_use enable row level security;
alter table public.art_get enable row level security;
alter table public.art_day enable row level security;
revoke all on public.art_use, public.art_get, public.art_day from anon, authenticated;
create or replace function public._art_tier(k text) returns text
language sql immutable as $$
  select case when k in ('ecorce', 'oeil') then 'legend'
              when k in ('megabombe', 'chaine', 'tornade', 'pilier') then 'tres'
              when k in ('seisme', 'vrille', 'grappe', 'givre', 'cor', 'marteau') then 'fort' end;
$$;
-- niveau « effectif » : le freinage d'urgence du pilote impose « strict » par-dessus le réglage choisi
create or replace function public._art_level() returns text
language sql stable security definer set search_path = public as $$
  -- le réglage personnalisé de l'organisateur reste toujours en place, même pendant un freinage d'urgence
  select case when coalesce((art_rules->>'emerg')::boolean, false) and coalesce(nullif(art_rules->>'level', ''), 'off') not in ('off', 'custom') then 'strict'
              else coalesce(nullif(art_rules->>'level', ''), 'off') end from public.game where id = 1;
$$;
-- Règle par niveau et par catégorie : { cd: recharge (s) par joueur, use_p: utilisations/joueur/jour, use_s: utilisations/serveur/jour, get: achetés+fabriqués/joueur/jour }
-- Pour use_p, use_s et get : 0 = pas de limite.
create or replace function public._art_rule(lvl text, tier text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when lvl = 'custom' then (
      select jsonb_build_object(
        'cd',    coalesce((c->>'cd')::int, 0), 'use_p', coalesce((c->>'use_p')::int, 0),
        'use_s', coalesce((c->>'use_s')::int, 0), 'get', coalesce((c->>'get')::int, 0))
      from (select art_rules->'custom'->tier c from public.game where id = 1) q)
    when lvl = 'modere' then case tier when 'fort' then '{"cd": 60, "use_p": 0, "use_s": 0, "get": 10}' when 'tres' then '{"cd": 300, "use_p": 0, "use_s": 0, "get": 3}' when 'legend' then '{"cd": 1800, "use_p": 0, "use_s": 0, "get": 1}' end::jsonb
    when lvl = 'strict' then case tier when 'fort' then '{"cd": 180, "use_p": 0, "use_s": 0, "get": 5}' when 'tres' then '{"cd": 900, "use_p": 3, "use_s": 8, "get": 1}' when 'legend' then '{"cd": 3600, "use_p": 1, "use_s": 3, "get": 1}' end::jsonb
  end;
$$;
create or replace function public._art_check_use(uid uuid, k text) returns void
language plpgsql security definer set search_path = public as $$
declare t text := public._art_tier(k); lvl text; r jsonb; last timestamptz; left_s int; cd int; up int; us int; mine int; svr int;
begin
  if t is null then return; end if;
  lvl := public._art_level(); if lvl = 'off' then return; end if;
  r := public._art_rule(lvl, t); if r is null then return; end if;
  cd := coalesce((r->>'cd')::int, 0); up := coalesce((r->>'use_p')::int, 0); us := coalesce((r->>'use_s')::int, 0);
  if cd > 0 then
    select at into last from public.art_use where player = uid and kind = k;
    if last is not null and last > now() - make_interval(secs => cd) then
      left_s := ceil(extract(epoch from last + make_interval(secs => cd) - now()))::int;
      if left_s >= 60 then raise exception 'Cet artefact se recharge : encore % min', ceil(left_s / 60.0)::int;
      else raise exception 'Cet artefact se recharge : encore % s', left_s; end if;
    end if;
  end if;
  if up > 0 then
    select coalesce(used, 0) into mine from public.art_day where player = uid and day = current_date and tier = t;
    if coalesce(mine, 0) >= up then raise exception 'Ta limite du jour pour ce niveau d''artefact est atteinte (% par jour)', up; end if;
  end if;
  if us > 0 then
    select coalesce(sum(used), 0) into svr from public.art_day where day = current_date and tier = t;
    if coalesce(svr, 0) >= us then raise exception 'Limite du serveur atteinte pour ce niveau d''artefact aujourd''hui (% par jour) : réessaie demain', us; end if;
  end if;
  insert into public.art_use (player, kind, at) values (uid, k, now()) on conflict (player, kind) do update set at = now();
  insert into public.art_day (player, day, tier, used) values (uid, current_date, t, 1)
    on conflict (player, day, tier) do update set used = public.art_day.used + 1;
  delete from public.art_day where day < current_date - 2;
end $$;
create or replace function public._art_check_get(uid uuid, k text, qty int) returns void
language plpgsql security definer set search_path = public as $$
declare t text := public._art_tier(k); lvl text; r jsonb; have int; cap int;
begin
  if t is null then return; end if;
  lvl := public._art_level(); if lvl = 'off' then return; end if;
  r := public._art_rule(lvl, t); if r is null then return; end if;
  cap := coalesce((r->>'get')::int, 0);
  if cap > 0 then
    select coalesce(got, 0) into have from public.art_day where player = uid and day = current_date and tier = t;
    if coalesce(have, 0) + qty > cap then
      raise exception 'Limite du jour atteinte : % par jour à l''achat et à l''atelier pour ce niveau, il en reste %', cap, greatest(0, cap - coalesce(have, 0));
    end if;
  end if;
  insert into public.art_day (player, day, tier, got) values (uid, current_date, t, qty)
    on conflict (player, day, tier) do update set got = public.art_day.got + qty;
  delete from public.art_day where day < current_date - 2;
end $$;
-- les réglages, pour l'organisateur (et les quotas restants pour un joueur)
create or replace function public.art_rules_state() returns json
language plpgsql stable security definer set search_path = public as $$
declare lvl text := public._art_level(); g record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select coalesce(nullif(art_rules->>'level', ''), 'off') lv, coalesce((art_rules->>'emerg')::boolean, false) em,
         coalesce((art_rules->>'emerg_x')::numeric, 3) ex, coalesce(art_rules->'custom', '{}'::jsonb) cu into g from public.game where id = 1;
  return json_build_object('level', g.lv, 'emerg', g.em, 'emerg_x', g.ex, 'effective', lvl, 'custom', g.cu,
    'rules', json_build_object('fort', public._art_rule(lvl, 'fort'), 'tres', public._art_rule(lvl, 'tres'), 'legend', public._art_rule(lvl, 'legend')),
    'today', (select coalesce(json_object_agg(tier, json_build_object('used', used, 'got', got)), '{}'::json) from public.art_day where player = auth.uid() and day = current_date),
    'server', (select coalesce(json_object_agg(tier, used_s), '{}'::json) from (select tier, sum(used)::int used_s from public.art_day where day = current_date group by tier) x));
end $$;
create or replace function public.admin_set_art_rules(p_level text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_level not in ('off', 'modere', 'strict', 'custom') then raise exception 'Niveau invalide'; end if;
  update public.game set art_rules = art_rules || jsonb_build_object('level', p_level) where id = 1;
  perform public._log(auth.uid(), 'art_rules', jsonb_build_object('level', p_level));
end $$;
-- réglage fin (fusion partielle : on ne touche qu'aux clés fournies) :
--   { level?, emerg_x?, custom?: { fort:{cd,use_p,use_s,get}, tres:{...}, legend:{...} } }
create or replace function public.admin_art_config(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare patch jsonb := '{}'::jsonb; cu jsonb := '{}'::jsonb; tier text; src jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p ? 'level' then
    if p->>'level' not in ('off', 'modere', 'strict', 'custom') then raise exception 'Niveau invalide'; end if;
    patch := patch || jsonb_build_object('level', p->>'level');
  end if;
  if p ? 'emerg_x' then
    patch := patch || jsonb_build_object('emerg_x', greatest(1.5, least(20, coalesce((p->>'emerg_x')::numeric, 3))));
  end if;
  if p ? 'custom' then
    foreach tier in array array['fort', 'tres', 'legend'] loop
      src := coalesce(p->'custom'->tier, '{}'::jsonb);
      cu := cu || jsonb_build_object(tier, jsonb_build_object(
        'cd',    greatest(0, least(86400, coalesce((src->>'cd')::int, 0))),
        'use_p', greatest(0, least(9999, coalesce((src->>'use_p')::int, 0))),
        'use_s', greatest(0, least(99999, coalesce((src->>'use_s')::int, 0))),
        'get',   greatest(0, least(9999, coalesce((src->>'get')::int, 0)))));
    end loop;
    patch := patch || jsonb_build_object('custom', cu);
  end if;
  update public.game set art_rules = art_rules || patch where id = 1;
  perform public._log(auth.uid(), 'art_config', patch);
end $$;

create or replace function public.shop_buy(p_kind text, p_qty int default 1) returns void
language plpgsql security definer set search_path = public as $$
declare pr int;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._check_kind(p_kind);
  if p_qty is null or p_qty < 1 or p_qty > 99 then raise exception 'Quantité invalide'; end if;
  if public._legendary(p_kind) then raise exception 'Les artefacts légendaires ne s''achètent pas'; end if;
  select price into pr from public.shop where kind = p_kind;
  if coalesce(pr, 0) <= 0 then raise exception 'Cet artefact n''est pas en vente'; end if;
  perform public._art_check_get(auth.uid(), p_kind, p_qty);
  perform public._take(auth.uid(), 'or', pr * p_qty);
  perform public._add(auth.uid(), p_kind, p_qty);
end $$;

create or replace function public.craft(p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare ing jsonb; e record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select ingredients into ing from public.recipes where result = p_kind and enabled;
  if ing is null then raise exception 'Pas de recette pour cet objet'; end if;
  perform public._art_check_get(auth.uid(), p_kind, 1);
  for e in select key, value::int as q from jsonb_each_text(ing) loop
    perform public._take(auth.uid(), e.key, e.q);
  end loop;
  perform public._add(auth.uid(), p_kind, 1);
  perform public._bump(auth.uid(), 0, 0, 1, 0, 0);
  perform public._log(auth.uid(), 'craft', jsonb_build_object('kind', p_kind));
end $$;

-- ----- Marché -----
create or replace function public.market_list() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select coalesce(json_agg(json_build_object(
      'id', m.id, 'seller', m.seller, 'pseudo', p.pseudo, 'give_kind', m.give_kind, 'give_qty', m.give_qty,
      'want_kind', m.want_kind, 'want_qty', m.want_qty, 'created_at', m.created_at) order by m.created_at desc), '[]'::json)
    from public.market m join public.profiles p on p.id = m.seller);
end $$;

create or replace function public.market_create(p_give text, p_give_qty int, p_want text, p_want_qty int) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._check_item(p_give); perform public._check_item(p_want);
  if p_give = p_want then raise exception 'Choisis deux objets différents'; end if;
  if p_give_qty < 1 or p_give_qty > 9999 or p_want_qty < 1 or p_want_qty > 9999 then raise exception 'Quantité invalide'; end if;
  if (select count(*) from public.market where seller = auth.uid()) >= 10 then
    raise exception 'Maximum 10 offres en même temps';
  end if;
  perform public._take(auth.uid(), p_give, p_give_qty);   -- mis de côté jusqu'à la vente
  insert into public.market (seller, give_kind, give_qty, want_kind, want_qty)
    values (auth.uid(), p_give, p_give_qty, p_want, p_want_qty) returning id into new_id;
  return new_id;
end $$;

create or replace function public.market_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from public.market where id = p_id for update;
  if not found then raise exception 'Offre introuvable'; end if;
  if o.seller <> auth.uid() and not public.is_admin() then raise exception 'Ce n''est pas ton offre'; end if;
  delete from public.market where id = p_id;
  perform public._add(o.seller, o.give_kind, o.give_qty);
end $$;

create or replace function public.market_accept(p_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into o from public.market where id = p_id for update;
  if not found then raise exception 'Offre déjà prise ou retirée'; end if;
  if o.seller = auth.uid() then raise exception 'C''est ta propre offre'; end if;
  perform public._take(auth.uid(), o.want_kind, o.want_qty);
  perform public._add(o.seller, o.want_kind, o.want_qty);
  perform public._add(auth.uid(), o.give_kind, o.give_qty);
  delete from public.market where id = p_id;
  perform public._bump(auth.uid(), 0, 0, 0, 1, 0);
  perform public._bump(o.seller, 0, 0, 0, 1, 0);
  perform public._log(auth.uid(), 'trade', jsonb_build_object('seller', (select pseudo from public.profiles where id = o.seller),
    'give', o.give_kind, 'give_qty', o.give_qty, 'want', o.want_kind, 'want_qty', o.want_qty));
  return json_build_object('seller', o.seller, 'give_kind', o.give_kind, 'give_qty', o.give_qty,
                           'want_kind', o.want_kind, 'want_qty', o.want_qty);
end $$;

-- ----- Missions -----
create or replace function public.get_missions() returns json
language plpgsql security definer set search_path = public as $$
declare sl int;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  for sl in 1 .. 3 loop
    if not exists (select 1 from public.missions where player = auth.uid() and slot = sl) then
      perform public._new_mission(auth.uid(), sl);
    end if;
  end loop;
  return (select json_agg(json_build_object('slot', slot, 'typ', typ, 'item', item, 'param', param,
            'target', target, 'progress', least(progress, target), 'reward', reward) order by slot)
          from public.missions where player = auth.uid());
end $$;

create or replace function public.deliver_mission(p_slot int) returns int
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into r from public.missions where player = auth.uid() and slot = p_slot and typ = 'livrer' for update;
  if not found then raise exception 'Mission introuvable'; end if;
  perform public._take(auth.uid(), r.item, r.target);
  perform public._add(auth.uid(), 'or', r.reward);
  perform public._bump(auth.uid(), r.reward, 0, 0, 0, 1);
  perform public._new_mission(auth.uid(), p_slot);
  return r.reward;
end $$;

create or replace function public.reroll_mission(p_slot int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if p_slot not between 1 and 3 then raise exception 'Mission introuvable'; end if;
  perform public._take(auth.uid(), 'or', 1);
  perform public._new_mission(auth.uid(), p_slot);
end $$;

create or replace function public.get_leaderboard()
returns table (id uuid, pseudo text, hits bigint, blocks bigint, artifacts_found int, artifacts_used int,
               best_break_ms int, best_cps int, deepest int, last_seen timestamptz,
               gold int, gold_found int, materials_found int, crafted int, trades int, missions_done int, peels int,
               week_blocks bigint, trophies int, chests int, best_combo int, avatar text, color text)
language sql stable security definer set search_path = public as $$
  select p.id, p.pseudo, coalesce(s.hits, 0), coalesce(s.blocks, 0), coalesce(s.artifacts_found, 0),
         coalesce(s.artifacts_used, 0), s.best_break_ms, coalesce(s.best_cps, 0), coalesce(s.deepest, 0), s.last_seen,
         coalesce((select iv.qty from public.inventory iv where iv.player = p.id and iv.kind = 'or'), 0),
         coalesce(s.gold_found, 0), coalesce(s.materials_found, 0), coalesce(s.crafted, 0),
         coalesce(s.trades, 0), coalesce(s.missions_done, 0), coalesce(s.peels, 0),
         coalesce(s.week_blocks, 0), coalesce(s.trophies, 0), coalesce(s.chests, 0), coalesce(s.best_combo, 0), p.avatar, p.color
  from public.profiles p left join public.stats s on s.player = p.id
  where p.status = 'approved' and public.is_approved()
  order by coalesce(s.blocks, 0) desc, coalesce(s.hits, 0) desc;
$$;

create or replace function public.get_treasure() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if public.is_admin() or (public.is_approved() and public.all_done()) then
    return (select json_build_object('kind', kind, 'message', message, 'image', image,
              'prize', prize, 'prize_rule', prize_rule, 'prize_visible', prize_visible,
              'winner', winner, 'winner_pseudo', winner_pseudo, 'won_prize', won_prize, 'prize_given', prize_given,
              'prize_podium', prize_podium, 'won_podium', won_podium, 'prize_global', prize_global)
            from public.treasure where id = 1);
  end if;
  return null;
end $$;


-- ---------------------------------------------------------------------
-- 5. FONCTIONS ADMIN
-- ---------------------------------------------------------------------
create or replace function public.set_treasure(k text, msg text, img text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if (select revealed_at from public.game where id = 1) is not null then
    raise exception 'Le trésor a déjà été révélé';
  end if;
  update public.treasure
     set kind = coalesce(k, 'noeud'), message = left(coalesce(msg, ''), 200),
         image = coalesce(img, ''), updated_at = now()
   where id = 1;
end $$;

drop function if exists public.admin_players();
create or replace function public.admin_players()
returns table (id uuid, pseudo text, email text, status text, is_admin boolean, created_at timestamptz,
               is_mod boolean, warnings int, chat_muted_until timestamptz, chat_banned boolean, shadow boolean,
               banned_until timestamptz, ban_reason text, rejected bigint, last_seen timestamptz, pseudo_locked boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._can_mod() then raise exception 'Réservé à l''administrateur'; end if;
  return query
    select p.id, p.pseudo, case when public.is_admin() then u.email::text else '' end, p.status, p.is_admin, p.created_at,
           p.is_mod, p.warnings, p.chat_muted_until, p.chat_banned, p.shadow, p.banned_until, p.ban_reason,
           coalesce(st.rejected, 0), st.last_seen, p.pseudo_locked
    from public.profiles p join auth.users u on u.id = p.id left join public.stats st on st.player = p.id
    order by p.created_at desc;
end $$;

create or replace function public.admin_set_status(p uuid, s text) returns void
language plpgsql security definer set search_path = public as $$
declare mx int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if s not in ('pending', 'approved', 'refused') then raise exception 'Statut inconnu'; end if;
  if p = auth.uid() then raise exception 'Tu ne peux pas changer ton propre statut'; end if;
  if s = 'approved' and exists (select 1 from public.profiles where id = p and status <> 'approved') then
    select max_players into mx from public.game where id = 1;
    if mx > 0 and (select count(*) from public.profiles where status = 'approved' and not is_admin) >= mx then
      raise exception 'Limite atteinte : % joueurs maximum (augmente-la dans 👑 ou retire un joueur)', mx;
    end if;
  end if;
  update public.profiles set status = s, approved_at = case when s = 'approved' then coalesce(approved_at, now()) else approved_at end
   where profiles.id = p;
  perform public._log(p, 'status', jsonb_build_object('status', s));
end $$;

-- Valider ou refuser plusieurs inscriptions d'un coup (dans l'ordre d'arrivée).
-- Renvoie { done, skipped } : skipped = laissés en attente car la limite de joueurs est atteinte.
create or replace function public.admin_set_status_many(ids uuid[], s text) returns json
language plpgsql security definer set search_path = public as $$
declare mx int; n int; done int := 0; skipped int := 0; r record;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if s not in ('pending', 'approved', 'refused') then raise exception 'Statut inconnu'; end if;
  select max_players into mx from public.game where id = 1;
  select count(*) into n from public.profiles where status = 'approved' and not is_admin;
  for r in select id, status from public.profiles
           where id = any(coalesce(ids, '{}')) and id <> auth.uid() and not is_admin and status <> s
           order by created_at loop
    if s = 'approved' and mx > 0 and n >= mx then skipped := skipped + 1; continue; end if;
    update public.profiles set status = s, approved_at = case when s = 'approved' then coalesce(approved_at, now()) else approved_at end
     where id = r.id;
    perform public._log(r.id, 'status', jsonb_build_object('status', s));
    if s = 'approved' then n := n + 1; elsif r.status = 'approved' then n := n - 1; end if;
    done := done + 1;
  end loop;
  return json_build_object('done', done, 'skipped', skipped);
end $$;

-- Réglages d'accès + compteurs (panneau 👑)
create or replace function public.admin_limits() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  return (select json_build_object(
    'signups_open', g.signups_open, 'auto_approve', g.auto_approve, 'max_players', g.max_players, 'max_online', g.max_online,
    'approved', (select count(*) from public.profiles where status = 'approved' and not is_admin),
    'pending',  (select count(*) from public.profiles where status = 'pending'),
    'refused',  (select count(*) from public.profiles where status = 'refused'),
    'active_24h', (select count(*) from public.stats where last_seen > now() - interval '24 hours'))
    from public.game g where g.id = 1);
end $$;

create or replace function public.admin_set_limits(p_signups_open boolean, p_auto_approve boolean, p_max_players int, p_max_online int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if coalesce(p_max_players, 0) < 0 or coalesce(p_max_players, 0) > 100000 or coalesce(p_max_online, 0) < 0 or coalesce(p_max_online, 0) > 100000 then
    raise exception 'Quantité invalide';
  end if;
  update public.game set signups_open = coalesce(p_signups_open, true), auto_approve = coalesce(p_auto_approve, false),
         max_players = coalesce(p_max_players, 0), max_online = coalesce(p_max_online, 0) where id = 1;
end $$;

-- Nombre d'inscriptions en attente (pastille sur 👑)
create or replace function public.admin_pending_count() returns int
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then (select count(*)::int from public.profiles where status = 'pending') else 0 end;
$$;

-- Règles : clics par bloc, rareté de l'or et des matériaux (modifiables à tout moment)
create or replace function public.admin_set_config(p_max_hp int, p_gold_every int, p_mat_every int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_max_hp < 1 or p_max_hp > 100 then raise exception 'Clics par bloc : entre 1 et 100'; end if;
  if p_gold_every < 0 or p_gold_every > 1000000 or p_mat_every < 0 or p_mat_every > 1000000 then
    raise exception 'Rareté invalide';
  end if;
  update public.game set max_hp = p_max_hp, gold_every = p_gold_every, mat_every = p_mat_every where id = 1;
  perform public._log(auth.uid(), 'rules', jsonb_build_object('max_hp', p_max_hp, 'gold_every', p_gold_every, 'mat_every', p_mat_every));
  -- un bloc entamé ne peut pas avoir plus de PV que le nouveau maximum
  update public.blocks set hp = p_max_hp where hp > p_max_hp;
end $$;

-- ----- Recettes de l'atelier (version 9) : modifier, activer ou désactiver, revenir à l'origine -----
create or replace function public._default_recipes() returns table (result text, ingredients jsonb)
language sql immutable as $$
  values ('radar', '{"silex": 4, "fer": 1}'::jsonb), ('marteau', '{"fer": 4, "or": 3}'), ('bombe', '{"poudre": 3, "fer": 2}'),
    ('foreuse', '{"cristal": 2, "fer": 3}'), ('megabombe', '{"bombe": 3, "cristal": 3}'), ('scie', '{"fer": 3, "silex": 2}'),
    ('seisme', '{"poudre": 3, "cristal": 1}'), ('aimant', '{"fer": 4, "cristal": 1}'), ('cor', '{"or": 2, "cristal": 2, "fer": 2}'),
    ('sonde', '{"silex": 3, "fer": 1}'), ('ecorce', '{"megabombe": 2, "cristal": 10, "or": 100}'), ('oeil', '{"radar": 3, "cristal": 5, "or": 50}'),
    ('dynamite', '{"poudre": 4, "silex": 2}'), ('trefle', '{"silex": 4, "fer": 1, "cristal": 1}'), ('sablier', '{"silex": 3, "cristal": 2}'),
    ('fontaine', '{"or": 15, "fer": 2}'), ('vrille', '{"foreuse": 1, "fer": 4, "cristal": 1}'), ('grappe', '{"bombe": 2, "poudre": 3}'),
    ('givre', '{"cristal": 3, "poudre": 1}'), ('chaine', '{"cristal": 4, "poudre": 4, "fer": 4}'), ('tornade', '{"marteau": 2, "cristal": 4}'),
    ('pilier', '{"vrille": 2, "cristal": 5}')
$$;
create or replace function public.admin_recipes() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  return json_build_object(
    'recipes', (select coalesce(json_object_agg(r.result, json_build_object('ingredients', r.ingredients, 'enabled', r.enabled)), '{}'::json) from public.recipes r),
    'defaults', (select coalesce(json_object_agg(d.result, d.ingredients), '{}'::json) from public._default_recipes() d),
    'mat_w', (select mat_w from public.game where id = 1));
end $$;
-- p_ing : {"cristal": 3, "or": 10, …} (1 à 6 ingrédients) ; null = garder ; p_enabled : fabricable ou non ; p_reset = recette d'origine
create or replace function public.admin_set_recipe(p_kind text, p_ing jsonb default null, p_enabled boolean default null, p_reset boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare e record; n int := 0; clean jsonb := '{}';
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  perform public._check_kind(p_kind);
  if p_reset then
    select d.ingredients into clean from public._default_recipes() d where d.result = p_kind;
    insert into public.recipes (result, ingredients, enabled) values (p_kind, clean, true)
      on conflict (result) do update set ingredients = excluded.ingredients, enabled = true;
    return;
  end if;
  if p_ing is not null then
    for e in select key, value from jsonb_each(p_ing) loop
      perform public._check_item(e.key);
      if e.key = p_kind then raise exception 'Une recette ne peut pas demander l''objet qu''elle fabrique'; end if;
      if jsonb_typeof(e.value) <> 'number' or (e.value)::text::numeric < 0 or (e.value)::text::numeric > 100000 then raise exception 'Quantité invalide'; end if;
      if (e.value)::text::int > 0 then clean := clean || jsonb_build_object(e.key, (e.value)::text::int); n := n + 1; end if;
    end loop;
    if n = 0 then raise exception 'Une recette doit demander au moins un ingrédient'; end if;
    if n > 6 then raise exception 'Six ingrédients au maximum'; end if;
    insert into public.recipes (result, ingredients, enabled) values (p_kind, clean, coalesce(p_enabled, true))
      on conflict (result) do update set ingredients = excluded.ingredients, enabled = coalesce(p_enabled, public.recipes.enabled);
  elsif p_enabled is not null then
    update public.recipes set enabled = p_enabled where result = p_kind;
    if not found then raise exception 'Pas de recette pour cet objet'; end if;
  end if;
end $$;
-- Quantité de chaque matériau : {"silex": 1, "fer": 1, "poudre": 1, "cristal": 2} (0 = jamais, jusqu'à ×5)
create or replace function public.admin_set_materials(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare o jsonb := '{}'; k text;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  foreach k in array array['silex', 'fer', 'poudre', 'cristal'] loop
    o := o || jsonb_build_object(k, least(greatest(coalesce((p->>k)::numeric, 1), 0), 5));
  end loop;
  update public.game set mat_w = o where id = 1;
  perform public._log(auth.uid(), 'materials', o);
end $$;

create or replace function public.admin_set_price(p_kind text, p_price int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  perform public._check_kind(p_kind);
  if p_price < 0 or p_price > 1000000 then raise exception 'Prix invalide'; end if;
  if public._legendary(p_kind) and p_price > 0 then raise exception 'Les artefacts légendaires ne se vendent pas'; end if;
  insert into public.shop (kind, price) values (p_kind, p_price)
    on conflict (kind) do update set price = excluded.price;
end $$;

create or replace function public.admin_new_cube(new_size int) returns void
language plpgsql security definer set search_path = public as $$
declare t record; e record; sn int; ended boolean := false; gl jsonb := '[]'::jsonb; gz record; e3 record; gg jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if new_size < 10 or new_size > 256 then raise exception 'Taille entre 10 et 256'; end if;
  perform public._hall_save();            -- 🏛️ souvenir du cube terminé
  -- 🏆 fin de la saison : médaille pour les 3 meilleurs casseurs, une saison de plus pour chaque joueur, lots du trésor comptés
  select season into sn from public.game where id = 1;
  if (select destroyed from public.game where id = 1) > 0 then
    update public.profiles p set medals = p.medals || jsonb_build_array(jsonb_build_object('s', sn, 'r', x.rk))
      from (select st.player, row_number() over (order by st.blocks desc, st.hits desc)::int as rk
            from public.stats st join public.profiles pp on pp.id = st.player
            where st.blocks > 0 and pp.status = 'approved' order by st.blocks desc, st.hits desc limit 3) x
      where p.id = x.player;
    update public.profiles p set seasons = p.seasons + 1 from public.stats st where st.player = p.id and st.blocks > 0;
    update public.profiles p set combo_best = st.best_combo from public.stats st where st.player = p.id and st.best_combo > p.combo_best;
    update public.profiles p set treasures = p.treasures + 1 from public.treasure tr where tr.id = 1 and tr.winner = p.id;
    update public.game set season = season + 1 where id = 1;
    ended := true;
    perform public._log(null, 'season_end', jsonb_build_object('season', sn));
  end if;
  delete from public.duels where status in ('open', 'live');    -- (les mises sont rendues avec les sacs vidés)
  delete from public.auctions;            -- les enchères en cours disparaissent avec les sacs
  update public.game set daily_day = null, daily_progress = 0, daily_done = false where id = 1;   -- nouveau défi du jour adapté au nouveau cube
  update public.profiles p set xp_bank = p.xp_bank + public._xp(s) from public.stats s where s.player = p.id;   -- ⭐ l'expérience est gardée
  update public.profiles p set blocks_bank = p.blocks_bank + s.blocks from public.stats s where s.player = p.id;  -- 🌍 et les blocs aussi
  -- 🌍 top 3 du classement global (toutes saisons) à la fin de cette saison
  if ended then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'pseudo', x.pseudo, 'rank', x.rk) order by x.rk), '[]'::jsonb) into gl
      from (select p.id, p.pseudo, row_number() over (order by p.blocks_bank desc, p.xp_bank desc)::int as rk
            from public.profiles p where p.status = 'approved' and p.blocks_bank > 0 order by p.blocks_bank desc, p.xp_bank desc limit 3) x;
  end if;
  truncate public.blocks;
  delete from public.artifacts;
  delete from public.inventory;
  delete from public.stats;
  delete from public.market;
  delete from public.missions;
  -- (le salon est conservé : on le vide séparément si on veut)
  truncate public.chests;
  truncate public.layer_done;
  -- le gagnant du cube précédent reçoit son lot dans son sac tout neuf
  select * into t from public.treasure where id = 1;
  update public.game set prize_note = '', prize_note_at = null, podium_note = '[]'::jsonb, global_note = '[]'::jsonb where id = 1;
  -- 🌍 récompenses du classement global (dans le sac tout neuf) + médaille gardée pour toujours
  for gz in select x.value as v from jsonb_array_elements(gl) x loop
    for e3 in select key, value::int as q from jsonb_each_text(coalesce(t.prize_global -> ((gz.v->>'rank')::int - 1), '{}'::jsonb)) loop
      if e3.q > 0 then perform public._add((gz.v->>'id')::uuid, e3.key, e3.q); end if;
    end loop;
    update public.profiles set medals = medals || jsonb_build_array(jsonb_build_object('s', sn, 'g', (gz.v->>'rank')::int)) where id = (gz.v->>'id')::uuid;
    gg := gg || jsonb_build_array(gz.v || jsonb_build_object('prize', coalesce(t.prize_global -> ((gz.v->>'rank')::int - 1), '{}'::jsonb)));
    perform public._log((gz.v->>'id')::uuid, 'global_given', jsonb_build_object('rank', gz.v->'rank'));
  end loop;
  if jsonb_array_length(gg) > 0 then update public.game set global_note = gg, prize_note_at = now() where id = 1; end if;
  -- 🥈 récompenses du classement
  if t.won_podium is not null and jsonb_array_length(t.won_podium) > 0 then
    declare pz record; e2 record; given jsonb := '[]'::jsonb;
    begin
      for pz in select x.value as v from jsonb_array_elements(t.won_podium) x loop
        continue when not exists (select 1 from public.profiles where id = (pz.v->>'id')::uuid) or coalesce(pz.v->'prize', '{}'::jsonb) = '{}'::jsonb;
        for e2 in select key, value::int as q from jsonb_each_text(pz.v->'prize') loop
          if e2.q > 0 then perform public._add((pz.v->>'id')::uuid, e2.key, e2.q); end if;
        end loop;
        given := given || jsonb_build_array(pz.v);
        perform public._log((pz.v->>'id')::uuid, 'podium_given', jsonb_build_object('rank', pz.v->'rank', 'prize', pz.v->'prize'));
      end loop;
      if jsonb_array_length(given) > 0 then update public.game set podium_note = given, prize_note_at = now() where id = 1; end if;
    end;
  end if;
  if t.winner is not null and not t.prize_given and t.won_prize is not null and t.won_prize <> '{}'::jsonb
     and exists (select 1 from public.profiles where id = t.winner) then
    for e in select key, value::int as q from jsonb_each_text(t.won_prize) loop
      if e.q > 0 then perform public._add(t.winner, e.key, e.q); end if;
    end loop;
    update public.game set prize_note = t.winner_pseudo || '|' || t.won_prize::text, prize_note_at = now() where id = 1;
    perform public._log(t.winner, 'prize_given', jsonb_build_object('prize', t.won_prize));
  end if;
  update public.treasure set winner = null, winner_pseudo = null, won_prize = null, prize_given = false, won_podium = null where id = 1;
  update public.game set size = new_size, started_at = now(), revealed_at = null, destroyed = 0, peeled = 0, peel_total = 0,
         rally_until = null, eye_until = null, arts_v4 = true, chests_v6 = true,
         week_base = 0, week_done = false, event_until = null,
         seed = floor(random() * 2000000000)::int where id = 1;
  update public.game set arts_v8 = true where id = 1;
  perform public._regen(new_size);                -- artefacts, pièges et coffres répartis selon la taille du cube
  perform public._log(auth.uid(), 'new_cube', jsonb_build_object('size', new_size));
end $$;

create or replace function public.admin_artifacts() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  return json_build_object(
    'kinds', (select coalesce(json_object_agg(t.kind, json_build_object('hidden', t.n_hidden, 'found', t.n_found)), '{}'::json)
              from (select a.kind, count(*) filter (where a.found_by is null) as n_hidden,
                           count(*) filter (where a.found_by is not null) as n_found
                    from public.artifacts a group by a.kind) t),
    'inventories', (select coalesce(json_agg(json_build_object('id', p.id, 'pseudo', p.pseudo, 'kind', iv.kind, 'qty', iv.qty)
                                             order by p.pseudo, iv.kind), '[]'::json)
                    from public.inventory iv join public.profiles p on p.id = iv.player where iv.qty > 0),
    'chests', (select json_build_object('hidden', count(*) filter (where opened_by is null and not trap),
                                        'fake', count(*) filter (where opened_by is null and trap),
                                        'opened', count(*) filter (where opened_by is not null)) from public.chests),
    'traps_on', (select traps_on from public.game where id = 1)
  );
end $$;

create or replace function public.admin_add_artifacts(k text, cnt int, min_layer int default 0, max_layer int default 999)
returns int language plpgsql security definer set search_path = public as $$
declare s int; lo int; hi int; added int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if not (k = any(public._arts() || public._traps() || array['coffre', 'faux_coffre'])) then raise exception 'Type d''artefact inconnu'; end if;
  if cnt is null or cnt < 1 or cnt > 500 then raise exception 'Quantité entre 1 et 500'; end if;
  select size into s from public.game where id = 1;
  if k in ('coffre', 'faux_coffre') then
    return public._place(k, cnt, greatest(coalesce(min_layer, 0), 0), least(coalesce(max_layer, 999), (s - 1) / 2), case when k = 'coffre' then 'chest' else 'fake' end);
  end if;
  min_layer := greatest(coalesce(min_layer, 0), 0, (select peeled from public.game where id = 1));
  max_layer := least(coalesce(max_layer, 999), (s - 1) / 2);
  if min_layer > max_layer then raise exception 'Couches invalides'; end if;
  lo := min_layer; hi := s - 1 - min_layer;
  with cand as (
    select distinct (lo + floor(random() * (hi - lo + 1))::int)
                  + (lo + floor(random() * (hi - lo + 1))::int) * s
                  + (lo + floor(random() * (hi - lo + 1))::int) * s * s as cell
    from generate_series(1, cnt * 80)
  )
  insert into public.artifacts (i, kind)
  select cand.cell, k from cand
  left join public.blocks b on b.i = cand.cell
  where coalesce(b.hp, 1) > 0
    and public._depth(cand.cell, s) <= max_layer
    and not exists (select 1 from public.artifacts a where a.i = cand.cell)
  order by random()
  limit cnt
  on conflict (i) do nothing;
  get diagnostics added = row_count;
  return added;
end $$;

create or replace function public.admin_remove_artifacts(k text, cnt int default null)
returns int language plpgsql security definer set search_path = public as $$
declare removed int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if not (k = any(public._arts() || public._traps() || array['coffre', 'faux_coffre'])) then raise exception 'Type d''artefact inconnu'; end if;
  if k in ('coffre', 'faux_coffre') then
    delete from public.chests where i in (
      select i from public.chests where opened_by is null and trap = (k = 'faux_coffre') order by random() limit cnt);
    get diagnostics removed = row_count;
    return removed;
  end if;
  delete from public.artifacts where i in (
    select i from public.artifacts where kind = k and found_by is null order by random() limit cnt
  );
  get diagnostics removed = row_count;
  return removed;
end $$;

-- Donner (delta > 0) ou reprendre (delta < 0) n'importe quel objet à un joueur
create or replace function public.admin_set_inventory(p uuid, k text, delta int)
returns int language plpgsql security definer set search_path = public as $$
declare q int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  perform public._check_item(k);
  if not exists (select 1 from public.profiles where id = p) then raise exception 'Joueur inconnu'; end if;
  insert into public.inventory as inv (player, kind, qty) values (p, k, greatest(coalesce(delta, 0), 0))
    on conflict (player, kind) do update set qty = greatest(inv.qty + coalesce(delta, 0), 0)
    returning qty into q;
  return q;
end $$;

-- ----- Profil, semaine, événements, annonce, journal (version 6) -----
create or replace function public.set_profile(p_avatar text, p_color text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if char_length(coalesce(p_avatar, '')) > 16 then raise exception 'Avatar invalide'; end if;
  if coalesce(p_color, '') <> '' and p_color !~ '^#[0-9a-fA-F]{6}$' then
    if p_color like 'fxc:%' then                            -- 👑 effet créé sur mesure par l'organisateur
      if not public.is_admin() then raise exception 'Effet pas encore débloqué'; end if;
      if p_color !~ '^fxc:(move|wave|pulse|flash|still|neon):[0-2]:[1-3]:[0-9a-f]{6}(-[0-9a-f]{6}){1,4}$' then raise exception 'Couleur invalide'; end if;
    else
      if not exists (select 1 from public._style_table() t where t.id = p_color and t.id like 'fx:%') then raise exception 'Couleur invalide'; end if;
      if not public.is_admin() and not public._style_ok(auth.uid(), p_color) then raise exception 'Effet pas encore débloqué'; end if;
    end if;
  end if;
  update public.profiles set avatar = coalesce(p_avatar, ''), color = coalesce(p_color, '') where id = auth.uid();
end $$;

create or replace function public.admin_set_week(p_goal int, p_reward int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if coalesce(p_goal, 0) < 0 or coalesce(p_reward, 0) < 0 or p_reward > 100000 then raise exception 'Quantité invalide'; end if;
  update public.game set week_goal = coalesce(p_goal, 0), week_reward = coalesce(p_reward, 30) where id = 1;
end $$;

create or replace function public.admin_set_events(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.game set events_on = coalesce(p_on, true) where id = 1;
end $$;

-- Lancer un événement tout de suite pendant N minutes (0 = arrêter).
-- (ancienne version : 'or' = heure dorée, 'mat' = heure des artisans)
create or replace function public.admin_start_event(p_kind text, p_minutes int) returns json
language plpgsql security definer set search_path = public as $$
declare eid int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  select id into eid from public.events where builtin = p_kind order by id limit 1;
  return public.admin_event_start(coalesce(eid, -1), p_minutes);
end $$;

-- ----- Événements composés (version 8) -----
create or replace function public.admin_events() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  return json_build_object(
    'list', (select coalesce(json_agg(json_build_object('id', e.id, 'name', e.name, 'icon', e.icon, 'message', e.message, 'mult', e.mult,
              'minutes', e.minutes, 'sched', e.sched, 'at', e.at, 'dow', e.dow, 'hh', e.hh, 'mi', e.mi, 'hh_to', e.hh_to, 'enabled', e.enabled, 'builtin', e.builtin)
              order by e.id), '[]'::json) from public.events e),
    'active', public._event_info(), 'events_on', (select events_on from public.game where id = 1),
    'manual', (select case when event_until > now() then json_build_object('id', event_id, 'until', event_until) end from public.game where id = 1));
end $$;

-- Créer (id absent) ou modifier un événement. p : {id, name, icon, message, mult, minutes, sched, at, dow, hh, mi, enabled}
create or replace function public.admin_event_save(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare eid int := nullif(p->>'id', '')::int; m jsonb := '{}'; e record; v numeric; sch text := coalesce(p->>'sched', 'none');
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if char_length(trim(coalesce(p->>'name', ''))) < 1 then raise exception 'Donne un nom à l''événement'; end if;
  if sch not in ('none', 'once', 'daily', 'weekly', 'random') then raise exception 'Programmation invalide'; end if;
  if sch = 'random' and coalesce((p->>'hh_to')::int, 22) <= coalesce((p->>'hh')::int, 10) then raise exception 'L''heure de fin doit être après l''heure de début'; end if;
  for e in select key, value from jsonb_each(coalesce(p->'mult', '{}'::jsonb)) loop
    continue when e.key not in ('or', 'mat', 'force', 'art', 'coffre');
    v := least(greatest(coalesce((e.value #>> '{}')::numeric, 1), 1), case when e.key = 'force' then 3 else 5 end);
    if v > 1 then m := m || jsonb_build_object(e.key, v); end if;
  end loop;
  if m = '{}'::jsonb then raise exception 'Choisis au moins un bonus pour l''événement'; end if;
  if coalesce((p->>'minutes')::int, 0) not between 1 and 1440 then raise exception 'Durée entre 1 et 1440 minutes'; end if;
  if sch = 'once' and (p->>'at') is null then raise exception 'Choisis la date de l''événement'; end if;
  if eid is null then
    insert into public.events (name, icon, message, mult, minutes, sched, at, dow, hh, mi, hh_to, enabled)
    values (left(trim(p->>'name'), 40), left(coalesce(nullif(p->>'icon', ''), '🌟'), 8), left(coalesce(p->>'message', ''), 200), m,
            (p->>'minutes')::int, sch, (p->>'at')::timestamptz, (p->>'dow')::int, (p->>'hh')::int, (p->>'mi')::int,
            least(greatest(coalesce((p->>'hh_to')::int, 22), 1), 24), coalesce((p->>'enabled')::boolean, true))
    returning id into eid;
  else
    update public.events set name = left(trim(p->>'name'), 40), icon = left(coalesce(nullif(p->>'icon', ''), '🌟'), 8),
      message = left(coalesce(p->>'message', ''), 200), mult = m, minutes = (p->>'minutes')::int, sched = sch,
      at = (p->>'at')::timestamptz, dow = (p->>'dow')::int, hh = (p->>'hh')::int, mi = (p->>'mi')::int,
      hh_to = least(greatest(coalesce((p->>'hh_to')::int, 22), 1), 24), enabled = coalesce((p->>'enabled')::boolean, true)
    where id = eid;
    if not found then raise exception 'Événement introuvable'; end if;
  end if;
  return eid;
end $$;

create or replace function public.admin_event_delete(p_id int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  delete from public.events where id = p_id;
  update public.game set event_id = null, event_until = null where id = 1 and event_id = p_id;
end $$;

-- Lancer un événement maintenant pendant N minutes (0 = arrêter l'événement lancé à la main)
create or replace function public.admin_event_start(p_id int, p_minutes int) returns json
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if coalesce(p_minutes, 0) <= 0 then
    update public.game set event_id = null, event_until = null, event_kind = null where id = 1;
    return public._event_info();
  end if;
  if p_minutes > 1440 then raise exception 'Durée entre 1 et 1440 minutes'; end if;
  select * into e from public.events where id = p_id;
  if not found then raise exception 'Événement introuvable'; end if;
  update public.game set event_id = p_id, event_until = now() + make_interval(mins => p_minutes) where id = 1;
  perform public._log(auth.uid(), 'event', jsonb_build_object('name', e.name, 'minutes', p_minutes, 'kind', e.builtin));
  return public._event_info();
end $$;

create or replace function public.admin_set_announce(p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.game set announce = left(trim(coalesce(p_text, '')), 300),
    announce_at = case when trim(coalesce(p_text, '')) = '' then null else now() end where id = 1;
end $$;

-- Lot du trésor : {"kind": quantité, ...}, règle du gagnant, visible ou secret
create or replace function public._check_prize(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare e record; n int := 0;
begin
  if jsonb_typeof(coalesce(p, '{}'::jsonb)) <> 'object' then raise exception 'Lot invalide'; end if;
  for e in select key, value from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    perform public._check_item(e.key);
    if jsonb_typeof(e.value) <> 'number' or (e.value)::text::int < 1 or (e.value)::text::int > 100000 then raise exception 'Quantité invalide'; end if;
    n := n + 1;
  end loop;
  if n > 30 then raise exception 'Lot invalide'; end if;
end $$;
drop function if exists public.admin_set_prize(jsonb, text, boolean);
create or replace function public.admin_set_prize(p_prize jsonb, p_rule text, p_visible boolean, p_podium jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_rule not in ('last', 'top') then raise exception 'Règle inconnue'; end if;
  perform public._check_prize(p_prize);
  if p_podium is not null then
    if jsonb_typeof(p_podium) <> 'array' or jsonb_array_length(p_podium) <> 2 then raise exception 'Lot invalide'; end if;
    perform public._check_prize(p_podium -> 0); perform public._check_prize(p_podium -> 1);
  end if;
  update public.treasure set prize = coalesce(p_prize, '{}'::jsonb), prize_rule = p_rule, prize_visible = coalesce(p_visible, true),
    prize_podium = coalesce(p_podium, prize_podium) where id = 1;
end $$;

-- Classement de la semaine (blocs cassés depuis lundi)
create or replace function public.week_board() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._week_roll();
  return (select coalesce(json_agg(json_build_object('id', p.id, 'pseudo', p.pseudo, 'avatar', p.avatar, 'color', p.color,
            'blocks', st.week_blocks, 'trophies', st.trophies) order by st.week_blocks desc), '[]'::json)
          from public.stats st join public.profiles p on p.id = st.player
          where p.status = 'approved' and st.week_blocks > 0);
end $$;

-- Journal d'activité (admin)
create or replace function public.admin_activity(lim int default 150) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  return (select coalesce(json_agg(json_build_object('id', a.id, 'at', a.at, 'pseudo', p.pseudo, 'kind', a.kind, 'detail', a.detail) order by a.id desc), '[]'::json)
          from (select * from public.activity order by id desc limit least(greatest(coalesce(lim, 150), 1), 500)) a
          left join public.profiles p on p.id = a.player);
end $$;


-- ---------------------------------------------------------------------
-- 5 bis. SALON DE DISCUSSION ET ESPACE DISQUE
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- 5 ter. VERSION 10 : défis du jour, enchères, messages privés, réactions,
--        hall of fame, thèmes, notifications sur le téléphone
-- ---------------------------------------------------------------------
alter table public.game add column if not exists daily_on       boolean not null default true;
alter table public.game add column if not exists daily_day      date;
alter table public.game add column if not exists daily_kind     text;
alter table public.game add column if not exists daily_target   int not null default 0;
alter table public.game add column if not exists daily_progress int not null default 0;
alter table public.game add column if not exists daily_reward   int not null default 20;
alter table public.game add column if not exists daily_done     boolean not null default false;
alter table public.game add column if not exists daily_salt     int not null default 0;
alter table public.game add column if not exists theme          text not null default 'classique';

create table if not exists public.auctions (
  id bigserial primary key, seller uuid not null references public.profiles(id) on delete cascade,
  kind text not null, qty int not null, min_bid int not null, bid int not null default 0,
  bidder uuid references public.profiles(id) on delete set null, ends_at timestamptz not null,
  status text not null default 'open', created_at timestamptz not null default now());
create index if not exists auctions_status on public.auctions (status, ends_at);
create table if not exists public.pm (
  id bigserial primary key, sender uuid references public.profiles(id) on delete cascade,
  recipient uuid references public.profiles(id) on delete cascade, body text not null check (char_length(body) between 1 and 500),
  at timestamptz not null default now(), read_at timestamptz, hidden boolean not null default false, flagged text);
create index if not exists pm_pair on public.pm (recipient, sender, id);
create index if not exists pm_sender on public.pm (sender, id);
create table if not exists public.chat_reactions (
  msg bigint not null references public.chat(id) on delete cascade, player uuid not null references public.profiles(id) on delete cascade,
  emoji text not null, primary key (msg, player, emoji));
create table if not exists public.hall (
  id serial primary key, size int, started_at timestamptz, ended_at timestamptz not null default now(),
  destroyed bigint, total bigint, revealed boolean, winner text, treasure text, theme text, players int,
  top jsonb not null default '[]'::jsonb, records jsonb not null default '{}'::jsonb);
create table if not exists public.push_subs (
  endpoint text primary key, player uuid not null references public.profiles(id) on delete cascade,
  keys jsonb not null, lang text not null default 'fr', created_at timestamptz not null default now());
alter table public.auctions enable row level security;
alter table public.pm enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.hall enable row level security;
alter table public.push_subs enable row level security;

-- ----- 🎯 Défi du jour (un défi commun, nouveau chaque jour à minuit, heure de Paris) -----
-- Type de couche spéciale d'une profondeur (comme dans le dessin du jeu) : glace, lave, cristal ou null
create or replace function public._layer_type(d int, s int) returns text
language sql immutable as $$
  select case when d <= 0 then null
    when d::float8 / greatest(1, (s - 1) / 2) > 0.28 and d::float8 / greatest(1, (s - 1) / 2) < 0.34 then 'glace'
    when d::float8 / greatest(1, (s - 1) / 2) > 0.53 and d::float8 / greatest(1, (s - 1) / 2) < 0.59 then 'lave'
    when d::float8 / greatest(1, (s - 1) / 2) > 0.78 and d::float8 / greatest(1, (s - 1) / 2) < 0.84 then 'cristal' end;
$$;
-- blocs encore debout dans un type de couche
create or replace function public._layer_left(lt text) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(((g.size - 2*gs.dd)::bigint ^ 3 - greatest(g.size - 2*gs.dd - 2, 0)::bigint ^ 3) - coalesce(ld.n, 0)), 0)::bigint
  from public.game g cross join lateral generate_series(g.peeled, greatest((g.size - 1) / 2, 0)) as gs(dd)
  left join public.layer_done ld on ld.d = gs.dd
  where g.id = 1 and public._layer_type(gs.dd, g.size) = lt;
$$;
create or replace function public._daily_roll() returns void
language plpgsql security definer set search_path = public as $$
declare g record; today date := (now() at time zone 'Europe/Paris')::date; opts text[] := '{}'; k text; t int; h int; left_n bigint;
begin
  select * into g from public.game where id = 1;
  if g.daily_day = today then return; end if;
  opts := array['blocs', 'artefacts', 'or', 'combo'];
  if (select count(*) from public.chests where opened_by is null) >= 8 then opts := opts || 'coffres'::text; end if;
  foreach k in array array['glace', 'lave', 'cristal'] loop
    if public._layer_left(k) >= 200 then opts := opts || k::text; end if;
  end loop;
  h := abs(hashint4(to_char(today, 'YYYYMMDD')::int # g.seed # (g.daily_salt * 7919)));
  k := opts[1 + h % array_length(opts, 1)];
  if k = g.daily_kind and g.daily_salt > 0 and array_length(opts, 1) > 1 then k := opts[1 + (h + 1) % array_length(opts, 1)]; end if;
  t := case k
    when 'blocs' then least(3000, greatest(150, round(g.size::numeric ^ 3 * 0.003)))
    when 'artefacts' then 12
    when 'or' then 150
    when 'combo' then 150
    when 'coffres' then 5
    else least(300, (public._layer_left(k) / 2)::int) end;
  update public.game set daily_day = today, daily_kind = k, daily_target = t, daily_progress = 0, daily_done = false where id = 1;
end $$;
-- Fait avancer le défi. Renvoie un message quand il est réussi (récompense versée à chaque joueur du jour).
create or replace function public._daily_track(nb int, depths int[], loots text[], chests int, used int, cmb int) returns text
language plpgsql security definer set search_path = public as $$
declare g record; add int := 0; ds timestamptz;
begin
  perform public._daily_roll();
  select * into g from public.game where id = 1 for update;
  if not g.daily_on or g.daily_done or g.daily_kind is null then return null; end if;
  if g.daily_kind = 'blocs' then add := coalesce(nb, 0);
  elsif g.daily_kind = 'artefacts' then add := coalesce(used, 0);
  elsif g.daily_kind = 'coffres' then add := coalesce(chests, 0);
  elsif g.daily_kind = 'or' then add := coalesce((select sum(split_part(l, ':', 2)::int) from unnest(loots) l where l like 'or:%'), 0);
  elsif g.daily_kind = 'combo' then
    if coalesce(cmb, 0) > g.daily_progress then update public.game set daily_progress = least(cmb, g.daily_target) where id = 1; g.daily_progress := least(cmb, g.daily_target); end if;
  else add := coalesce((select count(*) from unnest(depths) d where public._layer_type(d, g.size) = g.daily_kind), 0);
  end if;
  if add > 0 then
    update public.game set daily_progress = least(daily_progress + add, daily_target) where id = 1 returning daily_progress into g.daily_progress;
  end if;
  if g.daily_progress < g.daily_target then return null; end if;
  update public.game set daily_done = true where id = 1;
  ds := date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  insert into public.inventory as iv (player, kind, qty)
    select st.player, 'or', g.daily_reward from public.stats st where st.last_seen >= ds
    on conflict (player, kind) do update set qty = iv.qty + excluded.qty;
  perform public._log(null, 'daily', jsonb_build_object('kind', g.daily_kind, 'reward', g.daily_reward));
  return '🌟 Défi du jour réussi ! +' || g.daily_reward || ' 🪙';
end $$;
create or replace function public._daily_info() returns json
language sql stable security definer set search_path = public as $$
  select case when daily_on and daily_kind is not null and daily_day = (now() at time zone 'Europe/Paris')::date then
    json_build_object('kind', daily_kind, 'target', daily_target, 'progress', daily_progress, 'reward', daily_reward, 'done', daily_done) end
  from public.game where id = 1;
$$;
create or replace function public.admin_set_daily(p_on boolean, p_reward int, p_reroll boolean default false) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.game set daily_on = coalesce(p_on, daily_on), daily_reward = least(greatest(coalesce(p_reward, daily_reward), 0), 100000) where id = 1;
  if p_reroll then   -- nouveau tirage (un autre défi que celui en cours si possible)
    update public.game set daily_salt = daily_salt + 1, daily_day = null where id = 1;
    perform public._daily_roll();
  end if;
  return public._daily_info();
end $$;

-- ----- 🔨 Enchères (au marché) -----
create or replace function public._auctions_settle() returns json
language plpgsql security definer set search_path = public as $$
declare a record; o json[] := '{}';
begin
  for a in select * from public.auctions where status = 'open' and ends_at <= now() for update loop
    if a.bidder is not null then
      perform public._add(a.bidder, a.kind, a.qty);
      perform public._add(a.seller, 'or', a.bid);
      perform public._bump(a.bidder, 0, 0, 0, 1, 0); perform public._bump(a.seller, 0, 0, 0, 1, 0);
      update public.auctions set status = 'sold' where id = a.id;
      perform public._log(a.bidder, 'auction', jsonb_build_object('kind', a.kind, 'qty', a.qty, 'bid', a.bid,
        'seller', (select pseudo from public.profiles where id = a.seller)));
    else
      perform public._add(a.seller, a.kind, a.qty);
      update public.auctions set status = 'unsold' where id = a.id;
    end if;
    o := o || json_build_object('id', a.id, 'seller', a.seller, 'bidder', a.bidder, 'kind', a.kind, 'qty', a.qty, 'bid', a.bid,
                                'status', case when a.bidder is null then 'unsold' else 'sold' end,
                                'seller_pseudo', (select pseudo from public.profiles where id = a.seller),
                                'bidder_pseudo', (select pseudo from public.profiles where id = a.bidder));
  end loop;
  delete from public.auctions where status <> 'open' and ends_at < now() - interval '7 days';
  return to_json(o);
end $$;
create or replace function public.auction_list() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._auctions_settle();
  return (select coalesce(json_agg(json_build_object('id', a.id, 'seller', a.seller, 'pseudo', s.pseudo, 'kind', a.kind, 'qty', a.qty,
            'min_bid', a.min_bid, 'bid', a.bid, 'bidder', a.bidder, 'bidder_pseudo', b.pseudo, 'ends_at', a.ends_at, 'status', a.status,
            'left', greatest(0, extract(epoch from a.ends_at - now()))) order by (a.status <> 'open'), a.ends_at), '[]'::json)
          from public.auctions a join public.profiles s on s.id = a.seller left join public.profiles b on b.id = a.bidder
          where a.status = 'open' or a.ends_at > now() - interval '24 hours');
end $$;
create or replace function public.auction_create(p_kind text, p_qty int, p_min int, p_minutes int) returns bigint
language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._check_item(p_kind);
  if p_kind = 'or' then raise exception 'On ne met pas d''or aux enchères : choisis un objet'; end if;
  if coalesce(p_qty, 0) < 1 or p_qty > 9999 or coalesce(p_min, 0) < 1 or p_min > 1000000 then raise exception 'Quantité invalide'; end if;
  if (select count(*) from public.auctions where seller = auth.uid() and status = 'open') >= 5 then raise exception 'Maximum 5 enchères en même temps'; end if;
  perform public._take(auth.uid(), p_kind, p_qty);          -- mis de côté jusqu'à la fin
  insert into public.auctions (seller, kind, qty, min_bid, ends_at)
    values (auth.uid(), p_kind, p_qty, p_min, now() + make_interval(mins => least(greatest(coalesce(p_minutes, 60), 10), 1440)))
    returning id into nid;
  return nid;
end $$;
-- Enchérir : l'or est mis de côté ; l'enchérisseur précédent est remboursé. Dans les 2 dernières minutes, la fin recule de 2 minutes.
create or replace function public.auction_bid(p_id bigint, p_amount int) returns json
language plpgsql security definer set search_path = public as $$
declare a record; need int; prev uuid;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into a from public.auctions where id = p_id for update;
  prev := a.bidder;
  if not found or a.status <> 'open' or a.ends_at <= now() then raise exception 'Cette enchère est terminée'; end if;
  if a.seller = auth.uid() then raise exception 'C''est ta propre enchère'; end if;
  if a.bidder = auth.uid() then raise exception 'Tu as déjà la meilleure offre'; end if;
  need := case when a.bid = 0 then a.min_bid else a.bid + greatest(1, ceil(a.bid * 0.05)::int) end;
  if coalesce(p_amount, 0) < need then raise exception 'Offre trop basse : % 🪙 au minimum', need; end if;
  perform public._take(auth.uid(), 'or', p_amount);
  if a.bidder is not null then perform public._add(a.bidder, 'or', a.bid); end if;
  update public.auctions set bid = p_amount, bidder = auth.uid(),
    ends_at = case when ends_at - now() < interval '2 minutes' then now() + interval '2 minutes' else ends_at end
  where id = p_id returning * into a;
  return json_build_object('id', a.id, 'bid', a.bid, 'kind', a.kind, 'qty', a.qty, 'seller', a.seller,
    'outbid', prev, 'ends_at', a.ends_at,
    'pseudo', (select pseudo from public.profiles where id = auth.uid()));
end $$;
create or replace function public.auction_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from public.auctions where id = p_id for update;
  if not found or a.status <> 'open' then raise exception 'Cette enchère est terminée'; end if;
  if a.seller <> auth.uid() and not public.is_admin() then raise exception 'Ce n''est pas ton offre'; end if;
  if a.bidder is not null and not public.is_admin() then raise exception 'Impossible : quelqu''un a déjà enchéri'; end if;
  if a.bidder is not null then perform public._add(a.bidder, 'or', a.bid); end if;
  perform public._add(a.seller, a.kind, a.qty);
  update public.auctions set status = 'cancelled', ends_at = now() where id = p_id;
end $$;

-- ----- ✉️ Messages privés (surveillés par le 🤖 bot comme le salon) -----
create or replace function public.pm_send(p_to uuid, p_body text) returns json
language plpgsql security definer set search_path = public as $$
declare b text := trim(coalesce(p_body, '')); p record; g record; uid uuid := auth.uid(); bot jsonb; st jsonb; m public.pm; nb int; last_at timestamptz;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if b = '' then raise exception 'Message vide'; end if;
  if char_length(b) > 500 then raise exception 'Message trop long (500 caractères maximum)'; end if;
  if p_to = uid then raise exception 'Tu ne peux pas t''écrire à toi-même'; end if;
  if not exists (select 1 from public.profiles where id = p_to and status = 'approved') then raise exception 'Joueur inconnu'; end if;
  select * into p from public.profiles where id = uid;
  select * into g from public.game where id = 1;
  select max(at) into last_at from public.pm where sender = uid;
  if last_at > now() - interval '700 milliseconds' then raise exception 'Doucement ! Un message à la fois'; end if;
  if not p.is_admin then
    if p.chat_banned then raise exception 'Tu n''as plus le droit d''écrire dans le salon'; end if;
    if p.chat_muted_until > now() then raise exception 'Tu es en sourdine encore % min', ceil(extract(epoch from p.chat_muted_until - now()) / 60)::int; end if;
    if g.bot_on then
      select count(*) into nb from public.pm where sender = uid and at > now() - interval '10 seconds';
      if nb >= 6 then
        update public.profiles set chat_muted_until = greatest(coalesce(chat_muted_until, now()), now() + interval '2 minutes') where id = uid;
        insert into public.mod_log (moderator, target, action, reason, detail) values (null, uid, 'mute', 'flood', '{"minutes": 2, "pm": true}');
        return json_build_object('blocked', true, 'reason', 'flood', 'muted_until', now() + interval '2 minutes');
      end if;
      bot := public._bot_check(b, uid);
      if bot is not null then
        insert into public.pm (sender, recipient, body, hidden, flagged) values (uid, p_to, b, true, bot->>'reason');
        update public.profiles set warnings = warnings + (bot->>'sev')::int where id = uid;
        insert into public.mod_log (moderator, target, action, reason, detail)
          values (null, uid, 'warn', bot->>'reason', jsonb_build_object('auto', true, 'pm', true, 'n', (bot->>'sev')::int));
        st := public._escalate(uid);
        return json_build_object('blocked', true, 'reason', bot->>'reason', 'warnings', st->'warnings', 'muted_until', st->'muted_until', 'chat_banned', st->'chat_banned');
      end if;
      if not g.chat_links and b ~* '(https?://|www\.|[a-z0-9-]+\.(com|fr|net|org|io|gg|ly|be|ch|ca|co|me|tv|xyz|app)(/|\s|$))' then
        raise exception 'Les liens sont désactivés dans le salon';
      end if;
    end if;
  end if;
  insert into public.pm (sender, recipient, body) values (uid, p_to, b) returning * into m;
  -- garde-fou : 20 000 messages privés au plus
  if m.id % 200 = 0 then delete from public.pm where id <= (select id from public.pm order by id desc offset 20000 limit 1); end if;
  return json_build_object('id', m.id, 'from', m.sender, 'to', m.recipient, 'body', m.body, 'at', m.at,
                           'pseudo', p.pseudo, 'avatar', p.avatar, 'color', p.color);
end $$;
-- Mes conversations : le dernier message et les non lus
create or replace function public.pm_threads() returns json
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select coalesce(json_agg(json_build_object('with', t.other, 'pseudo', p.pseudo, 'avatar', p.avatar, 'color', p.color,
            'last', t.body, 'at', t.at, 'mine', t.sender = uid,
            'unread', (select count(*) from public.pm u where u.recipient = uid and u.sender = t.other and u.read_at is null and not u.hidden))
            order by t.at desc), '[]'::json)
    from (select distinct on (other) case when m.sender = uid then m.recipient else m.sender end as other, m.body, m.at, m.sender
          from public.pm m where (m.sender = uid or (m.recipient = uid and not m.hidden))
          order by other, m.id desc) t join public.profiles p on p.id = t.other);
end $$;
-- Une conversation (et la marquer comme lue)
create or replace function public.pm_list(p_with uuid, before_id bigint default null) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  update public.pm set read_at = now() where recipient = uid and sender = p_with and read_at is null;
  return (select coalesce(json_agg(json_build_object('id', m.id, 'from', m.sender, 'to', m.recipient, 'body', m.body, 'at', m.at,
            'hidden', case when m.hidden then m.flagged end) order by m.id), '[]'::json)
    from (select * from public.pm where ((sender = uid and recipient = p_with) or (sender = p_with and recipient = uid and not hidden))
            and (before_id is null or id < before_id) order by id desc limit 60) m);
end $$;
-- Supprimer son propre message privé (il disparaît aussi chez l'autre)
create or replace function public.pm_delete_own(p_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  delete from public.pm where id = p_id and sender = auth.uid() returning recipient into r;
  if not found then raise exception 'Message introuvable'; end if;
  return json_build_object('id', p_id, 'to', r);
end $$;
create or replace function public.pm_unread() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.pm where recipient = auth.uid() and read_at is null and not hidden and public.is_approved();
$$;
create or replace function public.pm_report(p_id bigint, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into m from public.pm where id = p_id and recipient = auth.uid();
  if not found then raise exception 'Message introuvable'; end if;
  if (select count(*) from public.reports where reporter = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Trop de signalements : réessaie plus tard';
  end if;
  insert into public.reports (reporter, target, message_id, body, reason) values (auth.uid(), m.sender, null, '✉️ ' || m.body, left(coalesce(p_reason, ''), 200));
end $$;

-- ----- 👍 Réactions sur les messages du salon -----
create or replace function public._reactions(p_msg bigint) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(emoji, ids), '{}'::json) from (
    select emoji, json_agg(player) ids from public.chat_reactions where msg = p_msg group by emoji) t;
$$;
create or replace function public.chat_react(p_id bigint, p_emoji text) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if p_emoji not in ('👍', '😂', '🔥', '❤️', '😮', '🎉', '😢', '😡', '👏', '💯', '🙏', '👀', '🤣', '😍', '💪', '🤔', '😱', '🥳') then raise exception 'Réaction inconnue'; end if;
  if not exists (select 1 from public.chat where id = p_id and not hidden) then raise exception 'Message introuvable'; end if;
  delete from public.chat_reactions where msg = p_id and player = auth.uid() and emoji = p_emoji;
  if not found then insert into public.chat_reactions (msg, player, emoji) values (p_id, auth.uid(), p_emoji); end if;
  return json_build_object('id', p_id, 'reactions', public._reactions(p_id));
end $$;

-- ----- 🏛️ Hall of fame : souvenir de chaque cube terminé -----
create or replace function public._hall_save() returns void
language plpgsql security definer set search_path = public as $$
declare g record; t record;
begin
  select * into g from public.game where id = 1;
  if g.destroyed <= 0 then return; end if;
  select * into t from public.treasure where id = 1;
  insert into public.hall (season, size, started_at, destroyed, total, revealed, winner, treasure, theme, players, top, records)
  values (g.season, g.size, g.started_at, g.destroyed, g.size::bigint ^ 3, g.revealed_at is not null, t.winner_pseudo, t.kind, g.theme,
    (select count(*) from public.stats where blocks > 0),
    (select coalesce(jsonb_agg(jsonb_build_object('pseudo', p.pseudo, 'avatar', p.avatar, 'blocks', s.blocks, 'hits', s.hits) order by s.blocks desc), '[]'::jsonb)
       from (select * from public.stats where blocks > 0 order by blocks desc limit 5) s join public.profiles p on p.id = s.player),
    jsonb_build_object(
      'combo', (select jsonb_build_object('pseudo', p.pseudo, 'v', s.best_combo) from public.stats s join public.profiles p on p.id = s.player where s.best_combo > 0 order by s.best_combo desc limit 1),
      'fast', (select jsonb_build_object('pseudo', p.pseudo, 'v', s.best_break_ms) from public.stats s join public.profiles p on p.id = s.player where s.best_break_ms is not null order by s.best_break_ms limit 1),
      'deep', (select jsonb_build_object('pseudo', p.pseudo, 'v', s.deepest) from public.stats s join public.profiles p on p.id = s.player where s.blocks > 0 order by s.deepest desc limit 1),
      'chests', (select jsonb_build_object('pseudo', p.pseudo, 'v', s.chests) from public.stats s join public.profiles p on p.id = s.player where s.chests > 0 order by s.chests desc limit 1),
      'used', (select jsonb_build_object('pseudo', p.pseudo, 'v', s.artifacts_used) from public.stats s join public.profiles p on p.id = s.player where s.artifacts_used > 0 order by s.artifacts_used desc limit 1),
      'gold', (select jsonb_build_object('pseudo', p.pseudo, 'v', s.gold_found) from public.stats s join public.profiles p on p.id = s.player where s.gold_found > 0 order by s.gold_found desc limit 1),
      'traps', (select jsonb_build_object('pseudo', p.pseudo, 'v', s.traps) from public.stats s join public.profiles p on p.id = s.player where s.traps > 0 order by s.traps desc limit 1)));
end $$;
create or replace function public.hall_list() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select coalesce(json_agg(row_to_json(h) order by h.id desc), '[]'::json) from (select * from public.hall order by id desc limit 50) h);
end $$;

-- ----- ⭐ Niveaux et titres : l'expérience gagnée est gardée d'un cube à l'autre -----
alter table public.profiles add column if not exists xp_bank bigint not null default 0;
create or replace function public._xp(s public.stats) returns bigint
language sql immutable as $$
  select (coalesce(s.blocks, 0) + coalesce(s.hits, 0) / 10 + coalesce(s.artifacts_found, 0) * 20 + coalesce(s.artifacts_used, 0) * 5
    + coalesce(s.chests, 0) * 15 + coalesce(s.missions_done, 0) * 30 + coalesce(s.crafted, 0) * 10 + coalesce(s.trades, 0) * 10
    + coalesce(s.trophies, 0) * 200 + coalesce(s.materials_found, 0) * 2 + coalesce(s.gold_found, 0) / 2 + coalesce(s.peels, 0) * 50)::bigint;
$$;
create or replace function public.player_levels() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select coalesce(json_object_agg(p.id, p.xp_bank + coalesce(public._xp(s), 0)), '{}'::json)
          from public.profiles p left join public.stats s on s.player = p.id where p.status = 'approved');
end $$;

-- ----- 🎨 Thème du cube -----
create or replace function public.admin_set_theme(p_theme text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_theme not in ('classique', 'halloween', 'noel', 'espace', 'ocean', 'bonbons', 'photo') then raise exception 'Thème inconnu'; end if;
  update public.game set theme = p_theme where id = 1;
end $$;

-- ----- 🔔 Notifications sur le téléphone -----
create or replace function public.push_subscribe(p_endpoint text, p_keys jsonb, p_lang text default 'fr') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000 then raise exception 'Abonnement invalide'; end if;
  insert into public.push_subs (endpoint, player, keys, lang) values (p_endpoint, auth.uid(), p_keys, case when p_lang = 'en' then 'en' else 'fr' end)
    on conflict (endpoint) do update set player = excluded.player, keys = excluded.keys, lang = excluded.lang;
  -- au plus 5 appareils par joueur
  delete from public.push_subs where player = auth.uid() and endpoint not in
    (select endpoint from public.push_subs where player = auth.uid() order by created_at desc limit 5);
end $$;
create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subs where endpoint = p_endpoint and player = auth.uid();
$$;


create or replace function public._chat_row(c public.chat) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('id', c.id, 'player', c.player,
    'pseudo', coalesce((select pseudo from public.profiles where id = c.player), 'Ancien joueur'),
    'avatar', (select avatar from public.profiles where id = c.player), 'color', (select color from public.profiles where id = c.player),
    'body', c.body, 'at', c.created_at,
    -- seuls les modérateurs savent qu'un message est « fantôme » ou masqué
    'shadow', case when c.shadow and public._can_mod() then true end,
    'flagged', case when public._can_mod() then c.flagged end,
    'reactions', public._reactions(c.id),
    'reply', (select json_build_object('id', r.id, 'player', r.player, 'pseudo', coalesce((select pseudo from public.profiles where id = r.player), 'Ancien joueur'),
                'body', left(r.body, 140)) from public.chat r where c.reply_to is not null and r.id = c.reply_to and not r.hidden
                and (not r.shadow or r.player = auth.uid() or public._can_mod())));
$$;

-- ----- 🤖 Bot de modération (version 8) -----
-- Texte simplifié : minuscules, sans accents, chiffres « leet » remplacés (c0nn4rd → connard),
-- ponctuation en espaces, lettres répétées réduites (coooonnard → conard).
create or replace function public._norm(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(
    translate(lower(coalesce(t, '')), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ0134578@$€!|', 'aaaaaaceeeeiiiinooooouuuuyyoaoieastbaseii'),
    '[^a-z]+', ' ', 'g'), '([a-z])\1+', '\1', 'g'), ' +', ' ', 'g'));
$$;
-- Liste par défaut (déjà simplifiée). mode : w = mot entier, p = début de mot (et mot collé si 5 lettres ou plus).
-- sev : 0 = seulement si c'est dirigé contre quelqu'un (« t'es débile »), 1 = insulte, 2 = haine ou menace (compte double).
create or replace function public._bot_list() returns table (word text, mode text, sev int, cat text)
language sql immutable as $$
  values
    ('conard', 'p', 1, 'insulte'), ('conase', 'p', 1, 'insulte'), ('salop', 'p', 1, 'insulte'), ('pute', 'p', 1, 'insulte'),
    ('encule', 'p', 1, 'insulte'), ('enfoire', 'p', 1, 'insulte'), ('batard', 'p', 1, 'insulte'), ('fdp', 'w', 1, 'insulte'),
    ('ntm', 'w', 1, 'insulte'), ('nique', 'p', 1, 'insulte'), ('niquer', 'p', 1, 'insulte'), ('tg', 'w', 1, 'insulte'),
    ('ftg', 'w', 1, 'insulte'), ('ta gueule', 'p', 1, 'insulte'), ('va te faire', 'p', 1, 'insulte'), ('bite', 'w', 1, 'insulte'),
    ('suce', 'w', 1, 'insulte'), ('fuck', 'p', 1, 'insulte'), ('bitch', 'p', 1, 'insulte'), ('bastard', 'p', 1, 'insulte'),
    ('ashole', 'p', 1, 'insulte'), ('dick', 'w', 1, 'insulte'), ('cunt', 'p', 1, 'insulte'), ('whore', 'p', 1, 'insulte'),
    ('slut', 'p', 1, 'insulte'), ('stfu', 'w', 1, 'insulte'), ('porn', 'p', 1, 'insulte'),
    ('con', 'w', 0, 'insulte'), ('debile', 'p', 0, 'insulte'), ('abruti', 'p', 0, 'insulte'), ('cretin', 'p', 0, 'insulte'),
    ('imbecile', 'p', 0, 'insulte'), ('idiot', 'p', 0, 'insulte'), ('tocard', 'p', 0, 'insulte'), ('boufon', 'p', 0, 'insulte'),
    ('moron', 'p', 0, 'insulte'), ('stupid', 'p', 0, 'insulte'), ('loser', 'p', 0, 'insulte'), ('creve', 'w', 0, 'menace'),
    ('pd', 'w', 2, 'haine'), ('pede', 'p', 2, 'haine'), ('tapete', 'p', 2, 'haine'), ('gouine', 'p', 2, 'haine'),
    ('negre', 'p', 2, 'haine'), ('negro', 'p', 2, 'haine'), ('bougnoul', 'p', 2, 'haine'), ('youpin', 'p', 2, 'haine'),
    ('bicot', 'p', 2, 'haine'), ('sale arabe', 'p', 2, 'haine'), ('sale noir', 'p', 2, 'haine'), ('sale juif', 'p', 2, 'haine'),
    ('sale blanc', 'p', 2, 'haine'), ('suicide toi', 'p', 2, 'menace'), ('suicidetoi', 'p', 2, 'menace'), ('va mourir', 'p', 2, 'menace'),
    ('va crever', 'p', 2, 'menace'), ('kys', 'w', 2, 'menace'), ('kil yourself', 'p', 2, 'menace'), ('kil urself', 'p', 2, 'menace'),
    ('je vais te tuer', 'p', 2, 'menace'), ('jvais te tuer', 'p', 2, 'menace')
$$;
-- Analyse d'un message : null si tout va bien, sinon { sev, reason, word }
create or replace function public._bot_check(t text, uid uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare sp text; cp text; raw text := lower(coalesce(t, '')); w record; directed boolean; g record; allow text[];
begin
  sp := ' ' || public._norm(t) || ' ';
  cp := regexp_replace(replace(sp, ' ', ''), '([a-z])\1+', '\1', 'g');     -- lettres espacées : « c o n n a r d »
  select bot_words, bot_allow into g from public.game where id = 1;
  allow := array(select public._norm(x) from regexp_split_to_table(coalesce(g.bot_allow, ''), '[,;\n]') x where btrim(x) <> '');
  if raw ~ '\m(nigg(a|er)|faggot)' then return jsonb_build_object('sev', 2, 'reason', 'haine', 'word', 'n'); end if;
  -- dirigé contre quelqu'un ? (« t'es … », « sale … », « espèce de … », ou le pseudo d'un joueur)
  directed := sp ~ ' (t es|tes|tu es|tu e|t etais|sale|espece de|you are|you re|youre|ur|u r|your|vous etes|z etes) '
    or exists (select 1 from public.profiles p where p.id is distinct from uid and p.status = 'approved'
               and char_length(public._norm(p.pseudo)) >= 3 and sp like '% ' || public._norm(p.pseudo) || ' %');
  for w in
    select bl.word, bl.mode, bl.sev, bl.cat from public._bot_list() bl
    union all
    select public._norm(x), 'p', 1, 'insulte' from regexp_split_to_table(coalesce(g.bot_words, ''), '[,;\n]') x where char_length(public._norm(x)) >= 2
  loop
    continue when w.word = '' or w.word = any(allow);
    if (w.mode = 'w' and sp like '% ' || w.word || ' %')
       or (w.mode = 'p' and (sp like '% ' || w.word || '%' or (char_length(w.word) >= 5 and cp like '%' || replace(w.word, ' ', '') || '%'))) then
      if w.sev = 0 and not directed then continue; end if;
      return jsonb_build_object('sev', greatest(w.sev, 1), 'reason', w.cat, 'word', w.word);
    end if;
  end loop;
  return null;
end $$;

-- Sanctions automatiques selon le nombre d'avertissements (réglable dans 👑 › Modération)
create or replace function public._escalate(uid uuid, by_mod uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; p record; act text := null; mins int;
begin
  select * into g from public.game where id = 1;
  select * into p from public.profiles where id = uid;
  if p.is_admin then return '{}'::jsonb; end if;
  if g.esc_ban > 0 and p.warnings >= g.esc_ban then
    if not p.chat_banned then update public.profiles set chat_banned = true where id = uid; act := 'chatban'; end if;
  elsif g.esc_mute2 > 0 and p.warnings >= g.esc_mute2 then mins := g.esc_mute2_min; act := 'mute';
  elsif g.esc_mute1 > 0 and p.warnings >= g.esc_mute1 then mins := g.esc_mute1_min; act := 'mute';
  end if;
  if act = 'mute' then
    update public.profiles set chat_muted_until = greatest(coalesce(chat_muted_until, now()), now() + make_interval(mins => mins)) where id = uid;
  end if;
  if act is not null then
    insert into public.mod_log (moderator, target, action, reason, detail)
    values (by_mod, uid, act, 'automatique', jsonb_build_object('warnings', p.warnings, 'minutes', mins));
  end if;
  return (select jsonb_build_object('warnings', warnings, 'muted_until', chat_muted_until, 'chat_banned', chat_banned) from public.profiles where id = uid);
end $$;

-- Envoyer un message. Renvoie le message, ou { blocked, reason, … } si le 🤖 bot l'a masqué.
-- p_reply : ↩️ le message auquel on répond (facultatif)
drop function if exists public.chat_send(text);
create or replace function public.chat_send(p_body text, p_reply bigint default null) returns json
language plpgsql security definer set search_path = public as $$
declare b text := trim(coalesce(p_body, '')); last_at timestamptz; c public.chat; p record; g record; uid uuid := auth.uid();
  bot jsonb; st jsonb; letters int; uppers int; nb int; mins int;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if b = '' then raise exception 'Message vide'; end if;
  if char_length(b) > 500 then raise exception 'Message trop long (500 caractères maximum)'; end if;
  select * into p from public.profiles where id = uid;
  select * into g from public.game where id = 1;
  select max(created_at) into last_at from public.chat where player = uid;
  if last_at is not null and last_at > now() - interval '700 milliseconds' then
    raise exception 'Doucement ! Un message à la fois';
  end if;
  if not p.is_admin then
    if p.chat_banned then raise exception 'Tu n''as plus le droit d''écrire dans le salon'; end if;
    if p.chat_muted_until > now() then
      raise exception 'Tu es en sourdine encore % min', ceil(extract(epoch from p.chat_muted_until - now()) / 60)::int;
    end if;
    if not p.is_mod then
      if g.chat_locked then raise exception 'Le salon est verrouillé par l''organisateur'; end if;
      if g.chat_slow > 0 and last_at > now() - make_interval(secs => g.chat_slow) then
        raise exception 'Mode lent : attends encore % s', ceil(extract(epoch from last_at + make_interval(secs => g.chat_slow) - now()))::int;
      end if;
      if g.chat_newbie_min > 0 and p.approved_at > now() - make_interval(mins => g.chat_newbie_min) then
        raise exception 'Les nouveaux joueurs peuvent écrire au bout de % min', ceil(extract(epoch from p.approved_at + make_interval(mins => g.chat_newbie_min) - now()) / 60)::int;
      end if;
    end if;
    if not g.chat_links and b ~* '(https?://|www\.|[a-z0-9-]+\.(com|fr|net|org|io|gg|ly|be|ch|ca|co|me|tv|xyz|app)(/|\s|$))' then
      raise exception 'Les liens sont désactivés dans le salon';
    end if;
    if g.bot_on then
      -- 🤖 flood : plus de 5 messages en 10 secondes → 2 minutes de sourdine
      select count(*) into nb from public.chat where player = uid and created_at > now() - interval '10 seconds';
      if nb >= 5 then
        update public.profiles set chat_muted_until = greatest(coalesce(chat_muted_until, now()), now() + interval '2 minutes') where id = uid;
        insert into public.mod_log (moderator, target, action, reason, detail) values (null, uid, 'mute', 'flood', '{"minutes": 2}');
        return json_build_object('blocked', true, 'reason', 'flood', 'muted_until', now() + interval '2 minutes');
      end if;
      -- 🤖 même message répété
      if exists (select 1 from (select body from public.chat where player = uid and created_at > now() - interval '60 seconds' order by id desc limit 3) r
                 where public._norm(r.body) = public._norm(b) and public._norm(b) <> '') then
        return json_build_object('blocked', true, 'reason', 'repete');
      end if;
      -- 🤖 insultes, haine, menaces
      bot := public._bot_check(b, uid);
      if bot is not null then
        insert into public.chat (player, body, hidden, flagged) values (uid, b, true, bot->>'reason') returning * into c;
        update public.profiles set warnings = warnings + (bot->>'sev')::int where id = uid;
        insert into public.mod_log (moderator, target, action, reason, detail)
          values (null, uid, 'warn', bot->>'reason', jsonb_build_object('message', c.id, 'auto', true, 'n', (bot->>'sev')::int));
        st := public._escalate(uid);
        return json_build_object('blocked', true, 'reason', bot->>'reason', 'warnings', st->'warnings',
                                 'muted_until', st->'muted_until', 'chat_banned', st->'chat_banned');
      end if;
      -- 🤖 TOUT EN MAJUSCULES : adouci en minuscules
      letters := char_length(regexp_replace(b, '[^[:alpha:]]', '', 'g'));
      uppers := char_length(regexp_replace(b, '[^[:upper:]]', '', 'g'));
      if letters >= 12 and uppers > letters * 0.7 then b := lower(b); end if;
    end if;
  end if;
  insert into public.chat (player, body, shadow, reply_to) values (uid, b, p.shadow and not p.is_admin,
    (select id from public.chat where id = p_reply and not hidden)) returning * into c;
  -- garde-fou : jamais plus de 5 000 messages
  if c.id % 100 = 0 then
    delete from public.chat where id <= (select id from public.chat order by id desc offset 5000 limit 1);
  end if;
  -- _s : sourdine fantôme (lu par le serveur maison pour savoir à qui relayer le message, puis retiré)
  return (public._chat_row(c)::jsonb || jsonb_build_object('_s', c.shadow))::json;
end $$;

-- Messages les plus récents (ou plus anciens que before_id), du plus ancien au plus récent
create or replace function public.chat_list(before_id bigint default null, lim int default 60) returns json
language plpgsql stable security definer set search_path = public as $$
declare md boolean := public._can_mod(); uid uuid := auth.uid();
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select coalesce(json_agg(public._chat_row(t) order by t.id), '[]'::json) from (
    select * from public.chat c where (before_id is null or c.id < before_id)
      and not c.hidden and (not c.shadow or c.player = uid or md)
    order by c.id desc limit least(greatest(coalesce(lim, 60), 1), 200)) t);
end $$;

create or replace function public.admin_chat_delete(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  if not public._can_mod() then raise exception 'Réservé à l''administrateur'; end if;
  delete from public.chat where id = p_id returning player into a;
  if found then insert into public.mod_log (moderator, target, action, detail) values (auth.uid(), a, 'delete', jsonb_build_object('message', p_id)); end if;
end $$;

-- Supprimer son propre message (salon)
create or replace function public.chat_delete_own(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  delete from public.chat where id = p_id and player = auth.uid();
  if not found then raise exception 'Message introuvable'; end if;
end $$;

-- Signaler un message (🚩). 10 signalements par heure au plus.
create or replace function public.chat_report(p_id bigint, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select ch.*, p.is_admin into c from public.chat ch join public.profiles p on p.id = ch.player where ch.id = p_id;
  if not found then raise exception 'Message introuvable'; end if;
  if c.player = auth.uid() then raise exception 'Tu ne peux pas signaler ton propre message'; end if;
  if c.is_admin then raise exception 'Les messages de l''organisateur ne peuvent pas être signalés'; end if;
  if (select count(*) from public.reports where reporter = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Trop de signalements : réessaie plus tard';
  end if;
  if exists (select 1 from public.reports where reporter = auth.uid() and message_id = p_id) then return; end if;
  insert into public.reports (reporter, target, message_id, body, reason) values (auth.uid(), c.player, p_id, c.body, left(coalesce(p_reason, ''), 200));
end $$;

-- ----- 🛡️ Modération : sanctions (organisateur et modérateurs) -----
-- action : warn, mute, unmute, chatban, unchatban, shadow, unshadow, kick, ban, unban, purge, reset, mod, unmod
-- minutes : durée (mute, kick, ban ; 0 = définitif pour ban). L'organisateur n'est jamais concerné.
create or replace function public.mod_action(p_target uuid, p_action text, p_minutes int default null, p_reason text default '')
returns json language plpgsql security definer set search_path = public as $$
declare t record; adm boolean := public.is_admin(); ids bigint[] := '{}'; mins int := coalesce(p_minutes, 0); st jsonb := '{}'; until timestamptz;
begin
  if not public._can_mod() then raise exception 'Réservé à l''administrateur'; end if;
  select * into t from public.profiles where id = p_target;
  if not found then raise exception 'Joueur inconnu'; end if;
  if t.is_admin then raise exception 'L''organisateur ne peut pas être sanctionné'; end if;
  if t.id = auth.uid() then raise exception 'Tu ne peux pas te sanctionner toi-même'; end if;
  if not adm and t.is_mod then raise exception 'Seul l''organisateur peut sanctionner un modérateur'; end if;
  if not adm and p_action not in ('warn', 'mute', 'unmute', 'purge', 'kick') then raise exception 'Réservé à l''organisateur'; end if;
  if p_action in ('mute', 'kick') and mins <= 0 then mins := case p_action when 'kick' then 5 else 15 end; end if;
  if not adm and ((p_action = 'mute' and mins > 1440) or (p_action = 'kick' and mins > 60)) then
    raise exception 'Un modérateur peut mettre en sourdine 24 h au plus et exclure 1 h au plus';
  end if;
  mins := least(mins, 525600);
  if p_action = 'warn' then
    update public.profiles set warnings = warnings + 1 where id = p_target;
    st := public._escalate(p_target, auth.uid());
  elsif p_action = 'mute' then
    until := now() + make_interval(mins => mins);
    update public.profiles set chat_muted_until = until where id = p_target;
  elsif p_action = 'unmute' then update public.profiles set chat_muted_until = null where id = p_target;
  elsif p_action = 'chatban' then update public.profiles set chat_banned = true where id = p_target;
  elsif p_action = 'unchatban' then update public.profiles set chat_banned = false where id = p_target;
  elsif p_action = 'shadow' then update public.profiles set shadow = true where id = p_target;
  elsif p_action = 'unshadow' then update public.profiles set shadow = false where id = p_target;
  elsif p_action = 'kick' then
    until := now() + make_interval(mins => mins);
    update public.profiles set banned_until = until, ban_reason = left(coalesce(p_reason, ''), 200) where id = p_target;
  elsif p_action = 'ban' then
    until := case when mins > 0 then now() + make_interval(mins => mins) else 'infinity'::timestamptz end;
    update public.profiles set banned_until = until, ban_reason = left(coalesce(p_reason, ''), 200) where id = p_target;
  elsif p_action = 'unban' then update public.profiles set banned_until = null, ban_reason = '' where id = p_target;
  elsif p_action = 'purge' then
    with d as (delete from public.chat where player = p_target returning id) select coalesce(array_agg(id), '{}') into ids from d;
  elsif p_action = 'reset' then
    update public.profiles set warnings = 0, chat_muted_until = null, chat_banned = false, shadow = false where id = p_target;
  elsif p_action = 'mod' then update public.profiles set is_mod = true where id = p_target;
  elsif p_action = 'unmod' then update public.profiles set is_mod = false where id = p_target;
  else raise exception 'Action inconnue';
  end if;
  insert into public.mod_log (moderator, target, action, reason, detail)
    values (auth.uid(), p_target, p_action, left(coalesce(p_reason, ''), 200), jsonb_build_object('minutes', mins, 'deleted', coalesce(array_length(ids, 1), 0)));
  return json_build_object('ok', true, 'target', p_target, 'action', p_action, 'close', p_action in ('kick', 'ban'),
                           'until', until, 'deleted', ids, 'state', st);
end $$;

-- Fiche d'un joueur pour la modération
create or replace function public.mod_player(p uuid) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._can_mod() then raise exception 'Réservé à l''administrateur'; end if;
  return (select json_build_object(
    'id', pr.id, 'pseudo', pr.pseudo, 'avatar', pr.avatar, 'color', pr.color, 'status', pr.status, 'is_admin', pr.is_admin, 'is_mod', pr.is_mod,
    'warnings', pr.warnings, 'chat_muted_until', case when pr.chat_muted_until > now() then pr.chat_muted_until end,
    'chat_banned', pr.chat_banned, 'shadow', pr.shadow, 'pseudo_locked', pr.pseudo_locked,
    'banned_until', case when pr.banned_until > now() then pr.banned_until end, 'ban_reason', pr.ban_reason,
    'created_at', pr.created_at, 'approved_at', pr.approved_at,
    'rejected', (select rejected from public.stats where player = pr.id),
    'messages', (select coalesce(json_agg(json_build_object('id', c.id, 'body', c.body, 'at', c.created_at, 'hidden', c.hidden, 'shadow', c.shadow, 'flagged', c.flagged) order by c.id desc), '[]'::json)
                 from (select * from public.chat where player = pr.id order by id desc limit 40) c),
    'log', (select coalesce(json_agg(json_build_object('at', l.at, 'by', coalesce(m.pseudo, '🤖'), 'action', l.action, 'reason', l.reason, 'detail', l.detail) order by l.id desc), '[]'::json)
            from (select * from public.mod_log where target = pr.id order by id desc limit 40) l left join public.profiles m on m.id = l.moderator),
    'reports', (select count(*) from public.reports where target = pr.id),
    'pseudos', (select coalesce(json_agg(json_build_object('old', h.old, 'new', h.new, 'at', h.at, 'admin', h.by_admin) order by h.id desc), '[]'::json)
                from (select * from public.pseudo_history where player = pr.id order by id desc limit 20) h))
    from public.profiles pr where pr.id = p);
end $$;

-- Vue d'ensemble : réglages, signalements, joueurs sanctionnés, journal
create or replace function public.mod_overview() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._can_mod() then raise exception 'Réservé à l''administrateur'; end if;
  return (select json_build_object(
    'settings', json_build_object('chat_locked', g.chat_locked, 'chat_slow', g.chat_slow, 'chat_links', g.chat_links,
        'chat_newbie_min', g.chat_newbie_min, 'bot_on', g.bot_on, 'bot_words', g.bot_words, 'bot_allow', g.bot_allow,
        'esc_mute1', g.esc_mute1, 'esc_mute1_min', g.esc_mute1_min, 'esc_mute2', g.esc_mute2, 'esc_mute2_min', g.esc_mute2_min,
        'esc_ban', g.esc_ban, 'pseudo_days', g.pseudo_days),
    'is_admin', public.is_admin(),
    'reports', (select coalesce(json_agg(json_build_object('id', r.id, 'at', r.at, 'reporter', rp.pseudo, 'target', r.target, 'target_pseudo', tp.pseudo,
                  'message_id', r.message_id, 'body', r.body, 'reason', r.reason) order by r.id desc), '[]'::json)
                from (select * from public.reports where status = 'open' order by id desc limit 100) r
                left join public.profiles rp on rp.id = r.reporter left join public.profiles tp on tp.id = r.target),
    'sanctioned', (select coalesce(json_agg(json_build_object('id', p.id, 'pseudo', p.pseudo, 'warnings', p.warnings,
                  'muted_until', case when p.chat_muted_until > now() then p.chat_muted_until end, 'chat_banned', p.chat_banned, 'shadow', p.shadow,
                  'banned_until', case when p.banned_until > now() then p.banned_until end, 'is_mod', p.is_mod) order by p.pseudo), '[]'::json)
                   from public.profiles p where not p.is_admin and (p.warnings > 0 or p.chat_muted_until > now() or p.chat_banned or p.shadow
                                                                 or p.banned_until > now() or p.is_mod)),
    'log', (select coalesce(json_agg(json_build_object('at', l.at, 'by', coalesce(m.pseudo, '🤖'), 'target', t.pseudo, 'action', l.action,
              'reason', l.reason, 'detail', l.detail) order by l.id desc), '[]'::json)
            from (select * from public.mod_log order by id desc limit 80) l
            left join public.profiles m on m.id = l.moderator left join public.profiles t on t.id = l.target),
    'flagged', (select coalesce(json_agg(json_build_object('id', c.id, 'player', c.player, 'pseudo', p.pseudo, 'body', c.body, 'at', c.created_at, 'flagged', c.flagged) order by c.id desc), '[]'::json)
                from (select * from public.chat where hidden order by id desc limit 30) c left join public.profiles p on p.id = c.player),
    'default_words', case when public.is_admin() then (select json_agg(word) from public._bot_list()) end)
    from public.game g where g.id = 1);
end $$;

create or replace function public.mod_settings(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.game set
    chat_locked = coalesce((p->>'chat_locked')::boolean, chat_locked),
    chat_slow = least(greatest(coalesce((p->>'chat_slow')::int, chat_slow), 0), 3600),
    chat_links = coalesce((p->>'chat_links')::boolean, chat_links),
    chat_newbie_min = least(greatest(coalesce((p->>'chat_newbie_min')::int, chat_newbie_min), 0), 10080),
    bot_on = coalesce((p->>'bot_on')::boolean, bot_on),
    bot_words = left(coalesce(p->>'bot_words', bot_words), 4000),
    bot_allow = left(coalesce(p->>'bot_allow', bot_allow), 2000),
    esc_mute1 = least(greatest(coalesce((p->>'esc_mute1')::int, esc_mute1), 0), 100),
    esc_mute1_min = least(greatest(coalesce((p->>'esc_mute1_min')::int, esc_mute1_min), 1), 525600),
    esc_mute2 = least(greatest(coalesce((p->>'esc_mute2')::int, esc_mute2), 0), 100),
    esc_mute2_min = least(greatest(coalesce((p->>'esc_mute2_min')::int, esc_mute2_min), 1), 525600),
    esc_ban = least(greatest(coalesce((p->>'esc_ban')::int, esc_ban), 0), 100),
    pseudo_days = least(greatest(coalesce((p->>'pseudo_days')::int, pseudo_days), 0), 365)
  where id = 1;
end $$;

create or replace function public.mod_report_close(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._can_mod() then raise exception 'Réservé à l''administrateur'; end if;
  update public.reports set status = 'done' where id = p_id or (p_id is null and status = 'open');
end $$;

-- Pastilles du bouton 👑 : inscriptions en attente, signalements
create or replace function public.admin_badges() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'pending', case when public.is_admin() then (select count(*) from public.profiles where status = 'pending') else 0 end,
    'reports', case when public._can_mod() then (select count(*) from public.reports where status = 'open') else 0 end);
$$;

-- ----- ✏️ Changement de pseudo -----
create or replace function public.set_pseudo(p_pseudo text) returns json
language plpgsql security definer set search_path = public as $$
declare ps text := public._clean_pseudo(p_pseudo); p record; d int; h int;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into p from public.profiles where id = auth.uid() for update;
  if char_length(ps) < 2 or ps !~ '[[:alnum:]]' then raise exception 'Pseudo invalide (2 à 20 caractères)'; end if;
  if ps = p.pseudo then return json_build_object('pseudo', ps); end if;
  if not p.is_admin then
    if p.pseudo_locked then raise exception 'L''organisateur a bloqué le changement de ton pseudo'; end if;
    select pseudo_days into d from public.game where id = 1;
    if d > 0 and p.pseudo_changed_at > now() - make_interval(days => d) then
      h := ceil(extract(epoch from p.pseudo_changed_at + make_interval(days => d) - now()) / 3600);
      raise exception 'Tu pourras changer de pseudo dans % h', h;
    end if;
    if public._bot_check(ps, auth.uid()) is not null then raise exception 'Ce pseudo n''est pas autorisé'; end if;
  end if;
  if exists (select 1 from public.profiles where lower(pseudo) = lower(ps) and id <> p.id) then raise exception 'Ce pseudo est déjà pris'; end if;
  insert into public.pseudo_history (player, old, new) values (p.id, p.pseudo, ps);
  update public.profiles set pseudo = ps, pseudo_changed_at = now() where id = p.id;
  perform public._log(p.id, 'pseudo', jsonb_build_object('old', p.pseudo, 'new', ps));
  return json_build_object('pseudo', ps, 'old', p.pseudo);
end $$;

create or replace function public.admin_set_pseudo(p uuid, p_pseudo text, p_lock boolean default null) returns json
language plpgsql security definer set search_path = public as $$
declare ps text := public._clean_pseudo(p_pseudo); t record;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  select * into t from public.profiles where id = p for update;
  if not found then raise exception 'Joueur inconnu'; end if;
  if p_lock is not null then update public.profiles set pseudo_locked = p_lock where id = p; end if;
  if coalesce(p_pseudo, '') = '' or ps = t.pseudo then return json_build_object('pseudo', t.pseudo); end if;
  if char_length(ps) < 2 or ps !~ '[[:alnum:]]' then raise exception 'Pseudo invalide (2 à 20 caractères)'; end if;
  if exists (select 1 from public.profiles where lower(pseudo) = lower(ps) and id <> p) then raise exception 'Ce pseudo est déjà pris'; end if;
  insert into public.pseudo_history (player, old, new, by_admin) values (p, t.pseudo, ps, true);
  update public.profiles set pseudo = ps where id = p;
  perform public._log(p, 'pseudo', jsonb_build_object('old', t.pseudo, 'new', ps, 'admin', true));
  return json_build_object('pseudo', ps, 'old', t.pseudo);
end $$;

-- ----- ✨ Répartition automatique (👑 › Artefacts) -----
create or replace function public.admin_auto_plan() returns json
language plpgsql stable security definer set search_path = public as $$
declare s int; cd int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  select size into s from public.game where id = 1;
  cd := case when s % 2 = 0 then s/2 - 1 else (s-1)/2 - 1 end;
  return json_build_object('plan', public._plan(null), 'size', s, 'layers', cd,
    'hidden', (select coalesce(json_object_agg(kind, n), '{}'::json) from (select kind, count(*) n from public.artifacts where found_by is null group by kind) t),
    'chests', (select json_build_object('coffre', count(*) filter (where not trap), 'faux_coffre', count(*) filter (where trap))
               from public.chests where opened_by is null),
    'traps_on', (select traps_on from public.game where id = 1));
end $$;
-- Applique un plan { sorte: { n, lo, hi } }. replace = d'abord retirer ce qui est encore caché pour ces sortes.
create or replace function public.admin_auto_apply(p_plan jsonb, p_replace boolean default true) returns json
language plpgsql security definer set search_path = public as $$
declare keys text[]; o jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  keys := array(select jsonb_object_keys(coalesce(p_plan, '{}'::jsonb)));
  if p_replace then
    delete from public.artifacts where found_by is null and kind = any(keys);
    if 'coffre' = any(keys) then delete from public.chests where opened_by is null and not trap; end if;
    if 'faux_coffre' = any(keys) then delete from public.chests where opened_by is null and trap; end if;
  end if;
  o := public._apply_plan(p_plan);
  perform public._log(auth.uid(), 'auto_plan', jsonb_build_object('replace', p_replace, 'placed', o));
  return o;
end $$;
-- Pièges : activer (ils sont cachés selon la taille du cube) ou désactiver (ils sont tous retirés)
create or replace function public.admin_set_traps(p_on boolean) returns json
language plpgsql security definer set search_path = public as $$
declare n int := 0; o jsonb := '{}';
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.game set traps_on = coalesce(p_on, true) where id = 1;
  if p_on then
    if not exists (select 1 from public.artifacts where found_by is null and public._is_trap(kind)) then
      o := public._apply_plan(public._plan(public._traps() || array['faux_coffre']));
    end if;
  else
    delete from public.artifacts where found_by is null and public._is_trap(kind);
    get diagnostics n = row_count;
    delete from public.chests where opened_by is null and trap;
  end if;
  return json_build_object('placed', o, 'removed', n);
end $$;

-- Vider le salon : older_days = 0 efface tout, sinon les messages plus vieux que X jours
create or replace function public.admin_chat_clear(older_days int default 0) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if coalesce(older_days, 0) <= 0 then
    select count(*) into n from public.chat;
    truncate public.chat_reactions, public.chat;   -- libère immédiatement l'espace disque (réactions comprises)
  else
    delete from public.chat where created_at < now() - make_interval(days => older_days);
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

-- Place occupée dans la base (pour la jauge du panneau admin)
create or replace function public.admin_db_size() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  return json_build_object(
    'total', pg_database_size(current_database()),
    'blocks', pg_total_relation_size('public.blocks'),
    'chat', pg_total_relation_size('public.chat'),
    'chat_count', (select count(*) from public.chat),
    'blocks_count', greatest((select reltuples::bigint from pg_class where oid = 'public.blocks'::regclass), (select destroyed from public.game where id = 1)),
    'limit', 500 * 1024 * 1024
  );
end $$;

-- ---------------------------------------------------------------------
-- VERSION 12 : combos, série de jours, coffre du jour, heure dorée surprise,
-- saisons, styles de pseudo et insignes, duels entre joueurs
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists streak       int not null default 0;        -- 🔥 jours joués d'affilée
alter table public.profiles add column if not exists streak_best  int not null default 0;
alter table public.profiles add column if not exists streak_day   date;                          -- dernier jour joué (heure de Paris)
alter table public.profiles add column if not exists freezes      int not null default 0;        -- 🧊 gels de série (3 au plus)
alter table public.profiles add column if not exists chest_day    date;                          -- dernier 🎁 coffre du jour ouvert
alter table public.profiles add column if not exists chests_daily int not null default 0;        -- coffres du jour ouverts (en tout)
alter table public.profiles add column if not exists combo_best   int not null default 0;        -- meilleur combo de tous les temps
alter table public.profiles add column if not exists duel_wins    int not null default 0;
alter table public.profiles add column if not exists duel_played  int not null default 0;
alter table public.profiles add column if not exists medals       jsonb not null default '[]'::jsonb;  -- [{s: saison, r: rang (0 = saison complétée)}]
alter table public.profiles add column if not exists seasons      int not null default 0;        -- saisons jouées
alter table public.profiles add column if not exists treasures    int not null default 0;        -- lots du trésor gagnés
alter table public.profiles add column if not exists badge        text not null default '';      -- insigne affiché à côté du pseudo
alter table public.stats add column if not exists combo_paid      int not null default 0;        -- primes de combo déjà payées (combo en cours)
alter table public.stats add column if not exists season_claimed  int not null default 0;        -- paliers de saison réclamés
alter table public.game add column if not exists season int not null default 1;                  -- 🏆 un cube = une saison
alter table public.events add column if not exists hh_to int;                                    -- « au hasard » : avant cette heure
alter table public.hall add column if not exists season int;

-- ⏰ Heure dorée surprise : chaque jour, une heure tirée au hasard entre 10 h et 22 h
insert into public.events (name, icon, message, mult, minutes, sched, hh, mi, hh_to, builtin)
  select 'Heure dorée surprise', '⏰', 'Butin doublé pendant une heure !', '{"or": 2, "mat": 2}'::jsonb, 60, 'random', 10, 0, 22, 'surprise'
  where not exists (select 1 from public.events where builtin = 'surprise');

create or replace function public._today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Paris')::date; $$;

-- ----- 🔥 Combo : multiplicateur de butin (plafonné à ×5) et primes d'or -----
create or replace function public._combo_mult(c int) returns int
language sql immutable as $$
  select case when coalesce(c, 0) >= 300 then 5 when c >= 160 then 4 when c >= 80 then 3 when c >= 30 then 2 else 1 end;
$$;
create or replace function public._combo_bonus(m int) returns int
language sql immutable as $$ select case m when 100 then 10 when 250 then 25 when 500 then 60 when 1000 then 150 else 0 end; $$;

-- ----- 🔥 Série de jours -----
-- Un jour sans jouer casse la série, sauf s'il reste des 🧊 gels (un gel par jour manqué)
create or replace function public._streak_touch(uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p record; t date := public._today(); n int := 1; f int; miss int;
begin
  select streak, streak_day, freezes into p from public.profiles where id = uid;
  if not found or p.streak_day = t then return; end if;
  f := p.freezes;
  if p.streak_day = t - 1 then n := p.streak + 1;
  elsif p.streak_day is not null and p.streak > 0 then
    miss := t - p.streak_day - 1;
    if miss <= f then f := f - miss; n := p.streak + 1; end if;
  end if;
  update public.profiles set streak = n, streak_best = greatest(streak_best, n), streak_day = t, freezes = f where id = uid;
end $$;

-- ----- 🎁 Coffre du jour : un par jour, de plus en plus riche avec la série -----
create or replace function public.daily_chest_open() returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p record; t date := public._today(); sl int; g int; items jsonb; k text; fz int := 0;
  mats text[] := array['silex', 'fer', 'poudre', 'cristal']; arts text[] := public._classics();
  strong text[] := array['vrille', 'grappe', 'givre', 'megabombe', 'chaine', 'tornade'];
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._streak_touch(uid);
  select * into p from public.profiles where id = uid for update;
  if p.chest_day = t then raise exception 'Coffre du jour déjà ouvert : reviens demain !'; end if;
  sl := greatest(p.streak, 1);
  g := 10 + 3 * least(sl, 30) + floor(random() * 11)::int;             -- l'or grandit avec la série (jusqu'à 30 jours)
  items := jsonb_build_object('or', g);
  for j in 1 .. 2 + floor(random() * 3)::int loop                        -- 2 à 4 matériaux (le cristal dès 5 jours)
    k := mats[1 + floor(random() * case when sl >= 5 then 4 else 3 end)::int];
    items := items || jsonb_build_object(k, coalesce((items->>k)::int, 0) + 1);
  end loop;
  if random() < least(0.85, 0.25 + sl * 0.04) then                      -- un artefact classique, de plus en plus probable
    k := arts[1 + floor(random() * array_length(arts, 1))::int];
    items := items || jsonb_build_object(k, coalesce((items->>k)::int, 0) + 1);
  end if;
  if sl % 7 = 0 then                                                     -- tous les 7 jours : un artefact puissant + un 🧊 gel
    k := strong[1 + floor(random() * array_length(strong, 1))::int];
    items := items || jsonb_build_object(k, coalesce((items->>k)::int, 0) + 1);
    if p.freezes < 3 then fz := 1; end if;
  end if;
  if sl % 30 = 0 then items := items || jsonb_build_object('or', (items->>'or')::int + 100); end if;
  for k in select key from jsonb_each(items) loop perform public._add(uid, k, (items->>k)::int); end loop;
  update public.profiles set chest_day = t, chests_daily = chests_daily + 1, freezes = freezes + fz where id = uid;
  perform public._log(uid, 'daily_chest', jsonb_build_object('items', items, 'streak', sl));
  return json_build_object('items', items, 'streak', sl, 'freeze', fz, 'big_in', 7 - sl % 7);
end $$;
-- 🧊 acheter un gel de série (60 🪙, 3 au plus)
create or replace function public.buy_freeze() returns int
language plpgsql security definer set search_path = public as $$
declare f int;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select freezes into f from public.profiles where id = auth.uid() for update;
  if f >= 3 then raise exception 'Tu as déjà 3 gels de série (le maximum)'; end if;
  perform public._take(auth.uid(), 'or', 60);
  update public.profiles set freezes = freezes + 1 where id = auth.uid() returning freezes into f;
  return f;
end $$;

-- ----- 🏆 Saisons : un cube = une saison, avec 10 paliers de récompenses -----
-- XP de la saison = XP gagnée dans le cube en cours. Les paliers suivent la taille du cube (128³ = 100 %).
create or replace function public._season_tiers() returns table (tier int, need int, reward jsonb)
language sql immutable as $$
  values (1, 150, '{"or": 20}'::jsonb), (2, 400, '{"silex": 5, "fer": 5}'), (3, 800, '{"bombe": 2}'), (4, 1500, '{"or": 60}'),
    (5, 2500, '{"poudre": 6, "cristal": 3}'), (6, 4000, '{"dynamite": 2, "aimant": 1}'), (7, 6000, '{"or": 150}'),
    (8, 9000, '{"vrille": 1, "grappe": 1}'), (9, 13000, '{"megabombe": 1, "cristal": 6}'), (10, 18000, '{"or": 300, "tornade": 1}')
$$;
create or replace function public._season_factor() returns float8
language sql stable security definer set search_path = public as $$
  select greatest(0.05, least(1.0, size::float8 ^ 3 / 2097152.0)) from public.game where id = 1;
$$;
create or replace function public._season_xp(uid uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select public._xp(s) from public.stats s where s.player = uid), 0)::bigint;
$$;
create or replace function public.season_info() returns json
language plpgsql stable security definer set search_path = public as $$
declare f float8 := public._season_factor(); g record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into g from public.game where id = 1;
  return json_build_object('season', g.season, 'started_at', g.started_at, 'size', g.size,
    'xp', public._season_xp(auth.uid()), 'claimed', coalesce((select season_claimed from public.stats where player = auth.uid()), 0),
    'tiers', (select json_agg(json_build_object('tier', t.tier, 'need', round(t.need * f)::int, 'reward', t.reward) order by t.tier) from public._season_tiers() t),
    'top', (select coalesce(json_agg(json_build_object('id', x.player, 'pseudo', x.pseudo, 'blocks', x.blocks) order by x.blocks desc), '[]'::json)
            from (select s.player, p.pseudo, s.blocks from public.stats s join public.profiles p on p.id = s.player
                  where s.blocks > 0 and p.status = 'approved' order by s.blocks desc, s.hits desc limit 3) x),
    'past', (select coalesce(json_agg(json_build_object('season', h.season, 'size', h.size, 'ended_at', h.ended_at, 'winner', h.winner, 'top', h.top) order by h.id desc), '[]'::json)
             from (select * from public.hall where season is not null order by id desc limit 5) h));
end $$;
create or replace function public.season_claim() returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); f float8 := public._season_factor(); xp bigint := public._season_xp(uid); cl int; t record; e record;
  got jsonb := '{}'; n int := 0; sn int;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  insert into public.stats (player) values (uid) on conflict (player) do nothing;
  select season_claimed into cl from public.stats where player = uid for update;
  for t in select * from public._season_tiers() x where x.tier > cl and round(x.need * f) <= xp order by x.tier loop
    for e in select key, value::int as q from jsonb_each_text(t.reward) loop
      perform public._add(uid, e.key, e.q);
      got := got || jsonb_build_object(e.key, coalesce((got->>e.key)::int, 0) + e.q);
    end loop;
    cl := t.tier; n := n + 1;
    if t.tier = 10 then                                        -- 🎖️ saison complétée : gardé pour toujours
      select season into sn from public.game where id = 1;
      update public.profiles set medals = medals || jsonb_build_array(jsonb_build_object('s', sn, 'r', 0)) where id = uid;
    end if;
  end loop;
  if n = 0 then raise exception 'Aucun palier à réclamer pour l''instant'; end if;
  update public.stats set season_claimed = cl where player = uid;
  perform public._log(uid, 'season_tier', jsonb_build_object('tier', cl, 'got', got));
  return json_build_object('got', got, 'tiers', n, 'claimed', cl);
end $$;

-- ----- ⚔️ Duels : qui casse le plus de blocs à la main en 1 à 10 minutes ? Le gagnant remporte les deux mises -----
create table if not exists public.duels (
  id bigserial primary key,
  a uuid not null references public.profiles(id) on delete cascade,      -- celui qui lance le défi
  b uuid not null references public.profiles(id) on delete cascade,      -- celui qui est défié
  stake int not null default 0, minutes int not null default 2,
  status text not null default 'open',                                    -- open | live | done | refused | cancelled | expired
  created_at timestamptz not null default now(), start_at timestamptz, end_at timestamptz,
  a_score int not null default 0, b_score int not null default 0, winner uuid, settled_at timestamptz);
alter table public.duels enable row level security;
create index if not exists duels_status on public.duels (status);
create or replace function public._duel_json(d public.duels) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', d.id, 'a', d.a, 'b', d.b, 'ap', (select pseudo from public.profiles where id = d.a),
    'bp', (select pseudo from public.profiles where id = d.b), 'stake', d.stake, 'minutes', d.minutes, 'status', d.status,
    'as', d.a_score, 'bs', d.b_score, 'winner', d.winner,
    'start_in', greatest(0, extract(epoch from d.start_at - now())), 'left', greatest(0, extract(epoch from d.end_at - now())),
    'expires', greatest(0, extract(epoch from d.created_at + interval '10 minutes' - now())));
$$;
-- le duel du moment (proposé, en cours, ou terminé il y a moins de 90 s)
create or replace function public._duel_live(uid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select public._duel_json(d) from public.duels d
  where (d.a = uid or d.b = uid) and (d.status in ('open', 'live') or d.settled_at > now() - interval '90 seconds')
  order by (d.status in ('open', 'live')) desc, d.id desc limit 1;
$$;
-- défis expirés (10 min sans réponse) et duels terminés : mises rendues ou gagnées
create or replace function public._duels_settle() returns jsonb
language plpgsql security definer set search_path = public as $$
declare d record; w uuid; ids bigint[] := '{}';
begin
  for d in select * from public.duels where status = 'open' and created_at < now() - interval '10 minutes' for update loop
    if d.stake > 0 then perform public._add(d.a, 'or', d.stake); end if;
    update public.duels set status = 'expired', settled_at = now() where id = d.id;
    ids := ids || d.id;
  end loop;
  for d in select * from public.duels where status = 'live' and end_at <= now() for update loop
    w := case when d.a_score > d.b_score then d.a when d.b_score > d.a_score then d.b end;
    if w is null then
      if d.stake > 0 then perform public._add(d.a, 'or', d.stake); perform public._add(d.b, 'or', d.stake); end if;
    else
      if d.stake > 0 then perform public._add(w, 'or', d.stake * 2); end if;
      update public.profiles set duel_wins = duel_wins + 1 where id = w;
    end if;
    update public.profiles set duel_played = duel_played + 1 where id in (d.a, d.b);
    update public.duels set status = 'done', winner = w, settled_at = now() where id = d.id;
    perform public._log(w, 'duel', jsonb_build_object('a', d.a_score, 'b', d.b_score, 'stake', d.stake));
    ids := ids || d.id;
  end loop;
  return (select coalesce(jsonb_agg(public._duel_json(x)), '[]'::jsonb) from public.duels x where x.id = any(ids));
end $$;
create or replace function public.duel_create(p_to uuid, p_stake int default 0, p_minutes int default 2) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); nid bigint;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._duels_settle();
  if p_to is null or p_to = uid then raise exception 'Choisis un autre joueur à défier'; end if;
  if not exists (select 1 from public.profiles where id = p_to and status = 'approved') then raise exception 'Joueur inconnu'; end if;
  if coalesce(p_stake, 0) < 0 or p_stake > 1000 then raise exception 'Mise entre 0 et 1 000 🪙'; end if;
  if coalesce(p_minutes, 0) not in (1, 2, 3, 5, 10) then raise exception 'Durée invalide'; end if;
  if exists (select 1 from public.duels where status in ('open', 'live') and (a = uid or b = uid)) then raise exception 'Tu as déjà un duel en cours'; end if;
  if exists (select 1 from public.duels where status in ('open', 'live') and (a = p_to or b = p_to)) then raise exception 'Ce joueur est déjà en duel'; end if;
  if coalesce(p_stake, 0) > 0 then perform public._take(uid, 'or', p_stake); end if;
  insert into public.duels (a, b, stake, minutes) values (uid, p_to, coalesce(p_stake, 0), p_minutes) returning id into nid;
  return (select public._duel_json(d) from public.duels d where d.id = nid);
end $$;
create or replace function public.duel_respond(p_id bigint, p_accept boolean) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); d record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._duels_settle();
  select * into d from public.duels where id = p_id for update;
  if not found or d.b <> uid then raise exception 'Duel introuvable'; end if;
  if d.status <> 'open' then raise exception 'Ce défi n''est plus valable'; end if;
  if p_accept then
    if d.stake > 0 then perform public._take(uid, 'or', d.stake); end if;
    update public.duels set status = 'live', start_at = now() + interval '10 seconds',
      end_at = now() + interval '10 seconds' + make_interval(mins => d.minutes) where id = p_id;
  else
    if d.stake > 0 then perform public._add(d.a, 'or', d.stake); end if;
    update public.duels set status = 'refused', settled_at = now() where id = p_id;
  end if;
  return (select public._duel_json(x) from public.duels x where x.id = p_id);
end $$;
create or replace function public.duel_cancel(p_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into d from public.duels where id = p_id for update;
  if not found or (d.a <> auth.uid() and not public.is_admin()) then raise exception 'Duel introuvable'; end if;
  if d.status <> 'open' then raise exception 'Ce défi n''est plus valable'; end if;
  if d.stake > 0 then perform public._add(d.a, 'or', d.stake); end if;
  update public.duels set status = 'cancelled', settled_at = now() where id = p_id;
  return (select public._duel_json(x) from public.duels x where x.id = p_id);
end $$;
create or replace function public.duel_state() returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  perform public._duels_settle();
  return json_build_object('current', public._duel_live(uid),
    'wins', (select duel_wins from public.profiles where id = uid), 'played', (select duel_played from public.profiles where id = uid),
    'history', (select coalesce(json_agg(public._duel_json(d) order by d.id desc), '[]'::json)
                from (select * from public.duels where (a = uid or b = uid) and status = 'done' order by id desc limit 8) d));
end $$;

-- ----- 🎨 Styles de pseudo et insignes à débloquer (l'organisateur peut tout choisir) -----
alter table public.profiles add column if not exists style_lib jsonb not null default '{}'::jsonb;   -- 👑 créations de l'organisateur (effets, insignes)
create or replace function public._level_of(xp bigint) returns int
language sql immutable as $$ select least(999, greatest(1, floor(power(greatest(xp, 0)::float8 / 50.0, 1 / 2.2))::int + 1)); $$;
-- id : 'fx:…' = effet sur le pseudo, sinon un insigne (emoji) · need : ce qu'il faut atteindre (val)
create or replace function public._style_table() returns table (id text, need text, val int)
language sql immutable as $$
  values ('fx:neon', 'lv', 5), ('fx:or', 'lv', 10), ('fx:multi', 'lv', 15), ('fx:arc', 'lv', 25), ('fx:diamant', 'lv', 40),
    ('fx:glace', 'streak', 7), ('fx:feu', 'combo', 300), ('fx:bonbon', 'chests', 20), ('fx:toxique', 'duels', 5),
    ('fx:aurore', 'seasons', 3), ('fx:galaxie', 'gold', 1),
    ('⭐', 'lv', 10), ('🌟', 'lv', 25), ('💫', 'lv', 50), ('🔥', 'streak', 7), ('📅', 'streak', 30), ('☄️', 'combo', 500),
    ('⚔️', 'duels', 1), ('🗡️', 'duels', 10), ('🥇', 'gold', 1), ('🥈', 'silver', 1), ('🥉', 'bronze', 1), ('🎖️', 'pass', 1),
    ('🎁', 'chests', 30), ('💎', 'treasures', 1), ('🏛️', 'seasons', 5), ('🌍', 'global', 1),
    -- 👑 réservés à l'organisateur (need 'admin' : jamais atteignable par un joueur)
    ('fx:couronne', 'admin', 1), ('fx:electrique', 'admin', 1), ('fx:holo', 'admin', 1), ('fx:glitch', 'admin', 1),
    ('fx:lave', 'admin', 1), ('fx:ombre', 'admin', 1), ('fx:matrix', 'admin', 1), ('fx:solaire', 'admin', 1),
    ('adm:admin', 'admin', 1), ('adm:orga', 'admin', 1), ('adm:gardien', 'admin', 1), ('adm:createur', 'admin', 1),
    ('fx:plasma', 'admin', 1), ('fx:cosmos', 'admin', 1), ('fx:sakura', 'admin', 1), ('fx:ocean', 'admin', 1), ('fx:emeraude', 'admin', 1), ('fx:rubis', 'admin', 1), ('fx:chrome', 'admin', 1), ('fx:neonrose', 'admin', 1), ('fx:disco', 'admin', 1), ('fx:feubleu', 'admin', 1), ('fx:fantome', 'admin', 1), ('fx:arcneon', 'admin', 1), ('fx:vampire', 'admin', 1), ('fx:orrose', 'admin', 1), ('fx:cyber', 'admin', 1),
    ('adm:boss', 'admin', 1), ('adm:roi', 'admin', 1), ('adm:legende', 'admin', 1), ('adm:vip', 'admin', 1), ('adm:dev', 'admin', 1), ('adm:mj', 'admin', 1), ('adm:fondateur', 'admin', 1), ('adm:staff', 'admin', 1), ('adm:architecte', 'admin', 1)
$$;
create or replace function public._style_progress(uid uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p record;
begin
  select * into p from public.profiles where id = uid;
  if not found then return '{}'::jsonb; end if;
  return jsonb_build_object('lv', public._level_of(p.xp_bank + public._season_xp(uid)), 'streak', p.streak_best,
    'combo', greatest(p.combo_best, coalesce((select best_combo from public.stats where player = uid), 0)),
    'chests', p.chests_daily, 'duels', p.duel_wins, 'seasons', p.seasons, 'treasures', p.treasures,
    'gold', (select count(*) from jsonb_array_elements(p.medals) m where (m->>'r')::int = 1),
    'silver', (select count(*) from jsonb_array_elements(p.medals) m where (m->>'r')::int = 2),
    'bronze', (select count(*) from jsonb_array_elements(p.medals) m where (m->>'r')::int = 3),
    'pass', (select count(*) from jsonb_array_elements(p.medals) m where (m->>'r')::int = 0),
    'global', (select count(*) from jsonb_array_elements(p.medals) m where m ? 'g'));
end $$;
create or replace function public._style_ok(uid uuid, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public._style_table() t, (select public._style_progress(uid) pr) x
                 where t.id = p_id and coalesce((x.pr->>t.need)::int, 0) >= t.val);
$$;
create or replace function public.my_style() returns json
language plpgsql stable security definer set search_path = public as $$
declare pr jsonb := public._style_progress(auth.uid()); adm boolean := public.is_admin();
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return json_build_object('admin', adm, 'progress', pr,
    'items', (select json_agg(json_build_object('id', t.id, 'need', t.need, 'val', t.val, 'ok', adm or coalesce((pr->>t.need)::int, 0) >= t.val))
              from public._style_table() t where adm or t.need <> 'admin'),
    'color', (select color from public.profiles where id = auth.uid()), 'badge', (select badge from public.profiles where id = auth.uid()),
    'medals', (select medals from public.profiles where id = auth.uid()),
    'lib', case when adm then (select style_lib from public.profiles where id = auth.uid()) end);
end $$;
-- 👑 bibliothèque de créations de l'organisateur : { fx: [...], b: [...] }
create or replace function public.admin_style_lib(p_lib jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if jsonb_typeof(p_lib) <> 'object' then raise exception 'Bibliothèque invalide'; end if;
  foreach k in array array['fx', 'b'] loop
    if p_lib ? k and (jsonb_typeof(p_lib->k) <> 'array' or jsonb_array_length(p_lib->k) > 40
        or exists (select 1 from jsonb_array_elements(p_lib->k) x where jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') > 200)) then
      raise exception 'Bibliothèque invalide (40 créations au plus)';
    end if;
  end loop;
  update public.profiles set style_lib = jsonb_build_object('fx', coalesce(p_lib->'fx', '[]'::jsonb), 'b', coalesce(p_lib->'b', '[]'::jsonb)) where id = auth.uid();
end $$;
create or replace function public.set_badge(p_badge text) returns void
language plpgsql security definer set search_path = public as $$
declare b text := trim(coalesce(p_badge, '')); arr jsonb;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if b <> '' then
    if public.is_admin() then
      if b like '[%' then                                   -- 👑 jusqu'à 3 insignes affichés en même temps
        if char_length(b) > 700 then raise exception 'Insignes invalides (3 au plus)'; end if;
        begin arr := b::jsonb; exception when others then raise exception 'Insignes invalides (3 au plus)'; end;
        if jsonb_typeof(arr) <> 'array' or jsonb_array_length(arr) > 3
           or exists (select 1 from jsonb_array_elements(arr) x where jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') > 200) then
          raise exception 'Insignes invalides (3 au plus)';
        end if;
      elsif b like 'cus:%' then                             -- 👑 insigne créé sur mesure
        if char_length(b) > 200 then raise exception 'Insigne trop long'; end if;
      elsif char_length(b) > 8 and not exists (select 1 from public._style_table() t where t.id = b and t.id like 'adm:%') then raise exception 'Insigne trop long (8 caractères au plus)'; end if;
    elsif b like 'fx:%' or b like 'adm:%' or b like 'cus:%' or b like '[%' or not public._style_ok(auth.uid(), b) then raise exception 'Insigne pas encore débloqué';
    end if;
  end if;
  update public.profiles set badge = b where id = auth.uid();
end $$;
create or replace function public.player_badges() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select coalesce(json_object_agg(id, badge), '{}'::json) from public.profiles where status = 'approved' and badge <> '');
end $$;

-- ----- Ce que le jeu affiche pour le joueur : série, coffre, saison, duel -----
create or replace function public._my_daily(uid uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare p record; f float8 := public._season_factor(); xp bigint := public._season_xp(uid); cl int; reach int;
begin
  select * into p from public.profiles where id = uid;
  if not found then return null; end if;
  select season_claimed into cl from public.stats where player = uid;
  select count(*) into reach from public._season_tiers() t where round(t.need * f) <= xp;
  return json_build_object('streak', p.streak, 'best', p.streak_best, 'freezes', p.freezes,
    'chest', p.chest_day is distinct from public._today(), 'season_xp', xp, 'claimable', greatest(0, reach - coalesce(cl, 0)),
    'duel', public._duel_live(uid));
end $$;


-- ----- ⚖️ Équilibrage de l'économie (👑) : rythme de la partie et richesse de chaque joueur -----
alter table public.game add column if not exists eco_days int not null default 30;      -- durée visée pour finir un cube (jours)
alter table public.game add column if not exists eco_last jsonb;                          -- dernier équilibrage appliqué
create or replace function public.admin_economy() returns json
language plpgsql stable security definer set search_path = public as $$
declare g record;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  select * into g from public.game where id = 1;
  return json_build_object(
    'size', g.size, 'total', g.size::bigint ^ 3, 'destroyed', g.destroyed, 'started_at', g.started_at,
    'days', extract(epoch from now() - g.started_at) / 86400.0,
    'week_days', extract(epoch from now() - coalesce(g.week_start, g.started_at)) / 86400.0, 'week_blocks', g.destroyed - g.week_base,
    'eco_days', g.eco_days, 'eco_last', g.eco_last, 'peeled', g.peeled,
    'players', (select coalesce(json_agg(json_build_object('id', p.id, 'pseudo', p.pseudo, 'admin', p.is_admin,
        'blocks', coalesce(s.blocks, 0), 'found', coalesce(s.artifacts_found, 0), 'used', coalesce(s.artifacts_used, 0),
        'gold_found', coalesce(s.gold_found, 0), 'crafted', coalesce(s.crafted, 0), 'last_seen', s.last_seen,
        'active', coalesce(s.last_seen > now() - interval '7 days', false),
        'inv', (select coalesce(json_object_agg(iv.kind, iv.qty), '{}'::json) from public.inventory iv where iv.player = p.id and iv.qty > 0))
        order by coalesce(s.blocks, 0) desc), '[]'::json)
      from public.profiles p left join public.stats s on s.player = p.id where p.status = 'approved'),
    'hidden', (select coalesce(json_object_agg(kind, n), '{}'::json) from (select kind, count(*) n from public.artifacts where found_by is null group by kind) t),
    'chests', (select json_build_object('coffre', count(*) filter (where not trap), 'faux_coffre', count(*) filter (where trap)) from public.chests where opened_by is null));
end $$;
create or replace function public.admin_set_eco(p_days int default null, p_last jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_days is not null and (p_days < 1 or p_days > 3650) then raise exception 'Durée entre 1 et 3 650 jours'; end if;
  update public.game set eco_days = coalesce(p_days, eco_days),
    eco_last = case when p_last is not null then p_last || jsonb_build_object('at', now()) else eco_last end where id = 1;
  if p_last is not null then perform public._log(auth.uid(), 'economy', p_last); end if;
end $$;

-- ----- 🌍 Classement global : toutes saisons confondues (blocs cassés depuis le tout premier cube) -----
alter table public.profiles add column if not exists blocks_bank bigint not null default 0;      -- blocs des saisons terminées
alter table public.treasure add column if not exists prize_global jsonb not null
  default '[{"or": 150, "megabombe": 1}, {"or": 100, "vrille": 1}, {"or": 60, "bombe": 3}]'::jsonb;  -- lots du top 3 global, à chaque fin de saison
alter table public.game add column if not exists global_note jsonb not null default '[]'::jsonb;  -- « X reçoit sa récompense du classement global »
create or replace function public.global_board() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  return (select coalesce(json_agg(json_build_object('id', x.id, 'pseudo', x.pseudo, 'avatar', x.avatar, 'color', x.color, 'blocks', x.total,
            'season_blocks', x.cur, 'xp', x.xp, 'seasons', x.seasons, 'medals', x.medals) order by x.total desc, x.xp desc), '[]'::json)
    from (select p.id, p.pseudo, p.avatar, p.color, p.blocks_bank + coalesce(s.blocks, 0) as total, coalesce(s.blocks, 0) as cur,
                 p.xp_bank + coalesce(public._xp(s), 0) as xp, p.seasons + case when coalesce(s.blocks, 0) > 0 then 1 else 0 end as seasons, p.medals
          from public.profiles p left join public.stats s on s.player = p.id
          where p.status = 'approved' and p.blocks_bank + coalesce(s.blocks, 0) > 0) x);
end $$;
create or replace function public.admin_set_global_prize(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 3 then raise exception 'Lot invalide'; end if;
  perform public._check_prize(p -> 0); perform public._check_prize(p -> 1); perform public._check_prize(p -> 2);
  update public.treasure set prize_global = p where id = 1;
end $$;

-- Premier remplissage des artefacts
do $$
begin
  if not exists (select 1 from public.artifacts) then
    perform public._regen((select size from public.game where id = 1));      -- artefacts, pièges et coffres
    update public.game set arts_v4 = true, chests_v6 = true, arts_v8 = true where id = 1;
  end if;
end $$;

-- Version 6 : cache une seule fois les coffres dorés dans la partie en cours
do $$
begin
  if not (select chests_v6 from public.game where id = 1) then
    perform public._chests_regen((select size from public.game where id = 1));
    update public.game set chests_v6 = true where id = 1;
  end if;
end $$;

-- Version 8 : compte une seule fois les blocs détruits de chaque couche
do $$
declare s int;
begin
  if not (select layers_v8 from public.game where id = 1) then
    select size into s from public.game where id = 1;
    delete from public.layer_done;
    insert into public.layer_done (d, n) select public._depth(b.i, s), count(*) from public.blocks b where b.hp = 0 group by 1;
    update public.game set layers_v8 = true where id = 1;
  end if;
end $$;

-- Version 8 : cache une seule fois les 10 nouveaux artefacts, les pièges et les faux coffres dans la partie en cours
do $$
begin
  if not (select arts_v8 from public.game where id = 1) then
    perform public._regen((select size from public.game where id = 1),
      array['dynamite', 'trefle', 'sablier', 'fontaine', 'vrille', 'grappe', 'givre', 'chaine', 'tornade', 'pilier',
            'toile', 'lenteur', 'brouillard', 'macon', 'durci', 'pickpocket', 'faux_coffre']);
    update public.game set arts_v8 = true where id = 1;
  end if;
end $$;

-- Version 4 : cache une seule fois les 7 nouveaux artefacts dans la partie en cours
do $$
begin
  if not (select arts_v4 from public.game where id = 1) then
    perform public._regen((select size from public.game where id = 1),
                          array['scie', 'sonde', 'seisme', 'aimant', 'cor', 'ecorce', 'oeil']);
    update public.game set arts_v4 = true where id = 1;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 6. PHOTO DU TRÉSOR (stockage privé)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('tresor', 'tresor', false)
  on conflict (id) do nothing;

drop policy if exists "le_cube_tresor_lire" on storage.objects;
create policy "le_cube_tresor_lire" on storage.objects for select to authenticated
  using (bucket_id = 'tresor' and (public.is_admin() or (public.is_approved() and public.all_done())));

drop policy if exists "le_cube_tresor_ajouter" on storage.objects;
create policy "le_cube_tresor_ajouter" on storage.objects for insert to authenticated
  with check (bucket_id = 'tresor' and public.is_admin());

drop policy if exists "le_cube_tresor_modifier" on storage.objects;
create policy "le_cube_tresor_modifier" on storage.objects for update to authenticated
  using (bucket_id = 'tresor' and public.is_admin());

drop policy if exists "le_cube_tresor_supprimer" on storage.objects;
create policy "le_cube_tresor_supprimer" on storage.objects for delete to authenticated
  using (bucket_id = 'tresor' and public.is_admin());


-- ---------------------------------------------------------------------
-- 7. TEMPS RÉEL PRIVÉ
-- ---------------------------------------------------------------------
drop policy if exists "le_cube_temps_reel_lire" on realtime.messages;
create policy "le_cube_temps_reel_lire" on realtime.messages for select to authenticated
  using (public.is_approved());

drop policy if exists "le_cube_temps_reel_ecrire" on realtime.messages;
create policy "le_cube_temps_reel_ecrire" on realtime.messages for insert to authenticated
  with check (public.is_approved());

-- ---------------------------------------------------------------------
-- VERSION 13 : 🤖 ROBOTS-MINEURS
-- Des modèles réglés par l'organisateur (prix, stock, durée, rythme), achetés en boutique ou donnés,
-- lancés depuis le sac. Un seul robot actif par joueur. Le serveur les fait travailler :
--   🤝 collaborateur : dès qu'il est lancé, jusqu'à la fin de son temps
--   🌙 hors ligne    : seulement quand son propriétaire n'est pas dans le jeu (le temps se met en pause sinon)
-- Le robot casse des blocs de la surface. Son butin va dans le sac du propriétaire, mais ses blocs ne comptent
-- que pour le cube (ni XP, ni classement, ni saison). Il ne touche jamais au cœur. Un piège le met en panne 1 min.
-- ---------------------------------------------------------------------
create table if not exists public.robot_models (
  id bigserial primary key,
  name text not null,
  icon text not null default '🤖',
  kind text not null default 'collab',              -- collab | offline
  minutes int not null default 30,                  -- durée de travail
  rate numeric not null default 1,                  -- coups par seconde
  price int not null default 0,                     -- 0 = pas en vente (on peut quand même le donner)
  stock int,                                        -- null = illimité
  enabled boolean not null default true,
  sold int not null default 0,
  created_at timestamptz not null default now());
alter table public.robot_models enable row level security;

create table if not exists public.robots (
  id bigserial primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  model_id bigint,
  name text not null, icon text not null, kind text not null,
  rate numeric not null, total_sec int not null, left_sec numeric not null,
  status text not null default 'active',            -- active | done | stopped
  started_at timestamptz not null default now(), ended_at timestamptz, broke_until timestamptz,
  hits int not null default 0, blocks int not null default 0, traps int not null default 0,
  loot jsonb not null default '{}'::jsonb,          -- tout ce qu'il a trouvé
  session jsonb not null default '{}'::jsonb,       -- 🌙 ce qu'il a fait depuis le dernier départ du joueur
  seen_end boolean not null default false);         -- bilan de fin déjà montré au propriétaire
alter table public.robots enable row level security;
create index if not exists robots_status on public.robots (status);
create unique index if not exists robots_one_active on public.robots (owner) where status = 'active';
alter table public.game add column if not exists robots_max int not null default 10;     -- robots qui travaillent en même temps (au plus)

-- Les robots sont des objets du sac : « robot:<n° du modèle> »
create or replace function public._check_item(k text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if k ~ '^robot:[0-9]{1,12}$' then
    if not exists (select 1 from public.robot_models where id = substr(k, 7)::bigint) then raise exception 'Objet inconnu'; end if;
    return;
  end if;
  if k is null or not (k = any(public._arts() || array['or', 'silex', 'fer', 'poudre', 'cristal'])) then
    raise exception 'Objet inconnu';
  end if;
end $$;

create or replace function public._robot_json(r public.robots) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', r.id, 'owner', r.owner, 'name', r.name, 'icon', r.icon, 'kind', r.kind, 'rate', r.rate,
    'total', r.total_sec, 'left', round(r.left_sec)::int, 'status', r.status, 'started_at', r.started_at, 'ended_at', r.ended_at,
    'broke', greatest(0, round(extract(epoch from coalesce(r.broke_until, now()) - now())))::int,
    'hits', r.hits, 'blocks', r.blocks, 'traps', r.traps, 'loot', r.loot, 'session', r.session);
$$;
create or replace function public._robot_model_json(m public.robot_models) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', m.id, 'key', 'robot:' || m.id, 'name', m.name, 'icon', m.icon, 'kind', m.kind, 'minutes', m.minutes,
    'rate', m.rate, 'price', m.price, 'stock', m.stock, 'enabled', m.enabled, 'sold', m.sold);
$$;

-- Ce que voit un joueur : les modèles (pour la boutique et le sac), son robot, et le bilan d'un robot qui vient de finir
create or replace function public.robot_info() returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); fin jsonb;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select public._robot_json(r) into fin from public.robots r
    where r.owner = uid and r.status in ('done', 'stopped') and not r.seen_end order by r.id desc limit 1;
  update public.robots set seen_end = true where owner = uid and status in ('done', 'stopped') and not seen_end;
  return json_build_object(
    'models', (select coalesce(json_agg(public._robot_model_json(m) order by m.id), '[]'::json) from public.robot_models m),
    'mine', (select public._robot_json(r) from public.robots r where r.owner = uid and r.status = 'active'),
    'finished', fin);
end $$;

create or replace function public.robot_buy(p_model bigint) returns json
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  select * into m from public.robot_models where id = p_model for update;
  if not found or not m.enabled or m.price <= 0 then raise exception 'Ce robot n''est pas en vente'; end if;
  if m.stock is not null and m.stock <= 0 then raise exception 'Plus aucun robot de ce modèle en stock'; end if;
  perform public._take(auth.uid(), 'or', m.price);
  update public.robot_models set stock = case when stock is null then null else stock - 1 end, sold = sold + 1 where id = p_model;
  perform public._add(auth.uid(), 'robot:' || p_model, 1);
  perform public._log(auth.uid(), 'robot_buy', jsonb_build_object('model', p_model, 'price', m.price));
  return (select public._robot_model_json(x) from public.robot_models x where x.id = p_model);
end $$;

create or replace function public.robot_launch(p_model bigint) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m record; r public.robots;
begin
  if not public.is_approved() then raise exception 'Accès non autorisé'; end if;
  if exists (select 1 from public.robots where owner = uid and status = 'active') then raise exception 'Tu as déjà un robot au travail (un seul à la fois)'; end if;
  select * into m from public.robot_models where id = p_model;
  if not found then raise exception 'Robot inconnu'; end if;
  perform public._take(uid, 'robot:' || p_model, 1);
  insert into public.robots (owner, model_id, name, icon, kind, rate, total_sec, left_sec)
    values (uid, m.id, m.name, m.icon, m.kind, least(5, greatest(0.05, m.rate)), m.minutes * 60, m.minutes * 60)
    returning * into r;
  perform public._log(uid, 'robot_start', jsonb_build_object('name', m.name, 'kind', m.kind, 'minutes', m.minutes));
  return public._robot_json(r);
end $$;

-- ----- 👑 Organisateur -----
create or replace function public.admin_robots() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  return json_build_object(
    'models', (select coalesce(json_agg(public._robot_model_json(m) || jsonb_build_object('owned',
                 (select coalesce(sum(qty), 0) from public.inventory where kind = 'robot:' || m.id)) order by m.id), '[]'::json) from public.robot_models m),
    'active', (select coalesce(json_agg(public._robot_json(r) || jsonb_build_object('pseudo', p.pseudo) order by r.id), '[]'::json)
               from public.robots r join public.profiles p on p.id = r.owner where r.status = 'active'),
    'recent', (select coalesce(json_agg(x.j order by x.id desc), '[]'::json) from (
               select r.id, public._robot_json(r) || jsonb_build_object('pseudo', p.pseudo) j
               from public.robots r join public.profiles p on p.id = r.owner where r.status <> 'active' order by r.id desc limit 8) x),
    'max', (select robots_max from public.game where id = 1),
    'size', (select size from public.game where id = 1), 'max_hp', (select max_hp from public.game where id = 1),
    'left', (select size::bigint * size * size - destroyed from public.game where id = 1),
    'gold_every', (select gold_every from public.game where id = 1), 'mat_every', (select mat_every from public.game where id = 1));
end $$;
create or replace function public.admin_robot_save(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare nid bigint; k text := coalesce(p->>'kind', 'collab'); rt numeric; mi int; st int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Donne un nom au robot'; end if;
  if k not in ('collab', 'offline') then raise exception 'Type de robot invalide'; end if;
  rt := (p->>'rate')::numeric; mi := (p->>'minutes')::int;
  if rt is null or rt < 0.05 or rt > 5 then raise exception 'Rythme entre 0,05 et 5 coups par seconde'; end if;
  if mi is null or mi < 1 or mi > 2880 then raise exception 'Durée entre 1 minute et 48 heures'; end if;
  st := case when p->>'stock' is null or p->>'stock' = '' then null else greatest(0, (p->>'stock')::int) end;
  if (p->>'id') is null then
    insert into public.robot_models (name, icon, kind, minutes, rate, price, stock, enabled)
      values (left(trim(p->>'name'), 40), left(coalesce(nullif(p->>'icon', ''), '🤖'), 8), k, mi, round(rt, 2),
              greatest(0, coalesce((p->>'price')::int, 0)), st, coalesce((p->>'enabled')::boolean, true))
      returning id into nid;
  else
    nid := (p->>'id')::bigint;
    update public.robot_models set name = left(trim(p->>'name'), 40), icon = left(coalesce(nullif(p->>'icon', ''), '🤖'), 8), kind = k,
      minutes = mi, rate = round(rt, 2), price = greatest(0, coalesce((p->>'price')::int, 0)), stock = st,
      enabled = coalesce((p->>'enabled')::boolean, true) where id = nid;
    if not found then raise exception 'Robot inconnu'; end if;
  end if;
  return (select public._robot_model_json(m) from public.robot_models m where m.id = nid);
end $$;
create or replace function public.admin_robot_delete(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if exists (select 1 from public.inventory where kind = 'robot:' || p_id and qty > 0) then
    raise exception 'Des joueurs ont encore ce robot dans leur sac : retire-le plutôt de la vente';
  end if;
  delete from public.robot_models where id = p_id;
end $$;
create or replace function public.admin_robot_config(p_max int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.game set robots_max = least(50, greatest(1, coalesce(p_max, 10))) where id = 1;
end $$;
create or replace function public.admin_robot_stop(p_id bigint) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.robots set status = 'stopped', ended_at = now() where status = 'active' and (p_id is null or id = p_id);
  get diagnostics n = row_count;
  return n;
end $$;

-- ----- Le travail d'un robot (appelé par le serveur, jamais par le jeu) -----
-- idx / n : blocs visés et nombre de coups sur chacun · p_dt : secondes de travail écoulées
create or replace function public._robot_strike(p_rid bigint, idx int[], n int[], p_dt numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.robots; g record; s int; k int; m int; v smallint; st0 record; e record;
  cells int[] := '{}'; vals int[] := '{}'; broke int[] := '{}'; rw jsonb; nb int := 0; tot int := 0; nt int := 0;
  depths int[]; lts text[]; msgs text[] := '{}'; dl text; wk text; add jsonb := '{}'::jsonb; res jsonb := '[]'::jsonb; nch int := 0; part text[];
begin
  select * into r from public.robots where id = p_rid and status = 'active' for update;
  if not found then return null; end if;
  select * into g from public.game where id = 1;
  s := g.size;
  if coalesce(array_length(idx, 1), 0) > 0 and (r.broke_until is null or r.broke_until <= now()) then
    perform public._week_roll();
    insert into public.stats (player) values (r.owner) on conflict (player) do nothing;
    select * into st0 from public.stats where player = r.owner;
    for k in 1 .. least(array_length(idx, 1), 200) loop
      continue when idx[k] is null or idx[k] < 0 or idx[k] >= s * s * s;
      continue when public._is_core(idx[k], s);                       -- 💎 le cœur est réservé aux humains
      continue when public._depth(idx[k], s) < g.peeled;
      m := least(greatest(coalesce(n[k], 1), 1), g.max_hp);
      v := null;
      insert into public.blocks as b (i, hp) values (idx[k], greatest(g.max_hp - m, 0))
        on conflict (i) do update set hp = greatest(b.hp - m, 0) where b.hp > 0
        returning b.hp into v;
      if v is null then continue; end if;
      tot := tot + m;
      res := res || jsonb_build_array(jsonb_build_array(idx[k], v::int));
      if v = 0 then broke := broke || idx[k]; end if;
    end loop;
    nb := coalesce(array_length(broke, 1), 0);
    -- butin : dans le sac du propriétaire (« à distance » : les pièges ne lui font rien)
    rw := public._reward_set(broke, r.owner, 1, false);
    -- … mais rien pour son classement ni son XP : ses statistiques reviennent comme avant
    update public.stats set gold_found = st0.gold_found, materials_found = st0.materials_found, chests = st0.chests,
      artifacts_found = st0.artifacts_found, last_seen = st0.last_seen where player = r.owner;
    nt := coalesce(jsonb_array_length(rw->'t'), 0);
    -- ce qu'il a trouvé
    lts := array(select jsonb_array_elements_text(coalesce(rw->'loots', '[]'::jsonb)));
    for e in select split_part(x, ':', 1) as k2, sum(split_part(x, ':', 2)::int)::int as q from unnest(lts) x group by 1 loop
      add := add || jsonb_build_object(e.k2, coalesce((add->>e.k2)::int, 0) + e.q);
    end loop;
    for e in select value #>> '{}' as k2 from jsonb_each(coalesce(rw->'a', '{}'::jsonb)) loop
      add := add || jsonb_build_object(e.k2, coalesce((add->>e.k2)::int, 0) + 1);
    end loop;
    for e in select value #>> '{}' as c from jsonb_each(coalesce(rw->'c', '{}'::jsonb)) loop
      nch := nch + 1;
      part := string_to_array(e.c, ':');
      if part[1] = 'piege' then continue; end if;
      if part[1] = 'art' then add := add || jsonb_build_object(part[2], coalesce((add->>part[2])::int, 0) + coalesce(part[3]::int, 1));
      else add := add || jsonb_build_object(part[1], coalesce((add->>part[1])::int, 0) + coalesce(part[2]::int, 1)); end if;
    end loop;
    if nch > 0 then add := add || jsonb_build_object('_coffres', nch); end if;
    -- le cube et les objectifs communs avancent
    if nb > 0 then
      depths := array(select public._depth(z, s) from unnest(broke) z);
      dl := public._daily_track(nb, depths, lts, nch, 0, 0);
      if dl is not null then msgs := msgs || dl; end if;
      update public.game set destroyed = destroyed + nb where id = 1;
      wk := public._week_check();
      if wk is not null then msgs := msgs || wk; end if;
    end if;
  end if;
  -- mise à jour du robot
  update public.robots set
    hits = hits + tot, blocks = blocks + nb, traps = traps + least(nt, 1),
    loot = (select coalesce(jsonb_object_agg(key, val), '{}'::jsonb) from (
              select key, sum(value::int) as val from (select * from jsonb_each_text(loot) union all select * from jsonb_each_text(add)) u group by key) z),
    session = (select coalesce(jsonb_object_agg(key, val), '{}'::jsonb) from (
              select key, sum(value::int) as val from (select * from jsonb_each_text(session) union all select * from jsonb_each_text(add || jsonb_build_object('_blocs', nb))) u group by key) z),
    broke_until = case when nt > 0 then now() + interval '60 seconds' else broke_until end,
    left_sec = greatest(0, left_sec - greatest(0, coalesce(p_dt, 0)))
    where id = p_rid returning * into r;
  if r.left_sec <= 0 then
    update public.robots set status = 'done', ended_at = now() where id = p_rid returning * into r;
    perform public._log(r.owner, 'robot_end', jsonb_build_object('name', r.name, 'blocks', r.blocks));
  end if;
  return public._robot_json(r) || jsonb_build_object('r', res, 'trap', nt > 0, 'msgs', to_jsonb(msgs), 'add', add, 'nb', nb);
end $$;
-- 🌙 le propriétaire revient : on lui rend le bilan de son absence et on remet le compteur à zéro
create or replace function public._robot_session_take(p_rid bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ses jsonb;
begin
  select session into ses from public.robots where id = p_rid for update;
  update public.robots set session = '{}'::jsonb where id = p_rid;
  return ses;
end $$;

-- Première connexion d'un joueur (version 13.8) : pour prévenir l'organisateur quand un nouveau venu entre dans le cube.
-- Les joueurs qui ont déjà joué sont marqués comme « déjà venus » (ceux qui ne sont jamais venus restent à prévenir).
alter table public.profiles add column if not exists first_seen timestamptz;
update public.profiles p set first_seen = coalesce(st.last_seen, p.created_at)
  from public.stats st where st.player = p.id and p.first_seen is null and st.last_seen is not null;
update public.profiles set first_seen = coalesce(first_seen, created_at) where is_admin and first_seen is null;

-- 📱 Appareils des joueurs (version 14.9) : fiche technique de chaque appareil (navigateur) qui se connecte, visible par l'organisateur
create table if not exists public.devices (
  player     uuid not null references public.profiles(id) on delete cascade,
  devid      text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  sessions   int not null default 0,
  info       jsonb not null default '{}'::jsonb,
  perf       jsonb not null default '{}'::jsonb,
  ip         text not null default '',
  ips        jsonb not null default '[]'::jsonb,
  country    text not null default '',
  region     text not null default '',
  city       text not null default '',
  primary key (player, devid)
);
alter table public.devices enable row level security;
revoke all on public.devices from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. SÉCURITÉ : les fonctions internes (« _… ») ne sont jamais appelables depuis le jeu
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like '\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Fin. Tu peux fermer cette page.

-- recalcule le compteur de blocs détruits à chaque démarrage / mise à jour.
-- Les couches arrachées par l'Écorce du Monde ne sont pas enregistrées bloc par bloc : on compte leur volume entier,
-- plus les blocs cassés dans les couches restantes.
update public.game g set destroyed =
    (g.size::bigint ^ 3 - greatest(g.size - 2 * coalesce(g.peeled, 0), 0)::bigint ^ 3)::bigint
  + (select count(*) from public.blocks b where b.hp = 0 and public._depth(b.i, g.size) >= coalesce(g.peeled, 0))
  where g.id = 1;
