/* =========================================================
 * AI —— 提示词组装与三大任务
 *   1) 章节正文生成（流式）
 *   2) 分卷 → 自动切分 N 章大纲
 *   3) 章末记忆总结（写入长期记忆）
 * 所有提示词措辞都来自 Store 里的内置模板（可编辑、可多套方案）
 * ========================================================= */
(function (global) {
  'use strict';

  var WORLD_LABEL = {
    background: '背景设定',
    characters: '人物',
    locations: '地点',
    concepts: '概念 / 设定',
    factions: '势力 / 组织'
  };
  var WORLD_ORDER = ['background', 'characters', 'locations', 'concepts', 'factions'];

  function T(key) { return Store.getTemplate(key); }

  /* 占位符替换 + 清理空值行 */
  function renderTpl(tpl, vars) {
    var s = String(tpl == null ? '' : tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) {
      return vars[k] == null ? '' : vars[k];
    });
    // 去掉“标签：”后面没有内容的行
    s = s.replace(/^[^\n]{0,24}[：:][ \t]*$/gm, '');
    s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
    return s;
  }

  function cleanText(t) {
    var s = String(t || '');
    s = s.replace(/\r\n/g, '\n');
    s = s.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    s = s.replace(/^\s*#{1,6}\s*.*\n+/, '');
    s = s.replace(/^\s*\n+/, '');
    return s.trim();
  }

  function parseJsonMaybe(text) {
    var s = String(text || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var tries = [];
    try { tries.push(JSON.parse(s)); } catch (e) { }
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { tries.push(JSON.parse(s.slice(a, b + 1))); } catch (e) { } }
    var c = s.indexOf('['), d = s.lastIndexOf(']');
    if (c >= 0 && d > c) { try { tries.push(JSON.parse(s.slice(c, d + 1))); } catch (e) { } }
    for (var i = 0; i < tries.length; i++) {
      if (tries[i] && typeof tries[i] === 'object') return tries[i];
    }
    throw new Error('AI 返回内容无法解析为 JSON，请重试或调低温度。\n\n原始返回前 200 字：\n' + String(text).slice(0, 200));
  }

  function wordCount(t) {
    return (String(t || '').replace(/\s/g, '').length);
  }

  /* ---------- 各区块文本 ---------- */
  function worldChunksText(book) {
    var chunks = [];
    WORLD_ORDER.forEach(function (cat) {
      var arr = (book.world && book.world[cat]) || [];
      var items = arr.filter(function (e) { return e.enabled !== false && (e.name || e.content); });
      if (!items.length) return;   // 可缺省：没有内容就不注入
      chunks.push('■ ' + WORLD_LABEL[cat] + '\n' + items.map(function (e) {
        return '- ' + (e.name ? e.name + '：' : '') + (e.content || '');
      }).join('\n'));
    });
    return chunks.join('\n\n');
  }

  function volumesText(book) {
    if (!book.volumes || !book.volumes.length) return '';
    return book.volumes.map(function (v, i) {
      return '第' + (i + 1) + '卷' + (v.title ? '《' + v.title + '》' : '') + (v.summary ? '：' + v.summary : '');
    }).join('\n');
  }

  function recentEntriesText(book) {
    var m = book.memory || {};
    var recent = (m.entries || []).slice(-(m.keepRecent || 6));
    if (!recent.length) return '';
    return recent.map(function (e, i) {
      return (i + 1) + '. ' + (e.chapterTitle ? '《' + e.chapterTitle + '》' : '第' + (e.chapterIndex + 1) + '章') + '\n' + e.text;
    }).join('\n');
  }

  function prevTailText(book, chapter) {
    var i = Store.chapterIndex(book, chapter.id);
    var prev = null;
    for (var k = i - 1; k >= 0; k--) {
      if (book.chapters[k].content && book.chapters[k].content.trim()) { prev = book.chapters[k]; break; }
    }
    if (!prev) return '';
    return '【上一章结尾】（承接此处继续写，不要重复）\n……' + prev.content.slice(-1200);
  }

  /* ---------- 提示词组装 ---------- */
  function systemPrompt(book) {
    var parts = [];
    var ids = book.globalPromptIds || [];
    Store.state.globalPrompts.forEach(function (p) {
      if (p.enabled !== false && ids.indexOf(p.id) >= 0 && p.content) {
        parts.push('【' + p.title + '】\n' + p.content);
      }
    });
    parts.push(T('chapterSystem'));
    return parts.filter(Boolean).join('\n\n');
  }

  /* 章节正文用的全部变量 */
  function chapterVars(book, chapter) {
    var i = Store.chapterIndex(book, chapter.id);
    var m = book.memory || {};
    var heading = '第' + (i + 1) + '章' + (chapter.title ? '《' + chapter.title + '》' : '');
    return {
      bookTitle: book.title || '未命名',
      genre: book.genre, author: book.author, synopsis: book.synopsis, style: book.style,
      requirements: book.requirements,
      targetWords: book.targetWordsPerChapter || 2500,
      chapterNo: i + 1,
      chapterTitle: chapter.title || '',
      chapterHeading: heading,
      chapterOutline: chapter.outline || '（未提供大纲，请根据分卷大纲与前文合理推进剧情）',
      worldChunks: worldChunksText(book),
      volumes: volumesText(book),
      volumeCurrentLine: (function () {
        var v = chapter.volumeId ? Store.getVolume(book, chapter.volumeId) : null;
        return v ? ('（本章属于：《' + (v.title || '未命名分卷') + '》）') : '';
      })(),
      longSummary: m.enabled ? (m.summary || '') : '',
      recentEntries: m.enabled ? recentEntriesText(book) : '',
      keepRecent: m.keepRecent || 6,
      prevSummary: m.summary || ''
    };
  }

  function memoryBlockText(book, v) {

    var m = book.memory || {};
    if (!m.enabled) return '';
    if (!v.longSummary && !v.recentEntries) return '';
    return renderTpl(T('memoryBlock'), v);
  }

  /* ---------- 任务实现 ---------- */
  var AI = {
    WORLD_LABEL: WORLD_LABEL,
    WORLD_ORDER: WORLD_ORDER,
    cleanText: cleanText,
    wordCount: wordCount,
    renderTpl: renderTpl,

    /* 组装章节正文的完整提示词 */
    buildChapterPrompt: function (book, chapter) {
      var v = chapterVars(book, chapter);
      v.bookInfo = renderTpl(T('bookInfo'), v);
      v.world = v.worldChunks ? renderTpl(T('world'), v) : '';
      v.outline = v.volumes ? renderTpl(T('volumeOutline'), v) : '';
      v.memory = memoryBlockText(book, v);
      v.prevTail = prevTailText(book, chapter);
      return { system: systemPrompt(book), user: renderTpl(T('chapterUser'), v) };
    },

    /* 当前实际会注入的记忆内容（供界面查看） */
    buildMemoryBlock: function (book) {
      var v = chapterVars(book, { id: '', title: '', outline: '', volumeId: '' });
      return memoryBlockText(book, v);
    },

    /* 生成章节正文（流式），完成后自动写入记忆 */
    generateChapter: async function (book, chapter, opts) {
      opts = opts || {};
      var provider = Store.activeProvider();
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');

      var p = this.buildChapterPrompt(book, chapter);
      var maxTokens = opts.maxTokens || provider.maxTokens || 4096;

      // 生成前快照：撤回时用得上
      var snapshot = { title: chapter.title, outline: chapter.outline, content: chapter.content };

      if (opts.onPhase) opts.onPhase('writing');
      var raw = await API.chat({
        provider: provider,
        system: p.system,
        user: p.user,
        temperature: opts.temperature,
        maxTokens: maxTokens,
        stream: true,
        signal: opts.signal,
        onDelta: function (delta, full) {
          if (opts.onDelta) opts.onDelta(delta, full);
        }
      });

      var text = cleanText(raw.text || '');
      if (!text) throw new Error('AI 未返回任何内容');

      chapter.content = text;
      chapter.updatedAt = Date.now();
      Store.touchBook(book);
      Store.save();

      // —— 记忆总结（顺带推荐新设定，但不直接写入世界书）——
      var prevSummary = book.memory.summary || '';
      var entry = null;
      var sugIds = [];
      if (book.memory.enabled && !opts.skipMemory) {
        try {
          if (opts.onPhase) opts.onPhase('memory');
          var memo = await this.summarizeMemory(book, chapter, { signal: opts.signal });
          book.memory.summary = memo.summary || prevSummary;
          entry = Store.addMemory(book, chapter, memo.pointsText, prevSummary);
          if (book.memory.suggestWorld !== false && memo.world && memo.world.length) {
            sugIds = Store.addWorldSuggestions(book, memo.world, chapter);
          }
        } catch (e) {
          if (opts.onPhase) opts.onPhase('done');
          if (opts.onError) opts.onError(e);
          throw e;
        }
      }
      Store.pushUndo(book, chapter, entry ? entry.id : '', prevSummary, snapshot, sugIds);
      if (opts.onPhase) opts.onPhase('done');
      return { text: text, memoryEntryId: entry ? entry.id : '', worldSugIds: sugIds };
    },

    /* 记忆总结：返回 { summary, points, pointsText, world } */
    summarizeMemory: async function (book, chapter, opts) {
      opts = opts || {};
      var provider = Store.activeProvider();
      var i = Store.chapterIndex(book, chapter.id);
      var v = chapterVars(book, chapter);
      v.chapterContent = (chapter.content || '').slice(0, 9000);
      v.prevSummary = book.memory.summary || '（暂无）';
      v.categories = WORLD_ORDER.map(function (c) { return c + '（' + WORLD_LABEL[c] + '）'; }).join('、');
      var user = renderTpl(T('memorySummary'), v);

      var r = await API.chat({
        provider: provider,
        system: '你是一个严谨的小说剧情记录员，只输出 JSON，不输出任何多余文字。',
        user: user,
        temperature: 0.3,
        maxTokens: 2048,
        stream: false,
        signal: opts.signal
      });
      var j = parseJsonMaybe(r.text);
      var summary = j.summary || '';
      var points = Array.isArray(j.points) ? j.points : [];
      var pointsText = points.map(function (x, k) { return (k + 1) + '. ' + x; }).join('\n');
      if (!summary && pointsText) summary = pointsText;
      var world = Array.isArray(j.world) ? j.world : (Array.isArray(j.settings) ? j.settings : []);
      world = world.map(function (x) {
        var cat = String((x && (x.cat || x.category)) || '').trim();
        if (WORLD_ORDER.indexOf(cat) < 0) cat = 'concepts';
        return { cat: cat, name: String((x && x.name) || '').trim(), content: String((x && (x.content || x.desc)) || '').trim() };
      }).filter(function (x) { return x.name || x.content; });
      return { summary: summary, points: points, pointsText: pointsText, world: world };
    },

    /* 分卷 → 自动切分 N 章大纲 */
    generateOutlines: async function (book, volume, count, opts) {
      opts = opts || {};
      var provider = Store.activeProvider();
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');

      var recent = book.chapters.slice(-8).map(function (c, k) {
        var idx = book.chapters.length - 8 + k;
        return '第' + (idx + 1) + '章' + (c.title ? '《' + c.title + '》' : '') + '：' + (c.outline || '（无大纲）');
      });

      var v = chapterVars(book, book.chapters[book.chapters.length - 1] || { id: '', title: '', outline: '' });
      v.bookInfo = renderTpl(T('bookInfo'), v);
      v.world = v.worldChunks ? renderTpl(T('world'), v) : '';
      v.volumes = volumesText(book) || '（暂无）';
      v.volume = volume ? ('《' + (volume.title || '未命名分卷') + '》\n' + (volume.summary || '')) : '（未指定，按整体大纲推进）';
      v.recentChapters = recent.length ? '【最近已写章节】\n' + recent.join('\n') : '';
      v.count = count;

      var user = renderTpl(T('outlineSplit'), v);
      var r = await API.chat({
        provider: provider,
        system: '你是一位精通节奏把控的小说大纲策划。只输出 JSON，不输出任何多余文字。',
        user: user,
        temperature: 0.8,
        maxTokens: Math.max(2048, count * 400),
        stream: false,
        signal: opts.signal
      });
      var j = parseJsonMaybe(r.text);
      var arr = j.chapters || j;
      if (!Array.isArray(arr)) throw new Error('AI 返回的不是章节数组');
      return arr.map(function (x) {
        return { title: String(x.title || '').trim(), outline: String(x.outline || x.summary || '').trim() };
      }).filter(function (x) { return x.outline || x.title; });
    },

    /* 单章大纲生成（针对已有章节重写大纲） */
    generateSingleOutline: async function (book, chapter, opts) {
      opts = opts || {};
      var provider = Store.activeProvider();
      var v = chapterVars(book, chapter);
      v.bookInfo = renderTpl(T('bookInfo'), v);
      v.world = v.worldChunks ? renderTpl(T('world'), v) : '';
      v.outline = v.volumes ? renderTpl(T('volumeOutline'), v) : '';
      v.memory = memoryBlockText(book, v);
      var user = renderTpl(T('chapterOutline'), v);

      var r = await API.chat({
        provider: provider,
        system: '你是小说大纲策划。只输出 JSON。',
        user: user, temperature: 0.8, maxTokens: 1024, stream: false, signal: opts.signal
      });
      var j = parseJsonMaybe(r.text);
      return { title: String(j.title || '').trim(), outline: String(j.outline || '').trim() };
    },

    /* =========================================================
     * 对话记录正则切分（不需要 AI）
     * 形如【我】:xxx / 【gemini】:xxx 的聊天导出
     *   - 【我】的内容 → 章节大纲（即当时给 AI 的指令）
     *   - 其他人的内容 → 章节正文
     * ========================================================= */
    splitDialog: function (text, opts) {
      opts = opts || {};
      var myTag = String(opts.myTag || '我').trim();
      var src = String(text || '').replace(/\r\n/g, '\n');

      var re = /【([^】]{1,30})】\s*[:：]?[ \t]*/g;
      var marks = [], m;
      while ((m = re.exec(src))) {
        marks.push({ at: m.index, start: m.index + m[0].length, speak: m[1].trim() });
      }
      if (!marks.length) return { chapters: [], reason: '未找到形如【我】: / 【AI名】: 的发言标记' };

      var blocks = marks.map(function (mk, i) {
        var end = (i + 1 < marks.length) ? marks[i + 1].at : src.length;
        return { speak: mk.speak, text: src.slice(mk.start, end) };
      });

      var raw = [];
      var cur = null;
      blocks.forEach(function (b) {
        var t = stripChatNoise(b.text);
        if (!t) return;
        if (b.speak === myTag) {
          if (cur && (cur.outline || cur.content)) raw.push(cur);
          cur = { outline: t, content: '', title: '' };
        } else {
          if (!cur) cur = { outline: '', content: '', title: '' };
          cur.content = cur.content ? cur.content + '\n\n' + t : t;
        }
      });
      if (cur && (cur.outline || cur.content)) raw.push(cur);

      var chapters = raw.map(function (c, i) {
        var body = stripMarkdown(c.content);
        var title = pickTitle(c.content) || pickTitle(c.outline) || ('第' + (i + 1) + '章');
        return { title: title, outline: stripMarkdown(c.outline), content: body };
      }).filter(function (c) { return c.content || c.outline; });

      return { chapters: chapters, blocks: blocks.length };
    },

    /* 世界设定：把一大段想法拆成设定条目 */
    extractWorld: async function (book, rawText, opts) {
      opts = opts || {};
      var provider = Store.activeProvider();
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');

      var existing = WORLD_ORDER.map(function (cat) {
        var arr = (book.world && book.world[cat]) || [];
        if (!arr.length) return '';
        return '■ ' + WORLD_LABEL[cat] + '：' + arr.map(function (e) { return e.name || '(未命名)'; }).join('、');
      }).filter(Boolean).join('\n');

      var v = {
        existing: existing || '（暂无）',
        categories: WORLD_ORDER.map(function (c) { return c + '（' + WORLD_LABEL[c] + '）'; }).join('、'),
        rawText: String(rawText || '').slice(0, 12000)
      };
      var r = await API.chat({
        provider: provider,
        system: '你是小说设定整理助手，只输出 JSON，不输出任何多余文字。',
        user: renderTpl(T('worldExtract'), v),
        temperature: 0.4,
        maxTokens: 4096,
        stream: false,
        signal: opts.signal
      });
      var j = parseJsonMaybe(r.text);
      var items = Array.isArray(j.items) ? j.items : [];
      return items.map(function (x) {
        var cat = String(x.cat || x.category || '').trim();
        if (WORLD_ORDER.indexOf(cat) < 0) cat = 'concepts';
        return { cat: cat, name: String(x.name || '').trim(), content: String(x.content || x.desc || '').trim() };
      }).filter(function (x) { return x.name || x.content; });
    },

    /* 快捷导入：把一大段文本整理成书本 / 分卷 / 章节 */
    extractBook: async function (rawText, opts) {
      opts = opts || {};
      var provider = Store.activeProvider();
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');

      var v = {
        rawText: String(rawText || '').slice(0, opts.keepContent ? 20000 : 30000),
        contentRule: opts.keepContent
          ? '每章额外输出 content 字段，把该章在原文中的正文原样搬运进来（不要改写、不要省略、不要加 markdown 标题）。'
          : '每章只输出 title 与 outline；outline 写清本章核心事件、出场人物、冲突推进与章末钩子。不要输出正文。'
      };
      var r = await API.chat({
        provider: provider,
        system: '你是小说文本整理助手，只输出 JSON，不输出任何多余文字。',
        user: renderTpl(T('bookImport'), v),
        temperature: 0.5,
        maxTokens: opts.keepContent ? 8192 : 4096,
        stream: false,
        signal: opts.signal
      });
      var j = parseJsonMaybe(r.text);
      var vols = Array.isArray(j.volumes) ? j.volumes : [];
      if (!vols.length && Array.isArray(j.chapters)) vols = [{ title: '', summary: '', chapters: j.chapters }];
      return {
        title: String(j.title || '').trim(),
        synopsis: String(j.synopsis || '').trim(),
        volumes: vols.map(function (v2) {
          return {
            title: String(v2.title || '').trim(),
            summary: String(v2.summary || '').trim(),
            chapters: (Array.isArray(v2.chapters) ? v2.chapters : []).map(function (c) {
              return {
                title: String(c.title || '').trim(),
                outline: String(c.outline || '').trim(),
                content: String(c.content || '').trim()
              };
            }).filter(function (c) { return c.title || c.outline || c.content; })
          };
        }).filter(function (v2) { return v2.chapters.length; })
      };
    }
  };

  /* ---------- 切分用的小工具 ---------- */
  function stripChatNoise(t) {
    var s = String(t || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s*[-—–]{2,}.*分享自[\s\S]*$/m, '')   // OMate 之类导出尾巴
      .replace(/^\s*分享自[^\n]*$/gm, '')
      .replace(/^\s*[-—–]{2,}\s*$/gm, '');             // 分隔线
    // 结尾的追问（"需要继续第二章吗？……"）不算正文
    s = s.replace(/\n\s*(需要继续|要继续|接下来(可以|要)|是否继续)[^\n]{0,60}[？?][\s\S]*$/, '');
    return s.trim();
  }
  function stripMarkdown(t) {
    return String(t || '')
      .replace(/\*\*/g, '')
      .replace(/^\s*#{1,6}\s*.*$/gm, '')
      .replace(/^\s*[-—–]{2,}\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function pickTitle(t) {
    var m = String(t || '').match(/^\s*#{1,6}\s*(.+)$/m);
    if (!m) return '';
    var s = m[1].replace(/\*\*/g, '').trim();
    s = s.replace(/^第[^\s:：·\-—]{1,8}章\s*[:：·\-—]?\s*/, '').trim();
    return s.slice(0, 40);
  }

  global.AI = AI;
})(window);
