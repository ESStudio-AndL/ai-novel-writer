/* 第三轮改造 · 纯逻辑测试：
 *   用量记账 / 任务级模型路由 / 关闭思考发参与 400 兜底 /
 *   触发式世界设定注入 / 角色卡结构化字段 / 正文与记忆去重 /
 *   文风规则 / 伏笔板 / 生成前预览与临时勾除 / 一致性审计 / 存储加固
 * 运行：node tests/round3.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// ---- 极简浏览器环境（与 smoke.js / round2.js 同款） ----
const mem = {};
const sandbox = {
  console,
  TextDecoder, TextEncoder, Uint8Array, JSON, Date, Math, Promise, Object, Array, String, Number, parseInt, parseFloat, Error,
  setTimeout, clearTimeout, AbortController,
  localStorage: {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
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

const { Store, API, AI, Util } = sandbox;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ---- 假 fetch：记录每一次实际发出的请求 ----
let calls = [];
function mock(fn) {
  calls = [];
  sandbox.fetch = async (url, opt) => {
    calls.push({ url: String(url), opt: opt || {} });
    return fn(String(url), opt || {}, calls.length);
  };
}
function jsonRes(obj, status) {
  const s = status || 200;
  return {
    ok: s >= 200 && s < 300, status: s,
    json: async () => obj, text: async () => JSON.stringify(obj)
  };
}
function sseRes(lines) {
  const enc = new TextEncoder();
  const payload = lines.join('\n\n') + '\n\n';
  let used = false;
  return {
    ok: true, status: 200,
    body: {
      getReader: () => ({
        read: async () => (used ? { done: true } : (used = true, { done: false, value: enc.encode(payload) })),
        releaseLock() { }, cancel() { }
      }),
      cancel() { }
    },
    json: async () => ({}), text: async () => ''
  };
}
function body(i) { return JSON.parse((calls[i || 0].opt.body) || '{}'); }

const P_OPENAI = { id: 'pA', name: '主力', type: 'openai', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-abcdefghij', model: 'big-1' };
const P_ANTH = { id: 'pC', name: 'Claude', type: 'anthropic', baseUrl: 'https://c.example.com', apiKey: 'sk-ant-123456', model: 'claude-x' };
const P_GOOG = { id: 'pG', name: 'Gemini', type: 'google', baseUrl: 'https://g.example.com/v1beta', apiKey: 'AIza-123456', model: 'gemini-2.5-flash' };
const P_CHEAP = { id: 'pB', name: '便宜', type: 'openai', baseUrl: 'https://b.example.com/v1', apiKey: 'sk-cheap-0000', model: 'cheap-1' };

(async () => {
  delete mem['novel_ai_db_v1'];
  Store.state = null;
  Store.init();

  /* ================================================================
   * [1] 用量记账：三家 usage 归一化 + 累计 + 成本
   * ================================================================ */
  console.log('\n[1] 用量记账：三家 usage 归一化');

  // OpenAI 非流式
  mock(() => jsonRes({
    choices: [{ message: { content: '正文A' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } }
  }));
  const r1 = await API.chat({ provider: P_OPENAI, system: 's', user: 'u', stream: false });
  ok('OpenAI 非流式取到用量', !!r1.usage && r1.usage.promptTokens === 1000 && r1.usage.completionTokens === 500,
    JSON.stringify(r1.usage));
  ok('OpenAI 缓存命中 token 单独记录', r1.usage.cachedTokens === 200, String(r1.usage.cachedTokens));

  // OpenAI 流式：usage 只在最后一个 chunk
  mock(() => sseRes([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '第' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '一章' } }] }),
    'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 40 } }),
    'data: [DONE]'
  ]));
  const r2 = await API.chat({ provider: P_OPENAI, system: 's', user: 'u', stream: true, onDelta() { } });
  ok('流式正文拼接正确', r2.text === '第一章', r2.text);
  ok('流式末 chunk 取到用量', !!r2.usage && r2.usage.promptTokens === 300 && r2.usage.completionTokens === 40);
  ok('流式自动带 stream_options.include_usage',
    !!(body(0).stream_options && body(0).stream_options.include_usage === true));

  // Anthropic 流式：输入在 message_start 里，输出在 message_delta 里
  mock(() => sseRes([
    'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } }),
    'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }),
    'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 60 } }),
    'data: [DONE]'
  ]));
  const r3 = await API.chat({ provider: P_ANTH, system: 's', user: 'u', stream: true, onDelta() { } });
  ok('Anthropic 流式正文', r3.text === '你好', r3.text);
  ok('Anthropic 输入 token（message_start）不漏记', !!r3.usage && r3.usage.promptTokens === 1200, JSON.stringify(r3.usage));
  ok('Anthropic 输出 token（message_delta）', !!r3.usage && r3.usage.completionTokens === 60);

  // Gemini
  mock(() => jsonRes({
    candidates: [{ content: { parts: [{ text: '正文G' }] } }],
    usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120, cachedContentTokenCount: 300 }
  }));
  const r4 = await API.chat({ provider: P_GOOG, system: 's', user: 'u', stream: false });
  ok('Gemini usageMetadata 归一化',
    !!r4.usage && r4.usage.promptTokens === 800 && r4.usage.completionTokens === 120);
  ok('Gemini 缓存 token', r4.usage.cachedTokens === 300);

  // 记账与成本
  Store.state.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  const b1 = Store.createBook('用量测试');
  b1.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  Store.recordUsage({ promptTokens: 1000000, completionTokens: 500000 }, { priceIn: 2, priceOut: 8 }, b1);
  // 1M * 2 / 1e6 = 2 元；0.5M * 8 / 1e6 = 4 元 → 共 6 元
  ok('全局累计请求数', Store.state.usage.requests === 1);
  ok('全局累计 token', Store.state.usage.promptTokens === 1000000 && Store.state.usage.completionTokens === 500000);
  ok('成本按输入/输出单价分别计算', Math.abs(Store.state.usage.cost - 6) < 1e-9, String(Store.state.usage.cost));
  ok('本书单独累计一份', b1.usage.requests === 1 && Math.abs(b1.usage.cost - 6) < 1e-9);
  Store.recordUsage({ promptTokens: 0, completionTokens: 0 }, { priceIn: 2, priceOut: 8 }, b1);
  ok('空用量不记账', Store.state.usage.requests === 1);
  Store.recordUsage(null, { priceIn: 2, priceOut: 8 }, b1);
  ok('无 usage 字段不记账', Store.state.usage.requests === 1);
  Store.recordUsage({ promptTokens: 1000, completionTokens: 100 }, null, b1);
  ok('没填单价时只记 token 不记钱', Math.abs(Store.state.usage.cost - 6) < 1e-9 && Store.state.usage.requests === 2);
  Store.resetUsage();
  ok('清零：全局归零', Store.state.usage.requests === 0 && Store.state.usage.cost === 0);
  ok('清零：书本归零', b1.usage.requests === 0 && b1.usage.cost === 0);

  /* ================================================================
   * [2] 任务级模型路由：不同活用不同模型
   * ================================================================ */
  console.log('\n[2] 任务级模型路由');
  Store.state.providers = [P_OPENAI, P_CHEAP];
  Store.state.activeProviderId = 'pA';
  Store.state.modelPresets = [];
  Store.state.activePresetId = null;

  const mWrite = Store.upsertModelPreset({
    name: '主笔', providerId: 'pA', model: 'big-1', temperature: 0.9,
    noThink: false, priceIn: 4, priceOut: 16, task: 'write'
  });
  const mMem = Store.upsertModelPreset({
    name: '便宜记忆', providerId: 'pB', model: 'cheap-1',
    noThink: true, priceIn: 0.5, priceOut: 2, task: 'memory'
  });
  Store.useModelPreset(mWrite.id);

  ok('正文走绑定的主笔方案', Store.activeModel('write').model === 'big-1');
  ok('记忆走绑定的便宜模型', Store.activeModel('memory').model === 'cheap-1');
  ok('未绑定任务回落当前启用方案', Store.activeModel('split').model === 'big-1');
  ok('不传任务时跟启用方案走', Store.activeModel().model === 'big-1');
  ok('路由结果带任务标记', Store.activeModel('memory').__task === 'memory');
  ok('方案名随路由返回', Store.activeModel('memory').__presetName === '便宜记忆');
  ok('关闭思考透传给 API 层', Store.activeModel('memory').noThink === true && Store.activeModel('write').noThink === false);
  ok('单价透传给记账', Store.activeModel('memory').priceIn === 0.5 && Store.activeModel('write').priceIn === 4);
  ok('温度覆盖透传', Store.activeModel('write').temperature === 0.9);
  ok('任务中文名可读', Store.taskLabel('memory') === '记忆总结 / 设定初筛');
  ok('AI.modelFor 与 Store.activeModel 一致', AI.modelFor('write').model === Store.activeModel('write').model);
  ok('十类任务 + 通用共 11 项', Store.TASKS.length === 11 && Store.TASKS[1].value === 'write');

  // 分工一览：界面据此把「谁干什么」摊开，避免只显示一个启用方案造成「不能分工」的误解
  const rt = Store.routingTable();
  ok('分工表覆盖十类任务', rt.length === 10);
  const rtMem = rt.filter(r => r.task === 'memory')[0];
  const rtWrite = rt.filter(r => r.task === 'write')[0];
  const rtSplit = rt.filter(r => r.task === 'split')[0];
  ok('专职任务标为 dedicated', rtMem.source === 'dedicated' && rtMem.model === 'cheap-1');
  ok('未指派任务标为 fallback', rtSplit.source === 'fallback' && rtSplit.model === 'big-1');
  ok('分工结果与 activeModel 一致', rtWrite.model === Store.activeModel('write').model);

  // 指派：一个任务只能有一套方案，指派新的自动解绑旧的（否则界面会出现假象）
  Store.upsertModelPreset({ name: '更便宜的记忆', providerId: 'pB', model: 'cheaper-9', task: 'memory' });
  const rtMem2 = Store.routingTable().filter(r => r.task === 'memory')[0];
  ok('重复指派时给出冲突提示', rtMem2.conflict === 2, String(rtMem2.conflict));
  ok('冲突时只认第一套', Store.activeModel('memory').model === 'cheap-1');
  Store.assignTask('memory', mMem.id);
  ok('指派后冲突消失', Store.routingTable().filter(r => r.task === 'memory')[0].conflict === 0);
  Store.assignTask('memory', '');
  ok('取消指派后回落兜底', Store.activeModel('memory').model === 'big-1');
  ok('取消指派后分工表标记为 fallback',
    Store.routingTable().filter(r => r.task === 'memory')[0].source === 'fallback');
  // 指派到别的任务：自动从原任务解绑，不会同时挂着两个
  Store.assignTask('memory', mMem.id);
  Store.assignTask('audit', mMem.id);
  ok('一套方案改派任务后不再挂原任务',
    Store.activeModel('memory').model === 'big-1' && Store.activeModel('audit').model === 'cheap-1');
  // 指派到「提供商已被删除」的方案：专职其实没生效，必须标出来而不是假装生效
  Store.assignTask('audit', '');
  const mGhost = Store.upsertModelPreset({ name: '幽灵方案', providerId: 'pNone', model: 'ghost-1', task: 'audit' });
  const rtAudit = Store.routingTable().filter(r => r.task === 'audit')[0];
  ok('专职方案提供商已删除时标为失效', rtAudit.broken === true);
  ok('失效时实际回落兜底方案', Store.activeModel('audit').model === 'big-1');
  Store.state.modelPresets = Store.state.modelPresets.filter(m => m.id !== mGhost.id);

  // 复原成「主笔兜底」的干净状态给后续用例
  Store.state.providers = [P_OPENAI, P_CHEAP];
  Store.state.activeProviderId = 'pA';
  Store.state.modelPresets = [mWrite];
  Store.state.activePresetId = mWrite.id;

  /* ================================================================
   * [3] 关闭思考：发参正确 + 老网关 400 兜底
   * ================================================================ */
  console.log('\n[3] 关闭思考（省掉按输出计费的思考 token）');
  mock(() => jsonRes({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  await API.chat({ provider: Object.assign({}, P_OPENAI, { noThink: true }), system: 's', user: 'u', stream: false });
  ok('OpenAI 系发 enable_thinking=false', body(0).enable_thinking === false);
  ok('OpenAI 系发 thinking.type=disabled', !!(body(0).thinking && body(0).thinking.type === 'disabled'));

  mock(() => jsonRes({ choices: [{ message: { content: 'ok' } }] }));
  await API.chat({ provider: P_OPENAI, system: 's', user: 'u', stream: false });
  ok('未开启时不带思考参数', body(0).enable_thinking === undefined && body(0).thinking === undefined);

  mock(() => jsonRes({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  await API.chat({ provider: Object.assign({}, P_GOOG, { noThink: true }), system: 's', user: 'u', stream: false });
  ok('Gemini 发 thinkingBudget=0',
    !!(body(0).generationConfig && body(0).generationConfig.thinkingConfig &&
      body(0).generationConfig.thinkingConfig.thinkingBudget === 0));

  // Gemini 老模型不认 thinkingConfig → 400 → 剥参重试
  let gn = 0;
  mock(() => {
    gn++;
    return gn === 1
      ? { ok: false, status: 400, text: async () => 'Unknown name "thinkingConfig"', json: async () => ({}) }
      : jsonRes({ candidates: [{ content: { parts: [{ text: '重试成功' }] } }] });
  });
  const rg = await API.chat({ provider: Object.assign({}, P_GOOG, { noThink: true }), system: 's', user: 'u', stream: false });
  ok('Gemini 400 后剥掉思考参数重试', calls.length === 2 && rg.text === '重试成功');
  ok('重试请求不再带 thinkingConfig', !body(1).generationConfig.thinkingConfig);

  /* 回归：Response 的 body 只能读一次。
   * 旧实现在 400 循环里读过一次 `res.text()`，跳出循环后又读第二次，
   * 于是「网关对 enable_thinking 回 400」时会抛
   * "Failed to execute 'text' on 'Response': body stream already read" —— 这个内部
   * 错误直接弹给用户（且发生在正文已生成完之后，表现就是「生成完了却说失败」）。
   * 这里用「同一个 Response 对象只能消费一次」的真实语义复现，确保不再回归。 */
  function onceRes(status, bodyText) {
    let used = false;
    return {
      ok: false, status: status,
      text: async () => {
        if (used) throw new Error("Failed to execute 'text' on 'Response': body stream already read");
        used = true; return bodyText;
      },
      json: async () => ({})
    };
  }
  let think400 = 0;
  mock(() => {
    think400++;
    if (think400 === 1) return onceRes(400, 'unknown parameter: enable_thinking');
    return jsonRes({ choices: [{ message: { content: '剥掉思考参数后成功' } }] });
  });
  let thinkErr = '';
  let thinkOk = null;
  try {
    thinkOk = await API.chat({ provider: Object.assign({}, P_OPENAI, { noThink: true }), system: 's', user: 'u', stream: false });
  } catch (e) { thinkErr = e.message || ''; }
  ok('400 后重试不再抛「body stream already read」', !/body stream already read/.test(thinkErr), thinkErr.slice(0, 60));
  ok('400 后剥掉思考参数并成功返回', !!thinkOk && thinkOk.text === '剥掉思考参数后成功',
    thinkOk ? thinkOk.text : thinkErr.slice(0, 60));
  ok('剥参重试确实发了两次请求', calls.length === 2);
  ok('第二次请求已无思考参数', body(1).enable_thinking === undefined);

  // 无参数可剥时：必须把网关的真实错误报出来，而不是内部错误、也不能静默成功
  let hard400 = 0;
  mock(() => { hard400++; return onceRes(400, 'invalid api key format'); });
  let hardErr = '';
  try { await API.chat({ provider: P_OPENAI, system: 's', user: 'u', stream: false }); } catch (e) { hardErr = e.message || ''; }
  ok('无可剥参数时只请求一次', hard400 === 1, String(hard400));
  ok('报出网关的真实错误文案', /HTTP 400/.test(hardErr) && /invalid api key format/.test(hardErr), hardErr.slice(0, 60));
  ok('不把内部错误抛给用户', !/body stream already read/.test(hardErr));

  // OpenAI 兼容网关不认 stream_options → 400 → 剥参重试且仍是流式
  let on = 0;
  mock(() => {
    on++;
    return on === 1
      ? onceRes(400, 'unsupported parameter: stream_options')
      : sseRes([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '流式' } }] }),
        'data: [DONE]'
      ]);
  });
  const ro = await API.chat({
    provider: Object.assign({}, P_OPENAI, { noThink: true }), system: 's', user: 'u', stream: true, onDelta() { }
  });
  ok('stream_options 400 后重试仍流式', ro.text === '流式');
  ok('重试请求已去掉 stream_options', body(1).stream_options === undefined);
  ok('重试仍保留关闭思考参数', body(1).enable_thinking === false);

  /* ================================================================
   * [4] 触发式世界设定注入 + 角色卡结构化字段
   * ================================================================ */
  console.log('\n[4] 触发式世界设定注入');
  const b4 = Store.createBook('触发注入');
  const volA = Store.addVolume(b4, '第一卷 启程', '主角离开故乡');
  const volB = Store.addVolume(b4, '第二卷 边城', '抵达边境');
  const eAlways = Store.addWorldEntry(b4, 'characters', '林昭', '男主，冷静寡言');           // 无关键词 → 老行为
  const eKey = Store.addWorldEntry(b4, 'locations', '黑石城', '边境要塞', null, { keywords: '黑石城, 要塞' });
  const ePin = Store.addWorldEntry(b4, 'factions', '铁卫', '城防军', null, { keywords: '铁卫', pin: true });
  const eScope = Store.addWorldEntry(b4, 'locations', '雾港', '南方港口', volB.id, { keywords: '雾港' });

  ok('关键词解析支持多种分隔符', AI.parseKeywords('黑石城, 要塞、铁卫；雾港\nX').length === 5);
  ok('没填关键词：始终注入（老数据行为不变）', AI.entryHit(eAlways, '完全不相关的文本') === true);
  ok('填了关键词但未命中：不注入', AI.entryHit(eKey, '今天天气不错') === false);
  ok('关键词命中：注入', AI.entryHit(eKey, '他们抵达黑石城') === true);
  ok('📌 常驻：无视关键词始终注入', AI.entryHit(ePin, '无关文本') === true);

  const wHit = AI.worldChunksText(b4, volA.id, '他走向黑石城，看见要塞的旗');
  const wMiss = AI.worldChunksText(b4, volA.id, '一段完全没有相关地名的日常情节');
  ok('命中项进入上下文', wHit.indexOf('边境要塞') >= 0);
  ok('未命中项不占上下文', wMiss.indexOf('边境要塞') < 0);
  ok('常驻项无条件保留', wMiss.indexOf('铁卫') >= 0);
  ok('无关键词项无条件保留', wMiss.indexOf('林昭') >= 0);
  ok('其他分卷专属设定不注入', wHit.indexOf('雾港') < 0);
  ok('本卷专属设定在范围内时可注入',
    AI.worldChunksText(b4, volB.id, '雾港的夜').indexOf('雾港') >= 0);
  ok('空匹配源时全部注入（分章等通盘任务）',
    AI.worldChunksText(b4, '', '').indexOf('边境要塞') >= 0);

  console.log('\n[4b] 角色卡结构化字段');
  Store.addWorldEntry(b4, 'characters', '沈清', '女主', null, {
    state: '受伤', location: '黑石城', goal: '找到医师', knows: '林昭的真实身份', relations: '林昭的旧友'
  });
  const wCard = AI.worldChunksText(b4, '', '');
  ok('角色卡：状态', wCard.indexOf('状态：受伤') >= 0);
  ok('角色卡：位置', wCard.indexOf('位置：黑石城') >= 0);
  ok('角色卡：目标', wCard.indexOf('目标：找到医师') >= 0);
  ok('角色卡：已知', wCard.indexOf('已知：林昭的真实身份') >= 0);
  ok('角色卡：关系', wCard.indexOf('关系：林昭的旧友') >= 0);
  ok('结构化字段只加在人物条目后',
    AI.worldChunksText(b4, '', '').indexOf('- 林昭：男主，冷静寡言\n  状态') < 0);

  /* ================================================================
   * [5] 去重：同一段剧情不付两次钱
   * ================================================================ */
  console.log('\n[5] 正文与记忆去重');
  const b5 = Store.createBook('去重测试');
  Store.addVolume(b5, '第一卷', '概要');
  b5.memory = { enabled: true, keepRecent: 6, summary: '长期摘要：主角离开故乡', entries: [] };
  const chs = [];
  for (let i = 1; i <= 5; i++) {
    const c = Store.addChapter(b5, { title: '第' + i + '章', outline: '大纲' + i });
    c.content = '第' + i + '章正文内容';
    chs.push(c);
  }
  chs.forEach((c, i) => Store.addMemory(b5, c, '第' + (i + 1) + '章要点', ''));

  const ids = AI.recentWrittenChapterIds(b5);
  ok('最近 3 章 id 正确', ids.length === 3 && ids[0] === chs[2].id && ids[2] === chs[4].id);
  const cur = Store.addChapter(b5, { title: '第6章', outline: '新的一章' });
  const p5 = AI.buildChapterPrompt(b5, cur);
  ok('最近 3 章正文全文注入', p5.user.indexOf('第3章正文内容') >= 0 && p5.user.indexOf('第5章正文内容') >= 0);
  ok('这 3 章的记忆要点不再重复计费', p5.user.indexOf('第3章要点') < 0 && p5.user.indexOf('第5章要点') < 0);
  ok('更早的记忆仍在', p5.user.indexOf('第1章要点') >= 0 && p5.user.indexOf('第2章要点') >= 0);
  ok('长期摘要照常注入', p5.user.indexOf('长期摘要：主角离开故乡') >= 0);
  const p5b = AI.buildChapterPrompt(b5, cur, { skip: { recentContent: true } });
  ok('勾掉最近正文后，记忆恢复完整（信息不丢）', p5b.user.indexOf('第5章要点') >= 0);

  /* ================================================================
   * [5b] 截止位置：回头改旧章时不读后文
   * 写第 N 章却把第 N 章之后的正文 / 记忆喂进去，模型进行因果倒置，
   * 回头修改前面的分卷章节就会被后文牵着走，越改越像「已知结局的补叙」。
   * ================================================================ */
  console.log('\n[5b] 截止位置：回头改旧章不读后文');
  const bx = Store.createBook('截断测试');
  Store.addVolume(bx, '第一卷', '概要');
  bx.memory = { enabled: true, keepRecent: 6, summary: '最新摘要：全书已写到第八章', entries: [] };
  const cx = [];
  for (let i = 1; i <= 8; i++) {
    const c = Store.addChapter(bx, { title: '第' + i + '章', outline: '大纲' + i });
    c.content = '第' + i + '章正文内容';
    cx.push(c);
  }
  // 每条记忆都带着「生成该章前的摘要」快照（真实流程里就是这么存的）
  cx.forEach((c, i) => Store.addMemory(bx, c, '第' + (i + 1) + '章要点', '写到第' + i + '章为止的摘要'));

  const c3 = cx[2];                       // 回头改第 3 章
  const px = AI.buildChapterPrompt(bx, c3);
  ok('只注入本章之前的正文', px.user.indexOf('第1章正文内容') >= 0 && px.user.indexOf('第2章正文内容') >= 0);
  ok('本章自身的旧正文不注入', px.user.indexOf('第3章正文内容') < 0);
  ok('其后的正文全文不注入', px.user.indexOf('第4章正文内容') < 0 && px.user.indexOf('第8章正文内容') < 0);
  const px2 = AI.buildChapterPrompt(bx, c3, { skip: { recentContent: true } });
  ok('其后的记忆要点不注入', px2.user.indexOf('第4章要点') < 0 && px2.user.indexOf('第8章要点') < 0);
  ok('本章自身的旧要点不注入', px2.user.indexOf('第3章要点') < 0);
  ok('本章之前的要点照常注入', px2.user.indexOf('第1章要点') >= 0 && px2.user.indexOf('第2章要点') >= 0);
  ok('长期摘要回溯到写这一章之前的版本',
    px.user.indexOf('写到第2章为止的摘要') >= 0 && px.user.indexOf('最新摘要：全书已写到第八章') < 0);
  const sx0 = AI.injectStats(bx, c3);
  ok('预览报告截断情况', sx0.cutoff.at === 2 && sx0.cutoff.skippedChapters === 5 && sx0.cutoff.skippedEntries === 5,
    JSON.stringify(sx0.cutoff));
  ok('标明摘要已回溯', sx0.cutoff.summaryDated === true);

  // 删掉第 3 章那条记忆（= 拿不到历史快照），应退回当前摘要并明确标注时间边界
  Store.removeMemory(bx, bx.memory.entries.filter(e => e.chapterId === c3.id)[0].id);
  const px3 = AI.buildChapterPrompt(bx, c3);
  ok('拿不到历史快照时退回当前摘要并标注时间边界',
    px3.user.indexOf('最新摘要：全书已写到第八章') >= 0 && /可能包含本章之后才发生的情节/.test(px3.user));
  ok('预览同样标明未回溯', AI.injectStats(bx, c3).cutoff.summaryDated === false);
  ok('审计旧章只对照本章之前的记忆',
    AI.fullMemoryText(bx, null, 2).indexOf('第4章要点') < 0 &&
    AI.fullMemoryText(bx, null, 2).indexOf('第1章要点') >= 0);
  ok('不截断时（自动分章）仍给全部记忆', AI.fullMemoryText(bx).indexOf('第8章要点') >= 0);

  /* ================================================================
   * [5c] 反复重写同一章：不吃自己的旧记忆 / 记忆不重复堆积
   * 用户实测：重新生成时会引用本章已有的记忆，重写效果不佳；
   * 反复重写还会给同一章攒出好几份记忆。
   * ================================================================ */
  console.log('\n[5c] 重写同一章');
  const br = Store.createBook('重写测试');
  Store.addVolume(br, '第一卷', '概要');
  br.memory = { enabled: true, keepRecent: 6, summary: '', entries: [] };
  const cr = [];
  for (let i = 1; i <= 5; i++) {
    const c = Store.addChapter(br, { title: '第' + i + '章', outline: 'o' + i });
    c.content = '第' + i + '章正文';
    cr.push(c);
  }
  // 复刻真实流程：每写完一章，条目记下「写这章之前」的摘要，随后摘要并入本章
  cr.forEach((c, i) => {
    Store.addMemory(br, c, '第' + (i + 1) + '章要点', br.memory.summary);
    br.memory.summary = '摘要（第' + (i + 1) + '章已并入）';
  });
  ok('一章一条记忆', br.memory.entries.length === 5, String(br.memory.entries.length));

  // —— 重写第 3 章 ——
  ok('前情基线回溯到写这一章之前',
    Store.memoryBaseline(br, cr[2]) === '摘要（第2章已并入）', Store.memoryBaseline(br, cr[2]));
  const pRe = AI.buildChapterPrompt(br, cr[2]);
  ok('重写时不再注入本章自己的旧记忆',
    pRe.user.indexOf('第3章已并入') < 0 && pRe.user.indexOf('第3章要点') < 0);
  ok('重写时注入的是本章之前的前情',
    pRe.user.indexOf('第2章已并入') >= 0 && pRe.user.indexOf('第1章正文') >= 0);
  ok('重写时不再注入本章之后的剧情',
    pRe.user.indexOf('第4章已并入') < 0 && pRe.user.indexOf('第4章正文') < 0);
  // 前两章正文已全文注入，其要点不再重复列（同一段剧情不付两次钱）
  ok('重写时前两章的要点不重复列出',
    pRe.user.indexOf('第1章要点') < 0 && pRe.user.indexOf('第2章要点') < 0);
  const pRe2 = AI.buildChapterPrompt(br, cr[2], { skip: { recentContent: true } });
  ok('勾掉最近正文后，本章之前的要点恢复',
    pRe2.user.indexOf('第1章要点') >= 0 && pRe2.user.indexOf('第2章要点') >= 0);
  ok('勾掉最近正文后，本章及之后的要点仍不注入',
    pRe2.user.indexOf('第3章要点') < 0 && pRe2.user.indexOf('第5章要点') < 0);

  // 连着重写三次：条目数不变，内容更新，summaryBefore 不被污染
  for (let k = 1; k <= 3; k++) {
    Store.addMemory(br, cr[2], '第3章要点（第' + k + '版）', Store.memoryBaseline(br, cr[2]));
  }
  ok('反复重写不新增记忆条目', br.memory.entries.length === 5, String(br.memory.entries.length));
  ok('记忆内容更新为最新版', Store.getMemoryEntry(br, cr[2]).text === '第3章要点（第3版）');
  ok('summaryBefore 未被重写污染',
    Store.getMemoryEntry(br, cr[2]).summaryBefore === '摘要（第2章已并入）',
    Store.getMemoryEntry(br, cr[2]).summaryBefore);
  ok('该章只有一条记忆',
    br.memory.entries.filter(e => e.chapterId === cr[2].id).length === 1);

  // 就算调用方传了被污染的摘要（老实现就是这么传的），也不该覆盖掉最早的快照
  Store.addMemory(br, cr[2], '第3章要点（污染版）', br.memory.summary);
  ok('传入被污染的摘要把不住已有快照',
    Store.getMemoryEntry(br, cr[2]).summaryBefore === '摘要（第2章已并入）');

  // —— 正常续写 vs 回头改旧章：摘要警告不能误报 ——
  const bn = Store.createBook('续写测试');
  Store.addVolume(bn, '第一卷', '概要');
  bn.memory = { enabled: true, keepRecent: 6, summary: '', entries: [] };
  const cn = [];
  for (let i = 1; i <= 3; i++) {
    const c = Store.addChapter(bn, { title: '第' + i + '章', outline: 'o' + i });
    c.content = '第' + i + '章正文';
    cn.push(c);
  }
  cn.forEach((c, i) => {
    Store.addMemory(bn, c, '第' + (i + 1) + '章要点', bn.memory.summary);
    bn.memory.summary = '摘要（第' + (i + 1) + '章已并入）';
  });
  const cNew = Store.addChapter(bn, { title: '第4章', outline: 'o4' });
  const pNew = AI.buildChapterPrompt(bn, cNew);
  ok('正常续写（摘要正好停在本章之前）不加「含后文」警告',
    pNew.user.indexOf('第3章已并入') >= 0 &&
    pNew.user.indexOf('可能包含本章之后才发生的情节') < 0);
  ok('正常续写时摘要照常注入', pNew.user.indexOf('摘要（第3章已并入）') >= 0);

  // 老数据清理：旧版给同一章攒下的多份记忆，载入时合并成一条
  const bLegacy = JSON.parse(JSON.stringify(br));
  bLegacy.id = 'legacy-book';
  bLegacy.memory.entries = bLegacy.memory.entries.filter(e => e.chapterId !== cr[2].id);
  // 手工造出旧版的脏数据：同一章三条
  bLegacy.memory.entries.push(
    { id: 'm1', chapterId: cr[2].id, chapterIndex: 2, chapterTitle: '第3章', text: '旧版一', summaryBefore: '写第三章前的摘要' },
    { id: 'm2', chapterId: cr[2].id, chapterIndex: 2, chapterTitle: '第3章', text: '旧版二', summaryBefore: '' },
    { id: 'm3', chapterId: cr[2].id, chapterIndex: 2, chapterTitle: '第3章', text: '旧版三', summaryBefore: '' }
  );
  Store.state.books.push(bLegacy);
  Store.save();
  Store.state = null;
  Store.init();                                  // 触发迁移
  const fixed = Store.getBook('legacy-book');
  ok('老数据里的多份同章记忆被合并成一条',
    fixed.memory.entries.filter(e => e.chapterId === cr[2].id).length === 1);
  const fx = fixed.memory.entries.filter(e => e.chapterId === cr[2].id)[0];
  ok('合并后保留最新内容', fx.text === '旧版三', fx.text);
  ok('合并后保留最早的「写这一章之前」快照', fx.summaryBefore === '写第三章前的摘要', fx.summaryBefore);
  ok('其他章的条目不受影响', fixed.memory.entries.length === 5, String(fixed.memory.entries.length));

  /* ================================================================
   * [6] 文风规则
   * ================================================================ */
  console.log('\n[6] 文风规则（禁词 / 套话）');
  const b6 = Store.createBook('文风测试');
  Store.addVolume(b6, '第一卷', '概要');
  b6.styleRules = { banned: '首先，其次\n仿佛\n不禁之词' };
  const c6 = Store.addChapter(b6, { title: '章', outline: 'o' });
  const p6 = AI.buildChapterPrompt(b6, c6);
  ok('禁词清单进入提示词', p6.user.indexOf('【文风规则】') >= 0 && p6.user.indexOf('- 首先') >= 0);
  ok('禁词按换行/逗号切成条目', AI.bannedListText(b6).split('\n').length === 4);
  ok('禁词清单不含空白项', AI.bannedListText(b6).indexOf('- \n') < 0);
  const p6b = AI.buildChapterPrompt(b6, c6, { skip: { styleRules: true } });
  ok('预览可临时去掉文风块', p6b.user.indexOf('【文风规则】') < 0);
  ok('空清单整块不注入', (function () {
    const t = Store.createBook('无文风'); Store.addVolume(t, 'V', 's');
    const cc = Store.addChapter(t, { title: 'x', outline: 'y' });
    return AI.buildChapterPrompt(t, cc).user.indexOf('【文风规则】') < 0;
  })());

  const scan = Util.scanBanned('他首先打开门，然后首先坐下，其次离开。这里没有别的词。', '首先，其次\n不存在的词');
  ok('本地扫描命中禁词', scan.length === 2);
  ok('统计出现次数', (scan.filter(h => h.word === '首先')[0] || {}).count === 2);
  ok('给出上下文摘录', scan[0].hits[0].excerpt.indexOf('首先') >= 0);
  ok('没出现的词不报', !scan.some(h => h.word === '不存在的词'));
  ok('空清单不报', Util.scanBanned('随便一段正文', '').length === 0);
  ok('token 粗估：1000 中文 ≈ 600', Util.estimateTokens('中'.repeat(1000)) === 600);
  ok('token 粗估：100 英文 ≈ 30', Util.estimateTokens('a'.repeat(100)) === 30);
  ok('token 粗估：空文本为 0', Util.estimateTokens('') === 0 && Util.estimateTokens(null) === 0);

  /* ================================================================
   * [7] 伏笔板
   * ================================================================ */
  console.log('\n[7] 伏笔板');
  const b7 = Store.createBook('伏笔测试');
  Store.addVolume(b7, '第一卷', '概要');
  const h1 = Store.addHook(b7, { content: '玉佩的来历', fromChapter: 2, planChapter: 5, note: '第5章揭晓' });
  const h2 = Store.addHook(b7, { content: '黑衣人身份', fromChapter: 3, status: 'resolved' });
  const hBad = Store.addHook(b7, { content: '   ' });
  ok('空内容不建伏笔', hBad === null && b7.hooks.length === 2);
  ok('默认为未回收', h1.status === 'open');
  ok('已回收状态保留', h2.status === 'resolved');
  ok('非法状态归一为 open', Store.addHook(b7, { content: '临时', status: 'xxx' }).status === 'open');
  Store.removeHook(b7, b7.hooks[2].id);
  Store.updateHook(b7, h1.id, { planChapter: 4, note: '提前一章' });
  ok('修改伏笔生效', h1.planChapter === 4 && h1.note === '提前一章');
  ok('到计划章即算逾期', Store.overdueHooks(b7, 4).length === 1 && Store.overdueHooks(b7, 4)[0].id === h1.id);
  ok('未到计划章不算逾期', Store.overdueHooks(b7, 3).length === 0);
  ok('已回收的不算逾期', Store.overdueHooks(b7, 99).length === 1);

  const ht = AI.hooksListText(b7);
  ok('只列未回收伏笔', ht.indexOf('玉佩的来历') >= 0 && ht.indexOf('黑衣人身份') < 0);
  ok('带埋下与计划回收章', ht.indexOf('第2章埋下') >= 0 && ht.indexOf('第4章回收') >= 0);
  ok('带备注', ht.indexOf('提前一章') >= 0);
  // 前面垫两章，让 c7 落在第 3 章——第 2 章埋下的伏笔到这儿才「已经存在」
  Store.addChapter(b7, { title: '一', outline: 'o' });
  Store.addChapter(b7, { title: '二', outline: 'o' });
  const c7 = Store.addChapter(b7, { title: '章', outline: 'o' });
  const p7 = AI.buildChapterPrompt(b7, c7);
  ok('伏笔进入正文提示词', p7.user.indexOf('【未回收的伏笔') >= 0 && p7.user.indexOf('玉佩的来历') >= 0);
  ok('预览可临时去掉伏笔块',
    AI.buildChapterPrompt(b7, c7, { skip: { hooks: true } }).user.indexOf('玉佩的来历') < 0);
  // 回头写第 1 章时，第 2 章才埋的伏笔不该出现（那时剧情里还没有它）
  const c7a = b7.chapters[0];
  ok('写第 1 章时不带还没埋下的伏笔',
    AI.buildChapterPrompt(b7, c7a).user.indexOf('玉佩的来历') < 0);
  ok('不截断时伏笔照常全部列出', AI.hooksListText(b7).indexOf('玉佩的来历') >= 0);
  Store.removeHook(b7, h1.id);
  ok('删除伏笔', b7.hooks.length === 1);

  /* ================================================================
   * [8] 生成前预览：区块统计 + 临时勾除
   * ================================================================ */
  console.log('\n[8] 生成前预览与临时勾除');
  b5.styleRules = { banned: '套话一，套话二' };
  Store.addHook(b5, { content: '打开的盒子', fromChapter: 1, planChapter: 8 });
  Store.addWorldEntry(b5, 'characters', '阿七', '配角');   // 无关键词 → 始终注入
  Store.addWorldEntry(b5, 'locations', '雪原', '北方荒原', null, { keywords: '雪原' });  // 本章不提 → 不注入
  const st = AI.injectStats(b5, cur);
  ok('六个区块都有统计',
    ['world', 'memory', 'recent', 'hooks', 'style', 'outline'].every(k => st[k] && typeof st[k].tokens === 'number'));
  ok('最近正文统计出 3 章', st.recent.count === 3);
  ok('记忆统计排除已全文注入的章', st.memory.count === 2);
  ok('世界设定统计只算本章命中的条目', st.world.count === 1 && st.world.text.indexOf('雪原') < 0);
  ok('文风统计出 2 条', st.style.count === 2);
  ok('伏笔统计出 1 条', st.hooks.count === 1);
  ok('字符数与 token 粗估都给出', st.recent.chars > 0 && st.recent.tokens > 0);

  const pAll = AI.buildChapterPrompt(b5, cur);
  const pNone = AI.buildChapterPrompt(b5, cur, {
    skip: { world: true, styleRules: true, outline: true, memory: true, recentContent: true, hooks: true }
  });
  ok('勾掉后不再注入世界设定', pNone.user.indexOf('【世界设定】') < 0 && pAll.user.indexOf('【世界设定】') >= 0);
  ok('勾掉后不再注入分卷大纲', pNone.user.indexOf('【分卷大纲】') < 0);
  ok('勾掉后不再注入前情记忆', pNone.user.indexOf('【前情记忆】') < 0);
  ok('勾掉后不再注入最近正文', pNone.user.indexOf('【最近 3 章正文（全文）】') < 0);
  ok('勾掉后不再注入伏笔', pNone.user.indexOf('打开的盒子') < 0);
  ok('勾掉后不再注入文风规则', pNone.user.indexOf('【文风规则】') < 0);
  ok('本章任务始终保留（提示词不会变空）',
    pNone.user.indexOf('【本章任务】') >= 0 && pNone.user.indexOf('第6章') >= 0);
  ok('勾掉后提示词明显变短', pNone.user.length < pAll.user.length);

  /* ================================================================
   * [9] 写后一致性审计
   * ================================================================ */
  console.log('\n[9] 写后一致性审计');
  Store.state.modelPresets = Store.state.modelPresets.filter(m => m.task !== 'audit');
  Store.upsertModelPreset({ name: '审计专用', providerId: 'pB', model: 'cheap-1', task: 'audit' });
  b5.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  mock(() => jsonRes({
    choices: [{
      message: {
        content: '```json\n{"issues":[{"type":"人物状态","quote":"他站在门口","against":"前文他已离开黑石城","suggest":"改为在城外扎营"}]}\n```'
      }
    }],
    usage: { prompt_tokens: 900, completion_tokens: 80 }
  }));
  const issues = await AI.auditChapter(b5, chs[4]);
  ok('审计返回问题清单', issues.length === 1);
  ok('问题字段归一（type / quote / against / suggest）',
    issues[0].type === '人物状态' && issues[0].quote === '他站在门口' &&
    issues[0].against === '前文他已离开黑石城' && issues[0].suggest === '改为在城外扎营');
  ok('审计走独立的便宜模型', calls[0].url.indexOf('b.example.com') >= 0);
  ok('审计请求体带上待查章节正文',
    JSON.parse(calls[0].opt.body).messages[1].content.indexOf('第5章正文内容') >= 0);
  ok('审计也计入用量', b5.usage.requests === 1 && b5.usage.promptTokens === 900);

  mock(() => jsonRes({ choices: [{ message: { content: '{"issues":[]}' } }] }));
  const none = await AI.auditChapter(b5, chs[4]);
  ok('没有问题返回空数组', Array.isArray(none) && none.length === 0);

  // 返回非 JSON 时必须报错，而不是「当作没问题」——静默通过会让用户误以为章节没问题
  mock(() => jsonRes({ choices: [{ message: { content: '这不是 JSON' } }] }));
  let threw = '';
  try { await AI.auditChapter(b5, chs[4]); } catch (e) { threw = e.message || ''; }
  ok('返回非 JSON 时明确报错（不假装没问题）', /无法解析为 JSON/.test(threw), threw.slice(0, 40));

  /* ================================================================
   * [10] 存储加固
   * ================================================================ */
  console.log('\n[10] 存储加固');
  const b8 = Store.createBook('撤回栈');
  const ch8 = Store.addChapter(b8, { title: 'x', outline: 'y' });
  for (let i = 0; i < 15; i++) {
    Store.pushUndo(b8, ch8, '', '', { title: 't' + i, outline: '', content: '正文' + i });
  }
  ok('撤回栈封顶 10 条（快照含整章正文，不能无限涨）', b8.undoStack.length === 10);
  ok('保留最近一次', b8.undoStack[b8.undoStack.length - 1].snapshot.title === 't14');
  ok('最旧的已被丢弃', !b8.undoStack.some(u => u.snapshot.title === 't0'));

  const b9 = Store.createBook('新书默认结构');
  ok('新书自带伏笔板', Array.isArray(b9.hooks) && b9.hooks.length === 0);
  ok('新书自带文风规则', !!(b9.styleRules && b9.styleRules.banned === ''));
  ok('新书自带用量账本',
    !!(b9.usage && b9.usage.requests === 0 && b9.usage.promptTokens === 0 && b9.usage.cost === 0));

  /* ================================================================
   * [10b] 设定管理模型：候选对照世界书去重与判定修改
   * 记忆模型看不到世界书，它给的候选必然混着「其实已经有了」。
   * ================================================================ */
  console.log('\n[10b] 设定管理模型');
  const bw = Store.createBook('设定管理');
  Store.addVolume(bw, '第一卷', '概要');
  const eLin = Store.addWorldEntry(bw, 'characters', '林昭', '主角，来自北境');
  const eCity = Store.addWorldEntry(bw, 'locations', '雾都', '终年有雾的港口城市');
  const cw = Store.addChapter(bw, { title: '雨夜', outline: 'o' });
  cw.content = '林昭在雨夜里抵达雾都，他其实是北境守夜人的后代。';
  ok('已有条目 id 可用于引用', !!eLin.id && !!eCity.id);

  mock(() => jsonRes({
    choices: [{
      message: {
        content: JSON.stringify({
          add: [
            { cat: 'characters', name: '黑衣人', content: '追杀林昭的神秘人', keywords: '夜行者 黑袍' },
            { cat: 'locations', name: '雾都', content: '港口城市' }   // 已有，但走 add 时照收（由模型负责不重复）
          ],
          update: [
            { id: eLin.id, content: '主角，来自北境；本章揭示他是北境守夜人的后代', reason: '本章揭示身世' },
            { id: 'not-exist', content: 'xxx', reason: '指向不存在的条目' },
            { id: eCity.id, content: '', reason: '本章没给它新信息' }
          ]
        })
      }
    }],
    usage: { prompt_tokens: 700, completion_tokens: 200 }
  }));
  const gov = await AI.governWorld(bw, cw, [
    { cat: 'characters', name: '林昭', content: '北境守夜人的后代' },
    { cat: 'characters', name: '黑衣人', content: '追杀林昭的神秘人' }
  ]);
  const govBody = JSON.stringify(body(0).messages);
  ok('提示词里带上了世界书现有条目', govBody.indexOf('林昭') >= 0 && govBody.indexOf('雾都') >= 0);
  ok('现有条目带 id 供引用', govBody.indexOf('id=' + eLin.id) >= 0);
  ok('提示词里带上了候选条目', govBody.indexOf('黑衣人') >= 0);
  ok('要求模型区分新增与修改', /\badd\b/.test(govBody) && /\bupdate\b/.test(govBody));
  ok('新增类解析正确', gov.add.length === 2 && gov.add[0].name === '黑衣人');
  ok('新增类带上别名触发词', gov.add[0].keywords === '夜行者 黑袍');
  ok('修改类解析正确', gov.update.length === 1 && gov.update[0].targetId === eLin.id);
  ok('修改类记住原内容（界面可对照）', gov.update[0].prevContent === '主角，来自北境');
  ok('修改类带理由', gov.update[0].reason === '本章揭示身世');
  ok('指向不存在条目的修改被丢弃', !gov.update.some(u => u.content === 'xxx'));
  ok('内容为空的修改被丢弃', !gov.update.some(u => u.targetId === eCity.id));

  const sugIds = Store.addWorldSuggestions(bw, gov.add.concat(gov.update), cw);
  const sugUp = bw.worldSug.filter(s => s.kind === 'update')[0];
  ok('修改型建议入库', !!sugUp && sugUp.targetId === eLin.id);
  ok('新增型建议入库', bw.worldSug.filter(s => s.kind === 'add').length === 1);
  ok('建议总数正确', bw.worldSug.length === 2, String(bw.worldSug.length));
  // 上面 mock 里模型漏判了一条（把已有的「雾都」又列进 add），入库层兜住
  ok('模型漏判时，同名已有条目也不会重复新增', !bw.worldSug.some(s => s.name === '雾都'));

  // 同一条已有设定只留一条修改建议（后来的覆盖先前的）
  Store.addWorldSuggestions(bw, [{ kind: 'update', targetId: eLin.id, content: '更新版内容' }], cw);
  ok('同一条设定只留一条修改建议',
    bw.worldSug.filter(s => s.kind === 'update' && s.targetId === eLin.id).length === 1);
  ok('后来的覆盖先前的',
    bw.worldSug.filter(s => s.kind === 'update')[0].content === '更新版内容');

  // 应用修改 → 写回原条目，不是新开一条
  const before = bw.world.characters.length;
  const upId = bw.worldSug.filter(s => s.kind === 'update')[0].id;
  Store.acceptWorldSuggestion(bw, upId, null, '');
  ok('应用修改写回原条目', eLin.content === '更新版内容');
  ok('应用修改不新增条目', bw.world.characters.length === before);
  ok('应用后从待办移除', !bw.worldSug.some(s => s.id === upId));

  // 原条目被删了，修改建议应无从落地
  bw.world.characters = bw.world.characters.filter(e => e.id !== eLin.id);
  const stale = Store.addWorldSuggestions(bw, [{ kind: 'update', targetId: eLin.id, content: 'x' }], cw);
  ok('条目已删除时修改建议不入库', stale.length === 0);
  ok('设定管理是独立的模型任务', !!Store.TASKS.filter(t => t.value === 'worldman')[0]);
  ok('设定管理走自己的模型',
    AI.modelFor('worldman').model === Store.activeModel('worldman').model);

  /* ================================================================
   * [11] PWA 与单文件构建（静态检查）
   * ================================================================ */
  console.log('\n[11] PWA / 单文件构建');
  const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ok('index 声明 manifest', /<link[^>]+manifest\.webmanifest/.test(idx));
  ok('index 声明主题色', /name="theme-color"/.test(idx));
  ok('index 声明图标', /<link[^>]+icon/.test(idx));
  ok('index 未被内联（保持多文件开发态）', !/class="chip"><\/div><script>[\s\S]{5000}/.test(idx));
  const man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  ok('manifest 有名称与启动地址', !!man.name && !!man.start_url);
  ok('manifest 有图标', Array.isArray(man.icons) && man.icons.length > 0);
  ok('manifest 独立窗口打开', man.display === 'standalone');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  ok('sw 注册 install / activate / fetch',
    /addEventListener\('install'/.test(sw) && /addEventListener\('activate'/.test(sw) && /addEventListener\('fetch'/.test(sw));
  ok('sw 对导航请求回退到 index.html',
    /index\.html/.test(sw) && /req\.mode === 'navigate'/.test(sw));
  /* 缓存策略：必须是 network-first。曾经用 stale-while-revalidate，结果
   * 「先给缓存」让 git pull 之后第一次打开必定是旧版，而那个后台重验证
   * 还会被浏览器的 HTTP 缓存喂回旧字节——手机上表现为「pull 了却看不到新功能」。 */
  ok('sw 是同源 network-first（先走网络，失败才回落到缓存）',
    /fetch\(new Request\(req, \{ cache: 'reload' \}\)/.test(sw));
  ok('sw 的响应策略以「回源」开头，缓存只做兜底',
    /fetch\(new Request\(req, \{ cache: 'reload' \}\)/.test(sw.slice(sw.indexOf('e.respondWith('), sw.indexOf('e.respondWith(') + 400)));
  ok('缓存查询只在网络失败的 catch 分支里',
    /catch\(function \(\) \{[\s\S]{0,240}caches\.match\(req\)/.test(sw));
  ok('sw 用 cache:reload 绕开 HTTP 缓存（否则重验证拿回的还是旧文件）',
    /cache: 'reload'/.test(sw));
  const swVer = (sw.match(/var VERSION = '([^']+)'/) || [])[1];
  ok('sw 里的版本号存在', !!swVer, swVer);
  ok('sw 的版本号与 Store.APP_VERSION 一致（发版时要一起改）',
    swVer === Store.APP_VERSION, swVer + ' vs ' + Store.APP_VERSION);
  ok('缓存名带版本号（发版时旧缓存才会被清掉）',
    /var CACHE = 'novel-writer-' \+ VERSION/.test(sw));
  ok('单文件构建脚本存在', fs.existsSync(path.join(root, 'build', 'single-file.js')));
  const distPath = path.join(root, 'dist', 'index.html');
  if (fs.existsSync(distPath)) {
    const dist = fs.readFileSync(distPath, 'utf8');
    // 单文件版必须自包含：不能再去抓外部 js / css
    const leftovers = (dist.match(/<(script|link)[^>]+(src|href)="(?!data:)[^"]+"/g) || [])
      .filter(s => !/manifest\.webmanifest/.test(s));
    ok('单文件版自包含（无外部 js/css 引用）', leftovers.length === 0, leftovers.slice(0, 3).join(' | '));
    ok('单文件版含全部模块', ['function Store', 'API', 'AI', 'sw.js' ].every(k => dist.indexOf(k) >= 0) || dist.length > 100000);
  } else {
    console.log('    （dist/index.html 未构建，跳过单文件产物检查；运行 node build/single-file.js 生成）');
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
