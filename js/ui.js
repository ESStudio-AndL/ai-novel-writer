/* =========================================================
 * UI —— 界面渲染与交互动作
 * ========================================================= */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts), n = new Date();
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    if (d.toDateString() === n.toDateString()) return '今天 ' + p(d.getHours()) + ':' + p(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtNum(n) {
    n = n || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  }

  var UI = {
    currentBookId: null,
    importPreview: null,      // 快捷导入的切分预览
    esc: esc,

    /* ---------------- 基础组件 ---------------- */
    /* opts = { actionText, onAction }：可选一个轻量按钮，不弹面板 */
    toast: function (msg, ms, opts) {
      opts = opts || {};
      var root = $('toastRoot');
      var el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      var timer = null;
      var kill = function () {
        clearTimeout(timer);
        el.style.transition = 'opacity .25s'; el.style.opacity = 0;
        setTimeout(function () { el.remove(); }, 260);
      };
      if (opts.actionText) {
        el.style.pointerEvents = 'auto';
        var btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = opts.actionText;
        btn.onclick = function () {
          kill();
          if (opts.onAction) opts.onAction();
        };
        el.appendChild(btn);
      }
      root.appendChild(el);
      timer = setTimeout(kill, ms || 1900);
    },

    /* bar=true 时为顶部浮条模式，不遮挡正文 */
    busy: function (text, onCancel, bar) {
      $('busyText').textContent = text || '处理中…';
      $('busy').classList.remove('hidden');
      $('busy').classList.toggle('bar', !!bar);
      $('busyCancel').onclick = function () { if (onCancel) onCancel(); };
      $('busyCancel').classList.toggle('hidden', !onCancel);
    },
    busyText: function (text) { $('busyText').textContent = text; },
    unbusy: function () { $('busy').classList.add('hidden'); },

    /* 底部弹出面板 */
    openSheet: function (opts) {
      var root = $('sheetRoot');
      $('sheetTitle').textContent = opts.title || '';
      $('sheetBody').innerHTML = opts.body || '';
      var foot = $('sheetFoot');
      foot.innerHTML = '';
      var self = this;
      (opts.buttons || []).forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'btn ' + (b.cls || '');
        btn.textContent = b.text;
        btn.onclick = function () {
          var keep = false;
          if (b.onClick) keep = b.onClick(self.collectSheet()) === true;
          if (!keep) self.closeSheet();
        };
        foot.appendChild(btn);
      });
      if (!foot.children.length) foot.classList.add('hidden'); else foot.classList.remove('hidden');
      root.classList.remove('hidden');
      if (opts.onMount) opts.onMount($('sheetBody'));
      var first = $('sheetBody').querySelector('input,textarea,select');
      if (first && opts.focus !== false) setTimeout(function () { try { first.focus(); } catch (e) { } }, 120);
      return root;
    },
    collectSheet: function () {
      var out = {};
      var els = $('sheetBody').querySelectorAll('[data-f]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        out[el.getAttribute('data-f')] = el.type === 'checkbox' ? el.checked : el.value;
      }
      return out;
    },
    closeSheet: function () {
      $('sheetRoot').classList.add('hidden');
      $('sheetBody').innerHTML = '';
    },

    /* 表单面板 */
    formSheet: function (title, fields, onSubmit, extraBtn) {
      var html = fields.map(function (f) {
        if (f.type === 'html') return f.html;
        if (f.type === 'checkbox') {
          return '<label class="switch" style="margin:6px 0 12px">' +
            '<input type="checkbox" data-f="' + f.key + '"' + (f.value ? ' checked' : '') + '><span class="track"></span>' +
            '<span>' + esc(f.label) + '</span></label>';
        }
        if (f.type === 'select') {
          return '<div class="field"><label>' + esc(f.label) + '</label><select class="input" data-f="' + f.key + '">' +
            f.options.map(function (o) {
              return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(f.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
            }).join('') + '</select>' + (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') + '</div>';
        }
        var ta = f.type === 'textarea';
        return '<div class="field"><label>' + esc(f.label) + '</label>' +
          (ta ? '<textarea class="textarea' + (f.tall ? ' tall' : '') + '" data-f="' + f.key + '" placeholder="' + esc(f.placeholder || '') + '"' + (f.rows ? ' rows="' + f.rows + '"' : '') + '>' + esc(f.value || '') + '</textarea>'
            : '<input class="input" type="' + (f.type || 'text') + '" data-f="' + f.key + '" value="' + esc(f.value == null ? '' : f.value) + '" placeholder="' + esc(f.placeholder || '') + '"' + (f.min ? ' min=' + f.min : '') + (f.max ? ' max=' + f.max : '') + '>') +
          (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') + '</div>';
      }).join('');

      var buttons = [{ text: '取消', cls: 'ghost' }];
      if (extraBtn) buttons.push(extraBtn);
      buttons.push({
        text: '确定', cls: 'primary', onClick: function (v) {
          var r = onSubmit(v);
          // 返回 false：校验不通过，保持面板；返回 Promise：由业务自己收尾关闭
          if (r === false) return true;
          if (r && typeof r.then === 'function') return true;
          return false;
        }
      });
      return this.openSheet({ title: title, body: html, buttons: buttons });
    },

    /* 多选面板：items = [{id, name, hint, checked, noMem}] */
    checkSheet: function (title, items, opts, onSubmit) {
      opts = opts || {};
      var html = opts.head || '';
      html += '<div class="check-list">' + items.map(function (it) {
        return '<div class="check-item' + (it.checked ? ' on' : '') + '" data-check="' + esc(it.id) + '"' +
          (it.noMem ? ' data-nomem="1"' : '') + '>' +
          '<div class="check-box"></div>' +
          '<div class="check-main"><div class="check-name">' + esc(it.name) + '</div>' +
          (it.hint ? '<div class="tiny muted">' + esc(it.hint) + '</div>' : '') +
          '</div></div>';
      }).join('') + '</div>';
      if (opts.actions && opts.actions.length) {
        html += '<div class="row-wrap mt8">' + opts.actions.map(function (a) {
          return '<button class="btn sm" data-check-act="' + esc(a.act) + '">' + esc(a.text) + '</button>';
        }).join('') + '</div>';
      }
      return this.openSheet({
        title: title,
        body: html,
        focus: false,
        buttons: [{ text: '取消', cls: 'ghost' }, {
          text: opts.okText || '确定', cls: 'primary', onClick: function () {
            var ids = [];
            var els = document.querySelectorAll('#sheetBody .check-item.on');
            for (var i = 0; i < els.length; i++) ids.push(els[i].getAttribute('data-check'));
            onSubmit(ids);
            return false;
          }
        }],
        onMount: function (body) {
          body.onclick = function (e) {
            var it = e.target.closest ? e.target.closest('.check-item') : null;
            if (it) { it.classList.toggle('on'); return; }
            var ab = e.target.closest ? e.target.closest('[data-check-act]') : null;
            if (!ab) return;
            var act = ab.getAttribute('data-check-act');
            var all = body.querySelectorAll('.check-item');
            for (var i = 0; i < all.length; i++) {
              if (act === 'all') all[i].classList.add('on');
              else if (act === 'none') all[i].classList.remove('on');
              else if (act === 'noMemory') all[i].classList.toggle('on', all[i].getAttribute('data-nomem') === '1');
            }
          };
        }
      });
    },

    /* 多选一确认：返回被点按钮的序号；取消返回 -1 */
    choose: function (title, msg, buttons) {
      var self = this;
      return new Promise(function (resolve) {
        var btns = buttons.map(function (b, i) {
          return { text: b.text, cls: b.cls, onClick: function () { resolve(i); } };
        });
        btns.push({ text: '取消', cls: 'ghost', onClick: function () { resolve(-1); } });
        self.openSheet({
          title: title,
          body: '<div style="font-size:14.5px;line-height:1.7">' + esc(msg) + '</div>',
          buttons: btns
        });
      });
    },

    confirm: function (title, msg, okText, danger) {
      var self = this;
      return new Promise(function (resolve) {
        self.openSheet({
          title: title,
          body: '<div style="font-size:14.5px;line-height:1.7">' + esc(msg) + '</div>',
          buttons: [
            { text: '取消', cls: 'ghost', onClick: function () { resolve(false); } },
            { text: okText || '确定', cls: danger ? 'danger' : 'primary', onClick: function () { resolve(true); } }
          ]
        });
      });
    },

    /* 全屏文本编辑 */
    editFullText: function (title, value, onSubmit) {
      var wrap = $('fullEditor');
      $('feTitle').textContent = title;
      var ta = $('feText');
      ta.value = value || '';
      wrap.classList.remove('hidden');
      var st = $('feStatus');
      var upd = function () { st.textContent = AI.wordCount(ta.value) + ' 字'; };
      upd();
      ta.oninput = upd;
      $('feBack').onclick = function () { wrap.classList.add('hidden'); };
      $('feSave').onclick = function () {
        wrap.classList.add('hidden');
        if (onSubmit) onSubmit(ta.value);
      };
      setTimeout(function () { try { ta.focus(); } catch (e) { } }, 60);
    },

    /* ---------------- 顶栏 ---------------- */
    setAppBar: function (opts) {
      var el = $('appbar');
      var html = '';
      if (opts.back) html += '<button class="icon-btn" data-act="nav" data-to="' + esc(opts.back) + '">‹</button>';
      html += '<div class="appbar-title">' + esc(opts.title || '') + '</div>';
      (opts.actions || []).forEach(function (a) {
        html += '<button class="icon-btn ' + (a.cls || '') + '" data-act="' + esc(a.act) + '"' +
          (a.id ? ' data-id="' + esc(a.id) + '"' : '') + ' title="' + esc(a.title || a.text || '') + '">' + (a.text || a.icon) + '</button>';
      });
      el.innerHTML = html;
    },

    /* ---------------- 底部主导航 ---------------- */
    setTabBar: function (key) {
      var bar = $('tabbar');
      if (!bar) return;
      var hide = (key === 'none');
      bar.classList.toggle('hidden', hide);
      document.body.classList.toggle('has-tab', !hide);
      var btns = bar.querySelectorAll('.tab-item');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === key);
      }
    },

    /* =========================================================
     * 界面 1：书架
     * ========================================================= */
    renderBooks: function () {
      this.currentBookId = null;
      this.setAppBar({
        title: '我的书架',
        actions: [
          { act: 'book.new', icon: '＋', title: '新建作品' }
        ]
      });
      var books = Store.state.books;
      var html = '';
      if (!books.length) {
        html += '<div class="empty-tip">还没有作品。<br>点击右上角「＋」创建第一本书。</div>';
      } else {
        html += '<div class="list">';
        books.forEach(function (b) {
          var words = b.chapters.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0);
          var last = Store.lastChapter(b);
          html += '<div class="book-card">' +
            '<div class="book-cover" data-act="book.open" data-id="' + b.id + '">' + esc((b.title || '?').trim().slice(0, 1)) + '</div>' +
            '<div class="book-main" data-act="book.open" data-id="' + b.id + '">' +
            '<div class="book-title ellipsis">' + esc(b.title) + '</div>' +
            '<div class="book-sub">' + esc(b.genre || '未分类') + ' · ' + b.chapters.length + ' 章 · ' + fmtNum(words) + ' 字</div>' +
            '<div class="book-sub tiny">' + (b.memory.enabled ? '记忆开' : '记忆关') + ' · 更新 ' + fmtTime(b.updatedAt) + '</div>' +
            '<div class="row-wrap" style="margin-top:8px">' +
            (last ? '<button class="btn sm primary" data-act="recent.read" data-id="' + b.id + '">继续 第' + (Store.chapterIndex(b, last.id) + 1) + '章</button>' : '') +
            '<button class="btn sm" data-act="book.chapters" data-id="' + b.id + '">章节列表</button>' +
            '<button class="btn sm ghost" data-act="book.menu" data-id="' + b.id + '">更多</button>' +
            '</div>' +
            '</div></div>';
        });
        html += '</div>';
      }
      html += '<div class="mt16"><button class="btn block" data-act="book.new">＋ 新建作品</button></div>';
      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    /* =========================================================
     * 界面：最近浏览（每本书最近阅读 / 编辑的章节）
     * ========================================================= */
    renderRecent: function () {
      this.currentBookId = null;
      this.setAppBar({ title: '最近浏览' });
      var books = Store.state.books;
      var html = '';

      if (!books.length) {
        html += '<div class="empty-tip">还没有作品。<br>去「书架」新建一本，这里会自动记住每本书读 / 写到哪一章。</div>' +
          '<button class="btn block mt12 primary" data-act="nav" data-to="#/books">去书架</button>';
      } else {
        html += '<div class="hint mb12">每张卡片是一本书，记录你最近阅读或编辑的那一章；点卡片直接进入该章。</div>';
        var items = books.map(function (b) {
          var c = Store.lastChapter(b);
          return { b: b, c: c, t: c ? (b.lastReadAt || b.updatedAt || 0) : 0 };
        });
        items.sort(function (x, y) {
          if (!x.c && !y.c) return (y.b.updatedAt || 0) - (x.b.updatedAt || 0);
          if (!x.c) return 1;
          if (!y.c) return -1;
          return y.t - x.t;
        });

        items.forEach(function (it) {
          var b = it.b, c = it.c;
          var words = b.chapters.reduce(function (s, x) { return s + AI.wordCount(x.content); }, 0);
          html += '<div class="recent-card">';
          html += '<div class="recent-book"><span class="chip">' + esc(b.genre || '未分类') + '</span>' +
            '<span class="ellipsis">' + esc(b.title) + '</span></div>';
          if (!c) {
            html += '<div class="recent-chapter muted">还没有章节</div>' +
              '<div class="recent-preview">先在「大纲分卷」里写大纲，或用 AI 自动分章。</div>';
          } else {
            var idx = Store.chapterIndex(b, c.id);
            var prev = c.content ? c.content.replace(/\s+/g, ' ').slice(0, 90)
              : (c.outline ? '大纲：' + c.outline : '（本章还没有正文与大纲）');
            html += '<div class="recent-chapter" data-act="recent.read" data-id="' + b.id + '">' +
              '第' + (idx + 1) + '章' + (c.title ? ' · ' + esc(c.title) : '') + '</div>' +
              '<div class="recent-preview" data-act="recent.read" data-id="' + b.id + '">' + esc(prev) + '</div>' +
              '<div class="recent-meta">共 ' + b.chapters.length + ' 章 · 已写 ' + fmtNum(words) + ' 字 · ' +
              (c.content ? '已写 ' + fmtNum(AI.wordCount(c.content)) + ' 字 · ' : '') +
              (b.lastReadAt ? '停留于 ' + fmtTime(b.lastReadAt) : '更新 ' + fmtTime(b.updatedAt)) + '</div>';
          }
          html += '<div class="row-wrap mt8">' +
            (c ? '<button class="btn sm primary" data-act="recent.read" data-id="' + b.id + '">继续</button>' : '') +
            '<button class="btn sm" data-act="book.chapters" data-id="' + b.id + '">目录</button>' +
            '<button class="btn sm" data-act="book.open" data-id="' + b.id + '">书本</button>' +
            '<button class="btn sm ghost" data-act="book.menu" data-id="' + b.id + '">更多</button>' +
            '</div></div>';
        });
      }
      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    /* =========================================================
     * 界面：快捷导入
     * ========================================================= */
    renderImport: function () {
      this.currentBookId = null;
      this.setAppBar({ title: '快捷导入' });
      var d = Store.state.ui.importDraft;
      var books = Store.state.books;

      var html = '<div class="hint mb12">把别的软件导出的对话记录 / 小说文本粘贴进来，一键变成书本、分卷和章节。</div>';

      // —— 切分方式 ——
      html += '<div class="section-title" style="margin-top:4px">切分方式</div>';
      html += '<div class="row">' +
        '<button class="btn' + (d.mode === 'regex' ? ' primary' : '') + '" style="flex:1" data-act="import.mode" data-mode="regex">🔤 规则切分（免费）</button>' +
        '<button class="btn' + (d.mode === 'ai' ? ' primary' : '') + '" style="flex:1" data-act="import.mode" data-mode="ai">✨ AI 整理</button>' +
        '</div>';
      html += d.mode === 'regex'
        ? '<div class="hint">按发言标记切分：<b>【' + esc(d.myTag || '我') + '】</b>的内容进「章节大纲」，其他人的发言进「章节正文」。适合 OMate / 聊天类软件的导出记录。</div>'
        : '<div class="hint">整段交给 AI，让它识别书名、分卷与章节（需配置 API）。文本很长时建议先用规则切分。</div>';

      // —— 选项 ——
      html += '<div class="section-title">选项</div>';
      html += '<div class="card">' +
        '<div class="field"><label>书名' + (d.mode === 'ai' ? '（留空则由 AI 起名）' : '') + '</label>' +
        '<input class="input" data-act-input="import.bookTitle" value="' + esc(d.bookTitle) + '" placeholder="导入的作品"></div>' +
        (d.mode === 'regex'
          ? '<div class="field"><label>我的发言标记（其余发言都算正文）</label>' +
            '<input class="input" data-act-input="import.myTag" value="' + esc(d.myTag || '我') + '" placeholder="我"></div>' +
            '<div class="field"><label>分卷名（全部章节归入这一卷）</label>' +
            '<input class="input" data-act-input="import.volumeTitle" value="' + esc(d.volumeTitle || '第一卷') + '" placeholder="第一卷"></div>'
          : '<label class="switch" style="margin:6px 0 12px">' +
            '<input type="checkbox" data-act-input="import.keepContent"' + (d.keepContent ? ' checked' : '') + '><span class="track"></span>' +
            '<span>同时提取正文（长文本不建议）</span></label>') +
        '<div class="field"><label>导入到</label><select class="input" data-act-input="import.targetBook">' +
        '<option value=""' + (d.targetBookId ? '' : ' selected') + '>新建一本新书</option>' +
        books.map(function (b) {
          return '<option value="' + b.id + '"' + (d.targetBookId === b.id ? ' selected' : '') + '>追加到《' + esc(b.title) + '》</option>';
        }).join('') +
        '</select>' +
        (d.targetBookId ? '<div class="hint">追加时会新建分卷，章节接在该书末尾。</div>' : '') +
        '</div></div>';

      // —— 文本 ——
      html += '<div class="section-title">粘贴文本</div>';
      html += '<textarea class="textarea tall" id="importText" placeholder="在这里粘贴导出的对话记录或正文…">' + esc(d.text) + '</textarea>';
      html += '<div class="row mt8">' +
        '<button class="btn" style="flex:1" data-act="import.paste">📋 从剪贴板粘贴</button>' +
        '<button class="btn" style="flex:1" data-act="import.file">📄 选择 .txt 文件</button>' +
        '<button class="btn ghost" data-act="import.clear">清空</button>' +
        '</div>';
      html += '<div class="hint mt8" id="importStat">' + (d.text ? AI.wordCount(d.text) + ' 字' : '尚未输入内容') + '</div>';

      html += '<div class="mt16 row">' +
        '<button class="btn" style="flex:1" data-act="import.preview">🔍 预览切分结果</button>' +
        '<button class="btn primary" style="flex:1" data-act="import.run">导入</button>' +
        '</div>';

      // —— 预览 ——
      var pv = this.importPreview;
      if (pv) {
        html += '<div class="section-title">预览：' + pv.chapters.length + ' 章' + (pv.title ? '（《' + esc(pv.title) + '》）' : '') + '</div>';
        if (!pv.chapters.length) {
          html += '<div class="empty-tip">' + esc(pv.reason || '没有切出任何章节') + '</div>';
        } else {
          html += '<div class="list">' + pv.chapters.slice(0, 200).map(function (c, i) {
            return '<div class="entry">' +
              '<div class="entry-head"><div class="entry-name">第' + (i + 1) + '章 ' + esc(c.title || '（无标题）') + '</div>' +
              '<span class="tiny muted">' + fmtNum(AI.wordCount(c.content)) + ' 字</span></div>' +
              '<div class="entry-body">' + esc(c.outline || '（无大纲）') + '</div>' +
              '</div>';
          }).join('') + '</div>';
          if (pv.chapters.length > 200) html += '<div class="hint">仅显示前 200 章</div>';
        }
      }

      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
      var ta = $('importText');
      if (ta) {
        var self = this;
        ta.addEventListener('input', function () {
          d.text = ta.value;
          var st = $('importStat');
          if (st) st.textContent = ta.value ? AI.wordCount(ta.value) + ' 字' : '尚未输入内容';
        });
      }
    },

    /* =========================================================
     * 界面 2：书本编辑
     * ========================================================= */
    renderBookEdit: function (bookId, tab) {
      var b = Store.getBook(bookId);
      if (!b) { location.hash = '#/books'; return; }
      this.currentBookId = bookId;
      tab = tab || 'basic';
      var tabs = [
        ['basic', '基本信息'], ['world', '世界设定'], ['outline', '大纲分卷'],
        ['prompts', '提示词'], ['memory', '记忆'], ['data', '数据']
      ];
      this.setAppBar({
        title: b.title, back: '#/books',
        actions: [
          { act: 'book.chapters', id: bookId, icon: '☰', title: '章节列表' },
          { act: 'book.menu', id: bookId, icon: '⋮', title: '更多' }
        ]
      });

      var nSug = (b.worldSug || []).length;
      var html = '<div class="tabs">' + tabs.map(function (t) {
        var label = t[1];
        if (t[0] === 'world' && nSug) label += ' 💡' + nSug;
        return '<div class="tab' + (t[0] === tab ? ' active' : '') + '" data-act="book.tab" data-tab="' + t[0] + '">' + label + '</div>';
      }).join('') + '</div>';

      html += { basic: renderBasic, world: renderWorld, outline: renderOutline, prompts: renderPrompts, memory: renderMemory, data: renderData }[tab](b);

      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    /* =========================================================
     * 界面 3：章节列表
     * ========================================================= */
    renderChapters: function (bookId) {
      var b = Store.getBook(bookId);
      if (!b) { location.hash = '#/books'; return; }
      this.currentBookId = bookId;
      this.setAppBar({
        title: b.title + ' · 章节', back: '#/book/' + bookId + '/outline',
        actions: [
          { act: 'outline.ai', id: bookId, icon: '✨', title: 'AI 自动分章' },
          { act: 'chapter.new', id: bookId, icon: '＋', title: '新建章节' }
        ]
      });

      // 按分卷分组（父子结构）
      var groups = [], byId = {};
      b.volumes.forEach(function (v) { var g = { vol: v, items: [] }; byId[v.id] = g; groups.push(g); });
      var orphan = [];
      b.chapters.forEach(function (c, i) {
        var g = c.volumeId ? byId[c.volumeId] : null;
        if (g) g.items.push({ c: c, i: i }); else orphan.push({ c: c, i: i });
      });
      if (orphan.length) groups.push({ vol: null, items: orphan });

      var html = '';
      if (!b.chapters.length) {
        html += '<div class="empty-tip">还没有章节。<br>可以在「大纲分卷」里让 AI 自动切分章节大纲，<br>或点击右上角「＋」手动新建。</div>';
      } else {
        groups.forEach(function (g, gi) {
          if (g.vol) {
            html += '<div class="vol-head">' +
              '<div class="vol-title">第' + (gi + 1) + '卷《' + esc(g.vol.title || '未命名') + '》<span class="tiny muted"> · ' + g.items.length + ' 章</span></div>' +
              '<div class="row">' +
              '<button class="btn sm" data-act="outline.ai" data-id="' + g.vol.id + '">✨ 自动分章</button>' +
              '<button class="btn sm" data-act="chapter.new" data-id="' + bookId + '" data-vol="' + g.vol.id + '">＋ 本卷新章</button>' +
              '<button class="btn sm ghost" data-act="volume.edit" data-id="' + g.vol.id + '">✎ 卷大纲</button>' +
              '</div></div>';
          } else {
            html += '<div class="vol-head"><div class="vol-title">未归入分卷</div></div>';
          }
          if (!g.items.length) {
            html += '<div class="empty-tip" style="padding:14px">本卷还没有章节</div>';
          }
          html += '<div class="list">';
          g.items.forEach(function (it) {
            var c = it.c, i = it.i;
            var wc = AI.wordCount(c.content);
            var status = c.content ? '<span style="color:var(--ok)">已写 ' + fmtNum(wc) + ' 字</span>' : '<span class="muted">待生成</span>';
            html += '<div class="chapter-item' + (c.content ? ' done' : '') + '">' +
              '<div class="no" data-act="read" data-id="' + c.id + '">' + (i + 1) + '</div>' +
              '<div class="chapter-body">' +
              '<div class="chapter-title ellipsis" data-act="read" data-id="' + c.id + '">' + esc(c.title || ('第' + (i + 1) + '章')) + '</div>' +
              '<div class="chapter-outline" data-act="chapter.edit" data-id="' + c.id + '">' + esc(c.outline || '（暂无大纲，点此编辑）') + '</div>' +
              '<div class="chapter-meta">' + status + '</div>' +
              '<div class="row-wrap mt8">' +
              '<button class="btn sm" data-act="chapter.edit" data-id="' + c.id + '">✎ 大纲</button>' +
              '<button class="btn sm" data-act="chapter.moveVol" data-id="' + c.id + '">⇄ 换分卷</button>' +
              '<button class="btn sm primary" data-act="chapter.generate" data-id="' + c.id + '">✨ 生成正文</button>' +
              '</div>' +
              '</div>' +
              '<button class="icon-btn small" data-act="chapter.menu" data-id="' + c.id + '">⋮</button>' +
              '</div>';
          });
          html += '</div>';
        });
      }
      html += '<div class="mt16 row">' +
        '<button class="btn" style="flex:1" data-act="chapter.new" data-id="' + bookId + '">＋ 新建章节</button>' +
        '<button class="btn" style="flex:1" data-act="outline.ai" data-id="' + bookId + '">✨ AI 自动分章</button>' +
        '</div>';
      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    /* =========================================================
     * 界面 4：阅读（上下翻页）
     * ========================================================= */
    renderReader: function (bookId, chapterId) {
      var b = Store.getBook(bookId);
      if (!b || !b.chapters.length) { location.hash = '#/chapters/' + bookId; return; }
      this.currentBookId = bookId;
      var idx = Store.chapterIndex(b, chapterId);
      if (idx < 0) idx = 0;
      Store.touchChapter(b, b.chapters[idx]);   // 记住阅读位置

      var p = $('page');
      p.style.animation = 'none';
      p.innerHTML =
        '<div class="reader-viewport" id="rv">' +
        '<div class="reader-page" id="rpPrev"></div>' +
        '<div class="reader-page" id="rpCur"></div>' +
        '<div class="reader-page" id="rpNext"></div>' +
        '</div>' +
        '<div class="reader-bar">' +
        '<button class="btn sm" data-act="reader.prev">↑ 上一章</button>' +
        '<button class="btn sm" data-act="nav" data-to="#/chapters/' + bookId + '">目录</button>' +
        '<button class="btn sm" data-act="chapter.editContent">编辑</button>' +
        '<button class="btn sm primary" data-act="reader.generate">✨ AI 写</button>' +
        '<button class="btn sm" data-act="reader.next">下一章 ↓</button>' +
        '</div>' +
        '<div class="reader-progress" id="rProg" style="width:0"></div>';

      Reader.mount(b, idx);
      this.setAppBar({
        title: b.title, back: '#/chapters/' + bookId,
        actions: [{ act: 'reader.menu', icon: '⋮', title: '更多' }]
      });
      this.updateReaderBar(b, idx);
    },

    updateReaderBar: function (b, idx) {
      var c = b.chapters[idx];
      var title = (idx + 1) + '/' + b.chapters.length + (c && c.title ? ' · ' + c.title : '');
      var el = document.querySelector('.appbar-title');
      if (el) el.textContent = title;
    },

    /* =========================================================
     * 设置
     * ========================================================= */
    renderSettings: function () {
      this.currentBookId = null;
      this.setAppBar({ title: '设置', back: '#/books' });
      var st = Store.state;
      var html = '';

      html += '<div class="section-title">API 提供商（数据仅存本地）</div>';
      if (!st.providers.length) html += '<div class="empty-tip">尚未添加提供商</div>';
      st.providers.forEach(function (p) {
        var active = p.id === st.activeProviderId;
        html += '<div class="entry">' +
          '<div class="entry-head">' +
          '<div class="entry-name">' + esc(p.name) + (active ? ' <span class="chip on">使用中</span>' : '') + '</div>' +
          (active ? '' : '<button class="btn sm" data-act="provider.use" data-id="' + p.id + '">启用</button>') +
          '</div>' +
          '<div class="entry-body">' + esc(p.type + ' · ' + p.model) + '\n' + esc(p.baseUrl) + '</div>' +
          '<div class="row-wrap mt8">' +
          '<button class="btn sm" data-act="provider.edit" data-id="' + p.id + '">编辑</button>' +
          '<button class="btn sm" data-act="provider.test" data-id="' + p.id + '">测试连接</button>' +
          '<button class="btn sm danger" data-act="provider.del" data-id="' + p.id + '">删除</button>' +
          '</div></div>';
      });
      html += '<button class="btn block mt8" data-act="provider.new">＋ 新增提供商</button>';

      html += '<div class="section-title">全局提示词（按条管理，每本书可独立挂载）</div>';
      st.globalPrompts.forEach(function (p, i) {
        html += '<div class="entry">' +
          '<div class="entry-head">' +
          '<div class="entry-name">' + esc(p.title) + (p.enabled === false ? ' <span class="chip">已停用</span>' : '') + '</div>' +
          '<button class="icon-btn small" data-act="prompt.up" data-id="' + p.id + '">↑</button>' +
          '<button class="icon-btn small" data-act="prompt.down" data-id="' + p.id + '">↓</button>' +
          '</div>' +
          '<div class="entry-body">' + esc(p.content) + '</div>' +
          '<div class="row-wrap mt8">' +
          '<button class="btn sm" data-act="prompt.edit" data-id="' + p.id + '">编辑</button>' +
          '<button class="btn sm" data-act="prompt.toggle" data-id="' + p.id + '">' + (p.enabled === false ? '启用' : '停用') + '</button>' +
          '<button class="btn sm danger" data-act="prompt.del" data-id="' + p.id + '">删除</button>' +
          '</div></div>';
      });
      html += '<button class="btn block mt8" data-act="prompt.new">＋ 新增全局提示词</button>';

      html += '<div class="section-title">内置提示词模板</div>' +
        '<button class="btn block" data-act="go.templates">✎ 编辑内置 prompt（每处可存多套方案）</button>' +
        '<div class="hint">包括输出规范、正文主提示词、分卷自动分章、单章大纲、记忆总结、世界设定 AI 整理、文本快捷导入等全部内置措辞。</div>';

      html += '<div class="section-title">数据</div>' +
        '<div class="row-wrap">' +
        '<button class="btn sm" data-act="data.export">导出全部数据</button>' +
        '<button class="btn sm" data-act="data.import">导入数据</button>' +
        '<button class="btn sm danger" data-act="data.reset">清空全部</button>' +
        '</div>' +
        '<div class="hint mt8">所有内容保存在浏览器 localStorage 中。换设备或清理浏览器数据前请先导出。</div>';

      html += '<div class="section-title">使用说明</div>' +
        '<div class="card small muted">' +
        '1. 先在上方配置一个 API 提供商并点击「测试连接」。<br>' +
        '2. 新建作品 → 填写基本信息 → 在「大纲分卷」里写分卷大纲。<br>' +
        '3. 用「AI 自动分章」把分卷拆成若干章的大纲，可逐条修改。<br>' +
        '4. 进入章节 → 「✨ AI 写」生成正文，完成后自动写入长期记忆。<br>' +
        '5. 若不满意，用「撤回上次 AI 生成」，正文与记忆会一起回滚。' +
        '</div>';

      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    /* =========================================================
     * 内置提示词模板
     * ========================================================= */
    renderTemplates: function () {
      this.currentBookId = null;
      this.setAppBar({ title: '内置提示词模板', back: '#/settings' });
      var html = '<div class="hint mb12">程序内置的 prompt 全部在这里，可逐条修改；每处还能保存多套方案，随时切换。</div>';
      Object.keys(Store.TEMPLATE_DEFS).forEach(function (k) {
        var t = Store.getTemplateDef(k);
        if (!t) return;
        var active = t.schemes.filter(function (s) { return s.id === t.activeId; })[0] || t.schemes[0];
        html += '<div class="entry" data-act="template.open" data-key="' + k + '">' +
          '<div class="entry-head"><div class="entry-name">' + esc(t.name) + '</div>' +
          '<span class="chip on">' + esc(active.name) + '</span>' +
          '<span class="chip">' + t.schemes.length + ' 套</span>' +
          '</div>' +
          '<div class="entry-body">' + esc(t.desc) + '</div>' +
          '</div>';
      });
      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    renderTemplateSchemes: function (key) {
      this.currentBookId = null;
      var t = Store.getTemplateDef(key);
      if (!t) { location.hash = '#/templates'; return; }
      this.setAppBar({ title: t.name, back: '#/templates' });
      var html = '<div class="hint mb12">' + esc(t.desc) + '</div>';
      html += '<div class="card small muted mb12"><b>可用占位符</b>：' +
        (t.vars.length ? t.vars.map(function (v) { return '{{' + v + '}}'; }).join('　') : '（该模板无占位符）') +
        '<br>写入提示词时会自动替换；某一项为空时，它所在的整行会被自动删掉。</div>';

      t.schemes.forEach(function (s) {
        var on = s.id === t.activeId;
        html += '<div class="entry">' +
          '<div class="entry-head"><div class="entry-name">' + esc(s.name) + (on ? ' <span class="chip on">使用中</span>' : '') + '</div></div>' +
          '<div class="entry-body" data-act="template.edit" data-key="' + key + '" data-sid="' + s.id + '">' + esc(s.content) + '</div>' +
          '<div class="row-wrap mt8">' +
          (on ? '' : '<button class="btn sm primary" data-act="template.use" data-key="' + key + '" data-sid="' + s.id + '">启用</button>') +
          '<button class="btn sm" data-act="template.edit" data-key="' + key + '" data-sid="' + s.id + '">✎ 编辑内容</button>' +
          '<button class="btn sm" data-act="template.rename" data-key="' + key + '" data-sid="' + s.id + '">改名</button>' +
          '<button class="btn sm" data-act="template.copy" data-key="' + key + '" data-sid="' + s.id + '">复制一套</button>' +
          (t.schemes.length > 1 ? '<button class="btn sm danger" data-act="template.del" data-key="' + key + '" data-sid="' + s.id + '">删除</button>' : '') +
          '</div></div>';
      });

      html += '<button class="btn block mt8" data-act="template.new" data-key="' + key + '">＋ 新增一套方案（复制当前）</button>';
      html += '<button class="btn block mt8 ghost" data-act="template.reset" data-key="' + key + '">恢复为内置默认</button>';
      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    /* =========================================================
     * 路由
     * ========================================================= */
    route: function () {
      var h = (location.hash || '#/books').replace(/^#\/?/, '');
      var seg = h.split('/');
      // 底部导航高亮：阅读页隐藏（底部留给阅读工具条）
      var tabKey = 'books';
      if (seg[0] === 'settings' || seg[0] === 'templates') tabKey = 'settings';
      else if (seg[0] === 'recent') tabKey = 'recent';
      else if (seg[0] === 'import') tabKey = 'import';
      else if (seg[0] === 'read') tabKey = 'none';
      this.setTabBar(tabKey);

      if (seg[0] === 'books') return this.renderBooks();
      if (seg[0] === 'recent') return this.renderRecent();
      if (seg[0] === 'import') return this.renderImport();
      if (seg[0] === 'settings') return this.renderSettings();
      if (seg[0] === 'templates') return seg[1] ? this.renderTemplateSchemes(seg[1]) : this.renderTemplates();
      if (seg[0] === 'book') return this.renderBookEdit(seg[1], seg[2]);
      if (seg[0] === 'chapters') return this.renderChapters(seg[1]);
      if (seg[0] === 'read') return this.renderReader(seg[1], seg[2]);
      return this.renderBooks();
    }
  };

  /* ---------------- 书本编辑各 Tab ---------------- */
  function renderBasic(b) {
    return '' +
      '<div class="field"><label>书名</label><input class="input" data-bind="book.title" value="' + esc(b.title) + '"></div>' +
      '<div class="field"><label>作者</label><input class="input" data-bind="book.author" value="' + esc(b.author) + '" placeholder="可留空"></div>' +
      '<div class="field"><label>类型 / 题材</label><input class="input" data-bind="book.genre" value="' + esc(b.genre) + '" placeholder="如：都市异能 / 古言权谋"></div>' +
      '<div class="field"><label>故事简介</label><textarea class="textarea" data-bind="book.synopsis" placeholder="整体故事讲什么">' + esc(b.synopsis) + '</textarea></div>' +
      '<div class="field"><label>文风要求</label><textarea class="textarea" data-bind="book.style" placeholder="如：冷峻克制、少用形容词、对话推动">' + esc(b.style) + '</textarea></div>' +
      '<div class="field"><label>每章目标字数</label><input class="input" type="number" min="200" max="20000" data-bind="book.targetWordsPerChapter" value="' + (b.targetWordsPerChapter || 2500) + '"></div>' +
      '<div class="field"><label>额外要求（注入每一次生成）</label><textarea class="textarea" data-bind="book.requirements" placeholder="如：禁止出现现代词汇；每章结尾留钩子">' + esc(b.requirements) + '</textarea></div>' +
      '<div class="hint">这些内容会随每次 AI 请求一起发送。</div>';
  }

  var worldTab = {};

  /* AI 推荐但尚未转正的设定：在这里挑选转正或忽略 */
  function renderWorldSug(b) {
    var sug = b.worldSug || [];
    if (!sug.length) return '';
    var html = '<div class="section-title">💡 AI 推荐的新设定（' + sug.length + '）</div>';
    html += '<div class="hint mb8">写章节 / 生成记忆时 AI 顺手记下的新设定，不会自动进世界书。确认后「转正」进对应分栏，没用的忽略掉即可。</div>';
    html += sug.map(function (s) {
      return '<div class="entry sug">' +
        '<div class="entry-head"><div class="entry-name">' + esc(s.name || '(未命名)') + '</div>' +
        '<span class="chip">' + esc(AI.WORLD_LABEL[s.cat] || s.cat) + '</span></div>' +
        '<div class="entry-body">' + esc(s.content || '（空）') + '</div>' +
        (s.chapterId ? '<div class="tiny muted mt4">来自第' + ((s.chapterIndex || 0) + 1) + '章' + (s.chapterTitle ? '《' + esc(s.chapterTitle) + '》' : '') + '</div>' : '') +
        '<div class="row-wrap mt8">' +
        '<button class="btn sm primary" data-act="world.sug.accept" data-id="' + s.id + '">✓ 转正</button>' +
        '<button class="btn sm" data-act="world.sug.edit" data-id="' + s.id + '">✎ 改后转正</button>' +
        '<button class="btn sm ghost" data-act="world.sug.dismiss" data-id="' + s.id + '">忽略</button>' +
        '</div></div>';
    }).join('');
    html += '<div class="row-wrap mt8">' +
      '<button class="btn sm primary" data-act="world.sug.select">☑ 选择并转正</button>' +
      '<button class="btn sm" data-act="world.sug.acceptAll">✓ 全部转正</button>' +
      '<button class="btn sm ghost" data-act="world.sug.clear">忽略全部</button>' +
      '</div>';
    return html;
  }

  function renderWorld(b) {
    var cat = worldTab[b.id] || 'characters';
    var html = renderWorldSug(b);
    html += '<div class="tabs">' + AI.WORLD_ORDER.map(function (k) {
      var n = (b.world[k] || []).length;
      return '<div class="tab' + (k === cat ? ' active' : '') + '" data-act="world.tab" data-cat="' + k + '">' + AI.WORLD_LABEL[k] + (n ? '(' + n + ')' : '') + '</div>';
    }).join('') + '</div>';

    var arr = b.world[cat] || [];
    if (!arr.length) {
      html += '<div class="empty-tip">「' + AI.WORLD_LABEL[cat] + '」暂无条目，可缺省。<br>条目只会注入已启用的内容。</div>';
    } else {
      html += arr.map(function (e) {
        return '<div class="entry">' +
          '<div class="entry-head">' +
          '<div class="entry-name">' + esc(e.name || '(未命名)') + (e.enabled === false ? ' <span class="chip">停用</span>' : '') + '</div>' +
          '<button class="btn sm ghost" data-act="world.toggle" data-cat="' + cat + '" data-id="' + e.id + '">' + (e.enabled === false ? '启用' : '停用') + '</button>' +
          '<button class="btn sm danger" data-act="world.del" data-cat="' + cat + '" data-id="' + e.id + '">删除</button>' +
          '</div>' +
          '<div class="entry-body" data-act="world.edit" data-cat="' + cat + '" data-id="' + e.id + '">' + esc(e.content || '（空）') + '</div>' +
          '</div>';
      }).join('');
    }
    html += '<button class="btn block mt8" data-act="world.add" data-cat="' + cat + '">＋ 新增「' + AI.WORLD_LABEL[cat] + '」条目</button>';
    html += '<button class="btn block mt8 primary" data-act="world.ai">✨ AI 整理：粘贴一大段想法，自动建条目</button>';
    html += '<div class="hint">名称 + 内容两段式，方便 AI 精确检索人物与设定的对应关系。懒得一条条填时，用上面的 AI 入口把想法一股脑倒进去。</div>';
    return html;
  }

  function renderOutline(b) {
    var html = '<div class="section-title" style="margin-top:4px">分卷大纲</div>';
    if (!b.volumes.length) html += '<div class="empty-tip">还没有分卷。可以先写一卷的大致剧情，再让 AI 拆成章节。</div>';
    html += b.volumes.map(function (v, i) {
      var cnt = b.chapters.filter(function (c) { return c.volumeId === v.id; }).length;
      return '<div class="entry">' +
        '<div class="entry-head"><div class="entry-name">第' + (i + 1) + '卷 《' + esc(v.title || '未命名') + '》' +
        '<span class="tiny muted"> · ' + cnt + ' 章</span></div></div>' +
        '<div class="entry-body">' + esc(v.summary || '（暂无大纲）') + '</div>' +
        '<div class="row-wrap mt8">' +
        '<button class="btn sm primary" data-act="outline.ai" data-id="' + v.id + '">✨ 自动分章</button>' +
        '<button class="btn sm" data-act="chapter.new" data-id="' + b.id + '" data-vol="' + v.id + '">＋ 本卷新章</button>' +
        '<button class="btn sm" data-act="volume.edit" data-id="' + v.id + '">✎ 编辑</button>' +
        '<button class="btn sm danger" data-act="volume.del" data-id="' + v.id + '">删除</button>' +
        '</div></div>';
    }).join('');
    html += '<button class="btn block mt8" data-act="volume.new">＋ 新增分卷</button>';

    html += '<div class="section-title">章节概况（共 ' + b.chapters.length + ' 章）</div>';
    html += '<div class="row">' +
      '<button class="btn" style="flex:1" data-act="book.chapters" data-id="' + b.id + '">管理章节 / 写作</button>' +
      '<button class="btn" style="flex:1" data-act="outline.ai" data-id="">✨ 自动分章</button>' +
      '</div>';
    html += '<div class="hint">每章都必须属于某个分卷：新建章节、AI 分章时都会要求先选分卷（这本书没有分卷时会引导你先建一个）。</div>';
    return html;
  }

  function renderPrompts(b) {
    var gps = Store.state.globalPrompts;
    var html = '<div class="hint mb12">开关决定本书是否挂载该条全局提示词；全局停用后，即使这里打开也不会注入。</div>';
    if (!gps.length) html += '<div class="empty-tip">还没有全局提示词，去「设置」里添加。</div>';
    html += gps.map(function (p) {
      var on = b.globalPromptIds.indexOf(p.id) >= 0;
      var globallyOff = p.enabled === false;
      return '<div class="entry">' +
        '<div class="entry-head">' +
        '<div class="entry-name">' + esc(p.title) + (globallyOff ? ' <span class="chip">全局停用</span>' : '') + '</div>' +
        '<button class="btn sm ' + (on ? '' : 'ghost') + '" data-act="book.togglePrompt" data-id="' + p.id + '">' + (on ? '已挂载' : '未挂载') + '</button>' +
        '</div>' +
        '<div class="entry-body">' + esc(p.content) + '</div>' +
        '<div class="row-wrap mt8"><button class="btn sm" data-act="prompt.edit" data-id="' + p.id + '">编辑内容</button></div>' +
        '</div>';
    }).join('');
    html += '<button class="btn block mt8" data-act="prompt.new">＋ 新增全局提示词</button>';
    html += '<div class="section-title">本书专属附加指令（可选）</div>' +
      '<div class="field"><label>附加系统提示词（追加在所有全局提示词之后）</label>' +
      '<textarea class="textarea" data-bind="book.requirements" placeholder="仅对本书生效的写作要求">' + esc(b.requirements) + '</textarea></div>';
    return html;
  }

  function renderMemory(b) {
    var m = b.memory;
    var html = '<div class="entry"><div class="entry-head"><div class="entry-name">记忆系统</div>' +
      '<label class="switch"><input type="checkbox" data-act="memory.toggle"' + (m.enabled ? ' checked' : '') + '><span class="track"></span></label></div>' +
      '<div class="hint">开启后，每次 AI 写完一章会自动总结本章要点，并合并进长期记忆；后续章节生成时自动带上。</div></div>';

    html += '<div class="entry"><div class="entry-head"><div class="entry-name">顺带推荐新设定</div>' +
      '<label class="switch"><input type="checkbox" data-act="memory.suggestToggle"' + (m.suggestWorld !== false ? ' checked' : '') + '><span class="track"></span></label></div>' +
      '<div class="hint">开启后，AI 总结记忆时会一并挑出本章出现的新人物 / 地点 / 概念等，作为「推荐条目」放到世界设定页等你确认，不会直接写进世界书。</div></div>';

    html += '<div class="section-title">长期记忆摘要（可查看 / 编辑）</div>';
    html += '<div class="card">' +
      '<div style="white-space:pre-wrap;font-size:13.5px;max-height:34vh;overflow:auto">' +
      esc(m.summary || '（暂无，写完第一章后自动生成）') + '</div>' +
      '<div class="row-wrap mt8">' +
      '<button class="btn sm" data-act="memory.editSummary">✎ 编辑摘要</button>' +
      '<button class="btn sm" data-act="memory.view">🔍 查看实际注入内容</button>' +
      '<button class="btn sm primary" data-act="memory.regen">🔁 重新生成记忆（选章节）</button>' +
      '<button class="btn sm danger" data-act="memory.clear">清空记忆</button>' +
      '</div>' +
      '<div class="hint mt8">「重新生成记忆」默认只勾选还没有记忆的章节（导入的小说一开始都没有），也可以手动勾选任意章节重来。</div>' +
      '<div class="field mt12"><label>注入最近几条章节记忆</label>' +
      '<input class="input" type="number" min="1" max="30" data-bind="book.memory.keepRecent" value="' + (m.keepRecent || 6) + '"></div>' +
      '</div>';

    html += '<div class="section-title">章节记忆（' + m.entries.length + ' 条）</div>';
    if (!m.entries.length) html += '<div class="empty-tip">暂无记录</div>';
    html += m.entries.slice().reverse().map(function (e) {
      return '<div class="entry">' +
        '<div class="entry-head"><div class="entry-name">' + esc(e.chapterTitle || ('第' + (e.chapterIndex + 1) + '章')) + '</div>' +
        '<span class="tiny muted">' + fmtTime(e.createdAt) + '</span>' +
        '</div>' +
        '<div class="entry-body" data-act="memory.edit" data-id="' + e.id + '">' + esc(e.text || '（空）') + '</div>' +
        '<div class="row-wrap mt8">' +
        '<button class="btn sm" data-act="memory.edit" data-id="' + e.id + '">✎ 编辑</button>' +
        '<button class="btn sm danger" data-act="memory.del" data-id="' + e.id + '">删除</button>' +
        '</div>' +
        '</div>';
    }).join('');
    html += '<button class="btn block mt8" data-act="memory.add">＋ 手动添加一条记忆</button>';
    return html;
  }

  function renderData(b) {
    return '<div class="section-title">导出 / 导入</div>' +
      '<div class="row-wrap">' +
      '<button class="btn sm" data-act="book.export" data-id="' + b.id + '">导出本书 JSON</button>' +
      '<button class="btn sm" data-act="book.import">导入书本 JSON</button>' +
      '<button class="btn sm" data-act="book.exportTxt" data-id="' + b.id + '">导出正文 TXT</button>' +
      '</div>' +
      '<div class="section-title">危险操作</div>' +
      '<button class="btn block danger" data-act="book.delete" data-id="' + b.id + '">删除这本书</button>' +
      '<div class="hint">删除不可恢复，建议先导出。</div>';
  }

  UI.worldTab = worldTab;
  UI.fmtTime = fmtTime;
  global.UI = UI;

  /* =========================================================
   * Reader —— 阅读器（上下滑动翻页）
   * ========================================================= */
  var Reader = {
    book: null, index: 0,
    el: {}, H: 0, dragging: false, startY: 0, dir: 0, atEdge: false,

    mount: function (book, idx) {
      this.book = book; this.index = idx;
      this.el = {
        vp: $('rv'), prev: $('rpPrev'), cur: $('rpCur'), next: $('rpNext'), prog: $('rProg')
      };
      this.H = this.el.vp.clientHeight;
      this.fill(this.el.prev, idx - 1, -1);
      this.fill(this.el.cur, idx, 0);
      this.fill(this.el.next, idx + 1, 1);
      this.bindGestures();
      this.bindScroll();
    },

    base: function (pos) { return 'translateY(' + (pos * this.H) + 'px)'; },

    fill: function (elm, idx, pos) {
      var b = this.book;
      if (idx < 0 || idx >= b.chapters.length) { elm.innerHTML = ''; elm.style.transform = this.base(pos); return; }
      var c = b.chapters[idx];
      var fs = Store.state.ui.fontSize || 17;
      var lh = Store.state.ui.lineHeight || 1.85;
      var body = '<div class="reader-content">' + esc(c.content) + '</div>' +
        (c.content ? '' : '<div class="reader-empty">本章还没有正文。<br><br>点击底部「✨ AI 写」按本章大纲生成，或「编辑」手动撰写。</div>');
      elm.innerHTML = '<div class="reader-inner">' +
        '<div class="reader-chapter-title">第' + (idx + 1) + '章' + (c.title ? ' · ' + esc(c.title) : '') + '</div>' +
        '<div class="reader-chapter-sub">' + (c.outline ? esc(c.outline) : '（暂无大纲）') + '</div>' +
        '<div style="font-size:' + fs + 'px;line-height:' + lh + '">' + body + '</div>' +
        '</div>';
      elm.scrollTop = 0;
      elm.style.transform = this.base(pos);
    },

    refreshCur: function () { this.fill(this.el.cur, this.index, 0); },

    /* 流式写作时实时替换当前页正文 */
    setLive: function (text, streaming) {
      if (!this.el || !this.el.cur) return;
      var el = this.el.cur;
      var box = el.querySelector('.reader-content');
      if (!box) { this.refreshCur(); box = el.querySelector('.reader-content'); }
      if (!box) return;
      box.textContent = text;
      var empty = el.querySelector('.reader-empty');
      if (empty) empty.remove();
      if (streaming) {
        box.classList.add('cursor-blink');
        el.scrollTop = el.scrollHeight;
      } else {
        box.classList.remove('cursor-blink');
      }
    },

    flip: function (dir) {
      var b = this.book;
      var t = this.index + dir;
      if (t < 0) { UI.toast('已经是第一章'); return; }
      if (t >= b.chapters.length) {
        UI.toast('已经是最后一章，可在目录里新建章节');
        return;
      }
      var self = this;
      var cur = this.el.cur, target = dir > 0 ? this.el.next : this.el.prev;
      cur.style.transform = this.base(-dir);
      target.style.transform = this.base(0);
      setTimeout(function () {
        if (dir > 0) { var a = self.el.prev; self.el.prev = self.el.cur; self.el.cur = self.el.next; self.el.next = a; }
        else { var b2 = self.el.next; self.el.next = self.el.cur; self.el.cur = self.el.prev; self.el.prev = b2; }
        self.index = t;
        Store.touchChapter(b, b.chapters[t]);   // 翻页后同步更新阅读位置
        self.fill(self.el.prev, t - 1, -1);
        self.fill(self.el.next, t + 1, 1);
        self.el.cur.style.transform = self.base(0);
        self.el.cur.scrollTop = 0;
        UI.updateReaderBar(b, t);
        history.replaceState(null, '', '#/read/' + b.id + '/' + b.chapters[t].id);
      }, 260);
    },

    bindScroll: function () {
      var self = this;
      this.el.cur.onscroll = function () {
        var e = self.el.cur;
        var max = e.scrollHeight - e.clientHeight;
        var pct = max > 0 ? (e.scrollTop / max) : 1;
        self.el.prog.style.width = Math.round(pct * 100) + '%';
      };
    },

    bindGestures: function () {
      var self = this;
      var vp = this.el.vp;
      vp.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        self.startY = e.touches[0].clientY;
        self.dragging = false; self.dir = 0;
        var c = self.el.cur;
        var max = c.scrollHeight - c.clientHeight;
        self.atTop = c.scrollTop <= 0;
        self.atBottom = max <= 0 || c.scrollTop >= max - 1;
      }, { passive: true });

      vp.addEventListener('touchmove', function (e) {
        if (e.touches.length !== 1) return;
        var dy = e.touches[0].clientY - self.startY;
        if (!self.dragging) {
          // 仅在滚动到边界时才接管手势
          if (dy > 8 && self.atTop && self.index > 0) { self.dragging = true; self.dir = -1; }
          else if (dy < -8 && self.atBottom && self.index < self.book.chapters.length - 1) { self.dragging = true; self.dir = 1; }
          else return;
        }
        e.preventDefault();
        var damp = dy * 0.55;
        self.el.cur.style.transform = 'translateY(' + damp + 'px)';
        self.el.prev.style.transform = 'translateY(' + (-self.H + damp) + 'px)';
        self.el.next.style.transform = 'translateY(' + (self.H + damp) + 'px)';
      }, { passive: false });

      vp.addEventListener('touchend', function (e) {
        if (!self.dragging) return;
        var dy = (e.changedTouches[0].clientY - self.startY);
        self.dragging = false;
        var threshold = Math.max(70, self.H * 0.16);
        if ((self.dir === 1 && dy < -threshold) || (self.dir === -1 && dy > threshold)) {
          self.flip(self.dir);
        } else {
          self.el.cur.style.transform = self.base(0);
          self.el.prev.style.transform = self.base(-1);
          self.el.next.style.transform = self.base(1);
        }
      });
    }
  };

  global.Reader = Reader;
})(window);
