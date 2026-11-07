const CACHE_NAME = "earthquake-monitor-shell-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title:"地震モニター", body:event.data ? event.data.text() : "新しい防災情報があります。" };
  }
  const title = payload.title || "地震モニター";
  const options = {
    body:payload.body || "新しい地震情報を受信しました。",
    icon:"./icons/icon.svg",
    badge:"./icons/icon.svg",
    tag:payload.code && payload.id ? "eqm-" + payload.code + "-" + payload.id : "eqm-earthquake",
    renotify:true,
    data:{ url:payload.url || "./", event:payload.event || null },
    requireInteraction:Number(payload.code) === 556
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        if (event.notification.data?.url) client.navigate(new URL(event.notification.data.url, self.registration.scope).href);
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(event.notification.data?.url || "./");
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(async () => (await caches.match("./index.html")) || Response.error())
    );
    return;
  }

  if (APP_SHELL.some((path) => new URL(path, self.registration.scope).pathname === url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
  }
});
