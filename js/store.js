/* =========================================================
 * Store —— 本地数据层（localStorage）
 * 所有数据仅保存在本机浏览器 / WebView 中，不会上传。
 * ========================================================= */
(function (global) {
  'use strict';

  var KEY = 'novel_ai_db_v1';
  var KEY_BAK = 'novel_ai_db_v1_bak';
  /* 上一次保存失败（多为容量超限）时置位，界面上要如实告知用户 */
  var lastError = null;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function now() { return Date.now(); }

  /* 安全解析：只接受「是对象的 JSON」，其余一律 null */
  function safeParse(raw) {
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }

  /* 判断这份数据是否「像」本程序的数据，避免把垃圾当作品读进来 */
  function looksLikeState(s) {
    return !!(s && typeof s === 'object' && Array.isArray(s.books));
  }

  /* 世界书分栏：顺序即界面顺序。标签在这里定一次，ai.js 直接引用
   * （原先 store 一份 WORLD_CATS、ai 一份 WORLD_ORDER + WORLD_LABEL，
   *   多出来的那份就是「两边漏改」的隐患）。 */
  var WORLD_CATS = ['background', 'characters', 'locations', 'concepts', 'factions'];
  var WORLD_LABELS = {
    background: '背景设定',
    characters: '人物',
    locations: '地点',
    concepts: '概念 / 设定',
    factions: '势力 / 组织'
  };

  /* =========================================================
   * 内置提示词模板 —— 每一处内置 prompt 都可编辑、可保存多套方案
   * 占位符 {{xxx}} 会在调用时被替换；值为空的占位符所在行会被自动删掉
   * ========================================================= */
  var TEMPLATE_DEFS = {
    chapterSystem: {
      name: '正文生成 · 输出规范',
      desc: '写在 system 末尾，约束模型只输出正文。',
      vars: [],
      content: '【输出规范】\n' +
        '- 只输出小说正文，不要输出任何前言、解释、批注、总结或 markdown 标记。\n' +
        '- 不要自行添加“第X章”之外的额外标题；如无把握，直接开始正文。\n' +
        '- 使用中文标点，段落之间用一个空行分隔。\n' +
        '- 忠于本章大纲，不要提前写后续章节的剧情。'
    },
    bookInfo: {
      name: '书籍信息块',
      desc: '书名、类型、简介、文风等基础信息。',
      vars: ['bookTitle', 'genre', 'author', 'synopsis', 'style', 'targetWords', 'requirements'],
      content: '【书籍信息】\n' +
        '书名：{{bookTitle}}\n' +
        '类型 / 题材：{{genre}}\n' +
        '作者：{{author}}\n' +
        '故事简介：{{synopsis}}\n' +
        '文风要求：{{style}}\n' +
        '本章目标字数：约 {{targetWords}} 字\n' +
        '额外要求：{{requirements}}'
    },
    world: {
      name: '世界设定块',
      desc: '人物、地点、概念等分栏设定，空分栏不会注入。',
      vars: ['worldChunks'],
      content: '【世界设定】\n{{worldChunks}}'
    },
    volumeOutline: {
      name: '分卷大纲块',
      desc: '分卷列表注入到提示词里的格式。',
      vars: ['volumes', 'volumeCurrentLine'],
      content: '【分卷大纲】\n{{volumes}}\n{{volumeCurrentLine}}'
    },
    chapterUser: {
      name: '正文生成 · 主提示词',
      desc: '生成章节正文时发给模型的完整内容。删掉某个占位符就等于不注入那部分，可省 token。',
      vars: ['bookInfo', 'world', 'styleRules', 'outline', 'memory', 'hooks', 'recentContent', 'chapterHeading', 'chapterNo', 'chapterTitle', 'chapterOutline', 'targetWords'],
      content: '{{bookInfo}}\n\n{{world}}\n\n{{styleRules}}\n\n{{outline}}\n\n{{memory}}\n\n{{hooks}}\n\n{{recentContent}}\n\n' +
        '【本章任务】\n' +
        '{{chapterHeading}}\n' +
        '章节大纲：{{chapterOutline}}\n\n' +
        '请写出本章完整正文，目标约 {{targetWords}} 字。'
    },
    styleRules: {
      name: '文风规则块',
      desc: '书本级「禁词与套话」清单（书本基本信息页配置），留空则整块不注入。',
      vars: ['bannedList'],
      content: '【文风规则】\n以下词语与句式为本作禁用，正文中一律不得出现（包括同义改写）：\n{{bannedList}}'
    },
    hooks: {
      name: '伏笔注入块',
      desc: '写正文时自动带上未回收的伏笔，提醒模型按计划呼应、不提前揭开。',
      vars: ['hooksList'],
      content: '【未回收的伏笔（写作时可自然呼应，未到计划回收章不要提前揭开）】\n{{hooksList}}'
    },
    memoryBlock: {
      name: '记忆注入块',
      desc: '写正文时注入：长期摘要 + 近期章节记忆（最近 N 条；已全文注入的最近几章不再重复列要点）。',
      vars: ['longSummary', 'recentEntries', 'keepRecent'],
      content: '【前情记忆】\n' +
        '长期记忆摘要（此前全部剧情的压缩记录）：\n{{longSummary}}\n\n' +
        '近期章节记忆（最多 {{keepRecent}} 条）：\n{{recentEntries}}'
    },
    memoryBlockFull: {
      name: '记忆注入块 · 完整版',
      desc: '自动分章时注入的长期记忆：长期摘要 + 全部章节记忆条目（已全文注入的最近几章不重复列）。',
      vars: ['longSummary', 'allEntries', 'entryCount'],
      content: '【长期记忆（完整）】\n' +
        '长期记忆摘要（此前全部剧情的压缩记录）：\n{{longSummary}}\n\n' +
        '章节记忆（共 {{entryCount}} 条，全部列出）：\n{{allEntries}}'
    },
    auditCheck: {
      name: '写后一致性审计',
      desc: '生成正文后，对照世界设定与前情记忆检查本章是否有矛盾。',
      vars: ['bookTitle', 'world', 'memory', 'chapterHeading', 'chapterContent'],
      content: '【作品】{{bookTitle}}\n\n{{world}}\n\n{{memory}}\n\n【待检查的章节】\n{{chapterHeading}}\n{{chapterContent}}\n\n' +
        '【任务】\n' +
        '对照上面的世界设定与前情记忆，检查本章正文是否存在矛盾。只报告有明确依据的问题：\n' +
        '- 人物状态 / 位置 / 已知信息与前文或设定冲突；\n' +
        '- 设定规则被违反（能力、物品、组织规则）；\n' +
        '- 时间线或剧情顺序不合理；\n' +
        '- 与伏笔或既有事实明显冲突。\n' +
        '每条给出：正文原句片段（quote）、冲突的设定或记忆要点（against）、具体修改建议（suggest）。\n' +
        '没有问题就输出空数组，不要为了凑数硬找。\n' +
        '严格输出 JSON：{"issues":[{"type":"人物状态|设定矛盾|时间线|记忆冲突|其他","quote":"...","against":"...","suggest":"..."}]}'
    },
    outlineSplit: {
      name: '分卷自动分章',
      desc: '把一个分卷拆成 N 章大纲时使用的提示词：设定 + 完整长期记忆 + 最近 3 章正文全文 + 本卷大纲。',
      vars: ['bookInfo', 'world', 'memory', 'recentContent', 'volume', 'count'],
      content: '{{bookInfo}}\n\n{{world}}\n\n{{memory}}\n\n{{recentContent}}\n\n' +
        '【本卷大纲】\n{{volume}}\n\n' +
        '【任务】\n' +
        '为上述分卷中“接下来尚未写的 {{count}} 章”依次生成章节大纲，承接最近已写章节的进度。\n' +
        '每章大纲要求：\n' +
        '- 120~220 字，写清本章核心事件、出场人物、场景、冲突推进与章末钩子；\n' +
        '- 章节之间必须有递进，禁止重复套路；\n' +
        '- 给出有吸引力的章节标题。\n' +
        '严格输出 JSON：{"chapters":[{"title":"...","outline":"..."}]}，数组长度必须等于 {{count}}。'
    },
    chapterOutline: {
      name: '单章大纲生成',
      desc: '给已有章节单独生成 / 重写大纲时使用的提示词。',
      vars: ['bookInfo', 'world', 'outline', 'memory', 'chapterNo', 'chapterTitle'],
      content: '{{bookInfo}}\n\n{{world}}\n\n{{outline}}\n\n{{memory}}\n\n' +
        '【任务】\n' +
        '为第{{chapterNo}}章生成一段 120~220 字的章节大纲（含核心事件、人物、冲突、章末钩子）与一个章节标题。\n' +
        '严格输出 JSON：{"title":"...","outline":"..."}'
    },
    memorySummary: {
      name: '记忆总结 + 设定推荐',
      desc: '每章写完之后，让 AI 总结本章并更新长期记忆；同时让它顺手推荐本章出现的新设定条目（不直接写入世界书，需你确认）。',
      vars: ['prevSummary', 'chapterHeading', 'chapterNo', 'chapterTitle', 'chapterContent', 'keepRecent', 'categories'],
      content: '【已有长期记忆摘要】\n{{prevSummary}}\n\n' +
        '【本章内容】\n{{chapterHeading}}\n{{chapterContent}}\n\n' +
        '【任务】\n' +
        '1. 将本章新增的关键信息合并进长期记忆摘要：必须保留并更新人物关系、人物当前状态与位置、已发生的关键事件、已埋下的伏笔、未解决的冲突。\n' +
        '2. 摘要控制在 600 字以内，用紧凑的条目式中文书写，不要写评价性文字。\n' +
        '3. 另列出本章要点 3-6 条。\n' +
        '4. 如果本章出现了值得记进世界书的新设定（新出场人物 / 新地点 / 新概念 / 新势力 / 关键背景），在 world 字段里列出来；已有设定不要重复。分栏只能取：{{categories}}\n' +
        '   - 一条只描述一个对象，name 用简短名称，content 用条目式中文写清关键事实（身份、外貌、性格、关系、规则、位置等）。\n' +
        '   - 数量宁少勿滥，只留对后续写作确实有用的；本章没有新设定就输出空数组。\n' +
        '5. 严格输出 JSON：{"summary":"...","points":["...","..."],"world":[{"cat":"characters","name":"...","content":"..."}]}'
    },
    editorChat: {
      name: 'AI 小编 · 对话',
      desc: '小编看到的上下文与写正文时完全一致（世界设定 / 前情记忆 / 最近正文 / 伏笔 / 文风 / 分卷大纲），并以约定的 actions 代码块提出改动建议。',
      vars: ['bookInfo', 'world', 'styleRules', 'outline', 'memory', 'hooks', 'recentContent', 'chapterNo', 'chapterTitle', 'history', 'question', 'categories'],
      content: '{{bookInfo}}\n\n{{world}}\n\n{{styleRules}}\n\n{{outline}}\n\n{{memory}}\n\n{{hooks}}\n\n{{recentContent}}\n\n' +
        '【你正在协助的章节】\n第 {{chapterNo}} 章《{{chapterTitle}}》\n\n' +
        '【我们的对话】\n{{history}}\n\n' +
        '【作者刚说】\n{{question}}\n\n' +
        '【任务】\n' +
        '你是这本书的责任编辑。像真人聊稿一样回应作者：可以讨论剧情走向、指出问题、给出几个可选方案、说明取舍。\n' +
        '要求：\n' +
        '- 直接说结论，不要客套；有依据（引用前文或设定）就点明依据；不确定就说不确定。\n' +
        '- 篇幅控制在 400 字以内；作者要的是商量，不是长篇分析。\n' +
        '- **不要**在这部分里写任何格式化的指令块。\n' +
        '- 作者让你改东西时才动手改；只是讨论时，绝不擅自改动。\n\n' +
        '【需要动数据时】\n' +
        '在回复的**最后**写上标签块（作者会在界面上逐条预览、修改、应用或忽略）。\n' +
        '写法：\n' +
        '```\n' +
        '[改设定 老周]\n' +
        '铁匠；实为北境守夜人的眼线，铜哨是接头信物\n' +
        '[/改设定]\n\n' +
        '[加设定 人物 守夜人]\n' +
        '北境的秘密组织，成员以灰斗篷相认，只认口令不认人\n' +
        '[/加设定]\n\n' +
        '[加伏笔 3 9]\n' +
        '老周腰间的铜哨\n' +
        '[/加伏笔]\n\n' +
        '[改伏笔 玉佩的来历]\n' +
        '回收=6\n' +
        '备注=提前到第6章揭晓\n' +
        '[/改伏笔]\n\n' +
        '[改大纲 5 夜访]\n' +
        '林昭夜访铁匠铺，第一次见到铜哨\n' +
        '[/改大纲]\n\n' +
        '[改分卷 2]\n' +
        '主角北上，揭开守夜人分裂的内幕\n' +
        '[/改分卷]\n' +
        '```\n' +
        '七个标签的格式（方括号里空格分隔；含 = 的是「键=值」，不含 = 的按位置填）：\n' +
        '- `[加设定 分栏 名称]` —— 分栏只能取 {{categories}}；正文写条目的内容；可选 `别名=…`\n' +
        '- `[改设定 名称]` —— 名称**必须与世界里已有的完全相同**；正文写改后的完整内容\n' +
        '- `[删设定 名称]` —— 名称必须是已有的；不需要正文\n' +
        '- `[加伏笔 埋于章号 计划回收章号]` —— 正文写伏笔内容；两个章号可省\n' +
        '- `[改伏笔 伏笔内容]` —— 正文里写要改的项：`状态=resolved|dropped|open`、`回收=章号`、`备注=…`\n' +
        '- `[改大纲 章号 标题]` —— 标题可省；正文写本章大纲\n' +
        '- `[改分卷 卷号 标题]` —— 标题可省；正文写本卷大纲\n' +
        '注意：\n' +
        '- 定位用的名称 / 伏笔内容必须**照抄已有数据里的原文**，否则界面会找不到、这条就废了。\n' +
        '- 只写确实要改的字段，没提到的保持原样。\n' +
        '- 每个标签都要有配对的 `[/标签]`。\n' +
        '- 不需要改动数据时，**一个字都不要写这些标签**。'
    },
    chapterPatch: {
      name: '框选处局部修改',
      desc: '作者在正文里用【【】】框住要改的地方、逐条写修改意见，由 AI 只改这些地方。与「整章重写」不同：没框的地方一个字都不动。',
      vars: ['chapterHeading', 'chapterContent', 'marks', 'markCount'],
      content: '【本章正文】\n{{chapterHeading}}\n{{chapterContent}}\n\n' +
        '【需要修改的片段（{{markCount}} 处）】\n{{marks}}\n\n' +
        '【任务】\n' +
        '作者在正文里用【【】】框出了若干处（上面已逐条列出框里的原文与他的修改意见）。\n' +
        '逐条按「修改意见」改写这些片段。**只改这些片段，其余内容一个字都不要动**；\n' +
        '输出的片段里不要再带【【】】——方括号只是标记，成稿里不该出现。\n' +
        '要求：\n' +
        '- 每条给出**替换后的完整片段**（不是修改说明、不是 diff、不要加引号或编号），直接就能放回原文对应位置。\n' +
        '- 改完后句子要能无缝接上前后文，不得破坏上下文的指代与因果关系。\n' +
        '- 保持原有文风、人称、时态；不要引入原文没有的新设定、新人物、新情节。\n' +
        '- 长度与原文相近（除非修改意见本身要求扩写或压缩）。\n' +
        '- 注意各条片段之间的衔接：改完的几处不能互相矛盾。\n' +
        '- 某条意见确实无法在不改动其他内容的前提下满足时，原样返回该片段。\n' +
        '严格输出 JSON：{"patches":[{"id":"片段id","text":"替换后的完整片段"}]}'
    },
    worldGovern: {
      name: '设定管理 · 去重与修改',
      desc: '记忆模型给出本章的新设定候选后，由设定管理模型对照世界书整理：判定哪些要新增、哪些其实是已有设定需要修改，并给出触发词。',
      vars: ['bookTitle', 'chapterHeading', 'chapterContent', 'existing', 'candidates', 'categories'],
      content: '【作品】{{bookTitle}}\n\n' +
        '【本章内容】\n{{chapterHeading}}\n{{chapterContent}}\n\n' +
        '【世界书现有条目（id 用于引用，不要改动 id）】\n{{existing}}\n\n' +
        '【记忆模型给出的候选新设定】\n{{candidates}}\n\n' +
        '【任务】\n' +
        '你是这本小说的设定管理员。上面的候选是另一个模型刚从本章里挑出来的，它看不到世界书，所以很可能跟已有条目重复。请你逐条判断：\n' +
        '1. **候选里其实已经有对应条目**（同名、同一对象的不同称呼、别名、已有条目里已写过这条信息）→ 不要新增。\n' +
        '   - 若本章只是重复了已有信息，直接丢掉，不输出。\n' +
        '   - 若本章给出了该对象的新事实（新身份、新状态、新关系、新地点、规则补完等）→ 输出 update：id 填已有条目的 id，content 写**合并后的完整内容**（以原条目为基础，把本章的新事实并进去，不要丢掉原有信息），reason 一句话说明为什么要改。\n' +
        '2. **确实是新对象** → 输出 add：cat 只能取 {{categories}}，name 简短，content 条目式中文写清关键事实。还可给 keywords（逗号分隔的别名 / 触发词，用于后续按章节内容决定是否注入；没有别名就留空）。\n' +
        '3. 你也可以从本章里补出候选遗漏的、但对后续写作确实有用的条目（仍走 add）。宁少勿滥。\n' +
        '4. candidates 为空、而本章确实没给世界书带来任何新增或改动时，输出空数组。\n' +
        '严格输出 JSON：{"add":[{"cat":"characters","name":"...","content":"...","keywords":"..."}],"update":[{"id":"已有条目id","content":"合并后的完整内容","reason":"..."}]}'
    },
    worldExtract: {
      name: '世界设定 · AI 整理',
      desc: '在世界设定页把一大段想法交给 AI，自动拆成设定条目时使用。',
      vars: ['existing', 'categories', 'rawText'],
      content: '【已有设定条目（不要重复创建；若有更新，请沿用同样的 name）】\n{{existing}}\n\n' +
        '【用户的一段想法】\n{{rawText}}\n\n' +
        '【任务】\n' +
        '把上面这段想法拆成若干条设定条目，各自归入合适的分栏。\n' +
        '可用分栏（cat 只能取这些值）：{{categories}}\n' +
        '要求：\n' +
        '- 一条条目只描述一个对象（一个人物 / 一个地点 / 一个概念 / 一个组织）；同一对象的多处描述合并成一条。\n' +
        '- name 用简短名称，content 用条目式中文写清关键事实（身份、外貌、性格、关系、规则、位置等），不要整段照抄原文。\n' +
        '- 不要编造原文中没有的信息；确实归类不了的内容放入 concepts。\n' +
        '- 数量宁少勿滥，只保留对后续写作有用的。\n' +
        '严格输出 JSON：{"items":[{"cat":"characters","name":"...","content":"..."}]}'
    },
    bookImport: {
      name: '文本快捷导入',
      desc: '在「导入」页把粘贴的一大段文本交给 AI，整理成书本 / 分卷 / 章节时使用。',
      vars: ['rawText', 'contentRule'],
      content: '【待整理的文本】\n{{rawText}}\n\n' +
        '【任务】\n' +
        '把这段文本整理成小说的书本结构：给出书名与故事简介；按剧情阶段划分分卷（每卷一段分卷大纲）；每卷下列出章节，每章给出标题与章节大纲。\n' +
        '要求：\n' +
        '- {{contentRule}}\n' +
        '- 忠实于原文，不要新增或改写剧情；原文里明显的闲聊、追问、说明性文字不要算作章节。\n' +
        '- 章节顺序与原文一致。\n' +
        '严格输出 JSON：{"title":"...","synopsis":"...","volumes":[{"title":"...","summary":"...","chapters":[{"title":"...","outline":"..."}]}]}'
    }
  };

  /* 历史版本的内置原文：老数据的 localStorage 里存着旧 prompt，升级时靠它判断
   * 「这条方案是否仍原样等于旧内置」。只有逐字相同的才自动换成新措辞，
   * 用户自己改过的内容一律原样保留。新增改动时把被替换掉的旧原文追加进来即可。 */
  var LEGACY_TEMPLATE_CONTENT = {
    outlineSplit: [
      '{{bookInfo}}\n\n{{world}}\n\n' +
      '【全部分卷大纲】\n{{volumes}}\n\n' +
      '【当前要细化的分卷】\n{{volume}}\n\n' +
      '{{recentChapters}}\n\n' +
      '【任务】\n' +
      '为上述分卷中“接下来尚未写的 {{count}} 章”依次生成章节大纲，承接最近已写章节的进度。\n' +
      '每章大纲要求：\n' +
      '- 120~220 字，写清本章核心事件、出场人物、场景、冲突推进与章末钩子；\n' +
      '- 章节之间必须有递进，禁止重复套路；\n' +
      '- 给出有吸引力的章节标题。\n' +
      '严格输出 JSON：{"chapters":[{"title":"...","outline":"..."}]}，数组长度必须等于 {{count}}。'
    ],
    /* v5 的正文主提示词（没有 {{styleRules}} / {{hooks}}）：
     * 仍逐字等于这份旧原文的方案，升级到带文风规则与伏笔占位符的新结构 */
    chapterUser: [
      '{{bookInfo}}\n\n{{world}}\n\n{{outline}}\n\n{{memory}}\n\n{{recentContent}}\n\n' +
      '【本章任务】\n' +
      '{{chapterHeading}}\n' +
      '章节大纲：{{chapterOutline}}\n\n' +
      '请写出本章完整正文，目标约 {{targetWords}} 字。'
    ]
  };

  function defaultTemplates() {
    var out = {};
    Object.keys(TEMPLATE_DEFS).forEach(function (k) {
      var d = TEMPLATE_DEFS[k];
      var id = uid();
      out[k] = {
        name: d.name, desc: d.desc, vars: d.vars.slice(),
        schemes: [{ id: id, name: '默认方案', content: d.content }],
        activeId: id
      };
    });
    return out;
  }

  function defaultProvider() {
    return {
      id: uid(),
      name: '示例：OpenAI 兼容',
      type: 'openai',            // openai | anthropic | google | custom
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.85,
      maxTokens: 4096,
      topP: 1,
      extraHeaders: ''
    };
  }

  function defaultState() {
    return {
      version: 1,
      ui: { fontSize: 17, lineHeight: 1.85, theme: 'dark', fabPos: null },
      providers: [defaultProvider()],
      activeProviderId: null,
      /* 模型方案（预设）：每个预设 = 某个提供商 + 指定模型 + 可选参数覆盖。
       * activePresetId 为 null 时退回直接用激活提供商本身（老行为）。 */
      modelPresets: [],
      activePresetId: null,
      promptTemplates: defaultTemplates(),
      /* 全局累计用量（所有书本合计），书本各自的用量在 book.usage */
      usage: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 },
      globalPrompts: [
        {
          id: uid(),
          title: '通用写作要求',
          content: '你是一位资深小说家。写作时遵循：\n1. 只输出正文内容，不要输出任何解释、说明、注释或 markdown 标题。\n2. 使用中文，叙事流畅，细节具体，避免空泛形容词堆砌。\n3. 保持人物性格与已有人设一致，情节推进符合大纲。\n4. 段落自然分段，适度使用对话推动剧情。',
          enabled: true
        },
        {
          id: uid(),
          title: '记忆调用规则',
          content: '你会看到“前情记忆”与“上一章结尾”。必须严格承接这些信息：\n- 已发生的事件不可推翻或重复发生；\n- 人物已知的信息、关系与状态必须延续；\n- 不要重复描写已经写过的桥段。',
          enabled: true
        }
      ],
      books: []
    };
  }

  function newBook(title) {
    return {
      id: uid(),
      title: title || '未命名作品',
      author: '',
      genre: '',
      synopsis: '',
      style: '',
      targetWordsPerChapter: 2500,
      requirements: '',
      /* 文风规则：禁词与套话清单（换行或逗号分隔），生成时注入 + 本地扫描高亮 */
      styleRules: { banned: '' },
      createdAt: now(),
      updatedAt: now(),
      color: 'linear-gradient(150deg,#3a3f6b,#6b4a7a)',
      globalPromptIds: [],          // 本书挂载的全局提示词 id（与全局 enabled 取交集）
      world: {                      // 分栏世界书，每项可为多条条目，可缺省
        background: [],
        characters: [],
        locations: [],
        concepts: [],
        factions: []
      },
      volumes: [],                  // 分卷大纲 {id, title, summary}
      chapters: [],                 // {id, title, outline, content, volumeId, status}
      /* 伏笔板：{id, content, fromChapter, planChapter, status('open'|'resolved'|'dropped'), note, createdAt, updatedAt} */
      hooks: [],
      lastChapterId: '',            // 最近阅读 / 编辑的章节（底部「最近」页据此定位）
      lastReadAt: 0,
      memory: {
        enabled: true,
        summary: '',
        keepRecent: 6,
        suggestWorld: true,         // 生成记忆时顺带让 AI 推荐新设定条目
        entries: []                 // {id, chapterId, chapterIndex, chapterTitle, text, summaryBefore, createdAt}
      },
      /* 推荐设定出来后，是否再交给「设定管理」模型对照已有设定整理一遍
       * （去重、判定该新增还是该修改）。关掉就用记忆模型给的原始候选。 */
      worldGovern: true,
      /* AI 推荐但尚未转正的设定：
       * {id, kind:'add'|'update', cat, name, content, targetId, reason, prevContent, chapterId...}
       * kind 缺省视为 add（老数据兼容）。 */
      worldSug: [],
      chat: [],                     // 小编对话记录 {id, role, text, actions, ctx, createdAt}
      chatChapterId: '',            // 小编以哪一章为上下文（空 = 最近一章）
      txns: [],                     // 小编改动的事务（before 快照，可整批撤销）
      /* 本书累计用量：requests 次数 / 输入输出 token / 按方案单价折算的成本（元） */
      usage: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 },
      undoStack: []                 // {id, chapterId, snapshot, memoryEntryId, summaryBefore, worldSugIds, createdAt}
    };
  }

  var Store = {
    state: null,
    /* 本次会话最近一次存储错误（供界面提示），无错误为 null */
    lastError: null,

    /* 初始化
     * 解析顺序：主存储 → 自动备份。两份都坏掉时**不静默重置**：
     * 把坏数据留在原地、抛出错误，交给调用方决定怎么处理，
     * 否则用户一进页面数据就被空库覆盖、再也找不回来。
     */
    init: function () {
      var raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) { }

      var parsed = safeParse(raw);
      if (looksLikeState(parsed)) {
        this.state = parsed;
      } else if (raw) {
        // 主存储存在但解析不出可用结构：试备份
        var bakRaw = null;
        try { bakRaw = localStorage.getItem(KEY_BAK); } catch (e) { }
        var bak = safeParse(bakRaw);
        if (looksLikeState(bak)) {
          this.state = bak;
          this.recoveredFromBackup = true;
          // 立刻把主存储写回一份可用数据，避免下次再踩同样的坑
          try { localStorage.setItem(KEY, JSON.stringify(bak)); } catch (e) { }
        } else {
          // 主存储与备份都不可用：不覆盖，报错
          var err = new Error('本地数据已损坏且无可用备份，为避免误覆盖已停止载入。');
          err.code = 'DB_CORRUPT';
          err.raw = String(raw).slice(0, 500);
          throw err;
        }
      } else {
        // 全新用户：没有任何历史数据
        var bakRaw2 = null;
        try { bakRaw2 = localStorage.getItem(KEY_BAK); } catch (e) { }
        var bak2 = safeParse(bakRaw2);
        this.state = looksLikeState(bak2) ? bak2 : defaultState();
        if (looksLikeState(bak2)) this.recoveredFromBackup = true;
      }

      this.migrate();
      if (!this.state.activeProviderId && this.state.providers.length) {
        this.state.activeProviderId = this.state.providers[0].id;
      }
      return this.state;
    },

    /* 备份策略：
     * 原来的做法是「每次保存前把上一版主存储复制到备份」，等于备份永远只落后一版，
     * 主存储一坏备份也一起坏。改成只在**备份不存在**时落一份基线备份，
     * 这样备份保存的是「本次会话开始前」的完整快照，容灾才有意义。
     */
    backupOnce: function () {
      try {
        var bak = localStorage.getItem(KEY_BAK);
        if (safeParse(bak) && looksLikeState(safeParse(bak))) return;   // 已有有效备份，不动它
        var cur = localStorage.getItem(KEY);
        if (cur) localStorage.setItem(KEY_BAK, cur);
      } catch (e) { /* 备份失败不影响主流程 */ }
    },

    migrate: function () {
      var s = this.state;
      s.version = s.version || 1;
      s.ui = s.ui || { fontSize: 17, lineHeight: 1.85 };
      // 导入页的草稿（粘贴的文本与选项），刷新不丢
      s.ui.importDraft = s.ui.importDraft || {
        text: '', mode: 'regex', myTag: '我', bookTitle: '', volumeTitle: '第一卷',
        keepContent: false, targetBookId: ''
      };
      s.providers = s.providers || [];
      s.globalPrompts = s.globalPrompts || [];
      s.books = s.books || [];
      // 全局用量累计
      if (!s.usage || typeof s.usage !== 'object') s.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
      // 模型方案预设：老数据没有这套结构。合并后「模型 / 温度 / maxTokens」只归方案管，
      // 因此为每个还没有方案的提供商自动补建一个（把老字段原样搬进去），行为与老版本一致
      s.modelPresets = Array.isArray(s.modelPresets) ? s.modelPresets : [];
      if (typeof s.activePresetId !== 'string') s.activePresetId = null;
      var ap0 = s.providers.filter(function (p) { return p.id === s.activeProviderId; })[0] || s.providers[0];
      s.providers.forEach(function (pv) {
        if (s.modelPresets.some(function (x) { return x.providerId === pv.id; })) return;
        var dp = {
          id: uid(), name: (pv.name || '默认') + ' · 默认方案', providerId: pv.id,
          model: pv.model || '',
          temperature: typeof pv.temperature === 'number' ? pv.temperature : null,
          maxTokens: typeof pv.maxTokens === 'number' && pv.maxTokens > 0 ? pv.maxTokens : null
        };
        s.modelPresets.push(dp);
        // 激活提供商的方案优先成为启用项
        if (ap0 && pv.id === ap0.id) s.activePresetId = dp.id;
      });
      if (!s.activePresetId && s.modelPresets.length) s.activePresetId = s.modelPresets[0].id;
      else if (s.activePresetId && !s.modelPresets.some(function (x) { return x.id === s.activePresetId; })) {
        s.activePresetId = s.modelPresets.length ? s.modelPresets[0].id : null;
      }
      // 悬浮球位置（null = 默认右下角）
      if (!s.ui.fabPos || typeof s.ui.fabPos !== 'object') s.ui.fabPos = null;

      // 内置提示词模板：补全缺失项，修复被改坏的方案
      s.promptTemplates = s.promptTemplates || {};
      var defs = defaultTemplates();
      Object.keys(defs).forEach(function (k) {
        var t = s.promptTemplates[k];
        if (!t || !t.schemes || !t.schemes.length) { s.promptTemplates[k] = defs[k]; return; }
        t.name = defs[k].name; t.desc = defs[k].desc; t.vars = defs[k].vars.slice();
        if (!t.activeId || !t.schemes.some(function (x) { return x.id === t.activeId; })) {
          t.activeId = t.schemes[0].id;
        }
      });

      // 内置措辞有实质改动时：老数据里仍逐字等于旧内置的方案自动升级到新措辞
      // （用户自己改过的、以及自己新建的方案都不动）
      Object.keys(LEGACY_TEMPLATE_CONTENT).forEach(function (k) {
        var t = s.promptTemplates[k];
        if (!t || !t.schemes) return;
        var legacy = LEGACY_TEMPLATE_CONTENT[k];
        t.schemes.forEach(function (sc) {
          if (sc && typeof sc.content === 'string' && legacy.indexOf(sc.content) >= 0) {
            sc.content = defs[k].schemes[0].content;
          }
        });
      });

      // 记忆总结模板：老版本的方案里没有「推荐设定」这一项，补上（保留用户自己改过的措辞）
      (function () {
        var t = s.promptTemplates && s.promptTemplates.memorySummary;
        if (!t || !t.schemes) return;
        t.schemes.forEach(function (sc) {
          if (!sc || !sc.content || /"world"/.test(sc.content)) return;
          sc.content = sc.content.replace(
            '{"summary":"...","points":["...","..."]}',
            '{"summary":"...","points":["...","..."],"world":[{"cat":"characters","name":"...","content":"..."}]}'
          );
          var lines = sc.content.split('\n');
          var at = -1;
          for (var i = 0; i < lines.length; i++) {
            if (/严格输出\s*JSON/.test(lines[i])) { at = i; break; }
          }
          var add = '· 如果本章出现了值得记进世界书的新设定（新出场人物 / 新地点 / 新概念 / 新势力 / 关键背景），在 world 字段里列出来；已有设定不要重复。分栏只能取：{{categories}}\n' +
            '  一条只描述一个对象，name 用简短名称，content 用条目式中文写清关键事实。数量宁少勿滥，没有就输出空数组。';
          if (at >= 0) lines.splice(at, 0, add); else lines.push(add);
          sc.content = lines.join('\n');
        });
      })();

      s.books.forEach(function (b) {
        b.world = b.world || {};
        WORLD_CATS.forEach(function (k) {
          if (!Array.isArray(b.world[k])) b.world[k] = [];
        });
        // AI 推荐但还没转正的设定条目
        if (!Array.isArray(b.worldSug)) b.worldSug = [];
        b.volumes = b.volumes || [];
        b.chapters = b.chapters || [];
        b.globalPromptIds = b.globalPromptIds || [];
        // 文风规则（禁词清单）
        if (!b.styleRules || typeof b.styleRules !== 'object') b.styleRules = { banned: '' };
        if (typeof b.styleRules.banned !== 'string') b.styleRules.banned = '';
        // 伏笔板
        if (!Array.isArray(b.hooks)) b.hooks = [];
        b.hooks.forEach(function (h) {
          if (h.status !== 'resolved' && h.status !== 'dropped') h.status = 'open';
        });
        // 本书用量累计
        if (!b.usage || typeof b.usage !== 'object') b.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
        b.memory = b.memory || { enabled: true, summary: '', entries: [], keepRecent: 6 };
        b.memory.entries = b.memory.entries || [];
        /* 旧版「每生成一次就 push 一条」给同一章攒下了多份记忆（它们描述的是同一章的
         * 不同版本，注入时互相矛盾）。合并成一条：内容取最新那版，
         * summaryBefore 取最早那次的值——「写这一章之前」是个固定的时间点。 */
        (function () {
          var order = [], group = {};
          b.memory.entries.forEach(function (e) {
            if (!e) return;
            var key = e.chapterId || ('#' + e.id);
            if (!group[key]) { group[key] = []; order.push(key); }
            group[key].push(e);
          });
          var out = [];
          order.forEach(function (k) {
            var g = group[k];
            if (g.length === 1) { out.push(g[0]); return; }
            var last = g[g.length - 1];              // 内容取最新那一版
            for (var i = 0; i < g.length; i++) {
              if (g[i].summaryBefore) { last.summaryBefore = g[i].summaryBefore; break; }
            }
            out.push(last);
          });
          b.memory.entries = out;
        })();
        if (typeof b.memory.suggestWorld !== 'boolean') b.memory.suggestWorld = true;
        if (typeof b.worldGovern !== 'boolean') b.worldGovern = true;
        b.worldSug = b.worldSug || [];
        b.undoStack = b.undoStack || [];
        b.chat = b.chat || [];            // 小编对话记录
        b.txns = b.txns || [];            // 小编改动的事务（可撤销）
        b.chatChapterId = typeof b.chatChapterId === 'string' ? b.chatChapterId : '';

        // 父子结构：每一章都必须属于某个分卷（历史数据自动归位）
        if (!b.volumes.length && b.chapters.length) {
          b.volumes.push({ id: uid(), title: '第一卷', summary: '' });
        }
        var fallbackId = b.volumes.length ? b.volumes[0].id : '';
        b.chapters.forEach(function (c) {
          var inVolume = b.volumes.some(function (v) { return v.id === c.volumeId; });
          if (!inVolume) c.volumeId = fallbackId;
          if (!Array.isArray(c.marks)) c.marks = [];      // 划线标记（老数据补空）
        });

        // 最近阅读位置：字段缺失或指向已删除的章节时，回落到第一章
        if (typeof b.lastChapterId !== 'string') b.lastChapterId = '';
        if (typeof b.lastReadAt !== 'number') b.lastReadAt = 0;
        if (b.lastChapterId && !b.chapters.some(function (c) { return c.id === b.lastChapterId; })) {
          b.lastChapterId = ''; b.lastReadAt = 0;
        }
        if (!b.lastChapterId && b.chapters.length) {
          b.lastChapterId = b.chapters[0].id;
          b.lastReadAt = b.updatedAt || 0;
        }
      });
    },

    /* ---------- 内置提示词模板 ---------- */
    TEMPLATE_DEFS: TEMPLATE_DEFS,
    /* 供测试与诊断查看：内置模板的历史原文（判断老数据是否需要升级措辞） */
    LEGACY_TEMPLATE_CONTENT: LEGACY_TEMPLATE_CONTENT,

    /* 取当前启用方案的内容 */
    getTemplate: function (key) {
      var t = this.state.promptTemplates && this.state.promptTemplates[key];
      if (t) {
        var s = t.schemes.filter(function (x) { return x.id === t.activeId; })[0] || t.schemes[0];
        if (s && s.content) return s.content;
      }
      return TEMPLATE_DEFS[key] ? TEMPLATE_DEFS[key].content : '';
    },
    getTemplateDef: function (key) {
      return this.state.promptTemplates && this.state.promptTemplates[key] || null;
    },
    /* 新增或更新一套方案 */
    upsertScheme: function (key, data) {
      var t = this.getTemplateDef(key);
      if (!t) return null;
      var s;
      if (data.id && t.schemes.some(function (x) { return x.id === data.id; })) {
        s = t.schemes.filter(function (x) { return x.id === data.id; })[0];
        s.name = data.name || s.name;
        if (data.content != null) s.content = data.content;
      } else {
        s = { id: data.id || uid(), name: data.name || '新方案', content: data.content || this.getTemplate(key) };
        t.schemes.push(s);
        t.activeId = s.id;
      }
      this.save();
      return s;
    },
    removeScheme: function (key, id) {
      var t = this.getTemplateDef(key);
      if (!t || t.schemes.length <= 1) return false;   // 至少留一套
      t.schemes = t.schemes.filter(function (x) { return x.id !== id; });
      if (t.activeId === id) t.activeId = t.schemes[0].id;
      this.save();
      return true;
    },
    setActiveScheme: function (key, id) {
      var t = this.getTemplateDef(key);
      if (!t) return;
      t.activeId = id; this.save();
    },
    resetTemplate: function (key) {
      var d = defaultTemplates()[key];
      if (!d) return;
      this.state.promptTemplates[key] = d;
      this.save();
    },

    save: function () {
      var json;
      try {
        json = JSON.stringify(this.state);
      } catch (e) {
        // 循环引用之类：内存数据本身有问题，不能当成功
        this.lastError = this.lastError || e;
        console.error('[Store] 序列化失败', e);
        return false;
      }

      try {
        this.backupOnce();
        localStorage.setItem(KEY, json);
        this.lastError = null;
        return true;
      } catch (e) {
        // 绝大多数情况是 QuotaExceededError：正文太长塞不下。
        // 这时**不能**假装保存成功——内存里的 state 已经变了但磁盘没有。
        var quota = e && (e.name === 'QuotaExceededError' ||
          e.code === 22 || e.code === 1014 ||
          /quota|exceeded|storage/i.test(e.name + ' ' + e.message));
        this.lastError = e;
        console.error('[Store] 保存失败', e);
        // 只在第一次报错时打扰用户，避免每次输入都弹
        if (global.UI && UI.toast && !this._warnedQuota) {
          this._warnedQuota = true;
          var msg = quota
            ? '本地存储已满，最近改动未能保存！请立即导出数据备份'
            : '保存失败：' + (e && e.message ? e.message : e);
          UI.toast(msg, 6000);
        }
        return false;
      }
    },

    /* 手动解除配额告警（用户导出后调用） */
    resetQuotaWarning: function () { this._warnedQuota = false; },

    /* 存储健康度：剩余空间估算，供设置页展示 */
    storageInfo: function () {
      var used = 0;
      try { used = (localStorage.getItem(KEY) || '').length; } catch (e) { }
      // 中文字符在 UTF-16 下占 2 字节
      return {
        bytes: used * 2,
        text: used > 0 ? (used * 2 / 1024 / 1024).toFixed(2) + ' MB' : '0 MB',
        healthy: !this.lastError
      };
    },

    /* 防抖保存：翻页、输入等高频操作避免反复写 localStorage。
     * 全应用只保留这一套防抖定时器——原来 app.js 里另有一个 App.saveTimer，
     * 两套互不感知，快速交替操作时会重复写盘（长正文下明显卡顿）。
     */
    saveSoon: function (delay) {
      var self = this;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () { self._saveTimer = null; self.save(); }, delay || 400);
    },

    /* 立即落盘，取消待执行的防抖（导出前、切页前调用） */
    flush: function () {
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      this.save();
    },

    /* ---------- 通用 ---------- */
    uid: uid,

    /* ---------- 提供商 ---------- */
    getProvider: function (id) {
      return this.state.providers.filter(function (p) { return p.id === id; })[0] || null;
    },
    activeProvider: function () {
      return this.getProvider(this.state.activeProviderId) || this.state.providers[0] || null;
    },
    upsertProvider: function (data) {
      var p;
      if (data.id && this.getProvider(data.id)) {
        p = this.getProvider(data.id);
        Object.keys(data).forEach(function (k) { p[k] = data[k]; });
      } else {
        data.id = data.id || uid();
        this.state.providers.push(data);
        if (!this.state.activeProviderId) this.state.activeProviderId = data.id;
        p = data;
      }
      this.save();
      return p;
    },
    removeProvider: function (id) {
      this.state.providers = this.state.providers.filter(function (p) { return p.id !== id; });
      if (this.state.activeProviderId === id) {
        this.state.activeProviderId = this.state.providers.length ? this.state.providers[0].id : null;
      }
      // 预设引用被删提供商时，清除该覆盖字段并回退到提供商自身模型
      this.state.modelPresets.forEach(function (m) {
        if (m.providerId === id) m.providerId = this.state.activeProviderId || '';
      }, this);
      this.save();
    },

    /* ---------- 模型方案（预设） ----------
     * 一个预设绑定某个提供商，可覆盖模型名 / 温度 / maxTokens。
     * activeModel() 把预设与提供商合并成「本次请求实际使用的配置」。
     */
    getModelPreset: function (id) {
      return this.state.modelPresets.filter(function (m) { return m.id === id; })[0] || null;
    },
    upsertModelPreset: function (data) {
      var m;
      if (data.id && this.getModelPreset(data.id)) {
        m = this.getModelPreset(data.id);
        Object.keys(data).forEach(function (k) { m[k] = data[k]; });
      } else {
        data.id = data.id || uid();
        this.state.modelPresets.push(data);
        if (!this.state.activePresetId) this.state.activePresetId = data.id;
        m = data;
      }
      this.save();
      return m;
    },
    removeModelPreset: function (id) {
      this.state.modelPresets = this.state.modelPresets.filter(function (m) { return m.id !== id; });
      if (this.state.activePresetId === id) {
        this.state.activePresetId = this.state.modelPresets.length ? this.state.modelPresets[0].id : null;
      }
      this.save();
    },
    useModelPreset: function (id) {
      if (!this.getModelPreset(id)) return false;
      this.state.activePresetId = id;
      this.save();
      return true;
    },
    /* 本次 AI 请求实际使用的配置：预设覆盖优先，其余继承提供商。
     * 返回的对象形似 provider（API 层只认这些字段），额外带 __presetName 供界面显示。
     * task（任务级路由）：传入任务类型时，优先用「绑定了该任务」的方案；
     * 没有绑定则回落当前启用方案。任务类型见 Store.TASKS。 */
    activeModel: function (task) {
      if (task) {
        var tm = (this.state.modelPresets || []).filter(function (m) { return m.task === task; })[0];
        if (tm) {
          var tp = this.getProvider(tm.providerId);
          if (tp) return this._merged(tp, tm);
        }
      }
      var p = this.activeProvider();
      if (!p) return null;
      var m = this.state.activePresetId ? this.getModelPreset(this.state.activePresetId) : null;
      if (!m || m.providerId !== p.id) {
        // 预设指向的提供商不是当前激活提供商：以预设为准切换过去
        if (m && m.providerId) {
          var tp2 = this.getProvider(m.providerId);
          if (tp2) p = tp2; else return this._merged(p, null);
        } else {
          return this._merged(p, null);
        }
      }
      return this._merged(p, m);
    },
    _merged: function (p, m) {
      if (!m) return p;
      var out = {};
      Object.keys(p).forEach(function (k) { out[k] = p[k]; });
      // 方案优先；方案没填的字段回落提供商自身（老数据兼容），再无则由 API 层用默认值
      if (m.model) out.model = m.model;
      if (typeof m.temperature === 'number') out.temperature = m.temperature;
      if (typeof m.maxTokens === 'number' && m.maxTokens > 0) out.maxTokens = m.maxTokens;
      if (typeof m.noThink === 'boolean') out.noThink = m.noThink;
      out.priceIn = typeof m.priceIn === 'number' && m.priceIn > 0 ? m.priceIn : 0;
      out.priceOut = typeof m.priceOut === 'number' && m.priceOut > 0 ? m.priceOut : 0;
      out.__presetId = m.id;
      out.__presetName = m.name || '';
      out.__task = m.task || '';
      return out;
    },

    /* 任务类型（模型方案可绑定其一，实现「不同活用不同模型」） */
    /* 版本号。改代码后请一并改 sw.js 里的 VERSION（两者必须一致，有测试锁着）——
     * 缓存的键名带着版本号，发版时旧缓存才会被清掉，否则手机上会一直看到旧页面。 */
    APP_VERSION: '9.0.0',

    /* 世界书分栏（供 ai.js / 界面共用同一份定义） */
    WORLD_CATS: WORLD_CATS,
    WORLD_LABEL: WORLD_LABELS,

    TASKS: [
      { value: '', label: '通用（跟当前启用方案走）' },
      { value: 'write', label: '正文生成 / 重写' },
      { value: 'split', label: '自动分章' },
      { value: 'outline', label: '单章大纲' },
      { value: 'editor', label: '小编对话 / 改稿提案' },
      { value: 'patch', label: '标记处局部修改' },
      { value: 'memory', label: '记忆总结 / 设定初筛' },
      { value: 'worldman', label: '设定管理（去重与修改）' },
      { value: 'world', label: '世界设定 AI 整理' },
      { value: 'audit', label: '一致性审计' },
      { value: 'import', label: '文本快捷导入' }
    ],
    taskLabel: function (task) {
      var t = this.TASKS.filter(function (x) { return x.value === task; })[0];
      return t && task ? t.label.replace(/（.*$/, '') : '';
    },

    /* ---------- 任务分工一览 ----------
     * 「启用」只有一个，很容易让人以为模型不能分工。实际上每类任务都可以在
     * 方案里指定「专用于」，没指定的才回落当前启用方案（兜底）。
     * 这里把七类任务各自**实际会走哪套方案**算出来，界面据此把分工摊开：
     *   source = 'dedicated' 该任务有专职方案
     *   source = 'fallback'  该任务没人认领，用兜底方案
     *   conflict = N>1       同一任务被 N 套方案认领，只认第一套（提醒用户清理）
     * 只统计「提供商仍然有效」的方案，与 activeModel() 的实际解析结果一致。 */
    routingTable: function () {
      var self = this;
      var byTask = {};
      (this.state.modelPresets || []).forEach(function (m) {
        if (!m.task) return;
        if (!byTask[m.task]) byTask[m.task] = [];
        byTask[m.task].push(m);
      });
      var fallback = this.state.activePresetId ? this.getModelPreset(this.state.activePresetId) : null;
      return this.TASKS.filter(function (t) { return !!t.value; }).map(function (t) {
        var all = byTask[t.value] || [];
        var usable = all.filter(function (m) { return !!self.getProvider(m.providerId); });
        var m = usable[0] || fallback || null;
        var p = m ? self.getProvider(m.providerId) : self.activeProvider();
        return {
          task: t.value,
          label: self.taskLabel(t.value),
          preset: m || null,
          presetName: m ? (m.name || '未命名方案') : '',
          providerName: p ? p.name : '',
          model: (m && m.model) || (p && p.model) || '',
          source: usable.length ? 'dedicated' : 'fallback',
          conflict: all.length > 1 ? all.length : 0,
          // 指派了但提供商没了：专职其实没生效，得告诉用户
          broken: all.length > 0 && usable.length === 0
        };
      });
    },

    /* 给某类任务指派方案（presetId 为空 = 取消指派，回落兜底方案）。
     * 一个任务只能有一套方案：指派新的会自动把旧的那套解绑，
     * 否则界面上会出现「两套都显示专职、实际只认第一套」的假象。 */
    assignTask: function (task, presetId) {
      (this.state.modelPresets || []).forEach(function (m) {
        if (m.task === task) delete m.task;
      });
      if (presetId) {
        var m2 = this.getModelPreset(presetId);
        if (!m2) return false;
        m2.task = task;
      }
      this.save();
      return true;
    },

    /* ---------- 用量记账 ----------
     * usage: { promptTokens, completionTokens, cachedTokens }
     * model：本次实际使用的合并配置（带 priceIn/priceOut，单位：元 / 百万 token）
     * book：可选，本书累计也记一份。
     * 成本按全价计算（缓存命中折扣不计入，宁可高估不可低估）。 */
    recordUsage: function (usage, model, book) {
      if (!usage || (!usage.promptTokens && !usage.completionTokens)) return;
      var pt = usage.promptTokens || 0, ct = usage.completionTokens || 0;
      var priceIn = (model && typeof model.priceIn === 'number') ? model.priceIn : 0;
      var priceOut = (model && typeof model.priceOut === 'number') ? model.priceOut : 0;
      var cost = pt / 1e6 * priceIn + ct / 1e6 * priceOut;
      function acc(o) {
        o.requests++; o.promptTokens += pt; o.completionTokens += ct; o.cost += cost;
      }
      var s = this.state;
      if (!s.usage || typeof s.usage !== 'object') s.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
      acc(s.usage);
      if (book) {
        if (!book.usage || typeof book.usage !== 'object') book.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
        acc(book.usage);
      }
      this.saveSoon(1500);
    },
    resetUsage: function () {
      this.state.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
      this.state.books.forEach(function (b) { b.usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 }; });
      this.save();
    },

    /* ---------- 伏笔板 ----------
     * h: {content, fromChapter, planChapter, status, note}
     * fromChapter / planChapter 存数字（第几章），允许空。
     */
    addHook: function (book, h) {
      h = h || {};
      var hook = {
        id: uid(),
        content: String(h.content || '').trim(),
        fromChapter: Util.clampInt(h.fromChapter, 1, 99999, 0) || 0,
        planChapter: Util.clampInt(h.planChapter, 1, 99999, 0) || 0,
        status: h.status === 'resolved' || h.status === 'dropped' ? h.status : 'open',
        note: String(h.note || '').trim(),
        createdAt: now(), updatedAt: now()
      };
      if (!hook.content) return null;
      book.hooks.push(hook);
      this.touchBook(book); this.save();
      return hook;
    },
    updateHook: function (book, id, data) {
      var h = (book.hooks || []).filter(function (x) { return x.id === id; })[0];
      if (!h) return null;
      if (data.content != null) h.content = String(data.content).trim();
      if (data.fromChapter != null) h.fromChapter = Util.clampInt(data.fromChapter, 1, 99999, 0) || 0;
      if (data.planChapter != null) h.planChapter = Util.clampInt(data.planChapter, 1, 99999, 0) || 0;
      if (data.status != null) h.status = data.status;
      if (data.note != null) h.note = String(data.note).trim();
      h.updatedAt = now();
      this.touchBook(book); this.save();
      return h;
    },
    removeHook: function (book, id) {
      book.hooks = (book.hooks || []).filter(function (x) { return x.id !== id; });
      this.touchBook(book); this.save();
    },
    /* 逾期未回收的伏笔（写第 currentNo 章时，计划回收章 ≤ 当前章的 open 伏笔） */
    overdueHooks: function (book, currentNo) {
      return (book.hooks || []).filter(function (h) {
        return h.status === 'open' && h.planChapter > 0 && h.planChapter <= currentNo;
      });
    },

    /* ---------- 全局提示词 ---------- */
    getGlobalPrompt: function (id) {
      return this.state.globalPrompts.filter(function (p) { return p.id === id; })[0] || null;
    },
    upsertGlobalPrompt: function (data) {
      var p;
      if (data.id && this.getGlobalPrompt(data.id)) {
        p = this.getGlobalPrompt(data.id);
        p.title = data.title; p.content = data.content;
        if (typeof data.enabled === 'boolean') p.enabled = data.enabled;
      } else {
        data.id = data.id || uid();
        if (typeof data.enabled !== 'boolean') data.enabled = true;
        this.state.globalPrompts.push(data);
        p = data;
      }
      this.save();
      return p;
    },
    removeGlobalPrompt: function (id) {
      this.state.globalPrompts = this.state.globalPrompts.filter(function (p) { return p.id !== id; });
      this.state.books.forEach(function (b) {
        b.globalPromptIds = b.globalPromptIds.filter(function (x) { return x !== id; });
      });
      this.save();
    },
    moveGlobalPrompt: function (id, dir) {
      var arr = this.state.globalPrompts;
      var i = arr.findIndex(function (p) { return p.id === id; });
      var j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      this.save();
    },

    /* ---------- 书本 ---------- */
    getBook: function (id) {
      return this.state.books.filter(function (b) { return b.id === id; })[0] || null;
    },
    createBook: function (title) {
      var b = newBook(title);
      // 默认挂载全部已启用的全局提示词
      b.globalPromptIds = this.state.globalPrompts.filter(function (p) { return p.enabled; }).map(function (p) { return p.id; });
      this.state.books.unshift(b);
      this.save();
      return b;
    },
    deleteBook: function (id) {
      this.state.books = this.state.books.filter(function (b) { return b.id !== id; });
      this.save();
    },
    touchBook: function (book) { book.updatedAt = now(); },

    /* ---------- 世界书条目 ----------
     * scope：'' / 不传 = 全局设定；传入分卷 id = 只对该分卷的章节生效
     * extra（可选）：{ keywords, pin, state, location, goal, knows, relations }
     *   keywords：别名 / 触发词（逗号或换行分隔）。**填了**才按命中注入（省 token）；
     *     不填 = 始终注入（老行为，兼容旧数据）。pin = 常驻（即使有关键词也始终注入）。
     *   state/location/goal/knows/relations：角色卡结构化字段（人物栏专用，注入时附加在内容后）。
     */
    addWorldEntry: function (book, cat, name, content, scope, extra) {
      extra = extra || {};
      var e = { id: uid(), name: name || '', content: content || '', enabled: true, updatedAt: now() };
      if (scope) e.scope = scope;
      if (extra.keywords) e.keywords = String(extra.keywords);
      if (extra.pin) e.pin = true;
      if (cat === 'characters') {
        ['state', 'location', 'goal', 'knows', 'relations'].forEach(function (k) {
          if (extra[k]) e[k] = String(extra[k]);
        });
      }
      book.world[cat].push(e);
      this.touchBook(book); this.save();
      return e;
    },
    getWorldEntry: function (book, cat, id) {
      return (book.world[cat] || []).filter(function (e) { return e.id === id; })[0] || null;
    },
    removeWorldEntry: function (book, cat, id) {
      book.world[cat] = book.world[cat].filter(function (e) { return e.id !== id; });
      this.touchBook(book); this.save();
    },
    /* 生成某卷章节时实际注入的设定池：全局条目 + 该分卷专属条目。
     * volumeId 为空（如记忆预览）时只取全局。 */
    worldForChapter: function (book, volumeId) {
      var out = {};
      WORLD_CATS.forEach(function (cat) {
        out[cat] = (book.world[cat] || []).filter(function (e) {
          return !e.scope || e.scope === volumeId;
        });
      });
      return out;
    },
    /* 全部条目（含各分卷专属），供浏览 / 搜索使用 */
    allWorldEntries: function (book) {
      var out = {};
      WORLD_CATS.forEach(function (cat) { out[cat] = (book.world[cat] || []).slice(); });
      return out;
    },
    /* 条目所属范围的中文描述（界面标签用） */
    worldScopeLabel: function (book, scope) {
      if (!scope) return '全局';
      var v = this.getVolume(book, scope);
      if (!v) return '全局';
      var i = this.volumeIndex(book, scope);
      return '第' + (i >= 0 ? i + 1 : '?') + '卷';
    },

    /* ---------- AI 推荐设定（待转正） ----------
     * 生成记忆时 AI 顺手给出的新设定，不直接写入世界书：
     * 先存进 book.worldSug，由用户在「世界设定」页挑选转正或忽略。
     */
    addWorldSuggestions: function (book, items, chapter) {
      var self = this;
      if (!Array.isArray(book.worldSug)) book.worldSug = [];
      var ids = [];
      (items || []).forEach(function (it) {
        if (!it) return;
        var cat = WORLD_CATS.indexOf(it.cat) >= 0 ? it.cat : 'concepts';
        var name = String(it.name || '').trim();
        var content = String(it.content || '').trim();
        var kind = String(it.kind || 'add');
        var targetId = String(it.targetId || '');
        if (kind === 'update') {
          /* 修改型：必须指向一条仍然存在的设定，否则无从落地 */
          if (!self.findWorldEntry(book, targetId)) return;
          // 同一条设定只留一条待办，后来的覆盖先前的
          book.worldSug = book.worldSug.filter(function (s) { return s.targetId !== targetId; });
          var idx2 = chapter ? self.chapterIndex(book, chapter.id) : -1;
          var u = {
            id: uid(),
            kind: 'update', cat: cat, name: name,
            content: content,
            targetId: targetId,
            prevContent: String(it.prevContent || ''),
            reason: String(it.reason || '').trim(),
            keywords: String(it.keywords || '').trim(),
            chapterId: chapter ? chapter.id : '',
            chapterIndex: idx2,
            chapterTitle: chapter ? (chapter.title || '') : '',
            createdAt: now()
          };
          book.worldSug.push(u);
          ids.push(u.id);
          return;
        }
        if (!name && !content) return;
        // 已有同名条目 / 已在待转正列表里 → 跳过
        var has = (book.world[cat] || []).some(function (e) {
          return name && e.name && e.name.trim() === name;
        });
        if (has) return;
        var dup = book.worldSug.some(function (s) {
          return s.cat === cat && name && s.name && s.name.trim() === name;
        });
        if (dup) return;
        var idx = chapter ? self.chapterIndex(book, chapter.id) : -1;
        var s = {
          id: uid(),
          kind: 'add',
          cat: cat, name: name, content: content,
          keywords: String(it.keywords || '').trim(),
          reason: String(it.reason || '').trim(),
          chapterId: chapter ? chapter.id : '',
          // 章节已被删除时 chapterIndex 为 -1，界面会显示「来自第0章」，这里归一化为 -1 并让界面自己处理
          chapterIndex: idx,
          chapterTitle: chapter ? (chapter.title || '') : '',
          createdAt: now()
        };
        book.worldSug.push(s);
        ids.push(s.id);
      });
      if (ids.length) { this.touchBook(book); this.save(); }
      return ids;
    },
    /* 按 id 找一条已有设定（跨全部分栏与作用域） */
    findWorldEntry: function (book, id) {
      if (!id || !book || !book.world) return null;
      var found = null;
      WORLD_CATS.forEach(function (cat) {
        if (found) return;
        (book.world[cat] || []).forEach(function (e) {
          if (!found && e.id === id) found = e;
        });
      });
      return found;
    },
    getWorldSuggestion: function (book, id) {
      return (book.worldSug || []).filter(function (s) { return s.id === id; })[0] || null;
    },
    /* 转正：写进对应分栏（同名条目追加合并），并从待办里移除。
     * scope 为分卷 id 时写入该分卷专属设定。 */
    acceptWorldSuggestion: function (book, id, data, scope) {
      var s = this.getWorldSuggestion(book, id);
      if (!s) return null;
      /* 修改型：写回原条目。传了 data.content 就用它，否则用建议里整理好的内容。 */
      if (s.kind === 'update') {
        var target = this.findWorldEntry(book, s.targetId);
        if (!target) { this.dismissWorldSuggestions(book, id); return null; }
        var nc = data && data.content != null ? String(data.content) : s.content;
        if (nc.trim()) {
          target.content = nc;
          if (data && data.name != null) target.name = String(data.name);
          target.enabled = true; target.updatedAt = now();
        }
        book.worldSug = book.worldSug.filter(function (x) { return x.id !== id; });
        this.touchBook(book); this.save();
        return true;
      }
      var cat = (data && data.cat && WORLD_CATS.indexOf(data.cat) >= 0) ? data.cat : s.cat;
      var name = data && data.name != null ? String(data.name) : s.name;
      var content = data && data.content != null ? String(data.content) : s.content;
      var exist = (book.world[cat] || []).filter(function (e) {
        return name && e.name && e.name.trim() === name.trim() &&
          (!scope ? !e.scope : e.scope === scope);
      })[0];
      if (exist) {
        exist.content = exist.content ? exist.content + '\n' + content : content;
        exist.enabled = true; exist.updatedAt = now();
      } else {
        this.addWorldEntry(book, cat, name, content, scope);
      }
      book.worldSug = book.worldSug.filter(function (x) { return x.id !== id; });
      this.touchBook(book); this.save();
      return true;
    },
    /* 忽略：直接从待办里移除 */
    dismissWorldSuggestions: function (book, ids) {
      var list = Array.isArray(ids) ? ids : [ids];
      book.worldSug = (book.worldSug || []).filter(function (s) { return list.indexOf(s.id) < 0; });
      this.touchBook(book); this.save();
    },
    clearWorldSuggestions: function (book) {
      book.worldSug = [];
      this.touchBook(book); this.save();
    },

    /* =========================================================
     * AI 小编：对话 + 结构化改动提案
     * 小编**不直接写库**：它把改动写成提案，由界面确认后才落地。
     * 落地时记一条事务（before 快照），所以随时能整批退回。
     * ========================================================= */

    /* 小编能做的操作。risk 只影响界面上的提示语气，真正的闸门是「必须人工勾选」。 */
    EDITOR_OPS: {
      'world.add': { label: '新增设定', risk: 'low' },
      'world.update': { label: '修改设定', risk: 'low' },
      'world.del': { label: '删除设定', risk: 'high' },
      'hook.add': { label: '新增伏笔', risk: 'low' },
      'hook.update': { label: '修改伏笔', risk: 'low' },
      'chapter.outline': { label: '修改章节大纲', risk: 'low' },
      'volume.update': { label: '修改分卷大纲', risk: 'low' }
    },

    /* 按名称在全书设定里找条目：返回候选（>1 说明名字有歧义，要人来选） */
    findWorldByName: function (book, name) {
      var want = String(name || '').trim();
      if (!want) return [];
      var out = [];
      WORLD_CATS.forEach(function (cat) {
        ((book.world && book.world[cat]) || []).forEach(function (e) {
          if (String(e.name || '').trim() === want) out.push({ cat: cat, entry: e });
        });
      });
      return out;
    },

    /* 把模型给的原始 action 解析成「可预览、可执行」的提案。
     * 不做任何写入——这一步只负责说清楚「要改什么」，以及**能不能确定改哪儿**。
     * 定位不到或名字有歧义的标 unlocated，界面让用户自己处理，绝不猜着改。 */
    resolveEditorAction: function (book, act) {
      var op = String((act && act.op) || '').trim();
      var def = this.EDITOR_OPS[op];
      var out = {
        op: op, label: def ? def.label : op, risk: def ? def.risk : 'low',
        raw: act, ok: false, kind: 'update', idx: act && act.__idx,
        title: '', before: '', after: '', reason: '', target: null,
        /* 界面上「修改这条」要编辑什么：text = 直接编辑 content；
         * kv = 逐行写「键=值」（有多个字段可改时用）。 */
        editKind: '', editValue: '', editHint: ''
      };
      if (!def) { out.reason = '不认识的指令：' + (op || '(空)'); return out; }

      if (op === 'world.add') {
        var name = String(act.name || '').trim();
        var content = String(act.content || '').trim();
        var cat = String(act.cat || '').trim();
        if (WORLD_CATS.indexOf(cat) < 0) cat = 'concepts';
        if (!name && !content) { out.reason = '内容为空'; return out; }
        var dup = this.findWorldByName(book, name);
        out.kind = 'create';
        out.title = (WORLD_LABELS[cat] || cat) + ' · ' + (name || '(未命名)');
        out.before = '（新增）';
        out.after = content;
        out.target = { coll: 'book.world.' + cat, cat: cat, name: name, content: content };
        out.ok = true;
        out.editKind = 'text';
        out.editValue = content;
        out.editHint = '编辑这一条要写进世界书的内容';
        if (dup.length) out.warn = '已有同名条目，应用后会变成两条';
        return out;
      }

      if (op === 'world.update' || op === 'world.del') {
        var hits = this.findWorldByName(book, act.name);
        out.kind = op === 'world.del' ? 'remove' : 'update';
        out.title = '设定 · ' + (String(act.name || '').trim() || '(未填名称)');
        if (!hits.length) { out.reason = '世界书里找不到叫「' + act.name + '」的条目'; return out; }
        if (hits.length > 1) {
          out.reason = '有 ' + hits.length + ' 条同名（' + hits.map(function (h) { return WORLD_LABELS[h.cat]; }).join('、') + '），无法确定改哪条';
          return out;
        }
        var e = hits[0].entry;
        out.before = e.content || '';
        out.after = op === 'world.del' ? '（删除）' : String(act.content || '').trim();
        out.target = { coll: 'book.world.' + hits[0].cat, cat: hits[0].cat, id: e.id, name: e.name, content: out.after };
        if (op === 'world.update' && !out.after) { out.reason = '新内容为空'; return out; }
        out.ok = true;
        if (op === 'world.update') {
          out.editKind = 'text';
          out.editValue = out.after;
          out.editHint = '编辑这条设定改后的完整内容';
        }
        return out;
      }

      if (op === 'hook.add' || op === 'hook.update') {
        var hc = String(act.content || '').trim();
        out.title = '伏笔 · ' + (hc || '(未命名)');
        if (op === 'hook.add') {
          if (!hc) { out.reason = '内容为空'; return out; }
          out.kind = 'create';
          out.before = '（新增）';
          out.after = hc;
          out.target = {
            coll: 'book.hooks', content: hc,
            fromChapter: act.fromChapter, planChapter: act.planChapter, note: act.note
          };
          if (act.fromChapter || act.planChapter) {
            out.after += '（' + (act.fromChapter ? '第' + act.fromChapter + '章埋' : '') +
              (act.fromChapter && act.planChapter ? '，' : '') +
              (act.planChapter ? '计划第' + act.planChapter + '章回收' : '') + '）';
          }
          out.ok = true;
          out.editKind = 'text';
          out.editValue = hc;
          out.editHint = '编辑这条伏笔的内容';
          return out;
        }
        var hs = (book.hooks || []).filter(function (h) { return String(h.content || '').trim() === hc; });
        if (!hs.length) { out.reason = '伏笔板里找不到这条'; return out; }
        if (hs.length > 1) { out.reason = '有 ' + hs.length + ' 条一样的伏笔'; return out; }
        var h0 = hs[0];
        out.before = '状态 ' + h0.status + (h0.planChapter ? '，计划第' + h0.planChapter + '章回收' : '');
        var bits = [];
        if (act.status) bits.push('状态改为 ' + String(act.status));
        if (act.planChapter) bits.push('计划回收改为第' + act.planChapter + '章');
        if (act.note != null) bits.push('备注：' + String(act.note));
        out.after = bits.length ? bits.join('；') : '（没有给出要改什么）';
        if (!bits.length) { out.reason = '没有给出要改什么'; return out; }
        out.kind = 'update';
        out.target = { coll: 'book.hooks', id: h0.id, status: act.status, planChapter: act.planChapter, note: act.note };
        out.ok = true;
        out.editKind = 'kv';
        out.editValue = '回收=' + (act.planChapter || h0.planChapter || '') + '\n' +
          '状态=' + (act.status || h0.status || 'open') + '\n' +
          '备注=' + (act.note != null ? act.note : (h0.note || ''));
        out.editHint = '每行写一项：回收=章号 / 状态=open|resolved|dropped / 备注=…';
        return out;
      }

      if (op === 'chapter.outline') {
        var n = parseInt(act.chapter, 10);
        out.title = '章节 · 第' + (n || '?') + '章';
        if (!n || n < 1 || n > book.chapters.length) {
          out.reason = '章号超出范围（本书共 ' + book.chapters.length + ' 章）';
          return out;
        }
        var ch = book.chapters[n - 1];
        out.before = (ch.title ? '标题：' + ch.title + '\n' : '') + '大纲：' + (ch.outline || '（空）');
        var nTitle = act.title != null ? String(act.title).trim() : null;
        var nOutline = act.outline != null ? String(act.outline).trim() : null;
        if (!nTitle && !nOutline) { out.reason = '标题与大纲都没给'; return out; }
        out.after = (nTitle ? '标题：' + nTitle + '\n' : '') + (nOutline ? '大纲：' + nOutline : '');
        out.target = { coll: 'book.chapters', id: ch.id, title: nTitle, outline: nOutline };
        out.ok = true;
        out.editKind = 'kv';
        out.editValue = '标题=' + (nTitle || ch.title || '') + '\n大纲=' + (nOutline || ch.outline || '');
        out.editHint = '每行写一项：标题=… / 大纲=…';
        return out;
      }

      if (op === 'volume.update') {
        var vn = parseInt(act.volume, 10);
        out.title = '分卷 · 第' + (vn || '?') + '卷';
        if (!vn || vn < 1 || vn > book.volumes.length) {
          out.reason = '卷号超出范围（本书共 ' + book.volumes.length + ' 卷）';
          return out;
        }
        var vol = book.volumes[vn - 1];
        out.before = (vol.title ? '标题：' + vol.title + '\n' : '') + '大纲：' + (vol.summary || '（空）');
        var vTitle = act.title != null ? String(act.title).trim() : null;
        var vSum = act.summary != null ? String(act.summary).trim() : null;
        if (!vTitle && !vSum) { out.reason = '标题与大纲都没给'; return out; }
        out.after = (vTitle ? '标题：' + vTitle + '\n' : '') + (vSum ? '大纲：' + vSum : '');
        out.target = { coll: 'book.volumes', id: vol.id, title: vTitle, summary: vSum };
        out.ok = true;
        out.editKind = 'kv';
        out.editValue = '标题=' + (vTitle || vol.title || '') + '\n大纲=' + (vSum || vol.summary || '');
        out.editHint = '每行写一项：标题=… / 大纲=…';
        return out;
      }

      out.reason = '暂不支持的指令：' + op;
      return out;
    },

    /* 批量解析（界面用）。带上 __idx，界面靠它把每条提案的按钮对回原始 action。 */
    resolveEditorActions: function (book, acts) {
      var self = this;
      return (acts || []).map(function (a, i) {
        if (a) a.__idx = i;    // 忽略过某几条之后索引会变，每次都以当前顺序为准
        return self.resolveEditorAction(book, a);
      });
    },

    /* 作者在界面上改了一条建议后，把编辑内容写回 action 对象。
     * text 类：整段替换 content；kv 类：逐行「键=值」回写到对应字段。 */
    applyEditorEdit: function (act, text) {
      if (!act) return false;
      var t = String(text == null ? '' : text).trim();
      if (!t) return false;
      if (act.op !== 'hook.update' && act.op !== 'chapter.outline' && act.op !== 'volume.update') {
        act.content = t;
        return true;
      }
      var kv = {}, loose = [];
      t.split('\n').forEach(function (ln) {
        var i = ln.indexOf('=');
        if (i > 0) kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
        else if (ln.trim()) loose.push(ln.trim());
      });
      var hasKv = Object.keys(kv).length > 0;
      if (!hasKv) { kv = { '大纲': t.replace(/\s+/g, ' ').trim() }; }
      function get() {
        for (var i = 0; i < arguments.length; i++) if (kv[arguments[i]] != null) return kv[arguments[i]];
        return null;
      }
      if (act.op === 'hook.update') {
        var st = get('状态', 'status'); if (st) act.status = st;
        var pl = get('回收', '回收章', 'plan'); if (pl) act.planChapter = pl;
        var nt = get('备注', 'note'); if (nt != null) act.note = nt;
        return true;
      }
      var ti = get('标题', 'title'); if (ti) act.title = ti;
      var bo = get('大纲', '简介', 'outline', 'summary');
      if (bo == null && loose.length) bo = loose.join(' ');
      if (bo != null) {
        if (act.op === 'chapter.outline') act.outline = bo;
        else act.summary = bo;
      }
      return true;
    },

    /* 落地一批提案，并记一条可撤销的事务。
     * 只应用 ok 的；每条都存 before 快照——这是「随时能退回去」的唯一依据。 */
    applyEditorActions: function (book, props, label) {
      if (!Array.isArray(book.txns)) book.txns = [];
      var changes = [];
      var self = this;
      var n = 0;
      props.forEach(function (p) {
        if (!p || !p.ok || !p.target) return;
        var t = p.target, coll = t.coll;
        var arr = self._collArr(book, coll);
        if (!arr) return;
        if (p.kind === 'create') {
          var item;
          if (coll === 'book.hooks') {
            item = self.addHook(book, {
              content: t.content, fromChapter: t.fromChapter,
              planChapter: t.planChapter, note: t.note
            });
            if (!item) return;
          } else {
            item = self.addWorldEntry(book, t.cat, t.name, t.content);
          }
          changes.push({ coll: coll, id: item.id, index: arr.length - 1, before: null, after: JSON.parse(JSON.stringify(item)) });
          n++;
          return;
        }
        var i = arr.findIndex(function (x) { return x.id === t.id; });
        if (i < 0) return;
        var before = JSON.parse(JSON.stringify(arr[i]));
        var after = JSON.parse(JSON.stringify(arr[i]));
        if (p.kind === 'remove') {
          arr.splice(i, 1);
          changes.push({ coll: coll, id: t.id, index: i, before: before, after: null });
          n++;
          return;
        }
        if (t.content != null && t.content !== '') {
          after.content = t.content;
          // 设定条目改名时同步改 name
          if (coll.indexOf('book.world.') === 0 && t.name) after.name = t.name;
        }
        if (t.title != null && t.title !== '') after.title = t.title;
        if (t.outline != null && t.outline !== '') after.outline = t.outline;
        if (t.summary != null && t.summary !== '') after.summary = t.summary;
        if (t.status) after.status = t.status;
        if (t.planChapter) after.planChapter = parseInt(t.planChapter, 10);
        if (t.note != null) after.note = String(t.note);
        after.updatedAt = now();
        arr[i] = after;
        changes.push({ coll: coll, id: t.id, index: i, before: before, after: JSON.parse(JSON.stringify(after)) });
        n++;
      });
      if (!n) return null;
      var txn = { id: uid(), at: now(), label: label || '小编的改动', changes: changes };
      book.txns.push(txn);
      if (book.txns.length > 20) book.txns = book.txns.slice(-20);
      this.touchBook(book); this.save();
      return txn;
    },

    _collArr: function (book, coll) {
      if (coll && coll.indexOf('book.world.') === 0) {
        var cat = coll.slice('book.world.'.length);
        if (!book.world || !Array.isArray(book.world[cat])) return null;
        return book.world[cat];
      }
      if (coll === 'book.hooks') return book.hooks || (book.hooks = []);
      if (coll === 'book.chapters') return book.chapters;
      if (coll === 'book.volumes') return book.volumes;
      return null;
    },

    /* 撤销一条事务：按 before 快照倒着还原。before 为 null = 这条是新增，删掉即可。 */
    undoTxn: function (book, txnId) {
      var i = (book.txns || []).findIndex(function (t) { return t.id === txnId; });
      if (i < 0) return false;
      var txn = book.txns[i];
      var self = this;
      for (var k = txn.changes.length - 1; k >= 0; k--) {
        var c = txn.changes[k];
        var arr = self._collArr(book, c.coll);
        if (!arr) continue;
        var at = arr.findIndex(function (x) { return x.id === c.id; });
        if (c.before === null) {
          if (at >= 0) arr.splice(at, 1);            // 新增的，撤掉
        } else if (at >= 0) {
          arr[at] = c.before;                        // 改过的，还原
        } else {
          var idx = Math.max(0, Math.min(c.index == null ? arr.length : c.index, arr.length));
          arr.splice(idx, 0, c.before);              // 删掉的，插回原位置
        }
      }
      book.txns.splice(i, 1);
      this.touchBook(book); this.save();
      return true;
    },

    /* ---------- 小编对话记录 ---------- */
    addChat: function (book, msg) {
      if (!Array.isArray(book.chat)) book.chat = [];
      var m = {
        id: uid(), role: msg.role === 'user' ? 'user' : 'ai',
        text: String(msg.text == null ? '' : msg.text),
        actions: Array.isArray(msg.actions) ? msg.actions : [],
        ctx: msg.ctx || '',
        createdAt: now()
      };
      book.chat.push(m);
      // 聊天记录跟着书存本地，长篇下别让它无限涨
      if (book.chat.length > 60) book.chat = book.chat.slice(-60);
      this.touchBook(book); this.save();
      return m;
    },
    clearChat: function (book) {
      book.chat = [];
      this.touchBook(book); this.save();
    },
    updateChatActions: function (book, msgId, actions) {
      var m = (book.chat || []).filter(function (x) { return x.id === msgId; })[0];
      if (!m) return null;
      m.actions = actions;
      this.touchBook(book); this.save();
      return m;
    },

    /* ---------- 分卷 ---------- */
    addVolume: function (book, title, summary) {
      var v = { id: uid(), title: title || '', summary: summary || '' };
      book.volumes.push(v);
      this.touchBook(book); this.save();
      return v;
    },
    getVolume: function (book, id) {
      return book.volumes.filter(function (v) { return v.id === id; })[0] || null;
    },
    /* 删除分卷。
     * 设计上「每章必属于某个分卷」，所以这里**绝不把章节的 volumeId 置空**——
     * 那正是孤儿章节的唯一来源。若该卷下还有章节且还有别的卷，
     * 统一把它们并入剩余的第一个分卷；调用方（app.js）已在删除前询问过用户。
     */
    removeVolume: function (book, id) {
      book.volumes = book.volumes.filter(function (v) { return v.id !== id; });
      var fallback = book.volumes.length ? book.volumes[0].id : '';
      book.chapters.forEach(function (c) { if (c.volumeId === id) c.volumeId = fallback; });
      this.touchBook(book); this.save();
    },
    /* 该卷在 book.volumes 里的真实序号（0 基），找不到返回 -1 */
    volumeIndex: function (book, id) {
      return book.volumes.findIndex(function (v) { return v.id === id; });
    },

    /* ---------- 章节 ---------- */
    addChapter: function (book, data) {
      var c = {
        id: uid(),
        title: (data && data.title) || '',
        outline: (data && data.outline) || '',
        content: (data && data.content) || '',
        volumeId: (data && data.volumeId) || '',
        marks: [],                    // 划线标记：{id, start, end, anchor, note}
        createdAt: now(),
        updatedAt: now()
      };
      book.chapters.push(c);
      this.touchBook(book); this.save();
      return c;
    },
    getChapter: function (book, id) {
      return book.chapters.filter(function (c) { return c.id === id; })[0] || null;
    },
    chapterIndex: function (book, id) {
      return book.chapters.findIndex(function (c) { return c.id === id; });
    },
    removeChapter: function (book, id) {
      var i = this.chapterIndex(book, id);
      if (i < 0) return;
      book.chapters.splice(i, 1);
      book.memory.entries = book.memory.entries.filter(function (m) { return m.chapterId !== id; });
      book.undoStack = book.undoStack.filter(function (u) { return u.chapterId !== id; });
      if (book.lastChapterId === id) { book.lastChapterId = ''; book.lastReadAt = 0; }
      this.touchBook(book); this.save();
    },
    /* 记录“最近阅读 / 编辑的章节”（只更新指针，不动 updatedAt） */
    touchChapter: function (book, chapter) {
      if (!book || !chapter) return;
      if (book.lastChapterId === chapter.id) { book.lastReadAt = now(); return; }
      book.lastChapterId = chapter.id;
      book.lastReadAt = now();
      this.saveSoon();
    },
    /* 取这本书最近阅读的章节；没有记录时回落到第一章 */
    lastChapter: function (book) {
      if (!book || !book.chapters.length) return null;
      if (book.lastChapterId) {
        var c = this.getChapter(book, book.lastChapterId);
        if (c) return c;
      }
      return book.chapters[0];
    },
    moveChapter: function (book, id, dir) {
      var i = this.chapterIndex(book, id), j = i + dir;
      if (i < 0 || j < 0 || j >= book.chapters.length) return false;
      var tmp = book.chapters[i]; book.chapters[i] = book.chapters[j]; book.chapters[j] = tmp;
      this.touchBook(book); this.save();
      return true;
    },
    /* 换分卷：把章节挪到目标分卷的**末尾**。
     * 注意目标卷下还没有章节时，原来的实现会 splice(0,0,c) 把它插到全书最前面，
     * 与「挪到该卷末尾」的语义相反。这里改为：找到该卷在 volumes 里的位置，
     * 插到「该卷之前所有卷的章节之后」，即该卷应有的起始位置。
     */
    moveChapterToVolume: function (book, chapterId, volumeId) {
      var i = this.chapterIndex(book, chapterId);
      if (i < 0) return false;
      if (!volumeId || !this.getVolume(book, volumeId)) return false;
      var c = book.chapters[i];
      if (c.volumeId === volumeId) return false;   // 已在该卷，无需移动

      book.chapters.splice(i, 1);

      var last = -1;
      for (var k = 0; k < book.chapters.length; k++) {
        if (book.chapters[k].volumeId === volumeId) last = k;
      }
      if (last < 0) {
        // 该卷还没有章节：插到它前面那些卷的最后一条之后
        var vi = this.volumeIndex(book, volumeId);
        var before = {};
        for (var v = 0; v < vi; v++) before[book.volumes[v].id] = 1;
        for (var m = book.chapters.length - 1; m >= 0; m--) {
          if (before[book.chapters[m].volumeId]) { last = m; break; }
        }
      }

      c.volumeId = volumeId;
      c.updatedAt = now();
      book.chapters.splice(last + 1, 0, c);
      this.touchBook(book); this.save();
      return true;
    },

    /* ---------- 正文框选标记（局部改稿） ----------
     * 标记的来源是正文里的【【】】，不是浏览器选区。chapter.marks 退化成
     * **意见簿**：只存 {anchor, note}，按框里的原文对齐。位置每次现算，
     * 所以作者随手改正文（加字、删段、换顺序）都不会让意见错位到别处。
     */

    /* 当前正文里的框 + 对齐好的意见。界面与执行都只看这个结果。 */
    bracketItems: function (chapter) {
      var items = Util.parseBracketMarks((chapter && chapter.content) || '');
      var pool = ((chapter && chapter.marks) || []).slice();
      var used = {};
      items.forEach(function (it) {
        var hit = pool.filter(function (m) {
          return !used[m.id] && String(m.anchor || '') === it.anchor;
        })[0];
        if (hit) { used[hit.id] = 1; it.note = hit.note || ''; it.noteId = hit.id; }
        else { it.note = ''; it.noteId = ''; }
      });
      return items;
    },

    /* 写某一条的意见。同一段文字被框了多次时，按出现顺序对齐（第 1 个框配第 1 条意见）。 */
    setBracketNote: function (book, chapter, idx, note) {
      var items = this.bracketItems(chapter);
      var it = items[idx];
      if (!it) return null;
      if (!Array.isArray(chapter.marks)) chapter.marks = [];
      var rank = items.filter(function (x) { return x.anchor === it.anchor; }).indexOf(it);
      var cands = chapter.marks.filter(function (m) { return String(m.anchor || '') === it.anchor; });
      var target = cands[rank];
      if (!target) {
        target = { id: uid(), anchor: it.anchor, note: '', createdAt: now() };
        chapter.marks.push(target);
      }
      target.note = String(note == null ? '' : note);
      target.updatedAt = now();
      this.touchBook(book); this.save();
      return target;
    },

    /* 清掉「已经被作者从正文里删掉的框」留下的孤儿意见 */
    pruneBracketNotes: function (book, chapter) {
      if (!chapter || !Array.isArray(chapter.marks) || !chapter.marks.length) return false;
      var quota = {};
      Util.parseBracketMarks(chapter.content || '').forEach(function (it) {
        quota[it.anchor] = (quota[it.anchor] || 0) + 1;
      });
      var seen = {}, keep = [];
      chapter.marks.forEach(function (m) {
        var a = String(m.anchor || '');
        seen[a] = (seen[a] || 0) + 1;
        if (quota[a] >= seen[a]) keep.push(m);
      });
      if (keep.length === chapter.marks.length) return false;
      chapter.marks = keep;
      this.touchBook(book); this.save();
      return true;
    },

    /* 取消全部标记：把正文里的【【】】去掉（框里的字保留），意见一并清空 */
    clearBracketMarks: function (book, chapter) {
      if (!chapter) return;
      chapter.content = Util.stripBrackets(chapter.content || '');
      chapter.marks = [];
      chapter.updatedAt = now();
      this.touchBook(book); this.save();
    },

    /* ---------- 旧的选区标记（按偏移定位，通用） ----------
     * 每条记下位置偏移 + 原文快照。原文快照是关键：正文被重新生成 / 手动改过之后，
     * 偏移会失效，靠它重新定位（且只在全文中唯一出现时才认，避免改错地方）。
     */
    addMark: function (book, chapter, start, end, note) {
      if (!chapter) return null;
      var s = String(chapter.content || '');
      start = Math.max(0, Math.min(start | 0, s.length));
      end = Math.max(0, Math.min(end | 0, s.length));
      if (end <= start) return null;
      var anchor = s.slice(start, end);
      if (!anchor.trim()) return null;              // 纯空白不值得标
      if (!Array.isArray(chapter.marks)) chapter.marks = [];
      // 与已有标记重叠的直接并入（同一处划两次没意义）
      var hit = chapter.marks.filter(function (m) {
        var p = Util.locateMark(s, m);
        return p && !(p.end <= start || p.start >= end);
      })[0];
      if (hit) {
        var hp = Util.locateMark(s, hit);
        hit.start = Math.min(hp.start, start);
        hit.end = Math.max(hp.end, end);
        hit.anchor = s.slice(hit.start, hit.end);
        if (note) hit.note = note;
        hit.updatedAt = now();
        this.touchBook(book); this.save();
        return hit;
      }
      var mk = {
        id: uid(), start: start, end: end, anchor: anchor,
        note: String(note == null ? '' : note),
        createdAt: now()
      };
      chapter.marks.push(mk);
      this.touchBook(book); this.save();
      return mk;
    },
    getMark: function (chapter, id) {
      return ((chapter && chapter.marks) || []).filter(function (m) { return m.id === id; })[0] || null;
    },
    updateMark: function (book, chapter, id, note) {
      var m = this.getMark(chapter, id);
      if (!m) return null;
      m.note = String(note == null ? '' : note);
      m.updatedAt = now();
      this.touchBook(book); this.save();
      return m;
    },
    removeMark: function (book, chapter, id) {
      if (!chapter || !Array.isArray(chapter.marks)) return false;
      var n = chapter.marks.length;
      chapter.marks = chapter.marks.filter(function (m) { return m.id !== id; });
      if (chapter.marks.length === n) return false;
      this.touchBook(book); this.save();
      return true;
    },
    clearMarks: function (book, chapter) {
      if (!chapter) return;
      chapter.marks = [];
      this.touchBook(book); this.save();
    },
    /* 能定位到当前正文的标记（定位不到的是「正文已变，这处标记失效了」） */
    liveMarks: function (chapter) {
      var s = String((chapter && chapter.content) || '');
      return ((chapter && chapter.marks) || []).map(function (m) {
        var p = Util.locateMark(s, m);
        return p ? { mark: m, start: p.start, end: p.end } : { mark: m, start: -1, end: -1 };
      });
    },

    /* ---------- 记忆 ---------- */
    /* 写入章节记忆：**同一章只保留一条**（就地更新，id 不变）。
     * 原来是每次生成都 push 一条新的，于是「重新生成」几次这章就有几份记忆——
     * 它们描述的还是同一章的不同版本，注入时互相矛盾，撤回也没法定位。
     * summaryBefore（写这一章之前的摘要快照）保留最早那次的值。 */
    addMemory: function (book, chapter, text, prevSummary) {
      if (!book.memory) book.memory = { enabled: true, summary: '', entries: [], keepRecent: 6 };
      if (!Array.isArray(book.memory.entries)) book.memory.entries = [];
      var cid = chapter ? chapter.id : '';
      var idx = chapter ? this.chapterIndex(book, chapter.id) : -1;
      var exist = cid ? book.memory.entries.filter(function (e) { return e.chapterId === cid; })[0] : null;
      if (exist) {
        exist.text = text;
        exist.chapterIndex = idx;
        exist.chapterTitle = chapter ? chapter.title : '';
        if (!exist.summaryBefore && prevSummary) exist.summaryBefore = prevSummary;
        exist.updatedAt = now();
        this.touchBook(book); this.save();
        return exist;
      }
      var e = {
        id: uid(),
        chapterId: cid,
        chapterIndex: idx,
        chapterTitle: chapter ? chapter.title : '',
        text: text,
        summaryBefore: prevSummary || '',
        createdAt: now()
      };
      book.memory.entries.push(e);
      this.touchBook(book); this.save();
      return e;
    },
    /* 本章现有的记忆条目（正规定义：一章至多一条） */
    getMemoryEntry: function (book, chapter) {
      var cid = chapter ? chapter.id : '';
      if (!cid) return null;
      return ((book.memory && book.memory.entries) || []).filter(function (e) { return e.chapterId === cid; })[0] || null;
    },
    /* 本章在长期记忆里的「前情基线」：写这一章之前那一刻的摘要。
     * 本章已有记忆条目时用它的 summaryBefore 快照回溯——
     * 直接用当前摘要会把本章上一版的剧情当成前情喂回去，重写就越改越像自己抄自己。 */
    memoryBaseline: function (book, chapter) {
      var i = chapter ? this.chapterIndex(book, chapter.id) : -1;
      var list = (book.memory && book.memory.entries) || [];
      if (i >= 0) {
        for (var k = list.length - 1; k >= 0; k--) {
          var e = list[k];
          var p = e.chapterId ? this.chapterIndex(book, e.chapterId) : -1;
          if (p < 0) p = typeof e.chapterIndex === 'number' ? e.chapterIndex : -1;
          if (p === i && e.summaryBefore) return e.summaryBefore;
        }
      }
      return (book.memory && book.memory.summary) || '';
    },
    removeMemory: function (book, entryId) {
      book.memory.entries = book.memory.entries.filter(function (e) { return e.id !== entryId; });
      this.touchBook(book); this.save();
    },

    /* ---------- 撤回栈 ----------
     * snapshot 必须在「生成之前」取，否则撤回等于没撤。
     */
    pushUndo: function (book, chapter, memoryEntryId, prevSummary, snapshot, worldSugIds, memoryBefore, kind) {
      var u = {
        id: uid(),
        chapterId: chapter.id,
        // 'write'（整章生成）/ 'patch'（只改标记处）：撤回提示语据此区分
        kind: kind || 'write',
        snapshot: snapshot || { title: chapter.title, outline: chapter.outline, content: chapter.content },
        memoryEntryId: memoryEntryId || '',
        summaryBefore: prevSummary || '',
        worldSugIds: worldSugIds || [],
        /* 重写场景：本章生成前就有的那条记忆。撤回时要**恢复它**而不是删掉，
         * 否则一次重写撤回后，这章的记忆就凭空消失了。 */
        memoryBefore: memoryBefore ? {
          id: memoryBefore.id,
          text: memoryBefore.text,
          chapterIndex: memoryBefore.chapterIndex,
          chapterTitle: memoryBefore.chapterTitle,
          summaryBefore: memoryBefore.summaryBefore
        } : null,
        createdAt: now()
      };
      book.undoStack.push(u);
      /* 撤回快照里存着整章旧正文，长篇下 30 条会吃掉可观的空间；保留最近 10 条足够日常反悔 */
      if (book.undoStack.length > 10) book.undoStack.shift();
      this.touchBook(book); this.save();
      return u;
    },
    /* 弹出指定的一条（生成彻底失败时用来清理刚压进去的空快照） */
    dropUndo: function (book, id) {
      var before = book.undoStack.length;
      book.undoStack = book.undoStack.filter(function (u) { return u.id !== id; });
      if (book.undoStack.length !== before) this.save();
    },
    popUndo: function (book) {
      var u = book.undoStack.pop();
      return u || null;
    },

    /* ---------- 导入导出 ---------- */
    exportBook: function (id) {
      var b = this.getBook(id);
      return b ? JSON.stringify(b, null, 2) : '';
    },
    importBook: function (json) {
      var b;
      try { b = JSON.parse(json); } catch (e) { throw new Error('不是合法的 JSON 文件'); }
      // 校验必要结构，避免把任意 JSON 塞进书架后变成删不掉的坏数据
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('文件格式不正确：期望一个书本对象');
      if (typeof b.title !== 'string' || !b.title.trim()) throw new Error('文件格式不正确：缺少书名');
      if (b.chapters != null && !Array.isArray(b.chapters)) throw new Error('文件格式不正确：chapters 必须是数组');
      if (b.volumes != null && !Array.isArray(b.volumes)) throw new Error('文件格式不正确：volumes 必须是数组');

      b.id = uid();
      b.createdAt = now(); b.updatedAt = now();
      this.state.books.unshift(b);
      this.migrate();
      this.save();
      return b;
    },
    exportAll: function () { return JSON.stringify(this.state, null, 2); },
    importAll: function (json) {
      var s;
      try { s = JSON.parse(json); } catch (e) { throw new Error('不是合法的 JSON 文件'); }
      if (!looksLikeState(s)) throw new Error('文件格式不正确：缺少 books 数组');
      if (!Array.isArray(s.providers)) s.providers = [];
      if (!Array.isArray(s.globalPrompts)) s.globalPrompts = [];
      this.state = s;
      this.migrate();
      this.save();
    },
    resetAll: function () {
      this.state = defaultState();
      this.save();
    }
  };

  global.Store = Store;
})(window);
