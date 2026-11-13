/**
 * TopicScope 最小离线 Service Worker（原生 JS，零依赖）。
 *
 * 策略：
 *   - install：预缓存应用外壳（'/'、'/index.html'）与离线快照 JSON；
 *     快照路径与 lib/data/snapshot.ts 的 SNAPSHOT_URL 保持一致。
 *   - 导航请求：network-first，失败回退缓存的外壳，保证断网刷新/重开仍能加载。
 *   - 同源静态资源：cache-first + stale-while-revalidate（先返回缓存，后台更新）。
 *   - activate：清理旧版本缓存。
 *   - 服务端 Function 接口（/functions/）与跨源请求一律不拦截、不缓存，
 *     避免把检索/AI 结果当成静态资源冻结。
 */

const VERSION = "topicscope-v1";
const SHELL_CACHE = VERSION + "-shell";
const ASSET_CACHE = VERSION + "-assets";
const KEEP_CACHES = [SHELL_CACHE, ASSET_CACHE];

/** 与 lib/data/snapshot.ts 的 SNAPSHOT_URL 一致（sw.js 无法 import TS，故在此同步声明）。 */
const SNAPSHOT_URL = "/data/snapshot-medical-segmentation.json";
const PRECACHE_URLS = ["/", "/index.html", SNAPSHOT_URL];
const SHELL_FALLBACK = "/index.html";

const STATIC_EXTENSION =
  /\.(?:js|mjs|css|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|map|webmanifest|txt)$/i;
const STATIC_PREFIXES = ["/assets/", "/data/", "/fonts/"];

const OFFLINE_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>TopicScope · 离线</title></head>" +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.7">' +
  "<h1 style=\"font-size:1rem\">当前离线，且没有可用的缓存外壳</h1>" +
  "<p style=\"font-size:.875rem\">请联网后刷新一次，静态资源与离线快照会被缓存，之后断网也能打开。</p>" +
  "</body></html>";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个 add：单个资源缺失不应让整个外壳安装失败。
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((error) => {
            console.warn("[sw] 预缓存失败:", url, error);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => KEEP_CACHES.indexOf(key) === -1).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

/** 只处理同源、GET、非服务端接口的静态请求。 */
function isCacheableStatic(url, request) {
  if (url.pathname === "/sw.js") return false;
  if (url.pathname.indexOf("/functions/") === 0) return false;
  if (request.destination === "document") return false;
  if (STATIC_PREFIXES.some((prefix) => url.pathname.indexOf(prefix) === 0)) return true;
  return STATIC_EXTENSION.test(url.pathname);
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === "basic") {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_FALLBACK, response.clone());
      await cache.put("/", response.clone());
    }
    return response;
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE);
    const cached =
      (await cache.match(request)) ||
      (await cache.match(SHELL_FALLBACK)) ||
      (await cache.match("/"));
    if (cached) return cached;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function staleWhileRevalidate(event) {
  const request = event.request;
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  const revalidate = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === "basic") {
        return cache.put(request, response.clone()).then(() => response);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // 先返回缓存，后台更新（waitUntil 保证 SW 不被提前终止）。
    event.waitUntil(revalidate);
    return cached;
  }

  const response = await revalidate;
  if (response) return response;
  return new Response("离线且无缓存: " + new URL(request.url).pathname, {
    status: 504,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.pathname.indexOf("/functions/") === 0) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (isCacheableStatic(url, request)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});