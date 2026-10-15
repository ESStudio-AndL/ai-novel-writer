/* =========================================================
 * AI —— 提示词组装与三大任务
 *   1) 章节正文生成（流式）
 *   2) 分卷 → 自动切分 N 章大纲
 *   3) 章末记忆总结（写入长期记忆）
 * 所有提示词措辞都来自 Store 里的内置模板（可编辑、可多套方案）
 * ========================================================= */
(function (global) {
  'use strict';

  // 分栏定义以 Store 为准，这里只做引用（避免两边各存一份、改一处漏一处）
  var WORLD_LABEL = Store.WORLD_LABEL;
  var WORLD_ORDER = Store.WORLD_CATS;

  function T(key) { return Store.getTemplate(key); }

  /* 占位符替换 + 清理空值行
   *
   * 难点在「标签」：模板里既有「书名：{{bookTitle}}」这种标签与占位符同行的写法，
   * 也有「长期记忆摘要（……）：\n{{longSummary}}」这种标签单独一行、内容在下一行的写法。
   * 旧实现按「行尾是冒号就删」来清理，会把后者的标签**误删**（内容明明有，标签却没了）。
   * 现在改成：先给空值打标记，再逐行判断——
   *   · 整行都是空占位符 → 删该行，并连带删掉它上面那行「纯标签」（标签与内容分行的情况）；
   *   · 「标签：空占位符」 → 整行删掉（标签与占位符同行的情况）。
   */
  var EMPTY_MARK = '\u0000';
  var BARE_LABEL = /^[^\n]{0,24}[：:][ \t]*$/;
  function renderTpl(tpl, vars) {
    var s = String(tpl == null ? '' : tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) {
      var v = vars[k];
      return (v == null || v === '') ? EMPTY_MARK : v;
    });
    var lines = s.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf(EMPTY_MARK) < 0) { out.push(line); continue; }
      var bare = line.split(EMPTY_MARK).join('').replace(/[ \t]+$/, '');
      if (!bare) {
        // 整行都是空占位符：删掉它，顺带删掉紧邻上面的纯标签行
        if (out.length && BARE_LABEL.test(out[out.length - 1])) out.pop();
        continue;
      }
      if (BARE_LABEL.test(bare)) continue;    // 「标签：」后面没内容
      out.push(bare);
    }
    s = out.join('\n');
    s = s.split(EMPTY_MARK).join('');
    s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
    return s;
  }

  /* 统一走 Util，避免三份实现行为不一致 */
  var cleanText = Util.cleanText;
  var parseJsonMaybe = Util.parseJsonMaybe;
  var wordCount = Util.wordCount;

  /* ---------- 各区块文本 ---------- */
  /* scopeId：本章所属分卷 id。只注入「全局设定 + 该分卷专属设定」，
   * 其他分卷的专属设定不进入上下文（省 token，也避免剧透）。
   *
   * matchText（可选）：触发式注入的匹配源（本章大纲 / 标题 / 上一章结尾等）。
   * 规则（对老数据完全兼容）：
   *   · 条目没填 keywords → 始终注入（与旧版行为一致）；
   *   · 填了 keywords → 任一关键词在 matchText 里命中才注入；
   *   · pin（常驻）→ 无视关键词始终注入。
   * matchText 为空时按「没填 keywords」处理（全部注入），供分章等需要通盘上下文的任务使用。
   */
  function parseKeywords(kw) {
    return String(kw || '').split(/[,，、\n;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function entryHit(e, matchText) {
    if (e.pin) return true;
    var kws = parseKeywords(e.keywords);
    if (!kws.length) return true;              // 没填关键词：始终注入（老行为）
    if (!matchText) return true;              // 无匹配源：不筛
    for (var i = 0; i < kws.length; i++) {
      if (matchText.indexOf(kws[i]) >= 0) return true;
    }
    return false;
  }
  /* 角色卡结构化字段 → 注入时附加在内容后（只对人物栏生效） */
  function entryText(e) {
    var s = '- ' + (e.name ? e.name + '：' : '') + (e.content || '');
    var card = [];
    if (e.state) card.push('状态：' + e.state);
    if (e.location) card.push('位置：' + e.location);
    if (e.goal) card.push('目标：' + e.goal);
    if (e.knows) card.push('已知：' + e.knows);
    if (e.relations) card.push('关系：' + e.relations);
    if (card.length) s += '\n  ' + card.join('｜');
    return s;
  }
  function worldChunksText(book, scopeId, matchText) {
    var pool = scopeId == null ? Store.allWorldEntries(book) : Store.worldForChapter(book, scopeId || '');
    var chunks = [];
    WORLD_ORDER.forEach(function (cat) {
      var arr = pool[cat] || [];
      var items = arr.filter(function (e) {
        return e.enabled !== false && (e.name || e.content) && entryHit(e, matchText);
      });
      if (!items.length) return;   // 可缺省：没有内容（或未命中）就不注入
      chunks.push('■ ' + WORLD_LABEL[cat] + '\n' + items.map(entryText).join('\n'));
    });
    return chunks.join('\n\n');
  }

  function volumesText(book) {
    if (!book.volumes || !book.volumes.length) return '';
    return book.volumes.map(function (v, i) {
      return '第' + (i + 1) + '卷' + (v.title ? '《' + v.title + '》' : '') + (v.summary ? '：' + v.summary : '');
    }).join('\n');
  }

  /* 世界书现有条目清单（给设定管理模型看）。
   * 必须带 id——它要靠 id 指出「这条该改」而不是新开一条。
   * 内容截断是为了不让一大本世界书把这一次请求撑爆。 */
  function worldIndexText(book) {
    var chunks = [];
    var n = 0;
    WORLD_ORDER.forEach(function (cat) {
      var items = (book.world && book.world[cat]) || [];
      if (!items.length) return;
      var lines = items.map(function (e) {
        n++;
        var scope = e.scope ? '（' + (Store.worldScopeLabel(book, e.scope) || '分卷') + '专属）' : '';
        var kw = e.keywords ? '｜别名：' + e.keywords : '';
        var body = String(e.content || '').replace(/\s+/g, ' ').slice(0, 220);
        return '  id=' + e.id + '｜' + (e.name || '(未命名)') + scope + kw + '：' + body;
      });
      chunks.push('■ ' + WORLD_LABEL[cat] + '\n' + lines.join('\n'));
    });
    return chunks.length ? chunks.join('\n\n') + '\n（共 ' + n + ' 条）' : '（世界书目前是空的）';
  }

  /* 章节记忆条目的统一排版 */
  function entriesText(list) {
    return list.map(function (e, i) {
      return (i + 1) + '. ' + (e.chapterTitle ? '《' + e.chapterTitle + '》' : '第' + (e.chapterIndex + 1) + '章') + '\n' + e.text;
    }).join('\n');
  }

  /* ---------- 截止位置（只看「本章之前」） ----------
   * 写第 N 章时，上下文里出现第 N 章之后的内容就是剧透：模型进行因果倒置，
   * 回头改前面分卷 / 章节时会被后文牵着走，越改越像「已知结局的补叙」。
   * 所以所有「已写出来的内容」（最近正文、章节记忆、长期摘要）都以 cutIndex 为界。
   * 正常续写最后一章时 cutIndex 等于全书写到的位置，行为与不截断完全一致。
   */
  function entryPos(book, e) {
    if (!e) return -1;
    var i = e.chapterId ? Store.chapterIndex(book, e.chapterId) : -1;
    // 章节被删了就退回记录时的下标（至少不会把它算到「本章之后」去）
    return i >= 0 ? i : (typeof e.chapterIndex === 'number' ? e.chapterIndex : -1);
  }

  /* excludeIds：这些章节的正文已全文注入，其记忆条目不再重复列出——
   * 这是省 token 的关键（同一段剧情不付两次钱）
   * cutIndex：只取位置 < cutIndex 的条目（null / undefined = 不截断，分章等通盘任务用） */
  function recentEntriesText(book, excludeIds, cutIndex) {
    var m = book.memory || {};
    var list = m.entries || [];
    if (cutIndex != null) {
      list = list.filter(function (e) { var p = entryPos(book, e); return p >= 0 && p < cutIndex; });
    }
    if (excludeIds && excludeIds.length) {
      list = list.filter(function (e) { return excludeIds.indexOf(e.chapterId) < 0; });
    }
    var recent = list.slice(-(m.keepRecent || 6));
    return recent.length ? entriesText(recent) : '';
  }

  /* 回头写旧章时用的长期摘要：记忆条目里存着 summaryBefore（生成该章前的摘要），
   * 所以「位置恰好等于 cutIndex 的条目」的 summaryBefore 正是写到这一章之前的全书面貌。
   * 拿不到就返回 null，调用方退化成当前摘要 + 明确的时间约束说明。 */
  function summaryBeforeChapter(book, cutIndex) {
    var list = (book.memory && book.memory.entries) || [];
    for (var k = list.length - 1; k >= 0; k--) {
      var e = list[k];
      if (entryPos(book, e) === cutIndex && e.summaryBefore) return e.summaryBefore;
    }
    return null;
  }

  /* 按「字符」安全截断：slice 可能把 emoji / 生僻字的代理对劈成半个，
   * 存进 JSON 后变成替换字符，重新注入时是乱码。实现见 Util.safeSliceEnd。
   */
  function safeSliceEnd(s, n) { return Util.safeSliceEnd(s, n); }

  function prevTailText(book, chapter) {
    var i = Store.chapterIndex(book, chapter.id);
    var prev = null;
    for (var k = i - 1; k >= 0; k--) {
      if (book.chapters[k].content && book.chapters[k].content.trim()) { prev = book.chapters[k]; break; }
    }
    if (!prev) return '';
    return '【上一章结尾】（承接此处继续写，不要重复）\n……' + safeSliceEnd(prev.content, 1200);
  }

  /* 自动分章用：**最近 3 章的正文全文**。
   * 只给大纲不够——语气、人物状态、剧情进度都在正文里，接不住笔就会写出重复或脱节的分章。
   * 按全书章节顺序取最后 3 个已经有正文的章节，原样全文注入，不做截断。 */
  var RECENT_FULL_CHAPTERS = 3;
  /* cutIndex：只取位置 < cutIndex 的章节（回头改旧章时不会把后文正文带进来）。
   * 顺带取代了原先「深拷贝 book 把本章正文清空」的写法——本章的 index 就是 cutIndex，
   * 天然被排除，不用再克隆整本书。 */
  function chaptersBefore(book, cutIndex) {
    var list = (book.chapters || []).filter(function (c, i) {
      if (cutIndex != null && i >= cutIndex) return false;
      return !!(c.content && c.content.trim());
    });
    return list.slice(-RECENT_FULL_CHAPTERS);
  }
  function recentContentText(book, cutIndex) {
    var recent = chaptersBefore(book, cutIndex);
    if (!recent.length) return '';
    var out = recent.map(function (c) {
      var i = Store.chapterIndex(book, c.id);
      return '【第' + (i + 1) + '章' + (c.title ? '《' + c.title + '》' : '') + ' 正文】\n' + c.content.trim();
    });
    return '【最近 ' + recent.length + ' 章正文（全文）】\n\n' + out.join('\n\n');
  }

  /* 按章节顺序取 cutIndex 之前最后 N 个已写正文的章节 id（去重注入用：
   * 这些章的正文全文已注入，其记忆条目不再重复列出） */
  function recentWrittenChapterIds(book, cutIndex) {
    return chaptersBefore(book, cutIndex).map(function (c) { return c.id; });
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
      worldChunks: worldChunksText(book, chapter.volumeId || ''),
      volumes: volumesText(book),
      volumeCurrentLine: (function () {
        var v = chapter.volumeId ? Store.getVolume(book, chapter.volumeId) : null;
        return v ? ('（本章属于：《' + (v.title || '未命名分卷') + '》）') : '';
      })(),
      /* 截止位置：上下文只含本章之前的内容（回头改旧章时不带后文）。
       * 正常续写最后一章时它等于全书写到的位置，行为与不截断一致。
       * 章节不在书里（index -1）时退化为不截断，免得把上下文清空。 */
      cutIndex: i >= 0 ? i : null,
      longSummary: m.enabled ? datedSummary(book, i) : '',
      recentEntries: m.enabled ? recentEntriesText(book, null, i) : '',
      keepRecent: m.keepRecent || 6,
      prevSummary: m.summary || ''
    };
  }

  /* 正文生成用的记忆块：长期摘要 + 近期章节记忆（keepRecent 条）。
   * excludeIds 里的章节正文已全文注入，其要点不再重复注入。
   * cutIndex 非空时只取本章之前的条目，且长期摘要回溯到该章之前那一刻。 */
  function memoryBlockText(book, v, excludeIds, cutIndex) {
    var m = book.memory || {};
    if (!m.enabled) return '';
    v = v || {};
    var long = (cutIndex != null)
      ? datedSummary(book, cutIndex)
      : ((v.longSummary != null) ? v.longSummary : (m.summary || ''));
    /* 注意：chapterVars 会预先算出 v.recentEntries（不含排除），
     * 传了 excludeIds 时必须以排除后的结果为准，否则去重会被绕过。 */
    var entries = (cutIndex != null || (excludeIds && excludeIds.length))
      ? recentEntriesText(book, excludeIds, cutIndex)
      : ((v.recentEntries != null) ? v.recentEntries : recentEntriesText(book));
    if (!long && !entries) return '';
    return renderTpl(T('memoryBlock'), {
      longSummary: long,
      recentEntries: entries,
      keepRecent: m.keepRecent || 6
    });
  }

  /* 长期摘要拿不到「本章之前」的历史快照时的兜底说明。
   * 与其静默把剧透喂进去，不如让模型知道这份摘要跑在当前进度之后。 */
  var FUTURE_WARN = '\n（注意：以上摘要涵盖全书最新进度，可能包含本章之后才发生的情节；' +
    '本章只可沿用其中在本章之前已成立的信息，不得提前写出后续剧情。）';

  /* 「写到 cutIndex 章之前」那一刻的长期摘要：优先用记忆条目里存的历史快照，
   * 拿不到就退回当前摘要并附上时间边界说明（宁可说清楚，不要静默剧透）。 */
  function datedSummary(book, cutIndex) {
    var m = book.memory || {};
    var cur = m.summary || '';
    if (cutIndex == null) return cur;
    var back = summaryBeforeChapter(book, cutIndex);
    if (back != null) return back;
    /* 回溯不到快照时，先判断这份摘要到底有没有跑在本章之后：
     * 有「本章之后」的记忆条目才需要警告。正常续写最后一章时摘要在本章处正好截住，
     * 加警告反而是误报（会让模型不敢用前情）。 */
    var hasFuture = (m.entries || []).some(function (e) { return entryPos(book, e) > cutIndex; });
    return (hasFuture && cur) ? cur + FUTURE_WARN : cur;
  }

  /* 完整长期记忆（自动分章 / 审计用）：长期摘要 + 全部章节记忆条目，
   * 不像写正文那样按 keepRecent 只取最近几条——分章要通盘了解前情。
   * 同样排除已全文注入的最近几章，避免重复付费。
   * cutIndex 非空时（审计旧章）同样只看到该章之前。 */
  function fullMemoryText(book, excludeIds, cutIndex) {
    var m = book.memory || {};
    if (!m.enabled) return '';
    var entries = m.entries || [];
    if (cutIndex != null) {
      entries = entries.filter(function (e) { var p = entryPos(book, e); return p >= 0 && p < cutIndex; });
    }
    if (excludeIds && excludeIds.length) {
      entries = entries.filter(function (e) { return excludeIds.indexOf(e.chapterId) < 0; });
    }
    var summary = datedSummary(book, cutIndex);
    if (!summary && !entries.length) return '';
    return renderTpl(T('memoryBlockFull'), {
      longSummary: summary,
      allEntries: entriesText(entries),
      entryCount: entries.length
    });
  }

  /* ---------- 伏笔 / 文风 ---------- */
  /* 未回收伏笔列表（写正文时自动带上，提醒模型按计划呼应）
   * cutIndex 非空时略去「还没埋到」的伏笔：本章之前的剧情里不存在的东西，
   * 让模型在本章去呼应它只会写出突兀的早熟情节。 */
  function hooksListText(book, cutIndex) {
    var hooks = (book.hooks || []).filter(function (h) {
      if (h.status !== 'open' || !h.content) return false;
      if (cutIndex == null) return true;
      var from = parseInt(h.fromChapter, 10);
      if (!from) return true;                 // 没记埋设章的按「已存在」处理
      return from <= cutIndex + 1;            // fromChapter 是 1 基章号
    });
    if (!hooks.length) return '';
    return hooks.map(function (h) {
      var bits = [];
      if (h.fromChapter) bits.push('第' + h.fromChapter + '章埋下');
      if (h.planChapter) bits.push('计划第' + h.planChapter + '章回收');
      var s = '- ' + h.content;
      if (bits.length) s += '（' + bits.join('，') + '）';
      if (h.note) s += '；备注：' + h.note;
      return s;
    }).join('\n');
  }

  /* 文风规则：把「禁词 / 套话」清单变成给模型看的条目 */
  function bannedListText(book) {
    var raw = (book.styleRules && book.styleRules.banned) || '';
    var list = String(raw).split(/[\n,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    return list.length ? list.map(function (w) { return '- ' + w; }).join('\n') : '';
  }

  /* ---------- 任务实现 ---------- */
  var AI = {
    WORLD_LABEL: WORLD_LABEL,
    WORLD_ORDER: WORLD_ORDER,
    cleanText: cleanText,
    wordCount: wordCount,
    renderTpl: renderTpl,
    worldChunksText: worldChunksText,
    recentContentText: recentContentText,
    fullMemoryText: fullMemoryText,

    /* 组装章节正文的完整提示词。
     * opts.instruction：用户填写的「重写指示」，追加在 user 提示词末尾；
     *   允许缺省（留空时只按书名 / 设定 / 前情 / 大纲重新写一遍，不追加任何额外要求）。
     * opts.rewrite：本次是否是「重写已有正文」（只影响请求归类，不影响提示词本体的结构）。 */
    /* 各任务的模型路由与用量记账：不同活走不同方案（便宜模型跑记忆 / 审计），
     * 每次请求结束后把 usage 落到「本书 + 全局」的累计里。 */
    modelFor: function (task) {
      return Store.activeModel(task);
    },
    trackUsage: function (res, provider, book) {
      if (res && res.usage) Store.recordUsage(res.usage, provider, book);
    },

    buildChapterPrompt: function (book, chapter, opts) {
      opts = opts || {};
      var skip = opts.skip || {};        // 生成前预览里临时勾掉的区块
      var v = chapterVars(book, chapter);
      v.bookInfo = renderTpl(T('bookInfo'), v);

      /* 触发式注入的匹配源：标题 + 本章大纲 + 长期摘要 + 上一章结尾。
       * 凡是这里面没出现过的设定，就不会占上下文（别名命中才算）。 */
      var matchSrc = [
        chapter.title || '', chapter.outline || '',
        (book.memory && book.memory.summary) || '',
        prevTailText(book, chapter)
      ].join('\n');
      v.worldChunks = skip.world ? '' : worldChunksText(book, chapter.volumeId || '', matchSrc);
      v.world = v.worldChunks ? renderTpl(T('world'), v) : '';

      // 文风规则（禁词 / 套话清单，书本基本信息页配置）
      v.bannedList = skip.styleRules ? '' : bannedListText(book);
      v.styleRules = v.bannedList ? renderTpl(T('styleRules'), v) : '';

      v.outline = (skip.outline || !v.volumes) ? '' : renderTpl(T('volumeOutline'), v);

      /* 记忆：长期摘要 + 最近 keepRecent 条章节记忆；
       * 已全文注入的最近几章（它们的正文就在下面）不再重复列要点。
       * cutIndex 保证只取本章之前——回头改旧章时不会把后文的记忆带进来。 */
      var cut = v.cutIndex;
      var recentIds = skip.recentContent ? [] : recentWrittenChapterIds(book, cut);
      v.memory = skip.memory ? '' : memoryBlockText(book, v, recentIds, cut);

      // 未回收伏笔
      v.hooksList = skip.hooks ? '' : hooksListText(book, cut);
      v.hooks = v.hooksList ? renderTpl(T('hooks'), v) : '';

      // 本章之前最近 3 章的正文全文（原样不截断）。
      // cutIndex 天然排除了本章自身，不用再克隆整本书把本章正文清空
      v.recentContent = skip.recentContent ? '' : recentContentText(book, cut);
      v.prevTail = v.recentContent;   // 兼容仍使用 {{prevTail}} 占位符的旧模板
      var user = renderTpl(T('chapterUser'), v);
      if (opts.instruction && String(opts.instruction).trim()) {
        user += '\n\n【重写指示】\n' + String(opts.instruction).trim() +
          '\n（本次是在已有正文基础上重写：请优先满足以上指示，同时保持与前文的连贯；仍然只输出正文本身）';
      }
      return { system: systemPrompt(book), user: user };
    },

    /* 当前实际会注入的记忆内容（供界面查看）
     * 传 chapter 时按该章位置截断（回头看旧章看到的就是当时会注入的那份） */
    buildMemoryBlock: function (book, chapter) {
      var cut = chapter ? Store.chapterIndex(book, chapter.id) : null;
      if (cut != null && cut < 0) cut = null;
      return memoryBlockText(book, null, recentWrittenChapterIds(book, cut), cut);
    },

    /* 生成前预览用的统计：把将要注入的每一块单独算出来（条数 / 字数 / 粗估 token），
     * 界面据此列出「这次到底发了什么」，用户也能临时勾掉某几块省 token 或做人工策稿。
     * 注意：这里只是量级估算，真实用量以接口返回的 usage 为准。 */
    injectStats: function (book, chapter) {
      var v = chapterVars(book, chapter);
      var matchSrc = [
        chapter.title || '', chapter.outline || '',
        (book.memory && book.memory.summary) || '',
        prevTailText(book, chapter)
      ].join('\n');
      var cut = v.cutIndex;
      var recentIds = recentWrittenChapterIds(book, cut);
      function stat(text, count) {
        var t = text || '';
        return { text: t, chars: t.length, tokens: Util.estimateTokens(t), count: count || 0 };
      }
      // 世界设定：触发词筛选后的条数
      var worldText = worldChunksText(book, chapter.volumeId || '', matchSrc);
      var pool = Store.worldForChapter(book, chapter.volumeId || '');
      var wCount = 0;
      WORLD_ORDER.forEach(function (cat) {
        (pool[cat] || []).forEach(function (e) {
          if (e.enabled !== false && (e.name || e.content) && entryHit(e, matchSrc)) wCount++;
        });
      });
      // 记忆：排除「本章之后」与「已全文注入的最近几章」后实际会注入的条数
      var m = book.memory || {};
      var memList = (m.entries || []).filter(function (e) {
        var p = entryPos(book, e);
        if (p < 0) return false;
        if (cut != null && p >= cut) return false;
        return recentIds.indexOf(e.chapterId) < 0;
      });
      var memCount = memList.slice(-(m.keepRecent || 6)).length;
      var hooksText = hooksListText(book, cut);
      var banned = bannedListText(book);
      var recentText = recentContentText(book, cut);
      /* 截断情况：回头改旧章时，本章之后已写出来的内容一律不注入。
       * 界面据此说明「略去了其后 N 章正文 / M 条记忆」，否则用户会以为记忆丢了。 */
      var skipCh = cut == null ? 0 : (book.chapters || []).filter(function (c, i) {
        return i > cut && c.content && c.content.trim();
      }).length;
      var skipEn = cut == null ? 0 : (m.entries || []).filter(function (e) {
        var p = entryPos(book, e); return p > cut;
      }).length;
      return {
        world: stat(worldText, wCount),
        memory: stat(memoryBlockText(book, v, recentIds, cut), memCount),
        recent: stat(recentText, (recentText.match(/【第\d+章/g) || []).length),
        hooks: stat(hooksText, hooksText ? hooksText.split('\n').length : 0),
        style: stat(banned, banned ? banned.split('\n').length : 0),
        outline: stat(v.volumes ? renderTpl(T('volumeOutline'), v) : '', (book.volumes || []).length),
        cutoff: {
          at: cut,
          skippedChapters: skipCh,
          skippedEntries: skipEn,
          summaryDated: !!summaryBeforeChapter(book, cut)
        }
      };
    },

    /* 写后一致性审计：返回问题清单 [{type, quote, against, suggest}] */
    auditChapter: auditChapter,
    /* 未回收伏笔 / 禁词清单的文本形态（界面预览与统计复用） */
    hooksListText: hooksListText,
    bannedListText: bannedListText,
    recentWrittenChapterIds: recentWrittenChapterIds,
    /* 触发式注入：判断某条设定在给定文本下是否会被注入（界面预览用） */
    entryHit: entryHit,
    parseKeywords: parseKeywords,

    /* 生成章节正文（流式），完成后自动写入记忆
     *
     * 撤回栈的关键约定：**快照必须在动 chapter 之前压栈**。
     * 原实现在生成成功后才 pushUndo，于是「正文已写入但记忆总结失败」这类中断
     * 会留下一个没有快照的脏状态：这次生成撤不回来，
     * 下一次生成又会把「已经脏了的正文」当成快照，撤回直接回到错误状态。
     */
    generateChapter: async function (book, chapter, opts) {
      opts = opts || {};
      var provider = this.modelFor('write');
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');

      var p = this.buildChapterPrompt(book, chapter, opts);
      var maxTokens = opts.maxTokens || provider.maxTokens || 4096;

      // ① 先取快照、先压栈
      var snapshot = { title: chapter.title, outline: chapter.outline, content: chapter.content };
      /* 撤回要回到「本次生成前」的摘要，所以存开始时的值；
       * 而喂给模型的「前情」必须是**写这一章之前**的摘要——两者在重写场景下不一样。 */
      var summaryAtStart = (book.memory && book.memory.summary) || '';
      var memoryBefore = Store.getMemoryEntry(book, chapter);
      var prevSummary = Store.memoryBaseline(book, chapter);
      var undo = Store.pushUndo(book, chapter, '', summaryAtStart, snapshot, [], memoryBefore);

      var text, entry = null, sugIds = [];
      try {
        if (opts.onPhase) opts.onPhase('writing');
        var raw = await API.chat({
          provider: provider,
          system: p.system,
          user: p.user,
          kind: (opts.rewrite || opts.instruction) ? 'AI 重写' : '正文生成',
          temperature: opts.temperature,
          maxTokens: maxTokens,
          stream: true,
          signal: opts.signal,
          onDelta: function (delta, full) {
            if (opts.onDelta) opts.onDelta(delta, full);
          }
        });

        this.trackUsage(raw, provider, book);
        text = cleanText(raw.text || '');
        if (!text) throw new Error('AI 未返回任何内容');

        chapter.content = text;
        chapter.updatedAt = Date.now();
        Store.touchBook(book);
        Store.save();

        // ② 记忆总结（顺带推荐新设定，但不直接写入世界书）
        if (book.memory.enabled && !opts.skipMemory) {
          if (opts.onPhase) opts.onPhase('memory');
          // 传前情基线：总结时要合并的是「这一章之前的前情 + 本章新剧情」，
          // 不是「含本章旧版的摘要 + 本章新剧情」（那样摘要把两版剧情揉在一起）
          var memo = await this.summarizeMemory(book, chapter, { signal: opts.signal, prevSummary: prevSummary });
          book.memory.summary = memo.summary || prevSummary;
          entry = Store.addMemory(book, chapter, memo.pointsText, prevSummary);
          if (book.memory.suggestWorld !== false && memo.world && memo.world.length) {
            /* 记忆模型看不到世界书，它给的候选必然带着一堆「其实已经有了」。
             * 交给设定管理模型对照整理一遍：能合并成「修改」的就别再新增。
             * 这一步失败不影响正文与记忆，退回用原始候选即可。 */
            var governed = memo.world;
            if (book.worldGovern !== false) {
              try {
                if (opts.onPhase) opts.onPhase('worldman');
                var g = await this.governWorld(book, chapter, memo.world, { signal: opts.signal });
                if (g && (g.add.length || g.update.length)) governed = g.add.concat(g.update);
              } catch (ge) {
                console.warn('设定管理模型整理失败，回退用记忆模型的原始候选：', ge && ge.message);
              }
            }
            sugIds = Store.addWorldSuggestions(book, governed, chapter);
          }
          // ③ 把记忆 id / 推荐 id 补回刚才那条快照，撤回时才能一起回滚
          undo.memoryEntryId = entry ? entry.id : '';
          undo.worldSugIds = sugIds;
          Store.touchBook(book); Store.save();
        }

        if (opts.onPhase) opts.onPhase('done');
        return { text: text, memoryEntryId: entry ? entry.id : '', worldSugIds: sugIds, undoId: undo.id };
      } catch (e) {
        // 记忆阶段失败不该让正文白写：正文已落盘就保留，只把这条快照留作可撤回点。
        // 若连正文都没写出来（卡在写作阶段），则弹掉这条没用的快照，避免撤回栈里堆积空条目。
        if (e && e.name === 'AbortError') {
          if (typeof text === 'string' && text) { undo.memoryEntryId = ''; }
          else Store.dropUndo(book, undo.id);
        } else if (typeof text !== 'string' || !text) {
          // 正文未产出：本章内容仍是快照里的原样，压栈没有意义
          Store.dropUndo(book, undo.id);
        }
        if (opts.onPhase) opts.onPhase('done');
        throw e;
      }
    },

    /* 记忆总结：返回 { summary, points, pointsText, world } */
    summarizeMemory: async function (book, chapter, opts) {
      opts = opts || {};
      var provider = this.modelFor('memory');
      var i = Store.chapterIndex(book, chapter.id);
      var v = chapterVars(book, chapter);
      v.chapterContent = (chapter.content || '').slice(0, 9000);
      // 调用方传了前情基线就用它（重写旧章时必须是「这一章之前」的那份摘要）
      v.prevSummary = (opts.prevSummary != null ? opts.prevSummary : book.memory.summary) || '（暂无）';
      v.categories = WORLD_ORDER.map(function (c) { return c + '（' + WORLD_LABEL[c] + '）'; }).join('、');
      var user = renderTpl(T('memorySummary'), v);

      var r = await API.chat({
        provider: provider,
        system: '你是一个严谨的小说剧情记录员，只输出 JSON，不输出任何多余文字。',
        user: user,
        kind: '记忆整理',
        temperature: 0.3,
        maxTokens: 2048,
        stream: false,
        signal: opts.signal
      });
      this.trackUsage(r, provider, book);
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

    /* 设定管理：把记忆模型给的候选对照世界书整理一遍。
     * 返回 { add: [...], update: [...] }；update 带 targetId / prevContent，
     * 落地时仍要用户确认（世界书不能被 AI 直接改写）。 */
    governWorld: async function (book, chapter, candidates, opts) {
      opts = opts || {};
      var provider = this.modelFor('worldman');
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');
      var i = Store.chapterIndex(book, chapter.id);
      var v = {
        bookTitle: book.title || '未命名',
        chapterHeading: '第' + (i + 1) + '章' + (chapter.title ? '《' + chapter.title + '》' : ''),
        chapterContent: (chapter.content || '').slice(0, 9000),
        existing: worldIndexText(book),
        candidates: (candidates || []).map(function (x, k) {
          return (k + 1) + '. [' + (WORLD_LABEL[x.cat] || x.cat) + '] ' + (x.name || '(未命名)') + '：' + (x.content || '');
        }).join('\n'),
        categories: WORLD_ORDER.map(function (c) { return c + '（' + WORLD_LABEL[c] + '）'; }).join('、')
      };
      var r = await API.chat({
        provider: provider,
        system: '你是一位严谨的小说设定管理员，只输出 JSON，不输出任何多余文字。',
        user: renderTpl(T('worldGovern'), v),
        kind: '设定管理',
        temperature: 0.2,
        maxTokens: 2048,
        stream: false,
        signal: opts.signal
      });
      this.trackUsage(r, provider, book);
      var j = parseJsonMaybe(r.text);
      var add = Array.isArray(j.add) ? j.add : [];
      var update = Array.isArray(j.update) ? j.update : [];
      add = add.map(function (x) {
        var cat = String((x && (x.cat || x.category)) || '').trim();
        if (WORLD_ORDER.indexOf(cat) < 0) cat = 'concepts';
        return {
          kind: 'add', cat: cat,
          name: String((x && x.name) || '').trim(),
          content: String((x && (x.content || x.desc)) || '').trim(),
          keywords: String((x && x.keywords) || '').trim()
        };
      }).filter(function (x) { return x.name || x.content; });
      update = update.map(function (x) {
        var e = Store.findWorldEntry(book, String((x && x.id) || ''));
        if (!e) return null;              // 指了个不存在的 id，丢掉
        // content 为空视为「本章没有给它带来新东西」
        var nc = String((x && x.content) || '').trim();
        if (!nc) return null;
        return {
          kind: 'update',
          cat: e.cat || 'concepts',
          targetId: e.id,
          name: e.name || '',
          content: nc,
          prevContent: e.content || '',
          reason: String((x && x.reason) || '').trim()
        };
      }).filter(Boolean);
      return { add: add, update: update };
    },

    /* ---------- AI 小编（对话式） ----------
     * 输入 = 与写正文**完全同一套**上下文（世界设定 / 前情记忆 / 最近正文 /
     *        伏笔 / 文风 / 分卷大纲），只是把「写这一章」换成「回答作者」。
     *        这样小编对项目的了解和写作时的模型是同一份，不用另建知识库。
     * 输出 = 一段人话 + 末尾的 actions 代码块，由 Store 解析成提案。
     * 一轮对话一次请求，不做多轮工具调用。 */
    editorContext: function (book, chapter) {
      var v = chapterVars(book, chapter);
      v.bookInfo = renderTpl(T('bookInfo'), v);
      var matchSrc = [
        chapter.title || '', chapter.outline || '',
        (book.memory && book.memory.summary) || '',
        prevTailText(book, chapter)
      ].join('\n');
      var cut = v.cutIndex;
      v.worldChunks = worldChunksText(book, chapter.volumeId || '', matchSrc);
      v.world = v.worldChunks ? renderTpl(T('world'), v) : '';
      v.bannedList = bannedListText(book);
      v.styleRules = v.bannedList ? renderTpl(T('styleRules'), v) : '';
      v.outline = v.volumes ? renderTpl(T('volumeOutline'), v) : '';
      var recentIds = recentWrittenChapterIds(book, cut);
      v.memory = memoryBlockText(book, v, recentIds, cut);
      v.hooksList = hooksListText(book, cut);
      v.hooks = v.hooksList ? renderTpl(T('hooks'), v) : '';
      v.recentContent = recentContentText(book, cut);
      v.categories = WORLD_ORDER.map(function (c) { return c + '（' + WORLD_LABEL[c] + '）'; }).join('、');
      return v;
    },

    buildEditorPrompt: function (book, chapter, question, opts) {
      opts = opts || {};
      var v = this.editorContext(book, chapter);
      v.history = chatHistoryText(book, opts.historyLimit);
      v.question = String(question || '');
      return { system: '你是一位资深小说责任编辑，说话直接、有判断、不客套。只输出内容本身。', user: renderTpl(T('editorChat'), v) };
    },

    /* 发一轮对话（流式）。onDelta 收到的已经是「去掉指令块」的可见文本。 */
    askEditor: async function (book, chapter, question, opts) {
      opts = opts || {};
      var provider = this.modelFor('editor');
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');
      var p = this.buildEditorPrompt(book, chapter, question, opts);
      var r = await API.chat({
        provider: provider,
        system: p.system,
        user: p.user,
        kind: '小编对话',
        temperature: 0.8,
        maxTokens: opts.maxTokens || 1600,
        stream: true,
        signal: opts.signal,
        onDelta: function (delta, full) {
          if (opts.onDelta) opts.onDelta(delta, editorVisibleText(full), full);
        }
      });
      this.trackUsage(r, provider, book);
      var parsed = parseEditorReply(r.text);
      return { text: parsed.text, actions: parsed.actions, note: parsed.note, raw: r.text };
    },

    // 供界面与测试使用
    parseEditorReply: parseEditorReply,
    editorVisibleText: editorVisibleText,
    chatHistoryText: chatHistoryText,

    /* 划线标记的局部修改：只改被标记的片段，其余一字不动。
     * marks: [{id, note}]（位置由调用方先定位好，这里只认 id 与意见）
     * 返回 [{id, text}]；调用方再用 Util.applyPatches 落地。 */
    patchChapter: async function (book, chapter, marks, opts) {
      opts = opts || {};
      var provider = this.modelFor('patch');
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');
      var list = (marks || []).filter(function (m) { return m && m.id; });
      if (!list.length) throw new Error('没有要修改的标记');
      var i = Store.chapterIndex(book, chapter.id);
      var v = {
        chapterHeading: '第' + (i + 1) + '章' + (chapter.title ? '《' + chapter.title + '》' : ''),
        // 给整章是为了让模型看清前后文；但落地时只取标记处的替换，整章返回也没用
        chapterContent: String(chapter.content || '').slice(0, 12000),
        markCount: list.length,
        marks: list.map(function (m, k) {
          var note = String(m.note || '').trim() || '（未填意见，按上下文润色这一处）';
          return '【片段 ' + (k + 1) + '】id=' + m.id + '\n原文：' + m.anchor + '\n修改意见：' + note;
        }).join('\n\n')
      };
      var r = await API.chat({
        provider: provider,
        system: '你是一位替作者做局部改稿的文字编辑。只输出 JSON，不输出任何多余文字。',
        user: renderTpl(T('chapterPatch'), v),
        kind: '标记处修改',
        temperature: 0.7,
        maxTokens: 2048,
        stream: false,
        signal: opts.signal
      });
      this.trackUsage(r, provider, book);
      var j = parseJsonMaybe(r.text);
      var arr = Array.isArray(j.patches) ? j.patches : (Array.isArray(j) ? j : []);
      var byId = {};
      list.forEach(function (m) { byId[m.id] = true; });
      return arr.map(function (x) {
        var id = String((x && (x.id || x.markId)) || '').trim();
        var text = String((x && (x.text != null ? x.text : (x.content != null ? x.content : x.new))) || '');
        return { id: id, text: text };
      }).filter(function (x) { return x.id && byId[x.id] && x.text; });
    },

    /* 分卷 → 自动切分 N 章大纲
     * 上下文结构：设定（书籍信息 + 世界设定）+ 完整长期记忆 + 最近 3 章正文全文 + 本卷大纲。
     * 不再列举其余分卷的大纲——那些内容对「细化本卷」没有帮助，只会占上下文、带偏节奏。 */
    generateOutlines: async function (book, volume, count, opts) {
      opts = opts || {};
      var provider = this.modelFor('split');
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');

      var v = chapterVars(book, book.chapters[book.chapters.length - 1] || { id: '', title: '', outline: '' });
      v.bookInfo = renderTpl(T('bookInfo'), v);
      // 自动分章针对某个分卷：注入「全局 + 该分卷」的设定
      v.worldChunks = worldChunksText(book, volume ? volume.id : '');
      v.world = v.worldChunks ? renderTpl(T('world'), v) : '';
      /* 完整长期记忆（摘要 + 全部章节记忆条目），比写正文时注入的更全；
       * 最近 3 章的正文就在下面全文给出，其记忆条目不再重复注入。 */
      var recentIds = recentWrittenChapterIds(book);
      v.memory = fullMemoryText(book, recentIds);
      // 最近 3 章的正文全文
      v.recentContent = recentContentText(book);
      v.volume = volume ? ('《' + (volume.title || '未命名分卷') + '》\n' + (volume.summary || '')) : '（未指定，按整体大纲推进）';
      v.count = count;

      var user = renderTpl(T('outlineSplit'), v);
      var r = await API.chat({
        provider: provider,
        system: '你是一位精通节奏把控的小说大纲策划。只输出 JSON，不输出任何多余文字。',
        user: user,
        kind: '自动分章',
        temperature: 0.8,
        maxTokens: Math.max(2048, count * 400),
        stream: false,
        signal: opts.signal
      });
      this.trackUsage(r, provider, book);
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
      var provider = this.modelFor('outline');
      var v = chapterVars(book, chapter);
      v.bookInfo = renderTpl(T('bookInfo'), v);
      v.world = v.worldChunks ? renderTpl(T('world'), v) : '';
      v.outline = v.volumes ? renderTpl(T('volumeOutline'), v) : '';
      // 同样只看到本章之前：给旧章重写大纲时被后文牵着走，大纲就不再是这一章的了
      var cut = v.cutIndex;
      v.memory = memoryBlockText(book, v, recentWrittenChapterIds(book, cut), cut);
      var user = renderTpl(T('chapterOutline'), v);

      var r = await API.chat({
        provider: provider,
        system: '你是小说大纲策划。只输出 JSON。',
        user: user, kind: '章节大纲', temperature: 0.8, maxTokens: 1024, stream: false, signal: opts.signal
      });
      this.trackUsage(r, provider, book);
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

    /* =========================================================
     * 全文搜索
     * 跨全部作品检索：章节标题 / 章节大纲 / 章节正文 / 世界设定 /
     * 长期记忆摘要 / 章节记忆 / 书名与简介。
     * 纯前端线性扫描：单本 100 万字量级下仍是毫秒级，
     * 没必要为它引入索引结构。
     * ========================================================= */
    search: function (query, opts) {
      opts = opts || {};
      var q = String(query || '').trim();
      if (!q) return { items: [], total: 0, query: '' };
      var lower = q.toLowerCase();
      var scope = opts.scope || 'all';        // all | chapter | world | memory
      var limit = opts.limit || 80;
      var items = [];

      function hit(text) {
        if (!text) return -1;
        return String(text).toLowerCase().indexOf(lower);
      }
      /* 从命中位置截一段上下文，并把命中词两端插上标记 */
      function excerpt(text, at, pad) {
        text = String(text);
        pad = pad || 44;
        var start = Math.max(0, at - pad);
        var end = Math.min(text.length, at + q.length + pad);
        if (start > 0) start = Util.safeSliceStart(text, start + 2).length;   // 避免切坏代理对
        var seg = text.slice(start, end).replace(/\s+/g, ' ');
        var rel = Math.max(0, at - start);
        var pre = Util.esc(seg.slice(0, rel));
        var mid = Util.esc(seg.slice(rel, rel + q.length));
        var post = Util.esc(seg.slice(rel + q.length));
        return (start > 0 ? '…' : '') + pre + '<mark>' + mid + '</mark>' + post + (end < text.length ? '…' : '');
      }

      Store.state.books.forEach(function (b) {
        var bookHit = hit(b.title) >= 0 || hit(b.synopsis) >= 0 || hit(b.genre) >= 0;

        // —— 章节：标题 / 大纲 / 正文 ——
        if (scope === 'all' || scope === 'chapter') {
          b.chapters.forEach(function (c, i) {
            var fields = [
              ['标题', c.title],
              ['大纲', c.outline],
              ['正文', c.content]
            ];
            for (var f = 0; f < fields.length; f++) {
              var label = fields[f][0], text = fields[f][1];
              var at = hit(text);
              if (at < 0) continue;
              // 标题/大纲里命中就直接给标题类结果，正文命中给正文类
              var kind = label === '正文' ? 'content' : 'outline';
              items.push({
                kind: kind,
                bookId: b.id, bookTitle: b.title,
                chapterId: c.id, chapterIndex: i,
                chapterTitle: c.title || ('第' + (i + 1) + '章'),
                field: label,
                score: (label === '正文' ? 1 : 3) + (bookHit ? 1 : 0),
                excerpt: excerpt(text, at)
              });
              break;   // 一章只出一条，避免同一章刷屏
            }
          });
        }

        // —— 世界设定 ——
        if (scope === 'all' || scope === 'world') {
          WORLD_ORDER.forEach(function (cat) {
            (b.world[cat] || []).forEach(function (e) {
              var at = hit(e.name) >= 0 ? hit(e.name) : hit(e.content);
              if (at < 0) return;
              items.push({
                kind: 'world',
                bookId: b.id, bookTitle: b.title,
                cat: cat,
                field: WORLD_LABEL[cat] + (e.name ? ' · ' + e.name : ''),
                score: 2 + (bookHit ? 1 : 0),
                excerpt: excerpt(hit(e.name) >= 0 ? e.name : e.content, at)
              });
            });
          });
        }

        // —— 记忆 ——
        if (scope === 'all' || scope === 'memory') {
          var atS = hit(b.memory && b.memory.summary);
          if (atS >= 0) {
            items.push({
              kind: 'memory',
              bookId: b.id, bookTitle: b.title,
              field: '长期记忆摘要',
              score: 2,
              excerpt: excerpt(b.memory.summary, atS)
            });
          }
          (b.memory && b.memory.entries || []).forEach(function (e) {
            var at = hit(e.text);
            if (at < 0) return;
            items.push({
              kind: 'memory',
              bookId: b.id, bookTitle: b.title,
              chapterId: e.chapterId || '',
              field: '章节记忆 · ' + (e.chapterTitle || '未命名'),
              score: 1,
              excerpt: excerpt(e.text, at)
            });
          });
        }

        // —— 书名本身命中：给一个「整本书」入口 ——
        if (bookHit && (scope === 'all' || scope === 'chapter')) {
          items.push({
            kind: 'book',
            bookId: b.id, bookTitle: b.title,
            field: '作品',
            score: 5,
            excerpt: Util.esc(Util.safeSliceStart(b.synopsis || b.title, 90))
          });
        }
      });

      items.sort(function (x, y) { return y.score - x.score; });
      return { items: items.slice(0, limit), total: items.length, query: q };
    },

    /* 世界设定：把一大段想法拆成设定条目 */
    extractWorld: async function (book, rawText, opts) {
      opts = opts || {};
      var provider = this.modelFor('world');
      if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');

      var existing = WORLD_ORDER.map(function (cat) {
        var arr = (book.world && book.world[cat]) || [];
        if (!arr.length) return '';
        return '■ ' + WORLD_LABEL[cat] + '：' + arr.map(function (e) {
          return (e.name || '(未命名)') + (e.scope ? '（' + Store.worldScopeLabel(book, e.scope) + '专属）' : '');
        }).join('、');
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
        kind: '设定整理',
        temperature: 0.4,
        maxTokens: 4096,
        stream: false,
        signal: opts.signal
      });
      this.trackUsage(r, provider, book);
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
      var provider = this.modelFor('import');
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
        kind: '文本导入',
        temperature: 0.5,
        maxTokens: opts.keepContent ? 8192 : 4096,
        stream: false,
        signal: opts.signal
      });
      this.trackUsage(r, provider, null);   // 导入时尚未建书，只记全局
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
  /* =========================================================
   * 写后一致性审计
   * 生成正文后，对照「世界设定 + 前情记忆」检查本章是否有矛盾。
   * 这是连续性问题的兜底手段：模型写错了，人工未必看得出，
   * 但另一双眼睛（哪怕还是模型）逐条比对设定与记忆，能捞回大部分硬伤。
   * ========================================================= */
  async function auditChapter(book, chapter, opts) {
    opts = opts || {};
    var provider = AI.modelFor('audit');
    if (!provider) throw new Error('请先在「设置 - API 提供商」中配置一个可用接口');
    var i = Store.chapterIndex(book, chapter.id);
    var v = {
      bookTitle: book.title || '未命名',
      world: worldChunksText(book, chapter.volumeId || ''),
      // 只对照本章之前的记忆：用后文的记忆来判本章「不一致」，等于要求旧章迁就后文
      memory: fullMemoryText(book, null, i),
      chapterHeading: '第' + (i + 1) + '章' + (chapter.title ? '《' + chapter.title + '》' : ''),
      chapterContent: String(chapter.content || '').slice(0, 12000)
    };
    var r = await API.chat({
      provider: provider,
      system: '你是一位严谨的小说连续性审校员，只输出 JSON，不输出任何多余文字。',
      user: renderTpl(T('auditCheck'), v),
      kind: '一致性审计',
      temperature: 0.2,
      maxTokens: 2048,
      stream: false,
      signal: opts.signal
    });
    AI.trackUsage(r, provider, book);
    var j = parseJsonMaybe(r.text);
    var issues = Array.isArray(j.issues) ? j.issues : (Array.isArray(j) ? j : []);
    return issues.map(function (x) {
      return {
        type: String((x && (x.type || x.kind)) || '其他').trim() || '其他',
        quote: String((x && (x.quote || x.text)) || '').trim(),
        against: String((x && (x.against || x.reason)) || '').trim(),
        suggest: String((x && (x.suggest || x.fix)) || '').trim()
      };
    }).filter(function (x) { return x.quote || x.against || x.suggest; });
  }

  /* ---------- AI 小编 ---------- */

  /* 从小编回复里拆出「给人看的话」和「要动数据的指令」。
   * 约定指令块放在回复最后，于是流式显示时可以直接在 ```actions 处截断——
   * 不用写状态机，也不会把半截 JSON 闪给用户看。 */
  /* ---------- 小编的标签格式 ----------
   * 改动写成标签块，直接摆在聊天里，人一眼能看懂、也能逐条改：
   *
   *   [改设定 老周]
   *   铁匠；实为北境守夜人的眼线
   *   [/改设定]
   *
   * 头部的参数：含 = 的是键值（名称= / 回收= / 备注= …），不含 = 的按位置填。
   * 中文键和英文键都认，模型写哪个都行。
   */
  var TAG_OPS = {
    '改设定': 'world.update', '删设定': 'world.del', '加设定': 'world.add',
    '加伏笔': 'hook.add', '改伏笔': 'hook.update',
    '改大纲': 'chapter.outline', '改分卷': 'volume.update'
  };
  var TAG_NAMES = Object.keys(TAG_OPS);
  var TAG_RE = new RegExp(
    '\\[(' + TAG_NAMES.join('|') + ')([^\\]]*)\\]' +
    '|\\[\\/\\s*(' + TAG_NAMES.join('|') + ')\\s*\\]', 'g');

  /* 把文本里的标签块扫出来（含未闭合的：模型被截断时也要能救回来） */
  function scanTagBlocks(s) {
    TAG_RE.lastIndex = 0;
    var tokens = [], m;
    while ((m = TAG_RE.exec(s))) {
      if (m[1]) tokens.push({ open: true, tag: m[1], args: String(m[2] || '').trim(), at: m.index, body: m[0].length + m.index });
      else tokens.push({ open: false, tag: m[3], at: m.index, end: m.index + m[0].length });
    }
    var blocks = [], cur = null;
    tokens.forEach(function (t) {
      if (t.open) {
        if (cur) { cur.bodyEnd = t.at; blocks.push(cur); }   // 上一个没闭合，就地结束
        cur = { tag: t.tag, args: t.args, start: t.at, bodyStart: t.body };
      } else if (cur && t.tag === cur.tag) {
        cur.bodyEnd = t.at; cur.end = t.end; blocks.push(cur); cur = null;
      }
    });
    if (cur) { cur.bodyEnd = s.length; blocks.push(cur); }
    return blocks;
  }

  /* "名称=老周 回收=6" → 位置参数 + 键值参数 */
  function parseTagArgs(str) {
    var pos = [], kv = {};
    String(str || '').split(/\s+/).forEach(function (t) {
      var i = t.indexOf('=');
      if (i > 0) kv[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      else if (t) pos.push(t);
    });
    return { pos: pos, kv: kv };
  }

  /* 标签 → 统一的 action 对象（与 JSON 写法共用同一种结构） */
  function tagToAction(tag, argsStr, body) {
    var a = parseTagArgs(argsStr);
    function pick() {
      for (var i = 0; i < arguments.length; i++) {
        if (a.kv[arguments[i]] != null) return a.kv[arguments[i]];
      }
      return null;
    }
    var op = TAG_OPS[tag];
    var content = String(body || '').trim();
    var out = { op: op };
    if (op === 'world.add') {
      out.cat = pick('分类', 'cat') || a.pos[0] || '';
      out.name = pick('名称', 'name') || a.pos[1] || a.pos[0] || '';
      out.content = content;
      out.keywords = pick('别名', 'keywords') || '';
      return out;
    }
    if (op === 'world.update' || op === 'world.del') {
      out.name = pick('名称', 'name') || a.pos[0] || '';
      if (op === 'world.update') out.content = content;
      return out;
    }
    if (op === 'hook.add') {
      out.content = content;
      out.fromChapter = pick('埋于', 'from', 'fromChapter') || a.pos[0] || '';
      out.planChapter = pick('回收', 'plan', 'planChapter') || a.pos[1] || '';
      out.note = pick('备注', 'note') || '';
      return out;
    }
    if (op === 'hook.update') {
      out.content = pick('名称', 'name') || a.pos[0] || '';
      // 正文里再写一次键值对（状态=resolved / 回收=6 / 备注=…）也认
      var b = parseTagArgs(content.replace(/\n/g, ' '));
      var kv = {};
      Object.keys(a.kv).forEach(function (k) { kv[k] = a.kv[k]; });
      Object.keys(b.kv).forEach(function (k) { kv[k] = b.kv[k]; });
      out.status = kv['状态'] || kv.status || '';
      out.planChapter = kv['回收'] || kv['回收章'] || kv.plan || '';
      out.note = kv['备注'] != null ? kv['备注'] : kv.note;
      return out;
    }
    if (op === 'chapter.outline') {
      out.chapter = pick('章', 'chapter') || a.pos[0] || '';
      out.title = pick('标题', 'title') || a.pos[1] || '';
      out.outline = content || pick('大纲', 'outline') || '';
      return out;
    }
    if (op === 'volume.update') {
      out.volume = pick('卷', 'volume') || a.pos[0] || '';
      out.title = pick('标题', 'title') || a.pos[1] || '';
      out.summary = content || pick('大纲', 'summary') || '';
      return out;
    }
    return out;
  }

  /* 兼容旧写法：```actions [ {...} ] ```（模板里已经改教标签，这条只是保险） */
  var ACTIONS_FENCE = /```\s*actions\s*\n([\s\S]*?)(?:```|$)/i;
  function parseActionsFence(s) {
    var m = s.match(ACTIONS_FENCE);
    if (!m) return null;
    var raw = String(m[1] || '').trim();
    var arr = null;
    try {
      var j = JSON.parse(raw);
      arr = Array.isArray(j) ? j : (Array.isArray(j && j.actions) ? j.actions : null);
    } catch (e) { arr = null; }
    return arr ? arr.filter(function (x) { return x && x.op; }) : null;
  }

  /* 只写了个空壳（有标签没内容）的指令没有意义：与其把它渲染成一条
   * 点不动的建议，不如丢掉并提示作者让小编重说一遍。 */
  function actionMeaningful(a) {
    if (!a || !a.op) return false;
    var has = function (x) { return !!String(x == null ? '' : x).trim(); };
    if (a.op === 'world.update') return has(a.content);
    if (a.op === 'chapter.outline') return has(a.outline) || has(a.title);
    if (a.op === 'volume.update') return has(a.summary) || has(a.title);
    if (a.op === 'hook.update') return has(a.status) || has(a.planChapter) || has(a.note);
    if (a.op === 'world.add') return has(a.name) || has(a.content);
    return true;
  }

  function parseEditorReply(text) {
    var s = String(text == null ? '' : text);
    var actions = [], note = '';

    var blocks = scanTagBlocks(s);
    blocks.forEach(function (b) {
      var a = tagToAction(b.tag, b.args, s.slice(b.bodyStart, b.bodyEnd));
      if (actionMeaningful(a)) actions.push(a);
    });

    if (!actions.length) {
      var fromJson = parseActionsFence(s);
      if (fromJson && fromJson.length) actions = fromJson;
    }

    // 把标签块从可见文本里摘掉；顺带把 actions 代码块也摘掉
    var visible = s;
    for (var i = blocks.length - 1; i >= 0; i--) {
      var b = blocks[i];
      visible = visible.slice(0, b.start) + visible.slice(b.end != null ? b.end : b.bodyEnd);
    }
    visible = visible.replace(ACTIONS_FENCE, '');

    if (!actions.length && blocks.length) {
      // 标签认出来了但一条都没解析成功（比如只写了开标签没写内容）
      note = '（小编写的改动标签没读全，已忽略。可以让它再说一次要改什么）';
    }
    return { text: visible.replace(/\n{3,}/g, '\n\n').trim(), actions: actions, note: note };
  }

  /* 流式期间用：遇到第一个标签或指令块就截断，不把半截东西闪给用户看 */
  function editorVisibleText(text) {
    var s = String(text == null ? '' : text);
    var at = s.search(/\[(改设定|删设定|加设定|加伏笔|改伏笔|改大纲|改分卷)|```\s*actions/i);
    return (at >= 0 ? s.slice(0, at) : s).trim();
  }

  /* 把对话历史拼成给模型看的样子（最近若干轮） */
  function chatHistoryText(book, limit) {
    var list = (book.chat || []).filter(function (m) { return m.text; });
    var recent = list.slice(-(limit || 8));
    if (!recent.length) return '（还没有对话）';
    return recent.map(function (m) {
      return (m.role === 'user' ? '作者：' : '小编：') + String(m.text).replace(/\s+/g, ' ').slice(0, 400);
    }).join('\n');
  }

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
