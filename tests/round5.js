/* 第五轮改造 · 纯逻辑测试：AI 小编
 *   回复解析（人话 / actions 代码块分离）/ 流式截断 /
 *   提案解析与定位（名称匹配、同名歧义、越界、未知 op）/
 *   应用与事务（before 快照、按 id 还原、删了插回原位置）/ 撤销
 * 运行：node tests/round5.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

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

let calls = [];
function mock(fn) {
  calls = [];
  sandbox.fetch = async (url, opt) => {
    calls.push({ url: String(url), opt: opt || {} });
    return fn(String(url), opt || {}, calls.length);
  };
}
function body(i) { return JSON.parse((calls[i || 0].opt.body) || '{}'); }
/* 假流式响应：一次性把整段文本吐出来 */
function sseRes(full) {
  const enc = new TextEncoder();
  const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: full } }] }) +
    '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 80 } }) +
    '\n\ndata: [DONE]\n\n';
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

(async () => {
  delete mem['novel_ai_db_v1'];
  Store.state = null;
  Store.init();

  /* ================================================================
   * [1] 回复解析：人话与指令块分离
   * ================================================================ */
  console.log('\n[1] 标签格式的回复解析');
  const REPLY = '老周现在只是个铁匠，确实没作用。\n' +
    '我建议给他加一条守夜人眼线的暗线，这样第 9 章的铜哨就有出处了。\n\n' +
    '[改设定 老周]\n' +
    '铁匠；实为北境守夜人的眼线，铜哨是接头信物\n' +
    '[/改设定]\n\n' +
    '[加伏笔 3 9]\n' +
    '老周腰间的铜哨\n' +
    '[/加伏笔]\n';

  const p1 = AI.parseEditorReply(REPLY);
  ok('抽出两条标签', p1.actions.length === 2, String(p1.actions.length));
  ok('「改设定」映射成 world.update', p1.actions[0].op === 'world.update');
  ok('位置参数解析正确', p1.actions[0].name === '老周', p1.actions[0].name);
  ok('正文成为要改的内容', p1.actions[0].content.indexOf('眼线') >= 0);
  ok('「加伏笔」的两个章号按位置解析',
    p1.actions[1].op === 'hook.add' && p1.actions[1].fromChapter === '3' && p1.actions[1].planChapter === '9',
    JSON.stringify(p1.actions[1]));
  ok('可见文本里没有标签', p1.text.indexOf('[改设定') < 0 && p1.text.indexOf('[/') < 0);
  ok('可见文本保留了人话', p1.text.indexOf('守夜人眼线的暗线') >= 0);
  ok('可见文本去掉了尾部空行', p1.text === p1.text.trim());

  /* 键值写法 / 中文键与英文键 */
  const kv = AI.parseEditorReply('好。\n[改伏笔 玉佩的来历]\n回收=6\n备注=提前到第6章揭晓\n[/改伏笔]');
  ok('键值写法解析成 hook.update', kv.actions[0].op === 'hook.update');
  ok('伏笔靠内容定位', kv.actions[0].content === '玉佩的来历');
  ok('回收章回填', kv.actions[0].planChapter === '6', kv.actions[0].planChapter);
  ok('备注回填', kv.actions[0].note === '提前到第6章揭晓');

  const en = AI.parseEditorReply('好。\n[改大纲 5 夜访]\n林昭夜访铁匠铺\n[/改大纲]');
  ok('章号与标题按位置解析', en.actions[0].chapter === '5' && en.actions[0].title === '夜访');
  ok('正文成为章节大纲', en.actions[0].outline === '林昭夜访铁匠铺');

  const en2 = AI.parseEditorReply('好。\n[加设定 人物 守夜人]\n北境秘密组织\n[/加设定]');
  ok('分栏用中文标签也能认', en2.actions[0].cat === '人物' && en2.actions[0].name === '守夜人');
  const en3 = AI.parseEditorReply('好。\n[加设定 characters 守夜人]\n北境秘密组织\n[/加设定]');
  ok('分栏用英文键也能认', en3.actions[0].cat === 'characters');

  const selfClose = AI.parseEditorReply('好。\n[删设定 老周]\n[/删设定]');
  ok('自闭合（无正文）也能解析', selfClose.actions[0].op === 'world.del' && selfClose.actions[0].name === '老周');

  const noClose = AI.parseEditorReply('好。\n[改设定 老周]\n改后的内容');
  ok('漏写闭合标签也能救回来（模型被截断时）',
    noClose.actions.length === 1 && noClose.actions[0].content === '改后的内容');

  const pure = AI.parseEditorReply('这章节奏没问题，不用改。');
  ok('没有标签时不动文本', pure.text === '这章节奏没问题，不用改。' && pure.actions.length === 0);

  const jsonFallback = AI.parseEditorReply('好。\n```actions\n[{"op":"world.del","name":"x"}]\n```');
  ok('旧的 JSON 代码块写法仍然兼容', jsonFallback.actions.length === 1 && jsonFallback.actions[0].op === 'world.del');
  ok('JSON 块也从可见文本里剔除', jsonFallback.text.indexOf('```') < 0);

  const half = AI.parseEditorReply('好。\n[改设定 老周]');
  ok('只写了开标签时给出提示', half.actions.length === 0 && /没读全/.test(half.note), half.note);

  /* 流式期间只显示能看的部分 */
  ok('流式：遇到标签就截断', AI.editorVisibleText('说完了。\n[改设定 老') === '说完了。');
  ok('流式：还没有标签时原样显示', AI.editorVisibleText('正在说') === '正在说');
  ok('流式：解析完成的文本等于可见文本', AI.editorVisibleText(REPLY) === p1.text);

  /* ================================================================
   * [2] 提案解析：定位与拒绝乱改
   * ================================================================ */
  console.log('\n[2] 提案解析与定位');
  const b = Store.createBook('小编测试');
  const v1 = Store.addVolume(b, '第一卷', '主角入城');
  const v2 = Store.addVolume(b, '第二卷', '北上');
  const eZhou = Store.addWorldEntry(b, 'characters', '老周', '铁匠');
  const eWu = Store.addWorldEntry(b, 'locations', '雾都', '终年有雾的港口城市');
  const c1 = Store.addChapter(b, { title: '雨夜', outline: '主角雨夜入城', volumeId: v1 });
  const c2 = Store.addChapter(b, { title: '黑石城', outline: '抵达要塞', volumeId: v1 });
  c1.content = '他推开城门。';
  const h1 = Store.addHook(b, { content: '玉佩的来历', fromChapter: 1, planChapter: 5 });

  const r1 = Store.resolveEditorActions(b, [
    { op: 'world.update', name: '老周', content: '铁匠；实为北境守夜人的眼线' }
  ]);
  ok('按名字定位到设定条目', r1[0].ok && r1[0].target.id === eZhou.id);
  ok('带上分类', r1[0].target.cat === 'characters');
  ok('预览里能看到改前改后', r1[0].before === '铁匠' && r1[0].after.indexOf('眼线') >= 0);
  ok('标题能读', r1[0].title === '设定 · 老周' && r1[0].label === '修改设定');

  const r2 = Store.resolveEditorActions(b, [{ op: 'world.update', name: '不存在的人', content: 'x' }]);
  ok('找不到的条目拒绝执行', !r2[0].ok && /找不到/.test(r2[0].reason), r2[0].reason);

  // 造一个同名条目 → 必须判歧义，不能猜
  Store.addWorldEntry(b, 'factions', '老周', '另一个叫老周的组织头目');
  const r3 = Store.resolveEditorActions(b, [{ op: 'world.update', name: '老周', content: 'x' }]);
  ok('同名条目判歧义并拒绝执行', !r3[0].ok && /2 条同名/.test(r3[0].reason), r3[0].reason);
  ok('歧义提示里说清是哪几栏', /人物/.test(r3[0].reason) && /势力/.test(r3[0].reason), r3[0].reason);
  b.world.factions = b.world.factions.filter(e => e.name !== '老周');   // 收拾干净

  const r4 = Store.resolveEditorActions(b, [
    { op: 'chapter.outline', chapter: 2, title: '夜访', outline: '第一次见到铜哨' }
  ]);
  ok('按章号定位章节', r4[0].ok && r4[0].target.id === c2.id);
  ok('章号越界拒绝', Store.resolveEditorActions(b, [{ op: 'chapter.outline', chapter: 99, outline: 'x' }])[0].ok === false);
  ok('章号过小拒绝', Store.resolveEditorActions(b, [{ op: 'chapter.outline', chapter: 0, outline: 'x' }])[0].ok === false);
  ok('什么字段都没给时拒绝',
    Store.resolveEditorActions(b, [{ op: 'chapter.outline', chapter: 1 }])[0].ok === false);

  const r5 = Store.resolveEditorActions(b, [{ op: 'volume.update', volume: 2, summary: '主角北上' }]);
  ok('按卷号定位分卷', r5[0].ok && r5[0].target.id === v2.id);

  const r6 = Store.resolveEditorActions(b, [{ op: 'hook.add', content: '铜哨', fromChapter: 3, planChapter: 9 }]);
  ok('新增伏笔', r6[0].ok && r6[0].kind === 'create');
  ok('新增伏笔的预览带上章号', /第3章埋/.test(r6[0].after) && /第9章回收/.test(r6[0].after), r6[0].after);

  const r7 = Store.resolveEditorActions(b, [{ op: 'hook.update', content: '玉佩的来历', planChapter: 6 }]);
  ok('按内容定位伏笔', r7[0].ok && r7[0].target.id === h1.id);
  ok('伏笔找不到时拒绝',
    Store.resolveEditorActions(b, [{ op: 'hook.update', content: '不存在', planChapter: 6 }])[0].ok === false);

  const r8 = Store.resolveEditorActions(b, [{ op: 'chapter.delete', chapter: 1 }]);
  ok('没实现的操作明确拒绝', !r8[0].ok && /不认识的指令/.test(r8[0].reason), r8[0].reason);
  ok('空 op 也拒绝', !Store.resolveEditorActions(b, [{ op: '' }])[0].ok);

  const r9 = Store.resolveEditorActions(b, [{ op: 'world.add', cat: 'characters', name: '守夜人', content: '北境秘密组织' }]);
  ok('新增设定的分栏归一', r9[0].ok && r9[0].target.coll === 'book.world.characters');
  const r10 = Store.resolveEditorActions(b, [{ op: 'world.add', cat: '乱七八糟', name: 'x', content: 'y' }]);
  ok('非法分栏回落到 concepts', r10[0].target.cat === 'concepts');
  const r11 = Store.resolveEditorActions(b, [{ op: 'world.add', cat: 'characters', name: '老周', content: '重名' }]);
  ok('新增重名时给警告但仍可应用', r11[0].ok && !!r11[0].warn, r11[0].warn);

  /* ================================================================
   * [3] 应用与事务
   * ================================================================ */
  console.log('\n[3] 应用与事务');
  const props = Store.resolveEditorActions(b, [
    { op: 'world.update', name: '老周', content: '铁匠；实为北境守夜人的眼线' },
    { op: 'world.add', cat: 'characters', name: '守夜人', content: '北境秘密组织' },
    { op: 'hook.add', content: '铜哨', fromChapter: 3, planChapter: 9 },
    { op: 'chapter.outline', chapter: 2, title: '夜访', outline: '第一次见到铜哨' },
    { op: 'volume.update', volume: 2, summary: '主角北上，揭开守夜人内幕' }
  ]);
  ok('五条都能定位', props.every(p => p.ok), props.map(p => p.reason).join('|'));

  const worldN0 = b.world.characters.length;
  const hookN0 = b.hooks.length;
  const txn = Store.applyEditorActions(b, props, '小编：给老周加暗线');
  ok('事务已建立', !!txn && txn.changes.length === 5, txn && String(txn.changes.length));
  ok('事务带了可读的标签', txn.label === '小编：给老周加暗线');
  ok('事务记进书本', b.txns.length === 1 && b.txns[0].id === txn.id);

  ok('设定被改', Store.findWorldByName(b, '老周')[0].entry.content.indexOf('眼线') >= 0);
  ok('设定被新增', b.world.characters.length === worldN0 + 1);
  ok('伏笔被新增', b.hooks.length === hookN0 + 1);
  ok('章节大纲被改', b.chapters[1].title === '夜访' && b.chapters[1].outline === '第一次见到铜哨');
  ok('第一章没被误伤', b.chapters[0].title === '雨夜' && b.chapters[0].outline === '主角雨夜入城');
  ok('分卷大纲被改', b.volumes[1].summary === '主角北上，揭开守夜人内幕');
  ok('第一卷没被误伤', b.volumes[0].summary === '主角入城');

  ok('每条改动都存了 before 快照',
    txn.changes.every(c => c.kind === undefined && ('before' in c) && ('after' in c)));
  const delChange = txn.changes.filter(c => c.coll === 'book.world.characters' && c.before === null)[0];
  ok('新增类改动 before 为 null（撤销时删掉即可）', !!delChange);
  const updChange = txn.changes.filter(c => c.id === eZhou.id)[0];
  ok('修改类改动存下了旧值', updChange.before.content === '铁匠', JSON.stringify(updChange.before));

  // 撤销
  ok('撤销成功', Store.undoTxn(b, txn.id) === true);
  ok('撤销后事务从列表消失', b.txns.length === 0);
  ok('设定内容还原', Store.findWorldByName(b, '老周')[0].entry.content === '铁匠');
  ok('新增的设定被撤掉', b.world.characters.length === worldN0);
  ok('新增的伏笔被撤掉', b.hooks.length === hookN0);
  ok('章节标题还原', b.chapters[1].title === '黑石城' && b.chapters[1].outline === '抵达要塞');
  ok('分卷大纲还原', b.volumes[1].summary === '北上');
  ok('撤销不存在的 txid 返回 false', Store.undoTxn(b, 'nope') === false);

  /* ================================================================
   * [4] 删除类：撤销要插回原位置
   * ================================================================ */
  console.log('\n[4] 删除与「插回原位」');
  const before3 = b.world.characters.map(e => e.name);
  const delTxn = Store.applyEditorActions(b, Store.resolveEditorActions(b, [
    { op: 'world.del', name: '老周' }
  ]), '小编：删掉老周');
  ok('条目被删除', !Store.findWorldByName(b, '老周').length && b.world.characters.length === before3.length - 1);
  ok('删掉的条目记在事务里', delTxn.changes[0].after === null && delTxn.changes[0].before.name === '老周');
  ok('记下了删除时的下标', typeof delTxn.changes[0].index === 'number');

  Store.undoTxn(b, delTxn.id);
  ok('撤销后条目回来了', !!Store.findWorldByName(b, '老周').length);
  ok('而且插回了原来的位置',
    b.world.characters.map(e => e.name).join(',') === before3.join(','),
    b.world.characters.map(e => e.name).join(','));

  /* ================================================================
   * [5] AI.askEditor：上下文与提示词
   * ================================================================ */
  console.log('\n[5] 小编看到的上下文');
  Store.state.providers = [
    { id: 'p1', name: '主力', type: 'openai', baseUrl: 'https://x.example.com/v1', apiKey: 'sk-1234567890', model: 'big' }
  ];
  Store.state.activeProviderId = 'p1';
  Store.state.modelPresets = [
    { id: 'm1', name: '主笔', providerId: 'p1', model: 'big', task: 'write' },
    { id: 'm2', name: '小编', providerId: 'p1', model: 'cheap', task: 'editor' }
  ];
  Store.state.activePresetId = 'm1';
  b.memory = { enabled: true, keepRecent: 6, summary: '前情：主角已抵达雾都', entries: [] };
  Store.addMemory(b, c1, '第1章要点：雨夜入城', '');
  b.styleRules = { banned: '首先，其次' };

  mock(() => sseRes(REPLY));
  const ans = await AI.askEditor(b, c2, '老周这个角色太单薄了，怎么办？', { historyLimit: 8 });
  ok('走「小编」专用的模型方案', body(0).model === 'cheap', body(0).model);
  const sent = JSON.stringify(body(0).messages);
  ok('注入世界设定', sent.indexOf('老周') >= 0 && sent.indexOf('雾都') >= 0);
  ok('注入前情记忆（与写正文同一套）', sent.indexOf('主角已抵达雾都') >= 0);
  ok('注入最近正文', sent.indexOf('他推开城门') >= 0);
  ok('注入文风规则', sent.indexOf('首先') >= 0 && sent.indexOf('其次') >= 0);
  ok('注入分卷大纲', sent.indexOf('主角入城') >= 0);
  ok('说明了当前是哪一章', /第 2 章/.test(sent) || /第2章/.test(sent));
  ok('带上了作者这句话', sent.indexOf('老周这个角色太单薄了') >= 0);
  ok('提示词里教了标签格式', sent.indexOf('改设定') >= 0 && sent.indexOf('加伏笔') >= 0);
  ok('提示词里给了可用的分栏', /characters/.test(sent) || /人物/.test(sent));
  ok('要求标签块放在最后', /最后/.test(sent));
  ok('要求每个标签都配对的闭合标签', /\[\/标签\]/.test(sent) || /配对/.test(sent));
  ok('要求不改数据时一个标签都别写', /不需要改动数据时/.test(sent));
  ok('返回里解析出了两条提案', ans.actions.length === 2, String(ans.actions.length));
  ok('返回的可见文本干净', ans.text.indexOf('```') < 0);

  /* 上下文截断：小编看到的是「本章之前」，跟写正文一致 */
  mock(() => sseRes('好。'));
  await AI.askEditor(b, c1, '第一章怎么样？', {});
  const sent2 = JSON.stringify(body(0).messages);
  ok('以第一章为上下文时看不到第二章的正文',
    sent2.indexOf('第2章') < 0 && sent2.indexOf('抵达要塞') < 0);
  ok('第一章之前的要点/摘要仍注入', sent2.indexOf('主角已抵达雾都') >= 0);

  /* 对话历史 */
  Store.addChat(b, { role: 'user', text: '老周太单薄了' });
  Store.addChat(b, { role: 'ai', text: '给他加条暗线' });
  mock(() => sseRes('行。'));
  await AI.askEditor(b, c2, '那就这么办', {});
  const sent3 = JSON.stringify(body(0).messages);
  ok('带上了之前的对话', sent3.indexOf('老周太单薄了') >= 0 && sent3.indexOf('给他加条暗线') >= 0);
  ok('对话里标了谁在说话', sent3.indexOf('作者：') >= 0 && sent3.indexOf('小编：') >= 0);

  /* ================================================================
   * [6] 对话记录
   * ================================================================ */
  console.log('\n[6] 对话记录');
  const b6 = Store.createBook('对话测试');
  ok('新书自带空对话与空事务',
    Array.isArray(b6.chat) && b6.chat.length === 0 && Array.isArray(b6.txns) && b6.txns.length === 0);
  Store.addChat(b6, { role: 'user', text: '你好' });
  Store.addChat(b6, { role: 'ai', text: '你好，说说什么问题' });
  ok('对话按顺序追加', b6.chat.length === 2 && b6.chat[0].role === 'user' && b6.chat[1].role === 'ai');
  const m6 = Store.addChat(b6, { role: 'ai', text: '改一下', actions: [{ op: 'world.del', name: 'x' }] });
  ok('AI 消息可以带提案', m6.actions.length === 1);
  for (let i = 0; i < 80; i++) Store.addChat(b6, { role: 'user', text: '第' + i + '句' });
  ok('对话记录有长度上限（不把 localStorage 撑爆）', b6.chat.length === 60, String(b6.chat.length));
  ok('保留的是最近的', b6.chat[b6.chat.length - 1].text === '第79句');
  Store.clearChat(b6);
  ok('可以清空', b6.chat.length === 0);

  /* ================================================================
   * [6b] 单条「修改」：编辑内容写回 action
   * ================================================================ */
  console.log('\n[6b] 改单条建议');
  const bE = Store.createBook('改单条');
  Store.addVolume(bE, '第一卷', '');
  const cE1 = Store.addChapter(bE, { title: '一', outline: '原本的大纲' });
  const hE = Store.addHook(bE, { content: '玉佩的来历', fromChapter: 1, planChapter: 5 });
  const eW = Store.addWorldEntry(bE, 'locations', '雾都', '终年有雾');

  // text 类：整段替换 content
  const aT = AI.parseEditorReply('[改设定 雾都]\n改后的内容\n[/改设定]').actions[0];
  Store.applyEditorEdit(aT, '雾气不散，进港要交雾税');
  ok('text 类替换 content', aT.content === '雾气不散，进港要交雾税');
  const rT = Store.resolveEditorActions(bE, [aT]);
  ok('改完能重新定位并预览', rT[0].ok && rT[0].after === '雾气不散，进港要交雾税');
  ok('已改的条目给出可编辑内容', rT[0].editKind === 'text' && rT[0].editValue === aT.content);

  // kv 类：逐行「键=值」
  const aH = AI.parseEditorReply('[改伏笔 玉佩的来历]\n回收=5\n[/改伏笔]').actions[0];
  const rH0 = Store.resolveEditorActions(bE, [aH]);
  ok('改伏笔是可编辑的（kv 形式）', rH0[0].editKind === 'kv', rH0[0].editKind);
  ok('kv 初值里带上了当前回收章', /回收=5/.test(rH0[0].editValue), rH0[0].editValue);
  Store.applyEditorEdit(aH, '回收=7\n状态=resolved\n备注=提前揭晓');
  ok('kv 改回收章', aH.planChapter === '7', aH.planChapter);
  ok('kv 改状态', aH.status === 'resolved');
  ok('kv 改备注', aH.note === '提前揭晓');
  const rH1 = Store.resolveEditorActions(bE, [aH]);
  ok('改完预览同步更新', rH1[0].ok && /计划回收改为第7章/.test(rH1[0].after), rH1[0].after);

  const aC = AI.parseEditorReply('[改大纲 1 新标题]\n新的大纲\n[/改大纲]').actions[0];
  Store.applyEditorEdit(aC, '标题=改过的标题\n大纲=改过的大纲');
  ok('章节的标题与大纲都能改', aC.title === '改过的标题' && aC.outline === '改过的大纲');

  const aV = AI.parseEditorReply('[改分卷 1]\n第一卷大纲\n[/改分卷]').actions[0];
  Store.applyEditorEdit(aV, '标题=第一卷 雾起\n大纲=主角踏入雾都');
  ok('分卷的标题与大纲都能改', aV.title === '第一卷 雾起' && aV.summary === '主角踏入雾都');

  const bare = AI.parseEditorReply('[改大纲 1]\n只有一行大纲文字\n[/改大纲]').actions[0];
  Store.applyEditorEdit(bare, '直接写的大纲，没带键名');
  ok('kv 类没写键名时整段当大纲', bare.outline === '直接写的大纲，没带键名', bare.outline);

  ok('空内容拒绝写回', Store.applyEditorEdit(aT, '   ') === false);
  ok('空 action 拒绝写回', Store.applyEditorEdit(null, 'x') === false);

  /* 逐条应用：只落地选中的那一条 */
  const bO = Store.createBook('逐条应用');
  Store.addVolume(bO, '第一卷', '');
  Store.addWorldEntry(bO, 'locations', '雾都', '终年有雾');
  Store.addWorldEntry(bO, 'characters', '老周', '铁匠');
  Store.addChapter(bO, { title: '一', outline: 'o' });
  const multi = AI.parseEditorReply('建议如下：\n' +
    '[改设定 雾都]\n雾气不散\n[/改设定]\n' +
    '[改设定 老周]\n铁匠；守夜人眼线\n[/改设定]\n' +
    '[改大纲 1 夜访]\n夜访铁匠铺\n[/改大纲]').actions;
  ok('三条建议都在', multi.length === 3);
  const allProps = Store.resolveEditorActions(bO, multi);
  ok('三条都能定位', allProps.every(p => p.ok));
  ok('每条带上了自己的序号', allProps[0].idx === 0 && allProps[2].idx === 2);

  const txn1 = Store.applyEditorActions(bO, [allProps[1]], '小编：只改老周');
  ok('只应用了选中的那一条', txn1.changes.length === 1 && txn1.changes[0].id === Store.findWorldByName(bO, '老周')[0].entry.id);
  ok('老周被改了', Store.findWorldByName(bO, '老周')[0].entry.content.indexOf('眼线') >= 0);
  ok('雾都没被动', Store.findWorldByName(bO, '雾都')[0].entry.content === '终年有雾');
  ok('大纲没被动', bO.chapters[0].outline === 'o');

  Store.undoTxn(bO, txn1.id);
  ok('单条应用也能撤销', Store.findWorldByName(bO, '老周')[0].entry.content === '铁匠');
  ok('撤销没有波及其他条目', Store.findWorldByName(bO, '雾都')[0].entry.content === '终年有雾');

  /* 每条应用各记一条事务，互不干扰 */
  const all2 = Store.resolveEditorActions(bO, multi);
  const t1 = Store.applyEditorActions(bO, [all2[0]], 'a');
  const t2 = Store.applyEditorActions(bO, [all2[2]], 'b');
  ok('两次单条应用是两条独立事务', bO.txns.length === 2 && t1.id !== t2.id);
  Store.undoTxn(bO, t1.id);
  ok('撤销第一条不影响第二条', Store.findWorldByName(bO, '雾都')[0].entry.content === '终年有雾' &&
    bO.chapters[0].outline === '夜访铁匠铺');
  Store.undoTxn(bO, t2.id);
  ok('再撤第二条全部还原', bO.chapters[0].outline === 'o');

  /* ================================================================
   * [7] 老数据兼容 + 任务分工
   * ================================================================ */
  console.log('\n[7] 老数据与任务');
  ok('小编是独立的模型任务', !!Store.TASKS.filter(t => t.value === 'editor')[0]);
  ok('分工表里有这一类', Store.routingTable().some(r => r.task === 'editor'));

  const legacy = JSON.parse(JSON.stringify(b));
  legacy.id = 'legacy-chat';
  delete legacy.chat;
  delete legacy.txns;
  Store.state.books.push(legacy);
  Store.save();
  Store.state = null; Store.init();
  const lb = Store.getBook('legacy-chat');
  ok('老数据载入后补上空对话与空事务', Array.isArray(lb.chat) && Array.isArray(lb.txns));
  ok('老数据能正常解析提案',
    Store.resolveEditorActions(lb, [{ op: 'world.update', name: '老周', content: '改了' }])[0].ok === true);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
