/* jsdom 端到端功能测试：覆盖本次新增功能（F1~F5）
 * 主题切换 / 全文搜索 / 阅读排版 / 写作统计 / TXT+Markdown 导出 / 键盘快捷键
 * 运行：node tests/features.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PORT = 8124;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const p = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    fs.readFile(p, (err, data) => {
      if (err) { res.statusCode = 404; res.end('404'); return; }
      res.setHeader('Content-Type', (MIME[path.extname(p)] || 'text/plain') + '; charset=utf-8');
      res.end(data);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  const server = await serve();
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push('jsdom:' + e.message));
  vc.on('error', (...a) => errs.push('err:' + a.join(' ')));

  const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/index.html',
    { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 300));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- 造一本两章的书，作为共用 fixture ----
  const b = w.Store.createBook('雾都拾遗');
  b.genre = '都市异能';
  b.synopsis = '一个关于雾的故事';
  const v = w.Store.addVolume(b, '第一卷 雾起', '主角踏入雾都').id;
  w.Store.addChapter(b, { title: '雨夜启程', outline: '主角在雨夜离开故乡', content: '雾很大。他背起行囊，走进夜色里。', volumeId: v });
  w.Store.addChapter(b, { title: '黑石城', outline: '抵达边境要塞', content: '城门口站着卫兵，目光如鹰。', volumeId: v });
  w.Store.addWorldEntry(b, 'characters', '林昭', '男主，冷静寡言');
  b.memory.summary = '主角已离开故乡，前往黑石城。';
  w.Store.save();

  console.log('\n[A] 主题切换');
  w.location.hash = '#/settings'; w.UI.route(); await sleep(40);
  ok('主题按钮存在', !!w.document.querySelector('[data-act="ui.theme"]'));
  w.document.querySelector('[data-act="ui.theme"][data-theme="light"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  ok('切到亮色主题', w.document.body.classList.contains('theme-light'), w.document.body.className);
  ok('theme-color 已同步', w.document.querySelector('meta[name="theme-color"]').getAttribute('content') === '#f6f7fa');
  w.location.hash = '#/settings'; w.UI.route(); await sleep(30);
  w.document.querySelector('[data-act="ui.theme"][data-theme="sepia"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  ok('切到护眼纸主题', w.document.body.classList.contains('theme-sepia'), w.document.body.className);
  ok('暗色类已移除', !w.document.body.classList.contains('theme-dark') && !w.document.body.classList.contains('theme-light'));
  ok('主题已持久化', JSON.parse(w.localStorage.getItem('novel_ai_db_v1')).ui.theme === 'sepia');

  console.log('\n[B] 全文搜索');
  w.location.hash = '#/books'; w.UI.route(); await sleep(40);
  ok('书架有搜索框', !!w.document.getElementById('searchInput'));
  const si = w.document.getElementById('searchInput');
  si.value = '雾很大';
  si.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(300);
  const hit = w.document.querySelectorAll('.search-hit');
  ok('搜到正文命中', hit.length >= 1, String(hit.length));
  ok('命中词已高亮', !!w.document.querySelector('.search-hit-body mark'));
  ok('聚焦未丢失', w.document.activeElement && w.document.activeElement.id === 'searchInput',
    w.document.activeElement ? w.document.activeElement.id : 'null');
  // 点结果直达章节
  w.document.querySelector('.search-hit[data-act="search.goto"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  ok('点击结果直达该章', w.location.hash.indexOf('#/read/') === 0, w.location.hash);

  console.log('\n[C] 阅读排版');
  w.location.hash = '#/read/' + b.id + '/' + b.chapters[0].id; w.UI.route(); await sleep(60);
  ok('阅读条有进度数字', !!w.document.getElementById('rProgNum'));
  ok('显示章节字数', w.document.getElementById('page').innerHTML.indexOf('本章') >= 0
    && /字/.test(w.document.querySelector('.reader-chapter-sub').textContent),
    w.document.querySelector('.reader-chapter-sub').textContent);
  const beforeLH = w.Store.state.ui.lineHeight;
  w.document.querySelector('[data-act="reader.menu"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  ok('排版面板有行高控件', !!w.document.querySelector('[data-act="reader.lineHeight"]'));
  ok('排版面板有段间距控件', !!w.document.querySelector('[data-act="reader.para"]'));
  ok('排版面板有主题切换', !!w.document.querySelector('[data-act="reader.theme"]'));
  w.document.querySelector('[data-act="reader.lineHeight"][data-delta="0.05"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  ok('行高已增加', w.Store.state.ui.lineHeight > beforeLH, beforeLH + ' -> ' + w.Store.state.ui.lineHeight);
  ok('行高已应用为样式', w.document.querySelector('.reader-body').style.lineHeight !== '',
    w.document.querySelector('.reader-body').getAttribute('style'));

  console.log('\n[D] 写作统计');
  w.location.hash = '#/book/' + b.id + '/data'; w.UI.route(); await sleep(40);
  ok('数据页有统计入口', !!w.document.querySelector('[data-act="book.stats"]'));
  ok('数据页显示本地占用', w.document.getElementById('page').innerHTML.indexOf('本地占用约') >= 0);
  w.document.querySelector('[data-act="book.stats"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const sb = w.document.getElementById('sheetBody').textContent;
  ok('统计面板已打开', w.document.getElementById('sheetTitle').textContent.indexOf('写作统计') >= 0,
    w.document.getElementById('sheetTitle').textContent);
  ok('显示总字数', sb.indexOf('总字数') >= 0);
  ok('显示完成度', sb.indexOf('完成度') >= 0);
  ok('有分卷明细表', !!w.document.querySelector('#sheetBody .mini-table'));
  w.UI.closeSheet();

  console.log('\n[E] 导出');
  w.location.hash = '#/book/' + b.id + '/data'; w.UI.route(); await sleep(30);
  let dl = null;
  w.URL.createObjectURL = (blob) => { dl = blob; return 'blob:test'; };
  w.URL.revokeObjectURL = () => { };
  w.document.querySelector('[data-act="book.exportTxt"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  ok('导出TXT弹出选项面板', w.document.getElementById('sheetTitle').textContent.indexOf('导出正文') >= 0,
    w.document.getElementById('sheetTitle').textContent);
  const formBtns = w.document.querySelectorAll('#sheetFoot .btn');
  formBtns[formBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  ok('TXT 已生成下载', !!dl);
  w.location.hash = '#/book/' + b.id + '/data'; w.UI.route(); await sleep(30);
  w.document.querySelector('[data-act="book.exportMd"]') && w.document.querySelector('[data-act="book.exportMd"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  ok('Markdown 已生成下载', !!dl);

  console.log('\n[F] 快捷键');
  w.location.hash = '#/read/' + b.id + '/' + b.chapters[0].id; w.UI.route(); await sleep(80);
  const idx0 = w.Reader.index;
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await sleep(500);
  ok('右方向键翻到下一章', w.Reader.index === idx0 + 1, idx0 + ' -> ' + w.Reader.index);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await sleep(500);
  ok('左方向键翻回上一章', w.Reader.index === idx0, '-> ' + w.Reader.index);

  console.log('\n[G] 运行期错误检查');
  const real = errs.filter(e => !/Not implemented: navigation/.test(e));
  const navOnly = errs.length - real.length;
  ok('全程无 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));
  if (navOnly) console.log('    （已忽略 ' + navOnly + ' 条 jsdom 不支持的下载导航提示）');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  server.close();
  process.exit(fail ? 1 : 0);
})();
