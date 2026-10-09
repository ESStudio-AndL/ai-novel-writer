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
  setTimeout, clearTimeout,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  fetch: null
};
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), sandbox, { filename: file });
}
load('store.js');
load('api.js');
load('ai.js');

const { Store, API, AI } = sandbox;
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

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})();
