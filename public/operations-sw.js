/* Public shell only. Ledger data and credentials never enter CacheStorage. */
const PUBLIC_CACHE = "subscription-butler-public-v1";
function publicAsset(url) {
  return url.origin === self.location.origin &&
    ((url.pathname.startsWith("/_next/static/") && /\.(?:js|css|woff2?|png|jpe?g|svg|ico)$/.test(url.pathname)) || ["/icon.svg", "/favicon.ico"].includes(url.pathname));
}
async function cacheAssets(urls) {
  const cache = await caches.open(PUBLIC_CACHE);
  await Promise.allSettled(urls.filter(value => typeof value === "string").map(async value => {
    const url = new URL(value, self.location.origin); if (!publicAsset(url)) return;
    const response = await fetch(url.href, { credentials: "omit", cache: "reload" });
    if (response.ok) await cache.put(url.href, response);
  }));
}
async function cachePublicShell() {
  // /workspace is a public, client-only shell. Never cache server flight/RSC
  // responses, query variants, /login, legacy pages or any /api response.
  const response = await fetch("/workspace", { credentials: "omit", headers: { accept: "text/html" }, cache: "reload" });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
  const html = await response.clone().text();
  await (await caches.open(PUBLIC_CACHE)).put("/workspace", response);
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&"));
  await cacheAssets(urls);
}
self.addEventListener("install", event => { event.waitUntil(cachePublicShell().catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("subscription-butler-public-") && key !== PUBLIC_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("message", event => {
  if (event.data?.type === "CACHE_PUBLIC_ASSETS" && Array.isArray(event.data.urls) && event.data.urls.length <= 300) event.waitUntil(cacheAssets(event.data.urls));
  if (event.data?.type === "REFRESH_PUBLIC_SHELL") event.waitUntil(cachePublicShell().catch(() => {}));
});
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/login") return;
  if (request.mode === "navigate" && url.pathname === "/workspace" && !url.search) {
    event.respondWith(fetch(request).then(async response => {
      if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
        await (await caches.open(PUBLIC_CACHE)).put("/workspace", response.clone());
        event.waitUntil(cachePublicShell().catch(() => {}));
      }
      return response;
    }).catch(async () => (await caches.open(PUBLIC_CACHE)).match("/workspace") || new Response("工作台尚未缓存。请联网打开一次后再离线使用。", { status: 503, headers: { "content-type": "text/plain;charset=utf-8" } })));
  } else if (publicAsset(url)) {
    event.respondWith(caches.open(PUBLIC_CACHE).then(async cache => {
      const cached = await cache.match(url.href); if (cached) return cached;
      const response = await fetch(url.href, { credentials: "omit" }); if (response.ok) await cache.put(url.href, response.clone()); return response;
    }));
  }
});
