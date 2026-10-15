/* 第三轮改造 · jsdom 端到端测试：
 *   生成前预览（临时减配）/ 伏笔板（增删改 + 逾期角标）/
 *   用量卡片与清零 / 文风规则写入
 * 运行：node tests/round3ui.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PORT = 8127;
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
  const fillSheet = (values) => {
    Object.keys(values).forEach(k => {
      const el = $('#sheetBody [data-f="' + k + '"]');
      if (el) el.value = values[k];
    });
    const btns = $$('#sheetFoot .btn');
    btns[btns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  };
  const sheetBtn = (text) => $$('#sheetFoot .btn').filter(b2 => b2.textContent.indexOf(text) >= 0)[0];

  // ---- 假 API：流式正文 + 非流式 JSON，都带 usage ----
  const enc = new w.TextEncoder();
  const seen = [];
  // slowMs：让流式请求「飞一会儿」，用来制造「上一个任务还没跑完」的观测窗口。
  // 必须放在 seen.push 之后，否则会把「请求已发出」这个事实也一起推迟掉。
  let slowMs = 0;
  // 记忆总结返回的要点，测试里可按需改写以区分第几版
  let memPoints = '抵达黑石城';
  w.fetch = async (url, opt) => {
    const body = opt && opt.body ? JSON.parse(opt.body) : {};
    seen.push({ url: String(url), body: body });
    if (slowMs && body.stream) await new Promise(r => setTimeout(r, slowMs));
    if (body.stream) {
      const text = '他推开城门，风从北方灌进来。';
      const ev = 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) +
        '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 300 } }) +
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
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ summary: '离开故乡，' + memPoints + '。', points: [memPoints] }) } }],
        usage: { prompt_tokens: 800, completion_tokens: 120 }
      })
    };
  };

  // ---- fixture ----
  const Store = w.Store, AI = w.AI;
  Store.state.providers = [
    { id: 'p1', name: '主力', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-123456', model: 'big-1' }
  ];
  Store.state.activeProviderId = 'p1';
  Store.state.modelPresets = [
    { id: 'm1', name: '主笔', providerId: 'p1', model: 'big-1', priceIn: 4, priceOut: 16, task: 'write' }
  ];
  Store.state.activePresetId = 'm1';
  Store.state.ui.injectPreview = true;      // 本文件专门测生成前预览
  const b = Store.createBook('雾都拾遗');
  const v1 = Store.addVolume(b, '第一卷 雾起', '主角踏入雾都').id;
  Store.addWorldEntry(b, 'characters', '林昭', '男主，冷静寡言');
  Store.addWorldEntry(b, 'locations', '黑石城', '边境要塞', null, { keywords: '黑石城' });
  b.styleRules = { banned: '首先，其次' };
  b.memory = { enabled: true, keepRecent: 6, summary: '主角离开故乡，正在前往黑石城。', entries: [] };
  const c1 = Store.addChapter(b, { title: '雨夜启程', outline: '主角雨夜离开故乡', volumeId: v1 });
  const c2 = Store.addChapter(b, { title: '黑石城', outline: '抵达黑石城，要塞闭门', volumeId: v1 });
  c1.content = '雾很大。他背起行囊，走进夜色里。';
  Store.addMemory(b, c1, '主角离开故乡', '');
  Store.addHook(b, { content: '腰间旧玉佩的来历', fromChapter: 1, planChapter: 3 });
  Store.save();

  /* ============================================================
   [A] 生成前预览：看得到、勾得掉、勾掉真的不发
   ============================================================ */
  console.log('\n[A] 生成前预览与临时减配');
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(60);
  const genBtn = $$('.chapter-item [data-act="chapter.generate"]').filter(x => x.textContent.indexOf('生成正文') >= 0)[0];
  ok('目录里有「生成正文」按钮', !!genBtn);
  click(genBtn); await sleep(80);
  ok('弹出生成前预览', $('#sheetTitle').textContent.indexOf('本次将注入') >= 0, $('#sheetTitle').textContent);
  ok('粗估 token 数写在标题里', /本次将注入 · 粗估 \d+ token/.test($('#sheetTitle').textContent), $('#sheetTitle').textContent);
  const boxes = $$('#sheetBody input[type="checkbox"][data-f]');
  ok('六块内容 + 一个「不再预览」开关', boxes.length === 7, String(boxes.length));
  ok('默认全部勾选', boxes.slice(0, 6).every(x => x.checked));
  ok('列出世界设定块', $('#sheetBody').textContent.indexOf('世界设定') >= 0);
  ok('列出伏笔块', $('#sheetBody').textContent.indexOf('未回收伏笔') >= 0);

  // 勾掉「世界设定」再生成
  $('#sheetBody [data-f="world"]').checked = false;
  click(sheetBtn('开始生成'));
  await sleep(400);
  // 生成完成后还会发一次（非流式的）记忆总结请求，这里只看流式那次正文请求
  const req = seen.filter(x => x.body && x.body.stream).slice(-1)[0];
  ok('确实发出了生成请求', !!req);
  const sent = req ? JSON.stringify(req.body.messages) : '';
  ok('勾掉的世界设定没有发出去', sent.indexOf('林昭') < 0, sent.slice(0, 120));
  ok('没勾掉的记忆仍在', sent.indexOf('主角离开故乡') >= 0);
  ok('没勾掉的伏笔仍在', sent.indexOf('腰间旧玉佩的来历') >= 0);
  ok('没勾掉的文风规则仍在', sent.indexOf('【文风规则】') >= 0);
  ok('正文已写入章节', !!Store.getChapter(b, c2.id).content);

  // 用量：流式末 chunk 的 usage 已记账
  await sleep(200);
  ok('生成后本书用量已累计', b.usage.requests >= 1 && b.usage.promptTokens >= 2000, JSON.stringify(b.usage));
  ok('按方案单价估算成本', b.usage.cost > 0, String(b.usage.cost));

  // 第二次：勾上「以后不再预览」
  const c3 = Store.addChapter(b, { title: '星图', outline: '观星会的遗迹', volumeId: v1 });
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(60);
  const genBtn2 = $$('.chapter-item [data-act="chapter.generate"]').filter(x => x.textContent.indexOf('生成正文') >= 0)[0];
  click(genBtn2); await sleep(100);
  ok('第二次仍弹出预览', $('#sheetTitle').textContent.indexOf('本次将注入') >= 0, $('#sheetTitle').textContent);
  $('#sheetBody [data-f="noAsk"]').checked = true;
  click(sheetBtn('开始生成'));
  await sleep(400);
  ok('勾了「以后不再预览」后写入设置', Store.state.ui.injectPreview === false);

  // 第三次：点一下就直接生成，不再弹预览
  const c4 = Store.addChapter(b, { title: '雾散', outline: '雾散之后', volumeId: v1 });
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(60);
  const genBtn3 = $$('.chapter-item [data-act="chapter.generate"]').filter(x => x.textContent.indexOf('生成正文') >= 0)[0];
  const n0 = seen.length;
  click(genBtn3); await sleep(200);
  ok('关闭后点击即直接发请求（不再弹预览）', seen.length > n0, String(seen.length - n0));
  await sleep(400);

  /* ============================================================
   [A3] 连着重写同一章：不吃自己的旧记忆 / 记忆不攒份数
   ============================================================ */
  console.log('\n[A3] 反复重写同一章');
  w.UI.closeSheet();
  Store.state.ui.injectPreview = false;   // 这几步只想看链路，不要每次都弹预览
  Store.save();
  // [A] 已经生成过一次 c2，这里重置成「这一章刚写第一版」的状态再测重写
  b.memory.entries = b.memory.entries.filter(e => e.chapterId !== c2.id);
  b.memory.summary = '前情：主角离开故乡，抵达黑石城。';
  Store.addMemory(b, c2, '抵达黑石城，城门紧闭', '前情：主角离开故乡。');
  Store.save();
  ok('重写前该章有一条记忆',
    b.memory.entries.filter(e => e.chapterId === c2.id).length === 1);

  async function rewriteChapter(cid) {
    w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(60);
    const row = $$('.chapter-item').filter(x => x.getAttribute('data-id') === cid)[0];
    click(row.querySelector('[data-act="chapter.generate"]'));
    await sleep(120);
    click(sheetBtn('确定'));           // 重写表单的「确定」
    await sleep(600);
  }
  const memOf = () => b.memory.entries.filter(e => e.chapterId === c2.id);

  memPoints = '抵达黑石城（第1版）';
  await rewriteChapter(c2.id);
  ok('重写后仍只有一条记忆', memOf().length === 1, String(memOf().length));
  ok('重写后记忆内容已更新', memOf()[0].text.indexOf('第1版') >= 0, memOf()[0].text);
  ok('重写后 summaryBefore 仍是「写这一章之前」的快照',
    memOf()[0].summaryBefore === '前情：主角离开故乡。', memOf()[0].summaryBefore);

  const sentRe = seen.filter(x => x.body && x.body.stream).slice(-1)[0];
  const reMsgs = sentRe ? JSON.stringify(sentRe.body.messages) : '';
  ok('重写时不再把本章旧正文喂回去', reMsgs.indexOf('城门紧闭') < 0, reMsgs.slice(0, 150));

  memPoints = '抵达黑石城（第2版）';
  await rewriteChapter(c2.id);
  ok('第二次重写仍只一条记忆', memOf().length === 1, String(memOf().length));
  ok('第二次重写刷新了内容', memOf()[0].text.indexOf('第2版') >= 0, memOf()[0].text);

  const beforeText = memOf()[0].text;
  memPoints = '抵达黑石城（第3版）';
  await rewriteChapter(c2.id);
  ok('连着重写三次，记忆还是一条', memOf().length === 1, String(memOf().length));
  ok('书本里没有同章的多份记忆',
    b.memory.entries.length === new Set(b.memory.entries.map(e => e.chapterId)).size,
    b.memory.entries.length + ' 条 / ' + new Set(b.memory.entries.map(e => e.chapterId)).size + ' 章');

  // 撤回：应该恢复重写前那条记忆，而不是把它删掉
  w.location.hash = '#/read/' + b.id + '/' + c2.id; w.UI.route(); await sleep(80);
  click('[data-act="reader.menu"]'); await sleep(40);
  click('[data-act="reader.undo"]'); await sleep(60);
  const ub = w.document.querySelectorAll('#sheetFoot .btn');
  ub[ub.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  ok('撤回后本章记忆还在（不是被删掉）', memOf().length === 1, String(memOf().length));
  ok('撤回后记忆回到重写前的版本', memOf()[0].text === beforeText, memOf()[0].text);
  ok('撤回后 summaryBefore 仍是写这一章之前的快照',
    memOf()[0].summaryBefore === '前情：主角离开故乡。', memOf()[0].summaryBefore);

  Store.state.ui.injectPreview = true; Store.save();

  /* ============================================================
   [A2] 回头改旧章：预览里说明「后面的没给模型看」
   ============================================================ */
  console.log('\n[A2] 回头改旧章的截断提示');
  Store.state.ui.injectPreview = true; Store.save();
  w.UI.closeSheet();
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(60);
  // 第 1 章（已有正文）重新生成 → 其后的正文与记忆都不该进上下文
  const items = $$('.chapter-item');
  const firstGen = items[0].querySelector('[data-act="chapter.generate"]');
  click(firstGen); await sleep(120);
  ok('已有正文的章节走重写入口', $('#sheetTitle').textContent.indexOf('重写') >= 0, $('#sheetTitle').textContent);
  click(sheetBtn('确定'));
  await sleep(150);
  const body = $('#sheetBody').textContent;
  ok('预览里说明改的是第几章', /第 1 章/.test(body), body.slice(0, 200));
  ok('预览里说明其后有多少内容不注入', /其后.*不注入/.test(body), body.slice(0, 300));
  click(sheetBtn('开始生成'));
  await sleep(500);
  const oldReq = seen.filter(x => x.body && x.body.stream).slice(-1)[0];
  const oldSent = oldReq ? JSON.stringify(oldReq.body.messages) : '';
  ok('其后的章节正文没有发给模型',
    oldSent.indexOf('【星图') < 0 && oldSent.indexOf('雾散之后') < 0, oldSent.slice(0, 200));
  ok('本章之前的内容照常发出', oldSent.indexOf('【世界设定】') >= 0);
  // 复原 [A] 留下的状态，[C] 还要接着验预览开关
  Store.state.ui.injectPreview = false; Store.save();

  /* ============================================================
   [B] 伏笔板
   ============================================================ */
  console.log('\n[B] 伏笔板');
  w.UI.closeSheet();
  w.location.hash = '#/book/' + b.id + '/hooks'; w.UI.route(); await sleep(60);
  ok('伏笔页有新增入口', !!$('[data-act="hook.add"]'));
  ok('列出已有伏笔', $('#page').textContent.indexOf('腰间旧玉佩的来历') >= 0);
  ok('显示埋设章与计划回收章', $('#page').textContent.indexOf('第1章埋下') >= 0 && $('#page').textContent.indexOf('第3章回收') >= 0);

  click('[data-act="hook.add"]'); await sleep(60);
  fillSheet({ content: '黑衣人的身份', fromChapter: '2', planChapter: '1', note: '第1章就该揭晓' });
  await sleep(80);
  ok('新增伏笔入库', b.hooks.length === 2);
  ok('新增后页面即时刷新', $('#page').textContent.indexOf('黑衣人的身份') >= 0);

  // planChapter = 1 ≤ 当前章节数(2) → 逾期
  ok('逾期伏笔高亮提醒', $('#page').textContent.indexOf('⚠ 逾期未回收') >= 0);
  ok('标签页给出逾期角标', (function () {
    const t = $$('.tab').filter(x => x.getAttribute('data-tab') === 'hooks')[0];
    return t && /⚠\d/.test(t.textContent);
  })(), ($$('.tab').map(x => x.textContent).join('|')));

  const black = b.hooks.filter(h => h.content === '黑衣人的身份')[0];
  click('[data-act="hook.resolve"][data-id="' + black.id + '"]'); await sleep(80);
  ok('标记回收后进入「已回收」分组', $('#page').textContent.indexOf('已回收 / 已放弃') >= 0);
  ok('已回收的伏笔不再注入正文',
    AI.hooksListText(b).indexOf('黑衣人的身份') < 0);

  /* ============================================================
   [C] 用量卡片与清零
   ============================================================ */
  console.log('\n[C] 用量卡片');
  w.location.hash = '#/book/' + b.id + '/data'; w.UI.route(); await sleep(60);
  ok('本书页显示累计用量', $('#page').textContent.indexOf('本书累计用量') >= 0);
  ok('显示请求次数与 token', $('#page').textContent.indexOf('请求次数') >= 0 && $('#page').textContent.indexOf('输入 token') >= 0);
  ok('填了单价就显示金额', /¥\d/.test($('#page').textContent));

  w.location.hash = '#/settings'; w.UI.route(); await sleep(60);
  ok('设置页显示全局用量', $('#page').textContent.indexOf('累计用量（全部作品）') >= 0);
  ok('有清零按钮', !!$('[data-act="usage.reset"]'));
  ok('有「关闭/开启预览」开关', !!$('[data-act="ui.togglePreview"]'));

  click('[data-act="ui.togglePreview"]'); await sleep(80);
  ok('开关可重新开启预览', Store.state.ui.injectPreview !== false);
  click('[data-act="ui.togglePreview"]'); await sleep(80);
  ok('再点一次可关闭', Store.state.ui.injectPreview === false);

  /* ============================================================
   [C2] 任务分工界面：分工看得见、指派得动
   ============================================================ */
  console.log('\n[C2] 任务分工界面');
  const cheap = Store.upsertModelPreset({
    name: '便宜记忆', providerId: 'p1', model: 'cheap-1', priceIn: 0.5, priceOut: 2
  });
  w.location.hash = '#/settings'; w.UI.route(); await sleep(60);
  ok('设置页有任务分工一览', $('#page').textContent.indexOf('任务分工') >= 0);
  const assignBtns = $$('[data-act="route.assign"]');
  ok('十类任务都有指派入口', assignBtns.length === 10, String(assignBtns.length));
  ok('未指派的任务显示「用兜底」', $('#page').textContent.indexOf('用兜底') >= 0);

  const memBtn = assignBtns.filter(x => x.getAttribute('data-task') === 'memory')[0];
  click(memBtn); await sleep(80);
  ok('弹出指派面板', $('#sheetTitle').textContent.indexOf('记忆总结') >= 0, $('#sheetTitle').textContent);
  ok('面板列出全部方案 + 「用兜底」选项',
    $$('#sheetBody [data-act="route.set"]').length === Store.state.modelPresets.length + 1);
  const pickCheap = $$('#sheetBody [data-act="route.set"]').filter(x => x.getAttribute('data-id') === cheap.id)[0];
  click(pickCheap); await sleep(120);
  ok('指派写进方案', Store.getModelPreset(cheap.id).task === 'memory');
  ok('分工表标记为专职',
    Store.routingTable().filter(r => r.task === 'memory')[0].source === 'dedicated');
  ok('该任务实际走便宜模型', Store.activeModel('memory').model === 'cheap-1');
  ok('正文仍走主笔（分工互不干扰）', Store.activeModel('write').model === 'big-1');

  // 改派给别的任务：自动从原任务解绑，不会两边同时挂着
  const auditBtn = $$('[data-act="route.assign"]').filter(x => x.getAttribute('data-task') === 'audit')[0];
  click(auditBtn); await sleep(80);
  click($$('#sheetBody [data-act="route.set"]').filter(x => x.getAttribute('data-id') === cheap.id)[0]);
  await sleep(120);
  ok('改派后不再挂原任务', Store.activeModel('memory').model === 'big-1');
  ok('改派后新任务生效', Store.activeModel('audit').model === 'cheap-1');

  /* ============================================================
   [C3] 记忆开关：切了要立刻反映到界面
   ============================================================ */
  console.log('\n[C3] 记忆开关即时刷新');
  b.memory.enabled = true; Store.save();
  w.location.hash = '#/book/' + b.id + '/memory'; w.UI.route(); await sleep(60);
  const sw = $('#page [data-act="memory.toggle"]');
  ok('记忆页有记忆系统开关', !!sw);
  ok('初始为开', sw.checked === true);
  sw.checked = false;
  sw.dispatchEvent(new w.Event('click', { bubbles: true })); await sleep(80);
  ok('关闭后写入数据', b.memory.enabled === false);
  ok('关闭后开关呈未选中态', $('#page [data-act="memory.toggle"]').checked === false);
  // 书架副标题也显示记忆状态，不重渲染的话那里会一直显示旧值
  w.location.hash = '#/books'; w.UI.route(); await sleep(60);
  const item = $$('#page .book-card').filter(e => e.textContent.indexOf('雾都拾遗') >= 0)[0];
  ok('书架副标题同步显示「记忆关」', !!item && item.textContent.indexOf('记忆关') >= 0,
    item ? item.textContent.slice(0, 60) : '没找到书本卡片');

  w.location.hash = '#/book/' + b.id + '/memory'; w.UI.route(); await sleep(60);
  const sw2 = $('#page [data-act="memory.toggle"]');
  sw2.checked = true;
  sw2.dispatchEvent(new w.Event('click', { bubbles: true })); await sleep(80);
  ok('重新开启后写入数据', b.memory.enabled === true);
  w.location.hash = '#/books'; w.UI.route(); await sleep(60);
  const item2 = $$('#page .book-card').filter(e => e.textContent.indexOf('雾都拾遗') >= 0)[0];
  ok('书架副标题同步显示「记忆开」', !!item2 && item2.textContent.indexOf('记忆开') >= 0);

  /* ============================================================
   [C4] 流式自动跟随：默认跟随、上翻暂停、一键恢复
   ============================================================ */
  console.log('\n[C4] 流式自动滚动跟随');
  const R = w.Reader;
  const target = Store.addChapter(b, { title: '跟随测试', outline: '测试自动滚动', volumeId: v1 });
  w.location.hash = '#/read/' + b.id + '/' + target.id; w.UI.route(); await sleep(80);
  const cur = w.document.getElementById('rpCur');
  const followBtn = w.document.getElementById('rFollow');
  ok('阅读器里注入跟随按钮', !!followBtn);
  ok('默认隐藏跟随按钮', followBtn.classList.contains('hidden'));
  ok('默认处于跟随意愿', R.follow === true);

  // 造一个「内容高于容器」的场景，否则 scrollHeight === clientHeight 看不出跟随
  Object.defineProperty(cur, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(cur, 'clientHeight', { value: 800, configurable: true });

  R.setLive('第一段。'.repeat(60), true);
  ok('流式时贴到底部（默认跟随）', cur.scrollTop === 2000, String(cur.scrollTop));
  ok('流式时显示光标', !!cur.querySelector('.cursor-blink'));

  // 用户往上翻：暂停跟随并露出按钮
  cur.scrollTop = 300;
  cur.dispatchEvent(new w.Event('scroll', { bubbles: true }));
  await sleep(30);
  ok('上翻后暂停跟随', R.follow === false);
  ok('上翻后露出「跟随」按钮', !followBtn.classList.contains('hidden'));

  // 暂停后新内容不再把视图拽回底部
  R.setLive('第二段。'.repeat(60), true);
  ok('暂停期间不强制滚动', cur.scrollTop === 300, String(cur.scrollTop));

  // 点按钮恢复
  click(followBtn); await sleep(30);
  ok('点按钮恢复跟随', R.follow === true);
  ok('点按钮后立刻贴到底部', cur.scrollTop === 2000, String(cur.scrollTop));
  ok('点按钮后按钮收起', followBtn.classList.contains('hidden'));

  // 自己滚回底部也应自动恢复
  cur.scrollTop = 200;
  cur.dispatchEvent(new w.Event('scroll', { bubbles: true })); await sleep(20);
  ok('再次上翻又暂停', R.follow === false);
  cur.scrollTop = 2000;
  cur.dispatchEvent(new w.Event('scroll', { bubbles: true })); await sleep(20);
  ok('自己滚回底部即恢复跟随', R.follow === true && followBtn.classList.contains('hidden'));

  // 流式结束：跟随意愿不该继续影响后续阅读
  R.setLive('写完了。', false);
  ok('流式结束后不再显示跟随按钮', followBtn.classList.contains('hidden'));
  ok('流式结束后光标消失', !cur.querySelector('.cursor-blink'));

  /* ============================================================
   [C5] AI 任务互斥锁：生成期间再点不会并发跑第二个
   ============================================================ */
  console.log('\n[C5] AI 任务互斥锁');
  Store.state.ui.injectPreview = false;    // 关掉生成前预览，专注测锁
  const lockCh = Store.addChapter(b, { title: '并发测试章', outline: '测试互斥', volumeId: v1 });

  // 让流式请求慢一点，制造「第一个还没跑完」的窗口
  slowMs = 600;
  // 只数「流式正文请求」：生成成功后还会跟一次（非流式的）记忆总结，会干扰计数
  const streams = () => seen.filter(x => x.body && x.body.stream).length;
  w.location.hash = '#/read/' + b.id + '/' + lockCh.id; w.UI.route(); await sleep(80);
  const q0 = streams();
  click('[data-act="reader.generate"]'); await sleep(180);
  ok('第一次生成已发出请求', streams() === q0 + 1, String(streams() - q0));
  ok('锁已登记为写作中', !!w.App.running() && w.App.running().key === 'write');

  // 生成期间再点：必须被拒绝，绝不能并发跑第二个
  click('[data-act="reader.generate"]'); await sleep(200);
  click('[data-act="reader.generate"]'); await sleep(200);
  ok('并发点击不会发出第二个请求', streams() === q0 + 1, String(streams() - q0));
  ok('给出「先停止当前任务」的提示',
    w.document.body.textContent.indexOf('请先点「停止」') >= 0,
    w.document.body.textContent.slice(-120));
  ok('锁仍在（说明是拒绝而非覆盖）', !!w.App.running());

  // 点停止 → 释放锁
  click('#busyCancel'); await sleep(300);
  ok('停止后释放锁', w.App.running() === null);

  // 锁释放后可以重新开始
  slowMs = 0;
  click('[data-act="reader.generate"]'); await sleep(500);
  ok('停止后可以重新开始生成', streams() === q0 + 2, String(streams() - q0));
  ok('新任务跑完自动释放锁', w.App.running() === null);

  /* ============================================================
   [D] 文风规则（书本基本信息页）
   ============================================================ */
  console.log('\n[D] 文风规则');
  w.location.hash = '#/book/' + b.id + '/basic'; w.UI.route(); await sleep(60);
  const bannedEl = $('#page [data-bind="book.styleRules.banned"]');
  ok('基本信息页有文风规则输入框', !!bannedEl);
  if (bannedEl) {
    bannedEl.value = '首先，其次\n仿佛';
    bannedEl.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(120);
    ok('修改后写回书本', b.styleRules.banned === '首先，其次\n仿佛', b.styleRules.banned);
    ok('文风规则进入提示词',
      AI.buildChapterPrompt(b, c2).user.indexOf('仿佛') >= 0);
  }

  /* ============================================================
   [D3] 阅读页取当前章节 + 一致性审计入口
   Reader.chapter 曾经漏了定义 → 靠它取章节的动作在 `if (!c) return`
   处静默失效，页面上点了没反应。
   ============================================================ */
  console.log('\n[D3] 阅读页当前章节 / 审计入口');
  w.UI.closeSheet();
  w.location.hash = '#/read/' + b.id + '/' + c2.id; w.UI.route(); await sleep(100);
  ok('Reader.chapter 能取到当前章节', !!w.Reader.chapter && w.Reader.chapter.id === c2.id,
    w.Reader.chapter && w.Reader.chapter.id);
  ok('取到的章节与阅读位置一致',
    Store.chapterIndex(b, w.Reader.chapter.id) === w.Reader.index);
  if (!Store.getChapter(b, c2.id).content) {
    Store.getChapter(b, c2.id).content = '他推开城门，风从北方灌进来。';
    Store.save(); w.Reader.refreshCur(); await sleep(60);
  }
  const nAudit = seen.length;
  click('[data-act="reader.menu"]'); await sleep(60);
  click('[data-act="reader.audit"]'); await sleep(400);
  ok('一致性审计真的发出了请求（此前被 undefined 挡掉）',
    seen.slice(nAudit).some(x => !x.body.stream), String(seen.length - nAudit));
  ok('审计走的是 audit 方案', (function () {
    const r = seen.slice(nAudit).filter(x => !x.body.stream)[0];
    return r && r.body.model === 'cheap-1';
  })());
  w.UI.closeSheet();

  /* ============================================================
   [D2] 设定管理：开关 + 「修改已有设定」建议的界面流程
   ============================================================ */
  console.log('\n[D2] 设定管理模型');
  w.UI.closeSheet();
  w.location.hash = '#/book/' + b.id + '/memory'; w.UI.route(); await sleep(60);
  ok('记忆页有「设定管理模型」开关', !!$('[data-act="world.governToggle"]'));
  ok('默认开启', b.worldGovern !== false);
  click('[data-act="world.governToggle"]'); await sleep(80);
  ok('可以关掉（省一次请求）', b.worldGovern === false);
  click('[data-act="world.governToggle"]'); await sleep(80);
  ok('可以重新开启', b.worldGovern === true);

  // 造一条「修改已有设定」的建议，走完整的应用流程
  const wLin = Store.addWorldEntry(b, 'characters', '老周', '铁匠');
  const upId = Store.addWorldSuggestions(b, [{
    kind: 'update', targetId: wLin.id, cat: 'characters', name: '老周',
    content: '铁匠；本章揭示他是北境守夜人', prevContent: '铁匠', reason: '本章揭示身世'
  }], c2)[0];
  ok('修改型建议已入库', !!upId);
  w.location.hash = '#/book/' + b.id + '/world'; w.UI.route(); await sleep(60);
  const upCard = $$('.entry.sug').filter(x => x.textContent.indexOf('老周') >= 0)[0];
  ok('推荐区列出修改型建议', !!upCard);
  ok('修改型标了「改」', upCard && /改\s*人物|改/.test(upCard.textContent), upCard && upCard.textContent.slice(0, 80));
  ok('显示修改理由', upCard && upCard.textContent.indexOf('本章揭示身世') >= 0);
  ok('显示原内容以便对照', upCard && upCard.textContent.indexOf('原内容：铁匠') >= 0);
  ok('按钮是「应用修改」而不是「转正」',
    upCard && !!upCard.querySelector('[data-act="world.sug.accept"]') &&
    upCard.querySelector('[data-act="world.sug.accept"]').textContent.indexOf('应用修改') >= 0);

  const beforeN = b.world.characters.length;
  click(upCard.querySelector('[data-act="world.sug.accept"]'));
  await sleep(120);
  ok('应用后原条目被更新', wLin.content === '铁匠；本章揭示他是北境守夜人', wLin.content);
  ok('没有多出一条重复条目', b.world.characters.length === beforeN);
  ok('应用后从推荐区消失', !$$('.entry.sug').some(x => x.textContent.indexOf('老周') >= 0));

  /* ============================================================
   [E] 运行期错误检查
   ============================================================ */
  console.log('\n[E] 运行期错误检查');
  const real = errs.filter(e => !/Not implemented: navigation/.test(e));
  ok('全程无 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
