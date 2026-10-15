/* 第五轮改造 · jsdom 端到端测试：AI 小编对话页
 *   [A] 对话页：上下文行、发一句话、流式回复里不闪标签
 *   [B] 标签渲染成提案卡：预览展开 / 修改 / 应用 / 忽略（单条各自独立）
 *   [C] 批量应用 + 撤销
 *   [D] 改不动的条目（名字对不上）明确说明并只能忽略
 *   [E] 运行期错误检查
 * 运行：node tests/round5ui.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PORT = 8131;
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
  const byIdx = (act, i) => $('[data-act="' + act + '"][data-idx="' + i + '"]');
  // 页面里会累积多轮对话，断言一律只看**最后一条** AI 回复里的卡片
  const lastMsg = () => $$('.chat-msg.ai').slice(-1)[0];
  const lastActs = () => lastMsg() ? Array.from(lastMsg().querySelectorAll('.chat-act')) : [];
  const lastAt = (act, i) => lastMsg().querySelector('[data-act="' + act + '"][data-idx="' + i + '"]');

  // ---- 假 API：小编回复（流式） ----
  const enc = new w.TextEncoder();
  const seen = [];
  let reply = '这章没问题。';
  w.fetch = async (url, opt) => {
    const body = opt && opt.body ? JSON.parse(opt.body) : {};
    seen.push({ url: String(url), body: body });
    if (body.stream) {
      const ev = 'data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) +
        '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 90 } }) +
        '\n\ndata: [DONE]\n\n';
      let done = false;
      return {
        ok: true, status: 200,
        body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: enc.encode(ev) }) }) },
        text: async () => '', json: async () => ({})
      };
    }
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })
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
    { id: 'm2', name: '小编', providerId: 'p1', model: 'cheap-1', task: 'editor' }
  ];
  Store.state.activePresetId = 'm1';
  const b = Store.createBook('小编测试书');
  const v1 = Store.addVolume(b, '第一卷 雾起', '主角踏入雾都');
  const c1 = Store.addChapter(b, { title: '雨夜启程', outline: '雨夜离乡', volumeId: v1 });
  c1.content = '雨点砸在石板路上。';
  Store.addWorldEntry(b, 'characters', '老周', '铁匠');
  Store.addWorldEntry(b, 'locations', '雾都', '终年有雾的港口城市');
  Store.addHook(b, { content: '玉佩的来历', fromChapter: 1, planChapter: 5 });
  Store.save();

  w.location.hash = '#/book/' + b.id + '/chat';
  w.UI.route();
  await sleep(150);

  /* ============================================================
   [A] 对话页与一轮对话
   ============================================================ */
  console.log('\n[A] 对话页');
  ok('书本页有「小编」页签', $$('.tabs-fixed .tab').some(t => t.textContent.indexOf('小编') >= 0));
  ok('小编页渲染出来了', !!$('#chatText') && !!$('[data-act="chat.send"]'));
  ok('顶部说明上下文基于哪一章', $('.chat-ctx').textContent.indexOf('第 1 章') >= 0, $('.chat-ctx').textContent.slice(0, 80));
  ok('默认没有对话时有引导文案', !!$('.chat-empty'));
  ok('还没有建议时没有事务条', !$('.chat-txns'));

  reply = '老周现在只是个铁匠，确实没作用。\n' +
    '我建议给他加一条守夜人眼线的暗线，这样第 9 章的铜哨就有出处了。\n\n' +
    '[改设定 老周]\n铁匠；实为北境守夜人的眼线，铜哨是接头信物\n[/改设定]\n\n' +
    '[加伏笔 3 9]\n老周腰间的铜哨\n[/加伏笔]\n\n' +
    '[改大纲 1 夜访]\n林昭夜访铁匠铺，第一次见到铜哨\n[/改大纲]\n';

  $('#chatText').value = '老周这个角色太单薄了，帮我改改';
  const n0 = seen.length;
  click('[data-act="chat.send"]');
  await sleep(500);

  ok('发出了小编请求', seen.length > n0);
  const req = seen.slice(n0).filter(x => x.body.stream)[0];
  ok('走的是「小编」那套模型方案', req && req.body.model === 'cheap-1', req && req.body.model);
  const sentBody = req ? JSON.stringify(req.body.messages) : '';
  ok('请求里带上了世界设定', sentBody.indexOf('铁匠') >= 0);
  ok('请求里带上了分卷大纲', sentBody.indexOf('主角踏入雾都') >= 0);
  ok('提示词里教了标签写法', sentBody.indexOf('改设定') >= 0 && sentBody.indexOf('加伏笔') >= 0);

  ok('作者那句话显示在对话里', $('#chatList').textContent.indexOf('老周这个角色太单薄了') >= 0);
  ok('小编的回复显示在对话里', $('#chatList').textContent.indexOf('守夜人眼线的暗线') >= 0);
  ok('标签块没有漏进气泡里',
    $('.chat-msg.ai .chat-bubble').textContent.indexOf('[改设定') < 0,
    $('.chat-msg.ai .chat-bubble').textContent);

  /* ============================================================
   [B] 提案卡：预览 / 修改 / 应用 / 忽略
   ============================================================ */
  console.log('\n[B] 逐条预览 / 修改 / 应用 / 忽略');
  const cards = lastActs();
  ok('三条建议各渲染成一张卡', cards.length === 3, String(cards.length));
  ok('卡片标了改动类型', cards[0].textContent.indexOf('修改设定') >= 0 && cards[0].textContent.indexOf('老周') >= 0);
  ok('新增类标了「新增」', cards[1].textContent.indexOf('新增伏笔') >= 0);
  ok('卡片列出改前改后',
    cards[0].textContent.indexOf('铁匠') >= 0 && cards[0].textContent.indexOf('眼线') >= 0);
  ok('每条都有「应用」与「忽略」',
    cards.every(c => c.querySelector('[data-act="chat.applyOne"]') && c.querySelector('[data-act="chat.drop"]')));
  ok('可编辑的条目有「修改」按钮',
    cards[0].querySelector('[data-act="chat.editAct"]') && cards[1].querySelector('[data-act="chat.editAct"]'));
  ok('有「预览」按钮', !!cards[0].querySelector('[data-act="chat.preview"]'));

  // —— 预览：展开 / 收起 ——
  const diff = cards[0].querySelector('.chat-act-diff');
  ok('默认是收起的单行', diff.classList.contains('one-line'));
  click(lastAt('chat.preview', 0));
  await sleep(120);
  ok('点预览后展开', !lastActs()[0].querySelector('.chat-act-diff').classList.contains('one-line'));
  click(lastAt('chat.preview', 0));
  await sleep(120);
  ok('再点收起', lastActs()[0].querySelector('.chat-act-diff').classList.contains('one-line'));

  // —— 修改：只改这一条 ——
  click(lastAt('chat.editAct', 0));
  await sleep(120);
  ok('打开编辑器改这条', !$('#fullEditor').classList.contains('hidden'));
  ok('编辑器里是这条当前的内容', $('#feText').value.indexOf('眼线') >= 0, $('#feText').value);
  $('#feText').value = '铁匠；北境守夜人的眼线，只认铜哨不认人';
  click('#feSave');
  await sleep(150);
  const a0 = b.chat[b.chat.length - 1].actions;
  ok('改的内容写回了这条建议', a0[0].content.indexOf('只认铜哨不认人') >= 0, JSON.stringify(a0[0]));
  ok('其他条目没被一起改', a0[1].content === '老周腰间的铜哨' && a0[2].outline.indexOf('林昭夜访') >= 0);
  ok('界面上同步显示新内容',
    lastActs()[0].textContent.indexOf('只认铜哨不认人') >= 0);

  // —— 忽略：只去掉这一条 ——
  click(lastAt('chat.drop', 1));
  await sleep(150);
  ok('忽略后少了一张卡', lastActs().length === 2, String(lastActs().length));
  ok('被忽略的那条不在建议里', b.chat[b.chat.length - 1].actions.length === 2);
  ok('被忽略的是伏笔那条',
    b.chat[b.chat.length - 1].actions.every(a => a.op !== 'hook.add'));
  ok('数据没有被改动', !b.hooks.some(h => h.content === '老周腰间的铜哨'));

  // —— 应用：只落地这一条 ——
  const txn0 = (b.txns || []).length;
  click(lastAt('chat.applyOne', 0));
  await sleep(200);
  ok('应用后这张卡消失', lastActs().length === 1, String(lastActs().length));
  ok('老周被改了', Store.findWorldByName(b, '老周')[0].entry.content.indexOf('只认铜哨不认人') >= 0);
  ok('雾都没被动', Store.findWorldByName(b, '雾都')[0].entry.content === '终年有雾的港口城市');
  ok('大纲没被动', Store.getChapter(b, c1.id).outline === '雨夜离乡');
  ok('伏笔没被动', b.hooks.length === 1);
  ok('记了一条事务', (b.txns || []).length === txn0 + 1);
  ok('界面出现可撤销的事务条', !!$('.chat-txns') && $('.chat-txns').textContent.indexOf('撤销') >= 0);

  // —— 撤销 ——
  click($('[data-act="chat.undoTxn"]'));
  await sleep(120);
  const cb = $$('#sheetFoot .btn');
  cb[cb.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  ok('撤销后老周还原', Store.findWorldByName(b, '老周')[0].entry.content === '铁匠');
  ok('事务条消失', !$('.chat-txns') || $('.chat-txns').textContent.indexOf('撤销') < 0);

  /* ============================================================
   [C] 批量应用
   ============================================================ */
  console.log('\n[C] 一次应用多条');
  reply = '顺便也把雾都和大纲理一下。\n\n' +
    '[改设定 雾都]\n雾气常年不散，进港要交雾税\n[/改设定]\n\n' +
    '[改大纲 1 夜访]\n林昭夜访铁匠铺\n[/改大纲]\n\n' +
    '[加伏笔 3 9]\n老周腰间的铜哨\n[/加伏笔]\n';
  $('#chatText').value = '再帮我补两条';
  click('[data-act="chat.send"]');
  await sleep(500);
  ok('新的一轮有三条建议', lastActs().length === 3, String(lastActs().length));
  ok('有多条时出现「全部应用」', !!lastMsg().querySelector('[data-act="chat.apply"]'));

  click(lastMsg().querySelector('[data-act="chat.apply"]'));
  await sleep(150);
  ok('批量应用前先确认', $('#sheetTitle').textContent.indexOf('应用全部') >= 0, $('#sheetTitle').textContent);
  click(sheetBtn('应用'));
  await sleep(300);
  ok('雾都被改了', Store.findWorldByName(b, '雾都')[0].entry.content.indexOf('雾税') >= 0);
  ok('大纲被改了', Store.getChapter(b, c1.id).outline === '林昭夜访铁匠铺');
  ok('伏笔被加了', b.hooks.some(h => h.content === '老周腰间的铜哨'));
  ok('这一轮的卡片都清空了', lastActs().length === 0, String(lastActs().length));

  // 整批撤销
  click($('[data-act="chat.undoTxn"]'));
  await sleep(120);
  const cb2 = $$('#sheetFoot .btn');
  cb2[cb2.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok('整批撤销：雾都还原', Store.findWorldByName(b, '雾都')[0].entry.content === '终年有雾的港口城市');
  ok('整批撤销：大纲还原', Store.getChapter(b, c1.id).outline === '雨夜离乡');
  ok('整批撤销：加的伏笔被收回', !b.hooks.some(h => h.content === '老周腰间的铜哨'));

  /* ============================================================
   [D] 定位不到的条目
   ============================================================ */
  console.log('\n[D] 名字对不上时');
  reply = '把这个改一下。\n\n[改设定 张三]\n某个人\n[/改设定]\n\n[改设定 老周]\n铁匠；眼线\n[/改设定]\n';
  $('#chatText').value = '改两个';
  click('[data-act="chat.send"]');
  await sleep(500);
  const cs = lastActs();
  ok('两条建议都在', cs.length === 2, String(cs.length));
  ok('对不上的那条标成「不适用」', cs[0].classList.contains('bad') && cs[0].textContent.indexOf('不适用') >= 0);
  ok('并说清为什么', cs[0].textContent.indexOf('找不到') >= 0, cs[0].textContent);
  ok('对不上的那条没有「应用」按钮', !cs[0].querySelector('[data-act="chat.applyOne"]'));
  ok('对不上的那条仍可忽略', !!cs[0].querySelector('[data-act="chat.drop"]'));
  ok('对得上的那条正常', !!cs[1].querySelector('[data-act="chat.applyOne"]'));

  click(lastAt('chat.drop', 0));
  await sleep(150);
  ok('忽略掉对不上的那条', lastActs().length === 1, String(lastActs().length));
  ok('剩下的是能用的那条', lastActs()[0].textContent.indexOf('老周') >= 0);

  /* ============================================================
   [G] 悬浮球「撤销上次生成」
   ============================================================ */
  console.log('\n[G] 悬浮球：撤销上次生成');
  const fabBtn = () => $$('#fabPanel [data-act]').map(x => x.getAttribute('data-act'));
  ok('悬浮球面板里有「撤销上次生成」', fabBtn().indexOf('fab.undo') >= 0, fabBtn().join(','));
  ok('而且排在最前（最常用的入口）', fabBtn()[0] === 'fab.undo');

  function tapFabUndo() {
    return new Promise(async (r) => {
      click('#fab'); await sleep(60);
      click('[data-act="fab.undo"]'); await sleep(120);
      r();
    });
  }
  function confirmSheet() {
    const b2 = $$('#sheetFoot .btn');
    if (!b2.length) return false;
    b2[b2.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return true;
  }

  // —— ① 没有可撤销的东西时说清楚 ——
  b.undoStack = []; b.txns = [];
  Store.save();
  await tapFabUndo();
  ok('没有可撤销的改动时给出说明',
    $('#sheetTitle').textContent.indexOf('撤销上次生成') >= 0 && $('#sheetBody').textContent.indexOf('没有可撤销') >= 0,
    $('#sheetBody').textContent.slice(0, 60));
  w.UI.closeSheet();
  await sleep(60);

  // —— ② 小编改动：走事务那条路 ——
  reply = '[改设定 老周]\n铁匠；北境守夜人的眼线\n[/改设定]\n[改大纲 1 夜访]\n林昭夜访铁匠铺\n[/改大纲]\n';
  $('#chatText').value = '帮我改两处';
  click('[data-act="chat.send"]');
  await sleep(500);
  click(lastMsg().querySelector('[data-act="chat.apply"]'));
  await sleep(120);
  click(sheetBtn('应用'));
  await sleep(300);
  ok('小编改动已落地', Store.findWorldByName(b, '老周')[0].entry.content.indexOf('眼线') >= 0);
  ok('而且留了事务', (b.txns || []).length === 1);

  await tapFabUndo();
  ok('确认面板写明了是哪一条小编改动',
    $('#sheetTitle').textContent.indexOf('小编') >= 0, $('#sheetTitle').textContent);
  ok('确认文案说清了后果', /退回原样/.test($('#sheetBody').textContent), $('#sheetBody').textContent.slice(0, 140));
  confirmSheet();
  await sleep(300);
  ok('撤销后老周还原', Store.findWorldByName(b, '老周')[0].entry.content === '铁匠');
  ok('撤销后大纲还原', Store.getChapter(b, c1.id).outline === '雨夜离乡');
  ok('事务被清掉', (b.txns || []).length === 0);

  // —— ③ 正文生成：走 undoStack 那条路 ——
  const cNew = Store.addChapter(b, { title: '新章', outline: '新的一章', volumeId: v1 });
  Store.pushUndo(b, cNew, '', b.memory.summary || '', { title: '新章', outline: '新的一章', content: '' }, [], null, 'write');
  cNew.content = '这是 AI 生成的正文。';
  Store.save();
  ok('正文生成立了撤回点', b.undoStack.length === 1);

  await tapFabUndo();
  ok('确认面板指出是哪一章',
    ($('#sheetTitle').textContent + $('#sheetBody').textContent).indexOf('第2章《新章》') >= 0,
    $('#sheetTitle').textContent + ' | ' + $('#sheetBody').textContent.slice(0, 90));
  ok('确认文案提到记忆一起回滚', /记忆/.test($('#sheetBody').textContent), $('#sheetBody').textContent.slice(0, 140));
  confirmSheet();
  await sleep(300);
  ok('正文被撤回', Store.getChapter(b, cNew.id).content === '');
  ok('撤回栈已清空', b.undoStack.length === 0);

  // —— ④ 两类都有时：让用户选，而不是替它猜 ——
  const cNew2 = Store.addChapter(b, { title: '再一章', outline: 'o', volumeId: v1 });
  Store.pushUndo(b, cNew2, '', '', { title: '再一章', outline: 'o', content: '' }, [], null, 'write');
  cNew2.content = 'AI 写的一段。';
  Store.applyEditorActions(b,
    Store.resolveEditorActions(b, [{ op: 'world.update', name: '雾都', content: '改后的雾都' }]), '小编：改雾都');
  Store.save();
  ok('两类记录都在', b.undoStack.length === 1 && b.txns.length === 1);

  w.location.hash = '#/book/' + b.id + '/chat'; w.UI.route(); await sleep(120);
  await tapFabUndo();
  ok('两条都给出来让用户选', $$('#sheetBody [data-act="fab.undoPick"]').length === 2,
    String($$('#sheetBody [data-act="fab.undoPick"]').length));
  ok('列表里标明各自是什么',
    $('#sheetBody').textContent.indexOf('AI 生成正文') >= 0 && $('#sheetBody').textContent.indexOf('小编') >= 0,
    $('#sheetBody').textContent.slice(0, 180));

  const pickWrite = $$('#sheetBody [data-act="fab.undoPick"]').filter(x => {
    const card = x.closest('.entry');
    return card && card.textContent.indexOf('AI 生成正文') >= 0;
  })[0];
  click(pickWrite);
  await sleep(120);
  confirmSheet();
  await sleep(300);
  ok('撤销了选中的那条（正文）', Store.getChapter(b, cNew2.id).content === '');
  ok('没动另一条（小编改动还在）',
    Store.findWorldByName(b, '雾都')[0].entry.content === '改后的雾都' && (b.txns || []).length === 1);

  // —— ⑤ 不在书本页时：扫全部作品，找最近的那一次 ——
  w.location.hash = '#/books'; w.UI.route(); await sleep(150);
  await tapFabUndo();
  ok('不在书本页也能找到最近那次改动',
    ($('#sheetTitle').textContent + ($('#sheetBody') ? $('#sheetBody').textContent : '')).indexOf('小编') >= 0,
    $('#sheetTitle').textContent);
  confirmSheet();
  await sleep(300);
  ok('撤销生效（雾都还原）', Store.findWorldByName(b, '雾都')[0].entry.content === '终年有雾的港口城市');
  ok('跨页撤销后事务也清掉', (b.txns || []).length === 0);

  w.location.hash = '#/book/' + b.id + '/chat'; w.UI.route(); await sleep(120);

  /* ============================================================
   [E] 清空对话 + 运行期错误
   ============================================================ */
  console.log('\n[E] 清空对话与错误检查');
  click('[data-act="chat.clear"]');
  await sleep(120);
  const cb3 = $$('#sheetFoot .btn');
  cb3[cb3.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  ok('对话已清空', b.chat.length === 0 && $$('.chat-msg').length === 0);
  ok('清空对话不影响已应用的数据', Store.findWorldByName(b, '老周')[0].entry.content === '铁匠');
  ok('回到引导文案', !!$('.chat-empty'));

  ok('全程无 JS 错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
