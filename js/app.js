/* =========================================================
 * App —— 路由启动、事件委托与业务流程
 * ========================================================= */
(function (global) {
  'use strict';

  var App = { abort: null, autoGenerate: null };

  /* =========================================================
   * AI 任务互斥锁
   *
   * 背景（真实可复现的坑）：正文生成用的是 bar 模式 busy（顶部浮条，**故意不遮挡
   * 正文**，方便边写边看），所以生成期间界面上的按钮照样能点。多点几下就会并发
   * 跑两个生成请求：后返回的那个直接覆盖先返回的正文，两次都会写记忆、都会扣钱，
   * 用户只看到一个结果但内容可能已经串了。分章、审计、整理设定等同理。
   *
   * 约定：任何会「发请求 + 改数据」的任务开始前 lockRun()，结束（成功 / 失败 /
   * 中止）必须在 finally 里 unlockRun()。已有人在跑时直接拒绝，并提示先停止当前
   * 任务——busy 浮条上的「停止」按钮就是干这个的。
   * ========================================================= */
  var RUN = null;
  /* 兜底：万一某个任务卡在既没成功也没失败（例如页面切后台被冻结、请求永不返回），
   * 锁不能永久占着把整个应用锁死。所有 AI 请求本身都有超时（流式 300s），
   * 所以 15 分钟仍未释放只可能是异常状态，放行并在控制台留痕。 */
  var LOCK_MAX = 15 * 60 * 1000;
  function lockRun(key, label) {
    if (RUN && Date.now() - RUN.at > LOCK_MAX) {
      console.warn('AI 任务锁超时未释放，强制放行：' + RUN.key);
      RUN = null;
    }
    if (RUN) {
      UI.toast('「' + RUN.label + '」正在进行，请先点「停止」结束它，再开始新的');
      return false;
    }
    RUN = { key: key, label: label, at: Date.now() };
    return true;
  }
  function unlockRun(key) {
    if (RUN && (!key || RUN.key === key)) RUN = null;
  }
  function isRunning() { return !!RUN; }
  /* 供测试与界面读取：当前有没有任务在跑 */
  App.running = function () { return RUN ? { key: RUN.key, label: RUN.label } : null; };

  /* 统一走 Util：app.js 原来自己有一份 esc / download / copyText */
  var esc = Util.esc;
  var fmtNum = Util.fmtNum;
  var download = Util.download;
  var copyText = Util.copyText;

  /* 跳转：目标 hash 与当前相同时也要重新渲染（否则页面不会刷新） */
  function go(hash) {
    if (location.hash === hash) UI.route();
    else location.hash = hash;
  }
  function bookIdFromHash() {
    var seg = (location.hash || '').replace(/^#\/?/, '').split('/');
    if (seg[0] === 'book' || seg[0] === 'chapters' || seg[0] === 'read') return seg[1];
    return null;
  }
  function curBook() { return Store.getBook(bookIdFromHash()); }

  /* ---------- data-bind 写入 ----------
   * 数值字段在这里统一钳制。原来只有 targetWordsPerChapter / keepRecent 走 parseInt，
   * 且都没有范围保护：keepRecent 填 0 会让「近期章节记忆」一条都取不到，
   * targetWords 填 0 会让提示词里出现「目标约 0 字」。
   */
  var INT_FIELDS = {
    targetWordsPerChapter: [200, 20000, 2500],
    keepRecent: [1, 30, 6]
  };

  function applyBind(path, rawValue) {
    var seg = path.split('.');
    var scope = seg[0];
    var b = curBook();
    var value = rawValue;
    if (scope === 'book' && b) {
      var last = seg[seg.length - 1];
      if (INT_FIELDS[last]) {
        var def = INT_FIELDS[last];
        value = Util.clampInt(rawValue, def[0], def[1], def[2]);
      }
      // 支持 book.memory.keepRecent 这类嵌套字段
      var node = b;
      for (var i = 1; i < seg.length - 1; i++) {
        if (!node[seg[i]]) node[seg[i]] = {};
        node = node[seg[i]];
      }
      node[last] = value;
      Store.touchBook(b);
    } else if (scope === 'chapter' && b) {
      var c = Store.getChapter(b, seg[1]);
      if (c) { c[seg[2]] = value; c.updatedAt = Date.now(); Store.touchBook(b); }
    } else if (scope === 'world' && b) {
      var e = Store.getWorldEntry(b, seg[1], seg[2]);
      if (e) { e[seg[3]] = value; e.updatedAt = Date.now(); Store.touchBook(b); }
    } else if (scope === 'volume' && b) {
      var v = Store.getVolume(b, seg[1]);
      if (v) { v[seg[2]] = value; Store.touchBook(b); }
    } else if (scope === 'provider') {
      var p = Store.getProvider(seg[1]);
      if (p) {
        p[seg[2]] = (seg[2] === 'temperature' || seg[2] === 'maxTokens' || seg[2] === 'topP')
          ? (parseFloat(rawValue) || 0) : value;
      }
    } else if (scope === 'prompt') {
      var gp = Store.getGlobalPrompt(seg[1]);
      if (gp) { gp[seg[2]] = value; }
    }
    // 只用 Store 这一套防抖，避免两个定时器各自写盘
    Store.saveSoon();
  }

  /* =========================================================
   * AI 业务流程
   * ========================================================= */

  /* AI 顺手推荐了新设定：只给一条轻提示，点「去看看」才跳到世界设定页 */
  function suggestToast(b, n) {
    if (!n) return;
    UI.toast('💡 AI 推荐了 ' + n + ' 条新设定', 3600, {
      actionText: '去看看',
      onAction: function () { go('#/book/' + b.id + '/world'); }
    });
  }

  /* 生成前预览面板：让用户看清上下文构成，并临时减配。
   * 返回 { skip: {...} }；用户取消时返回 null。 */
  function askInject(b, c) {
    return new Promise(function (resolve) {
      var s = AI.injectStats(b, c);
      var blocks = [
        ['world', '世界设定（角色卡 + 分卷作用域，按触发词筛选后）', '条'],
        ['memory', '前情记忆（长期摘要 + 本章之前最近几章要点）', '条'],
        ['recent', '本章之前最近 3 章正文全文', '章'],
        ['hooks', '未回收伏笔（已埋下的）', '条'],
        ['style', '文风规则（禁词清单）', '条'],
        ['outline', '分卷大纲（含后续规划）', '卷']
      ];
      var total = 0;
      blocks.forEach(function (x) { total += s[x[0]].tokens; });

      /* 回头改旧章时说明「后面的没给模型看」，否则用户会以为记忆丢了 */
      var cut = s.cutoff || {};
      var cutNote = '';
      if (cut.skippedChapters || cut.skippedEntries) {
        var bits = [];
        if (cut.skippedChapters) bits.push(cut.skippedChapters + ' 章正文');
        if (cut.skippedEntries) bits.push(cut.skippedEntries + ' 条章节记忆');
        cutNote = '<div class="hint mb8">你在修改第 ' + (cut.at + 1) + ' 章，其后的 ' + bits.join('、') +
          '不注入——否则模型会顺着后文写，这章就再也改不动了。' +
          (cut.summaryDated ? '长期摘要已回溯到写这一章之前的版本。' : '长期摘要是全书最新版，提示词里已标注不要提前写出后续剧情。') +
          '</div>';
      }

      function row(x) {
        var d = s[x[0]];
        var meta = (d.count ? d.count + ' ' + x[2] + ' · ' : '') + fmtNum(d.chars) + ' 字 · 约 ' + d.tokens + ' token';
        return '<label class="switch" style="margin:6px 0 12px">' +
          '<input type="checkbox" data-f="' + x[0] + '" checked><span class="track"></span>' +
          '<span>' + esc(x[1]) + '<span class="tiny muted">（' + esc(meta) + '）</span></span></label>';
      }

      UI.openSheet({
        title: '本次将注入 · 粗估 ' + total + ' token',
        body: '<div class="hint mb8">取消勾选 = 本次不注入该块，用来省 token 或做人工策稿。' +
          '粗估值不计 system 提示词与模型回复，真实用量看请求返回的 usage。</div>' +
          cutNote +
          blocks.map(row).join('') +
          '<label class="switch" style="margin:12px 0 0">' +
          '<input type="checkbox" data-f="noAsk"><span class="track"></span>' +
          '<span>以后不再预览（设置 → 数据里可重新开启）</span></label>',
        focus: false,
        buttons: [
          { text: '取消', cls: 'ghost' },
          {
            text: '开始生成', cls: 'primary', onClick: function () {
              var v = UI.collectSheet();
              if (v.noAsk) { Store.state.ui.injectPreview = false; Store.save(); }
              resolve({
                skip: {
                  world: !v.world, memory: !v.memory, recentContent: !v.recent,
                  hooks: !v.hooks, styleRules: !v.style, outline: !v.outline
                }
              });
              return false;
            }
          }
        ]
      });
    });
  }

  /* 正文生成的薄壳：只负责加互斥锁。
   * 主体里有很多早退分支（没配接口、用户取消覆盖确认、取消生成前预览……），
   * 把锁放在壳里用 try/finally 兜住，任何一条路径都保证解锁，不会漏。 */
  async function generateChapterFlow(bookId, chapterId, opts) {
    opts = opts || {};
    var b0 = Store.getBook(bookId);
    if (!b0 || !Store.getChapter(b0, chapterId)) return;
    var rr = !!(opts.rewrite || opts.instruction);
    /* 互斥锁：bar 模式 busy 不遮挡界面，生成期间按钮照样可点。
     * 不锁的话多点几下就是并发写作——后返回的覆盖先返回的，还会重复写记忆、重复扣钱。 */
    if (!lockRun('write', rr ? 'AI 重写' : 'AI 写作')) return;
    try {
      return await generateChapterRun(bookId, chapterId, opts);
    } finally {
      unlockRun('write');
    }
  }

  async function generateChapterRun(bookId, chapterId, opts) {
    opts = opts || {};
    var force = !!opts.force;
    var instruction = opts.instruction || '';
    // 「重写」是独立语义：只要从重写入口进来就算重写，提示词留空也算。
    // （以前用 instruction 是否为空兼职判断，留空就被当成「新写一章」，行为与提示都不对）
    var rewrite = !!opts.rewrite || !!instruction;
    var b = Store.getBook(bookId), c = Store.getChapter(b, chapterId);
    if (!b || !c) return;
    var provider = Store.activeModel('write');
    if (!provider) {
      await UI.confirm('尚未配置 API', '需要先在「设置 → API 提供商」里添加一个可用的接口。', '去设置');
      go('#/settings'); return;
    }
    if (!provider.apiKey && provider.type !== 'custom') {
      UI.toast('当前提供商未填写 API Key'); return;
    }
    if (!c.volumeId && b.volumes.length) c.volumeId = b.volumes[0].id;
    // 从重写表单进来时用户已确认过覆盖（force），不再重复询问
    if (c.content && !force && !rewrite) {
      var ok = await UI.confirm('重新生成', '本章已有 ' + AI.wordCount(c.content) + ' 字正文。重新生成会覆盖它（之后可用「撤回」恢复），继续？', '重新生成');
      if (!ok) return;
    }

    /* 生成前预览：默认弹出，列出本次到底注入了什么、多少 token，可临时勾掉某几块。
     * 关键章（比如要收伏笔的那章）值得在这里切一次「人工策稿」。
     * 在设置 → 数据里关掉后就不弹了。 */
    var skip = null;
    if (!opts.noPreview && Store.state.ui.injectPreview !== false) {
      skip = await askInject(b, c);
      if (!skip) return;      // 用户取消
    }

    var ac = new AbortController();
    App.abort = ac;
    UI.busy((rewrite ? 'AI 正在重写… ' : 'AI 正在写作…'), function () { ac.abort(); }, true);
    var last = 0, buf = '';
    try {
      var res = await AI.generateChapter(b, c, {
        signal: ac.signal,
        instruction: instruction,
        rewrite: rewrite,
        skip: skip ? skip.skip : null,
        onPhase: function (p) {
          if (p === 'memory') {
            UI.busyText('正在写入长期记忆…');
            // 流式输出有 160ms 节流，最后一帧可能被跳过；进记忆阶段前先把最新全文
            // 刷进阅读器，否则记忆生成这几秒里正文尾部一直停在旧内容。
            // 这里传 false：正文已经写完了，不再需要「跟随」态（光标闪动也停掉）。
            if (buf && Reader.book && Reader.book.id === b.id && Reader.el && Reader.el.cur) Reader.setLive(buf, false);
          }
        },
        onDelta: function (delta, full) {
          buf = full;
          var t = Date.now();
          if (t - last > 160) {
            last = t;
            UI.busyText('AI 正在写作… ' + AI.wordCount(full) + ' 字');
            if (Reader.book && Reader.book.id === b.id && Reader.el && Reader.el.cur) Reader.setLive(full, true);
          }
        }
      });
      UI.unbusy();
      if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
      if (rewrite) {
        // 重写完成： toast 带「撤销」，一键回滚到重写前
        UI.toast('重写完成：' + AI.wordCount(c.content) + ' 字' + (b.memory.enabled ? '，记忆已更新' : ''), 6000, {
          actionText: '撤销',
          onAction: function () { undoLastAI(b.id); }
        });
      } else {
        UI.toast('完成：' + AI.wordCount(c.content) + ' 字' + (b.memory.enabled ? '，记忆已更新' : ''));
      }
      suggestToast(b, res && res.worldSugIds ? res.worldSugIds.length : 0);
      /* 生成后顺手做一次本地禁词扫描：不花钱、不用网络，
       * 命中了就在 toast 里给个入口（模型偶尔还是会用回套话）。 */
      var banned = (b.styleRules && b.styleRules.banned) || '';
      if (banned.trim()) {
        var hits = Util.scanBanned(c.content || '', banned);
        var totalHits = hits.reduce(function (s, x) { return s + x.count; }, 0);
        if (totalHits) {
          UI.toast('⚠️ 命中禁词 ' + totalHits + ' 处', 6000, {
            actionText: '查看',
            onAction: function () { A['reader.styleCheck'](); }
          });
        }
      }
    } catch (e) {
      UI.unbusy();
      if (e && e.name === 'AbortError') {
        // 中止时 AI.generateChapter 已经处理过快照（有正文就留作可撤回点），
        // 这里只需把「已经流出来的部分」落到正文，不要再补写记忆。
        if (buf) {
          var partial = AI.cleanText(buf);
          if (partial && partial !== c.content) {
            c.content = partial; c.updatedAt = Date.now();
            Store.touchBook(b); Store.save();
          }
        }
        if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
        UI.toast('已中止，已保留生成的部分内容（可点「撤回」还原）');
      } else {
        // 记忆阶段失败但正文已产出：正文保留，提示说明差异
        if (c.content && AI.wordCount(c.content) > 0 && !buf) {
          UI.toast('正文已保留，但记忆写入失败：' + (e && e.message ? e.message : e), 4000);
          if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
        } else {
          UI.fail('生成失败', e);
        }
      }
    } finally {
      App.abort = null;
    }
  }

  async function outlineFlow(bookId, volumeId) {
    var b = Store.getBook(bookId);
    if (!b) return;
    if (!b.volumes.length) { UI.toast('请先创建分卷'); return; }
    if (!volumeId || !Store.getVolume(b, volumeId)) volumeId = b.volumes[b.volumes.length - 1].id;

    var last = { volume: volumeId, count: 5, append: true };

    function openForm() {
      UI.formSheet('AI 自动分章', [
        {
          type: 'html',
          html: '<div class="hint mb12">把分卷大纲拆成若干章，为每章生成一段「章节大纲 prompt」，生成后可在章节列表点「✎ 大纲」逐条修改。<br>本次会带上世界设定、<b>完整的长期记忆</b>（摘要 + 全部章节记忆条目）与<b>最近 3 章正文全文</b>，接着已写的进度往下排。</div>'
        },
        { key: 'volume', type: 'select', label: '依据哪个分卷（生成的章节会挂到该卷下）', value: last.volume, options: volumeOptions(b) },
        { key: 'count', type: 'number', label: '生成章节数', value: last.count, min: 1, max: 60 },
        { key: 'append', type: 'checkbox', label: '追加到本卷末尾（不勾选＝先清空「本卷」现有章节再重写，其他分卷不受影响）', value: last.append }
      ], submit);
    }

    async function submit(v) {
      last = v;
      var n = parseInt(v.count, 10);
      if (!n || n < 1) { UI.toast('请填写章节数量'); return false; }
      var vol = Store.getVolume(b, v.volume) || Store.getVolume(b, volumeId) || b.volumes[0];
      // 清空重写的作用域只限当前分卷，绝不碰其他分卷的章节
      var doomed = !v.append
        ? b.chapters.filter(function (c) { return vol ? c.volumeId === vol.id : !c.volumeId; })
        : [];
      if (doomed.length) {
        var sure = await UI.confirm('清空重写本卷',
          '将删除《' + (vol ? (vol.title || '未命名分卷') : '未归卷') + '》下的 ' + doomed.length +
          ' 个章节（含大纲、正文与该章记忆）。其他分卷的章节不受影响。', '删除并重写', true);
        if (!sure) { openForm(); return false; }
      }
      // 分章会删章节、建章节，绝不能和别的 AI 任务并发
      if (!lockRun('split', '自动分章')) { openForm(); return false; }
      var ac = new AbortController();
      UI.busy('正在拆分章节大纲…', function () { ac.abort(); });
      try {
        var arr = await AI.generateOutlines(b, vol, n, { signal: ac.signal });
        if (!arr.length) { UI.unbusy(); UI.toast('AI 没有返回任何章节'); return false; }
        if (doomed.length) {
          var ids = doomed.map(function (c) { return c.id; });
          b.chapters = b.chapters.filter(function (c) { return ids.indexOf(c.id) < 0; });
          b.memory.entries = b.memory.entries.filter(function (e) { return ids.indexOf(e.chapterId) < 0; });
          b.undoStack = b.undoStack.filter(function (u) { return ids.indexOf(u.chapterId) < 0; });
        }
        arr.forEach(function (x) {
          Store.addChapter(b, { title: x.title, outline: x.outline, volumeId: vol ? vol.id : '' });
        });
        Store.touchBook(b); Store.save();
        UI.unbusy();
        UI.closeSheet();
        UI.toast('已生成 ' + arr.length + ' 章大纲');
        go('#/book/' + bookId + '/chapters');
      } catch (e) {
        UI.unbusy();
        if (e && e.name === 'AbortError') { UI.toast('已中止分章'); return false; }
        UI.fail('分章失败', e);
        return false;
      } finally {
        unlockRun('split');
      }
      return true;
    }

    openForm();
  }

  function undoLastAI(bookId) {
    var b = Store.getBook(bookId);
    if (!b) return;
    if (!b.undoStack.length) { UI.toast('没有可撤回的 AI 生成'); return; }
    var u = Store.popUndo(b);
    var c = Store.getChapter(b, u.chapterId);
    if (c) {
      c.title = u.snapshot.title;
      c.outline = u.snapshot.outline;
      c.content = u.snapshot.content;
      // 框选改稿的快照里还带着当时的意见簿：正文里的框回来了，意见也得跟着回来
      if (u.snapshot.marks) c.marks = JSON.parse(JSON.stringify(u.snapshot.marks));
      c.updatedAt = Date.now();
    }
    /* 记忆回滚分两种：
     * - 新写一章：把这次给本章留下的那条删掉
     * - 重写旧章：把本章原本那条**恢复**回去（不能删，否则撤回后记忆凭空消失）
     * 摘要一律回到本次生成开始前的值。 */
    var entries = b.memory.entries || (b.memory.entries = []);
    var mine = entries.filter(function (e) { return e.chapterId === u.chapterId; });
    if (u.memoryBefore) {
      var keep = mine.filter(function (e) { return e.id === u.memoryBefore.id; })[0];
      if (!keep) {
        keep = { id: u.memoryBefore.id, chapterId: u.chapterId };
        entries.push(keep);
      }
      keep.text = u.memoryBefore.text;
      keep.chapterIndex = u.memoryBefore.chapterIndex;
      keep.chapterTitle = u.memoryBefore.chapterTitle;
      keep.summaryBefore = u.memoryBefore.summaryBefore;
      // 本次生成若另开了新条目（理论上不会，addMemory 已按章去重），一并清掉
      b.memory.entries = entries.filter(function (e) {
        return e.chapterId !== u.chapterId || e.id === u.memoryBefore.id;
      });
    } else if (mine.length) {
      b.memory.entries = entries.filter(function (e) { return e.chapterId !== u.chapterId; });
    }
    // 只改标记处的那种撤回不碰记忆（它本来就没动记忆）
    if (u.kind !== 'patch' && typeof u.summaryBefore === 'string') b.memory.summary = u.summaryBefore;
    // 这次生成顺带推荐出来的设定也一并撤回
    if (u.worldSugIds && u.worldSugIds.length) {
      Store.dismissWorldSuggestions(b, u.worldSugIds);
    }
    Store.touchBook(b); Store.save();
    /* 阅读器里就地重画（整页 route 会把滚动位置与当前页丢掉）；
     * 不在读这本书时整页刷新——书架页的字数、目录里的章节摘要也得跟着变。 */
    if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
    else UI.route();
    UI.toast(u.kind === 'patch' ? '已撤回上次改动' : '已撤回上次 AI 生成，记忆同步回滚');
  }

  /* =========================================================
   * 动作表
   * ========================================================= */
  var A = {};

  A['nav'] = function (el) { go(el.getAttribute('data-to')); };

  /* ---- 全文搜索 ---- */
  A['search.clear'] = function () {
    UI.searchQuery = '';
    UI.renderBooks();
    var el = document.getElementById('searchInput');
    if (el) el.focus();
  };
  /* 结果点击：有章节就直达该章，否则进书本 */
  A['search.goto'] = function (el) {
    var bid = el.getAttribute('data-id');
    var cid = el.getAttribute('data-cid');
    if (bid && cid) { go('#/read/' + bid + '/' + cid); return; }
    if (bid) { go('#/book/' + bid + '/basic'); return; }
  };
  /* 按范围过滤：复用同一份结果，客户端再筛一次 */
  A['search.scope'] = function (el) {
    var scope = el.getAttribute('data-scope') || 'all';
    var q = UI.searchQuery || '';
    if (!q) return;
    var res = AI.search(q, { scope: scope, limit: 200 });
    // 直接把筛过的结果铺到页面上（保持搜索词不变）
    var html = '<div class="search-box">' +
      '<span class="search-ico">🔍</span>' +
      '<input class="input" id="searchInput" type="search" value="' + esc(q) + '" autocomplete="off">' +
      '<button class="icon-btn small" data-act="search.clear" title="清空">✕</button>' +
      '</div>';
    html += '<div class="search-stat">范围：<b>' + esc({ all: '全部', chapter: '正文/大纲', world: '世界设定', memory: '记忆' }[scope]) +
      '</b> · ' + res.total + ' 条' +
      '<div class="row-wrap mt8">' +
      ['all', 'chapter', 'world', 'memory'].map(function (s) {
        return '<button class="btn sm' + (s === scope ? ' primary' : '') + '" data-act="search.scope" data-scope="' + s + '">' +
          { all: '全部', chapter: '正文/大纲', world: '世界设定', memory: '记忆' }[s] + '</button>';
      }).join('') +
      '</div></div>';
    if (!res.total) {
      html += '<div class="empty-tip">该范围内没有匹配内容</div>';
    } else {
      html += '<div class="list">' + res.items.map(function (it) {
        var act = it.chapterId ? 'search.goto' : 'book.open';
        return '<div class="search-hit" data-act="' + act + '" data-id="' + it.bookId + '"' +
          (it.chapterId ? ' data-cid="' + it.chapterId + '"' : '') + '>' +
          '<div class="search-hit-head">' +
          '<span class="chip">' + esc(it.field || it.kind) + '</span>' +
          '<span class="ellipsis tiny muted">' + esc(it.bookTitle) + '</span>' +
          '</div>' +
          '<div class="search-hit-body">' + it.excerpt + '</div>' +
          '</div>';
      }).join('') + '</div>';
    }
    var p = document.getElementById('page');
    p.style.animation = ''; p.innerHTML = html;
    UI.bindSearchInput();
  };

  /* 直接跳到这本书最近阅读 / 编辑的那一章 */
  A['recent.read'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    if (!b) return;
    var c = Store.lastChapter(b);
    if (!c) { UI.toast('这本书还没有章节'); go('#/book/' + b.id + '/outline'); return; }
    go('#/read/' + b.id + '/' + c.id);
  };

  /* ---- 书本 ---- */
  A['book.new'] = function () {
    UI.formSheet('新建作品', [
      { key: 'title', label: '书名', value: '', placeholder: '例如：雾都拾遗' },
      { key: 'genre', label: '类型 / 题材', value: '', placeholder: '例如：都市异能' },
      { key: 'synopsis', type: 'textarea', label: '故事简介（可稍后补充）', value: '' }
    ], function (v) {
      var b = Store.createBook(v.title || '未命名作品');
      if (v.genre) b.genre = v.genre;
      if (v.synopsis) b.synopsis = v.synopsis;
      Store.save();
      go('#/book/' + b.id + '/basic');
    });
  };
  A['book.open'] = function (el) { go('#/book/' + el.getAttribute('data-id') + '/basic'); };
  A['book.chapters'] = function (el) { go('#/book/' + (el.getAttribute('data-id') || bookIdFromHash()) + '/chapters'); };
  A['book.tab'] = function (el) { go('#/book/' + bookIdFromHash() + '/' + el.getAttribute('data-tab')); };
  A['book.menu'] = function (el) {
    var id = el.getAttribute('data-id') || bookIdFromHash();
    var b = Store.getBook(id);
    if (!b) return;
    UI.openSheet({
      title: b.title,
      body: '<div class="list">' +
        '<button class="btn block" data-act="book.rename" data-id="' + id + '">重命名</button>' +
        '<button class="btn block" data-act="book.dup" data-id="' + id + '">复制一本（含全部内容）</button>' +
        '<button class="btn block" data-act="book.export" data-id="' + id + '">导出 JSON（可再导入）</button>' +
        '<button class="btn block" data-act="book.exportTxt" data-id="' + id + '">导出正文 TXT</button>' +
        '<button class="btn block" data-act="book.exportMd" data-id="' + id + '">导出 Markdown</button>' +
        '<button class="btn block" data-act="book.stats" data-id="' + id + '">📊 写作统计</button>' +
        '<button class="btn block" data-act="book.archive" data-id="' + id + '">📦 归档导出（导出后从本机移除）</button>' +
        '<button class="btn block danger" data-act="book.delete" data-id="' + id + '">删除这本书</button>' +
        '<div class="card small muted">数据存在浏览器本地存储里（通常有 5~10MB 上限）。' +
        '长篇写到后面如果提示容量不足，「归档导出」会把这本书完整存成文件再从本机移除，' +
        '书架变轻，需要时可随时导入回来。</div>' +
        '</div>'
    });
  };

  /* 归档：先导出 JSON，确认文件拿到了再从本机删除。
   * 顺序不能反——万一导出失败，数据还在。 */
  A['book.archive'] = async function (el) {
    var id = el.getAttribute('data-id') || bookIdFromHash();
    var b = Store.getBook(id);
    if (!b) return;
    var words = b.chapters.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0);
    var ok = await UI.confirm('归档导出',
      '将导出《' + b.title + '》（' + b.chapters.length + ' 章 · ' + fmtNum(words) + ' 字）的完整 JSON，' +
      '然后把它从本机移除以释放空间。\n\n导出的文件随时可以用「导入书本 JSON」还原。', '导出并移除');
    if (!ok) return;
    Store.flush();
    var data = JSON.stringify({ books: [b], exportedAt: Date.now() }, null, 2);
    Util.download(data, Util.safeFilename('归档-' + b.title, 'archive') + '.json');
    Store.deleteBook(id);
    UI.closeSheet();
    UI.toast('已归档并从本机移除');
    UI.route();
  };

  /* 写作统计：全书 / 分卷 / 章节三个维度看进度 */
  A['book.stats'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    if (!b) return;
    var total = b.chapters.length;
    var done = b.chapters.filter(function (c) { return c.content && c.content.trim(); }).length;
    var words = b.chapters.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0);
    var target = (b.targetWordsPerChapter || 0) * total;
    var rows = b.volumes.map(function (v) {
      var chs = b.chapters.filter(function (c) { return c.volumeId === v.id; });
      var w = chs.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0);
      var d = chs.filter(function (c) { return c.content && c.content.trim(); }).length;
      return '<tr><td>' + esc(v.title || '未命名') + '</td><td>' + chs.length + '</td>' +
        '<td>' + d + '/' + chs.length + '</td><td>' + fmtNum(w) + '</td></tr>';
    }).join('');

    UI.openSheet({
      title: '写作统计 · ' + b.title,
      body:
        '<div class="stat-grid">' +
        '<div class="stat-cell"><b>' + fmtNum(words) + '</b><span>总字数</span></div>' +
        '<div class="stat-cell"><b>' + done + '/' + total + '</b><span>已写章节</span></div>' +
        '<div class="stat-cell"><b>' + (total ? Math.round(done / total * 100) : 0) + '%</b><span>完成度</span></div>' +
        '<div class="stat-cell"><b>' + fmtNum(total ? Math.round(words / total) : 0) + '</b><span>平均章字数</span></div>' +
        '</div>' +
        (target ? '<div class="hint mb12">按每章目标 ' + fmtNum(b.targetWordsPerChapter) +
          ' 字估算，全书目标约 ' + fmtNum(target) + ' 字，当前完成 ' +
          Math.round(words / target * 100) + '%。</div>' : '') +
        (b.volumes.length ? '<div class="section-title" style="margin-top:6px">分卷明细</div>' +
          '<div class="table-wrap"><table class="mini-table"><thead><tr>' +
          '<th>分卷</th><th>章数</th><th>已写</th><th>字数</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>' : '') +
        (function () {
          var empty = b.chapters.filter(function (c) { return !c.content || !c.content.trim(); });
          if (!empty.length) return '<div class="hint mt12">全部章节都已写正文。</div>';
          return '<div class="section-title">待写章节（' + empty.length + '）</div>' +
            '<div class="hint">' + empty.slice(0, 30).map(function (c) {
              return '第' + (Store.chapterIndex(b, c.id) + 1) + '章';
            }).join('、') + (empty.length > 30 ? ' 等' : '') + '</div>';
        })(),
      buttons: [{ text: '知道了', cls: 'primary' }]
    });
  };
  A['book.rename'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    UI.formSheet('重命名', [{ key: 'title', label: '书名', value: b.title }], function (v) {
      b.title = v.title || b.title; Store.touchBook(b); Store.save(); UI.route();
    });
  };
  A['book.dup'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    var copy = JSON.parse(JSON.stringify(b));
    copy.id = Store.uid();
    copy.title = b.title + '（副本）';
    copy.createdAt = Date.now(); copy.updatedAt = Date.now();
    copy.undoStack = [];
    Store.state.books.unshift(copy); Store.save();
    UI.closeSheet(); UI.toast('已复制'); UI.route();
  };
  A['book.delete'] = async function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    var ok = await UI.confirm('删除作品', '《' + b.title + '》及其全部章节、记忆将被永久删除，无法恢复。', '删除', true);
    if (!ok) return;
    Store.deleteBook(b.id); UI.closeSheet(); go('#/books');
  };
  A['book.togglePrompt'] = function (el) {
    var b = curBook(); if (!b) return;
    var pid = el.getAttribute('data-id');
    var i = b.globalPromptIds.indexOf(pid);
    if (i >= 0) b.globalPromptIds.splice(i, 1); else b.globalPromptIds.push(pid);
    Store.touchBook(b); Store.save(); UI.route();
  };
  A['book.export'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    if (!b) return;
    download(Store.exportBook(b.id), Util.safeFilename(b.title, 'book') + '.json');
  };
  /* 导出 TXT：可选是否带分卷结构与章节大纲。
   * 原来的实现把分卷结构整个丢掉，且不支持长文分卷产出，
   * 导出后还得手工排版。
   */
  A['book.exportTxt'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    if (!b) return;
    UI.formSheet('导出正文 TXT', [
      {
        type: 'html',
        html: '<div class="hint mb12">共 ' + b.chapters.length + ' 章 · ' +
          Util.fmtNum(b.chapters.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0)) + ' 字</div>'
      },
      { key: 'withVolume', type: 'checkbox', label: '保留分卷结构（插入「第N卷」标题）', value: true },
      { key: 'withOutline', type: 'checkbox', label: '在每章正文前附上章节大纲', value: false },
      { key: 'onlyDone', type: 'checkbox', label: '只导出已写正文的章节', value: false }
    ], function (v) {
      download(buildBookText(b, {
        withVolume: v.withVolume, withOutline: v.withOutline, onlyDone: v.onlyDone
      }), Util.safeFilename(b.title, 'book') + '.txt', 'text/plain');
      UI.toast('已导出 TXT');
    });
  };
  /* 导出 Markdown：适合继续用编辑器排版 / 发布 */
  A['book.exportMd'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    if (!b) return;
    var name = Util.safeFilename(b.title, 'book');
    var lines = ['# ' + (b.title || '未命名作品'), ''];
    if (b.author) lines.push('- 作者：' + b.author);
    if (b.genre) lines.push('- 类型：' + b.genre);
    lines.push('- 共 ' + b.chapters.length + ' 章 · ' +
      Util.fmtNum(b.chapters.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0)) + ' 字');
    lines.push('');
    if (b.synopsis) lines.push('> ' + String(b.synopsis).replace(/\n/g, '\n> '), '');

    var order = [];
    b.volumes.forEach(function (v) {
      order.push({ vol: v, chapters: b.chapters.filter(function (c) { return c.volumeId === v.id; }) });
    });
    var orphan = b.chapters.filter(function (c) { return !c.volumeId; });
    if (orphan.length) order.push({ vol: null, chapters: orphan });

    var n = 0;
    order.forEach(function (g) {
      if (g.vol) lines.push('## 第' + (Store.volumeIndex(b, g.vol.id) + 1) + '卷 ' + (g.vol.title || '未命名'), '');
      if (g.vol && g.vol.summary) lines.push('> ' + String(g.vol.summary).replace(/\n/g, '\n> '), '');
      g.chapters.forEach(function (c) {
        n++;
        lines.push('### 第' + n + '章 ' + (c.title || ''), '');
        if (c.outline) lines.push('<!-- 大纲：' + String(c.outline).replace(/-->/g, '—>') + ' -->', '');
        lines.push((c.content || '（本章暂无正文）'), '');
      });
    });
    download(lines.join('\n'), name + '.md', 'text/markdown');
    UI.toast('已导出 Markdown');
  };
  A['book.import'] = function () {
    pickFile(function (txt) {
      try { var b = Store.importBook(txt); UI.toast('已导入《' + b.title + '》'); go('#/book/' + b.id + '/basic'); }
      catch (e) { UI.toast('导入失败：' + e.message); }
    });
  };

  /* ---- 世界书 ---- */
  A['world.tab'] = function (el) {
    UI.worldTab[bookIdFromHash()] = el.getAttribute('data-cat');
    UI.route();
  };
  /* 作用域切换：'' = 全局；分卷 id = 只对该分卷生效 */
  A['world.scope'] = function (el) {
    UI.worldScope[bookIdFromHash()] = el.getAttribute('data-scope') || '';
    UI.route();
  };
  /* 触发式注入：关键词（别名）与常驻开关。
   * 中文网文一个人五六个称呼是常态，别名填全了才不会因为叫错名字而漏注入。 */
  function worldEntryExtraFields(b, cat, e) {
    e = e || {};
    var fields = [
      {
        key: 'keywords', label: '触发词 / 别名（可选）', value: e.keywords || '',
        placeholder: '逗号或换行分隔，如：林昭,小林,林家主',
        hint: '不填 = 始终注入（旧行为）。填了之后，只有本章大纲 / 标题 / 上一章结尾里出现这些词时才会注入——省 token，也避免无关设定干扰。'
      },
      { key: 'pin', type: 'checkbox', label: '常驻：无视触发词，每次都注入', value: !!e.pin }
    ];
    /* 角色卡：人物栏额外的结构化字段，注入时附加在内容后面，
     * 比散在自由文本里更好维护，也方便模型稳定抽取。 */
    if (cat === 'characters') {
      fields.push(
        { type: 'html', html: '<div class="hint mt12">角色卡（选填，注入时附加在内容后）</div>' },
        { key: 'state', label: '当前状态 / 境界', value: e.state || '', placeholder: '如：重伤未愈，灵力只剩三成' },
        { key: 'location', label: '所在位置', value: e.location || '', placeholder: '如：黑石城牢房' },
        { key: 'goal', label: '当前目标', value: e.goal || '', placeholder: '如：找到密信上的接头人' },
        { key: 'knows', label: '已知信息', value: e.knows || '', placeholder: '如：知道密信内容，但不知道对方长相' },
        { key: 'relations', label: '人物关系', value: e.relations || '', placeholder: '如：与城主是师徒，表面恭敬' }
      );
    }
    return fields;
  }

  A['world.add'] = function (el) {
    var cat = el.getAttribute('data-cat');
    var scope = el.getAttribute('data-scope') || '';
    var b = curBook();
    UI.formSheet('新增「' + AI.WORLD_LABEL[cat] + '」' + (scope ? '（' + Store.worldScopeLabel(b, scope) + '专属）' : ''), [
      { key: 'name', label: '名称', value: '', placeholder: cat === 'characters' ? '如：林昭（男主）' : '如：黑石城' },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: '', placeholder: '越具体越好，AI 会原样注入上下文' }
    ].concat(worldEntryExtraFields(b, cat, {})), function (v) {
      Store.addWorldEntry(b, cat, v.name, v.content, scope, v);
      UI.route();
    });
  };
  A['world.edit'] = function (el) {
    var b = curBook(), cat = el.getAttribute('data-cat');
    var e = Store.getWorldEntry(b, cat, el.getAttribute('data-id'));
    if (!e) return;
    UI.formSheet('编辑条目', [
      { key: 'name', label: '名称', value: e.name },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: e.content },
      {
        key: 'scope', type: 'select', label: '归属（全局 / 分卷）', value: e.scope || '',
        options: scopeOptions(b),
        hint: '改归属随时生效：选「全局」对全书生效，选某分卷则只在该卷章节生成时注入。'
      }
    ].concat(worldEntryExtraFields(b, cat, e)), function (v) {
      var oldScope = e.scope || '';
      e.name = v.name; e.content = v.content;
      e.scope = v.scope || '';
      e.keywords = (v.keywords || '').trim();
      e.pin = !!v.pin;
      if (cat === 'characters') {
        ['state', 'location', 'goal', 'knows', 'relations'].forEach(function (k) {
          e[k] = (v[k] || '').trim();
        });
      }
      e.updatedAt = Date.now();
      Store.touchBook(b); Store.save();
      if (oldScope !== (v.scope || '')) {
        UI.toast('「' + (v.name || '条目') + '」已改为' + (v.scope ? Store.worldScopeLabel(b, v.scope) + '专属' : '全局'));
      }
      UI.route();
    });
  };
  /* 分卷视图下把全局条目复制一份到本卷：之后可单独改写，不动全局原文 */
  A['world.copyToVol'] = function (el) {
    var b = curBook(), cat = el.getAttribute('data-cat');
    var scope = el.getAttribute('data-scope') || '';
    var e = Store.getWorldEntry(b, cat, el.getAttribute('data-id'));
    if (!e || !scope) return;
    Store.addWorldEntry(b, cat, e.name, e.content, scope);
    Store.touchBook(b); Store.save();
    UI.toast('已复制到本卷，可单独修改（全局原文不变）');
    UI.route();
  };
  A['world.toggle'] = function (el) {
    var b = curBook(), cat = el.getAttribute('data-cat');
    var e = Store.getWorldEntry(b, cat, el.getAttribute('data-id'));
    e.enabled = e.enabled === false; Store.touchBook(b); Store.save(); UI.route();
  };
  /* 章节目录 / 阅读页：浏览全部世界设定 */
  A['world.browse'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id') || bookIdFromHash());
    if (!b) return;
    UI.openSheet({
      title: '世界设定',
      body: UI.renderWorldBrowse(b),
      buttons: [
        { text: '去世界设定页编辑', cls: '', onClick: function () { go('#/book/' + b.id + '/world'); return true; } },
        { text: '关闭', cls: 'primary' }
      ]
    });
  };

  /* ---- 伏笔板 ----
   * 长线伏笔最容易烂尾：埋的时候记得，写到二三十章就忘了。
   * 这里把它当结构化数据存（埋设章 / 计划回收章 / 状态），
   * 写正文时自动注入未回收项，逾期未回收的在列表里高亮提醒。
   */
  A['hook.add'] = function () {
    var b = curBook();
    if (!b) return;
    var idx = b.chapters.length + 1;
    UI.formSheet('新增伏笔', [
      { key: 'content', type: 'textarea', tall: true, label: '伏笔内容', value: '', placeholder: '如：林昭腰间的旧玉佩，刻着不认识的纹路' },
      { key: 'fromChapter', label: '埋设章（第几章）', value: String(idx), placeholder: '留空 = 未指定' },
      { key: 'planChapter', label: '计划回收章（第几章）', value: '', placeholder: '留空 = 暂不定时机' },
      { key: 'note', label: '备注（可选）', value: '', placeholder: '如：回收时要点明玉佩来自星图一族' }
    ], function (v) {
      if (!String(v.content || '').trim()) { UI.toast('伏笔内容不能为空'); return false; }
      Store.addHook(b, v);
      UI.route();
    });
  };
  A['hook.edit'] = function (el) {
    var b = curBook();
    var h = (b.hooks || []).filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
    if (!h) return;
    UI.formSheet('编辑伏笔', [
      { key: 'content', type: 'textarea', tall: true, label: '伏笔内容', value: h.content },
      { key: 'fromChapter', label: '埋设章（第几章）', value: h.fromChapter ? String(h.fromChapter) : '' },
      { key: 'planChapter', label: '计划回收章（第几章）', value: h.planChapter ? String(h.planChapter) : '' },
      {
        key: 'status', type: 'select', label: '状态', value: h.status || 'open',
        options: [{ value: 'open', label: '未回收' }, { value: 'resolved', label: '已回收' }, { value: 'dropped', label: '已放弃' }]
      },
      { key: 'note', label: '备注（可选）', value: h.note || '' }
    ], function (v) {
      Store.updateHook(b, h.id, {
        content: v.content, fromChapter: v.fromChapter, planChapter: v.planChapter,
        status: v.status, note: v.note
      });
      UI.route();
    });
  };
  A['hook.resolve'] = function (el) {
    var b = curBook();
    Store.updateHook(b, el.getAttribute('data-id'), { status: 'resolved' });
    UI.toast('已标记为回收'); UI.route();
  };
  A['hook.reopen'] = function (el) {
    var b = curBook();
    Store.updateHook(b, el.getAttribute('data-id'), { status: 'open' });
    UI.route();
  };
  A['hook.del'] = async function (el) {
    var b = curBook();
    var h = (b.hooks || []).filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
    if (!h) return;
    var okDel = await UI.confirm('删除伏笔', '删除后无法恢复：\n' + h.content.slice(0, 60));
    if (!okDel) return;
    Store.removeHook(b, h.id); UI.route();
  };

  /* =========================================================
   * AI 小编：一轮对话一次请求
   * 小编**不直接写库**——它把改动写成 actions 提案，作者勾选后才落地，
   * 落地时记一条事务，随时能整批退回。
   * ========================================================= */
  /* 从阅读页跳过来：顺手把上下文切到正在读的这一章 */
  A['chat.fromReader'] = function () {
    var b = curBook();
    if (!b) return;
    var c = Reader.chapter;
    if (c) { b.chatChapterId = c.id; Store.touchBook(b); Store.save(); }
    UI.closeSheet();
    go('#/book/' + b.id + '/chat');
  };

  A['chat.pick'] = function () {
    var b = curBook();
    if (!b) return;
    if (!b.chapters.length) { UI.toast('这本书还没有章节'); return; }
    var cur = (b.chatChapterId || '');
    UI.openSheet({
      title: '小编以哪一章为上下文',
      body: '<div class="hint mb8">和写正文时看到的是同一份上下文（只含该章之前的内容）。</div>' +
        '<div class="list">' + b.chapters.map(function (c, i) {
          return '<button class="btn block' + (c.id === cur ? ' primary' : '') + '" data-act="chat.setCtx" data-id="' + c.id + '">' +
            '第' + (i + 1) + '章' + (c.title ? ' · ' + esc(c.title) : '') +
            (c.content ? '' : '（无正文）') + '</button>';
        }).join('') + '</div>',
      buttons: [{ text: '关闭' }]
    });
  };
  A['chat.setCtx'] = function (el) {
    var b = curBook();
    if (!b) return;
    b.chatChapterId = el.getAttribute('data-id');
    Store.touchBook(b); Store.save();
    UI.closeSheet(); UI.route();
  };

  A['chat.clear'] = function () {
    var b = curBook();
    if (!b) return;
    var n = (b.chat || []).length;
    if (!n) { UI.toast('还没有对话'); return; }
    UI.confirm('清空对话', '丢弃这 ' + n + ' 条对话记录？（已经应用过的改动不受影响）', '清空', true).then(function (ok) {
      if (!ok) return;
      Store.clearChat(b);
      UI.route();
      UI.toast('已清空对话');
    });
  };

  A['chat.send'] = async function () {
    var b = curBook();
    if (!b) return;
    var ta = document.getElementById('chatText');
    var q = ta ? String(ta.value || '').trim() : '';
    if (!q) { UI.toast('先说点什么'); return; }
    var c = b.chatChapterId ? Store.getChapter(b, b.chatChapterId) : null;
    if (!c) c = b.chapters[b.chapters.length - 1] || b.chapters[0] || null;
    if (!c) { UI.toast('这本书还没有章节，先建一章'); return; }
    if (!lockRun('editor', '小编对话')) return;

    Store.addChat(b, { role: 'user', text: q, ctx: c.id });
    if (ta) ta.value = '';
    UI.route();
    await sleep0();
    scrollChatToEnd();

    /* 流式：先把回复气泡挂上去，边收边改。onDelta 拿到的已经是
     * 「切掉 actions 代码块」的可见文本，所以不会把半截 JSON 闪给用户看。 */
    var holder = document.createElement('div');
    holder.className = 'chat-msg ai';
    holder.innerHTML = '<div class="chat-bubble cursor-blink"></div>';
    var list = document.getElementById('chatList');
    if (list) { list.appendChild(holder); scrollChatToEnd(); }
    var bubble = holder.querySelector('.chat-bubble');

    var ac = new AbortController();
    UI.busy('小编正在读你的书…', function () { ac.abort(); });
    try {
      var r = await AI.askEditor(b, c, q, {
        signal: ac.signal,
        onDelta: function (delta, visible) {
          if (bubble) bubble.textContent = visible;
          scrollChatToEnd();
        }
      });
      UI.unbusy();
      if (holder.remove) holder.remove();
      Store.addChat(b, { role: 'ai', text: r.text, actions: r.actions, ctx: c.id });
      if (r.note) UI.toast(r.note);
      else if (r.actions.length) UI.toast('小编提了 ' + r.actions.length + ' 条改动建议');
      UI.route();
      await sleep0();
      scrollChatToEnd();
    } catch (e) {
      UI.unbusy();
      if (holder.remove) holder.remove();
      if (e && e.name === 'AbortError') { UI.toast('已中止'); }
      else {
        Store.addChat(b, { role: 'ai', text: '（出错了：' + (e && e.message ? e.message : String(e)) + '）' });
        UI.route();
      }
    } finally {
      unlockRun('editor');
    }
  };

  /* 找到某条 AI 消息里的一条提案（按当前数据重新解析，索引可能已经变了） */
  function chatPick(b, mid, idx) {
    var m = (b.chat || []).filter(function (x) { return x.id === mid; })[0];
    if (!m) return null;
    var props = Store.resolveEditorActions(b, m.actions || []);
    return { m: m, props: props, p: props[idx], idx: idx };
  }

  /* 预览：把这一条的改前改后完整展开（默认只显示一行，长了看不全） */
  A['chat.preview'] = function (el) {
    var b = curBook();
    if (!b) return;
    var got = chatPick(b, el.getAttribute('data-mid'), parseInt(el.getAttribute('data-idx'), 10));
    if (!got || !got.p || !got.p.raw) return;
    got.p.raw.__open = !got.p.raw.__open;
    Store.touchBook(b); Store.save();
    UI.route();
  };

  /* 修改：编辑这条建议的内容，改完只影响这一条 */
  A['chat.editAct'] = function (el) {
    var b = curBook();
    if (!b) return;
    var got = chatPick(b, el.getAttribute('data-mid'), parseInt(el.getAttribute('data-idx'), 10));
    if (!got || !got.p) return;
    var p = got.p, act = got.m.actions[got.idx];
    if (!p.ok && !p.editKind) { UI.toast('这一条改不了：' + p.reason); return; }
    if (!p.editKind) { UI.toast('这一条没有可编辑的内容'); return; }
    UI.editFullText(p.editHint || '修改这条建议', p.editValue, function (val) {
      if (!String(val || '').trim()) { UI.toast('内容不能为空'); return; }
      if (p.editKind === 'kv') {
        // 逐行「键=值」：标题= / 大纲= / 回收= / 状态= / 备注=
        Store.applyEditorEdit(act, val);
      } else {
        act.content = String(val).trim();
      }
      Store.updateChatActions(b, got.m.id, got.m.actions);
      UI.route();
      UI.toast('已改，记得点「应用」');
    });
  };

  /* 忽略：把这条从建议列表里去掉（数据不动） */
  A['chat.drop'] = function (el) {
    var b = curBook();
    if (!b) return;
    var got = chatPick(b, el.getAttribute('data-mid'), parseInt(el.getAttribute('data-idx'), 10));
    if (!got || !got.m) return;
    got.m.actions.splice(got.idx, 1);
    Store.updateChatActions(b, got.m.id, got.m.actions);
    UI.route();
    UI.toast('已忽略这一条');
  };

  function applyChatProps(b, m, chosen) {
    var label = '小编：' + clipText(m.text, 18);
    var txn = Store.applyEditorActions(b, chosen, label);
    if (!txn) { UI.toast('没有可应用的改动'); return null; }
    return txn;
  }

  /* 应用单条：改完立刻从建议里摘掉，其余条目不受影响 */
  A['chat.applyOne'] = function (el) {
    var b = curBook();
    if (!b) return;
    var got = chatPick(b, el.getAttribute('data-mid'), parseInt(el.getAttribute('data-idx'), 10));
    if (!got || !got.p) return;
    if (!got.p.ok) { UI.toast('这一条现在无法定位：' + got.p.reason); UI.route(); return; }
    var txn = applyChatProps(b, got.m, [got.p]);
    if (!txn) return;
    got.m.actions.splice(got.idx, 1);
    Store.updateChatActions(b, got.m.id, got.m.actions);
    UI.route();
    UI.toast('已应用：' + got.p.title, 5000, {
      actionText: '撤销',
      onAction: function () { Store.undoTxn(b, txn.id); UI.route(); UI.toast('已撤销'); }
    });
  };

  /* 一次性应用这一轮里的全部可用条目 */
  A['chat.apply'] = function (el) {
    var b = curBook();
    if (!b) return;
    var mid = el.getAttribute('data-id');
    var m = (b.chat || []).filter(function (x) { return x.id === mid; })[0];
    if (!m) return;
    var props = Store.resolveEditorActions(b, m.actions || []);
    var chosen = props.filter(function (p) { return p.ok; });
    if (!chosen.length) { UI.toast('这些建议现在都无法定位，刷新后再看看'); UI.route(); return; }
    UI.confirm('应用全部', '把这一轮里可用的 ' + chosen.length + ' 条改动一起写入？（之后可以整批撤销）', '应用').then(function (ok) {
      if (!ok) return;
      var txn = applyChatProps(b, m, chosen);
      if (!txn) return;
      var doneIds = chosen.map(function (p) { return p.idx; });
      m.actions = m.actions.filter(function (a, i) { return doneIds.indexOf(i) < 0; });
      Store.updateChatActions(b, m.id, m.actions);
      UI.route();
      UI.toast('已应用 ' + txn.changes.length + ' 项改动', 5000, {
        actionText: '撤销',
        onAction: function () { Store.undoTxn(b, txn.id); UI.route(); UI.toast('已撤销这次改动'); }
      });
    });
  };

  A['chat.undoTxn'] = function (el) {
    var b = curBook();
    if (!b) return;
    var t = (b.txns || []).filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
    if (!t) return;
    UI.confirm('撤销这次改动', '把「' + clipText(t.label, 30) + '」的 ' + t.changes.length + ' 项改动退回原样？', '撤销', true).then(function (ok) {
      if (!ok) return;
      Store.undoTxn(b, t.id);
      UI.route();
      UI.toast('已撤销，数据已退回');
    });
  };

  function clipText(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }
  function sleep0() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function scrollChatToEnd() {
    var list = document.getElementById('chatList');
    if (list) list.scrollTop = list.scrollHeight;
    /* 用属性赋值而不是 window.scrollTo()：后者在无头环境里会抛「Not implemented」
     * 并污染控制台/测试的错误收集。 */
    var de = document.documentElement;
    if (de) de.scrollTop = de.scrollHeight;
  }

  /* =========================================================
   * 框选改稿：正文里用【【】】框住要改的地方 → AI 只改这些地方
   * 和「AI 重写」的区别：重写会整章重来，这里没框的地方一个字不动。
   *
   * 为什么不用浏览器选区：选区的 DOM Range 与原文偏移换算在移动端
   * （换行、软键盘、手势翻页叠加）太不可靠。框选是纯文本层面的，
   * 作者在正文编辑里自己加，所见即所得，也不怕正文以后被改动。
   * ========================================================= */

  function cloneMarks(marks) {
    return JSON.parse(JSON.stringify(marks || []));
  }
  function markChapter(b) {
    return Reader.book && Reader.book.id === b.id ? Reader.chapter : null;
  }

  function showMarkList(b, c) {
    Store.pruneBracketNotes(b, c);
    var items = Store.bracketItems(c);
    if (!items.length) {
      UI.openSheet({
        title: '框选改稿',
        body: '<div class="hint">还没有框。<br><br>' +
          '打开「编辑」正文，用 <b>【【</b> 和 <b>】】</b> 把要改的地方框起来，比如：<br><br>' +
          '<div class="card small">雨点砸在石板路上，他没有撑伞，【【连鞋都没湿】】。</div><br>' +
          '保存后回到这里，每个框就是一条，可以分别写修改意见；点「按意见修改」后 AI 只重写框里的内容，' +
          '其余部分一个字不动，方括号也会自动去掉。</div>',
        buttons: [
          {
            text: '去正文里加框', cls: 'primary', onClick: function () {
              go('#/read/' + b.id + '/' + c.id);
              setTimeout(function () {
                var el = { getAttribute: function () { return c.id; } };
                A['chapter.editContent'](el);
              }, 120);
              return true;
            }
          },
          { text: '关闭' }
        ]
      });
      return;
    }
    var rows = items.map(function (it, i) {
      return '<div class="entry">' +
        '<div class="entry-head"><div class="entry-name">#' + (i + 1) + ' · ' + it.anchor.length + ' 字</div></div>' +
        '<div class="entry-body">' + esc(it.anchor) + '</div>' +
        /* 意见框就放在条目下面（不全屏）——填完点「按意见修改」即可 */
        '<input class="input mt8" data-mark-note="' + i + '" value="' + esc(it.note) + '"' +
        ' placeholder="这处想怎么改？（留空 = 按上下文润色）">' +
        '<div class="row-wrap mt8">' +
        '<button class="btn sm ghost" data-act="mark.goto" data-idx="' + i + '">↧ 在正文里定位</button>' +
        '</div></div>';
    }).join('');
    UI.openSheet({
      title: '框选改稿 · ' + items.length + ' 处',
      body: '<div class="hint mb8">AI 只会重写这些框里的内容，本章其余部分一个字不动；应用后方括号会自动去掉。' +
        '意见框里改完直接点下面的「按意见修改」。</div>' + rows,
      focus: false,
      buttons: [
        { text: '取消标记', cls: 'ghost', onClick: function () { A['mark.clear'](); return false; } },
        { text: '关闭' },
        { text: '✨ 按意见修改', cls: 'primary', onClick: function () { A['mark.apply'](); return false; } }
      ]
    });
  }

  A['mark.list'] = function () {
    var b = curBook(), c = b && markChapter(b);
    if (!b || !c) return;
    showMarkList(b, c);
  };

  /* 点正文里的高亮 → 打开意见面板（定位到那一处） */
  A['mark.tap'] = function () {
    A['mark.list']();
  };

  /* 意见框失焦即存：不重新渲染，免得把焦点抢走 */
  A['mark.setNote'] = function (el) {
    var b = curBook(), c = b && markChapter(b);
    if (!b || !c) return;
    var i = parseInt(el.getAttribute('data-mark-note'), 10);
    if (isNaN(i)) return;
    Store.setBracketNote(b, c, i, el.value);
    el.classList.add('saved');
    setTimeout(function () { el.classList.remove('saved'); }, 600);
  };

  A['mark.goto'] = function (el) {
    var i = parseInt(el.getAttribute('data-idx'), 10);
    UI.closeSheet();
    var m = document.querySelector('.reader-content mark[data-idx="' + i + '"]');
    if (m && m.scrollIntoView) {
      try { m.scrollIntoView({ block: 'center' }); } catch (e) { m.scrollIntoView(); }
      m.classList.add('mk-flash');
      setTimeout(function () { m.classList.remove('mk-flash'); }, 1200);
    } else {
      UI.toast('正文里找不到这一处，可能已经被改掉了');
    }
  };

  A['mark.clear'] = function () {
    var b = curBook(), c = b && markChapter(b);
    if (!b || !c) return;
    var n = Reader.liveMarkCount(c);
    UI.confirm('取消标记',
      '把正文里这 ' + n + ' 处【【】】去掉（框里的文字保留），已填的修改意见一并清空。正文内容本身不变。',
      '取消标记', true).then(function (ok) {
        if (!ok) { showMarkList(b, c); return; }
        // 存个撤回点：去掉方括号也是一次正文改动
        Store.pushUndo(b, c, '', (b.memory && b.memory.summary) || '',
          { title: c.title, outline: c.outline, content: c.content, marks: cloneMarks(c.marks) }, [], null, 'patch');
        Store.clearBracketMarks(b, c);
        UI.closeSheet();
        if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
        UI.toast('已去掉 ' + n + ' 处方括号', 4000, {
          actionText: '撤销', onAction: function () { undoLastAI(b.id); }
        });
      });
  };

  A['mark.apply'] = async function () {
    var b = curBook(), c = b && markChapter(b);
    if (!b || !c) return;
    Store.pruneBracketNotes(b, c);
    var items = Store.bracketItems(c);
    if (!items.length) { UI.toast('正文里没有【【】】框，先加框再改'); return; }
    if (!lockRun('patch', '框选改稿')) return;
    var ac = new AbortController();
    UI.closeSheet();
    UI.busy('AI 正在改这 ' + items.length + ' 处…', function () { ac.abort(); });
    try {
      var patches = await AI.patchChapter(b, c, items.map(function (it) {
        return { id: it.id, anchor: it.anchor, note: it.note };
      }), { signal: ac.signal });
      UI.unbusy();
      if (!patches || !patches.length) { UI.toast('AI 没有返回可用的修改'); return; }
      // 落库前先存快照，改完能一键撤回
      Store.pushUndo(b, c, '', (b.memory && b.memory.summary) || '',
        { title: c.title, outline: c.outline, content: c.content, marks: cloneMarks(c.marks) }, [], null, 'patch');
      var res = Util.applyBracketPatches(c.content, items, patches);
      if (!res.applied.length) { UI.toast('AI 返回的内容没有对上任何一处'); return; }
      c.content = res.text;
      c.updatedAt = Date.now();
      /* 改过的那些框没了，其意见一并不需要了（撤销时靠快照恢复）；
       * 没对上的框还在，意见要留着方便重试——交给 prune 按框的现状决定。 */
      Store.pruneBracketNotes(b, c);
      Store.touchBook(b); Store.save();
      if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
      else UI.route();
      var left = res.skipped.length;
      UI.toast('已改 ' + res.applied.length + ' 处' + (left ? '，' + left + ' 处没对上（框还在，可重试）' : '') +
        '，方括号已去掉，其余内容未动', 5000, {
        actionText: '撤销', onAction: function () { undoLastAI(b.id); }
      });
    } catch (e) {
      UI.unbusy();
      if (e && e.name === 'AbortError') { UI.toast('已中止修改'); return; }
      UI.fail('修改失败', e);
    } finally {
      unlockRun('patch');
    }
  };

  /* ---- 写后一致性审计 ----
   * 模型写错了人工未必看得出，但拿设定和记忆逐条比对能捞回大部分硬伤。
   * 默认不自动跑（要花钱），需要时在阅读页 ⋮ 菜单里手动触发。 */
  A['reader.audit'] = async function () {
    var b = curBook(), c = Reader.chapter;
    if (!b || !c) return;
    if (!c.content || !c.content.trim()) { UI.toast('本章还没有正文，先写一版再审计'); return; }
    if (!lockRun('audit', '一致性审计')) return;
    var ac = new AbortController();
    UI.closeSheet();
    UI.busy('正在对照设定与记忆检查…', function () { ac.abort(); });
    try {
      var issues = await AI.auditChapter(b, c, { signal: ac.signal });
      UI.unbusy();
      if (!issues.length) {
        UI.openSheet({
          title: '一致性审计',
          body: '<div class="empty-tip">没有发现矛盾 🎉</div>' +
            '<div class="hint">已对照：世界设定（全局 + 本章所属分卷）、长期记忆与章节记忆。</div>',
          buttons: [{ text: '关闭', cls: 'primary' }]
        });
        return;
      }
      UI.openSheet({
        title: '一致性审计 · ' + issues.length + ' 处',
        body: '<div class="hint mb8">以下为 AI 对照设定与记忆的比对结果，仅供参考，改不改你自己判断。</div>' +
          issues.map(function (x, i) {
            return '<div class="card mb8">' +
              '<div class="row-wrap"><span class="chip on">' + esc(x.type) + '</span>' +
              '<span class="tiny muted">#' + (i + 1) + '</span></div>' +
              (x.quote ? '<div class="mt8"><div class="tiny muted">正文</div><div>' + esc(x.quote) + '</div></div>' : '') +
              (x.against ? '<div class="mt8"><div class="tiny muted">冲突对象</div><div>' + esc(x.against) + '</div></div>' : '') +
              (x.suggest ? '<div class="mt8"><div class="tiny muted">建议</div><div>' + esc(x.suggest) + '</div></div>' : '') +
              '</div>';
          }).join(''),
        buttons: [{ text: '关闭', cls: 'primary' }]
      });
    } catch (e) {
      UI.unbusy();
      if (e && e.name === 'AbortError') { UI.toast('已中止审计'); return; }
      UI.fail('审计失败', e, '检查 API 配置与模型是否支持 JSON 输出');
    } finally {
      unlockRun('audit');
    }
  };

  /* ---- 文风检查（纯本地扫描，不花钱） ---- */
  A['reader.styleCheck'] = function () {
    var b = curBook(), c = Reader.chapter;
    if (!b || !c) return;
    var banned = (b.styleRules && b.styleRules.banned) || '';
    if (!banned.trim()) {
      UI.openSheet({
        title: '文风检查',
        body: '<div class="empty-tip">还没有配置禁词</div>' +
          '<div class="hint">到书本「基本信息」页的「文风规则」里填写禁用词与套话，' +
          '生成时会自动注入提示词，写完后可在这里零成本扫描命中。</div>',
        buttons: [{ text: '去配置', cls: '', onClick: function () { go('#/book/' + b.id + '/basic'); return true; } }, { text: '关闭', cls: 'primary' }]
      });
      return;
    }
    var hits = Util.scanBanned(c.content || '', banned);
    var total = hits.reduce(function (s, x) { return s + x.count; }, 0);
    UI.openSheet({
      title: '文风检查',
      body: total
        ? '<div class="hint mb8">正文命中 ' + total + ' 处（本章 ' + (Util.wordCount(c.content)) + ' 字）：</div>' +
        hits.map(function (h) {
          return '<div class="card mb8"><div class="row-wrap"><b>' + esc(h.word) + '</b>' +
            '<span class="tiny muted">×' + h.count + '</span></div>' +
            h.hits.slice(0, 6).map(function (x) {
              return '<div class="tiny muted mt4">…' + esc(x.excerpt) + '…</div>';
            }).join('') + '</div>';
        }).join('')
        : '<div class="empty-tip">没有命中禁词 ✅</div>',
      buttons: [{ text: '关闭', cls: 'primary' }]
    });
  };

  /* ---- AI 推荐的设定：查看 / 选择转正 / 忽略 ---- */
  A['memory.suggestToggle'] = function (el) {
    var b = curBook();
    if (!b) return;
    b.memory.suggestWorld = el.checked;
    Store.touchBook(b); Store.save();
    UI.route();
    UI.toast(b.memory.suggestWorld ? '已开启：生成记忆时会推荐新设定' : '已关闭：不再推荐新设定');
  };
  A['world.governToggle'] = function (el) {
    var b = curBook();
    if (!b) return;
    b.worldGovern = el.checked;
    Store.touchBook(b); Store.save();
    UI.route();
    UI.toast(b.worldGovern ? '已开启：推荐设定先经设定管理模型整理' : '已关闭：直接用记忆模型的原始候选');
  };
  A['world.sug.accept'] = function (el) {
    var b = curBook();
    var scope = el.getAttribute('data-scope') || '';
    var s = Store.getWorldSuggestion(b, el.getAttribute('data-id'));
    if (Store.acceptWorldSuggestion(b, el.getAttribute('data-id'), null, scope)) {
      UI.toast(s && s.kind === 'update' ? '已应用修改' : '已转正'); UI.route();
    }
  };
  A['world.sug.edit'] = function (el) {
    var b = curBook();
    var s = Store.getWorldSuggestion(b, el.getAttribute('data-id'));
    if (!s) return;
    var curScope = UI.worldScope[b.id] || '';
    /* 修改型只能改内容，归属沿用原条目（世界书里它已经在那儿了） */
    if (s.kind === 'update') {
      UI.formSheet('修改后应用', [
        { key: 'name', label: '名称', value: s.name },
        { key: 'content', type: 'textarea', tall: true, label: '合并后的完整内容', value: s.content }
      ], function (v) {
        Store.acceptWorldSuggestion(b, s.id, v, '');
        UI.toast('已更新「' + (v.name || s.name) + '」'); UI.route();
      });
      return;
    }
    UI.formSheet('修改后转正', [
      { key: 'name', label: '名称', value: s.name },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: s.content },
      {
        key: 'cat', type: 'select', label: '归入分栏', value: s.cat,
        options: AI.WORLD_ORDER.map(function (c) { return { value: c, label: AI.WORLD_LABEL[c] }; })
      },
      {
        key: 'scope', type: 'select', label: '归属（全局 / 分卷）', value: curScope,
        options: scopeOptions(b)
      }
    ], function (v) {
      var scope = v.scope || '';
      Store.acceptWorldSuggestion(b, s.id, v, scope);
      UI.toast('已转正到「' + AI.WORLD_LABEL[v.cat] + '」' + (scope ? '（' + Store.worldScopeLabel(b, scope) + '专属）' : '（全局）')); UI.route();
    });
  };
  A['world.sug.dismiss'] = function (el) {
    var b = curBook();
    Store.dismissWorldSuggestions(b, el.getAttribute('data-id'));
    UI.toast('已忽略'); UI.route();
  };
  A['world.sug.acceptAll'] = function () {
    var b = curBook();
    var ids = (b.worldSug || []).map(function (s) { return s.id; });
    if (!ids.length) { UI.toast('没有待处理的推荐'); return; }
    var nUp = (b.worldSug || []).filter(function (s) { return s.kind === 'update'; }).length;
    var tip = '处理全部 ' + ids.length + ' 条：新增的写进对应分栏（同名条目会追加合并）' +
      (nUp ? '，' + nUp + ' 条「修改」会按整理后的内容覆盖已有条目' : '') + '。';
    UI.confirm('全部应用', tip, '全部应用').then(function (ok) {
      if (!ok) return;
      var scope = UI.worldScope[b.id] || '';
      ids.forEach(function (id) { Store.acceptWorldSuggestion(b, id, null, scope); });
      UI.toast('已处理 ' + ids.length + ' 条' + (scope ? '（' + Store.worldScopeLabel(b, scope) + '专属）' : '')); UI.route();
    });
  };
  A['world.sug.clear'] = function () {
    var b = curBook();
    var n = (b.worldSug || []).length;
    if (!n) return;
    UI.confirm('忽略全部', '丢弃这 ' + n + ' 条推荐设定，不会再显示。', '忽略', true).then(function (ok) {
      if (!ok) return;
      Store.clearWorldSuggestions(b);
      UI.toast('已忽略 ' + n + ' 条'); UI.route();
    });
  };
  A['world.sug.select'] = function () {
    var b = curBook();
    var sug = b.worldSug || [];
    if (!sug.length) { UI.toast('没有待转正的推荐'); return; }
    UI.checkSheet(
      '选择要转正的推荐设定',
      sug.map(function (s) {
        return {
          id: s.id, checked: true,
          name: AI.WORLD_LABEL[s.cat] + ' · ' + (s.name || '(未命名)'),
          hint: s.content
        };
      }),
      {
        head: '<div class="hint mb8">勾选要保留的条目，确定后写进对应分栏；未勾选的会被丢弃。同名条目追加合并。</div>',
        okText: '转正选中',
        actions: [{ act: 'all', text: '全选' }, { act: 'none', text: '全不选' }]
      },
      function (ids) {
        var all = sug.map(function (s) { return s.id; });
        var scope = UI.worldScope[b.id] || '';
        ids.forEach(function (id) { Store.acceptWorldSuggestion(b, id, null, scope); });
        var rest = all.filter(function (id) { return ids.indexOf(id) < 0; });
        if (rest.length) Store.dismissWorldSuggestions(b, rest);
        UI.toast('已转正 ' + ids.length + ' 条' + (rest.length ? '，忽略 ' + rest.length + ' 条' : ''));
        UI.route();
      }
    );
  };
  /* 一股脑输入想法，AI 自动拆成设定条目 */
  A['world.ai'] = function () {
    var b = curBook();
    if (!b) return;
    var provider = Store.activeModel();
    if (!provider) {
      UI.confirm('尚未配置 API', 'AI 整理需要先在「设置 → API 提供商」里添加一个可用的接口。', '去设置').then(function (ok) {
        if (ok) go('#/settings');
      });
      return;
    }
    UI.editFullText('把想法一股脑写在这里', '', function (text) {
      if (!text || !text.trim()) return;
      if (!lockRun('world', '设定整理')) return;
      var ac = new AbortController();
      UI.busy('AI 正在整理设定…', function () { ac.abort(); });
      AI.extractWorld(b, text, { signal: ac.signal }).then(function (items) {
        UI.unbusy();
        if (!items.length) { UI.toast('AI 没有识别出设定条目'); return; }
        showWorldExtract(b, items);
      }).catch(function (e) {
        UI.unbusy();
        if (e && e.name === 'AbortError') { UI.toast('已中止整理'); return; }
        UI.fail('整理失败', e);
      }).then(function () {
        unlockRun('world');     // 成功 / 失败 / 中止都要解锁
      });
    });
  };

  function showWorldExtract(b, items) {
    UI.checkSheet(
      '识别到 ' + items.length + ' 条设定',
      items.map(function (it, i) {
        return {
          id: String(i), checked: true,
          name: AI.WORLD_LABEL[it.cat] + ' · ' + (it.name || '(未命名)'),
          hint: it.content
        };
      }),
      {
        head: '<div class="hint mb8">勾选要保留的条目；与已有条目同名的会追加合并，不会重复新建。</div>',
        okText: '加入世界书',
        actions: [{ act: 'all', text: '全选' }, { act: 'none', text: '全不选' }]
      },
      function (ids) {
        var n = 0;
        var scope = UI.worldScope[b.id] || '';
        ids.forEach(function (id) {
          var it = items[parseInt(id, 10)];
          if (!it) return;
          var exist = (b.world[it.cat] || []).filter(function (e) {
            return e.name && e.name === it.name && (scope ? e.scope === scope : !e.scope);
          })[0];
          if (exist) {
            exist.content = exist.content ? exist.content + '\n' + it.content : it.content;
            exist.enabled = true;
          } else {
            Store.addWorldEntry(b, it.cat, it.name, it.content, scope);
          }
          n++;
        });
        Store.touchBook(b); Store.save();
        UI.toast('已添加 / 更新 ' + n + ' 条设定');
        UI.route();
      }
    );
  }

  A['world.del'] = async function (el) {
    var b = curBook(), cat = el.getAttribute('data-cat');
    var ok = await UI.confirm('删除条目', '确定删除这条设定？', '删除', true);
    if (!ok) return;
    Store.removeWorldEntry(b, cat, el.getAttribute('data-id')); UI.route();
  };

  /* ---- 分卷 ---- */
  A['volume.new'] = function () {
    UI.formSheet('新增分卷', [
      { key: 'title', label: '分卷名', value: '', placeholder: '如：第一卷 雾起' },
      { key: 'summary', type: 'textarea', tall: true, label: '本卷大纲', value: '', placeholder: '这一卷的主线、关键事件与结局走向' }
    ], function (v) {
      Store.addVolume(curBook(), v.title, v.summary); UI.route();
    });
  };
  A['volume.edit'] = function (el) {
    var b = curBook(), v0 = Store.getVolume(b, el.getAttribute('data-id'));
    UI.formSheet('编辑分卷', [
      { key: 'title', label: '分卷名', value: v0.title },
      { key: 'summary', type: 'textarea', tall: true, label: '本卷大纲', value: v0.summary }
    ], function (v) {
      v0.title = v.title; v0.summary = v.summary; Store.touchBook(b); Store.save(); UI.route();
    });
  };
  /* 收起 / 打开某一卷的章节列表（运行时状态，不持久化） */
  A['volume.collapse'] = function (el) {
    var vid = el.getAttribute('data-id');
    if (!vid) return;
    UI.volCollapsed[vid] = !UI.volCollapsed[vid];
    UI.route();
  };
  /* 删除分卷：章节要么移走、要么明确删除，绝不留下「无分卷」的孤儿章节 */
  A['volume.del'] = async function (el) {
    var b = curBook(), vid = el.getAttribute('data-id');
    var v = Store.getVolume(b, vid);
    if (!v) return;
    var name = '《' + (v.title || '未命名分卷') + '》';
    var affected = b.chapters.filter(function (c) { return c.volumeId === vid; });
    var others = b.volumes.filter(function (x) { return x.id !== vid; });

    if (!affected.length) {
      var ok = await UI.confirm('删除分卷', name + ' 下没有章节，可以安全删除。', '删除', true);
      if (!ok) return;
    } else if (others.length) {
      var i = await UI.choose('删除分卷',
        name + ' 下有 ' + affected.length + ' 个章节。要怎么处理它们？',
        [{ text: '移到其他分卷', cls: 'primary' }, { text: '连同章节一起删除', cls: 'danger' }]);
      if (i < 0) return;
      if (i === 0) {
        UI.formSheet('移到哪个分卷', [
          {
            key: 'to', type: 'select', label: '目标分卷', value: others[0].id,
            options: others.map(function (x, k) {
              return { value: x.id, label: '第' + (k + 1) + '卷 《' + (x.title || '未命名') + '》' };
            })
          }
        ], function (vv) {
          // 先记下要搬的章节 id：moveChapterToVolume 会改动数组顺序，
          // 直接遍历 affected 里持有的对象引用虽然仍有效，但显式用 id 更稳妥。
          var ids = affected.map(function (c) { return c.id; });
          var moved = 0;
          ids.forEach(function (cid) {
            if (Store.moveChapterToVolume(b, cid, vv.to)) moved++;
            else {
              // 目标卷不存在之类的意外：兜底改用直接赋值，保证不产生孤儿章节
              var cc = Store.getChapter(b, cid);
              if (cc && Store.getVolume(b, vv.to)) { cc.volumeId = vv.to; Store.touchBook(b); moved++; }
            }
          });
          Store.save();
          Store.removeVolume(b, vid);
          UI.toast('已把 ' + moved + ' 章移到其他分卷');
          UI.route();
        });
        return;
      }
      var ok2 = await UI.confirm('连同章节删除', '将删除 ' + name + ' 下的 ' + affected.length +
        ' 个章节及其大纲、正文与记忆，不可恢复。', '删除', true);
      if (!ok2) return;
      affected.forEach(function (c) { Store.removeChapter(b, c.id); });
    } else {
      var ok3 = await UI.confirm('删除最后一个分卷', name + ' 下的 ' + affected.length +
        ' 个章节会一并删除（不可恢复）。每章都必须属于某个分卷，无法保留。', '删除', true);
      if (!ok3) return;
      affected.forEach(function (c) { Store.removeChapter(b, c.id); });
    }
    Store.removeVolume(b, vid); UI.route();
  };
  A['outline.ai'] = function (el) {
    var id = el.getAttribute('data-id');
    var bid = bookIdFromHash();
    var b = curBook();
    if (!b) return;
    var isVolume = id && b.volumes.some(function (v) { return v.id === id; });
    // 分章必须针对某个分卷：没有分卷就先建一个
    ensureVolume(b, function (newVolId) {
      outlineFlow(bid, isVolume ? id : (newVolId || b.volumes[b.volumes.length - 1].id));
    });
  };

  /* ---- 章节 ---- */
  function volumeOptions(b) {
    return b.volumes.map(function (v, i) {
      return { value: v.id, label: '第' + (i + 1) + '卷 ' + (v.title || '未命名') };
    });
  }
  /* 归属选项：全局 + 各分卷（世界设定条目 / AI 推荐转正都能改归属） */
  function scopeOptions(b) {
    var opts = [{ value: '', label: '全局（对所有分卷生效）' }];
    b.volumes.forEach(function (v, i) {
      opts.push({ value: v.id, label: '第' + (i + 1) + '卷《' + (v.title || '未命名') + '》专属' });
    });
    return opts;
  }
  /* 没有分卷时先引导创建一个（章节必须挂在某个分卷下） */
  function ensureVolume(b, then) {
    if (b.volumes.length) { then(); return; }
    UI.formSheet('先创建一个分卷', [
      { key: 'title', label: '分卷名', value: '第一卷' },
      { key: 'summary', type: 'textarea', label: '本卷大纲（可留空，之后还能改）', value: '' }
    ], function (v) {
      var vol = Store.addVolume(b, v.title || '第一卷', v.summary);
      UI.route();
      setTimeout(function () { then(vol.id); }, 0);
    });
  }

  A['chapter.new'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id') || bookIdFromHash());
    var presetVol = el.getAttribute('data-vol') || '';
    var openForm = function (volId) {
      var opts = volumeOptions(b);
      UI.formSheet('新建章节', [
        { key: 'title', label: '章节标题', value: '', placeholder: '可留空，之后自动生成' },
        { key: 'outline', type: 'textarea', label: '章节大纲（AI 写作的依据）', value: '' },
        { key: 'volumeId', type: 'select', label: '所属分卷（必选）', value: volId || presetVol || (opts.length ? opts[opts.length - 1].value : ''), options: opts }
      ], function (v) {
        if (!v.volumeId) { UI.toast('请选择所属分卷'); return false; }
        var c = Store.addChapter(b, { title: v.title, outline: v.outline, volumeId: v.volumeId });
        UI.toast('已新建第 ' + b.chapters.length + ' 章');
        go('#/read/' + b.id + '/' + c.id);
      });
    };
    ensureVolume(b, openForm);
  };

  /* 章节列表里点「✨ 生成正文」/「✏️ AI 重写」：
   * 无正文 → 进阅读页自动开写；已有正文 → 先填重写指示再重写 */
  A['chapter.generate'] = function (el) {
    var b = curBook(), cid = el.getAttribute('data-id');
    if (!b || !Store.getChapter(b, cid)) return;
    var c = Store.getChapter(b, cid);
    if (c.content) { openRewriteForm(b, c); return; }
    App.autoGenerate = cid;
    go('#/read/' + b.id + '/' + cid);
  };

  /* 重写指示弹窗：可留空（= 不附加任何额外要求，直接重写），填写后会追加进本次提示词 */
  function openRewriteForm(b, c) {
    UI.formSheet('AI 重写 · 第' + (Store.chapterIndex(b, c.id) + 1) + '章', [
      {
        type: 'html',
        html: '<div class="hint mb12">本章已有 ' + AI.wordCount(c.content) + ' 字正文，重写会整体覆盖（完成后可一键撤销）。</div>'
      },
      {
        key: 'instruction', type: 'textarea', tall: true, label: '重写指示（可留空）', value: '',
        hint: '留空 = 不加额外要求，直接按本章大纲与前文重写一遍。',
        placeholder: '如：加快叙事节奏、减少对话比重；把结尾的悬念写得更明确……'
      }
    ], function (v) {
      UI.closeSheet();
      // 表单里的「重写会整体覆盖」+ 用户点「确定」＝已经确认过覆盖，force 不再二次确认。
      // 返回 Promise：让 formSheet 知道后续由业务自己收尾，避免它紧接着的 closeSheet
      // 把流程中途弹出来的面板（如「尚未配置 API」）一起抹掉。
      return generateChapterFlow(b.id, c.id, {
        instruction: v.instruction || '', rewrite: true, force: true
      });
    });
  }
  /* 换分卷：把这一章挪到别的分卷下 */
  A['chapter.moveVol'] = function (el) {
    var b = curBook(), c = Store.getChapter(b, el.getAttribute('data-id'));
    if (!b || !c) return;
    if (b.volumes.length < 2) { UI.toast('这本书目前只有一个分卷'); return; }
    var opts = volumeOptions(b).map(function (o) {
      return o.value === c.volumeId ? { value: o.value, label: o.label + '（当前）' } : o;
    });
    UI.formSheet('把本章换到哪个分卷', [
      { key: 'volumeId', type: 'select', label: '目标分卷', value: c.volumeId || opts[0].value, options: opts },
      { type: 'html', html: '<div class="hint">换卷后本章会被挪到该分卷的末尾，正文与大纲不受影响。</div>' }
    ], function (v) {
      if (!v.volumeId) { UI.toast('请选择分卷'); return false; }
      if (v.volumeId === c.volumeId) { UI.toast('本章已在该分卷'); return false; }
      Store.moveChapterToVolume(b, c.id, v.volumeId);
      UI.toast('已移动到目标分卷');
      UI.route();
    });
  };

  A['chapter.menu'] = function (el) {
    var b = curBook(), cid = el.getAttribute('data-id');
    var i = Store.chapterIndex(b, cid);
    UI.openSheet({
      title: '第' + (i + 1) + '章',
      body: '<div class="list">' +
        '<button class="btn block" data-act="read" data-id="' + cid + '">进入阅读 / 写作</button>' +
        '<button class="btn block" data-act="chapter.edit" data-id="' + cid + '">编辑标题与大纲</button>' +
        '<button class="btn block" data-act="chapter.moveVol" data-id="' + cid + '">⇄ 换到别的分卷</button>' +
        '<button class="btn block" data-act="chapter.aiOutline" data-id="' + cid + '">✨ 让 AI 写本章大纲</button>' +
        '<button class="btn block" data-act="chapter.editContent" data-id="' + cid + '">手动编辑正文</button>' +
        '<button class="btn block" data-act="chapter.up" data-id="' + cid + '">上移一位</button>' +
        '<button class="btn block" data-act="chapter.down" data-id="' + cid + '">下移一位</button>' +
        '<button class="btn block danger" data-act="chapter.del" data-id="' + cid + '">删除本章</button>' +
        '</div>'
    });
  };
  A['chapter.edit'] = function (el) {
    var b = curBook(), c = Store.getChapter(b, el.getAttribute('data-id'));
    var opts = volumeOptions(b);
    if (!opts.length) { UI.toast('这本书还没有分卷，请先创建分卷'); return; }
    UI.formSheet('编辑章节（标题 / 大纲 / 分卷）', [
      { key: 'title', label: '标题', value: c.title },
      { key: 'outline', type: 'textarea', tall: true, label: '本章大纲 prompt（AI 按它写正文，可随时改）', value: c.outline },
      { key: 'volumeId', type: 'select', label: '所属分卷（必选）', value: c.volumeId || opts[0].value, options: opts }
    ], function (v) {
      if (!v.volumeId) { UI.toast('请选择所属分卷'); return false; }
      c.title = v.title; c.outline = v.outline; c.volumeId = v.volumeId;
      c.updatedAt = Date.now(); Store.touchBook(b); Store.touchChapter(b, c); Store.save();
      UI.closeSheet(); UI.route();
    });
  };
  A['chapter.aiOutline'] = async function (el) {
    var b = curBook(), c = Store.getChapter(b, el.getAttribute('data-id'));
    if (!b || !c) return;
    if (!lockRun('outline', '章节大纲')) return;
    var ac = new AbortController();
    UI.busy('正在生成大纲…', function () { ac.abort(); });
    try {
      var r = await AI.generateSingleOutline(b, c, { signal: ac.signal });
      c.title = r.title || c.title; c.outline = r.outline || c.outline;
      c.updatedAt = Date.now(); Store.touchBook(b); Store.save();
      UI.unbusy(); UI.closeSheet(); UI.route(); UI.toast('大纲已更新');
    } catch (e) {
      UI.unbusy();
      if (!(e && e.name === 'AbortError')) UI.toast(e.message || String(e));
      else UI.toast('已中止生成大纲');
    }
    finally { unlockRun('outline'); }
  };
  A['chapter.up'] = function (el) { Store.moveChapter(curBook(), el.getAttribute('data-id'), -1); UI.closeSheet(); UI.route(); };
  A['chapter.down'] = function (el) { Store.moveChapter(curBook(), el.getAttribute('data-id'), 1); UI.closeSheet(); UI.route(); };
  A['chapter.del'] = async function (el) {
    var ok = await UI.confirm('删除章节', '本章正文与相关记忆都会被删除。', '删除', true);
    if (!ok) return;
    Store.removeChapter(curBook(), el.getAttribute('data-id'));
    UI.closeSheet(); UI.route();
  };
  A['chapter.editContent'] = function (el) {
    var b = curBook();
    var cid = el.getAttribute('data-id') || (b.chapters[Reader.index] && b.chapters[Reader.index].id);
    var c = Store.getChapter(b, cid);
    if (!c) return;
    UI.editFullText('第' + (Store.chapterIndex(b, cid) + 1) + '章 正文', c.content, function (text) {
      c.content = text; c.updatedAt = Date.now();
      Store.pruneBracketNotes(b, c);   // 作者删掉的框，其意见一并清理
      Store.touchBook(b); Store.touchChapter(b, c); Store.save();
      if (Reader.book && Reader.book.id === b.id) Reader.refreshCur(); else UI.route();
      var n = Store.bracketItems(c).length;
      if (n) {
        UI.toast('已保存 · 识别到 ' + n + ' 处【【框】】', 3600, {
          actionText: '填意见', onAction: function () { UI.route(); A['mark.list'](); }
        });
      } else UI.toast('已保存');
    }, '用 【【 】】 把要改的地方框起来，保存后就能逐条填修改意见');
  };
  A['read'] = function (el) {
    go('#/read/' + bookIdFromHash() + '/' + el.getAttribute('data-id'));
  };

  /* ---- 阅读器 ---- */
  A['reader.prev'] = function () { Reader.flip(-1); };
  A['reader.next'] = function () { Reader.flip(1); };
  A['reader.generate'] = function () {
    var b = curBook();
    if (!b.chapters.length) return;
    var c = b.chapters[Reader.index];
    if (c.content) { openRewriteForm(b, c); return; }
    generateChapterFlow(b.id, c.id, { force: false });
  };
  A['reader.menu'] = function () {
    var b = curBook();
    var ui = Store.state.ui;
    var fs = ui.fontSize || 17;
    var lh = ui.lineHeight || 1.85;
    var para = ui.paraSpacing == null ? 1 : ui.paraSpacing;
    var hasUndo = b.undoStack.length > 0;
    var themes = [['dark', '暗色'], ['light', '亮色'], ['sepia', '护眼纸']];
    var curTheme = ui.theme || 'dark';

    UI.openSheet({
      title: '第' + (Reader.index + 1) + '章',
      body: '<div class="list">' +
        '<button class="btn block primary" data-act="reader.generate">' + (b.chapters[Reader.index].content ? '✏️ AI 重写' : '✨ AI 生成本章') + '</button>' +
        '<button class="btn block" data-act="chapter.editContent">✎ 手动编辑正文</button>' +
        '<button class="btn block" data-act="mark.list">🖍 划线改稿' +
          (Reader.liveMarkCount(b.chapters[Reader.index]) ? '（' + Reader.liveMarkCount(b.chapters[Reader.index]) + ' 处）' : '') + '</button>' +
        '<button class="btn block" data-act="chat.fromReader">💬 找小编聊聊这章</button>' +
        '<button class="btn block" data-act="world.browse" data-id="' + b.id + '">🌍 浏览世界设定</button>' +
        '<button class="btn block" data-act="reader.editOutline">✎ 编辑本章大纲</button>' +
        '<button class="btn block" data-act="reader.viewPrompt">🔍 查看注入的提示词</button>' +
        '<button class="btn block" data-act="reader.styleCheck">🧹 文风检查（本地扫描禁词）</button>' +
        '<button class="btn block" data-act="reader.audit">🔍 一致性审计（对照设定与记忆）</button>' +
        '<button class="btn block" data-act="reader.undo"' + (hasUndo ? '' : ' disabled') + '>↩ 撤回上次 AI 生成（含记忆）</button>' +
        '<div class="card small muted">撤回会把正文回滚到本次生成前，并删除本次写入的记忆、把长期记忆摘要恢复原样。' +
        '「一致性审计」会再发一次请求（按「审计」方案走模型），文风检查是纯本地扫描，不花钱。</div>' +

        // —— 排版设置 ——
        '<div class="card">' +
        '<div class="row"><span class="small">字号</span><div class="spacer"></div>' +
        '<button class="btn sm" data-act="reader.font" data-delta="-1">A−</button>' +
        '<span id="fsVal" style="min-width:34px;text-align:center">' + fs + '</span>' +
        '<button class="btn sm" data-act="reader.font" data-delta="1">A＋</button>' +
        '</div>' +
        '<div class="row mt12"><span class="small">行高</span><div class="spacer"></div>' +
        '<span id="lhVal" style="min-width:34px;text-align:center">' + lh.toFixed(2) + '</span>' +
        '<button class="btn sm" data-act="reader.lineHeight" data-delta="-0.05">−</button>' +
        '<button class="btn sm" data-act="reader.lineHeight" data-delta="0.05">＋</button>' +
        '</div>' +
        '<div class="row mt12"><span class="small">段间距</span><div class="spacer"></div>' +
        '<span id="paraVal" style="min-width:34px;text-align:center">' + para.toFixed(1) + '</span>' +
        '<button class="btn sm" data-act="reader.para" data-delta="-0.2">−</button>' +
        '<button class="btn sm" data-act="reader.para" data-delta="0.2">＋</button>' +
        '</div>' +
        '<div class="row mt12"><span class="small">主题</span><div class="spacer"></div>' +
        themes.map(function (t) {
          return '<button class="btn sm' + (t[0] === curTheme ? ' primary' : '') + '" data-act="reader.theme" data-theme="' + t[0] + '">' + t[1] + '</button>';
        }).join('') +
        '</div>' +
        '<div class="hint mt8">排版设置对所有作品生效，保存在本机。</div>' +
        '</div>' +

        '<button class="btn block ghost" data-act="nav" data-to="#/book/' + b.id + '/chapters">返回章节目录</button>' +
        '</div>'
    });
  };
  A['reader.font'] = function (el) {
    var d = parseInt(el.getAttribute('data-delta'), 10);
    var ui = Store.state.ui;
    ui.fontSize = Util.clampInt((ui.fontSize || 17) + d, 13, 28, 17);
    Store.save();
    var v = document.getElementById('fsVal'); if (v) v.textContent = ui.fontSize;
    Reader.refreshCur();
  };
  A['reader.lineHeight'] = function (el) {
    var d = parseFloat(el.getAttribute('data-delta'));
    var ui = Store.state.ui;
    ui.lineHeight = Util.clampFloat((ui.lineHeight || 1.85) + d, 1.2, 3, 1.85);
    Store.save();
    var v = document.getElementById('lhVal'); if (v) v.textContent = ui.lineHeight.toFixed(2);
    Reader.refreshCur();
  };
  A['reader.para'] = function (el) {
    var d = parseFloat(el.getAttribute('data-delta'));
    var ui = Store.state.ui;
    var cur = ui.paraSpacing == null ? 1 : ui.paraSpacing;
    ui.paraSpacing = Util.clampFloat(cur + d, 0, 3, 1);
    Store.save();
    var v = document.getElementById('paraVal'); if (v) v.textContent = ui.paraSpacing.toFixed(1);
    Reader.refreshCur();
  };
  A['reader.theme'] = function (el) {
    var t = el.getAttribute('data-theme') || 'dark';
    Store.state.ui.theme = t;
    Store.save();
    UI.applyTheme();
    var btns = document.querySelectorAll('[data-act="reader.theme"]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('primary', btns[i].getAttribute('data-theme') === t);
    }
    UI.toast('已切换为「' + ({ dark: '暗色', light: '亮色', sepia: '护眼纸' }[t] || t) + '」');
  };
  A['reader.editOutline'] = function () {
    var b = curBook(), c = b.chapters[Reader.index];
    UI.formSheet('本章大纲', [
      { key: 'title', label: '标题', value: c.title },
      { key: 'outline', type: 'textarea', tall: true, label: '章节大纲 prompt', value: c.outline }
    ], function (v) {
      c.title = v.title; c.outline = v.outline; c.updatedAt = Date.now();
      Store.touchBook(b); Store.touchChapter(b, c); Store.save(); UI.closeSheet(); Reader.refreshCur(); UI.toast('已保存');
    });
  };
  A['reader.viewPrompt'] = function () {
    var b = curBook(), c = b.chapters[Reader.index];
    var p = AI.buildChapterPrompt(b, c);
    UI.openSheet({
      title: '本次注入的提示词',
      body: '<div class="section-title" style="margin-top:0">System</div>' +
        '<div class="card small" style="white-space:pre-wrap;max-height:32vh;overflow:auto">' + esc(p.system) + '</div>' +
        '<div class="section-title">User</div>' +
        '<div class="card small" style="white-space:pre-wrap;max-height:40vh;overflow:auto">' + esc(p.user) + '</div>',
      buttons: [
        { text: '复制', cls: '', onClick: function () { copyText(p.system + '\n\n' + p.user); UI.toast('已复制'); return true; } },
        { text: '关闭', cls: 'primary' }
      ]
    });
  };
  A['reader.undo'] = function () {
    var b = curBook();
    UI.confirm('撤回', '将把第' + (Reader.index + 1) + '章正文恢复到上次 AI 生成之前，并同步撤销本次写入的记忆。', '撤回', true).then(function (ok) {
      if (ok) { undoLastAI(b.id); UI.closeSheet(); }
    });
  };

  /* ---- 提供商 ----
   * 合并后：提供商只管「连接」（名称 / 类型 / Base URL / Key / 请求头 / 余额地址），
   * 模型与生成参数（模型名 / 温度 / maxTokens）全部归「模型方案」管理，不再两处重复。 */
  function providerFields(p) {
    p = p || {};
    return [
      {
        type: 'html', html: '<div class="row-wrap mb12">' +
          ['deepseek', 'moonshot', 'zhipu', 'siliconflow', 'dashscope', 'ollama', 'openai', 'anthropic', 'google']
            .map(function (k) {
              return '<button class="btn sm" data-act="provider.preset" data-preset="' + k + '">' + API.PRESETS[k].name + '</button>';
            }).join('') + '</div>'
      },
      { key: 'name', label: '名称', value: p.name || '', placeholder: '如：DeepSeek 主力' },
      {
        key: 'type', type: 'select', label: '接口类型', value: p.type || 'openai',
        options: [{ value: 'openai', label: 'OpenAI 兼容（推荐）' }, { value: 'anthropic', label: 'Anthropic Claude' }, { value: 'google', label: 'Google Gemini' }, { value: 'custom', label: '自定义（同 OpenAI 格式）' }]
      },
      { key: 'baseUrl', label: 'Base URL', value: p.baseUrl || 'https://api.openai.com/v1', hint: 'OpenAI 兼容填到 /v1 即可，不要带 /chat/completions' },
      { key: 'apiKey', label: 'API Key', value: p.apiKey || '' },
      {
        type: 'html', html: '<div class="row-wrap mb12">' +
          '<button class="btn sm" data-act="provider.fetchBalance">💰 查询余额</button>' +
          '<span id="balHint" class="tiny muted"></span></div>'
      },
      { key: 'balanceUrl', label: '余额查询地址（可选）', value: p.balanceUrl || '', placeholder: '留空 = 按提供商自动识别（DeepSeek / Moonshot / 硅基流动等）' },
      { key: 'extraHeaders', type: 'textarea', label: '自定义请求头（可选）', value: p.extraHeaders || '', placeholder: '每行一条，如：\nX-Title: NovelWriter' },
      { type: 'html', html: '<div class="hint">模型与温度 / Token 等参数在「模型方案」里配置（保存后会引导你建一个方案）。</div>' }
    ];
  }

  /* 模型方案（预设）表单：模型与生成参数的唯一入口 */
  function presetFields(m) {
    m = m || {};
    var provs = Store.state.providers.map(function (pv) { return { value: pv.id, label: pv.name + '（' + pv.baseUrl + '）' }; });
    return [
      { key: 'name', label: '方案名称', value: m.name || '', placeholder: '如：DeepSeek 写正文 / Kimi 整理大纲' },
      {
        key: 'providerId', type: 'select', label: '使用哪个提供商',
        value: m.providerId || Store.state.activeProviderId || (provs[0] || {}).value || '', options: provs
      },
      { key: 'model', label: '模型名（必填）', value: m.model || '', placeholder: '可点下方按钮拉取列表后选择' },
      {
        type: 'html', html: '<div class="row-wrap mb12">' +
          '<button class="btn sm" data-act="provider.fetchModels">📥 拉取模型列表</button>' +
          '<button class="btn sm" data-act="provider.fetchBalance">💰 查询余额</button>' +
          '<span id="balHint" class="tiny muted"></span></div>'
      },
      { key: 'temperature', type: 'number', label: '温度（留空 = 用默认 0.85）', value: m.temperature == null ? '' : m.temperature },
      { key: 'maxTokens', type: 'number', label: '单次最大输出 Token（留空 = 用默认 4096）', value: m.maxTokens == null ? '' : m.maxTokens },
      /* 任务级路由：绑了用途后该任务固定走这套方案，不用再手动切。
       * 典型省钱姿势：正文用好模型，记忆总结 / 审计用便宜模型。 */
      {
        key: 'task', type: 'select', label: '专用于（任务级路由）', value: m.task || '',
        options: Store.TASKS,
        hint: '选了某个任务后，该任务自动使用这套方案，不再跟「当前启用方案」走。同一任务只认第一套方案。'
      },
      {
        key: 'noThink', type: 'checkbox', label: '关闭思考（对思考型模型，省掉按输出计费的思考 token）', value: !!m.noThink
      },
      { key: 'priceIn', type: 'number', label: '输入单价（元 / 百万 token，可留空）', value: m.priceIn ? m.priceIn : '' },
      { key: 'priceOut', type: 'number', label: '输出单价（元 / 百万 token，可留空）', value: m.priceOut ? m.priceOut : '' },
      {
        type: 'html',
        html: '<div class="hint">填了单价，数据页就能看到估算成本；不填只统计 token 数。' +
          '记忆总结、设定整理这类轻任务用便宜模型，是性价比最高的一档省钱。</div>'
      }
    ];
  }

  /* 从当前面板表单读出「用于拉取列表 / 查余额的提供商草稿」：
   * 提供商表单里字段就在表单上；预设表单只有 providerId，回查 Store。 */
  function sheetProviderDraft() {
    var v = UI.collectSheet();
    var base = v.providerId ? (Store.getProvider(v.providerId) || {}) : v;
    return {
      name: base.name || v.name || '',
      type: base.type || v.type || 'openai',
      baseUrl: base.baseUrl || v.baseUrl || '',
      apiKey: base.apiKey || v.apiKey || '',
      model: v.model || base.model || '',
      balanceUrl: v.balanceUrl || base.balanceUrl || '',
      extraHeaders: base.extraHeaders || v.extraHeaders || ''
    };
  }

  /* 把拉到的模型列表注入当前表单面板（不新开面板，避免覆盖正在编辑的表单） */
  function injectModelPicker(body, models, current) {
    var old = document.getElementById('mdlPick');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'mdlPick';
    box.className = 'card mt8';
    box.innerHTML = '<div class="row"><span class="small">共 ' + models.length + ' 个模型，点选（已过滤不可用字符）</span>' +
      '<div class="spacer"></div>' +
      '<button class="btn sm ghost" data-act="model.pickClose">收起</button></div>' +
      '<input class="input mt8" id="mdlFilter" placeholder="输入关键字筛选…" autocomplete="off">' +
      '<div class="list mt8" style="max-height:38vh;overflow:auto">' +
      models.map(function (m) {
        return '<button class="btn block ghost' + (m === current ? ' primary' : '') + '" ' +
          'style="justify-content:flex-start;font-size:13px" data-act="model.pick" data-model="' + Util.esc(m) + '">' +
          Util.esc(m) + (m === current ? ' ✓' : '') + '</button>';
      }).join('') + '</div>';
    var modelInput = body.querySelector('[data-f="model"]');
    if (modelInput && modelInput.parentNode) modelInput.parentNode.appendChild(box);
    else body.appendChild(box);
    var fi = document.getElementById('mdlFilter');
    fi.addEventListener('input', function () {
      var q = fi.value.trim().toLowerCase();
      var btns = box.querySelectorAll('[data-act="model.pick"]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].style.display = (!q || btns[i].getAttribute('data-model').toLowerCase().indexOf(q) >= 0) ? '' : 'none';
      }
    });
    setTimeout(function () { try { fi.focus(); } catch (e) { } }, 60);
  }
  A['provider.new'] = function () {
    UI.formSheet('新增提供商', providerFields(null), function (v) {
      if (!v.name) { UI.toast('请填写名称'); return false; }
      if (!v.baseUrl) { UI.toast('请填写 Base URL'); return false; }
      var p = Store.upsertProvider(v);
      Store.state.activeProviderId = p.id;
      Store.save(); UI.route();
      // 连接配好后直接引导建第一个模型方案（模型名在这里选，不在提供商里重复配）
      setTimeout(function () { openPresetForm(null, p.id); }, 60);
    });
  };
  /* 打开模型方案表单；fixedProviderId = 锁定提供商（新增提供商后的引导流程用） */
  function openPresetForm(m, fixedProviderId) {
    var fields = presetFields(m);
    if (fixedProviderId) {
      var fp = Store.getProvider(fixedProviderId);
      if (!fp) { UI.toast('提供商不存在'); return; }
      fields = fields.map(function (f) {
        if (f.key === 'providerId') { f.value = fixedProviderId; f.options = [{ value: fixedProviderId, label: fp.name }]; }
        return f;
      });
      if (!m) fields[0].value = fp.name + ' · 方案一';
    }
    UI.formSheet(m ? '编辑模型方案' : '新增模型方案', fields, function (v) {
      if (!v.providerId) { UI.toast('请选择提供商'); return false; }
      if (!v.model) { UI.toast('请填写或选择模型名'); return false; }
      var temp = v.temperature === '' ? null : parseFloat(v.temperature);
      var mt = v.maxTokens === '' ? null : parseInt(v.maxTokens, 10);
      var priceIn = parseFloat(v.priceIn);
      var priceOut = parseFloat(v.priceOut);
      var data = {
        name: v.name || v.model,
        providerId: v.providerId,
        model: v.model,
        temperature: (temp == null || isNaN(temp)) ? null : temp,
        maxTokens: (mt == null || isNaN(mt) || mt <= 0) ? null : mt,
        /* 用途绑定：绑了任务后，该任务自动走这套方案（正文 / 记忆 / 审计分开用不同模型） */
        task: v.task || '',
        noThink: !!v.noThink,
        priceIn: (isNaN(priceIn) || priceIn < 0) ? 0 : priceIn,
        priceOut: (isNaN(priceOut) || priceOut < 0) ? 0 : priceOut
      };
      var saved;
      if (m && m.id) { data.id = m.id; saved = Store.upsertModelPreset(data); UI.toast('已保存'); }
      else { saved = Store.upsertModelPreset(data); Store.useModelPreset(saved.id); UI.toast('已新增并启用「' + saved.name + '」'); }
      /* 一类任务只认一套方案：保存后把同任务的其他方案解绑，
       * 否则界面上会同时显示两套「专职」，实际只有第一套生效——纯误导。 */
      if (data.task) {
        var stolen = Store.state.modelPresets.filter(function (x) {
          return x.id !== saved.id && x.task === data.task;
        });
        if (stolen.length) {
          stolen.forEach(function (x) { delete x.task; });
          Store.save();
          UI.toast('「' + Store.taskLabel(data.task) + '」已改由「' + saved.name + '」负责');
        }
      }
      UI.route();
    });
  }
  A['provider.edit'] = function (el) {
    var p = Store.getProvider(el.getAttribute('data-id'));
    UI.formSheet('编辑提供商', providerFields(p), function (v) {
      v.id = p.id;
      Store.upsertProvider(v); UI.route();
    });
  };
  A['provider.preset'] = function (el) {
    var k = el.getAttribute('data-preset'), pr = API.PRESETS[k];
    var body = document.getElementById('sheetBody');
    var type = (k === 'anthropic') ? 'anthropic' : (k === 'google') ? 'google' : 'openai';
    var inputs = body.querySelectorAll('[data-f]');
    for (var i = 0; i < inputs.length; i++) {
      var f = inputs[i].getAttribute('data-f');
      if (f === 'baseUrl') inputs[i].value = pr.baseUrl;
      if (f === 'type') inputs[i].value = type;
      if (f === 'name' && !inputs[i].value) inputs[i].value = pr.name;
    }
    UI.toast('已填入 ' + pr.name + ' 的连接参数（模型在方案里选）');
  };
  A['provider.use'] = function (el) {
    var id = el.getAttribute('data-id');
    Store.state.activeProviderId = id;
    // 同步把启用方案切到该提供商的第一个方案，避免「启用A提供商却仍在用B提供商的方案」
    var m = (Store.state.modelPresets || []).filter(function (x) { return x.providerId === id; })[0];
    if (m) Store.state.activePresetId = m.id;
    Store.save(); UI.route();
  };
  A['provider.del'] = async function (el) {
    var ok = await UI.confirm('删除提供商', '确定删除这个接口配置？', '删除', true);
    if (!ok) return;
    Store.removeProvider(el.getAttribute('data-id')); UI.route();
  };
  A['provider.test'] = async function (el) {
    var p = Store.getProvider(el.getAttribute('data-id'));
    if (!p) return;
    // 测试用的配置：优先取绑定该提供商的模型方案（模型名在方案里），
    // 没有方案时回落提供商自身的老字段
    var m = (Store.state.modelPresets || []).filter(function (x) { return x.providerId === p.id; })[0];
    var cfg = m ? Store._merged(p, m) : p;
    if (!cfg.model) {
      UI.toast('请先为这个提供商建一个模型方案（模型名在方案里配）', 4000);
      return;
    }
    /* 诊断类请求也走同一把锁：它们不写章节，但会抢共用的忙碌浮层，
     * 结束时的 unbusy 会把正在进行的正文生成的浮层（含「停止」）一起关掉。 */
    if (!lockRun('diag', '连接测试')) return;
    UI.busy('正在测试连接…');
    try {
      var r = await API.test(cfg);
      UI.toast('连接成功：' + String(r.text || '').slice(0, 40));
    } catch (e) {
      UI.fail('连接失败', e, '常见原因：Base URL 少写/多写了 /v1；Key 错误；手机无法访问该域名（海外接口需代理）；或者该模型名不存在。');
    } finally {
      UI.unbusy(); unlockRun('diag');
    }
  };

  /* 拉取模型列表：结果注入当前表单面板，点选即填入模型名 */
  A['provider.fetchModels'] = async function () {
    var draft = sheetProviderDraft();
    if (!draft.baseUrl) { UI.toast('请先填写 Base URL'); return; }
    if (!lockRun('diag', '拉取模型列表')) return;
    UI.busy('正在拉取模型列表…');
    try {
      var models = await API.fetchModels(draft);
      injectModelPicker(document.getElementById('sheetBody'), models, draft.model);
      UI.toast('拉到 ' + models.length + ' 个模型');
    } catch (e) {
      UI.fail('拉取模型列表失败', e, '确认 Base URL / Key 是否正确；部分提供商不开放 /models 端点，此时只能手写模型名。');
    } finally {
      UI.unbusy(); unlockRun('diag');
    }
  };
  A['model.pick'] = function (el) {
    var m = el.getAttribute('data-model');
    var input = document.querySelector('#sheetBody [data-f="model"]');
    if (input) input.value = m;
    var box = document.getElementById('mdlPick');
    if (box) box.remove();
    UI.toast('已选择：' + m);
  };
  A['model.pickClose'] = function () {
    var box = document.getElementById('mdlPick');
    if (box) box.remove();
  };

  /* 查询余额 */
  A['provider.fetchBalance'] = async function () {
    var draft = sheetProviderDraft();
    if (!draft.baseUrl) { UI.toast('请先填写 Base URL'); return; }
    if (!lockRun('diag', '查询余额')) return;
    UI.busy('正在查询余额…');
    try {
      var r = await API.fetchBalance(draft);
      var txt = '余额：' + r.amount;
      var hint = document.getElementById('balHint');
      if (hint) hint.textContent = txt;
      UI.toast(txt);
    } catch (e) {
      UI.fail('查询余额失败', e, 'DeepSeek / Moonshot / 硅基流动等可自动识别；其他提供商可在表单里填写「余额查询地址」。');
    } finally {
      UI.unbusy(); unlockRun('diag');
    }
  };

  /* ---- 模型方案（预设） ---- */
  A['preset.newFor'] = function (el) {
    var pid = el.getAttribute('data-id');
    if (!Store.getProvider(pid)) { UI.toast('提供商不存在'); return; }
    openPresetForm(null, pid);
  };
  A['preset.new'] = function () {
    if (!Store.state.providers.length) { UI.toast('请先添加一个 API 提供商'); return; }
    openPresetForm(null, null);
  };
  A['preset.edit'] = function (el) {
    var m = Store.getModelPreset(el.getAttribute('data-id'));
    if (!m) return;
    openPresetForm(m, null);
  };
  A['preset.del'] = async function (el) {
    var m = Store.getModelPreset(el.getAttribute('data-id'));
    if (!m) return;
    var ok = await UI.confirm('删除模型方案', '确定删除「' + (m.name || '') + '」？', '删除', true);
    if (!ok) return;
    Store.removeModelPreset(m.id);
    UI.route();
  };
  /* 生成前预览开关（在预览面板里勾「以后不再预览」也会设置同一个值） */
  A['ui.togglePreview'] = function () {
    Store.state.ui.injectPreview = Store.state.ui.injectPreview === false;
    Store.save();
    UI.toast(Store.state.ui.injectPreview === false ? '已关闭生成前预览' : '已重新开启生成前预览');
    UI.route();
  };
  A['usage.reset'] = async function () {
    var ok = await UI.confirm('清零用量统计', '会把全部作品的输入 / 输出 token 与估算成本归零（不影响正文与记忆）。', '清零', true);
    if (!ok) return;
    Store.resetUsage();
    UI.toast('用量统计已清零');
    UI.route();
  };
  /* ---- 任务分工：直接指派「某类活用哪套方案」 ----
   * 光在方案表单里设「专用于」不够直观——用户得自己记哪套绑了什么。
   * 这里从分工表反向操作：点某类任务的「指派…」，选方案即可。 */
  /* 流式写作时「继续跟随」：用户上翻看了前文之后，一键把视图拉回输出末尾并恢复自动跟随 */
  A['reader.follow'] = function () {
    Reader.resumeFollow();
  };

  A['route.assign'] = function (el) {
    var task = el.getAttribute('data-task');
    var presets = Store.state.modelPresets || [];
    var cur = presets.filter(function (m) { return m.task === task; })[0] || null;
    function btn(id, name, sub, on) {
      return '<button class="btn block ' + (on ? 'primary' : 'ghost') + '" ' +
        'style="justify-content:flex-start;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px" ' +
        'data-act="route.set" data-task="' + esc(task) + '" data-id="' + esc(id) + '">' +
        '<span style="font-weight:600">' + esc(name) + (on ? ' ✓' : '') + '</span>' +
        '<span class="tiny muted">' + esc(sub) + '</span></button>';
    }
    var fb = Store.state.activePresetId ? Store.getModelPreset(Store.state.activePresetId) : null;
    var html = '<div class="list">' +
      btn('', '用兜底方案（不单独指派）', fb ? '当前兜底：' + (fb.name || '未命名方案') : '尚未设置兜底方案', !cur) +
      presets.map(function (m) {
        var pv = Store.getProvider(m.providerId);
        var sub = (pv ? pv.name : '提供商已删除') + ' · ' + (m.model || '');
        if (m.task && m.task !== task) sub += '　（已专职 ' + Store.taskLabel(m.task) + '，指派过来会取消那边）';
        return btn(m.id, m.name || '未命名方案', sub, !!(cur && cur.id === m.id));
      }).join('') + '</div>';
    UI.openSheet({
      title: '「' + esc(Store.taskLabel(task)) + '」用哪套方案',
      body: html + '<div class="hint mt8">同一类任务只能有一套方案；指派给新的，旧的那套会自动取消。' +
        '不指派就用兜底方案。</div>',
      buttons: [{ text: '关闭', cls: 'primary' }]
    });
  };
  A['route.set'] = function (el) {
    var task = el.getAttribute('data-task');
    var id = el.getAttribute('data-id') || '';
    var name = '';
    if (id) {
      var m = Store.getModelPreset(id);
      name = m ? (m.name || '未命名方案') : '';
    }
    Store.assignTask(task, id);
    UI.closeSheet();
    UI.toast(id
      ? '「' + Store.taskLabel(task) + '」已指派给「' + name + '」'
      : '「' + Store.taskLabel(task) + '」改为用兜底方案');
    UI.route();
  };

  A['preset.use'] = function (el) {
    var id = el.getAttribute('data-id');
    if (Store.useModelPreset(id)) {
      var m = Store.getModelPreset(id);
      UI.toast('兜底方案已切换为「' + (m.name || '') + '」（专职方案的任务不受影响）');
    }
    UI.closeSheet();
    UI.route();
  };

  /* ---- 悬浮球：查看最近 AI 上下文 / 切换模型预设 ---- */
  /* 最近 3 条请求记录的面板状态（记录本体在 api.js 的环形缓冲里） */
  var ctxPanel = { log: [], sel: 0 };

  function renderCtxBody() {
    var log = ctxPanel.log;
    var r = log[ctxPanel.sel];
    if (!r) return '<div class="empty-tip">记录已失效，请重新打开。</div>';
    function hm(ts) {
      var t = new Date(ts);
      var a = function (n) { return ('0' + n).slice(-2); };
      return a(t.getHours()) + ':' + a(t.getMinutes()) + ':' + a(t.getSeconds());
    }
    // 切换条：每次请求一条（正文生成 / 记忆整理不会互相覆盖）
    var picker = '<div class="row-wrap mb8">' + log.map(function (x, i) {
      return '<button class="btn sm' + (i === ctxPanel.sel ? ' primary' : ' ghost') + '" ' +
        'data-act="fab.ctxPick" data-idx="' + i + '">' + (i + 1) + '. ' + hm(x.at) + ' · ' + esc(x.kind || 'AI 请求') + '</button>';
    }).join('') + '</div>';

    return picker +
      '<div class="hint mb8">' + esc(r.provider || '（未命名提供商）') + ' · ' + esc(r.model || '') +
      ' · ' + hm(r.at) + '（密钥已脱敏，可复制）<br>最近 ' + log.length + ' 次请求各占一条：生成正文后紧接着的记忆整理不会再把它覆盖掉。</div>' +
      '<div class="section-title" style="margin-top:0">请求地址</div>' +
      '<div class="card small" style="word-break:break-all">' + esc(r.url) + '</div>' +
      '<div class="section-title">请求头</div>' +
      '<div class="card small" style="white-space:pre-wrap;max-height:20vh;overflow:auto">' + esc(JSON.stringify(r.headers, null, 2)) + '</div>' +
      '<div class="section-title">请求体</div>' +
      '<div class="card small" style="white-space:pre-wrap;max-height:42vh;overflow:auto">' + esc(r.body) + '</div>';
  }

  /* ---- 悬浮球：撤销上次生成 ----
   * 现在有两套可撤销的记录：
   *   ① undoStack —— 正文生成 / AI 重写 / 划线改稿（只弹出栈顶那一条）
   *   ② txns      —— 小编改动（按对象快照还原）
   * 这里把当前这本书「最近一次可撤销的改动」找出来；不在书本页时，
   * 退而在全部作品里找最近的那一次，免得用户在书架页点了个没反应的按钮。
   */
  function chapterLabel(b, chapterId) {
    var i = Store.chapterIndex(b, chapterId);
    if (i < 0) return '（章节已删除）';
    var c = b.chapters[i];
    return '第' + (i + 1) + '章' + (c.title ? '《' + c.title + '》' : '');
  }

  function undoCandidates(b) {
    var out = [];
    var top = (b.undoStack || [])[b.undoStack.length - 1];
    if (top) {
      out.push({
        src: 'stack', id: top.id, at: top.createdAt || 0,
        kind: top.kind === 'patch' ? 'patch' : 'write',
        title: chapterLabel(b, top.chapterId),
        label: top.kind === 'patch' ? '划线改稿' : 'AI 生成正文'
      });
    }
    var t = (b.txns || [])[b.txns.length - 1];
    if (t) {
      out.push({
        src: 'txn', id: t.id, at: t.at || 0, kind: 'txn',
        title: t.label || '小编的改动',
        label: '改动 ' + t.changes.length + ' 项'
      });
    }
    out.sort(function (x, y) { return y.at - x.at; });
    return out;
  }

  function hmTime(ts) {
    if (!ts) return '';
    var t = new Date(ts);
    var p = function (n) { return ('0' + n).slice(-2); };
    return p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
  }

  function undoDescribe(c) {
    if (c.kind === 'write') {
      return '正文会回到生成前，本次写入的章节记忆、长期摘要与推荐设定一起回滚。';
    }
    if (c.kind === 'patch') {
      return '正文会回到划线改稿之前（那次只改了标记处，没有动记忆）。';
    }
    return '这条事务里记下的改动会全部退回原样（新增的删掉、改过的还原、删掉的插回原位置）。';
  }

  function doUndo(b, c) {
    if (c.src === 'stack') {
      undoLastAI(b.id);
    } else {
      Store.undoTxn(b, c.id);
      if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
      UI.route();
      UI.toast('已撤销：' + c.title);
    }
  }

  function runUndo(b, c) {
    // 单行拼，别用 \n：confirm 的消息体走 esc()，换行不会渲染出来
    UI.confirm('撤销 · ' + c.title,
      c.label + '（' + hmTime(c.at) + '）。' + undoDescribe(c), '撤销', true).then(function (ok) {
        if (ok) doUndo(b, c);
      });
  }

  A['fab.undo'] = function () {
    Fab.closePanel();
    var b = curBook();
    var cands = b ? undoCandidates(b) : [];
    if (!cands.length) {
      // 不在书本页、或这本书没得撤：在全部作品里找最近的一次
      var best = null, bestAt = -1;
      (Store.state.books || []).forEach(function (x) {
        var l = undoCandidates(x);
        if (l.length && l[0].at > bestAt) { bestAt = l[0].at; best = { b: x, c: l[0] }; }
      });
      if (!best) {
        UI.openSheet({
          title: '撤销上次生成',
          body: '<div class="empty-tip">没有可撤销的 AI 改动。<br>' +
            '生成一次正文、划线改稿，或让小编改过设定之后，这里就能一键退回。</div>',
          buttons: [{ text: '知道了', cls: 'primary' }]
        });
        return;
      }
      b = best.b; cands = [best.c];
    }
    // 只有一条时直接问，少一次点击
    if (cands.length === 1) { runUndo(b, cands[0]); return; }
    UI.openSheet({
      title: '撤销上次生成',
      body: '<div class="hint mb8">《' + esc(b.title) + '》里最近可撤销的改动，选一条退回：</div>' +
        cands.map(function (c) {
          return '<div class="entry">' +
            '<div class="entry-head"><div class="entry-name">' + esc(c.title) + '</div>' +
            '<span class="chip">' + esc(c.label) + '</span></div>' +
            '<div class="tiny muted mt4">' + hmTime(c.at) + '</div>' +
            '<div class="row-wrap mt8">' +
            '<button class="btn sm" data-act="fab.undoPick" data-src="' + c.src + '" data-id="' + c.id + '">撤销这一条</button>' +
            '</div></div>';
        }).join(''),
      buttons: [{ text: '关闭' }]
    });
  };

  A['fab.undoPick'] = function (el) {
    var b = curBook();
    if (!b) return;
    var c = undoCandidates(b).filter(function (x) {
      return x.src === el.getAttribute('data-src') && x.id === el.getAttribute('data-id');
    })[0];
    UI.closeSheet();
    if (c) runUndo(b, c);
  };

  A['fab.ctx'] = function () {
    Fab.closePanel();
    var log = API.requestLog();
    if (!log.length) {
      UI.openSheet({
        title: '最近 AI 上下文',
        body: '<div class="empty-tip">还没有发送过任何 AI 请求。<br>生成一次正文或大纲后，这里会显示当时发给接口的完整内容（密钥自动脱敏）。<br>系统保留最近 3 次请求，可随时切换查看。</div>',
        buttons: [{ text: '知道了', cls: 'primary' }]
      });
      return;
    }
    ctxPanel.log = log;
    ctxPanel.sel = 0;
    UI.openSheet({
      title: '最近 AI 上下文',
      body: renderCtxBody(),
      buttons: [
        {
          text: '复制', cls: '', onClick: function () {
            var r = ctxPanel.log[ctxPanel.sel];
            if (!r) return true;
            copyText('URL: ' + r.url + '\n\nHeaders:\n' + JSON.stringify(r.headers, null, 2) + '\n\nBody:\n' + r.body);
            UI.toast('已复制'); return true;
          }
        },
        { text: '关闭', cls: 'primary' }
      ]
    });
  };
  /* 在最近 3 条请求之间切换（不关面板） */
  A['fab.ctxPick'] = function (el) {
    var i = parseInt(el.getAttribute('data-idx'), 10);
    if (!ctxPanel.log.length || isNaN(i) || i < 0 || i >= ctxPanel.log.length) return;
    ctxPanel.sel = i;
    var bodyEl = document.getElementById('sheetBody');
    if (bodyEl) bodyEl.innerHTML = renderCtxBody();
  };
  A['fab.presets'] = function () {
    Fab.closePanel();
    var presets = Store.state.modelPresets || [];
    if (!presets.length) {
      UI.openSheet({
        title: '切换模型预设',
        body: '<div class="empty-tip">还没有模型方案。<br>到「设置 → 模型方案」里新增一套（绑定提供商 + 选模型）。</div>',
        buttons: [
          { text: '去设置', cls: 'primary', onClick: function () { go('#/settings'); return true; } },
          { text: '关闭', cls: '' }
        ]
      });
      return;
    }
    var html = '<div class="list">' + presets.map(function (m) {
      var active = m.id === Store.state.activePresetId;
      var pv = Store.getProvider(m.providerId);
      var tag = m.task ? '　<span class="tiny muted">专职 ' + esc(Store.taskLabel(m.task)) + '</span>' : '';
      return '<button class="btn block' + (active ? ' primary' : ' ghost') + '" ' +
        'style="justify-content:flex-start;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px" ' +
        'data-act="preset.use" data-id="' + m.id + '">' +
        '<span style="font-weight:600">' + esc(m.name || '未命名方案') + (active ? ' ✓ 兜底' : '') + tag + '</span>' +
        '<span class="tiny muted">' + esc((pv ? pv.name : '提供商已删除') + ' · ' + (m.model || '')) + '</span></button>';
    }).join('') + '</div>';
    UI.openSheet({
      title: '切换兜底方案',
      body: '<div class="hint mb8">这里切的是<b>兜底方案</b>——只影响没有单独指派的任务。' +
        '已经在方案里设了「专用于」的任务仍走它自己的专职方案，不受影响。</div>' + html,
      buttons: [
        { text: '去设置管理', cls: '', onClick: function () { go('#/settings'); return true; } },
        { text: '关闭', cls: 'primary' }
      ]
    });
  };

  /* =========================================================
   * 可拖动悬浮球
   * 交互约定（按用户要求）：点一下只出选项面板，再点面板里的功能才执行。
   * - pointer 事件只负责「拖动」：位移超 8px 算拖动，拖动时不弹面板；
   * - 面板开合统一走 click：pointerup 里改布局会让紧随其后的 click
   *   命中刚弹出的面板（面板以球为中心定位，会盖住球），
   *   于是「点一下」直接触发面板第一个按钮 —— 这正是之前
   *   「点击默认进入查看上下文」的根因；
   * - 拖动结束后浏览器补发的 click 用 moved 标记吞掉，不会误开面板。
   * 位置记在 Store.state.ui.fabPos，刷新后保留。
   * ========================================================= */
  var Fab = {
    el: null, panel: null, drag: null, moved: false,
    init: function () {
      this.el = document.getElementById('fab');
      this.panel = document.getElementById('fabPanel');
      if (!this.el || !this.panel) return;
      var self = this;
      var pos = Store.state.ui.fabPos;
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') this.applyPos(pos.x, pos.y);
      this.el.addEventListener('pointerdown', function (e) { self.onDown(e); });
      this.el.addEventListener('pointermove', function (e) { self.onMove(e); });
      this.el.addEventListener('pointerup', function (e) { self.onUp(e); });
      this.el.addEventListener('pointercancel', function () { self.onUp(); });
      this.el.addEventListener('click', function () { self.onClick(); });
      document.addEventListener('click', function (e) {
        if (self.panel.classList.contains('hidden')) return;
        if (self.el.contains(e.target) || self.panel.contains(e.target)) return;
        self.closePanel();
      });
      global.addEventListener('resize', function () { self.clampIntoView(); });
    },
    applyPos: function (x, y) {
      this.el.style.left = x + 'px'; this.el.style.top = y + 'px';
      this.el.style.right = 'auto'; this.el.style.bottom = 'auto';
      this.positionPanel();
    },
    onDown: function (e) {
      this.drag = { x: e.clientX, y: e.clientY, left: this.el.offsetLeft, top: this.el.offsetTop };
      this.moved = false;
      try { this.el.setPointerCapture(e.pointerId); } catch (err) { }
    },
    onMove: function (e) {
      if (!this.drag) return;
      var dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (!this.moved && Math.abs(dx) + Math.abs(dy) > 8) { this.moved = true; this.closePanel(); }
      if (!this.moved) return;
      var w = this.el.offsetWidth, h = this.el.offsetHeight;
      var x = Math.min(Math.max(8, this.drag.left + dx), Math.max(8, global.innerWidth - w - 8));
      var y = Math.min(Math.max(8, this.drag.top + dy), Math.max(8, global.innerHeight - h - 8));
      this.applyPos(x, y);
    },
    onUp: function () {
      if (!this.drag) return;
      if (this.moved) {
        Store.state.ui.fabPos = { x: this.el.offsetLeft, y: this.el.offsetTop };
        Store.save();
      }
      // 没拖动也这里不开面板：等 click 到来再开（此时本次点击的目标已定型，
      // 不可能被刚弹出的面板抢走）。click 由 onClick 处理。
      this.drag = null;
    },
    onClick: function () {
      if (this.moved) { this.moved = false; return; }   // 拖动后补发的 click，忽略
      this.togglePanel();
    },
    togglePanel: function () {
      if (this.panel.classList.contains('hidden')) this.openPanel(); else this.closePanel();
    },
    openPanel: function () {
      // 必须先显示再测量：.hidden 是 display:none，隐藏时 offsetHeight 为 0，
      // 先定位会把面板盖到球上（点击落到面板按钮上）。
      this.panel.classList.remove('hidden');
      this.positionPanel();
    },
    closePanel: function () { this.panel.classList.add('hidden'); },
    positionPanel: function () {
      var w = this.el.offsetWidth, h = this.el.offsetHeight;
      var x = this.el.offsetLeft, y = this.el.offsetTop;
      var pw = this.panel.offsetWidth || 186;
      var ph = this.panel.offsetHeight || 120;
      var left = Math.min(Math.max(8, x + w / 2 - pw / 2), Math.max(8, global.innerWidth - pw - 8));
      // 面板只放在球的上方或下方，绝不盖住球本身（避免遮挡与误触）
      var top = y - ph - 10;
      if (top < 56) top = y + h + 10;
      this.panel.style.left = left + 'px';
      this.panel.style.top = top + 'px';
    },
    clampIntoView: function () {
      var w = this.el.offsetWidth, h = this.el.offsetHeight;
      var x = Math.min(Math.max(8, this.el.offsetLeft), Math.max(8, global.innerWidth - w - 8));
      var y = Math.min(Math.max(8, this.el.offsetTop), Math.max(8, global.innerHeight - h - 8));
      this.applyPos(x, y);
      Store.state.ui.fabPos = { x: x, y: y };
      Store.save();
    }
  };

  /* ---- 全局提示词 ---- */
  A['prompt.new'] = function () {
    UI.formSheet('新增全局提示词', [
      { key: 'title', label: '标题', value: '', placeholder: '如：对话风格' },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: '' }
    ], function (v) {
      if (!v.title && !v.content) return false;
      var p = Store.upsertGlobalPrompt({ title: v.title || '未命名提示词', content: v.content, enabled: true });
      // 新增的提示词默认挂载到所有书本
      Store.state.books.forEach(function (b) {
        if (b.globalPromptIds.indexOf(p.id) < 0) b.globalPromptIds.push(p.id);
      });
      Store.save(); UI.closeSheet(); UI.route();
    });
  };
  A['prompt.edit'] = function (el) {
    var p = Store.getGlobalPrompt(el.getAttribute('data-id'));
    UI.formSheet('编辑提示词', [
      { key: 'title', label: '标题', value: p.title },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: p.content }
    ], function (v) {
      Store.upsertGlobalPrompt({ id: p.id, title: v.title, content: v.content });
      UI.closeSheet(); UI.route();
    });
  };
  A['prompt.toggle'] = function (el) {
    var p = Store.getGlobalPrompt(el.getAttribute('data-id'));
    p.enabled = p.enabled === false; Store.save(); UI.route();
  };
  A['prompt.del'] = async function (el) {
    var ok = await UI.confirm('删除提示词', '所有书本都会解除对它的挂载。', '删除', true);
    if (!ok) return;
    Store.removeGlobalPrompt(el.getAttribute('data-id')); UI.route();
  };
  A['prompt.up'] = function (el) { Store.moveGlobalPrompt(el.getAttribute('data-id'), -1); UI.route(); };
  A['prompt.down'] = function (el) { Store.moveGlobalPrompt(el.getAttribute('data-id'), 1); UI.route(); };

  /* ---- 内置提示词模板（可多套方案） ---- */
  A['go.templates'] = function () { go('#/templates'); };
  A['template.open'] = function (el) { go('#/templates/' + el.getAttribute('data-key')); };
  A['template.use'] = function (el) {
    Store.setActiveScheme(el.getAttribute('data-key'), el.getAttribute('data-sid'));
    UI.route(); UI.toast('已切换为「' + (Store.getTemplateDef(el.getAttribute('data-key')).schemes.filter(function (s) { return s.id === el.getAttribute('data-sid'); })[0] || {}).name + '」');
  };
  A['template.edit'] = function (el) {
    var key = el.getAttribute('data-key'), sid = el.getAttribute('data-sid');
    var t = Store.getTemplateDef(key);
    var s = t.schemes.filter(function (x) { return x.id === sid; })[0];
    if (!s) return;
    UI.editFullText(t.name + ' · ' + s.name, s.content, function (txt) {
      Store.upsertScheme(key, { id: sid, name: s.name, content: txt });
      UI.route(); UI.toast('已保存该方案');
    });
  };
  A['template.rename'] = function (el) {
    var key = el.getAttribute('data-key'), sid = el.getAttribute('data-sid');
    var s = Store.getTemplateDef(key).schemes.filter(function (x) { return x.id === sid; })[0];
    UI.formSheet('方案改名', [{ key: 'name', label: '方案名', value: s.name }], function (v) {
      Store.upsertScheme(key, { id: sid, name: v.name || s.name });
      UI.route();
    });
  };
  A['template.copy'] = function (el) {
    var key = el.getAttribute('data-key'), sid = el.getAttribute('data-sid');
    var s = Store.getTemplateDef(key).schemes.filter(function (x) { return x.id === sid; })[0];
    Store.upsertScheme(key, { name: s.name + ' 副本', content: s.content });
    UI.route(); UI.toast('已复制为一套新方案');
  };
  A['template.new'] = function (el) {
    var key = el.getAttribute('data-key');
    var t = Store.getTemplateDef(key);
    var cur = t.schemes.filter(function (x) { return x.id === t.activeId; })[0] || t.schemes[0];
    UI.formSheet('新增一套方案', [
      { key: 'name', label: '方案名', value: '方案 ' + (t.schemes.length + 1) },
      { key: 'copy', type: 'checkbox', label: '以当前方案内容为基础', value: true }
    ], function (v) {
      Store.upsertScheme(key, { name: v.name || '新方案', content: v.copy ? cur.content : '' });
      UI.route();
    });
  };
  A['template.del'] = async function (el) {
    var ok = await UI.confirm('删除方案', '删除后不可恢复（至少会保留一套）。', '删除', true);
    if (!ok) return;
    if (!Store.removeScheme(el.getAttribute('data-key'), el.getAttribute('data-sid'))) {
      UI.toast('至少要保留一套方案');
    }
    UI.route();
  };
  A['template.reset'] = async function (el) {
    var ok = await UI.confirm('恢复默认', '该处的所有自定义方案会被清空，还原为内置写法。', '恢复默认', true);
    if (!ok) return;
    Store.resetTemplate(el.getAttribute('data-key'));
    UI.route(); UI.toast('已恢复内置默认');
  };

  /* ---- 记忆 ---- */
  A['memory.toggle'] = function (el) {
    var b = curBook();
    if (!b) return;
    b.memory.enabled = el.checked;
    Store.touchBook(b); Store.save();
    /* 必须重渲染：开关状态会出现在书架副标题（「记忆开 / 记忆关」）等别处，
     * 不 route() 的话那些地方会一直显示旧值，看起来像没生效。 */
    UI.route();
    UI.toast(b.memory.enabled ? '记忆系统已开启' : '记忆系统已关闭');
  };
  A['memory.editSummary'] = function () {
    var b = curBook();
    UI.editFullText('长期记忆摘要', b.memory.summary, function (t) {
      b.memory.summary = t; Store.touchBook(b); Store.save(); UI.route(); UI.toast('已保存');
    });
  };
  A['memory.view'] = function () {
    var b = curBook();
    var txt = AI.buildMemoryBlock(b) || '（当前没有可注入的记忆：记忆开关关闭，或还没有任何摘要与章节记忆）';
    UI.openSheet({
      title: '实际注入的记忆',
      body: '<div class="hint mb8">下一次生成正文时，这段内容会作为「完整长期记忆」发给模型。</div>' +
        '<div class="card small" style="white-space:pre-wrap;max-height:58vh;overflow:auto">' + esc(txt) + '</div>',
      buttons: [
        { text: '复制', onClick: function () { copyText(txt); UI.toast('已复制'); return true; } },
        { text: '关闭', cls: 'primary' }
      ]
    });
  };
  A['memory.edit'] = function (el) {
    var b = curBook();
    var e = b.memory.entries.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
    if (!e) return;
    UI.editFullText('编辑记忆', e.text, function (t) {
      e.text = t; Store.touchBook(b); Store.save(); UI.route(); UI.toast('已保存');
    });
  };
  A['memory.add'] = function () {
    UI.formSheet('手动添加记忆', [
      { key: 'text', type: 'textarea', tall: true, label: '记忆内容', value: '' }
    ], function (v) {
      if (!v.text.trim()) return false;
      var b = curBook();
      Store.addMemory(b, null, v.text, b.memory.summary);
      UI.route();
    });
  };
  A['memory.del'] = async function (el) {
    var ok = await UI.confirm('删除记忆', '删除后本章记忆不再参与后续生成。', '删除', true);
    if (!ok) return;
    Store.removeMemory(curBook(), el.getAttribute('data-id')); UI.route();
  };
  A['memory.clear'] = async function () {
    var ok = await UI.confirm('清空记忆', '长期摘要与全部章节记忆都会被清除（不会删除正文）。', '清空', true);
    if (!ok) return;
    var b = curBook();
    b.memory.summary = ''; b.memory.entries = []; b.undoStack = [];
    Store.touchBook(b); Store.save(); UI.route();
  };
  /* 重新生成记忆：自己勾选章节，默认选中所有还没有记忆的章节（导入的小说正需要） */
  A['memory.regen'] = function () {
    var b = curBook();
    if (!b) return;
    var withText = b.chapters.filter(function (c) { return c.content && c.content.trim(); });
    if (!withText.length) { UI.toast('还没有任何章节正文，无法生成记忆'); return; }
    var hasMem = {};
    b.memory.entries.forEach(function (e) { if (e.chapterId) hasMem[e.chapterId] = 1; });

    UI.checkSheet(
      '为哪些章节生成记忆',
      b.chapters.map(function (c, i) {
        var noMem = !hasMem[c.id];
        var usable = !!(c.content && c.content.trim());
        return {
          id: c.id, checked: usable && noMem, noMem: usable && noMem,
          name: '第' + (i + 1) + '章' + (c.title ? ' · ' + c.title : ''),
          hint: usable ? (AI.wordCount(c.content) + ' 字 · ' + (noMem ? '暂无记忆' : '已有记忆')) : '（无正文，跳过）'
        };
      }).filter(function (x) { return x.hint.indexOf('无正文') < 0; }),
      {
        head: '<div class="hint mb8">默认勾选所有还没有记忆的章节（导入的小说通常全部如此）。选中的章节会按章节顺序重新总结，并依次合并进长期摘要。</div>',
        okText: '开始生成',
        actions: [
          { act: 'all', text: '全选' },
          { act: 'none', text: '全不选' },
          { act: 'noMemory', text: '只选无记忆的' }
        ]
      },
      async function (ids) {
        if (!ids.length) { UI.toast('没有选择任何章节'); return; }
        if (!lockRun('memory', '记忆生成')) return;
        var ac = new AbortController();
        UI.busy('生成记忆 0/' + ids.length, function () { ac.abort(); });
        try {
          var n = 0, sugIds = [];
          for (var k = 0; k < ids.length; k++) {
            var c = Store.getChapter(b, ids[k]);
            if (!c || !c.content) continue;
            UI.busyText('生成记忆 ' + (k + 1) + '/' + ids.length + '：第' + (Store.chapterIndex(b, c.id) + 1) + '章');
            /* 前情基线用「写这一章之前」的摘要；写回靠 addMemory 的按章去重（就地更新），
             * 所以这里**不能先删旧条目**——删了再总结，一旦失败这条记忆就凭空丢了。 */
            var prevSummary = Store.memoryBaseline(b, c);
            var r = await AI.summarizeMemory(b, c, { signal: ac.signal, prevSummary: prevSummary });
            b.memory.summary = r.summary || b.memory.summary;
            Store.addMemory(b, c, r.pointsText, prevSummary);
            if (b.memory.suggestWorld !== false && r.world && r.world.length) {
              /* 与写章节时同一条链路：先让设定管理模型对照世界书整理，再进待办 */
              var gw = r.world;
              if (b.worldGovern !== false) {
                try {
                  var gg = await AI.governWorld(b, c, r.world, { signal: ac.signal });
                  if (gg && (gg.add.length || gg.update.length)) gw = gg.add.concat(gg.update);
                } catch (ge) {
                  console.warn('设定管理模型整理失败，回退用原始候选：', ge && ge.message);
                }
              }
              sugIds = sugIds.concat(Store.addWorldSuggestions(b, gw, c));
            }
            n++;
          }
          Store.touchBook(b); Store.save();
          UI.unbusy(); UI.toast('已生成 ' + n + ' 章记忆'); UI.route();
          suggestToast(b, sugIds.length);
        } catch (e) {
          UI.unbusy();
          if (e && e.name === 'AbortError') UI.toast('已中止，已生成的记忆会保留');
          else UI.toast(e.message || String(e));
          Store.save(); UI.route();
        } finally {
          unlockRun('memory');
        }
      }
    );
  };

  /* =========================================================
   * 快捷导入
   * ========================================================= */
  function importDraft() { return Store.state.ui.importDraft; }

  A['import.mode'] = function (el) {
    var d = importDraft();
    d.mode = el.getAttribute('data-mode') === 'ai' ? 'ai' : 'regex';
    UI.importPreview = null;
    Store.saveSoon(); UI.route();
  };
  A['import.clear'] = function () {
    var d = importDraft();
    d.text = ''; UI.importPreview = null;
    Store.saveSoon(); UI.route(); UI.toast('已清空');
  };
  A['import.paste'] = function () {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) {
          if (!t) { UI.toast('剪贴板是空的'); return; }
          var d = importDraft(); d.text = t;
          Store.saveSoon(); UI.route(); UI.toast('已粘贴 ' + AI.wordCount(t) + ' 字');
        }).catch(function () { UI.toast('读取剪贴板失败，请手动长按粘贴'); });
      } else {
        UI.toast('当前环境不支持读取剪贴板，请手动粘贴');
      }
    } catch (e) { UI.toast('请手动粘贴'); }
  };
  A['import.file'] = function () {
    pickFile(function (txt) {
      var d = importDraft(); d.text = txt;
      Store.saveSoon(); UI.route();
      UI.toast('已读入 ' + AI.wordCount(txt) + ' 字');
    }, '.txt,.md,.json,text/plain');
  };
  A['import.preview'] = function () { doImport(true); };
  A['import.run'] = function () { doImport(false); };

  function applyImportInput(key, el) {
    var d = importDraft();
    var v = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'import.bookTitle') d.bookTitle = v;
    else if (key === 'import.myTag') d.myTag = v;
    else if (key === 'import.volumeTitle') d.volumeTitle = v;
    else if (key === 'import.keepContent') d.keepContent = v;
    else if (key === 'import.targetBook') d.targetBookId = v;
    Store.saveSoon();
  }

  async function doImport(previewOnly) {
    var d = importDraft();
    var text = (d.text || '').trim();
    if (!text) { UI.toast('请先粘贴文本'); return; }

    var volumes = [], title = d.bookTitle || '', synopsis = '';

    if (d.mode === 'regex') {
      var r = AI.splitDialog(text, { myTag: d.myTag || '我' });
      if (!r.chapters.length) {
        UI.importPreview = { chapters: [], reason: r.reason || '没有切出任何章节' };
        UI.route();
        UI.toast(r.reason || '没有切出任何章节');
        return;
      }
      title = title || '导入的作品';
      volumes = [{ title: d.volumeTitle || '第一卷', summary: '', chapters: r.chapters }];
    } else {
      var provider = Store.activeProvider();
      if (!provider) {
        var goSet = await UI.confirm('尚未配置 API', 'AI 整理需要先在「设置 → API 提供商」里添加一个可用的接口。', '去设置');
        if (goSet) go('#/settings');
        return;
      }
      if (!lockRun('import', 'AI 整理结构')) return;
      var ac = new AbortController();
      UI.busy('AI 正在整理结构…', function () { ac.abort(); });
      try {
        var res = await AI.extractBook(text, { keepContent: d.keepContent, signal: ac.signal });
        UI.unbusy();
        if (!res.volumes.length) { UI.toast('AI 没有整理出章节'); return; }
        volumes = res.volumes;
        synopsis = res.synopsis || '';
        title = title || res.title || '导入的作品';
      } catch (e) {
        UI.unbusy();
        if (e && e.name === 'AbortError') { UI.toast('已中止整理'); return; }
        UI.fail('整理失败', e, '文本太长时模型容易失败，可以分段导入，或改用「规则切分」。');
        return;
      } finally {
        unlockRun('import');
      }
    }

    var total = volumes.reduce(function (s, v) { return s + v.chapters.length; }, 0);
    if (previewOnly) {
      UI.importPreview = { chapters: volumes.reduce(function (a, v) { return a.concat(v.chapters); }, []), title: title };
      UI.route();
      UI.toast('切出 ' + total + ' 章，确认无误后点「导入」');
      return;
    }
    commitImport(title, volumes, synopsis, total);
  }

  function commitImport(title, volumes, synopsis, total) {
    var d = importDraft();
    var b = d.targetBookId ? Store.getBook(d.targetBookId) : null;
    var isNew = !b;
    if (isNew) {
      b = Store.createBook(title || '导入的作品');
      if (synopsis) b.synopsis = synopsis;
    }
    volumes.forEach(function (v) {
      var vol = Store.addVolume(b, v.title || (d.volumeTitle || '导入分卷'), v.summary || '');
      v.chapters.forEach(function (c) {
        Store.addChapter(b, { title: c.title, outline: c.outline, content: c.content, volumeId: vol.id });
      });
    });
    if (!b.lastChapterId && b.chapters.length) b.lastChapterId = b.chapters[0].id;
    Store.touchBook(b); Store.save();

    UI.importPreview = null;
    d.text = ''; Store.save();
    UI.toast((isNew ? '已新建《' + b.title + '》：' : '已追加：') + total + ' 章');
    go('#/book/' + b.id + '/chapters');
  }

  /* ---- 外观 ---- */
  A['ui.theme'] = function (el) {
    var t = el.getAttribute('data-theme') || 'dark';
    Store.state.ui.theme = t;
    Store.save();
    UI.applyTheme();
    UI.route();
    UI.toast('已切换为「' + ({ dark: '暗色', light: '亮色', sepia: '护眼纸' }[t] || t) + '」');
  };

  /* ---- 数据 ---- */
  A['data.export'] = function () {
    // 导出前把待写入的改动落盘，保证导出的就是屏幕上看到的内容
    Store.flush();
    Store.resetQuotaWarning();
    download(Store.exportAll(), 'novel-ai-backup.json');
    UI.toast('已导出全部数据');
  };
  A['data.import'] = function () {
    pickFile(function (txt) {
      try { Store.importAll(txt); UI.toast('导入成功'); UI.route(); }
      catch (e) { UI.toast('导入失败：' + e.message); }
    });
  };
  A['data.reset'] = async function () {
    var ok = await UI.confirm('清空全部数据', '所有作品、章节、记忆与接口配置都会被删除！', '确认清空', true);
    if (!ok) return;
    Store.resetAll(); go('#/books'); UI.route();
  };

  /* =========================================================
   * 工具
   * ========================================================= */
  /* 把一本作品拼成纯文本（导出 TXT 用），可选保留分卷与大纲 */
  function buildBookText(b, opts) {
    opts = opts || {};
    var out = [];
    var n = 0;
    var order = [];
    b.volumes.forEach(function (v) {
      order.push({ vol: v, chapters: b.chapters.filter(function (c) { return c.volumeId === v.id; }) });
    });
    var orphan = b.chapters.filter(function (c) { return !c.volumeId; });
    if (orphan.length) order.push({ vol: null, chapters: orphan });

    order.forEach(function (g) {
      var list = opts.onlyDone
        ? g.chapters.filter(function (c) { return c.content && c.content.trim(); })
        : g.chapters;
      if (!list.length) return;
      if (opts.withVolume && g.vol) {
        out.push('第' + (Store.volumeIndex(b, g.vol.id) + 1) + '卷 ' + (g.vol.title || '未命名'));
        out.push('');
      }
      list.forEach(function (c) {
        n++;
        out.push('第' + n + '章 ' + (c.title || ''));
        if (opts.withOutline && c.outline) { out.push(''); out.push('【大纲】' + c.outline); }
        out.push('');
        out.push(c.content || '');
        out.push('');
        out.push('');
      });
    });
    return out.join('\n').replace(/\n{4,}/g, '\n\n\n');
  }

  function pickFile(cb, accept) {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = accept || '.json,application/json,text/plain';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onerror = function () { UI.toast('读取文件失败'); };
      r.onload = function () { cb(String(r.result)); };
      r.readAsText(f, 'utf-8');
    };
    input.click();
  }

  /* =========================================================
   * 事件绑定
   * ========================================================= */
  // 这些动作执行后不自动关闭底部面板
  var KEEP_SHEET = { 'provider.preset': 1, 'reader.font': 1, 'noop': 1, 'provider.fetchModels': 1, 'provider.fetchBalance': 1, 'model.pick': 1, 'model.pickClose': 1, 'fab.ctxPick': 1 };

  function bind() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el) {
        if (e.target.hasAttribute && e.target.hasAttribute('data-sheet-close')) UI.closeSheet();
        return;
      }
      var act = el.getAttribute('data-act');
      if (act === 'noop') return;
      var fn = A[act];
      if (!fn) { console.warn('未实现的动作：', act); return; }
      if (el.disabled || el.getAttribute('disabled') !== null) return;
      e.preventDefault();
      // 面板内的动作：先关面板再执行，避免后面的 confirm / 新面板被关掉
      var inSheet = !!(el.closest && el.closest('#sheetBody'));
      if (inSheet && !KEEP_SHEET[act]) UI.closeSheet();
      fn(el, e);
    });

    var onInput = function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var key = el.getAttribute('data-act-input');
      if (key) { applyImportInput(key, el); return; }
      var path = el.getAttribute('data-bind');
      if (path) applyBind(path, el.value);
    };
    document.addEventListener('input', onInput);
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var key = el.getAttribute('data-act-input');
      if (key && (el.tagName === 'SELECT' || el.type === 'checkbox')) {
        applyImportInput(key, el);
        UI.route();     // 选项变化会影响页面上的提示文案
        return;
      }
      if (el.tagName === 'SELECT' && el.getAttribute('data-bind')) applyBind(el.getAttribute('data-bind'), el.value);
      // 框选改稿的意见框：失焦即存（用 change 而不是 input，改一个字就存会把光标顶掉）
      if (el.hasAttribute && el.hasAttribute('data-mark-note')) A['mark.setNote'](el);
    });

    document.addEventListener('keydown', function (e) {
      // Esc：关面板 / 关全屏编辑器（全屏编辑器优先，否则会连编辑内容一起丢）
      if (e.key === 'Escape') {
        var fe = document.getElementById('fullEditor');
        if (fe && !fe.classList.contains('hidden')) {
          fe.classList.add('hidden');
          return;
        }
        UI.closeSheet();
        return;
      }

      // 小编对话框：Enter 发送，Shift+Enter 换行
      if (e.target && e.target.id === 'chatText' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        A['chat.send']();
        return;
      }

      // 以下快捷键在输入框里一律不生效
      var t = e.target;
      var tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) {
        // 全屏编辑器里 Ctrl/Cmd+S 仍然保存
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          var fe2 = document.getElementById('fullEditor');
          if (fe2 && !fe2.classList.contains('hidden')) {
            e.preventDefault();
            document.getElementById('feSave').click();
          }
        }
        return;
      }

      // 阅读页：左右方向键翻章
      var seg = (location.hash || '').replace(/^#\/?/, '').split('/');
      if (seg[0] === 'read') {
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); Reader.flip(-1); return; }
        if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); Reader.flip(1); return; }
      }

      // Ctrl/Cmd+S：立刻落盘，并提示（防抖保存可能还没执行）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        Store.flush();
        UI.toast('已保存');
        return;
      }
      // Ctrl/Cmd+K：回到书架并聚焦搜索
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        go('#/books');
        setTimeout(function () {
          var el = document.getElementById('searchInput');
          if (el) el.focus();
        }, 60);
      }
    });

    global.addEventListener('hashchange', function () {
      UI.route();
      // 从章节列表点「✨ 生成正文」过来：进阅读页后自动开写
      if (App.autoGenerate) {
        var cid = App.autoGenerate; App.autoGenerate = null;
        var b = curBook();
        if (b && Store.getChapter(b, cid)) generateChapterFlow(b.id, cid, { force: false });
      }
    });
    global.addEventListener('resize', function () {
      if (Reader.el && Reader.el.vp) Reader.H = Reader.el.vp.clientHeight || Reader.H;
    });
  }

  /* =========================================================
   * 启动
   * ========================================================= */
  function start() {
    var dbErr = null;
    try {
      Store.init();
    } catch (e) {
      // 数据损坏且无备份：**不能**继续往下走，否则任何一次自动保存都会
      // 用空库覆盖掉那份还能抢救的原始数据。
      dbErr = e;
    }
    if (dbErr) {
      document.body.innerHTML =
        '<div style="max-width:560px;margin:18vh auto;padding:22px;font-family:system-ui,sans-serif;line-height:1.75">' +
        '<h2 style="margin:0 0 12px;font-size:19px">本地数据读取失败</h2>' +
        '<p style="color:#c66">' + Util.esc(dbErr.message) + '</p>' +
        '<p style="opacity:.8;font-size:13.5px">为避免覆盖，程序已停止载入，你原来的数据仍保留在浏览器里。<br>' +
        '可以先导出原始数据再决定怎么处理。</p>' +
        '<button id="__dump" style="padding:9px 14px;border-radius:10px;border:1px solid #888;background:transparent;color:inherit;cursor:pointer">导出原始数据</button>' +
        '<div style="margin-top:14px;font-size:12.5px;opacity:.7">若确认不需要旧数据，可在浏览器里清除本站点数据后重新打开。</div>' +
        '</div>';
      var btn = document.getElementById('__dump');
      if (btn) {
        btn.onclick = function () {
          var raw = '';
          try { raw = localStorage.getItem('novel_ai_db_v1') || ''; } catch (e2) { }
          Util.download(raw || '(空)', 'novel-ai-raw-dump.json');
        };
      }
      return;
    }

    UI.applyTheme();
    // 从备份恢复过：如实告知，避免用户以为数据凭空变了
    if (Store.recoveredFromBackup) {
      setTimeout(function () {
        UI.toast('检测到本地数据异常，已从自动备份恢复', 5000);
      }, 400);
    }
    bind();
    Fab.init();
    registerSW();
    if (!location.hash || location.hash === '#') location.hash = '#/books';
    UI.route();
  }

  /* 注册 Service Worker：让工具可以离线打开、可以装到桌面（PWA）。
   * 只在 http(s) 下注册——file:// 协议不支持，单文件版双击打开时会静默跳过。
   * 失败不影响使用，所以一律静默。 */
  function registerSW() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    if (String(location.protocol).indexOf('http') !== 0) return;
    try {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    } catch (e) { }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.App = App;
})(window);
