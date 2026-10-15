#!/usr/bin/env node
/* =========================================================
 * 构建「单文件版」：把 css / js 全部内联进 index.html，
 * 产出一个 dist/index.html —— 双击就能用，不用起服务器。
 *
 *   node build/single-file.js
 *
 * 用途：有些场景不方便起 http 服务（比如直接在手机上打开文件、
 * 把一份拷贝发给别人），file:// 下外链资源与 localStorage 都可能受限。
 * 单文件版把这两个问题都绕开。
 *
 * 注意：单文件版不注册 Service Worker（file:// 协议下不可用），
 * 所以这里会把 manifest 引用一并去掉，避免控制台报错。
 * ========================================================= */
'use strict';

var fs = require('fs');
var path = require('path');

var root = path.resolve(__dirname, '..');
var indexFile = path.join(root, 'index.html');
var outDir = path.join(root, 'dist');

var html = fs.readFileSync(indexFile, 'utf8');

// 内联样式
html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, function (m, href) {
  var css = fs.readFileSync(path.join(root, href), 'utf8');
  return '<style>\n' + css + '\n</style>';
});

// 内联脚本（用函数式替换，避免 $& 之类被当成替换模式）
html = html.replace(/<script\s+src="([^"]+)"\s*>\s*<\/script>/g, function (m, src) {
  var js = fs.readFileSync(path.join(root, src), 'utf8');
  // 保险起见：万一脚本里出现 </script> 字面量，拆开它，否则会提前闭合标签
  js = js.replace(/<\/script>/gi, '<\\/script>');
  return '<script>\n' + js + '\n</script>';
});

// 单文件版走不了 PWA
html = html.replace(/<link\s+rel="manifest"[^>]*>/g, '');

/* 图标内联成 data URI：图标是 svg，直接 base64 嵌进去只有几百字节，
 * 不内联的话 file:// 下会 404（控制台一条红，虽然不影响功能，但看着像坏了）。 */
html = html.replace(/<link\s+([^>]*?)href="([^"]+\.svg)"([^>]*)>/g, function (m, pre, href, post) {
  var f = path.join(root, href);
  if (!fs.existsSync(f)) return m;
  var b64 = fs.readFileSync(f).toString('base64');
  return '<link ' + pre + 'href="data:image/svg+xml;base64,' + b64 + '"' + post + '>';
});

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
var outFile = path.join(outDir, 'index.html');
fs.writeFileSync(outFile, html, 'utf8');

var left = html.match(/<script\s+src=|<link\s+rel="stylesheet"/g);
console.log('已生成 ' + path.relative(root, outFile) +
  '（' + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0) + ' KB）');
if (left && left.length) {
  console.warn('⚠ 还有 ' + left.length + ' 处外链没被内联，请检查 index.html 的引用方式');
}
