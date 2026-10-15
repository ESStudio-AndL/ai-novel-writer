/* 第二轮改造 · 纯逻辑测试：模型方案（预设）/ 世界设定作用域 /
 * 模型列表与余额拉取 / 请求记录脱敏 / 重写指示注入
 * 运行：node tests/round2.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// ---- 极简浏览器环境（与 smoke.js 同款） ----
const store = {};
const sandbox = {
  console,
  TextDecoder, TextEncoder, Uint8Array, JSON, Date, Math, Promise, Object, Array, String, Number, parseInt, parseFloat, Error,
  setTimeout, clearTimeout, AbortController,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  fetch: null,
  navigator: { clipboard: null },
  document: {
    createElement: () => ({ style: {}, setAttribute() { }, appendChild() { }, remove() { }, select() { }, click() { }, value: '' }),
    body: { appendChild() { } },
    execCommand: () => true
  },
  Blob: function () { },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() { } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), sandbox, { filename: file });
}
load('util.js'); load('store.js'); load('api.js'); load('ai.js');

const { Store, API, AI } = sandbox;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 统一的假 fetch：按 URL 分发，记录最后一次调用
let lastCall = null;
function mockFetch(routes) {
  sandbox.fetch = async (url, opt) => {
    lastCall = { url: String(url), opt: opt || {} };
    for (const r of routes) {
      if (r.match.test(String(url))) {
        if (r.status && r.status !== 200) {
          return { ok: false, status: r.status, text: async () => r.body || 'err', json: async () => ({}) };
        }
        return {
          ok: true, status: 200,
          text: async () => (typeof r.body === 'string' ? r.body : ''),
          json: async () => r.json !== undefined ? r.json : (typeof r.body === 'string' ? JSON.parse(r.body) : {})
        };
      }
    }
    return { ok: false, status: 404, text: async () => 'no route', json: async () => ({}) };
  };
}

(async () => {

  console.log('\n[1] 模型方案（预设）：CRUD 与合并');
  delete store['novel_ai_db_v1'];
  Store.state = null;
  Store.init();
  // 先铺好两个提供商，再手动触发 migrate，验证「老数据自动生成默认预设」
  Store.state.providers = [
    { id: 'pA', name: '主力', type: 'openai', baseUrl: 'https://a.example.com/v1', apiKey: 'key-aaaaaa', model: 'model-a', temperature: 0.7, maxTokens: 4000 },
    { id: 'pB', name: '备用', type: 'openai', baseUrl: 'https://b.example.com/v1', apiKey: 'key-bbbbbb', model: 'model-b' }
  ];
  Store.state.activeProviderId = 'pA';
  Store.state.modelPresets = [];
  Store.state.activePresetId = null;
  Store.migrate();

  ok('老数据 migrate：每个提供商各补一个默认方案', Store.state.modelPresets.length === 2,
    JSON.stringify(Store.state.modelPresets));
  const dp = Store.state.modelPresets.filter(m => m.providerId === 'pA')[0];
  ok('默认方案绑定对应提供商', !!dp && dp.providerId === 'pA');
  ok('默认方案搬走提供商的模型与参数', dp.model === 'model-a' && dp.temperature === 0.7 && dp.maxTokens === 4000,
    JSON.stringify(dp));
  ok('激活提供商的方案被启用', Store.state.activePresetId === dp.id);
  ok('无自定义字段时 activeModel 等同提供商', Store.activeModel().model === 'model-a' && Store.activeModel().apiKey === 'key-aaaaaa');

  // 新建预设（只覆盖模型名）
  const m1 = Store.upsertModelPreset({ name: '草稿方案', providerId: 'pA', model: 'model-a2' });
  ok('upsert 新预设返回条目', !!m1 && !!m1.id && m1.name === '草稿方案');
  ok('预设数增加', Store.state.modelPresets.length === 3, String(Store.state.modelPresets.length));
  ok('首个预设仍是激活项（不抢戏）', Store.state.activePresetId === dp.id);

  Store.useModelPreset(m1.id);
  ok('useModelPreset 切换激活', Store.state.activePresetId === m1.id);
  const am = Store.activeModel();
  ok('预设覆盖模型名', am.model === 'model-a2', am.model);
  ok('未覆盖的字段继承提供商', am.baseUrl === 'https://a.example.com/v1' && am.apiKey === 'key-aaaaaa');
  ok('温度沿用提供商', am.temperature === 0.7, String(am.temperature));
  ok('附带预设名供界面显示', am.__presetName === '草稿方案' && am.__presetId === m1.id);

  // 合并后：方案留空的字段回落提供商自身（老数据兼容）
  ok('方案不填模型时回落提供商', (function () {
    const bare = Store.upsertModelPreset({ name: '裸方案', providerId: 'pA', model: '' });
    Store.useModelPreset(bare.id);
    const x = Store.activeModel();
    return x.model === 'model-a' && x.baseUrl === 'https://a.example.com/v1';
  })());
  Store.useModelPreset(m1.id);

  // 覆盖温度与 maxTokens
  const m2 = Store.upsertModelPreset({ name: '精修方案', providerId: 'pA', model: 'model-a3', temperature: 0.2, maxTokens: 8000 });
  Store.useModelPreset(m2.id);
  const am2 = Store.activeModel();
  ok('预设覆盖温度', am2.temperature === 0.2, String(am2.temperature));
  ok('预设覆盖 maxTokens', am2.maxTokens === 8000, String(am2.maxTokens));
  ok('预设指向另一提供商时整体切换', (function () {
    const m3 = Store.upsertModelPreset({ name: '备用方案', providerId: 'pB', model: 'model-b2' });
    Store.useModelPreset(m3.id);
    const x = Store.activeModel();
    return x.baseUrl === 'https://b.example.com/v1' && x.apiKey === 'key-bbbbbb' && x.model === 'model-b2';
  })());
  ok('预设的提供商被删后回退当前提供商', (function () {
    Store.useModelPreset(m2.id);
    Store.removeProvider('pA');
    const x = Store.activeModel();
    return !!x && x.baseUrl === 'https://b.example.com/v1';
  })());
  ok('删除提供商后预设 providerId 被重指向', Store.state.modelPresets.every(m => m.providerId !== 'pA'),
    JSON.stringify(Store.state.modelPresets.map(m => m.providerId)));
  ok('removeModelPreset 删除指定项', (function () {
    const n = Store.state.modelPresets.length;
    Store.removeModelPreset(m1.id);
    return Store.state.modelPresets.length === n - 1 && !Store.getModelPreset(m1.id);
  })());
  ok('删除激活预设时自动切到第一个', (function () {
    Store.useModelPreset(Store.state.modelPresets[0].id);
    Store.removeModelPreset(Store.state.activePresetId);
    return Store.state.activePresetId === (Store.state.modelPresets[0] || {}).id || Store.state.activePresetId === null;
  })());
  ok('删光预设后 activeModel 回落提供商', (function () {
    Store.state.modelPresets.forEach(m => Store.removeModelPreset(m.id));
    const x = Store.activeModel();
    return !!x && x.model === 'model-b' && x.__presetId === undefined;
  })());
  ok('空预设列表时 useModelPreset 返回 false', Store.useModelPreset('不存在') === false);
  ok('无任何提供商时 activeModel 为 null', (function () {
    Store.state.modelPresets = [{ id: 'x', name: 'x', providerId: 'pA' }];
    Store.state.activePresetId = 'x';
    Store.state.providers = [];
    const x = Store.activeModel();
    Store.state.providers = [{ id: 'pB', name: '备用', type: 'openai', baseUrl: 'https://b.example.com/v1', apiKey: 'key-bbbbbb', model: 'model-b' }];
    return x === null;
  })());

  console.log('\n[2] 世界设定作用域（全局 / 分卷）');
  delete store['novel_ai_db_v1'];
  Store.state = null;
  Store.init();
  Store.state.providers = [{ id: 'p1', type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }];
  Store.state.activeProviderId = 'p1';
  const wb = Store.createBook('设定书');
  const v1 = Store.addVolume(wb, '第一卷 雾起', '').id;
  const v2 = Store.addVolume(wb, '第二卷 星落', '').id;

  const g1 = Store.addWorldEntry(wb, 'characters', '林昭', '男主');
  const s1 = Store.addWorldEntry(wb, 'locations', '雾港', '只在第一卷出现的港口', v1);
  const s2 = Store.addWorldEntry(wb, 'factions', '观星会', '第二卷势力', v2);
  ok('全局条目不带 scope 字段', !('scope' in g1) || g1.scope === undefined || g1.scope === '');
  ok('分卷条目带 scope', s1.scope === v1 && s2.scope === v2);

  const poolV1 = Store.worldForChapter(wb, v1);
  ok('第一卷注入：全局 + 本卷专属', poolV1.characters.length === 1 && poolV1.locations.length === 1 && poolV1.factions.length === 0,
    JSON.stringify({ c: poolV1.characters.length, l: poolV1.locations.length, f: poolV1.factions.length }));
  const poolV2 = Store.worldForChapter(wb, v2);
  ok('第二卷注入：不含第一卷专属', poolV2.locations.length === 0 && poolV2.factions.length === 1);
  ok('空 volumeId 只取全局', Store.worldForChapter(wb, '').locations.length === 0 && Store.worldForChapter(wb, '').characters.length === 1);

  const all = Store.allWorldEntries(wb);
  ok('allWorldEntries 取全量（含分卷专属）', all.locations.length === 1 && all.factions.length === 1 && all.characters.length === 1);
  ok('worldScopeLabel：全局', Store.worldScopeLabel(wb, '') === '全局');
  ok('worldScopeLabel：第一卷', Store.worldScopeLabel(wb, v1) === '第1卷', Store.worldScopeLabel(wb, v1));
  ok('worldScopeLabel：第二卷', Store.worldScopeLabel(wb, v2) === '第2卷');
  ok('worldScopeLabel：已删分卷回落全局', Store.worldScopeLabel(wb, 'no-such') === '全局');

  // 生成注入：第二卷的章不应看到雾港
  const cV1 = Store.addChapter(wb, { title: '雾中', outline: 'x', volumeId: v1 });
  const cV2 = Store.addChapter(wb, { title: '星下', outline: 'y', volumeId: v2 });
  const p1 = AI.buildChapterPrompt(wb, cV1);
  const p2 = AI.buildChapterPrompt(wb, cV2);
  ok('第一卷章节注入雾港', p1.user.indexOf('雾港') >= 0 && p1.user.indexOf('观星会') < 0);
  ok('第二卷章节注入观星会、不含雾港', p2.user.indexOf('观星会') >= 0 && p2.user.indexOf('雾港') < 0);
  ok('两卷都注入全局林昭', p1.user.indexOf('林昭') >= 0 && p2.user.indexOf('林昭') >= 0);

  // 推荐设定按作用域转正
  Store.addWorldSuggestions(wb, [{ cat: 'concepts', name: '星仪', content: '观星道具' }], cV2);
  Store.acceptWorldSuggestion(wb, wb.worldSug[0].id, null, v2);
  ok('转正写入指定分卷', wb.world.concepts[0].scope === v2 && wb.world.concepts[0].name === '星仪');
  Store.addWorldSuggestions(wb, [{ cat: 'concepts', name: '雾号', content: '第一卷道具' }], cV1);
  Store.acceptWorldSuggestion(wb, wb.worldSug[0].id);
  ok('不带作用域转正 = 全局', !wb.world.concepts[1].scope && wb.world.concepts[1].name === '雾号');
  ok('worldChunksText 按作用域过滤', (function () {
    const t1 = AI.worldChunksText(wb, v1);
    const t2 = AI.worldChunksText(wb, v2);
    return t1.indexOf('雾号') >= 0 && t1.indexOf('星仪') < 0 &&    // v1：全局+本卷，看不到 v2 专属
      t2.indexOf('星仪') >= 0 && t2.indexOf('雾号') >= 0 &&        // v2：全局+本卷都能看到
      t2.indexOf('雾港') < 0;                                      // v2 看不到 v1 专属
  })());
  ok('worldChunksText(null) 取全部', AI.worldChunksText(wb, null).indexOf('星仪') >= 0 && AI.worldChunksText(wb, null).indexOf('雾号') >= 0);

  console.log('\n[3] 模型列表拉取（三家适配）');
  mockFetch([{ match: /\/models$/, json: { data: [{ id: 'z-model' }, { id: 'a-model' }] } }]);
  let r = await API.fetchModels({ type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-abcdef123456' });
  ok('openai：解析 data[].id 并排序', r.length === 2 && r[0] === 'a-model' && r[1] === 'z-model', JSON.stringify(r));
  ok('openai：GET 且带 Bearer 头', lastCall.opt.method === 'GET' && /^Bearer sk-abc/.test(lastCall.opt.headers.Authorization), JSON.stringify(lastCall.opt.headers));
  ok('openai：URL 拼到 /models', /\/v1\/models$/.test(lastCall.url), lastCall.url);

  mockFetch([{ match: /\/v1\/models$/, json: { data: [{ id: 'claude-x' }] } }]);
  r = await API.fetchModels({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-123456' });
  ok('anthropic：解析模型 id', r.length === 1 && r[0] === 'claude-x');
  ok('anthropic：带 x-api-key 与版本头', !!lastCall.opt.headers['x-api-key'] && !!lastCall.opt.headers['anthropic-version'],
    JSON.stringify(lastCall.opt.headers));

  mockFetch([{ match: /\/models\?key=/, json: { models: [{ name: 'models/gemini-1.5' }, { name: 'models/gemini-2' }] } }]);
  r = await API.fetchModels({ type: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'gkey-123456' });
  ok('google：去掉 models/ 前缀', r.indexOf('gemini-1.5') >= 0 && r.indexOf('gemini-2') >= 0, JSON.stringify(r));
  ok('google：key 放 query', /key=gkey-123456/.test(lastCall.url), lastCall.url);

  mockFetch([{ match: /\/models$/, status: 401, body: 'unauthorized' }]);
  let threw = '';
  try { await API.fetchModels({ type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' }); } catch (e) { threw = e.message; }
  ok('HTTP 错误给出中文提示', /401|认证|密钥|鉴权/.test(threw), threw);

  mockFetch([{ match: /\/models$/, body: 'not json' }]);
  threw = '';
  try { await API.fetchModels({ type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' }); } catch (e) { threw = e.message; }
  ok('非 JSON 返回明确报错', /JSON/.test(threw), threw);

  mockFetch([{ match: /\/models$/, json: { data: [] } }]);
  threw = '';
  try { await API.fetchModels({ type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' }); } catch (e) { threw = e.message; }
  ok('空列表报错', /为空/.test(threw), threw);

  threw = '';
  try { await API.fetchModels(null); } catch (e) { threw = e.message; }
  ok('未配置提供商时报错', /提供商/.test(threw), threw);

  console.log('\n[4] 余额拉取与字段识别');
  mockFetch([{ match: /\/user\/balance$/, json: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }, { currency: 'USD', total_balance: '1' }] } }]);
  r = await API.fetchBalance({ type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-d-123456' });
  ok('deepseek：命中 /user/balance', /\/user\/balance$/.test(lastCall.url), lastCall.url);
  ok('deepseek：balance_infos 求和', Math.abs(r.amount - 13.34) < 1e-9, String(r.amount));

  mockFetch([{ match: /\/v1\/users\/me\/balance$/, json: { data: { available_balance: 88.5 } } }]);
  r = await API.fetchBalance({ type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'k' });
  ok('moonshot：命中余额端点', /\/v1\/users\/me\/balance$/.test(lastCall.url), lastCall.url);
  ok('moonshot：解析 available_balance', r.amount === 88.5, String(r.amount));

  mockFetch([{ match: /\/v1\/user\/info$/, json: { data: { totalBalance: 100 } } }]);
  r = await API.fetchBalance({ type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k' });
  ok('siliconflow：解析 totalBalance', r.amount === 100, String(r.amount));

  mockFetch([{ match: /\/my-balance$/, json: { balance: '5.5' } }]);
  r = await API.fetchBalance({ type: 'openai', baseUrl: 'https://custom.example.com/v1', apiKey: 'k', balanceUrl: '/my-balance' });
  ok('自定义 balanceUrl 优先', /\/my-balance$/.test(lastCall.url) && r.amount === 5.5, lastCall.url);

  mockFetch([]);
  threw = '';
  try { await API.fetchBalance({ type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }); } catch (e) { threw = e.message; }
  ok('OpenAI 无公开余额接口时明确拒绝', /没有公开|官网后台/.test(threw), threw);
  threw = '';
  try { await API.fetchBalance({ type: 'openai', baseUrl: 'https://unknown.example.com/v1', apiKey: 'k' }); } catch (e) { threw = e.message; }
  ok('未知域名引导手动填地址', /余额查询地址/.test(threw), threw);

  mockFetch([{ match: /\/balance$/, json: { foo: 1 } }]);
  threw = '';
  try { await API.fetchBalance({ type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', balanceUrl: '/balance' }); } catch (e) { threw = e.message; }
  ok('识别不出字段时报错带返回片段', /没能识别|balance/.test(threw), threw);

  mockFetch([{ match: /\/balance$/, status: 500, body: 'boom' }]);
  threw = '';
  try { await API.fetchBalance({ type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', balanceUrl: '/balance' }); } catch (e) { threw = e.message; }
  ok('余额接口 HTTP 错误有提示', /500|失败|错误/.test(threw), threw);

  console.log('\n[5] 请求记录：脱敏与内容');
  ok('无请求时 lastRequest 为 null', API.lastRequest() === null);
  const chatProv = { id: 'pX', name: '测试方', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-supersecret-1234', model: 'm1' };
  mockFetch([{ match: /chat\/completions$/, json: { choices: [{ message: { content: '你好' } }] } }]);
  await API.chat({ provider: chatProv, system: 's', user: 'u', stream: false });
  const rec = API.lastRequest();
  ok('记录了请求地址', !!rec && /chat\/completions$/.test(rec.url), rec && rec.url);
  ok('记录了请求体（美化 JSON）', !!rec && rec.body.indexOf('"messages"') >= 0 && rec.body.indexOf('\n  ') >= 0);
  ok('Authorization 头已脱敏', !!rec && rec.headers.Authorization.indexOf('supersecret') < 0, rec && JSON.stringify(rec.headers));
  ok('脱敏保留可识别前缀', !!rec && /sk-sup/.test(rec.headers.Authorization), rec && rec.headers.Authorization);
  ok('记录提供商与模型', rec.provider === '测试方' && rec.model === 'm1');

  // Google URL 内 key 脱敏
  mockFetch([{ match: /generateContent/, json: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] } }]);
  await API.chat({ provider: { id: 'g', name: 'G', type: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'gsecret-987654321', model: 'gemini-1.5' }, system: 's', user: 'u', stream: false });
  const recG = API.lastRequest();
  ok('google：URL 内 key 已脱敏', recG.url.indexOf('gsecret') < 0 && /\?key=/.test(recG.url), recG.url);

  console.log('\n[6] 重写指示注入提示词');
  const base = AI.buildChapterPrompt(wb, cV1, {});
  ok('无指示时不出现重写块', base.user.indexOf('【重写指示】') < 0);
  const withIns = AI.buildChapterPrompt(wb, cV1, { instruction: '加快节奏，删减对话' });
  ok('有指示时出现重写块', withIns.user.indexOf('【重写指示】') >= 0);
  ok('重写块包含指示原文', withIns.user.indexOf('加快节奏，删减对话') >= 0);
  ok('指示不影响 system', withIns.system === base.system);
  ok('指示追加在末尾（正文要求之后）', withIns.user.indexOf('【重写指示】') > withIns.user.indexOf('【本章大纲】'),
    'idx=' + withIns.user.indexOf('【重写指示】'));

  console.log('\n[7] 自动分章提示词结构：设定 + 完整长期记忆 + 最近 3 章正文全文 + 本卷大纲');
  const ob = Store.createBook('分章书');
  const ov1 = Store.addVolume(ob, '第一卷 雾起', '主角踏入雾都').id;
  const ov2 = Store.addVolume(ob, '第二卷 星落', '边境之外，星图现世').id;
  Store.addWorldEntry(ob, 'characters', '林昭', '男主，冷静寡言');
  // 5 章：前两章在第一卷、后三章在第二卷 → 「最近 3 章」应为第 3/4/5 章
  const mkCh = (title, outline, head, volumeId) => Store.addChapter(ob, {
    title: title, outline: outline,
    content: head + '这一段是正文内容。'.repeat(60) + '【' + title + '结尾】',
    volumeId: volumeId
  });
  const oc1 = mkCh('雨夜', '主角离乡', '【一章开头】', ov1);
  const oc2 = mkCh('入城', '抵达雾都', '【二章开头】', ov1);
  const oc3 = mkCh('观星', '星图亮起', '【三章开头】', ov2);
  const oc4 = mkCh('密信', '收到密信', '【四章开头】', ov2);
  const oc5 = mkCh('夜航', '夜航出海', '【五章开头】', ov2);
  ob.memory.enabled = true;
  ob.memory.keepRecent = 2;            // 写正文时只注入最近 2 条；分章要全部 5 条
  ['一', '二', '三', '四', '五'].forEach((n, i) => {
    Store.addMemory(ob, [oc1, oc2, oc3, oc4, oc5][i], '【记忆' + n + '】离开故乡的第' + n + '件事', '');
  });
  ob.memory.summary = '长期记忆：主角已离开故乡，正前往雾都。';
  Store.save();

  mockFetch([{
    match: /chat\/completions$/,
    json: { choices: [{ message: { content: '{"chapters":[{"title":"雨夜行","outline":"承接前一章"}]}' } }] }
  }]);
  const outlines = await AI.generateOutlines(ob, Store.getVolume(ob, ov1), 3);
  const oBody = String(lastCall.opt.body);
  ok('返回解析出的章节大纲', outlines.length === 1 && outlines[0].title === '雨夜行', JSON.stringify(outlines));
  ok('已移除「全部分卷大纲」块', oBody.indexOf('【全部分卷大纲】') < 0);
  ok('不再列举其他分卷', oBody.indexOf('第二卷 星落') < 0 && oBody.indexOf('边境之外') < 0);
  ok('注入世界设定', oBody.indexOf('【世界设定】') >= 0 && oBody.indexOf('林昭') >= 0);
  ok('注入完整长期记忆', oBody.indexOf('【长期记忆（完整）】') >= 0 && oBody.indexOf('主角已离开故乡') >= 0);
  /* 去重：最近 3 章（第 3/4/5 章）的正文已全文注入，其记忆条目不再重复列出，
   * 于是 5 条里只剩第 1、2 章的两条要点。同一段剧情不付两次钱。 */
  ok('分章时排除已全文注入的最近 3 章记忆',
    ['【记忆一】', '【记忆二】'].every(x => oBody.indexOf(x) >= 0) &&
    ['【记忆三】', '【记忆四】', '【记忆五】'].every(x => oBody.indexOf(x) < 0),
    'keepRecent=' + ob.memory.keepRecent);
  ok('标注了条目总数', oBody.indexOf('共 2 条') >= 0);
  ok('注入最近 3 章正文全文',
    ['【三章开头】', '【观星结尾】', '【四章开头】', '【密信结尾】', '【五章开头】', '【夜航结尾】']
      .every(x => oBody.indexOf(x) >= 0));
  ok('不注入更早的章节正文', oBody.indexOf('【一章开头】') < 0 && oBody.indexOf('【二章开头】') < 0);
  ok('本卷大纲单独成块', oBody.indexOf('【本卷大纲】') >= 0 && oBody.indexOf('主角踏入雾都') >= 0);
  ok('顺序：设定 → 长期记忆 → 正文 → 本卷大纲',
    oBody.indexOf('【世界设定】') < oBody.indexOf('【长期记忆（完整）】') &&
    oBody.indexOf('【长期记忆（完整）】') < oBody.indexOf('最近 3 章正文（全文）') &&
    oBody.indexOf('最近 3 章正文（全文）') < oBody.indexOf('【本卷大纲】'));
  ok('仍要求按 count 输出 JSON', /数组长度必须等于 3/.test(oBody));

  const rct = AI.recentContentText(ob);
  ok('正文上下文恰好 3 章', (rct.match(/【第\d+章/g) || []).length === 3, rct.slice(0, 60));
  ok('取全书最后三章（跨分卷）',
    rct.indexOf('【第3章') >= 0 && rct.indexOf('【第5章') >= 0 && rct.indexOf('【第1章') < 0);
  ok('正文是全文（首尾都在）',
    rct.indexOf('【三章开头】') >= 0 && rct.indexOf('【观星结尾】') >= 0 && rct.indexOf('【夜航结尾】') >= 0);
  const fmt = AI.fullMemoryText(ob);
  ok('完整版记忆块（不排除时）含全部条目',
    ['【记忆一】', '【记忆五】'].every(x => fmt.indexOf(x) >= 0) && fmt.indexOf('共 5 条') >= 0);
  ok('写正文走精简版记忆块，分章走完整版',
    AI.buildMemoryBlock(ob).indexOf('【前情记忆】') >= 0 && fmt.indexOf('【长期记忆（完整）】') >= 0);
  const cpCh = AI.buildChapterPrompt(ob, oc5);
  ok('正文生成注入前情记忆（含长期摘要）',
    cpCh.user.indexOf('【前情记忆】') >= 0 && cpCh.user.indexOf('主角已离开故乡') >= 0);
  ok('正文生成注入前几章正文全文', cpCh.user.indexOf('最近 3 章正文（全文）') >= 0);
  /* 写第 5 章：正文取它之前的第 2/3/4 章，记忆要点因此只剩第 1 章那条。
   * 旧实现里「正文排除本章、去重却没排除」是不一致的，第 5 章的要点会被
   * 去重剔掉却又没给正文，等于凭空少了一段前情；现在两边用同一条界线。 */
  ok('写第 5 章时不带第 5 章及之后的记忆要点',
    cpCh.user.indexOf('【记忆五】') < 0 && cpCh.user.indexOf('【记忆四】') < 0);
  ok('去重只剔已全文注入的那几章（第 2/3/4 章）',
    cpCh.user.indexOf('【记忆二】') < 0 && cpCh.user.indexOf('【记忆三】') < 0 &&
    cpCh.user.indexOf('【记忆一】') >= 0);
  // keepRecent 对正文真正生效（此前默认模板走全量，这个设置项是失效的）
  // 用不带章节上下文的 buildMemoryBlock 验：那里才有多条候选可供裁剪
  ok('keepRecent=2 注入最近 2 条',
    AI.buildMemoryBlock(ob).indexOf('【记忆一】') >= 0 && AI.buildMemoryBlock(ob).indexOf('【记忆二】') >= 0);
  ob.memory.keepRecent = 1;
  const mb1 = AI.buildMemoryBlock(ob);
  ok('keepRecent 生效：只注入最近 1 条',
    mb1.indexOf('【记忆二】') >= 0 && mb1.indexOf('【记忆一】') < 0);
  ob.memory.keepRecent = 2;

  console.log('\n[8] 老数据的内置模板措辞升级');
  const legacyText = Store.LEGACY_TEMPLATE_CONTENT.outlineSplit[0];
  ok('记录着历史内置原文', /【全部分卷大纲】/.test(legacyText));
  const ot = Store.state.promptTemplates.outlineSplit;
  ot.schemes[0].content = legacyText;                       // 仍是旧内置原文 → 应被升级
  ot.schemes.push({ id: 'mine', name: '我的改法', content: '自定义：{{volume}}' });   // 用户改过的 → 不动
  ot.activeId = 'mine';
  Store.migrate();
  ok('旧内置原文自动升级为新结构',
    ot.schemes[0].content.indexOf('【本卷大纲】') >= 0 && ot.schemes[0].content.indexOf('【全部分卷大纲】') < 0);
  ok('用户自己改过的方案原样保留', ot.schemes[1].content === '自定义：{{volume}}');
  ok('占位符表同步更新',
    Store.getTemplateDef('outlineSplit').vars.indexOf('recentContent') >= 0 &&
    Store.getTemplateDef('outlineSplit').vars.indexOf('volumes') < 0);
  ok('升级后的模板仍可用', ot.schemes[0].content.indexOf('{{recentContent}}') >= 0);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
