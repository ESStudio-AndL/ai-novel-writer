/* 第四轮改造 · jsdom 端到端测试：正文【【】】框选 → 只改框里的内容
 *   [A] 在正文编辑里加框 → 阅读器高亮显示（方括号不显示）→ 阅读条出现「🖍 N」
 *   [B] 打开面板：每个框一条，意见框就嵌在条目里（不全屏）
 *   [C] 应用：请求带上框里的原文与意见；只改框内，方括号自动去掉，其余一字不动
 *   [D] 撤销 / 取消标记
 *   [E] 正文里删掉框后，高亮与计数跟着走，孤儿意见被清
 * 运行：node tests/round4ui.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PORT = 8129;
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
  w.addEventListener('error', e => errs.push('window.error: ' + (e.message || e)));
  await new Promise(r => w.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 300));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => w.document.querySelector(s);
  const $$ = s => Array.from(w.document.querySelectorAll(s));
  const click = (selOrEl) => {
    const el = typeof selOrEl === 'string' ? $(selOrEl) : selOrEl;
    if (!el) throw new Error('找不到元素：' + selOrEl);
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return el;
  };
  const sheetBtn = (text) => $$('#sheetFoot .btn').filter(b2 => b2.textContent.indexOf(text) >= 0)[0];
  function typeInto(el, val) {
    el.value = val;
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  }

  // ---- 假 API ----
  const enc = new w.TextEncoder();
  const seen = [];
  let patchReply = null;
  w.fetch = async (url, opt) => {
    const body = opt && opt.body ? JSON.parse(opt.body) : {};
    seen.push({ url: String(url), body: body });
    const msgs = JSON.stringify(body.messages || []);
    if (body.stream) {
      const ev = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '流式正文' } }] }) +
        '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }) +
        '\n\ndata: [DONE]\n\n';
      let done = false;
      return {
        ok: true, status: 200,
        body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: enc.encode(ev) }) }) },
        text: async () => '', json: async () => ({})
      };
    }
    const isPatch = msgs.indexOf('框选处局部修改') >= 0 || msgs.indexOf('需要修改的片段') >= 0;
    const content = isPatch
      ? JSON.stringify({ patches: patchReply || [] })
      : JSON.stringify({ summary: '前情摘要', points: ['要点'] });
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({ choices: [{ message: { content: content } }], usage: { prompt_tokens: 500, completion_tokens: 60 } })
    };
  };

  // ---- fixture ----
  const Store = w.Store;
  Store.state.providers = [
    { id: 'p1', name: '主力', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-123456', model: 'big-1' }
  ];
  Store.state.activeProviderId = 'p1';
  Store.state.modelPresets = [
    { id: 'm1', name: '主笔', providerId: 'p1', model: 'big-1', task: 'write' },
    { id: 'm2', name: '改稿', providerId: 'p1', model: 'cheap-1', task: 'patch' }
  ];
  Store.state.activePresetId = 'm1';
  Store.state.ui.injectPreview = false;
  const b = Store.createBook('框选改稿测试');
  const v1 = Store.addVolume(b, '第一卷', '雾起').id;
  const c1 = Store.addChapter(b, { title: '雨夜', outline: '主角雨夜入城', volumeId: v1 });

  const P1 = '雨点砸在石板路上，他没有撑伞。';
  const P2 = '城门在身后合拢，发出沉闷的响声。';
  const P3 = '他抬脚往前走，靴子里灌满了水。';
  // 作者在正文里自己加了两个框
  c1.content = P1 + '城门在身后合拢，【【发出沉闷的响声】】。' + P3;
  Store.save();

  const c = () => Store.getChapter(b, c1.id);
  const mkCount = () => w.Reader.liveMarkCount(c());

  w.location.hash = '#/read/' + b.id + '/' + c1.id;
  w.UI.route();
  await sleep(150);

  /* ============================================================
   [A] 正文里的框被识别
   ============================================================ */
  console.log('\n[A] 框被识别并高亮');
  ok('阅读器渲染出正文', !!$('.reader-content'));
  ok('识别出一处框', mkCount() === 1, String(mkCount()));

  const marks = $$('.reader-content mark.mk');
  ok('画出一处高亮', marks.length === 1, String(marks.length));
  ok('高亮只包住框里的字', marks[0].textContent === '发出沉闷的响声', marks[0].textContent);
  ok('高亮带序号', marks[0].getAttribute('data-n') === '1');
  ok('正文里看不到方括号',
    $('.reader-content').textContent.indexOf('【【') < 0 &&
    $('.reader-content').textContent.indexOf('】】') < 0,
    $('.reader-content').textContent);
  ok('读者看到的正文 = 去掉方括号的正文',
    $('.reader-content').textContent ===
    '雨点砸在石板路上，他没有撑伞。城门在身后合拢，发出沉闷的响声。他抬脚往前走，靴子里灌满了水。',
    $('.reader-content').textContent);
  ok('没框的地方一字未动',
    $('.reader-content').textContent.indexOf(P1) >= 0 && $('.reader-content').textContent.indexOf(P3) >= 0);
  ok('阅读条上出现「🖍 1」', !!$('.reader-bar [data-act="mark.list"]') &&
    $('.reader-bar [data-act="mark.list"]').textContent.indexOf('1') >= 0,
    $('.reader-bar [data-act="mark.list"]') && $('.reader-bar [data-act="mark.list"]').textContent);

  /* ============================================================
   [B] 面板：每个框一条，意见框嵌在条目里
   ============================================================ */
  console.log('\n[B] 逐条填意见（不全屏）');
  click($('.reader-bar [data-act="mark.list"]'));
  await sleep(120);
  ok('打开框选改稿面板', $('#sheetTitle').textContent.indexOf('框选改稿') >= 0, $('#sheetTitle').textContent);
  ok('面板里一处条目', $$('#sheetBody .entry').length === 1, String($$('#sheetBody .entry').length));
  ok('条目里显示框里的原文', $('#sheetBody').textContent.indexOf('发出沉闷的响声') >= 0);

  const noteInput = $('[data-mark-note="0"]');
  ok('意见框就嵌在条目里（不是全屏编辑器）',
    !!noteInput && $('#sheetBody').contains(noteInput));
  ok('没有弹出全屏编辑器', $('#fullEditor').classList.contains('hidden'));
  ok('意见框有提示文案', (noteInput.getAttribute('placeholder') || '').indexOf('想怎么改') >= 0);

  typeInto(noteInput, '声音别用「沉闷」，换成门轴干涩的摩擦声');
  await sleep(120);
  ok('意见失焦即存', Store.bracketItems(c())[0].note === '声音别用「沉闷」，换成门轴干涩的摩擦声',
    Store.bracketItems(c())[0].note);
  ok('存意见没有把面板顶掉', $('#sheetTitle').textContent.indexOf('框选改稿') >= 0);

  /* ============================================================
   [C] 应用：只改框里
   ============================================================ */
  console.log('\n[C] 应用：只改框里，方括号去掉');
  patchReply = [{ id: 'bk0', text: '门轴发出一声干涩的摩擦声' }];
  const before = seen.length;
  click(sheetBtn('按意见修改'));
  await sleep(500);

  const req = seen.slice(before).filter(x => !x.body.stream)[0];
  ok('发出了改稿请求', !!req);
  ok('走的是「改稿」那套方案', req && req.body.model === 'cheap-1', req && req.body.model);
  const sentBody = req ? JSON.stringify(req.body.messages) : '';
  ok('请求里带上框里的原文', sentBody.indexOf('发出沉闷的响声') >= 0);
  ok('请求里带上填的意见', sentBody.indexOf('门轴干涩的摩擦声') >= 0);
  ok('请求里带上整章正文（看清前后文）', sentBody.indexOf('雨点砸在石板路上') >= 0);
  ok('明确要求只改这些片段', /只改这些片段|一个字都不要动/.test(sentBody));

  const after = c().content;
  ok('框里换成新文本', after.indexOf('门轴发出一声干涩的摩擦声') >= 0, after);
  ok('旧内容消失', after.indexOf('发出沉闷的响声') < 0);
  ok('方括号从正文里去掉了', after.indexOf('【【') < 0 && after.indexOf('】】') < 0);
  ok('没框的两段一字未动',
    after.indexOf(P1) >= 0 && after.indexOf(P3) >= 0, after);
  ok('去框后等于「保留框内文字、去掉方括号」的结果',
    after === P1 + '城门在身后合拢，门轴发出一声干涩的摩擦声。' + P3, after);
  ok('高亮撤下', $$('.reader-content mark.mk').length === 0);
  ok('阅读条上的「🖍」入口收起', !$('.reader-bar [data-act="mark.list"]'));
  ok('意见已被消费', c().marks.filter(m => Store.bracketItems(c()).some(x => x.noteId === m.id)).length === 0);
  ok('界面上的正文同步刷新', $('.reader-content').textContent === after);

  /* ============================================================
   [D] 撤销 + 取消标记
   ============================================================ */
  console.log('\n[D] 撤销与取消标记');
  click('[data-act="reader.menu"]');
  await sleep(80);
  click('[data-act="reader.undo"]');
  await sleep(80);
  const ub = $$('#sheetFoot .btn');
  ub[ub.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  ok('正文回滚到改之前', c().content === P1 + '城门在身后合拢，【【发出沉闷的响声】】。' + P3, c().content);
  ok('框和高亮都回来了', $$('.reader-content mark.mk').length === 1);
  ok('阅读条上又出现「🖍 1」', !!$('.reader-bar [data-act="mark.list"]'));

  click($('.reader-bar [data-act="mark.list"]'));
  await sleep(120);
  ok('意见也回来了（按框里的原文对齐）',
    ($('[data-mark-note="0"]') || {}).value === '声音别用「沉闷」，换成门轴干涩的摩擦声',
    ($('[data-mark-note="0"]') || {}).value);
  w.UI.closeSheet();
  await sleep(60);

  // 取消标记
  click($('.reader-bar [data-act="mark.list"]'));
  await sleep(120);
  click(sheetBtn('取消标记'));
  await sleep(120);
  const cb = $$('#sheetFoot .btn');
  cb[cb.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok('取消标记后方括号没了、文字保留',
    c().content === P1 + '城门在身后合拢，发出沉闷的响声。' + P3, c().content);
  ok('意见一并清空', c().marks.length === 0);
  ok('高亮消失', $$('.reader-content mark.mk').length === 0);
  ok('阅读条上的入口收起', !$('.reader-bar [data-act="mark.list"]'));

  /* ============================================================
   [E] 在正文编辑里改框
   ============================================================ */
  console.log('\n[E] 正文编辑里加框 / 删框');
  click('[data-act="reader.menu"]');
  await sleep(80);
  click('[data-act="chapter.editContent"]');
  await sleep(150);
  ok('打开正文编辑器', !$('#fullEditor').classList.contains('hidden'));
  ok('编辑器里是当前正文（上一步取消标记后已经没有方括号）',
    $('#feText').value === c().content, $('#feText').value.slice(0, 60));
  ok('编辑器下方提示了框选语法', $('#feStatus').textContent.indexOf('【【') >= 0 ||
    $('#feStatus').getAttribute('data-hint').indexOf('【【') >= 0,
    $('#feStatus').textContent + ' | ' + $('#feStatus').getAttribute('data-hint'));

  $('#feText').value = P1 + '【【城门在身后合拢】】' + '发出沉闷的响声。' + '【【他抬脚往前走】】' + '，靴子里灌满了水。';
  click('#feSave');
  await sleep(250);
  ok('保存后识别到两处框', mkCount() === 2, String(mkCount()));
  ok('两处高亮', $$('.reader-content mark.mk').length === 2);
  ok('高亮内容正确',
    $$('.reader-content mark.mk')[0].textContent === '城门在身后合拢' &&
    $$('.reader-content mark.mk')[1].textContent === '他抬脚往前走');
  ok('序号 1 / 2 正确',
    $$('.reader-content mark.mk')[0].getAttribute('data-n') === '1' &&
    $$('.reader-content mark.mk')[1].getAttribute('data-n') === '2');
  ok('阅读条上显示「🖍 2」', $('.reader-bar [data-act="mark.list"]').textContent.indexOf('2') >= 0);

  // 再删掉一个框
  click('[data-act="reader.menu"]');
  await sleep(80);
  click('[data-act="chapter.editContent"]');
  await sleep(150);
  $('#feText').value = P1 + '【【城门在身后合拢】】发出沉闷的响声。他抬脚往前走，靴子里灌满了水。';
  click('#feSave');
  await sleep(250);
  ok('删掉一个框后只剩一处', mkCount() === 1, String(mkCount()));
  ok('高亮跟着变', $$('.reader-content mark.mk').length === 1);
  ok('剩下的那处是高亮正确的内容',
    $$('.reader-content mark.mk')[0].textContent === '城门在身后合拢');

  click($('.reader-bar [data-act="mark.list"]'));
  await sleep(120);
  ok('面板里只剩一条', $$('#sheetBody .entry').length === 1, String($('#sheetBody .entry').length));
  w.UI.closeSheet();
  await sleep(60);

  /* ============================================================
   [F] 运行期错误检查
   ============================================================ */
  console.log('\n[F] 运行期错误检查');
  ok('全程无 JS 错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
