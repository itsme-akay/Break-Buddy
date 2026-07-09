self.addEventListener("install", (e) => {
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  // network passthrough — no offline caching yet
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Break Buddies";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/assest/Icons/coffe-icon.webp",
      badge: "/assest/Icons/coffe-icon.webp",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  const params = new URL(url, self.location.origin).searchParams;
  const openChat = params.get("openChat");
  const mine = params.get("mine");
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if (openChat && "postMessage" in c) c.postMessage({ type: "openChat", pingId: openChat, mine: mine === "1" });
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
