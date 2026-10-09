/* =========================================================
 * App —— 路由启动、事件委托与业务流程
 * ========================================================= */
(function (global) {
  'use strict';

  var App = { abort: null, saveTimer: null, autoGenerate: null };

  function esc(s) { return UI.esc(s); }

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

  /* ---------- data-bind 写入 ---------- */
  function applyBind(path, rawValue) {
    var seg = path.split('.');
    var scope = seg[0];
    var b = curBook();
    var value = rawValue;
    if (scope === 'book' && b) {
      if (seg[1] === 'targetWordsPerChapter') value = parseInt(rawValue, 10) || 0;
      // 支持 book.memory.keepRecent 这类嵌套字段
      var node = b;
      for (var i = 1; i < seg.length - 1; i++) {
        if (!node[seg[i]]) node[seg[i]] = {};
        node = node[seg[i]];
      }
      var last = seg[seg.length - 1];
      if (last === 'keepRecent' || last === 'targetWordsPerChapter') value = parseInt(rawValue, 10) || 0;
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
      if (p) { p[seg[2]] = (seg[2] === 'temperature' || seg[2] === 'maxTokens' || seg[2] === 'topP') ? (parseFloat(rawValue) || 0) : value; }
    } else if (scope === 'prompt') {
      var gp = Store.getGlobalPrompt(seg[1]);
      if (gp) { gp[seg[2]] = value; }
    }
    clearTimeout(App.saveTimer);
    App.saveTimer = setTimeout(function () { Store.save(); }, 300);
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

  async function generateChapterFlow(bookId, chapterId, force) {
    var b = Store.getBook(bookId), c = Store.getChapter(b, chapterId);
    if (!b || !c) return;
    var provider = Store.activeProvider();
    if (!provider) {
      await UI.confirm('尚未配置 API', '需要先在「设置 → API 提供商」里添加一个可用的接口。', '去设置');
      go('#/settings'); return;
    }
    if (!provider.apiKey && provider.type !== 'custom') {
      UI.toast('当前提供商未填写 API Key'); return;
    }
    if (!c.volumeId && b.volumes.length) c.volumeId = b.volumes[0].id;
    if (c.content && !force) {
      var ok = await UI.confirm('重新生成', '本章已有 ' + AI.wordCount(c.content) + ' 字正文。重新生成会覆盖它（之后可用「撤回」恢复），继续？', '重新生成');
      if (!ok) return;
    }

    var ac = new AbortController();
    App.abort = ac;
    UI.busy('AI 正在写作…', function () { ac.abort(); }, true);
    var last = 0, buf = '';
    try {
      var res = await AI.generateChapter(b, c, {
        signal: ac.signal,
        onPhase: function (p) {
          if (p === 'memory') UI.busyText('正在写入长期记忆…');
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
      UI.toast('完成：' + AI.wordCount(c.content) + ' 字' + (b.memory.enabled ? '，记忆已更新' : ''));
      suggestToast(b, res && res.worldSugIds ? res.worldSugIds.length : 0);
    } catch (e) {
      UI.unbusy();
      if (e && e.name === 'AbortError') {
        if (buf) {
          c.content = AI.cleanText(buf); c.updatedAt = Date.now();
          Store.touchBook(b); Store.save();
          if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
        }
        UI.toast('已中止，已保留生成的部分内容');
      } else {
        UI.openSheet({
          title: '生成失败',
          body: '<div style="font-size:13.5px;white-space:pre-wrap">' + esc(e && e.message ? e.message : String(e)) + '</div>',
          buttons: [{ text: '知道了', cls: 'primary' }]
        });
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
          html: '<div class="hint mb12">把分卷大纲拆成若干章，为每章生成一段「章节大纲 prompt」，生成后可在章节列表点「✎ 大纲」逐条修改。</div>'
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
      UI.busy('正在拆分章节大纲…');
      try {
        var arr = await AI.generateOutlines(b, vol, n);
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
        go('#/chapters/' + bookId);
      } catch (e) {
        UI.unbusy();
        UI.openSheet({
          title: '分章失败',
          body: '<div style="font-size:13.5px;white-space:pre-wrap">' + esc(e && e.message ? e.message : String(e)) + '</div>',
          buttons: [{ text: '知道了', cls: 'primary' }]
        });
        return false;
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
      c.updatedAt = Date.now();
    }
    var entry = u.memoryEntryId ? b.memory.entries.filter(function (e) { return e.id === u.memoryEntryId; })[0] : null;
    if (entry) {
      b.memory.summary = entry.summaryBefore || '';
      b.memory.entries = b.memory.entries.filter(function (e) { return e.id !== u.memoryEntryId; });
    } else if (typeof u.summaryBefore === 'string') {
      b.memory.summary = u.summaryBefore;
    }
    // 这次生成顺带推荐出来的设定也一并撤回
    if (u.worldSugIds && u.worldSugIds.length) {
      Store.dismissWorldSuggestions(b, u.worldSugIds);
    }
    Store.touchBook(b); Store.save();
    if (Reader.book && Reader.book.id === b.id) Reader.refreshCur();
    UI.toast('已撤回上次 AI 生成，记忆同步回滚');
  }

  /* =========================================================
   * 动作表
   * ========================================================= */
  var A = {};

  A['nav'] = function (el) { go(el.getAttribute('data-to')); };
  A['go.settings'] = function () { go('#/settings'); };
  A['go.recent'] = function () { go('#/recent'); };

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
  A['book.chapters'] = function (el) { go('#/chapters/' + (el.getAttribute('data-id') || bookIdFromHash())); };
  A['book.tab'] = function (el) { go('#/book/' + bookIdFromHash() + '/' + el.getAttribute('data-tab')); };
  A['book.menu'] = function (el) {
    var id = el.getAttribute('data-id') || bookIdFromHash();
    var b = Store.getBook(id);
    UI.openSheet({
      title: b.title,
      body: '<div class="list">' +
        '<button class="btn block" data-act="book.rename" data-id="' + id + '">重命名</button>' +
        '<button class="btn block" data-act="book.dup" data-id="' + id + '">复制一本（含全部内容）</button>' +
        '<button class="btn block" data-act="book.export" data-id="' + id + '">导出 JSON</button>' +
        '<button class="btn block" data-act="book.exportTxt" data-id="' + id + '">导出正文 TXT</button>' +
        '<button class="btn block danger" data-act="book.delete" data-id="' + id + '">删除这本书</button>' +
        '</div>'
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
  A['book.export'] = function (el) { download(Store.exportBook(el.getAttribute('data-id')), (Store.getBook(el.getAttribute('data-id')).title || 'book') + '.json'); };
  A['book.exportTxt'] = function (el) {
    var b = Store.getBook(el.getAttribute('data-id'));
    var txt = b.chapters.map(function (c, i) {
      return '第' + (i + 1) + '章 ' + (c.title || '') + '\n\n' + (c.content || '');
    }).join('\n\n\n');
    download(txt, (b.title || 'book') + '.txt', 'text/plain');
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
  A['world.add'] = function (el) {
    var cat = el.getAttribute('data-cat');
    UI.formSheet('新增「' + AI.WORLD_LABEL[cat] + '」', [
      { key: 'name', label: '名称', value: '', placeholder: cat === 'characters' ? '如：林昭（男主）' : '如：黑石城' },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: '', placeholder: '越具体越好，AI 会原样注入上下文' }
    ], function (v) {
      Store.addWorldEntry(curBook(), cat, v.name, v.content);
      UI.route();
    });
  };
  A['world.edit'] = function (el) {
    var b = curBook(), cat = el.getAttribute('data-cat');
    var e = Store.getWorldEntry(b, cat, el.getAttribute('data-id'));
    UI.formSheet('编辑条目', [
      { key: 'name', label: '名称', value: e.name },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: e.content }
    ], function (v) {
      e.name = v.name; e.content = v.content; e.updatedAt = Date.now();
      Store.touchBook(b); Store.save(); UI.route();
    });
  };
  A['world.toggle'] = function (el) {
    var b = curBook(), cat = el.getAttribute('data-cat');
    var e = Store.getWorldEntry(b, cat, el.getAttribute('data-id'));
    e.enabled = e.enabled === false; Store.touchBook(b); Store.save(); UI.route();
  };

  /* ---- AI 推荐的设定：查看 / 选择转正 / 忽略 ---- */
  A['memory.suggestToggle'] = function (el) {
    var b = curBook();
    if (!b) return;
    b.memory.suggestWorld = el.checked;
    Store.save();
    UI.toast(b.memory.suggestWorld ? '已开启：生成记忆时会推荐新设定' : '已关闭：不再推荐新设定');
  };
  A['world.sug.accept'] = function (el) {
    var b = curBook();
    if (Store.acceptWorldSuggestion(b, el.getAttribute('data-id'))) {
      UI.toast('已转正'); UI.route();
    }
  };
  A['world.sug.edit'] = function (el) {
    var b = curBook();
    var s = Store.getWorldSuggestion(b, el.getAttribute('data-id'));
    if (!s) return;
    UI.formSheet('修改后转正', [
      { key: 'name', label: '名称', value: s.name },
      { key: 'content', type: 'textarea', tall: true, label: '内容', value: s.content },
      {
        key: 'cat', type: 'select', label: '归入分栏', value: s.cat,
        options: AI.WORLD_ORDER.map(function (c) { return { value: c, label: AI.WORLD_LABEL[c] }; })
      }
    ], function (v) {
      Store.acceptWorldSuggestion(b, s.id, v);
      UI.toast('已转正到「' + AI.WORLD_LABEL[v.cat] + '」'); UI.route();
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
    if (!ids.length) { UI.toast('没有待转正的推荐'); return; }
    UI.confirm('全部转正', '把 ' + ids.length + ' 条推荐设定全部写进对应分栏（同名条目会追加合并）。', '全部转正').then(function (ok) {
      if (!ok) return;
      ids.forEach(function (id) { Store.acceptWorldSuggestion(b, id); });
      UI.toast('已转正 ' + ids.length + ' 条'); UI.route();
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
        ids.forEach(function (id) { Store.acceptWorldSuggestion(b, id); });
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
    var provider = Store.activeProvider();
    if (!provider) {
      UI.confirm('尚未配置 API', 'AI 整理需要先在「设置 → API 提供商」里添加一个可用的接口。', '去设置').then(function (ok) {
        if (ok) go('#/settings');
      });
      return;
    }
    UI.editFullText('把想法一股脑写在这里', '', function (text) {
      if (!text || !text.trim()) return;
      UI.busy('AI 正在整理设定…');
      AI.extractWorld(b, text).then(function (items) {
        UI.unbusy();
        if (!items.length) { UI.toast('AI 没有识别出设定条目'); return; }
        showWorldExtract(b, items);
      }).catch(function (e) {
        UI.unbusy();
        UI.openSheet({
          title: '整理失败',
          body: '<div style="font-size:13.5px;white-space:pre-wrap">' + esc(e && e.message ? e.message : String(e)) + '</div>',
          buttons: [{ text: '知道了', cls: 'primary' }]
        });
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
        ids.forEach(function (id) {
          var it = items[parseInt(id, 10)];
          if (!it) return;
          var exist = (b.world[it.cat] || []).filter(function (e) { return e.name && e.name === it.name; })[0];
          if (exist) {
            exist.content = exist.content ? exist.content + '\n' + it.content : it.content;
            exist.enabled = true;
          } else {
            Store.addWorldEntry(b, it.cat, it.name, it.content);
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
          affected.forEach(function (c) { Store.moveChapterToVolume(b, c.id, vv.to); });
          Store.removeVolume(b, vid);
          UI.toast('已把 ' + affected.length + ' 章移到其他分卷');
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

  /* 章节列表里直接点「✨ 生成正文」：进阅读页后自动开写 */
  A['chapter.generate'] = function (el) {
    var b = curBook(), cid = el.getAttribute('data-id');
    if (!b || !Store.getChapter(b, cid)) return;
    App.autoGenerate = cid;
    go('#/read/' + b.id + '/' + cid);
  };
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
    UI.busy('正在生成大纲…');
    try {
      var r = await AI.generateSingleOutline(b, c);
      c.title = r.title || c.title; c.outline = r.outline || c.outline;
      c.updatedAt = Date.now(); Store.touchBook(b); Store.save();
      UI.unbusy(); UI.closeSheet(); UI.route(); UI.toast('大纲已更新');
    } catch (e) { UI.unbusy(); UI.toast(e.message || String(e)); }
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
      Store.touchBook(b); Store.touchChapter(b, c); Store.save();
      if (Reader.book && Reader.book.id === b.id) Reader.refreshCur(); else UI.route();
      UI.toast('已保存');
    });
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
    generateChapterFlow(b.id, c.id, false);
  };
  A['reader.menu'] = function () {
    var b = curBook();
    var fs = Store.state.ui.fontSize || 17;
    var hasUndo = b.undoStack.length > 0;
    UI.openSheet({
      title: '第' + (Reader.index + 1) + '章',
      body: '<div class="list">' +
        '<button class="btn block primary" data-act="reader.generate">✨ ' + (b.chapters[Reader.index].content ? '重新生成' : 'AI 生成本章') + '</button>' +
        '<button class="btn block" data-act="chapter.editContent">✎ 手动编辑正文</button>' +
        '<button class="btn block" data-act="reader.editOutline">✎ 编辑本章大纲</button>' +
        '<button class="btn block" data-act="reader.viewPrompt">🔍 查看注入的提示词</button>' +
        '<button class="btn block" data-act="reader.undo"' + (hasUndo ? '' : ' disabled') + '>↩ 撤回上次 AI 生成（含记忆）</button>' +
        '<div class="card small muted">撤回会把正文回滚到本次生成前，并删除本次写入的记忆、把长期记忆摘要恢复原样。</div>' +
        '<div class="card"><div class="row">' +
        '<span class="small">字号</span><div class="spacer"></div>' +
        '<button class="btn sm" data-act="reader.font" data-delta="-1">A−</button>' +
        '<span id="fsVal" style="min-width:34px;text-align:center">' + fs + '</span>' +
        '<button class="btn sm" data-act="reader.font" data-delta="1">A＋</button>' +
        '</div></div>' +
        '<button class="btn block ghost" data-act="nav" data-to="#/chapters/' + b.id + '">返回章节目录</button>' +
        '</div>'
    });
  };
  A['reader.font'] = function (el) {
    var d = parseInt(el.getAttribute('data-delta'), 10);
    var ui = Store.state.ui;
    ui.fontSize = Math.min(28, Math.max(13, (ui.fontSize || 17) + d));
    Store.save();
    var v = document.getElementById('fsVal'); if (v) v.textContent = ui.fontSize;
    Reader.refreshCur();
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

  /* ---- 提供商 ---- */
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
      { key: 'model', label: '模型名', value: p.model || 'gpt-4o-mini' },
      { key: 'temperature', type: 'number', label: '温度', value: p.temperature == null ? 0.85 : p.temperature },
      { key: 'maxTokens', type: 'number', label: '单次最大输出 Token', value: p.maxTokens || 4096 },
      { key: 'extraHeaders', type: 'textarea', label: '自定义请求头（可选）', value: p.extraHeaders || '', placeholder: '每行一条，如：\nX-Title: NovelWriter' }
    ];
  }
  A['provider.new'] = function () {
    UI.formSheet('新增提供商', providerFields(null), function (v) {
      v.temperature = parseFloat(v.temperature); v.maxTokens = parseInt(v.maxTokens, 10) || 4096;
      var p = Store.upsertProvider(v);
      Store.state.activeProviderId = p.id;
      Store.save(); UI.route();
    });
  };
  A['provider.edit'] = function (el) {
    var p = Store.getProvider(el.getAttribute('data-id'));
    UI.formSheet('编辑提供商', providerFields(p), function (v) {
      v.id = p.id;
      v.temperature = parseFloat(v.temperature); v.maxTokens = parseInt(v.maxTokens, 10) || 4096;
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
      if (f === 'model') inputs[i].value = pr.model;
      if (f === 'type') inputs[i].value = type;
      if (f === 'name' && !inputs[i].value) inputs[i].value = pr.name;
    }
    UI.toast('已填入 ' + pr.name + ' 的默认参数');
  };
  A['provider.use'] = function (el) {
    Store.state.activeProviderId = el.getAttribute('data-id'); Store.save(); UI.route();
  };
  A['provider.del'] = async function (el) {
    var ok = await UI.confirm('删除提供商', '确定删除这个接口配置？', '删除', true);
    if (!ok) return;
    Store.removeProvider(el.getAttribute('data-id')); UI.route();
  };
  A['provider.test'] = async function (el) {
    var p = Store.getProvider(el.getAttribute('data-id'));
    UI.busy('正在测试连接…');
    try {
      var r = await API.test(p);
      UI.unbusy();
      UI.toast('连接成功：' + String(r.text || '').slice(0, 40));
    } catch (e) {
      UI.unbusy();
      UI.openSheet({
        title: '连接失败',
        body: '<div style="font-size:13.5px;white-space:pre-wrap">' + esc(e.message || String(e)) + '</div>' +
          '<div class="hint mt12">常见原因：Base URL 少写/多写了 /v1；Key 错误；手机无法访问该域名（海外接口需代理）；或者该模型名不存在。</div>',
        buttons: [{ text: '知道了', cls: 'primary' }]
      });
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
    var b = curBook(); b.memory.enabled = el.checked; Store.touchBook(b); Store.save();
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
      body: '<div class="hint mb8">下一次生成正文时，这段内容会作为「前情记忆」发给模型。</div>' +
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
        var ac = new AbortController();
        UI.busy('生成记忆 0/' + ids.length, function () { ac.abort(); });
        try {
          var n = 0, sugIds = [];
          for (var k = 0; k < ids.length; k++) {
            var c = Store.getChapter(b, ids[k]);
            if (!c || !c.content) continue;
            UI.busyText('生成记忆 ' + (k + 1) + '/' + ids.length + '：第' + (Store.chapterIndex(b, c.id) + 1) + '章');
            // 先移除该章的旧记忆，避免重复累积
            var olds = b.memory.entries.filter(function (e) { return e.chapterId === c.id; });
            var prevSummary = olds.length ? (olds[0].summaryBefore || '') : (b.memory.summary || '');
            b.memory.entries = b.memory.entries.filter(function (e) { return e.chapterId !== c.id; });
            var r = await AI.summarizeMemory(b, c, { signal: ac.signal });
            b.memory.summary = r.summary || b.memory.summary;
            Store.addMemory(b, c, r.pointsText, prevSummary);
            if (b.memory.suggestWorld !== false && r.world && r.world.length) {
              sugIds = sugIds.concat(Store.addWorldSuggestions(b, r.world, c));
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
        }
      }
    );
  };
  A['memory.rebuild'] = A['memory.regen'];

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
      UI.busy('AI 正在整理结构…');
      try {
        var res = await AI.extractBook(text, { keepContent: d.keepContent });
        UI.unbusy();
        if (!res.volumes.length) { UI.toast('AI 没有整理出章节'); return; }
        volumes = res.volumes;
        synopsis = res.synopsis || '';
        title = title || res.title || '导入的作品';
      } catch (e) {
        UI.unbusy();
        UI.openSheet({
          title: '整理失败',
          body: '<div style="font-size:13.5px;white-space:pre-wrap">' + esc(e && e.message ? e.message : String(e)) + '</div>' +
            '<div class="hint mt12">文本太长时模型容易失败，可以分段导入，或改用「规则切分」。</div>',
          buttons: [{ text: '知道了', cls: 'primary' }]
        });
        return;
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
    go('#/chapters/' + b.id);
  }

  /* ---- 数据 ---- */
  A['data.export'] = function () { download(Store.exportAll(), 'novel-ai-backup.json'); };
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
  function download(text, filename, mime) {
    try {
      var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    } catch (e) { UI.toast('导出失败：' + e.message); }
  }
  function pickFile(cb, accept) {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = accept || '.json,application/json,text/plain';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () { cb(String(r.result)); };
      r.readAsText(f, 'utf-8');
    };
    input.click();
  }
  function copyText(t) {
    try {
      if (navigator.clipboard) { navigator.clipboard.writeText(t); return; }
    } catch (e) { }
    var ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { }
    ta.remove();
  }

  /* =========================================================
   * 事件绑定
   * ========================================================= */
  // 这些动作执行后不自动关闭底部面板
  var KEEP_SHEET = { 'provider.preset': 1, 'reader.font': 1, 'noop': 1 };

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
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') UI.closeSheet();
    });

    global.addEventListener('hashchange', function () {
      UI.route();
      // 从章节列表点「✨ 生成正文」过来：进阅读页后自动开写
      if (App.autoGenerate) {
        var cid = App.autoGenerate; App.autoGenerate = null;
        var b = curBook();
        if (b && Store.getChapter(b, cid)) generateChapterFlow(b.id, cid, false);
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
    Store.init();
    bind();
    if (!location.hash || location.hash === '#') location.hash = '#/books';
    UI.route();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.App = App;
})(window);
