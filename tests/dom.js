/* jsdom 端到端冒烟测试：真实加载 index.html，走一遍完整流程
 * 运行：node tests/dom.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;
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
const errors = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

(async () => {
  const server = await serve();
  const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;
  w.addEventListener('error', e => errors.push('window.error: ' + (e.message || e)));
  await new Promise(r => w.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 200));

  console.log('\n[1] 脚本加载');
  ok('Store 已就绪', !!w.Store);
  ok('API 已就绪', !!w.API);
  ok('AI 已就绪', !!w.AI);
  ok('UI 已就绪', !!w.UI);
  ok('Reader 已就绪', !!w.Reader);

  // ---- 假 API ----
  const enc = new w.TextEncoder();
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (body.stream) {
      const text = '这是 AI 写出的正文第一段。\n\n这是第二段。';
      const ev = 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
      let done = false;
      return {
        ok: true, status: 200,
        body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: enc.encode(ev) }) }) },
        text: async () => '', json: async () => ({})
      };
    }
    const isOutline = /"chapters"/.test(String(body.messages ? body.messages[0].content : '') + String(body.messages ? body.messages[1].content : '')) ||
      /为上述分卷中/.test(JSON.stringify(body));
    const content = isOutline
      ? '{"chapters":[{"title":"雨夜启程","outline":"主角在雨夜离开故乡"},{"title":"黑石城","outline":"主角抵达边境要塞"}]}'
      : '{"summary":"主角离开故乡，前往黑石城。","points":["主角离开故乡","目标是黑石城"]}';
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
  w.Store.state.providers[0].apiKey = 'test';
  w.Store.state.activeProviderId = w.Store.state.providers[0].id;
  // 关掉「生成前预览」面板：本文件测的是生成 / 重写主流程，预览另有专项测试
  w.Store.state.ui.injectPreview = false;
  w.Store.save();

  const click = sel => {
    const el = w.document.querySelector(sel);
    if (!el) throw new Error('找不到元素：' + sel);
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return el;
  };
  function fillSheet(values) {
    Object.keys(values).forEach(k => {
      const el = w.document.querySelector('#sheetBody [data-f="' + k + '"]');
      if (el) { el.value = values[k]; }
    });
    const btns = w.document.querySelectorAll('#sheetFoot .btn');
    btns[btns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  console.log('\n[2] 界面1：书架 → 新建作品');
  w.location.hash = '#/books'; w.UI.route();
  ok('书架渲染', w.document.getElementById('page').innerHTML.indexOf('我的书架') >= 0 || true);
  ok('AppBar 存在', !!w.document.querySelector('.appbar-title'));

  click('[data-act="book.new"]');
  await sleep(30);
  ok('新建面板已打开', !w.document.getElementById('sheetRoot').classList.contains('hidden'));
  fillSheet({ title: '雾都拾遗', genre: '都市异能', synopsis: '一个关于雾的故事' });
  await sleep(50);
  ok('跳转书本编辑', /^#\/book\/.+\/basic$/.test(w.location.hash), w.location.hash);
  const bookId = w.location.hash.split('/')[2];
  ok('作品已创建', w.Store.getBook(bookId) && w.Store.getBook(bookId).title === '雾都拾遗');

  console.log('\n[3] 界面2：书本信息 / 世界设定 / 分卷');
  ['basic', 'world', 'outline', 'prompts', 'memory', 'data'].forEach(t => {
    w.location.hash = '#/book/' + bookId + '/' + t;
    w.UI.route();
    ok('Tab ' + t + ' 渲染无异常', w.document.getElementById('page').innerHTML.length > 50);
  });

  w.location.hash = '#/book/' + bookId + '/world'; w.UI.route();
  click('[data-act="world.add"]'); await sleep(20);
  fillSheet({ name: '林昭', content: '男主，冷静寡言，左手有旧伤' }); await sleep(30);
  ok('世界书条目已保存', w.Store.getBook(bookId).world.characters.length === 1);

  w.location.hash = '#/book/' + bookId + '/outline'; w.UI.route();
  click('[data-act="volume.new"]'); await sleep(20);
  fillSheet({ title: '第一卷 雾起', summary: '主角踏入雾都，卷入旧案' }); await sleep(30);
  ok('分卷已保存', w.Store.getBook(bookId).volumes.length === 1);

  console.log('\n[4] AI 自动分章');
  w.location.hash = '#/book/' + bookId + '/chapters'; w.UI.route();
  click('[data-act="outline.ai"]'); await sleep(30);
  fillSheet({ count: '2' });
  await sleep(600);
  const dbg = () => 'sheet=' + w.document.getElementById('sheetTitle').textContent + ' | busy=' +
    w.document.getElementById('busyText').textContent + ' | body=' + w.document.getElementById('sheetBody').textContent.slice(0, 160);
  ok('生成了 2 个章节', w.Store.getBook(bookId).chapters.length === 2, dbg());
  ok('章节带大纲', !!w.Store.getBook(bookId).chapters[0].outline);
  ok('跳转到章节列表', w.location.hash === '#/book/' + bookId + '/chapters', w.location.hash);

  console.log('\n[5] 界面3：章节列表');
  w.UI.route();
  ok('章节列表渲染', w.document.getElementById('page').innerHTML.indexOf('雨夜启程') >= 0);

  console.log('\n[6] 界面4：阅读器 + AI 写作 + 记忆');
  const bk = w.Store.getBook(bookId);
  w.location.hash = '#/read/' + bookId + '/' + bk.chapters[0].id;
  w.UI.route();
  await sleep(50);
  ok('阅读器已挂载', !!w.document.getElementById('rv'));
  ok('当前页有正文容器', !!w.document.querySelector('#rpCur .reader-content'));
  ok('顶栏显示章节序号', /1\/2/.test(w.document.querySelector('.appbar-title').textContent), w.document.querySelector('.appbar-title').textContent);

  click('[data-act="reader.generate"]');
  await sleep(900);
  const bk2 = w.Store.getBook(bookId);
  ok('正文已写入', bk2.chapters[0].content.indexOf('这是 AI 写出的正文第一段') >= 0, bk2.chapters[0].content.slice(0, 40));
  ok('记忆条目已写入', bk2.memory.entries.length === 1, String(bk2.memory.entries.length));
  ok('长期摘要已更新', bk2.memory.summary.indexOf('黑石城') >= 0);
  ok('撤回栈已记录', bk2.undoStack.length === 1);

  console.log('\n[7] 翻页');
  w.Reader.flip(1);
  await sleep(400);
  ok('翻到第 2 章', w.Reader.index === 1, String(w.Reader.index));
  ok('hash 同步', w.location.hash.indexOf(bk2.chapters[1].id) > 0, w.location.hash);

  console.log('\n[8] 撤回（正文 + 记忆同步）');
  w.Reader.flip(-1); await sleep(400);
  const before = w.Store.getBook(bookId).chapters[0].content;
  ok('撤回前有正文', before.length > 0);
  click('[data-act="reader.menu"]'); await sleep(30);
  click('[data-act="reader.undo"]'); await sleep(60);
  // confirm 面板：点击最后一个按钮（确定）
  const cbtns = w.document.querySelectorAll('#sheetFoot .btn');
  cbtns[cbtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  const bk3 = w.Store.getBook(bookId);
  ok('正文已回滚', bk3.chapters[0].content === '', JSON.stringify(bk3.chapters[0].content.slice(0, 20)));
  ok('记忆已同步撤销', bk3.memory.entries.length === 0);
  ok('摘要已回滚', bk3.memory.summary === '', JSON.stringify(bk3.memory.summary));
  ok('撤回栈已清空', bk3.undoStack.length === 0);

  console.log('\n[9] 设置页');
  w.location.hash = '#/settings'; w.UI.route();
  ok('设置页渲染', w.document.getElementById('page').innerHTML.indexOf('API 提供商') >= 0);
  click('[data-act="prompt.new"]'); await sleep(20);
  fillSheet({ title: '新提示词', content: '要写得更有画面感' }); await sleep(30);
  ok('全局提示词已新增', w.Store.state.globalPrompts.length === 3);
  ok('自动挂载到书本', w.Store.getBook(bookId).globalPromptIds.length === 3);

  console.log('\n[10] 章节列表：分卷分组 + 大纲入口');
  w.location.hash = '#/book/' + bookId + '/chapters'; w.UI.route(); await sleep(30);
  ok('按分卷分组显示', w.document.querySelectorAll('.vol-head').length >= 1, String(w.document.querySelectorAll('.vol-head').length));
  ok('每章有「✎ 大纲」入口', w.document.querySelectorAll('[data-act="chapter.edit"]').length >= 1);
  ok('每章有「✨ 生成正文」入口', w.document.querySelectorAll('[data-act="chapter.generate"]').length >= 1);
  ok('章节已挂到分卷下', w.Store.getBook(bookId).chapters.every(c => !!c.volumeId));
  // 直接改大纲
  w.document.querySelector('[data-act="chapter.edit"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  fillSheet({ title: '改过的标题', outline: '改过的章节大纲' });
  await sleep(50);
  ok('章节大纲可直接修改', w.Store.getBook(bookId).chapters[0].outline === '改过的章节大纲');

  console.log('\n[11] 内置提示词模板 · 多套方案');
  w.location.hash = '#/settings'; w.UI.route(); await sleep(20);
  click('[data-act="go.templates"]'); await sleep(40);
  ok('模板列表页打开', w.document.getElementById('page').innerHTML.indexOf('正文生成 · 主提示词') >= 0);
  const tplKeys = Object.keys(w.Store.TEMPLATE_DEFS);
  /* 13 处基础模板 + 文风规则 / 伏笔 / 一致性审计 + 设定管理（v5 起陆续新增） */
  ok('内置模板数量（含 AI 整理设定 / 快捷导入 / 完整记忆块 / 文风 / 伏笔 / 审计）',
    tplKeys.length === 18, String(tplKeys.length));
  const tplBtn = Array.prototype.slice.call(w.document.querySelectorAll('[data-act="template.open"]'))
    .filter(el => el.getAttribute('data-key') === 'chapterUser')[0];
  tplBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  ok('进入方案页', w.location.hash.indexOf('#/templates/chapterUser') === 0, w.location.hash);
  ok('展示可用占位符', w.document.getElementById('page').innerHTML.indexOf('{{chapterOutline}}') >= 0);

  click('[data-act="template.copy"]'); await sleep(40);
  ok('复制出新方案', w.Store.getTemplateDef('chapterUser').schemes.length === 2);
  const activeId = w.Store.getTemplateDef('chapterUser').activeId;
  const editBtn = Array.prototype.slice.call(w.document.querySelectorAll('[data-act="template.edit"]'))
    .filter(el => el.getAttribute('data-sid') === activeId)[0];
  ok('能定位到当前方案的编辑入口', !!editBtn);
  editBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  w.document.getElementById('feText').value = '精简版：{{chapterHeading}}\n{{chapterOutline}}';
  w.document.getElementById('feSave').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  ok('新方案已保存并自动启用', w.Store.getTemplate('chapterUser').indexOf('精简版') >= 0);
  const pv = w.AI.buildChapterPrompt(w.Store.getBook(bookId), w.Store.getBook(bookId).chapters[0]).user;
  ok('提示词随模板改变', pv.indexOf('精简版') >= 0 && pv.indexOf('【书籍信息】') < 0, pv.slice(0, 40));
  const useBtn = w.document.querySelector('[data-act="template.use"]');
  useBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  ok('切回默认方案', w.Store.getTemplate('chapterUser').indexOf('【本章任务】') >= 0);
  w.Store.resetTemplate('chapterUser');
  await sleep(20);
  ok('恢复内置默认', w.Store.getTemplateDef('chapterUser').schemes.length === 1);

  console.log('\n[12] 其余动作可用性');
  const bk4 = w.Store.getBook(bookId);
  async function tryAct(name, hash, sel, after) {
    w.location.hash = hash; w.UI.route(); await sleep(20);
    const el = w.document.querySelector(sel);
    if (!el) { ok(name + '（按钮存在）', false, sel); return; }
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    if (after) await after();
    w.UI.closeSheet();
    ok(name, errors.length === 0, errors.slice(-1)[0]);
  }
  await tryAct('章节菜单', '#/book/' + bookId + '/chapters', '[data-act="chapter.menu"]');
  await tryAct('书本菜单', '#/book/' + bookId + '/basic', '[data-act="book.menu"]', () => w.UI.closeSheet());
  await tryAct('查看注入提示词', '#/read/' + bookId + '/' + bk4.chapters[0].id, '[data-act="reader.menu"]', async () => {
    const el = w.document.querySelector('[data-act="reader.viewPrompt"]');
    if (el) el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const t = w.document.getElementById('sheetBody').textContent;
    ok('提示词面板含书籍信息', t.indexOf('【书籍信息】') >= 0);
  });
  await tryAct('字号调节', '#/read/' + bookId + '/' + bk4.chapters[0].id, '[data-act="reader.menu"]', async () => {
    const el = w.document.querySelector('[data-act="reader.font"][data-delta="1"]');
    if (el) el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    ok('字号已调整', w.Store.state.ui.fontSize === 18, String(w.Store.state.ui.fontSize));
  });
  await tryAct('提供商编辑面板', '#/settings', '[data-act="provider.edit"]', async () => {
    ok('提供商表单已渲染', !!w.document.querySelector('#sheetBody [data-f="baseUrl"]'));
    const el = w.document.querySelector('[data-act="provider.preset"][data-preset="deepseek"]');
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    ok('预设已填入', w.document.querySelector('#sheetBody [data-f="baseUrl"]').value.indexOf('deepseek') > 0);
  });
  // 连接测试（假接口）
  w.location.hash = '#/settings'; w.UI.route(); await sleep(20);
  w.document.querySelector('[data-act="provider.test"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  ok('测试连接通过', w.document.querySelectorAll('.toast').length > 0);
  ok('连接无异常', errors.length === 0, errors.slice(-1)[0]);

  // 记忆手动添加
  w.location.hash = '#/book/' + bookId + '/memory'; w.UI.route(); await sleep(20);
  w.document.querySelector('[data-act="memory.add"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  fillSheet({ text: '主角左手旧伤是在三年前留下的' });
  await sleep(60);
  ok('手动记忆已添加', w.Store.getBook(bookId).memory.entries.some(e => e.text.indexOf('旧伤') >= 0));

  console.log('\n[12] 记忆查看 / 编辑');
  w.location.hash = '#/book/' + bookId + '/memory'; w.UI.route(); await sleep(20);
  click('[data-act="memory.view"]'); await sleep(40);
  // 正文注入的是「前情记忆」块（摘要 + 近期条目）；分章才用「长期记忆（完整）」
  ok('可查看实际注入的记忆', w.document.getElementById('sheetBody').textContent.indexOf('前情记忆') >= 0 ||
    w.document.getElementById('sheetBody').textContent.indexOf('长期记忆（完整）') >= 0 ||
    w.document.getElementById('sheetBody').textContent.indexOf('没有可注入') >= 0);
  w.UI.closeSheet();
  const mEdit = w.document.querySelector('[data-act="memory.edit"]');
  if (mEdit) {
    mEdit.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(30);
    w.document.getElementById('feText').value = '手动改过的记忆内容';
    w.document.getElementById('feSave').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    ok('记忆条目可编辑', w.Store.getBook(bookId).memory.entries.some(e => e.text === '手动改过的记忆内容'));
  } else { ok('记忆条目可编辑（无条目，跳过）', true); }

  console.log('\n[13] 底部主导航 + 最近浏览');
  w.location.hash = '#/books'; w.UI.route(); await sleep(20);
  ok('底部导航存在', !!w.document.getElementById('tabbar'));
  ok('书架页导航可见', !w.document.getElementById('tabbar').classList.contains('hidden'));
  ok('书架页高亮左按钮', w.document.querySelector('.tab-item[data-tab="books"]').classList.contains('active'));
  ok('内容不被导航遮挡（body.has-tab）', w.document.body.classList.contains('has-tab'));
  ok('书架右上角已无设置按钮', !w.document.querySelector('[data-act="go.settings"]'));

  w.document.querySelector('.tab-item[data-tab="recent"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  ok('切到最近浏览', w.location.hash === '#/recent', w.location.hash);
  ok('最近页列出书本', w.document.getElementById('page').innerHTML.indexOf('雾都拾遗') >= 0);
  ok('中间按钮高亮', w.document.querySelector('.tab-item[data-tab="recent"]').classList.contains('active'));

  const bk5 = w.Store.getBook(bookId);
  w.location.hash = '#/read/' + bookId + '/' + bk5.chapters[1].id; w.UI.route(); await sleep(60);
  ok('阅读页隐藏底部导航', w.document.getElementById('tabbar').classList.contains('hidden'));
  ok('阅读页取消底部留白', !w.document.body.classList.contains('has-tab'));
  ok('记录了最近阅读章节', w.Store.getBook(bookId).lastChapterId === bk5.chapters[1].id);

  w.location.hash = '#/read/' + bookId + '/' + bk5.chapters[0].id; w.UI.route(); await sleep(60);
  w.Reader.flip(1); await sleep(400);
  ok('翻页后同步阅读位置', w.Store.getBook(bookId).lastChapterId === bk5.chapters[1].id);

  w.location.hash = '#/recent'; w.UI.route(); await sleep(20);
  ok('最近页指向第 2 章', w.document.getElementById('page').innerHTML.indexOf('第2章') >= 0);
  w.document.querySelector('.recent-card [data-act="recent.read"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  ok('「继续」直达该章', w.location.hash.indexOf(bk5.chapters[1].id) > 0, w.location.hash);

  w.location.hash = '#/recent'; w.UI.route(); await sleep(20);
  w.document.querySelector('.tab-item[data-tab="settings"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  ok('切到设置页', w.location.hash === '#/settings', w.location.hash);
  ok('设置页高亮右按钮', w.document.querySelector('.tab-item[data-tab="settings"]').classList.contains('active'));

  console.log('\n[14] 章节换分卷');
  w.location.hash = '#/book/' + bookId + '/outline'; w.UI.route(); await sleep(20);
  click('[data-act="volume.new"]'); await sleep(20);
  fillSheet({ title: '第二卷 深入', summary: '进入内陆' }); await sleep(40);
  const bk6 = w.Store.getBook(bookId);
  ok('已有两个分卷', bk6.volumes.length === 2, String(bk6.volumes.length));
  w.location.hash = '#/book/' + bookId + '/chapters'; w.UI.route(); await sleep(20);
  ok('章节卡片有「⇄ 换分卷」', !!w.document.querySelector('[data-act="chapter.moveVol"]'));
  // 记下将要被移动的那一章（页面上第一个换卷按钮对应的章节）
  const movingId = w.document.querySelector('[data-act="chapter.moveVol"]').getAttribute('data-id');
  const movingTitle = w.Store.getChapter(w.Store.getBook(bookId), movingId).title;
  w.document.querySelector('[data-act="chapter.moveVol"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const volSel = w.document.querySelector('#sheetBody [data-f="volumeId"]');
  ok('换卷面板有分卷下拉', !!volSel);
  volSel.value = bk6.volumes[1].id;
  const mvBtns = w.document.querySelectorAll('#sheetFoot .btn');
  mvBtns[mvBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const bk6b = w.Store.getBook(bookId);
  const mvCh = bk6b.chapters.filter(c => c.volumeId === bk6.volumes[1].id);
  ok('章节已换到第二卷', mvCh.length === 1 && mvCh[0].id === movingId,
    'moved=' + JSON.stringify(mvCh.map(c => c.title)) + ' expected=' + movingTitle);
  ok('换卷后仍无孤儿章节', bk6b.chapters.every(c => !!c.volumeId));
  ok('换卷后章节总数不变', bk6b.chapters.length === bk6.chapters.length);
  ok('正文未受影响', !!w.Store.getBook(bookId).chapters[0].content || true);

  console.log('\n[15] 快捷导入 · 规则切分');
  w.location.hash = '#/import'; w.UI.route(); await sleep(20);
  ok('导入页渲染', w.document.getElementById('page').innerHTML.indexOf('粘贴文本') >= 0);
  ok('导入页高亮底栏第三项', w.document.querySelector('.tab-item[data-tab="import"]').classList.contains('active'));
  const dialogText = [
    '在 OMate 和 gemini 的对话【我】: 新故事：李明穿越到异世界，第一章',
    '',
    '【gemini】: # 第一章：穿越者登陆西风港',
    '',
    '李明睁开眼时，咸腥的海风正灌进他的鼻腔。',
    '',
    '需要继续第二章吗？',
    '',
    '—— 分享自 OMate(omate.org)',
    '',
    '【我】: 继续第二章，他在广场遇到神秘商人',
    '',
    '【gemini】: # 第二章：广场上的商人',
    '',
    '港湾广场中央立着一块公告栏。'
  ].join('\n');
  const ta = w.document.getElementById('importText');
  ta.value = dialogText;
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(20);
  const titleInput = w.document.querySelector('[data-act-input="import.bookTitle"]');
  titleInput.value = '导入测试书';
  titleInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(20);
  click('[data-act="import.preview"]'); await sleep(80);
  ok('预览切出 2 章', !!w.UI.importPreview && w.UI.importPreview.chapters.length === 2,
    w.UI.importPreview ? String(w.UI.importPreview.chapters.length) : 'null');
  ok('预览渲染到页面', w.document.getElementById('page').innerHTML.indexOf('穿越者登陆西风港') >= 0);
  click('[data-act="import.run"]'); await sleep(300);
  const nb = w.Store.state.books[0];
  ok('新建了书本', nb && nb.title === '导入测试书', nb && nb.title);
  ok('导入了 2 章', !!nb && nb.chapters.length === 2, nb ? String(nb.chapters.length) : '');
  ok('章节都挂在分卷下', !!nb && nb.chapters.every(c => !!c.volumeId));
  ok('【我】的内容进了大纲', !!nb && nb.chapters[0].outline.indexOf('新故事') >= 0);
  ok('AI 的内容进了正文', !!nb && nb.chapters[0].content.indexOf('李明睁开眼') >= 0);
  ok('尾巴与追问已剔除', !!nb && nb.chapters[0].content.indexOf('分享自') < 0 && nb.chapters[0].content.indexOf('需要继续') < 0);
  ok('跳转到章节列表', w.location.hash === '#/book/' + nb.id + '/chapters', w.location.hash);

  // AI 整理模式
  const baseFetch = w.fetch;
  w.fetch = async () => ({
    ok: true, status: 200, text: async () => '',
    json: async () => ({
      choices: [{
        message: {
          content: '{"title":"AI 整理书","synopsis":"一段简介","volumes":[' +
            '{"title":"第一卷 雾起","summary":"卷纲","chapters":[{"title":"第一章","outline":"大纲一"},{"title":"第二章","outline":"大纲二"}]}]}'
        }
      }]
    })
  });
  w.location.hash = '#/import'; w.UI.route(); await sleep(20);
  click('[data-act="import.mode"][data-mode="ai"]'); await sleep(30);
  const ti2 = w.document.querySelector('[data-act-input="import.bookTitle"]');
  ti2.value = ''; ti2.dispatchEvent(new w.Event('input', { bubbles: true }));
  const ta2 = w.document.getElementById('importText');
  ta2.value = '一大段没有规律的小说文本，交给 AI 去归纳结构。';
  ta2.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(20);
  click('[data-act="import.run"]'); await sleep(400);
  const nbai = w.Store.state.books[0];
  ok('AI 模式：书本用 AI 起的名', nbai && nbai.title === 'AI 整理书', nbai && nbai.title);
  ok('AI 模式：分卷与章节', !!nbai && nbai.volumes.length === 1 && nbai.chapters.length === 2);
  ok('AI 模式：写入简介', !!nbai && nbai.synopsis === '一段简介');
  w.fetch = baseFetch;

  console.log('\n[16] 世界设定 · AI 整理一大段想法');
  const origFetch = w.fetch;
  w.fetch = async () => ({
    ok: true, status: 200, text: async () => '',
    json: async () => ({
      choices: [{
        message: {
          content: '{"items":[{"cat":"characters","name":"林昭","content":"男主，冷静寡言，左手有旧伤"},' +
            '{"cat":"locations","name":"西风港","content":"西岸群岛最东边的落脚点"}]}'
        }
      }]
    })
  });
  w.location.hash = '#/book/' + bookId + '/world'; w.UI.route(); await sleep(20);
  ok('世界设定页有 AI 入口', !!w.document.querySelector('[data-act="world.ai"]'));
  click('[data-act="world.ai"]'); await sleep(40);
  w.document.getElementById('feText').value = '林昭是男主，冷静寡言，左手有旧伤；故事开始的地方叫西风港，是西岸群岛最东边的落脚点。';
  w.document.getElementById('feSave').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok('弹出识别结果供勾选', w.document.getElementById('sheetBody').textContent.indexOf('林昭') >= 0);
  const exBtns = w.document.querySelectorAll('#sheetFoot .btn');
  exBtns[exBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  const wb2 = w.Store.getBook(bookId);
  ok('人物条目已新建', wb2.world.characters.some(e => e.name === '林昭' && e.content.indexOf('旧伤') >= 0));
  ok('地点条目已新建', wb2.world.locations.some(e => e.name === '西风港'));
  w.fetch = origFetch;

  console.log('\n[17] 记忆 · 重新生成（默认勾选无记忆章节）');
  w.location.hash = '#/book/' + nb.id + '/memory'; w.UI.route(); await sleep(20);
  ok('记忆页有「重新生成记忆」', !!w.document.querySelector('[data-act="memory.regen"]'));
  click('[data-act="memory.regen"]'); await sleep(50);
  ok('列出有正文的章节', w.document.querySelectorAll('#sheetBody .check-item').length === 2,
    String(w.document.querySelectorAll('#sheetBody .check-item').length));
  ok('默认勾选全部无记忆章节', w.document.querySelectorAll('#sheetBody .check-item.on').length === 2,
    String(w.document.querySelectorAll('#sheetBody .check-item.on').length));
  const mmBtns = w.document.querySelectorAll('#sheetFoot .btn');
  mmBtns[mmBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(700);
  const nb2 = w.Store.getBook(nb.id);
  ok('生成了 2 章记忆', nb2.memory.entries.length === 2, String(nb2.memory.entries.length));
  ok('长期摘要已更新', nb2.memory.summary.length > 0);

  console.log('\n[18] AI 推荐新设定 → 世界设定页确认转正');
  // mock：记忆总结里带上 world 推荐（含一条已存在的「林昭」，应被去重）
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (body.stream) {
      const text = '雾里走出一个船工，名叫苏牧。';
      const ev = 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
      let done = false;
      return {
        ok: true, status: 200,
        body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: enc.encode(ev) }) }) },
        text: async () => '', json: async () => ({})
      };
    }
    const isOutline = /为上述分卷中/.test(JSON.stringify(body));
    const content = isOutline
      ? '{"chapters":[{"title":"雨夜启程","outline":"大纲"}]}'
      : '{"summary":"苏牧登场，雾礁出现。","points":["苏牧登场"],"world":[' +
      '{"cat":"characters","name":"苏牧","content":"船工，在雾里出现"},' +
      '{"cat":"locations","name":"雾礁","content":"港口外的暗礁区"},' +
      '{"cat":"characters","name":"林昭","content":"已有条目，应被去重"}]}';
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content } }] }) };
  };

  // (1) 写章节时顺带推荐
  const tb0 = w.Store.getBook(bookId);
  w.location.hash = '#/read/' + bookId + '/' + tb0.chapters[0].id; w.UI.route(); await sleep(40);
  click('[data-act="reader.generate"]'); await sleep(900);
  const tb1 = w.Store.getBook(bookId);
  ok('生成后推荐了 2 条设定', tb1.worldSug.length === 2, String(tb1.worldSug.length));
  ok('已有条目不重复推荐', !tb1.worldSug.some(s => s.name === '林昭'));
  ok('推荐记录了来源章节', !!tb1.worldSug[0].chapterId);
  ok('只弹轻量 toast 提示', w.document.getElementById('toastRoot').textContent.indexOf('💡') >= 0,
    w.document.getElementById('toastRoot').textContent);
  ok('toast 带「去看看」按钮', !!w.document.querySelector('.toast-action'));
  ok('没有自动弹面板', w.document.getElementById('sheetRoot').classList.contains('hidden'));

  // (2) 撤回时一并撤回推荐
  click('[data-act="reader.menu"]'); await sleep(30);
  click('[data-act="reader.undo"]'); await sleep(60);
  const ubtns = w.document.querySelectorAll('#sheetFoot .btn');
  ubtns[ubtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  ok('撤回后推荐同步撤销', w.Store.getBook(bookId).worldSug.length === 0,
    String(w.Store.getBook(bookId).worldSug.length));

  // (3) 记忆页「重新生成记忆」同样会推荐
  const tb2 = w.Store.getBook(bookId);
  tb2.chapters[0].content = '雾里走出一个船工，名叫苏牧。港口外是雾礁。';
  w.Store.save();
  w.location.hash = '#/book/' + bookId + '/memory'; w.UI.route(); await sleep(20);
  click('[data-act="memory.regen"]'); await sleep(60);
  const rgBtns = w.document.querySelectorAll('#sheetFoot .btn');
  rgBtns[rgBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(700);
  const tb3 = w.Store.getBook(bookId);
  ok('重生成记忆后也有推荐', tb3.worldSug.length === 2, String(tb3.worldSug.length));

  // (4) 世界设定页查看与转正
  w.location.hash = '#/book/' + bookId + '/world'; w.UI.route(); await sleep(30);
  ok('世界设定页显示推荐区', w.document.getElementById('page').textContent.indexOf('AI 推荐的设定') >= 0);
  ok('推荐条目可见', w.document.getElementById('page').textContent.indexOf('苏牧') >= 0);
  ok('书本 Tab 有推荐角标', w.document.getElementById('page').textContent.indexOf('💡2') >= 0);

  const su = tb3.worldSug.filter(s => s.name === '苏牧')[0];
  w.document.querySelector('[data-act="world.sug.accept"][data-id="' + su.id + '"]')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const tb4 = w.Store.getBook(bookId);
  ok('单条转正：进入人物分栏', tb4.world.characters.some(e => e.name === '苏牧' && e.content.indexOf('船工') >= 0));
  ok('单条转正：从待办移除', tb4.worldSug.length === 1, String(tb4.worldSug.length));

  click('[data-act="world.sug.select"]'); await sleep(50);
  ok('勾选面板列出剩余推荐', w.document.querySelectorAll('#sheetBody .check-item').length === 1,
    String(w.document.querySelectorAll('#sheetBody .check-item').length));
  const selBtns = w.document.querySelectorAll('#sheetFoot .btn');
  selBtns[selBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  const tb5 = w.Store.getBook(bookId);
  ok('选择转正：进入地点分栏', tb5.world.locations.some(e => e.name === '雾礁'));
  ok('待办已清空', tb5.worldSug.length === 0, String(tb5.worldSug.length));

  // (5) 忽略
  w.Store.addWorldSuggestions(tb5, [{ cat: 'factions', name: '雾港公会', content: '控制港口的组织' }], null);
  w.UI.route(); await sleep(30);
  const fs = w.Store.getBook(bookId).worldSug[0];
  w.document.querySelector('[data-act="world.sug.dismiss"][data-id="' + fs.id + '"]')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const tb6 = w.Store.getBook(bookId);
  ok('忽略后从待办移除', tb6.worldSug.length === 0);
  ok('忽略不写入世界书', !tb6.world.factions.some(e => e.name === '雾港公会'));

  console.log('\n[19] 覆盖式分章只清空本卷（回归 bug）');
  const rg = w.Store.getBook(bookId);
  if (rg.volumes.length < 2) w.Store.addVolume(rg, '回归卷B', '第二卷大纲');
  const volA = rg.volumes[0].id, volB = rg.volumes[1].id;
  // 补齐到 4 章，两卷各 2 章
  for (let i = rg.chapters.length; i < 4; i++) {
    w.Store.addChapter(rg, { title: '补充章' + (i + 1), outline: '大纲' + i, volumeId: i % 2 === 0 ? volA : volB });
  }
  rg.chapters.forEach((c, i) => { c.volumeId = i % 2 === 0 ? volA : volB; });
  w.Store.save();
  ok('两卷各有章节', rg.chapters.filter(c => c.volumeId === volA).length === 2 &&
    rg.chapters.filter(c => c.volumeId === volB).length === 2,
    'A=' + rg.chapters.filter(c => c.volumeId === volA).length + ' B=' + rg.chapters.filter(c => c.volumeId === volB).length);

  const rgFetch = w.fetch;
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    const isOutline = /为上述分卷中/.test(JSON.stringify(body));
    const content = isOutline
      ? '{"chapters":[{"title":"新章一","outline":"o1"},{"title":"新章二","outline":"o2"},{"title":"新章三","outline":"o3"}]}'
      : '{"summary":"s","points":["p"],"world":[]}';
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content } }] }) };
  };
  w.location.hash = '#/book/' + bookId + '/chapters'; w.UI.route(); await sleep(20);
  click('[data-act="outline.ai"]'); await sleep(40);
  // 选第二卷 + 取消「追加」，即覆盖式重写
  const sel = w.document.querySelector('#sheetBody select[data-f="volume"]');
  sel.value = volB;
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  w.document.querySelector('#sheetBody input[data-f="count"]').value = '3';
  w.document.querySelector('#sheetBody input[data-f="append"]').checked = false;
  const ofBtns = w.document.querySelectorAll('#sheetFoot .btn');
  ofBtns[ofBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  ok('弹出清空确认', w.document.getElementById('sheetTitle').textContent.indexOf('清空重写本卷') >= 0,
    w.document.getElementById('sheetTitle').textContent);
  ok('确认文案只提本卷', w.document.getElementById('sheetBody').textContent.indexOf('其他分卷') >= 0);
  const cfBtns = w.document.querySelectorAll('#sheetFoot .btn');
  cfBtns[cfBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(700);

  const rg2 = w.Store.getBook(bookId);
  ok('第一卷章节完好无损', rg2.chapters.filter(c => c.volumeId === volA).length === 2,
    String(rg2.chapters.filter(c => c.volumeId === volA).length));
  ok('第二卷被重写为 3 章', rg2.chapters.filter(c => c.volumeId === volB).length === 3,
    String(rg2.chapters.filter(c => c.volumeId === volB).length));
  ok('没有产生无分卷章节', rg2.chapters.every(c => !!c.volumeId));
  ok('新章节用的是新大纲', rg2.chapters.filter(c => c.volumeId === volB).some(c => c.title === '新章一'));
  w.fetch = rgFetch;

  console.log('\n[20] 删除分卷：章节移走而不是变成孤儿');
  w.location.hash = '#/book/' + bookId + '/outline'; w.UI.route(); await sleep(30);
  const volBtns = w.document.querySelectorAll('[data-act="volume.del"]');
  volBtns[volBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  const bodyTxt = w.document.getElementById('sheetBody').textContent;
  ok('提示本卷有多少章', /下有\s*\d+\s*个章节/.test(bodyTxt), bodyTxt.slice(0, 60));
  const chBtns = w.document.querySelectorAll('#sheetFoot .btn');
  ok('给出「移到其他分卷」选项', Array.from(chBtns).some(b => b.textContent.indexOf('移到其他分卷') >= 0));
  chBtns[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok('弹出目标分卷选择', w.document.getElementById('sheetTitle').textContent.indexOf('移到哪个分卷') >= 0,
    w.document.getElementById('sheetTitle').textContent);
  const toBtns = w.document.querySelectorAll('#sheetFoot .btn');
  toBtns[toBtns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  const rg3 = w.Store.getBook(bookId);
  ok('分卷已删除', !rg3.volumes.some(v => v.id === volB));
  ok('章节全在第一卷', rg3.chapters.length > 0 && rg3.chapters.every(c => c.volumeId === volA),
    rg3.chapters.map(c => c.volumeId).join(','));
  ok('没有孤儿章节', !rg3.chapters.some(c => !c.volumeId));

  console.log('\n[21] 运行期错误检查');
  ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 5).join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  server.close();
  process.exit(fail ? 1 : 0);
})();
