/* =========================================================
 * Service Worker —— 让本工具能离线打开、能装到桌面（PWA）
 *
 * 只做一件事：把同源的静态资源缓存下来，之后断网也能用。
 * 采用 stale-while-revalidate：先给缓存版本保证秒开，同时后台拉一份新的，
 * 下次打开就是最新代码（这样 git pull 之后不用手动清缓存）。
 *
 * 注意：数据全在 localStorage / 浏览器存储里，SW 不碰也不上传任何数据。
 * ========================================================= */
var CACHE = 'novel-writer-v1';
var ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/util.js', './js/store.js', './js/api.js', './js/ai.js', './js/ui.js', './js/app.js',
  './img/icon.svg'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).catch(function () { /* 缺资源不影响安装 */ })
  );
});

/* 每次更新版本号后，旧缓存在这里被清掉 */
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  // 跨域请求一律放行：AI 接口绝不能走缓存
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        }).catch(function () { });
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
