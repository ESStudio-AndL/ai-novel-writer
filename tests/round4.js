/* 第四轮改造 · 纯逻辑测试：正文【【】】框选 → 只改框里的内容
 *   方括号解析 / 分段渲染（方括号不显示）/ 连框一起替换 /
 *   意见簿对齐（同名多处、正文改动后仍对齐、孤儿清理）/ 取消标记 /
 *   提示词与 AI 返回解析 / 端到端「三处框只改三处，其余逐字不变」
 * 运行：node tests/round4.js
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
function jsonRes(obj, status) {
  const s = status || 200;
  return { ok: s >= 200 && s < 300, status: s, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function body(i) { return JSON.parse((calls[i || 0].opt.body) || '{}'); }

(async () => {
  delete mem['novel_ai_db_v1'];
  Store.state = null;
  Store.init();

  /* ================================================================
   * [1] 方括号解析
   * ================================================================ */
  console.log('\n[1] 【【】】解析');
  const T = '雨点砸在石板路上，他【【连鞋都没湿】】。城门在身后合拢，【【发出沉闷的响声】】。';

  const one = Util.parseBracketMarks('他【【推开城门】】。');
  ok('解析出一处', one.length === 1);
  ok('start/end 覆盖含方括号的整体',
    '他【【推开城门】】。'.slice(one[0].start, one[0].end) === '【【推开城门】】',
    '他【【推开城门】】。'.slice(one[0].start, one[0].end));
  ok('anchor 是框里的原文', one[0].anchor === '推开城门');
  ok('innerStart/innerEnd 指向框内',
    '他【【推开城门】】。'.slice(one[0].innerStart, one[0].innerEnd) === '推开城门');
  ok('编号按出现顺序', one[0].id === 'bk0' && one[0].idx === 0);

  const two = Util.parseBracketMarks(T);
  ok('解析出两处', two.length === 2, String(two.length));
  ok('第二处位置正确', T.slice(two[1].start, two[1].end) === '【【发出沉闷的响声】】',
    T.slice(two[1].start, two[1].end));
  ok('两处编号连续', two[0].id === 'bk0' && two[1].id === 'bk1');

  ok('空的【【】】不算标记', Util.parseBracketMarks('他【【】】走了。').length === 0);
  ok('只有空格的框也不算', Util.parseBracketMarks('他【【   】】走了。').length === 0);
  ok('单个方括号不算（没配对）', Util.parseBracketMarks('他【推开城门】走了。').length === 0);
  ok('只有左框没右框不算', Util.parseBracketMarks('他【【推开城门走了。').length === 0);
  ok('跨行也能框住', Util.parseBracketMarks('甲。\n【【第一行\n第二行】】\n乙。')[0].anchor === '第一行\n第二行');
  ok('相邻的两个框互不干扰',
    Util.parseBracketMarks('【【甲】】【【乙】】').map(x => x.anchor).join('/') === '甲/乙');
  ok('同一段被框两次分别成条',
    Util.parseBracketMarks('【【雨很大】】他站住。【【雨很大】】').length === 2);
  ok('没有框时返回空数组', Util.parseBracketMarks('普通正文。').length === 0);
  ok('空正文不报错', Util.parseBracketMarks('').length === 0 && Util.parseBracketMarks(null).length === 0);
  ok('重复调用互不影响（正则状态没被串）',
    Util.parseBracketMarks(T).length === 2 && Util.parseBracketMarks(T).length === 2);

  /* ================================================================
   * [2] 渲染分段：方括号不显示
   * ================================================================ */
  console.log('\n[2] 渲染分段');
  const segs = Util.bracketSegments(T);
  ok('切成「普通 + 高亮 + 普通 + 高亮 + 普通」共 5 段', segs.length === 5, String(segs.length));
  ok('高亮段是框里的原文', segs[1].mark.anchor === '连鞋都没湿' && segs[3].mark.anchor === '发出沉闷的响声');
  ok('普通段没有 mark', !segs[0].mark && !segs[2].mark && !segs[4].mark);
  ok('拼接后等于「去掉方括号」的正文',
    segs.map(s => s.text).join('') === Util.stripBrackets(T),
    segs.map(s => s.text).join(''));
  ok('方括号不出现在任何一段里',
    segs.every(s => s.text.indexOf('【【') < 0 && s.text.indexOf('】】') < 0));
  ok('没有框时只有一段', Util.bracketSegments('普通正文。').length === 1);
  ok('空正文返回空数组', Util.bracketSegments('').length === 0);

  ok('stripBrackets 保留框里的字',
    Util.stripBrackets('他【【推开城门】】。') === '他推开城门。');
  ok('stripBrackets 处理多处',
    Util.stripBrackets('甲【【一】】乙【【二】】') === '甲一乙二');

  /* ================================================================
   * [3] 连框一起替换
   * ================================================================ */
  console.log('\n[3] 应用：只替换框里的内容，方括号一并去掉');
  const items = Util.parseBracketMarks(T);
  const r1 = Util.applyBracketPatches(T, items, [
    { id: 'bk0', text: '鞋面早湿透了' },
    { id: 'bk1', text: '门轴发出一声闷响' }
  ]);
  ok('两处都被替换', r1.applied.length === 2, JSON.stringify(r1.applied));
  ok('第一处换成新文本', r1.text.indexOf('鞋面早湿透了') >= 0);
  ok('第二处换成新文本', r1.text.indexOf('门轴发出一声闷响') >= 0);
  ok('方括号全部消失', r1.text.indexOf('【【') < 0 && r1.text.indexOf('】】') < 0);
  ok('框外的正文逐字未动',
    r1.text.replace('鞋面早湿透了', '').replace('门轴发出一声闷响', '') ===
    T.replace('【【连鞋都没湿】】', '').replace('【【发出沉闷的响声】】', ''),
    r1.text);

  const S2 = '【【AAA】】中【【BBB】】';
  const r2 = Util.applyBracketPatches(S2, Util.parseBracketMarks(S2),
    [{ id: 'bk0', text: 'AAAAAAAAAA' }, { id: 'bk1', text: 'B' }]);
  ok('前面的框变长不影响后面的框', r2.text === 'AAAAAAAAAA中B', r2.text);

  const r3 = Util.applyBracketPatches(T, items, [{ id: 'bk0', text: '改了' }]);
  ok('AI 漏给的条目不动原文', r3.applied.length === 1 && r3.text.indexOf('发出沉闷的响声') >= 0);
  ok('漏给的记进 skipped', r3.skipped.length === 1 && r3.skipped[0] === 'bk1');

  const r4 = Util.applyBracketPatches(T, items, [{ id: 'bk0', text: '  ' }, { id: 'bk1', text: '' }]);
  ok('空替换一律跳过（不把原文删空）', r4.applied.length === 0 && r4.text === T);

  const r5 = Util.applyBracketPatches(T, items, [{ id: 'bk0', text: '新' }, { id: 'zz', text: '无关' }]);
  ok('不认识的 id 忽略掉', r5.applied.length === 1 && r5.text.indexOf('无关') < 0);

  /* ================================================================
   * [4] 意见簿：按框里的原文对齐
   * ================================================================ */
  console.log('\n[4] 意见对齐');
  const b = Store.createBook('框选测试');
  Store.addVolume(b, '第一卷', '概要');
  const c = Store.addChapter(b, { title: '雨夜', outline: 'o' });
  c.content = T;

  ok('新章节没有意见', Store.bracketItems(c).length === 2 && Store.bracketItems(c).every(x => !x.note));
  ok('没有框时条目为空',
    Store.bracketItems({ content: '普通正文', marks: [] }).length === 0);

  Store.setBracketNote(b, c, 0, '这句太平，换成动作');
  const it0 = Store.bracketItems(c);
  ok('第一条意见已存', it0[0].note === '这句太平，换成动作');
  ok('第二条仍是空的', it0[1].note === '');

  Store.setBracketNote(b, c, 1, '声音改成门轴的');
  ok('第二条意见也能存', Store.bracketItems(c)[1].note === '声音改成门轴的');

  c.content = '（新增一句话。）' + T;
  const it1 = Store.bracketItems(c);
  ok('正文前面插字后意见仍对齐', it1[0].note === '这句太平，换成动作' && it1[1].note === '声音改成门轴的');

  c.content = '雨点砸在石板路上，他连鞋都没湿。城门在身后合拢，【【发出沉闷的响声】】。';
  Store.pruneBracketNotes(b, c);
  const it2 = Store.bracketItems(c);
  ok('删掉的框只剩一处', it2.length === 1);
  ok('剩下那处的意见正确（没有错位到第一条）', it2[0].note === '声音改成门轴的', it2[0].note);

  const c2 = Store.addChapter(b, { title: '重复', outline: 'o' });
  c2.content = '【【雨很大】】他站住。【【雨很大】】';
  Store.setBracketNote(b, c2, 0, '第一处改小');
  Store.setBracketNote(b, c2, 1, '第二处改大');
  const it3 = Store.bracketItems(c2);
  ok('同名两处各配各的意见', it3[0].note === '第一处改小' && it3[1].note === '第二处改大',
    it3.map(x => x.note).join('/'));
  Store.setBracketNote(b, c2, 0, '第一处再改');
  ok('改第一处不影响第二处',
    Store.bracketItems(c2)[0].note === '第一处再改' && Store.bracketItems(c2)[1].note === '第二处改大');

  c2.content = '雨很大。他站住。雨很大。';
  ok('框没了以后孤儿意见被清掉', Store.pruneBracketNotes(b, c2) === true && c2.marks.length === 0);
  ok('没有孤儿时不动作', Store.pruneBracketNotes(b, c2) === false);

  /* ================================================================
   * [5] 取消标记
   * ================================================================ */
  console.log('\n[5] 取消标记');
  const c3 = Store.addChapter(b, { title: '取消', outline: 'o' });
  c3.content = '甲【【一】】乙【【二】】丙';
  Store.setBracketNote(b, c3, 0, 'x');
  Store.clearBracketMarks(b, c3);
  ok('方括号被去掉、框里的字保留', c3.content === '甲一乙二丙', c3.content);
  ok('意见被清空', c3.marks.length === 0);
  ok('再解析就没有标记了', Util.parseBracketMarks(c3.content).length === 0);

  /* ================================================================
   * [6] AI.patchChapter：提示词与返回解析
   * ================================================================ */
  console.log('\n[6] AI 只改框里的内容');
  Store.state.providers = [
    { id: 'p1', name: '便宜', type: 'openai', baseUrl: 'https://x.example.com/v1', apiKey: 'sk-1234567890', model: 'cheap' }
  ];
  Store.state.activeProviderId = 'p1';
  Store.state.modelPresets = [
    { id: 'm1', name: '主笔', providerId: 'p1', model: 'big', task: 'write' },
    { id: 'm2', name: '改稿', providerId: 'p1', model: 'cheap', task: 'patch' }
  ];
  Store.state.activePresetId = 'm1';

  const b2 = Store.createBook('提示词测试');
  Store.addVolume(b2, '第一卷', '概要');
  const c4 = Store.addChapter(b2, { title: '雨夜', outline: 'o' });
  c4.content = T;
  Store.setBracketNote(b2, c4, 0, '开头太平，给点动作');
  Store.setBracketNote(b2, c4, 1, '声音要更闷');
  const items4 = Store.bracketItems(c4);

  mock(() => jsonRes({
    choices: [{
      message: {
        content: '```json\n{"patches":[{"id":"bk0","text":"鞋面早湿透了"},{"id":"nope","text":"无关"},{"id":"bk1","text":""}]}\n```'
      }
    }],
    usage: { prompt_tokens: 900, completion_tokens: 60 }
  }));
  const patches = await AI.patchChapter(b2, c4, items4);
  const sent = JSON.stringify(body(0).messages);
  ok('走了「改稿」专用的模型方案', body(0).model === 'cheap', String(body(0).model));
  ok('提示词带上整章正文（看清前后文）', sent.indexOf('城门在身后合拢') >= 0);
  ok('提示词带上每处框里的原文', sent.indexOf('连鞋都没湿') >= 0 && sent.indexOf('发出沉闷的响声') >= 0);
  ok('提示词带上每处意见', sent.indexOf('开头太平，给点动作') >= 0 && sent.indexOf('声音要更闷') >= 0);
  ok('提示词带上片段 id（回填要对上号）', sent.indexOf('id=bk0') >= 0);
  ok('明确要求只改这些片段', /只改这些片段|一个字都不要动/.test(sent));
  ok('明确说输出里不要再带方括号', /不要再带【【】】|方括号/.test(sent));
  ok('解析出有效修改', patches.length === 1 && patches[0].id === 'bk0' && patches[0].text === '鞋面早湿透了');
  ok('id 对不上的丢弃', !patches.some(p => p.text === '无关'));
  ok('空文本的丢弃', !patches.some(p => p.id === 'bk1'));

  mock(() => jsonRes({ choices: [{ message: { content: '这不是 JSON' } }], usage: {} }));
  ok('返回非 JSON 时明确报错',
    await AI.patchChapter(b2, c4, items4).then(() => false).catch(e => /无法解析为 JSON/.test(e.message)));
  ok('没有框时直接报错',
    await AI.patchChapter(b2, c4, []).then(() => false).catch(e => /没有要修改的标记/.test(e.message)));

  /* ================================================================
   * [7] 端到端：三处框 → 只改三处 → 其余逐字不变
   * ================================================================ */
  console.log('\n[7] 整条链路');
  const P1 = '【【目标一】】', P2 = '【【目标二】】', P3 = '【【目标三】】';
  const LONG = '甲'.repeat(40) + P1 + '乙'.repeat(40) + P2 + '丙'.repeat(40) + P3 + '丁'.repeat(40);
  const N1 = '【改好的一】', N2 = '【改好好的二】', N3 = '【改好的三】';
  const b3 = Store.createBook('端到端');
  Store.addVolume(b3, '第一卷', '概要');
  const c5 = Store.addChapter(b3, { title: '章', outline: 'o' });
  c5.content = LONG;
  const it5 = Store.bracketItems(c5);
  ok('三处框各自独立', it5.length === 3);
  Store.setBracketNote(b3, c5, 0, '改成一');
  Store.setBracketNote(b3, c5, 1, '改成二');
  Store.setBracketNote(b3, c5, 2, '改成三');

  mock(() => jsonRes({
    choices: [{
      message: {
        content: JSON.stringify({
          patches: [{ id: 'bk0', text: N1 }, { id: 'bk1', text: N2 }, { id: 'bk2', text: N3 }]
        })
      }
    }],
    usage: { prompt_tokens: 500, completion_tokens: 50 }
  }));
  const got = await AI.patchChapter(b3, c5, Store.bracketItems(c5));
  Store.pushUndo(b3, c5, '', b3.memory.summary || '', { title: c5.title, outline: c5.outline, content: c5.content }, [], null, 'patch');
  const out = Util.applyBracketPatches(c5.content, it5, got);
  ok('三处全部替换', out.applied.length === 3);
  ok('替换后的文本正确',
    out.text.indexOf(N1) >= 0 && out.text.indexOf(N2) >= 0 && out.text.indexOf(N3) >= 0);
  ok('旧的框内容都消失了',
    out.text.indexOf('目标一') < 0 && out.text.indexOf('目标二') < 0 && out.text.indexOf('目标三') < 0);
  ok('成稿里没有留下方括号', out.text.indexOf('【【') < 0 && out.text.indexOf('】】') < 0);
  ok('框外的正文逐字未动', (function () {
    let a = out.text, z = LONG;
    [N1, N2, N3].forEach(s => { a = a.replace(s, ''); });
    [P1, P2, P3].forEach(s => { z = z.replace(s, ''); });
    return a === z && a.length === 160;
  })(), '剩余 ' + out.text.length);
  ok('长度只随替换片段变（没有顺手扩写）',
    out.text.length === LONG.length - (P1.length + P2.length + P3.length) + (N1.length + N2.length + N3.length),
    String(out.text.length));

  c5.content = out.text;
  Store.pruneBracketNotes(b3, c5);
  ok('应用过的意见被消费掉', c5.marks.length === 0);
  ok('撤销快照记的是改动前的正文（能回滚）',
    b3.undoStack[b3.undoStack.length - 1].kind === 'patch' &&
    b3.undoStack[b3.undoStack.length - 1].snapshot.content === LONG);

  /* ================================================================
   * [8] 老数据兼容
   * ================================================================ */
  console.log('\n[8] 老数据');
  const legacy = JSON.parse(JSON.stringify(b3));
  legacy.id = 'legacy-4';
  delete legacy.chapters[0].marks;
  Store.state.books.push(legacy);
  Store.save();
  Store.state = null; Store.init();
  const lb = Store.getBook('legacy-4');
  ok('老数据载入后补空意见簿', Array.isArray(lb.chapters[0].marks));
  ok('老数据能正常解析框', Store.bracketItems(lb.chapters[0]).length === 0);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
