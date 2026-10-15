/* 纯 Node 冒烟测试：验证 Store / AI 提示词组装 / API 流式解析
 * 运行：node tests/smoke.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// ---- 极简浏览器环境 ----
const store = {};
const sandbox = {
  console,
  TextDecoder, TextEncoder, Uint8Array, JSON, Date, Math, Promise, Object, Array, String, Number, parseInt, parseFloat, Error,
  setTimeout, clearTimeout, AbortController,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => {
      // 模拟浏览器配额：超过 5MB 抛 QuotaExceededError，用于验证保存失败不会静默丢数据
      const total = Object.keys(store).reduce((s, key) => s + store[key].length + String(v).length, 0);
      if (String(v).length > sandbox.__quotaLimit) {
        const e = new Error('quota exceeded');
        e.name = 'QuotaExceededError';
        throw e;
      }
      store[k] = String(v);
    },
    removeItem: k => { delete store[k]; }
  },
  fetch: null,
  navigator: { clipboard: null },
  document: {
    createElement: () => ({
      style: {}, setAttribute() { }, appendChild() { }, remove() { }, select() { },
      click() { }, value: ''
    }),
    body: { appendChild() { } },
    execCommand: () => true
  },
  Blob: function () { },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() { } }
};
sandbox.__quotaLimit = Infinity;
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), sandbox, { filename: file });
}
load('util.js');
load('store.js');
load('api.js');
load('ai.js');

const { Store, API, AI, Util } = sandbox;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n[1] Store 基础');
Store.init();
const b = Store.createBook('测试之书');
b.genre = '科幻'; b.synopsis = '一个测试故事';
ok('创建书本', b.title === '测试之书');
ok('默认挂载全局提示词', b.globalPromptIds.length === Store.state.globalPrompts.length);
Store.addVolume(b, '第一卷 启程', '主角离开故乡，遇到导师');
Store.addWorldEntry(b, 'characters', '林昭', '男主，冷静寡言');
Store.addWorldEntry(b, 'locations', '黑石城', '边境要塞');
ok('分卷写入', b.volumes.length === 1);
ok('世界书写入', b.world.characters.length === 1 && b.world.locations.length === 1);

console.log('\n[2] 章节 + 记忆 + 撤回');
const c1 = Store.addChapter(b, { title: '第一章', outline: '主角出发' });
const snap = { title: c1.title, outline: c1.outline, content: c1.content };
c1.content = '这是 AI 生成的正文内容。';
const e1 = Store.addMemory(b, c1, '1. 主角离开故乡', '');
b.memory.summary = '主角已离开故乡，前往黑石城。';
Store.pushUndo(b, c1, e1.id, '', snap);
ok('记忆条目写入', b.memory.entries.length === 1);
ok('摘要更新', b.memory.summary.indexOf('黑石城') >= 0);

const u = Store.popUndo(b);
c1.title = u.snapshot.title; c1.outline = u.snapshot.outline; c1.content = u.snapshot.content;
const ent = b.memory.entries.find(x => x.id === u.memoryEntryId);
if (ent) { b.memory.summary = ent.summaryBefore; Store.removeMemory(b, ent.id); }
ok('撤回后正文清空', c1.content === '');
ok('撤回后记忆删除', b.memory.entries.length === 0);
ok('撤回后摘要回滚', b.memory.summary === '');

console.log('\n[3] 提示词组装');
c1.outline = '主角在雨夜离开故乡';
c1.content = '雨很大。他背起行囊。';
const c2 = Store.addChapter(b, { title: '第二章', outline: '抵达黑石城' });
const p = AI.buildChapterPrompt(b, c2);
ok('包含书籍信息块', p.user.indexOf('【书籍信息】') >= 0);
ok('包含世界设定', p.user.indexOf('林昭') >= 0 && p.user.indexOf('黑石城') >= 0);
ok('包含分卷大纲', p.user.indexOf('第一卷 启程') >= 0);
ok('包含上一章结尾', p.user.indexOf('他背起行囊') >= 0);
ok('包含本章大纲', p.user.indexOf('抵达黑石城') >= 0);
ok('system 含全局提示词', p.system.indexOf('通用写作要求') >= 0);
ok('system 含输出规范', p.system.indexOf('【输出规范】') >= 0);
// 空分栏不应出现
ok('缺省分栏不注入', p.user.indexOf('■ 势力 / 组织') < 0);

console.log('\n[4] API 流式解析（假 OpenAI SSE）');
const events = [
  'data: ' + JSON.stringify({ choices: [{ delta: { content: '第一章。' } }] }),
  'data: ' + JSON.stringify({ choices: [{ delta: { content: '他走了。' } }] }),
  'data: [DONE]'
].join('\n\n') + '\n\n';
let idx = 0;
const enc = new TextEncoder();
sandbox.fetch = async () => ({
  ok: true, status: 200,
  body: {
    getReader: () => ({
      read: async () => idx < 1
        ? { done: false, value: enc.encode(events) }
        : { done: true }
    })
  },
  json: async () => ({}), text: async () => ''
});
(async () => {
  let out = '';
  const r = await API.chat({
    provider: { id: 'x', name: 't', type: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' },
    system: 'sys', user: 'usr', stream: true, onDelta: (d, f) => { out = f; }
  });
  ok('流式拼接正确', r.text === '第一章。他走了。', r.text);
  ok('onDelta 累积正确', out === '第一章。他走了。');

  console.log('\n[5] JSON 容错解析（大纲切分）');
  Store.state.providers[0].apiKey = 'test-key';
  Store.state.activeProviderId = Store.state.providers[0].id;
  const fake = '```json\n{"chapters":[{"title":"雨夜","outline":"他离开"}]}\n```';
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: fake } }] }), text: async () => '' });
  const arr = await AI.generateOutlines(b, b.volumes[0], 1);
  ok('解析出章节数组', arr.length === 1 && arr[0].title === '雨夜', JSON.stringify(arr));

  console.log('\n[6] 对话记录正则切分（快捷导入）');
  const dialog = [
    '在 OMate 和 gemini 的对话【我】: 新故事：李明穿越时空，在异世界冒险的小说，第一章',
    '',
    '【gemini】: # 第一章：穿越者登陆西风港',
    '',
    '李明睁开眼时，咸腥的海风正灌进他的鼻腔。',
    '',
    '**"这是哪？"** 他爬起来。',
    '',
    '需要继续第二章吗？接下来可以写他在港湾广场的见闻。',
    '',
    '---',
    '',
    '—— 分享自 OMate(omate.org)，真正属于你的AI知己',
    '',
    '【我】: 继续第二章，他在广场遇到了一个神秘商人',
    '',
    '【gemini】: # 第二章：广场上的商人',
    '',
    '港湾广场中央立着一块公告栏。'
  ].join('\n');
  const sp = AI.splitDialog(dialog, { myTag: '我' });
  ok('切出 2 章', sp.chapters.length === 2, JSON.stringify(sp.chapters.map(x => x.title)));
  ok('第一章标题取自 markdown 标题', sp.chapters[0].title === '穿越者登陆西风港', sp.chapters[0].title);
  ok('【我】的内容进大纲', sp.chapters[0].outline.indexOf('新故事') >= 0, sp.chapters[0].outline);
  ok('AI 的内容进正文', sp.chapters[0].content.indexOf('李明睁开眼') >= 0);
  ok('去掉了 markdown 粗体', sp.chapters[0].content.indexOf('**') < 0);
  ok('去掉了导出尾巴', sp.chapters[0].content.indexOf('分享自') < 0);
  ok('去掉了结尾追问', sp.chapters[0].content.indexOf('需要继续第二章吗') < 0);
  ok('第二章大纲正确', sp.chapters[1].outline.indexOf('神秘商人') >= 0, sp.chapters[1].outline);
  ok('第二章标题正确', sp.chapters[1].title === '广场上的商人', sp.chapters[1].title);
  ok('自定义我的标记', AI.splitDialog('【小明】: 写第三章\n【AI】: 正文来了', { myTag: '小明' }).chapters.length === 1);
  ok('无标记时给出原因', AI.splitDialog('没有任何标记的纯文本').reason.indexOf('未找到') >= 0);

  console.log('\n[7] AI 推荐设定：去重与转正');
  const ids1 = Store.addWorldSuggestions(b, [
    { cat: 'characters', name: '苏牧', content: '船工' },
    { cat: 'locations', name: '雾礁', content: '港口外的暗礁区' },
    { cat: 'characters', name: '林昭', content: '已有条目，应被跳过' },   // 世界书里已存在
    { cat: 'characters', name: '苏牧', content: '重复推荐，应被跳过' }
  ], c1);
  ok('只收下 2 条', ids1.length === 2, String(ids1.length));
  ok('已有条目不重复推荐', !b.worldSug.some(s => s.name === '林昭'));
  ok('推荐里自带来源章节', b.worldSug[0].chapterId === c1.id);
  Store.acceptWorldSuggestion(b, b.worldSug[0].id);
  ok('转正后进入世界书', b.world.characters.some(e => e.name === '苏牧' && e.content.indexOf('船工') >= 0));
  ok('转正后移出待办', b.worldSug.length === 1, String(b.worldSug.length));
  Store.acceptWorldSuggestion(b, b.worldSug[0].id, { cat: 'concepts', name: '雾礁', content: '港口外的暗礁区' });
  ok('可改分栏后转正', b.world.concepts.some(e => e.name === '雾礁'));
  Store.addWorldSuggestions(b, [{ cat: 'factions', name: '雾港公会', content: '控制港口' }], null);
  Store.dismissWorldSuggestions(b, b.worldSug.map(s => s.id));
  ok('忽略后清空待办', b.worldSug.length === 0);
  ok('忽略不写入世界书', !b.world.factions.some(e => e.name === '雾港公会'));

  console.log('\n[8] 老版本记忆模板自动补上「推荐设定」');
  const t = Store.getTemplateDef('memorySummary');
  t.schemes[0].content = '1. 合并摘要\n2. 严格输出 JSON：{"summary":"...","points":["...","..."]}';
  Store.migrate();
  const after = t.schemes[0].content;
  ok('补上了 world 输出字段', after.indexOf('"world"') >= 0, after);
  ok('补上了推荐说明', after.indexOf('{{categories}}') >= 0);
  ok('保留用户原有措辞', after.indexOf('合并摘要') >= 0);
  ok('说明插在 JSON 要求之前', after.indexOf('{{categories}}') < after.indexOf('严格输出 JSON'));
  const again = t.schemes[0].content;
  Store.migrate();
  ok('重复迁移不会重复插入', t.schemes[0].content === again);

  console.log('\n[9] 数据安全：损坏、备份与配额');

  // (1) 主存储损坏但备份可用 → 应恢复而不是清空
  Store.state = null;
  const good = JSON.stringify({ version: 1, books: [{ id: 'b1', title: '备份里的书', chapters: [], volumes: [], world: {} }], providers: [], globalPrompts: [] });
  store['novel_ai_db_v1_bak'] = good;
  store['novel_ai_db_v1'] = '{这不是合法 JSON';
  try {
    Store.init();
    ok('损坏主存储后从备份恢复', Store.state.books.length === 1 && Store.state.books[0].title === '备份里的书',
      JSON.stringify(Store.state.books.map(b => b.title)));
    ok('恢复后置了标记', Store.recoveredFromBackup === true);
  } catch (e) { ok('损坏主存储后从备份恢复', false, e.message); }

  // (2) 主存储与备份都不可用 → 抛错而不是静默重置为默认库
  Store.state = null;
  store['novel_ai_db_v1_bak'] = 'garbage';
  store['novel_ai_db_v1'] = 'garbage';
  let threw = false;
  try { Store.init(); } catch (e) { threw = /损坏|停止载入/.test(e.message); }
  ok('主存储与备份都坏时抛错（不静默清空）', threw);

  // (3) 全新的空环境 → 正常初始化
  delete store['novel_ai_db_v1'];
  delete store['novel_ai_db_v1_bak'];
  Store.state = null;
  Store.recoveredFromBackup = false;
  Store.init();
  ok('空环境可正常初始化', Store.state.books.length === 0);

  // (4) 备份是「基线」而不是「上一版」：多次保存不应冲掉备份
  Store.createBook('基线书');
  Store.save();
  const bakAfterFirst = store['novel_ai_db_v1_bak'];
  Store.createBook('第二本');
  Store.save();
  Store.createBook('第三本');
  Store.save();
  ok('多次保存不会覆盖基线备份', store['novel_ai_db_v1_bak'] === bakAfterFirst,
    'backup was overwritten');

  // (5) 配额超限：save 返回 false 且 lastError 被置位，不能假装成功
  const b2 = Store.state.books[0];
  sandbox.__quotaLimit = 10;
  const saved = Store.save();
  ok('配额超限时 save 返回 false', saved === false);
  ok('配额超限时记录了错误', !!Store.lastError);
  sandbox.__quotaLimit = Infinity;
  Store.save();
  ok('恢复空间后可正常保存', Store.lastError === null);
  ok('存储信息可读', typeof Store.storageInfo().text === 'string' && Store.storageInfo().healthy === true);

  console.log('\n[10] 分卷与章节的完整性约束');

  Store.state.books = [];
  Store.state.providers = [{ id: 'p1', type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }];
  Store.state.activeProviderId = 'p1';
  const bk = Store.createBook('结构书');
  const vA = Store.addVolume(bk, '卷A', '').id;
  const vB = Store.addVolume(bk, '卷B', '').id;

  // (1) 换卷到一本「还没有任何章节」的卷：必须落在该卷位置，而不是全书最前面
  const cA1 = Store.addChapter(bk, { title: 'A1', volumeId: vA });
  const cA2 = Store.addChapter(bk, { title: 'A2', volumeId: vA });
  Store.moveChapterToVolume(bk, cA1.id, vB);
  ok('换到空卷后归属正确', Store.getChapter(bk, cA1.id).volumeId === vB);
  ok('换到空卷后不是插到全书最前', bk.chapters[0].id === cA2.id,
    bk.chapters.map(c => c.title).join(','));
  ok('换卷后无孤儿章节', bk.chapters.every(c => !!c.volumeId));

  // (2) 同卷内重复移动应被拒绝
  ok('移动到同一分卷返回 false', Store.moveChapterToVolume(bk, cA1.id, vB) === false);

  // (3) 删除分卷不产生孤儿章节（会并入剩余分卷）
  Store.removeVolume(bk, vB);
  ok('删除分卷后章节不落空', bk.chapters.every(c => !!c.volumeId),
    bk.chapters.map(c => c.title + '@' + (c.volumeId || 'NULL')).join(','));
  ok('删除分卷后章节全部归入剩余卷', bk.chapters.every(c => c.volumeId === vA));

  // (4) 章节 id 不存在时 chapterIndex 为 -1，且不会被写进推荐条目
  ok('不存在的章节 index 为 -1', Store.chapterIndex(bk, 'nope') === -1);
  Store.addWorldSuggestions(bk, [{ cat: 'characters', name: '幽灵', content: 'x' }], null);
  ok('无章节来源的推荐 chapterId 为空', bk.worldSug[0].chapterId === '');

  console.log('\n[11] 导入数据的结构校验');

  let bad = 0;
  [['不是 JSON', () => Store.importBook('{{'), ],
  ['缺少书名', () => Store.importBook('{"chapters":[]}')],
  ['chapters 不是数组', () => Store.importBook('{"title":"x","chapters":{}}')],
  ['导入的是数组', () => Store.importBook('[1,2,3]')]].forEach(function (t) {
    try { t[1](); } catch (e) { bad++; return; }
  });
  ok('非法书本 JSON 全部被拒绝', bad === 4, '通过=' + bad);

  let good2 = null;
  try { good2 = Store.importBook('{"title":"合法书","chapters":[]}'); } catch (e) { }
  ok('合法书本 JSON 可导入', !!good2 && good2.title === '合法书');
  ok('导入的书本获得新 id', !!good2 && good2.id !== undefined);

  let allBad = 0;
  [['不是 JSON', '{{'], ['缺少 books', '{"foo":1}'], ['books 不是数组', '{"books":{}}']].forEach(function (t) {
    try { Store.importAll(t[1]); } catch (e) { allBad++; }
  });
  ok('非法全量备份全部被拒绝', allBad === 3, '通过=' + allBad);

  console.log('\n[12] 撤回栈：快照时机与清理');

  Store.state.books = [];
  const ub = Store.createBook('撤回书');
  const uv = Store.addVolume(ub, '卷一', '').id;
  const uc = Store.addChapter(ub, { title: '原题', outline: '原纲', content: '原文', volumeId: uv });

  // pushUndo 应返回条目（generateChapter 依赖它回填 memoryEntryId）
  const uu = Store.pushUndo(ub, uc, '', '旧摘要', { title: '原题', outline: '原纲', content: '原文' }, []);
  ok('pushUndo 返回条目', !!uu && !!uu.id);
  ok('撤回条目带上章节 id', uu.chapterId === uc.id);

  // dropUndo：生成彻底失败时清理空快照
  Store.dropUndo(ub, uu.id);
  ok('dropUndo 可移除指定条目', ub.undoStack.length === 0);

  Store.pushUndo(ub, uc, '', '', { title: 'a', outline: 'b', content: 'c' }, []);
  Store.pushUndo(ub, uc, '', '', { title: 'a', outline: 'b', content: 'c' }, []);
  ok('撤回栈累积', ub.undoStack.length === 2);
  ok('popUndo 取最后一条', !!Store.popUndo(ub) && ub.undoStack.length === 1);

  console.log('\n[13] 全文搜索');
  Store.state.books = [];
  const sbk = Store.createBook('搜索之书');
  sbk.synopsis = '一个关于雾的故事';
  const sv = Store.addVolume(sbk, '卷一', '').id;
  Store.addChapter(sbk, { title: '雨夜启程', outline: '主角在雨夜离开故乡', content: '雾很大。他背起行囊。', volumeId: sv });
  Store.addChapter(sbk, { title: '黑石城', outline: '抵达边境要塞', content: '城门口站着卫兵。', volumeId: sv });
  Store.addWorldEntry(sbk, 'characters', '林昭', '男主，冷静寡言');
  sbk.memory.summary = '主角已离开故乡，前往黑石城。';

  const s1 = AI.search('雾很大');
  ok('能搜到正文', s1.items.some(i => i.kind === 'content'), JSON.stringify(s1.items.map(i => i.field)));
  ok('正文命中带高亮标记', s1.items.some(i => /<mark>/.test(i.excerpt)));
  ok('命中结果带章节 id（可直接跳转）', s1.items.some(i => !!i.chapterId));
  ok('能搜到章节标题', AI.search('雨夜').items.some(i => i.kind === 'outline'));
  ok('能搜到世界设定', AI.search('林昭').items.some(i => i.kind === 'world'));
  ok('能搜到记忆摘要', AI.search('前往黑石城').items.some(i => i.kind === 'memory'));
  ok('能搜到书名/简介', AI.search('雾的故事').items.some(i => i.kind === 'book'));
  ok('空查询返回空结果', AI.search('').total === 0);
  ok('无命中返回空结果', AI.search('完全不存在的内容xyz').total === 0);
  ok('可按范围过滤', AI.search('雾', { scope: 'world' }).items.every(i => i.kind === 'world'));
  ok('同一章节不重复刷屏', (function () {
    const r = AI.search('雾很大');
    const byCh = {};
    for (const it of r.items) { if (!it.chapterId) continue; byCh[it.chapterId] = (byCh[it.chapterId] || 0) + 1; }
    return Object.values(byCh).every(n => n === 1);
  })());

  console.log('\n[14] 工具函数边界');
  ok('wordCount 忽略空白', Util.wordCount(' 你好 世界\n') === 4, String(Util.wordCount(' 你好 世界\n')));
  ok('esc 转义尖括号与引号', Util.esc('<a href="x">&\'`</a>').indexOf('<') < 0);
  ok('esc 转义反引号', Util.esc('`').indexOf('&#96;') >= 0);
  ok('safeSliceEnd 不劈开代理对', (function () {
    const s = 'a'.repeat(5) + '😀';
    const t = Util.safeSliceEnd(s, 2);
    // 结果里不应出现孤立代理
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) return t.charCodeAt(i + 1) >= 0xDC00 && t.charCodeAt(i + 1) <= 0xDFFF;
      if (c >= 0xDC00 && c <= 0xDFFF) return false;
    }
    return true;
  })());
  ok('clampInt 钳制到范围', Util.clampInt(999, 1, 30, 6) === 30 && Util.clampInt(0, 1, 30, 6) === 1);
  ok('clampInt 非法值回落默认', Util.clampInt('abc', 1, 30, 6) === 6);
  ok('clampFloat 钳制到范围', Util.clampFloat(99, 1.2, 3, 1.85) === 3);
  ok('safeFilename 去掉路径分隔符', Util.safeFilename('a/b:c*d', 'x').indexOf('/') < 0);
  ok('safeFilename 空值回落', Util.safeFilename('', 'fallback') === 'fallback');
  ok('parseJsonMaybe 容忍代码块包裹', Util.parseJsonMaybe('```json\n{"a":1}\n```').a === 1);
  ok('parseJsonMaybe 容忍前后废话', Util.parseJsonMaybe('好的，结果如下：{"a":2} 完毕').a === 2);
  ok('cleanText 去围栏与首行标题', Util.cleanText('```\n# 标题\n正文\n```') === '正文');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})();
