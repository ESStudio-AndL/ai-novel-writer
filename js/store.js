/* =========================================================
 * Store —— 本地数据层（localStorage）
 * 所有数据仅保存在本机浏览器 / WebView 中，不会上传。
 * ========================================================= */
(function (global) {
  'use strict';

  var KEY = 'novel_ai_db_v1';
  var KEY_BAK = 'novel_ai_db_v1_bak';

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function now() { return Date.now(); }

  var WORLD_CATS = ['background', 'characters', 'locations', 'concepts', 'factions'];

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
      vars: ['bookInfo', 'world', 'outline', 'memory', 'prevTail', 'chapterHeading', 'chapterNo', 'chapterTitle', 'chapterOutline', 'targetWords'],
      content: '{{bookInfo}}\n\n{{world}}\n\n{{outline}}\n\n{{memory}}\n\n{{prevTail}}\n\n' +
        '【本章任务】\n' +
        '{{chapterHeading}}\n' +
        '章节大纲：{{chapterOutline}}\n\n' +
        '请写出本章完整正文，目标约 {{targetWords}} 字。'
    },
    memoryBlock: {
      name: '记忆注入块',
      desc: '写下一章时，把长期记忆与近期章节记忆带上的格式。',
      vars: ['longSummary', 'recentEntries', 'keepRecent'],
      content: '【前情记忆】\n' +
        '长期记忆摘要（此前全部剧情的压缩记录）：\n{{longSummary}}\n\n' +
        '近期章节记忆（最多 {{keepRecent}} 条）：\n{{recentEntries}}'
    },
    outlineSplit: {
      name: '分卷自动分章',
      desc: '把一个分卷拆成 N 章大纲时使用的提示词。',
      vars: ['bookInfo', 'world', 'volumes', 'volume', 'recentChapters', 'count'],
      content: '{{bookInfo}}\n\n{{world}}\n\n' +
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
      ui: { fontSize: 17, lineHeight: 1.85, theme: 'dark' },
      providers: [defaultProvider()],
      activeProviderId: null,
      promptTemplates: defaultTemplates(),
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
      lastChapterId: '',            // 最近阅读 / 编辑的章节（底部「最近」页据此定位）
      lastReadAt: 0,
      memory: {
        enabled: true,
        summary: '',
        keepRecent: 6,
        suggestWorld: true,         // 生成记忆时顺带让 AI 推荐新设定条目
        entries: []                 // {id, chapterId, chapterIndex, chapterTitle, text, summaryBefore, createdAt}
      },
      worldSug: [],                 // AI 推荐但尚未转正的设定 {id, cat, name, content, chapterId...}
      undoStack: []                 // {id, chapterId, snapshot, memoryEntryId, summaryBefore, worldSugIds, createdAt}
    };
  }

  var Store = {
    state: null,

    init: function () {
      var raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) { }
      if (raw) {
        try {
          this.state = JSON.parse(raw);
        } catch (e) {
          try { this.state = JSON.parse(localStorage.getItem(KEY_BAK) || 'null'); } catch (e2) { }
        }
      }
      if (!this.state || typeof this.state !== 'object') this.state = defaultState();
      this.migrate();
      if (!this.state.activeProviderId && this.state.providers.length) {
        this.state.activeProviderId = this.state.providers[0].id;
      }
      return this.state;
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
        b.memory = b.memory || { enabled: true, summary: '', entries: [], keepRecent: 6 };
        b.memory.entries = b.memory.entries || [];
        if (typeof b.memory.suggestWorld !== 'boolean') b.memory.suggestWorld = true;
        b.undoStack = b.undoStack || [];

        // 父子结构：每一章都必须属于某个分卷（历史数据自动归位）
        if (!b.volumes.length && b.chapters.length) {
          b.volumes.push({ id: uid(), title: '第一卷', summary: '' });
        }
        var fallbackId = b.volumes.length ? b.volumes[0].id : '';
        b.chapters.forEach(function (c) {
          var inVolume = b.volumes.some(function (v) { return v.id === c.volumeId; });
          if (!inVolume) c.volumeId = fallbackId;
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
      try {
        var cur = localStorage.getItem(KEY);
        if (cur) { try { localStorage.setItem(KEY_BAK, cur); } catch (e) { } }
        localStorage.setItem(KEY, JSON.stringify(this.state));
      } catch (e) {
        if (global.UI && UI.toast) UI.toast('保存失败：本地存储空间可能已满');
        console.error(e);
      }
    },

    /* 防抖保存：翻页等高频操作避免反复写 localStorage */
    saveSoon: function () {
      var self = this;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () { self.save(); }, 500);
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
      this.save();
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

    /* ---------- 世界书条目 ---------- */
    addWorldEntry: function (book, cat, name, content) {
      var e = { id: uid(), name: name || '', content: content || '', enabled: true, updatedAt: now() };
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
        var s = {
          id: uid(),
          cat: cat, name: name, content: content,
          chapterId: chapter ? chapter.id : '',
          chapterIndex: chapter ? self.chapterIndex(book, chapter.id) : -1,
          chapterTitle: chapter ? (chapter.title || '') : '',
          createdAt: now()
        };
        book.worldSug.push(s);
        ids.push(s.id);
      });
      if (ids.length) { this.touchBook(book); this.save(); }
      return ids;
    },
    getWorldSuggestion: function (book, id) {
      return (book.worldSug || []).filter(function (s) { return s.id === id; })[0] || null;
    },
    /* 转正：写进对应分栏（同名条目追加合并），并从待办里移除 */
    acceptWorldSuggestion: function (book, id, data) {
      var s = this.getWorldSuggestion(book, id);
      if (!s) return null;
      var cat = (data && data.cat && WORLD_CATS.indexOf(data.cat) >= 0) ? data.cat : s.cat;
      var name = data && data.name != null ? String(data.name) : s.name;
      var content = data && data.content != null ? String(data.content) : s.content;
      var exist = (book.world[cat] || []).filter(function (e) {
        return name && e.name && e.name.trim() === name.trim();
      })[0];
      if (exist) {
        exist.content = exist.content ? exist.content + '\n' + content : content;
        exist.enabled = true; exist.updatedAt = now();
      } else {
        this.addWorldEntry(book, cat, name, content);
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
    removeVolume: function (book, id) {
      book.volumes = book.volumes.filter(function (v) { return v.id !== id; });
      book.chapters.forEach(function (c) { if (c.volumeId === id) c.volumeId = ''; });
      this.touchBook(book); this.save();
    },

    /* ---------- 章节 ---------- */
    addChapter: function (book, data) {
      var c = {
        id: uid(),
        title: (data && data.title) || '',
        outline: (data && data.outline) || '',
        content: (data && data.content) || '',
        volumeId: (data && data.volumeId) || '',
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
    /* 换分卷：把章节挪到目标分卷的末尾（章节数组按分卷顺序排列） */
    moveChapterToVolume: function (book, chapterId, volumeId) {
      var i = this.chapterIndex(book, chapterId);
      if (i < 0) return false;
      if (!volumeId || !this.getVolume(book, volumeId)) return false;
      var c = book.chapters[i];
      book.chapters.splice(i, 1);
      var last = -1;
      for (var k = 0; k < book.chapters.length; k++) {
        if (book.chapters[k].volumeId === volumeId) last = k;
      }
      c.volumeId = volumeId;
      c.updatedAt = now();
      book.chapters.splice(last + 1, 0, c);
      this.touchBook(book); this.save();
      return true;
    },

    /* ---------- 记忆 ---------- */
    addMemory: function (book, chapter, text, prevSummary) {
      var e = {
        id: uid(),
        chapterId: chapter ? chapter.id : '',
        chapterIndex: chapter ? this.chapterIndex(book, chapter.id) : -1,
        chapterTitle: chapter ? chapter.title : '',
        text: text,
        summaryBefore: prevSummary || '',
        createdAt: now()
      };
      book.memory.entries.push(e);
      this.touchBook(book); this.save();
      return e;
    },
    removeMemory: function (book, entryId) {
      book.memory.entries = book.memory.entries.filter(function (e) { return e.id !== entryId; });
      this.touchBook(book); this.save();
    },

    /* ---------- 撤回栈 ----------
     * snapshot 必须在“生成之前”取，否则撤回等于没撤。
     */
    pushUndo: function (book, chapter, memoryEntryId, prevSummary, snapshot, worldSugIds) {
      book.undoStack.push({
        id: uid(),
        chapterId: chapter.id,
        snapshot: snapshot || { title: chapter.title, outline: chapter.outline, content: chapter.content },
        memoryEntryId: memoryEntryId || '',
        summaryBefore: prevSummary || '',
        worldSugIds: worldSugIds || [],
        createdAt: now()
      });
      if (book.undoStack.length > 30) book.undoStack.shift();
      this.touchBook(book); this.save();
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
      var b = JSON.parse(json);
      b.id = uid();
      b.createdAt = now(); b.updatedAt = now();
      this.state.books.unshift(b);
      this.migrate();
      this.save();
      return b;
    },
    exportAll: function () { return JSON.stringify(this.state, null, 2); },
    importAll: function (json) {
      var s = JSON.parse(json);
      if (!s || !s.books) throw new Error('文件格式不正确');
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
