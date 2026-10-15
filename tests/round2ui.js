/* 第二轮改造 · jsdom 端到端 UI 测试：模型列表/余额拉取、模型方案、
 * 章节目录视图（收起/整行点击）、世界设定作用域、AI 重写与撤销、悬浮球
 * 运行：node tests/round2ui.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PORT = 8125;
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

  const click = (selOrEl) => {
    const el = typeof selOrEl === 'string' ? w.document.querySelector(selOrEl) : selOrEl;
    if (!el) throw new Error('找不到元素：' + selOrEl);
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return el;
  };
  const $ = s => w.document.querySelector(s);
  const $$ = s => Array.from(w.document.querySelectorAll(s));
  const fillSheet = (values) => {
    Object.keys(values).forEach(k => {
      const el = w.document.querySelector('#sheetBody [data-f="' + k + '"]');
      if (el) el.value = values[k];
    });
    const btns = $$('#sheetFoot .btn');
    btns[btns.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  };
  const ptr = (type, x, y) => {
    const E = w.PointerEvent || w.MouseEvent;
    $('#fab').dispatchEvent(new E(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 }));
  };

  // ---- 假 API：chat(流式/非流式) / models / balance ----
  const enc = new w.TextEncoder();
  const seen = [];
  w.fetch = async (url, opt) => {
    const u = String(url);
    const body = opt && opt.body ? JSON.parse(opt.body) : {};
    seen.push({ url: u, body: body });
    if (/\/models(\?|$)/.test(u)) {
      return { ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ id: 'zeta-model' }, { id: 'alpha-model' }, { id: 'beta-model' }] }) };
    }
    if (/\/user\/balance$/.test(u)) {
      return { ok: true, status: 200, text: async () => '', json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.5' }] }) };
    }
    if (body.stream) {
      const text = '这是重写后的正文第一段。\n\n第二段，节奏更快。';
      const ev = 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
      let done = false;
      return {
        ok: true, status: 200,
        body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: enc.encode(ev) }) }) },
        text: async () => '', json: async () => ({})
      };
    }
    const isOutline = /"chapters"/.test(JSON.stringify(body));
    const content = isOutline
      ? '{"chapters":[{"title":"雨夜启程","outline":"主角在雨夜离开故乡"}]}'
      : '{"summary":"主角离开故乡，前往黑石城。","points":["主角离开故乡"]}';
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content } }] }) };
  };

  // ---- fixture：两卷三章（两章有正文、一章没有） ----
  // 提供商直改 state 会绕过 migrate，这里按 migrate 的规则手动补一个默认方案，
  // 贴合 #17 合并后的真实数据结构（提供商只管连接，模型与参数在方案里）
  const Store = w.Store;
  Store.state.providers = [{ id: 'p1', name: '测试方', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-123456', model: 'gpt-4o-mini' }];
  Store.state.activeProviderId = 'p1';
  Store.state.modelPresets = [{ id: 'm1', name: '测试方 · 默认方案', providerId: 'p1', model: 'gpt-4o-mini', temperature: null, maxTokens: null }];
  Store.state.activePresetId = 'm1';
  // 关掉「生成前预览」面板：本文件测的是重写 / 悬浮球等流程，预览另有专项测试
  Store.state.ui.injectPreview = false;
  const b = Store.createBook('雾都拾遗');
  const v1 = Store.addVolume(b, '第一卷 雾起', '主角踏入雾都').id;
  const v2 = Store.addVolume(b, '第二卷 星落', '边境之外').id;
  const cWith = Store.addChapter(b, { title: '雨夜启程', outline: '主角在雨夜离开故乡', content: '雾很大。他背起行囊，走进夜色里。', volumeId: v1 });
  const cEmpty = Store.addChapter(b, { title: '黑石城', outline: '抵达边境要塞', content: '', volumeId: v1 });
  Store.addChapter(b, { title: '星图', outline: '观星会的遗迹', content: '星图缓缓亮起。', volumeId: v2 });
  Store.addWorldEntry(b, 'characters', '林昭', '男主，冷静寡言');
  Store.addWorldEntry(b, 'characters', '苏牧', '船工，嗓门很大');
  Store.save();

  /* ============================================================
   [A] 模型界面：拉取模型列表 + 查询余额
   （#17 合并后：提供商表单只管连接；模型名 / 温度 / Token 在模型方案里）
   ============================================================ */
  console.log('\n[A] 模型界面：模型列表与余额');
  w.location.hash = '#/settings'; w.UI.route(); await sleep(50);
  ok('设置页有新增提供商入口', !!$('[data-act="provider.new"]'));
  click('[data-act="provider.new"]'); await sleep(50);
  ok('提供商表单不再有模型名字段（已并入方案）', !$('#sheetBody [data-f="model"]'));
  ok('提供商表单有 Base URL 与 Key', !!$('#sheetBody [data-f="baseUrl"]') && !!$('#sheetBody [data-f="apiKey"]'));
  ok('表单有「查询余额」按钮', !!$('#sheetBody [data-act="provider.fetchBalance"]'));
  ok('表单有「余额查询地址」字段', !!$('#sheetBody [data-f="balanceUrl"]'));
  ok('表单提示模型在方案里配置', $('#sheetBody').textContent.indexOf('模型方案') >= 0,
    $('#sheetBody').textContent.slice(0, 120));

  // 保存提供商 → 自动引导建第一个模型方案（模型名在方案表单里选）
  $('#sheetBody [data-f="name"]').value = '拉取方';
  $('#sheetBody [data-f="baseUrl"]').value = 'https://api.deepseek.com/v1';
  $('#sheetBody [data-f="apiKey"]').value = 'sk-test-123456';
  fillSheet({});
  await sleep(180);
  ok('保存后引导建模型方案', $('#sheetTitle').textContent.indexOf('模型方案') >= 0, $('#sheetTitle').textContent);
  ok('方案表单锁定提供商', $('#sheetBody [data-f="providerId"]').options.length === 1 &&
    $('#sheetBody [data-f="providerId"]').options[0].text.indexOf('拉取方') >= 0,
    $('#sheetBody [data-f="providerId"]').textContent);
  ok('方案表单有模型字段', !!$('#sheetBody [data-f="model"]'));
  ok('方案表单能拉取模型列表', !!$('#sheetBody [data-act="provider.fetchModels"]'));

  // 拉取模型列表（按钮在面板内，不应把正在编辑的表单关掉）
  click('#sheetBody [data-act="provider.fetchModels"]');
  await sleep(150);
  ok('拉取后模型选择器注入当前面板', !!$('#mdlPick'), $('#sheetBody').textContent.slice(0, 80));
  ok('选择器列出全部模型', $$('#mdlPick [data-act="model.pick"]').length === 3);
  ok('模型按 id 排序展示', $('#mdlPick [data-act="model.pick"]').getAttribute('data-model') === 'alpha-model');
  ok('选择器带筛选框', !!$('#mdlFilter'));

  // 筛选
  $('#mdlFilter').value = 'beta';
  $('#mdlFilter').dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(30);
  const visible = $$('#mdlPick [data-act="model.pick"]').filter(b2 => b2.style.display !== 'none');
  ok('筛选只留匹配项', visible.length === 1 && visible[0].getAttribute('data-model') === 'beta-model',
    visible.map(x => x.getAttribute('data-model')).join(','));

  // 点选写回模型字段
  click($('#mdlPick [data-act="model.pick"][data-model="beta-model"]'));
  await sleep(30);
  ok('点选后模型字段被写入', $('#sheetBody [data-f="model"]').value === 'beta-model',
    $('#sheetBody [data-f="model"]').value);
  ok('点选后选择器收起', !$('#mdlPick'));

  // 保存方案（留空温度 / Token = 用默认值）
  fillSheet({ name: '拉取方 · 方案一' });
  await sleep(120);
  const fetched = Store.state.modelPresets.filter(m => m.model === 'beta-model')[0];
  ok('方案已保存', !!fetched, JSON.stringify(Store.state.modelPresets.map(m => m.model)));
  ok('保存后自动启用', Store.state.activePresetId === fetched.id);
  ok('activeModel 用方案模型', Store.activeModel().model === 'beta-model', Store.activeModel().model);

  // 查询余额（入口留在提供商表单）
  const editBtns = $$('[data-act="provider.edit"]');
  click(editBtns[editBtns.length - 1]); await sleep(50);
  ok('编辑表单预填已保存的连接', $('#sheetBody [data-f="baseUrl"]').value === 'https://api.deepseek.com/v1');
  click('#sheetBody [data-act="provider.fetchBalance"]');
  await sleep(150);
  const balTxt = $('#balHint') ? $('#balHint').textContent : '';
  ok('余额显示在表单旁', /42\.5/.test(balTxt), balTxt);
  w.UI.closeSheet();

  /* ============================================================
   [B] 模型方案（预设）
   ============================================================ */
  console.log('\n[B] 模型方案（预设）');
  w.location.hash = '#/settings'; w.UI.route(); await sleep(50);
  ok('设置页有「模型方案」区', $('#page').textContent.indexOf('模型方案') >= 0);
  ok('迁移出的默认预设在列表中', $$('#page .entry').some(e => e.textContent.indexOf('默认方案') >= 0));

  click('[data-act="preset.new"]'); await sleep(50);
  ok('预设表单有方案名称字段', !!$('#sheetBody [data-f="name"]'));
  ok('预设表单有提供商选择', !!$('#sheetBody [data-f="providerId"]'));
  ok('预设表单有模型字段', !!$('#sheetBody [data-f="model"]'));
  ok('预设表单也能拉取模型列表', !!$('#sheetBody [data-act="provider.fetchModels"]'));
  fillSheet({ name: 'Kimi 整理大纲', model: 'moonshot-v1-8k' });
  await sleep(80);
  const presets = Store.state.modelPresets;
  ok('新增预设成功', presets.some(m => m.name === 'Kimi 整理大纲' && m.model === 'moonshot-v1-8k'),
    JSON.stringify(presets.map(m => m.name)));
  ok('新增后自动启用', Store.state.activePresetId === presets[presets.length - 1].id);
  ok('activeModel 用预设模型', Store.activeModel().model === 'moonshot-v1-8k', Store.activeModel().model);
  ok('activeModel 带预设名', Store.activeModel().__presetName === 'Kimi 整理大纲');

  w.location.hash = '#/settings'; w.UI.route(); await sleep(50);
  const presetEntry = $$('#page .entry').filter(e => e.textContent.indexOf('Kimi 整理大纲') >= 0)[0];
  // 文案由「使用中」改为「兜底」：只显示启用会让人以为模型不能分工，
  // 实际上每类任务都能单独指派方案，启用状态只对未指派的任务生效
  ok('预设列表标注「兜底」', !!presetEntry && presetEntry.textContent.indexOf('兜底') >= 0);
  // [A] 节新建的「拉取方」是当前活动提供商，新方案默认挂在它下面
  ok('预设描述含提供商与模型', !!presetEntry && presetEntry.textContent.indexOf('拉取方') >= 0 && presetEntry.textContent.indexOf('moonshot-v1-8k') >= 0,
    presetEntry && presetEntry.textContent.slice(0, 80));

  // 停用/启用另一个预设
  const other = presets[0];
  const useBtn = $$('[data-act="preset.use"]').filter(x => x.getAttribute('data-id') === other.id)[0];
  click(useBtn); await sleep(60);
  ok('切换到另一个预设', Store.state.activePresetId === other.id);
  ok('activeModel 跟随切换', Store.activeModel().model === other.model);

  /* ============================================================
   [C] 章节目录视图（原「大纲分卷」合并而来；独立目录页已移除）
   ============================================================ */
  console.log('\n[C] 章节目录视图');
  const dirHash = '#/book/' + b.id + '/chapters';
  w.location.hash = dirHash; w.UI.route(); await sleep(60);
  ok('章节目录标签页被激活', $$('.tabs-fixed .tab.active').some(t => t.textContent.indexOf('章节目录') >= 0),
    $$('.tabs-fixed .tab.active').map(t => t.textContent).join('/'));
  ok('按分卷分组', $$('.vol-section').length === 2, String($$('.vol-section').length));
  ok('章节行总数正确', $$('.chapter-item').length === 3, String($$('.chapter-item').length));
  ok('整行可点击进入（data-act=read 在行上）', $$('.chapter-item').every(x => x.getAttribute('data-act') === 'read'));
  ok('章节号方块不再是唯一入口', $('.chapter-item .no') && !$('.chapter-item .no').hasAttribute('data-act'));
  ok('行内有功能按钮', !!$('.chapter-item [data-act="chapter.edit"]') && !!$('.chapter-item [data-act="chapter.menu"]'));
  ok('有正文显示「AI 重写」', $('.chapter-item [data-act="chapter.generate"]').textContent.indexOf('AI 重写') >= 0,
    $('.chapter-item [data-act="chapter.generate"]').textContent);
  ok('无正文显示「生成正文」', $$('.chapter-item [data-act="chapter.generate"]').some(x => x.textContent.indexOf('生成正文') >= 0));
  ok('卷标题行可点击（收起）', !!$('.vol-title-row[data-act="volume.collapse"]'));
  ok('默认展开（无 collapsed）', $$('.vol-section').every(x => !x.classList.contains('collapsed')));

  // 独立目录页的三个入口已并入本标签页
  ok('并入：浏览世界设定', !!$('#page [data-act="world.browse"]'));
  ok('并入：AI 自动分章', !!$('#page [data-act="outline.ai"]'));
  ok('并入：新建章节', !!$('#page [data-act="chapter.new"]'));
  ok('appbar 也有浏览世界设定', !!$('#appbar [data-act="world.browse"]'));

  // 点行内空白处（章节号）进入阅读
  const row = $$('.chapter-item')[0];
  click(row.querySelector('.no'));
  await sleep(80);
  ok('点章节行进入该章阅读', w.location.hash === '#/read/' + b.id + '/' + cWith.id, w.location.hash);
  w.location.hash = dirHash; w.UI.route(); await sleep(60);

  // 收起 / 打开
  click('.vol-title-row'); await sleep(40);
  ok('点卷标题收起该卷', $('.vol-section').classList.contains('collapsed'));
  click('.vol-title-row'); await sleep(40);
  ok('再点打开', !$('.vol-section').classList.contains('collapsed'));

  // 卷级操作按钮
  ok('卷级：自动分章', !!$('.vol-section [data-act="outline.ai"]'));
  ok('卷级：本卷新章', !!$('.vol-section [data-act="chapter.new"][data-vol]'));
  ok('卷级：卷大纲', !!$('.vol-section [data-act="volume.edit"]'));
  ok('卷级：删除', !!$('.vol-section [data-act="volume.del"]'));
  ok('底部有新建章节 / 自动分章 / 新增分卷', !!$('[data-act="chapter.new"]') && !!$('[data-act="volume.new"]'));

  // 老链接（#/chapters/{id}，原独立目录页）静默改写为标签页，不新增历史记录
  w.location.hash = '#/chapters/' + b.id; w.UI.route(); await sleep(60);
  ok('老目录链接改写为标签页', w.location.hash === dirHash, w.location.hash);
  ok('改写后仍渲染章节目录', $$('.vol-section').length === 2 && $$('.chapter-item').length === 3);

  // 书本编辑页：七个 tab 固定（新增「伏笔」） + chapters tab 就是目录
  w.location.hash = '#/book/' + b.id + '/basic'; w.UI.route(); await sleep(50);
  ok('标签容器固定（tabs-fixed）', !!$('.tabs.tabs-fixed'));
  ok('八个标签完整展示（含小编与伏笔）', $$('.tabs-fixed .tab').length === 8, String($$('.tabs-fixed .tab').length));
  const tabTexts = $$('.tabs-fixed .tab').map(t => t.textContent.trim());
  ok('「章节目录」tab 存在（原大纲分卷已合并）', tabTexts.some(t => t.indexOf('章节目录') >= 0), tabTexts.join('/'));
  ok('不再有「大纲分卷」tab', !tabTexts.some(t => t.indexOf('大纲分卷') >= 0));
  click($$('.tabs-fixed .tab').filter(t => t.textContent.indexOf('章节目录') >= 0)[0]);
  await sleep(60);
  ok('章节目录 tab 渲染同一视图', $$('.vol-section').length === 2 && $$('.chapter-item').length === 3);

  /* ============================================================
   [D] 世界设定：作用域切换与浏览
   ============================================================ */
  console.log('\n[D] 世界设定作用域');
  w.location.hash = '#/book/' + b.id + '/world'; w.UI.route(); await sleep(50);
  ok('有作用域切换 chips', !!$('.scope-chips'));
  const chips = $$('.scope-chips [data-act="world.scope"]');
  ok('chips = 全局 + 各分卷', chips.length === 3 && chips[0].textContent.indexOf('全局') >= 0, chips.map(c => c.textContent).join('/'));
  ok('默认编辑全局', chips[0].className.indexOf('primary') >= 0);

  // 切到第一卷
  click(chips[1]); await sleep(60);
  ok('切到分卷后提示专属', $('#page').textContent.indexOf('该分卷专属') >= 0);
  ok('分卷 chip 高亮', $$('.scope-chips [data-act="world.scope"]')[1].className.indexOf('primary') >= 0);

  // 在分卷作用下新增条目（先切到「地点」分栏，语义更清晰）
  click($$('.tabs-fixed .tab').filter(t => t.textContent.indexOf('地点') >= 0)[0]);
  await sleep(50);
  click('[data-act="world.add"]'); await sleep(50);
  ok('新增面板标题注明分卷专属', $('#sheetTitle').textContent.indexOf('专属') >= 0, $('#sheetTitle').textContent);
  fillSheet({ name: '雾港', content: '只在第一卷出现的港口' });
  await sleep(80);
  const added = b.world.locations.find(e => e.name === '雾港');
  ok('条目写入该分卷 scope', !!added && added.scope === v1, added && added.scope);

  // 切回全局：看不到分卷专属条目
  w.location.hash = '#/book/' + b.id + '/world'; w.UI.route(); await sleep(50);
  w.UI.worldScope[b.id] = '';
  w.UI.route(); await sleep(50);
  ok('全局视图不含分卷专属条目', $('#page').textContent.indexOf('雾港') < 0);
  w.UI.worldScope[b.id] = v1;
  w.UI.route(); await sleep(50);
  ok('分卷视图含专属条目', $('#page').textContent.indexOf('雾港') >= 0);
  // 切回「人物」分栏：全局条目在分卷视图带「全局」标注，且可改归属 / 复制到本卷
  click($$('.tabs-fixed .tab').filter(t => t.textContent.indexOf('人物') >= 0)[0]);
  await sleep(50);
  ok('全局条目在分卷视图也显示', $('#page').textContent.indexOf('林昭') >= 0);
  const globalEntry = $$('#page .entry').filter(e => e.textContent.indexOf('林昭') >= 0)[0];
  ok('全局条目带「全局」标注', !!globalEntry && globalEntry.textContent.indexOf('全局') >= 0);
  ok('全局条目可编辑（能改归属）', !!globalEntry && !!globalEntry.querySelector('[data-act="world.edit"]'));
  ok('全局条目有「复制到本卷」', !!globalEntry && !!globalEntry.querySelector('[data-act="world.copyToVol"]'));

  // 改归属：把「林昭」从全局改为第一卷专属
  click(globalEntry.querySelector('[data-act="world.edit"]')); await sleep(50);
  ok('编辑面板有归属选择', !!$('#sheetBody [data-f="scope"]'), $('#sheetBody').textContent.slice(0, 100));
  $('#sheetBody [data-f="scope"]').value = v1;
  fillSheet({});
  await sleep(80);
  const linzhao = b.world.characters.find(e => e.name === '林昭');
  ok('条目已改为分卷专属', !!linzhao && linzhao.scope === v1, linzhao && String(linzhao.scope));
  w.UI.worldScope[b.id] = '';
  w.UI.route(); await sleep(50);
  ok('全局视图不再含它', $('#page').textContent.indexOf('林昭') < 0);
  w.UI.worldScope[b.id] = v1;
  w.UI.route(); await sleep(50);
  ok('分卷视图含它（且不带全局标注）', $('#page').textContent.indexOf('林昭') >= 0 &&
    $$('#page .entry').filter(e => e.textContent.indexOf('林昭') >= 0)[0].textContent.indexOf('全局') < 0);

  // 复制到本卷：全局「苏牧」复制一份第一卷专属，全局原文不动
  click($$('.tabs-fixed .tab').filter(t => t.textContent.indexOf('人物') >= 0)[0]);
  await sleep(50);
  const sumu = $$('#page .entry').filter(e => e.textContent.indexOf('苏牧') >= 0)[0];
  ok('苏牧仍是全局条目', !!sumu && sumu.textContent.indexOf('全局') >= 0);
  click(sumu.querySelector('[data-act="world.copyToVol"]')); await sleep(60);
  const sumuCopies = b.world.characters.filter(e => e.name === '苏牧');
  ok('复制出本卷专属副本', sumuCopies.length === 2 && sumuCopies.some(e => e.scope === v1) && sumuCopies.some(e => !e.scope),
    JSON.stringify(sumuCopies.map(e => String(e.scope))));

  // 浏览入口（章节目录页）
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(50);
  click('#appbar [data-act="world.browse"]'); await sleep(60);
  const sheetTxt = $('#sheetBody').textContent;
  ok('浏览面板显示全部设定', sheetTxt.indexOf('林昭') >= 0 && sheetTxt.indexOf('雾港') >= 0);
  ok('浏览面板标注作用域', sheetTxt.indexOf('全局') >= 0 && sheetTxt.indexOf('第1卷') >= 0, sheetTxt.slice(0, 120));
  w.UI.closeSheet();

  /* ============================================================
   [E] AI 重写：重写指示 + 一键撤销
   ============================================================ */
  console.log('\n[E] AI 重写与撤销');
  const before = cWith.content;
  const beforeWords = w.AI.wordCount(before);
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(50);
  const genBtn = $$('.chapter-item [data-act="chapter.generate"]')[0];
  click(genBtn); await sleep(60);
  ok('有正文时弹出重写表单', $('#sheetTitle').textContent.indexOf('AI 重写') >= 0, $('#sheetTitle').textContent);
  ok('表单注明当前字数', $('#sheetBody').textContent.indexOf(beforeWords + ' 字') >= 0, $('#sheetBody').textContent.slice(0, 100));
  ok('有重写指示输入框', !!$('#sheetBody [data-f="instruction"]'));
  fillSheet({ instruction: '加快叙事节奏，把悬念写明确' });
  await sleep(300);

  // 指示应进入本次 API 请求（章节生成请求，而非随后的记忆整理请求）
  const genReq = seen.filter(s => /chat\/completions/.test(s.url) && JSON.stringify(s.body).indexOf('加快叙事节奏，把悬念写明确') >= 0).pop();
  ok('重写指示进入 API 上行', !!genReq, seen.filter(s => /chat/.test(s.url)).length + ' 次请求');
  ok('上行带「重写指示」标记', !!genReq && JSON.stringify(genReq.body).indexOf('【重写指示】') >= 0);
  ok('正文已被重写替换', cWith.content !== before && cWith.content.indexOf('重写后') >= 0, cWith.content.slice(0, 40));

  // toast 一键撤销
  const toastBtn = $('.toast-action');
  ok('完成 toast 带「撤销」', !!toastBtn && toastBtn.textContent === '撤销', toastBtn && toastBtn.textContent);
  if (toastBtn) toastBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  ok('撤销后正文还原', cWith.content === before, cWith.content.slice(0, 40));

  // 留空提示词也要能重写：以前表单回调启动的流程会被面板自身的收尾关闭吞掉，
  // 「确定」之后一个请求都不发，表现为「默认不执行」
  const beforeEmpty = cWith.content;
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(50);
  click($$('.chapter-item [data-act="chapter.generate"]')[0]); await sleep(60);
  ok('重写表单标明指示可留空', $('#sheetBody').textContent.indexOf('可留空') >= 0, $('#sheetBody').textContent.slice(0, 90));
  fillSheet({ instruction: '' });
  await sleep(300);
  const emptyReq = seen.filter(s => /chat\/completions/.test(s.url) && s.body.stream).pop();
  ok('留空也照常发起重写请求', !!emptyReq, seen.filter(s => /chat/.test(s.url)).length + ' 次请求');
  ok('留空时不追加重写块', !!emptyReq && JSON.stringify(emptyReq.body).indexOf('【重写指示】') < 0);
  ok('留空重写照常替换正文', cWith.content !== beforeEmpty && cWith.content.indexOf('重写后') >= 0, cWith.content.slice(0, 40));
  const emptyToast = $('.toast-action');
  ok('留空重写的 toast 也带「撤销」', !!emptyToast && emptyToast.textContent === '撤销', emptyToast && emptyToast.textContent);
  if (emptyToast) emptyToast.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  ok('留空重写同样可一键撤销', cWith.content === beforeEmpty, cWith.content.slice(0, 40));

  // 无正文的章节：按钮走「生成」而非重写表单
  w.location.hash = '#/book/' + b.id + '/chapters'; w.UI.route(); await sleep(50);
  const emptyBtn = $$('.chapter-item [data-act="chapter.generate"]').filter(x => x.textContent.indexOf('生成正文') >= 0)[0];
  click(emptyBtn); await sleep(100);
  ok('无正文时进入阅读页开写', /#\/read\//.test(w.location.hash), w.location.hash);

  /* ============================================================
   [F] 悬浮球：点一下出选项、拖动不误触、最近 3 条请求记录
   ============================================================ */
  console.log('\n[F] 悬浮球');
  await sleep(400);   // 等 [E] 尾部触发的自动写作（正文 + 记忆）把请求记录写完
  ok('悬浮球存在', !!$('#fab'));
  ok('悬浮球面板默认隐藏', $('#fabPanel').classList.contains('hidden'));
  ok('面板有三个功能按钮（撤销 / 上下文 / 预设）', $$('#fabPanel [data-act]').length === 3,
    $$('#fabPanel [data-act]').map(x => x.getAttribute('data-act')).join(','));

  // #20：pointerup 不开面板（否则紧随其后的 click 会命中刚弹出的面板按钮），
  // 统一由 click 决定开合 —— 点一下必定只出选项
  ptr('pointerdown', 900, 700); ptr('pointerup', 900, 700);
  await sleep(40);
  ok('pointerup 不直接开面板', $('#fabPanel').classList.contains('hidden'));
  click('#fab'); await sleep(40);
  ok('点击打开选项面板', !$('#fabPanel').classList.contains('hidden'));
  click('#fab'); await sleep(40);
  ok('再点关闭面板', $('#fabPanel').classList.contains('hidden'));

  // #21：请求记录保留最近 3 条（正文生成 / 记忆整理互不覆盖）
  const log = w.API.requestLog();
  ok('请求记录保留最近 3 条', log.length === 3, String(log.length));
  ok('最新一条是记忆整理', log[0].kind === '记忆整理', log.map(x => x.kind).join('/'));
  ok('包含正文生成记录', log.some(x => x.kind === '正文生成'), log.map(x => x.kind).join('/'));
  ok('最早的 AI 重写已被挤出（环形缓冲）', !log.some(x => x.kind === 'AI 重写'), log.map(x => x.kind).join('/'));

  // 查看最近 AI 上下文（先点开选项面板，再选功能）
  click('#fab'); await sleep(30);
  click('#fabPanel [data-act="fab.ctx"]'); await sleep(60);
  const ctxTxt = $('#sheetBody').textContent;
  ok('上下文面板显示请求地址', ctxTxt.indexOf('chat/completions') >= 0, ctxTxt.slice(0, 100));
  ok('上下文面板显示请求体', ctxTxt.indexOf('messages') >= 0);
  ok('上下文面板密钥已脱敏', ctxTxt.indexOf('sk-test-123456') < 0);
  const picks = $$('#sheetBody [data-act="fab.ctxPick"]');
  ok('面板提供最近 3 条切换', picks.length === 3, String(picks.length));
  ok('默认看最新一条', picks[0].className.indexOf('primary') >= 0);
  // 切到中间的「正文生成」记录：正文请求里不该出现记忆整理的系统提示词
  click(picks[1]); await sleep(40);
  const picks2 = $$('#sheetBody [data-act="fab.ctxPick"]');
  ok('切换后选中项跟着变', picks2[1].className.indexOf('primary') >= 0 && picks2[0].className.indexOf('primary') < 0);
  ok('切到正文生成记录', $('#sheetBody').textContent.indexOf('剧情记录员') < 0, '正文请求不应包含记忆提示词');
  click(picks2[2]); await sleep(40);
  ok('切到更早的一条', $('#sheetBody').textContent.indexOf('剧情记录员') >= 0);
  w.UI.closeSheet();

  // 拖动（> 8px）→ 移位且不展开面板；拖动后补发的 click 也要被吞掉
  ptr('pointerdown', 900, 700);
  ptr('pointermove', 860, 640);
  ptr('pointerup', 860, 640);
  click('#fab');   // 真实浏览器在拖动结束后也会补发 click
  await sleep(60);
  ok('拖动后位置已更新', /px$/.test($('#fab').style.left || '') && $('#fab').style.left !== '', $('#fab').style.left + ',' + $('#fab').style.top);
  ok('拖动不展开面板', $('#fabPanel').classList.contains('hidden'));
  ok('位置已持久化', !!Store.state.ui.fabPos && typeof Store.state.ui.fabPos.x === 'number',
    JSON.stringify(Store.state.ui.fabPos));

  // 切换模型预设
  click('#fab'); await sleep(30);
  click('#fabPanel [data-act="fab.presets"]'); await sleep(60);
  const preTxt = $('#sheetBody').textContent;
  ok('预设面板列出全部方案', preTxt.indexOf('Kimi 整理大纲') >= 0 && preTxt.indexOf('默认方案') >= 0, preTxt.slice(0, 120));
  const pick = $('#sheetBody [data-act="preset.use"]');
  ok('可点选切换', !!pick);
  if (pick) {
    const targetId = pick.getAttribute('data-id');
    click(pick); await sleep(80);
    ok('切换后 activePresetId 更新', Store.state.activePresetId === targetId, Store.state.activePresetId);
  }

  /* ============================================================
   [G] 运行期错误检查
   ============================================================ */
  console.log('\n[G] 运行期错误检查');
  const real = errs.filter(e => !/Not implemented: navigation/.test(e));
  const navOnly = errs.length - real.length;
  ok('全程无 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));
  if (navOnly) console.log('    （已忽略 ' + navOnly + ' 条 jsdom 不支持的下载导航提示）');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
