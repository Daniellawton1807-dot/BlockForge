/* Homebase service worker: shows push notifications and opens the right page when one is tapped.
   It deliberately caches nothing, so the site never serves an out-of-date copy of itself. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { title: "Homebase", body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(m.title || "Homebase", {
    body: m.body || "", tag: m.tag || undefined, renotify: Boolean(m.tag),
    icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: m.url || "/" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of open) if (c.url.startsWith(self.location.origin)) { await c.focus(); return c.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
