// Le Cube : petit « service worker » qui permet d'installer le jeu comme une application.
// Il ne garde rien en cache : le jeu est toujours chargé à jour depuis le serveur.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Le Cube</title>' +
    '<body style="margin:0;background:#0d0f14;color:#eef1f8;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center">' +
    '<div><p style="font-size:42px;margin:0">🧊</p><p>Le serveur du Cube est injoignable pour le moment.<br>The Cube server cannot be reached right now.</p>' +
    '<p><button onclick="location.reload()" style="font-size:16px;padding:10px 18px;border-radius:10px;border:0;background:#ffc83d">↻</button></p></div>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

// 🔔 Notifications sur le téléphone (même jeu fermé) : envoyées par le serveur du Cube
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Le Cube', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Le Cube', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: 'icon-192.png', badge: 'icon-192.png',
    data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) { c.postMessage({ type: 'notif', url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
