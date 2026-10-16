/* =========================================================
 * Service Worker —— 让本工具能离线打开、能装到桌面（PWA）
 *
 * 策略：**同源请求一律 network-first**，网络不通时才回落到缓存。
 *
 * 为什么不用 stale-while-revalidate（v9 之前是这么做的，踩过坑）：
 *   1. 「先给缓存、后台再拉新的」意味着 git pull 之后**第一次打开必定是旧版**；
 *   2. 更糟的是那个后台请求会走浏览器的 HTTP 缓存，而 `python3 -m http.server`
 *      只发 Last-Modified、不发 Cache-Control，浏览器会按启发式规则把旧文件
 *      当成「还新鲜」直接返回——于是「重新验证」把旧字节又写回了缓存，永远新不了。
 *   3. sw.js 本身每次发版都是一模一样的字节，浏览器判定「SW 没变」就不会
 *      install/activate，预缓存那一步也不会重跑。
 * 对一个本地工具来说，服务器几乎总是在线，新代码立刻可见比省几十毫秒重要得多。
 *
 * 数据全在 localStorage 里，SW 不碰也不上传任何数据。
 * ========================================================= */
var VERSION = '9.0.0';
var CACHE = 'novel-writer-' + VERSION;
var ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/util.js', './js/store.js', './js/api.js', './js/ai.js', './js/ui.js', './js/app.js',
  './img/icon.svg'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // cache:'reload' 强制回源校验，别让 HTTP 缓存把旧字节喂进来
      return Promise.all(ASSETS.map(function (u) {
        return fetch(new Request(u, { cache: 'reload' }))
          .then(function (res) { if (res && res.ok) return c.put(u, res); })
          .catch(function () { /* 缺资源不影响安装 */ });
      }));
    })
  );
});

/* 版本号一变，旧缓存在这里被清掉 */
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* 界面上的「强制刷新」用它清干净缓存 */
self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'CACHE_VERSION' && e.source) e.source.postMessage({ type: 'CACHE_VERSION', version: VERSION });
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  // 跨域请求一律放行：AI 接口绝不能走缓存
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    // cache:'reload'：绕过 HTTP 缓存回源，避免「网络明明通着却拿到旧文件」。
    // 基于 req 构造而不是 req.url，这样 method / headers / mode / credentials 都原样保留。
    fetch(new Request(req, { cache: 'reload' }))
      .then(function (res) {
        if (res && res.ok && res.type !== 'opaque') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () { });
        }
        return res;
      })
      .catch(function () {
        // 离线 / 请求失败：回落到缓存；导航请求再退到首页，免得白屏
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
      })
  );
});
