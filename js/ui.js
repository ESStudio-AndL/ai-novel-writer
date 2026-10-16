/* =========================================================
 * UI —— 界面渲染与交互动作
 * ========================================================= */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* 这些原本在 ui.js 本地定义、在 ai.js / app.js 又各有一份，统一改走 Util */
  var esc = Util.esc;
  var fmtTime = Util.fmtTime;
  var fmtNum = Util.fmtNum;
  var copyText = Util.copyText;

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

    /* 统一的失败提示面板。
     * 原来是 6 处各自拼 openSheet('生成失败'…)，文案与格式不一致，
     * 有的还漏了 esc 导致报错信息里的尖括号破坏 DOM。
     */
    fail: function (title, err, hint) {
      var msg = (err && err.message) ? err.message : String(err == null ? '未知错误' : err);
      this.openSheet({
        title: title || '操作失败',
        body: '<div style="font-size:13.5px;white-space:pre-wrap;word-break:break-word">' + esc(msg) + '</div>' +
          (hint ? '<div class="hint mt12">' + esc(hint) + '</div>' : ''),
        buttons: [
          { text: '复制错误', cls: '', onClick: function () { copyText(msg); UI.toast('已复制'); return true; } },
          { text: '知道了', cls: 'primary' }
        ]
      });
    },

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
    editFullText: function (title, value, onSubmit, hint) {
      var wrap = $('fullEditor');
      $('feTitle').textContent = title;
      var ta = $('feText');
      ta.value = value || '';
      wrap.classList.remove('hidden');
      var st = $('feStatus');
      st.setAttribute('data-hint', hint || '');
      var upd = function () {
        st.textContent = AI.wordCount(ta.value) + ' 字' + (hint ? ' · ' + hint : '');
      };
      upd();
      ta.oninput = upd;
      $('feBack').onclick = function () { wrap.classList.add('hidden'); };
      $('feSave').onclick = function () {
        wrap.classList.add('hidden');
        if (onSubmit) onSubmit(ta.value);
      };
      setTimeout(function () { try { ta.focus(); } catch (e) { } }, 60);
    },

    /* ---------------- 主题 ---------------- */
    applyTheme: function () {
      var t = (Store.state && Store.state.ui && Store.state.ui.theme) || 'dark';
      var cl = document.body.classList;
      cl.remove('theme-dark', 'theme-light', 'theme-sepia');
      cl.add('theme-' + t);
      // 让移动端地址栏也跟着变色
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t === 'light' ? '#f6f7fa' : (t === 'sepia' ? '#f4ecd8' : '#12131a'));
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
     * 界面 1：书架（含全文搜索）
     * ========================================================= */
    searchQuery: '',

    renderBooks: function () {
      this.currentBookId = null;
      this.setAppBar({
        title: '我的书架',
        actions: [
          { act: 'book.new', icon: '＋', title: '新建作品' }
        ]
      });
      var books = Store.state.books;
      var q = this.searchQuery || '';

      // —— 搜索框：常驻在书架顶部，输入即搜 ——
      var html = '<div class="search-box">' +
        '<span class="search-ico">🔍</span>' +
        '<input class="input" id="searchInput" type="search" value="' + esc(q) + '" ' +
        'placeholder="搜索全部作品：正文 / 大纲 / 设定 / 记忆" autocomplete="off">' +
        (q ? '<button class="icon-btn small" data-act="search.clear" title="清空">✕</button>' : '') +
        '</div>';

      // —— 有搜索词：只显示结果 ——
      if (q) {
        var res = AI.search(q, { limit: 120 });
        html += '<div class="search-stat">' + (res.total ? '找到 <b>' + res.total + '</b> 条' + (res.total > res.items.length ? '（显示前 ' + res.items.length + ' 条）' : '') : '没有找到匹配内容') +
          '<div class="row-wrap mt8">' +
          '<button class="btn sm" data-act="search.scope" data-scope="all">全部</button>' +
          '<button class="btn sm" data-act="search.scope" data-scope="chapter">正文/大纲</button>' +
          '<button class="btn sm" data-act="search.scope" data-scope="world">世界设定</button>' +
          '<button class="btn sm" data-act="search.scope" data-scope="memory">记忆</button>' +
          '</div></div>';

        if (!res.total) {
          html += '<div class="empty-tip">换个关键词试试。<br>搜索会覆盖所有作品的章节正文、大纲、世界设定与记忆。</div>';
        } else {
          html += '<div class="list">' + res.items.map(function (it) {
            var act = it.chapterId ? 'search.goto' : 'book.open';
            return '<div class="search-hit" data-act="' + act + '" data-id="' + it.bookId + '"' +
              (it.chapterId ? ' data-cid="' + it.chapterId + '"' : '') + '>' +
              '<div class="search-hit-head">' +
              '<span class="chip">' + esc(it.field || it.kind) + '</span>' +
              '<span class="ellipsis tiny muted">' + esc(it.bookTitle) + '</span>' +
              (it.chapterId ? '<span class="spacer"></span><span class="tiny muted">第' + (it.chapterIndex + 1) + '章</span>' : '') +
              '</div>' +
              '<div class="search-hit-body">' + it.excerpt + '</div>' +
              '</div>';
          }).join('') + '</div>';
        }
        var p0 = $('page'); p0.style.animation = ''; p0.innerHTML = html;
        this.bindSearchInput();
        return;
      }

      // —— 无搜索词：正常书架 ——
      if (!books.length) {
        html += '<div class="empty-tip">还没有作品。<br>点击右上角「＋」创建第一本书。</div>';
      } else {
        html += '<div class="list">';
        books.forEach(function (b) {
          var words = b.chapters.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0);
          var last = Store.lastChapter(b);
          var done = b.chapters.filter(function (c) { return c.content && c.content.trim(); }).length;
          var totalCh = b.chapters.length;
          var pct = totalCh ? Math.round(done / totalCh * 100) : 0;
          html += '<div class="book-card">' +
            '<div class="book-cover" data-act="book.open" data-id="' + b.id + '">' + esc((b.title || '?').trim().slice(0, 1)) + '</div>' +
            '<div class="book-main" data-act="book.open" data-id="' + b.id + '">' +
            '<div class="book-title ellipsis">' + esc(b.title) + '</div>' +
            '<div class="book-sub">' + esc(b.genre || '未分类') + ' · ' + totalCh + ' 章 · ' + fmtNum(words) + ' 字</div>' +
            (totalCh ? '<div class="progress-thin" title="已写 ' + done + '/' + totalCh + ' 章"><i style="width:' + pct + '%"></i></div>' : '') +
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
      this.bindSearchInput();
    },

    /* 搜索框：输入即搜（防抖），避免每敲一个字就整页重渲染 */
    bindSearchInput: function () {
      var self = this;
      var el = $('searchInput');
      if (!el) return;
      el.addEventListener('input', function () {
        clearTimeout(self._searchTimer);
        self._searchTimer = setTimeout(function () {
          self.searchQuery = el.value;
          self.renderBooks();
          // 重渲染后把焦点与光标还给输入框，否则打字会断
          var next = $('searchInput');
          if (next) {
            next.focus();
            try { next.setSelectionRange(next.value.length, next.value.length); } catch (e) { }
          }
        }, 180);
      });
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
      // 归一化草稿：老数据 / 手工改过 localStorage 时 mode 可能是任意值，
      // 会让下面所有 `d.mode === 'regex'` 判断同时为假，页面渲染成半成品。
      if (d.mode !== 'ai' && d.mode !== 'regex') d.mode = 'regex';
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
        var statEl = $('importStat');
        var updStat = function () {
          if (statEl) statEl.textContent = ta.value ? AI.wordCount(ta.value) + ' 字' : '尚未输入内容';
        };
        ta.addEventListener('input', function () {
          d.text = ta.value;
          updStat();
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
      // 「大纲分卷」已并入章节目录：tab 用 chapters 承载
      if (tab === 'outline') tab = 'chapters';
      var tabs = [
        ['basic', '基本信息'], ['world', '世界设定'], ['chapters', '章节目录'],
        ['chat', '小编'], ['prompts', '提示词'], ['memory', '记忆'], ['hooks', '伏笔'], ['data', '数据']
      ];
      // 章节目录标签页：顶栏放「浏览世界设定」（原独立目录页的常用入口），
      // 其余标签页顶栏保留「章节列表」快捷跳转与「更多」菜单
      var appbarActions = tab === 'chapters'
        ? [
          { act: 'world.browse', id: bookId, icon: '🌍', title: '浏览世界设定' },
          { act: 'book.menu', id: bookId, icon: '⋮', title: '更多' }
        ]
        : [
          { act: 'book.chapters', id: bookId, icon: '☰', title: '章节列表' },
          { act: 'book.menu', id: bookId, icon: '⋮', title: '更多' }
        ];
      this.setAppBar({
        title: b.title, back: '#/books',
        actions: appbarActions
      });

      var nSug = (b.worldSug || []).length;
      // 逾期未回收的伏笔：写到第 N 章了还没回收，标签上给个角标提醒
      var nOver = Store.overdueHooks(b, b.chapters.length).length;
      // tabs-fixed：标签始终完整展示，不横向滚动、不自动回正
      var html = '<div class="tabs tabs-fixed">' + tabs.map(function (t) {
        var label = t[1];
        if (t[0] === 'world' && nSug) label += ' 💡' + nSug;
        if (t[0] === 'hooks' && nOver) label += ' ⚠' + nOver;
        return '<div class="tab' + (t[0] === tab ? ' active' : '') + '" data-act="book.tab" data-tab="' + t[0] + '">' + label + '</div>';
      }).join('') + '</div>';

      html += {
        basic: renderBasic, world: renderWorld, chapters: renderChapterDir, chat: renderChat,
        prompts: renderPrompts, memory: renderMemory, hooks: renderHooks, data: renderData
      }[tab](b);

      var p = $('page'); p.style.animation = ''; p.innerHTML = html;
    },

    /* =========================================================
     * 章节目录（原独立目录页已移除）：老链接 #/chapters/{id} 静默
     * 改写为书本编辑的 chapters 标签页，不新增历史记录。
     * ========================================================= */
    renderChapterDirRedirect: function (bookId) {
      var fix = '#/book/' + bookId + '/chapters';
      if (location.hash !== fix) {
        try { history.replaceState(null, '', fix); } catch (e) { location.hash = fix; return; }
      }
      return this.renderBookEdit(bookId, 'chapters');
    },

    /* =========================================================
     * 界面 4：阅读（上下翻页）
     * ========================================================= */
    renderReader: function (bookId, chapterId) {
      var b = Store.getBook(bookId);
      // 书本不存在 / 没有任何章节：回目录，且不要再递归触发本函数
      if (!b || !b.chapters.length) {
        if (!b) { location.hash = '#/books'; }
        else { location.hash = '#/book/' + bookId + '/chapters'; }
        return;
      }
      this.currentBookId = bookId;
      var idx = Store.chapterIndex(b, chapterId);
      // 章节 id 非法（被删掉 / 手改 URL）时回落第一章，并把 hash 修正回去，
      // 否则地址栏显示的章节与屏幕上看的章节长期不一致。
      if (idx < 0) {
        idx = 0;
        var fix = '#/read/' + bookId + '/' + b.chapters[0].id;
        if (location.hash !== fix) {
          try { history.replaceState(null, '', fix); } catch (e) { location.hash = fix; }
        }
      }
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
        '<button class="btn sm" data-act="nav" data-to="#/book/' + bookId + '/chapters">目录</button>' +
        '<button class="btn sm" data-act="chapter.editContent">编辑</button>' +
        (Reader.liveMarkCount(b.chapters[idx]) ? '<button class="btn sm" data-act="mark.list" title="框选改稿">🖍 ' + Reader.liveMarkCount(b.chapters[idx]) + '</button>' : '') +
        '<button class="btn sm primary" data-act="reader.generate">✨ AI 写</button>' +
        '<button class="btn sm" data-act="reader.next">下一章 ↓</button>' +
        '</div>' +

        '<div class="reader-progress" id="rProg" style="width:0"></div>' +
        '<div class="reader-prog-num" id="rProgNum">0%</div>' +
        /* 流式写作时如果用户自己往上翻（回看前文），就不再强行把页面拽到底部；
         * 这个小按钮负责「继续跟随」。默认隐藏，只在暂停跟随时出现。 */
        '<button class="btn sm primary reader-follow hidden" id="rFollow" data-act="reader.follow">跟随 ↓</button>';

      Reader.mount(b, idx);
      this.setAppBar({
        title: b.title, back: '#/book/' + bookId + '/chapters',
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

      html += '<div class="section-title">API 提供商（只管连接；模型与参数在下方「模型方案」配置）</div>';
      if (!st.providers.length) html += '<div class="empty-tip">尚未添加提供商</div>';
      st.providers.forEach(function (p) {
        var active = p.id === st.activeProviderId;
        var nScheme = (st.modelPresets || []).filter(function (m) { return m.providerId === p.id; }).length;
        html += '<div class="entry">' +
          '<div class="entry-head">' +
          '<div class="entry-name">' + esc(p.name) + (active ? ' <span class="chip on">使用中</span>' : '') + '</div>' +
          (active ? '' : '<button class="btn sm" data-act="provider.use" data-id="' + p.id + '">启用</button>') +
          '</div>' +
          '<div class="entry-body">' + esc(p.type) + ' · ' + esc(p.baseUrl) +
          (nScheme ? '\n已配 ' + nScheme + ' 个模型方案' : '\n还没有模型方案——生成时无法使用该提供商') + '</div>' +
          '<div class="row-wrap mt8">' +
          (nScheme ? '' : '<button class="btn sm primary" data-act="preset.newFor" data-id="' + p.id + '">＋ 建模型方案</button>') +
          '<button class="btn sm" data-act="provider.edit" data-id="' + p.id + '">编辑</button>' +
          '<button class="btn sm" data-act="provider.test" data-id="' + p.id + '">测试连接</button>' +
          '<button class="btn sm danger" data-act="provider.del" data-id="' + p.id + '">删除</button>' +
          '</div></div>';
      });
      html += '<button class="btn block mt8" data-act="provider.new">＋ 新增提供商</button>';

      var presets = Store.state.modelPresets || [];
      html += '<div class="section-title">任务分工（每类活实际用哪套方案）</div>';
      html += renderRouting();

      html += '<div class="section-title">模型方案（模型名 / 温度 / Token 都在这里配，可配多套分给不同任务）</div>';
      if (!presets.length) html += '<div class="empty-tip">还没有模型方案。新增一套，即可指定「哪个提供商 + 哪个模型」。</div>';
      presets.forEach(function (m) {
        var active = m.id === Store.state.activePresetId;
        var pv = Store.getProvider(m.providerId);
        var desc = (pv ? pv.name : '（提供商已删除）') + ' · ' + (m.model || pv && pv.model || '未指定模型');
        var over = [];
        if (typeof m.temperature === 'number') over.push('温度 ' + m.temperature);
        if (typeof m.maxTokens === 'number') over.push('maxTokens ' + m.maxTokens);
        if (m.noThink) over.push('关思考');
        if (m.priceIn || m.priceOut) over.push('¥' + (m.priceIn || 0) + '/' + (m.priceOut || 0) + ' 每百万');
        if (over.length) desc += '（' + over.join('，') + '）';
        /* 「启用」只有一个，但这套方案可以另外认领一类任务——两个标记互不冲突：
         * 兜底 = 没人认领的任务用它；专职 = 某类任务固定用它。 */
        var tags = '';
        if (m.task) {
          tags += ' <span class="chip' + (pv ? ' on' : '') + '">专职 ' + esc(Store.taskLabel(m.task)) + '</span>';
          if (!pv) tags += ' <span class="chip" style="color:var(--danger)">提供商已删除，专职没生效</span>';
        }
        if (active) tags += ' <span class="chip on">兜底</span>';
        html += '<div class="entry">' +
          '<div class="entry-head">' +
          '<div class="entry-name">' + esc(m.name || '未命名方案') + tags + '</div>' +
          (active ? '' : '<button class="btn sm primary" data-act="preset.use" data-id="' + m.id + '">设为兜底</button>') +
          '</div>' +
          '<div class="entry-body">' + esc(desc) + '</div>' +
          '<div class="row-wrap mt8">' +
          '<button class="btn sm" data-act="preset.edit" data-id="' + m.id + '">编辑</button>' +
          '<button class="btn sm danger" data-act="preset.del" data-id="' + m.id + '">删除</button>' +
          '</div></div>';
      });
      html += '<button class="btn block mt8" data-act="preset.new">＋ 新增模型方案</button>' +
        '<div class="hint">每套方案 = 一个提供商 + 模型名（可「拉取模型列表」选择）+ 可选温度 / Token 覆盖（留空用默认）。' +
        '<b>分工的做法</b>：在方案里把「专用于」选成某类任务，该类任务就固定走这套，不再跟兜底方案走——' +
        '典型省钱姿势是正文用好模型、记忆总结与一致性审计用便宜模型。同一任务被多套认领时只认第一套。' +
        '<b>兜底方案</b> = 没有专职方案的任务都用它（右下角悬浮球可快速切换）。</div>';

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

      html += '<div class="section-title">外观</div>' +
        '<div class="card"><div class="row"><span class="small">主题</span><div class="spacer"></div>' +
        [['dark', '暗色'], ['light', '亮色'], ['sepia', '护眼纸']].map(function (t) {
          return '<button class="btn sm' + ((st.ui.theme || 'dark') === t[0] ? ' primary' : '') +
            '" data-act="ui.theme" data-theme="' + t[0] + '">' + t[1] + '</button>';
        }).join('') +
        '</div><div class="hint mt8">阅读页的「更多」里还能调字号、行高与段间距。</div></div>';

      var info = Store.storageInfo();
      html += usageCard(st.usage, '累计用量（全部作品）');
      html += '<div class="section-title">数据</div>' +
        '<div class="row-wrap">' +
        '<button class="btn sm" data-act="data.export">导出全部数据</button>' +
        '<button class="btn sm" data-act="data.import">导入数据</button>' +
        '<button class="btn sm" data-act="usage.reset">清零用量统计</button>' +
        '<button class="btn sm" data-act="ui.togglePreview">' +
        (st.ui.injectPreview === false ? '☑ 重新开启生成前预览' : '☐ 关闭生成前预览') + '</button>' +
        '<button class="btn sm danger" data-act="data.reset">清空全部</button>' +
        '</div>' +
        '<div class="hint mt8">所有内容保存在浏览器 localStorage 中（当前约 ' + esc(info.text) +
        '）。换设备或清理浏览器数据前请先导出。' +
        (info.healthy ? '' : '<br><span style="color:var(--danger)">⚠ 最近一次保存失败，多为存储空间已满，请立即导出数据。</span>') +
        '</div>';

      /* 版本与缓存：这是个 PWA，离线缓存很容易让人「git pull 了却看不到新功能」。
       * 手机上又没有 devtools，所以必须留一个能在界面里点的出口。 */
      html += '<div class="section-title">版本与更新</div>' +
        '<div class="card"><div class="row"><span class="small">当前版本</span><div class="spacer"></div>' +
        '<span class="chip" id="verChip">v' + esc(Store.APP_VERSION) + '</span></div>' +
        '<div class="hint mt8">这是 PWA，会缓存页面供离线使用。改了代码（git pull）后如果界面没变化，' +
        '多半是浏览器还在用旧缓存——点下面这个按钮清掉再重载即可，作品数据不受影响。</div>' +
        '<div class="row-wrap mt8">' +
        '<button class="btn sm primary" data-act="app.forceReload">↻ 强制刷新（清缓存重载）</button>' +
        '</div></div>';

      html += '<div class="section-title">使用说明</div>' +
        '<div class="card small muted">' +
        '1. 先在上方新增一个 API 提供商（只填连接：Base URL + Key），保存后按引导建第一个模型方案。<br>' +
        '2. 模型方案里「拉取模型列表」选模型；可配多套（如便宜模型跑记忆），右下角悬浮球一键切换。<br>' +
        '3. 新建作品 → 填写基本信息 → 在「章节目录」里写分卷大纲。<br>' +
        '4. 用「AI 自动分章」把分卷拆成若干章的大纲，可逐条修改。<br>' +
        '5. 进入章节 →「✨ AI 写」生成正文，完成后自动写入长期记忆。<br>' +
        '6. 若不满意，用「撤回上次 AI 生成」，正文与记忆会一起回滚。' +
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
      if (seg[0] === 'chapters') return this.renderChapterDirRedirect(seg[1]);
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
      '<div class="hint">这些内容会随每次 AI 请求一起发送。</div>' +
      '<div class="section-title">文风规则（禁词 / 套话）</div>' +
      '<div class="field"><label>禁用词清单</label><textarea class="textarea" data-bind="book.styleRules.banned" placeholder="如：不禁倒吸一口凉气&#10;眸光一闪&#10;心中一凛">' +
      esc((b.styleRules && b.styleRules.banned) || '') + '</textarea>' +
      '<div class="hint">换行或逗号分隔。两条作用：<b>生成时</b>作为文风规则注入提示词；' +
      '<b>生成后</b>纯本地扫描正文并高亮命中（不花 API 钱）。留空则两者都不启用。</div></div>';
  }

  var worldTab = {};
  /* 世界设定页当前查看的作用域：'' = 全局，否则为分卷 id */
  var worldScope = {};

  /* AI 推荐但尚未转正的设定：在这里挑选转正或忽略。
   * 两类：add（世界书里没有，新增）与 update（已有条目，本章给出了新事实，建议修改）。 */
  function renderWorldSug(b, scope) {
    var sug = b.worldSug || [];
    if (!sug.length) return '';
    var nUp = sug.filter(function (s) { return s.kind === 'update'; }).length;
    var html = '<div class="section-title">💡 AI 推荐的设定（' + sug.length +
      (nUp ? '：新增 ' + (sug.length - nUp) + ' · 修改 ' + nUp : '') + '）</div>';
    html += '<div class="hint mb8">写章节 / 生成记忆时 AI 挑出的设定，已经对照过世界书去重，不会自动进世界书。' +
      '标「改」的那类是已有条目——本章给了新事实，确认后按整理后的内容覆盖。</div>';
    html += sug.map(function (s) {
      var isUp = s.kind === 'update';
      var body = isUp
        ? '<div class="entry-body">' + esc(s.content || '（空）') + '</div>' +
          (s.prevContent ? '<div class="tiny muted mt4">原内容：' + esc(s.prevContent) + '</div>' : '') +
          (s.reason ? '<div class="tiny mt4">理由：' + esc(s.reason) + '</div>' : '')
        : '<div class="entry-body">' + esc(s.content || '（空）') + '</div>' +
          (s.keywords ? '<div class="tiny muted mt4">别名 / 触发词：' + esc(s.keywords) + '</div>' : '');
      return '<div class="entry sug">' +
        '<div class="entry-head"><div class="entry-name">' + esc(s.name || '(未命名)') + '</div>' +
        '<span class="chip">' + (isUp ? '改 ' : '') + esc(AI.WORLD_LABEL[s.cat] || s.cat) + '</span></div>' +
        body +
        (s.chapterId ? '<div class="tiny muted mt4">来自第' + ((s.chapterIndex || 0) + 1) + '章' + (s.chapterTitle ? '《' + esc(s.chapterTitle) + '》' : '') + '</div>' : '') +
        '<div class="row-wrap mt8">' +
        '<button class="btn sm primary" data-act="world.sug.accept" data-id="' + s.id + '" data-scope="' + (scope || '') + '">' +
          (isUp ? '✓ 应用修改' : '✓ 转正') + '</button>' +
        '<button class="btn sm" data-act="world.sug.edit" data-id="' + s.id + '" data-scope="' + (scope || '') + '">✎ 改后应用</button>' +
        '<button class="btn sm ghost" data-act="world.sug.dismiss" data-id="' + s.id + '">忽略</button>' +
        '</div></div>';
    }).join('');
    html += '<div class="row-wrap mt8">' +
      '<button class="btn sm primary" data-act="world.sug.select">☑ 选择并应用</button>' +
      '<button class="btn sm" data-act="world.sug.acceptAll">✓ 全部应用</button>' +
      '<button class="btn sm ghost" data-act="world.sug.clear">忽略全部</button>' +
      '</div>';
    return html;
  }

  function renderWorld(b) {
    var cat = worldTab[b.id] || 'characters';
    var scope = worldScope[b.id] || '';
    if (scope && !Store.getVolume(b, scope)) scope = worldScope[b.id] = '';

    // 作用域切换：全局 / 各分卷
    var scopeChips = [{ id: '', label: '全局设定' }].concat(b.volumes.map(function (v, i) {
      return { id: v.id, label: '第' + (i + 1) + '卷《' + esc(v.title || '未命名') + '》' };
    }));
    var html = '<div class="scope-chips">' + scopeChips.map(function (s) {
      return '<button class="btn sm' + (s.id === scope ? ' primary' : ' ghost') + '" data-act="world.scope" data-scope="' + s.id + '">' + s.label + '</button>';
    }).join('') + '</div>' +
      '<div class="hint mb8">' + (scope
        ? '当前编辑的是<b>该分卷专属</b>设定：只在对本卷章节生成时注入，其他分卷看不到。下面的全局设定带「全局」标注，点它也能改，改完可选「归属」挪到本卷，或「↧ 复制到本卷」留一份单独改写。'
        : '当前编辑的是<b>全局</b>设定：对所有分卷的章节生成都生效。') + '</div>';

    html += renderWorldSug(b, scope);
    html += '<div class="tabs tabs-fixed">' + AI.WORLD_ORDER.map(function (k) {
      var n = (b.world[k] || []).filter(function (e) { return scope ? (e.scope === scope || !e.scope) : !e.scope; }).length;
      return '<div class="tab' + (k === cat ? ' active' : '') + '" data-act="world.tab" data-cat="' + k + '">' + AI.WORLD_LABEL[k] + (n ? '(' + n + ')' : '') + '</div>';
    }).join('') + '</div>';

    // 分卷视图 = 该卷专属条目 + 全局条目（带「全局」标注）。
    // 全局条目在这里也能编辑（可随手把归属改到本卷）或一键复制到本卷，
    // 不再只能手动重添一遍。
    var arr = (b.world[cat] || []).filter(function (e) {
      return scope ? (e.scope === scope || !e.scope) : !e.scope;
    });
    if (!arr.length) {
      html += '<div class="empty-tip">「' + AI.WORLD_LABEL[cat] + '」' + (scope ? '在本分卷下' : '') + '暂无条目，可缺省。<br>条目只会注入已启用的内容。</div>';
    } else {
      html += arr.map(function (e) {
        var isGlobal = !e.scope;
        /* 触发式注入的标记：常驻（📌）/ 按触发词命中才注入（🎯 词数） */
        var kws = AI.parseKeywords(e.keywords);
        var trigMark = e.pin ? '<span class="chip on" title="常驻：每次都注入">📌 常驻</span>'
          : (kws.length ? '<span class="chip" title="命中这些词才注入：' + esc(kws.join('、')) + '">🎯 ' + kws.length + ' 词</span>' : '');
        return '<div class="entry' + (isGlobal && scope ? ' sug' : '') + '">' +
          '<div class="entry-head">' +
          '<div class="entry-name">' + esc(e.name || '(未命名)') + (e.enabled === false ? ' <span class="chip">停用</span>' : '') + '</div>' +
          trigMark +
          (isGlobal && scope ? '<span class="chip">全局</span>' : '') +
          (isGlobal && scope ? '<button class="btn sm ghost" data-act="world.copyToVol" data-cat="' + cat + '" data-scope="' + scope + '" data-id="' + e.id + '" title="复制一份到本卷，之后可单独修改">↧ 复制到本卷</button>' : '') +
          '<button class="btn sm ghost" data-act="world.toggle" data-cat="' + cat + '" data-id="' + e.id + '">' + (e.enabled === false ? '启用' : '停用') + '</button>' +
          '<button class="btn sm danger" data-act="world.del" data-cat="' + cat + '" data-id="' + e.id + '">删除</button>' +
          '</div>' +
          '<div class="entry-body" data-act="world.edit" data-cat="' + cat + '" data-scope="' + scope + '" data-id="' + e.id + '">' + esc(e.content || '（空）') + '</div>' +
          '</div>';
      }).join('');
    }
    html += '<button class="btn block mt8" data-act="world.add" data-cat="' + cat + '" data-scope="' + scope + '">＋ 新增「' + AI.WORLD_LABEL[cat] + '」条目' + (scope ? '（本分卷）' : '') + '</button>';
    html += '<button class="btn block mt8 primary" data-act="world.ai">✨ AI 整理：粘贴一大段想法，自动建条目</button>';
    html += '<div class="hint">名称 + 内容两段式，方便 AI 精确检索人物与设定的对应关系。懒得一条条填时，用上面的 AI 入口把想法一股脑倒进去。</div>';
    return html;
  }
  UI.worldScope = worldScope;

  /* 运行时状态：各分卷章节列表的收起 / 打开（不持久化，刷新恢复展开） */
  UI.volCollapsed = {};

  /* 单个章节行：整行可点进章节（行内按钮仍各自触发） */
  function chapterRow(b, c, i) {
    var wc = AI.wordCount(c.content);
    var target = b.targetWordsPerChapter || 0;
    var status;
    if (c.content) {
      status = '<span style="color:var(--ok)">已写 ' + fmtNum(wc) + ' 字</span>';
      if (target > 0) {
        var pct = Math.round(wc / target * 100);
        status += '<span class="muted"> · 目标 ' + fmtNum(target) + ' 字（' + pct + '%）</span>';
      }
    } else {
      status = '<span class="muted">待生成</span>';
    }
    return '<div class="chapter-item clickable' + (c.content ? ' done' : '') + '" data-act="read" data-id="' + c.id + '">' +
      '<div class="no">' + (i + 1) + '</div>' +
      '<div class="chapter-body">' +
      '<div class="chapter-title ellipsis">' + esc(c.title || ('第' + (i + 1) + '章')) + '</div>' +
      '<div class="chapter-outline">' + esc(c.outline || '（暂无大纲）') + '</div>' +
      '<div class="chapter-meta">' + status + '</div>' +
      '<div class="row-wrap mt8">' +
      '<button class="btn sm" data-act="chapter.edit" data-id="' + c.id + '">✎ 大纲</button>' +
      '<button class="btn sm" data-act="chapter.moveVol" data-id="' + c.id + '">⇄ 换分卷</button>' +
      '<button class="btn sm primary" data-act="chapter.generate" data-id="' + c.id + '">' +
      (c.content ? '✏️ AI 重写' : '✨ 生成正文') + '</button>' +
      '</div>' +
      '</div>' +
      '<button class="icon-btn small" data-act="chapter.menu" data-id="' + c.id + '">⋮</button>' +
      '</div>';
  }

  /* =========================================================
   * 章节目录（合并了原「大纲分卷」与章节列表）
   * 每个分卷一节，可收起 / 打开；卷级操作（自动分章 / 新章 /
   * 卷大纲 / 删除）都在卷头上；底部管新建与新增分卷。
   * ========================================================= */
  function renderChapterDir(b) {
    var groups = [], byId = {};
    b.volumes.forEach(function (v) { var g = { vol: v, items: [] }; byId[v.id] = g; groups.push(g); });
    var orphan = [];
    b.chapters.forEach(function (c, i) {
      var g = c.volumeId ? byId[c.volumeId] : null;
      if (g) g.items.push({ c: c, i: i }); else orphan.push({ c: c, i: i });
    });
    if (orphan.length) groups.push({ vol: null, items: orphan });

    var html = '';
    if (!b.chapters.length && !b.volumes.length) {
      html += '<div class="empty-tip">还没有分卷与章节。<br>可以先「＋ 新增分卷」写一卷大纲，<br>或直接「✨ AI 自动分章」让 AI 拆成若干章。</div>';
    }
    // 原「章节目录独立界面」的三个入口全部并入本标签页，独立界面已移除
    html += '<div class="row-wrap mb12">' +
      '<button class="btn sm" data-act="world.browse" data-id="' + b.id + '">🌍 浏览世界设定</button>' +
      '<button class="btn sm" data-act="outline.ai" data-id="' + b.id + '">✨ AI 自动分章</button>' +
      '<button class="btn sm primary" data-act="chapter.new" data-id="' + b.id + '">＋ 新建章节</button>' +
      '</div>';
    groups.forEach(function (g) {
      var vol = g.vol;
      var vid = vol ? vol.id : '__orphan';
      var collapsed = !!UI.volCollapsed[vid];
      // 卷号取 book.volumes 里的真实序号（出现未归入分卷的分组时也不会错位）
      var vi = vol ? Store.volumeIndex(b, vol.id) : -1;
      var volNo = vi >= 0 ? vi + 1 : '?';
      var title = vol ? ('第' + volNo + '卷《' + esc(vol.title || '未命名') + '》') : '未归入分卷';
      html += '<div class="vol-section' + (collapsed ? ' collapsed' : '') + '" data-vol="' + vid + '">' +
        '<div class="vol-head">' +
        '<div class="vol-title-row" data-act="volume.collapse" data-id="' + vid + '">' +
        '<span class="vol-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="vol-title">' + title + '</span>' +
        '<span class="tiny muted"> · ' + g.items.length + ' 章</span>' +
        '</div>' +
        '<div class="row-wrap mt8">' +
        (vol ? '<button class="btn sm" data-act="outline.ai" data-id="' + vol.id + '">✨ 自动分章</button>' : '') +
        (vol ? '<button class="btn sm" data-act="chapter.new" data-id="' + b.id + '" data-vol="' + vol.id + '">＋ 本卷新章</button>' : '') +
        (vol ? '<button class="btn sm ghost" data-act="volume.edit" data-id="' + vol.id + '">✎ 卷大纲</button>' : '') +
        (vol ? '<button class="btn sm ghost" data-act="volume.del" data-id="' + vol.id + '">删除</button>' : '') +
        '</div></div>' +
        '<div class="vol-chapters">';
      if (!g.items.length) {
        html += '<div class="empty-tip" style="padding:12px">本卷还没有章节</div>';
      } else {
        html += '<div class="list">' + g.items.map(function (it) {
          return chapterRow(b, it.c, it.i);
        }).join('') + '</div>';
      }
      html += '</div></div>';
    });

    html += '<div class="mt16 row">' +
      '<button class="btn" style="flex:1" data-act="chapter.new" data-id="' + b.id + '">＋ 新建章节</button>' +
      '<button class="btn" style="flex:1" data-act="outline.ai" data-id="' + b.id + '">✨ AI 自动分章</button>' +
      '</div>' +
      '<div class="mt12"><button class="btn block ghost" data-act="volume.new">＋ 新增分卷</button></div>' +
      '<div class="hint mt8">点章节行（按钮除外）即进入阅读 / 写作；点卷标题可收起 / 打开该卷章节。「✏️ AI 重写」可在重写时附加指示，留空则直接重写。</div>';
    return html;
  }

  /* 章节目录 / 阅读页里浏览世界设定用：全部分栏 + 条目，标注作用域 */
  function renderWorldBrowse(b) {
    var pool = Store.allWorldEntries(b);
    var html = '<div class="hint mb12">这里浏览全部设定。全局设定对全书生效；分卷设定只在该卷章节生成时注入。编辑请到「世界设定」页。</div>';
    var any = false;
    AI.WORLD_ORDER.forEach(function (cat) {
      var arr = pool[cat] || [];
      if (!arr.length) return;
      any = true;
      html += '<div class="section-title">' + AI.WORLD_LABEL[cat] + '（' + arr.length + '）</div>';
      html += arr.map(function (e) {
        return '<div class="entry' + (e.enabled === false ? ' sug' : '') + '">' +
          '<div class="entry-head"><div class="entry-name">' + esc(e.name || '(未命名)') + '</div>' +
          '<span class="chip">' + esc(Store.worldScopeLabel(b, e.scope)) + '</span>' +
          (e.enabled === false ? '<span class="chip">停用</span>' : '') +
          '</div>' +
          '<div class="entry-body">' + esc(e.content || '（空）') + '</div>' +
          '</div>';
      }).join('');
    });
    if (!any) html = '<div class="empty-tip">还没有任何世界设定。<br>可到「世界设定」页添加，或让 AI 在写作时顺带推荐。</div>';
    return html;
  }
  UI.renderWorldBrowse = renderWorldBrowse;

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

    html += '<div class="entry"><div class="entry-head"><div class="entry-name">设定管理模型再整理一遍</div>' +
      '<label class="switch"><input type="checkbox" data-act="world.governToggle"' + (b.worldGovern !== false ? ' checked' : '') + '><span class="track"></span></label></div>' +
      '<div class="hint">记忆模型看不到世界书，它给的候选里混着一堆「其实已经有了」。开启后，会再交给<b>设定管理</b>模型对照世界书整理：重复的判成「修改已有条目」而不是新增，并补上别名触发词。' +
      '关掉就用记忆模型的原始候选（省一次请求）。该模型可在「设置 → 模型方案」里为「设定管理」单独指派。</div></div>';

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

  /* 伏笔板：埋设章 / 计划回收章 / 状态。逾期未回收的高亮提醒——
   * 长线伏笔烂尾，绝大多数不是忘了写，是忘了「还没收」。 */
  function renderHooks(b) {
    var hooks = b.hooks || [];
    var cur = b.chapters.length;
    var open = hooks.filter(function (h) { return h.status === 'open'; });
    var done = hooks.filter(function (h) { return h.status !== 'open'; });

    function card(h) {
      var overdue = h.status === 'open' && h.planChapter > 0 && h.planChapter <= cur;
      var bits = [];
      if (h.fromChapter) bits.push('第' + h.fromChapter + '章埋下');
      if (h.planChapter) bits.push('计划第' + h.planChapter + '章回收');
      return '<div class="card mb8"' + (overdue ? ' style="border-color:rgba(239,106,122,.45)"' : '') + '>' +
        '<div class="row-wrap">' +
        (h.status === 'open'
          ? (overdue ? '<span class="chip on" style="color:var(--danger)">⚠ 逾期未回收</span>' : '<span class="chip">未回收</span>')
          : '<span class="chip">' + (h.status === 'resolved' ? '已回收' : '已放弃') + '</span>') +
        '<div class="spacer"></div>' +
        '<button class="btn sm" data-act="hook.edit" data-id="' + h.id + '">✎</button>' +
        (h.status === 'open'
          ? '<button class="btn sm" data-act="hook.resolve" data-id="' + h.id + '">✓ 回收</button>'
          : '<button class="btn sm" data-act="hook.reopen" data-id="' + h.id + '">↩ 重新开启</button>') +
        '<button class="btn sm danger" data-act="hook.del" data-id="' + h.id + '">✕</button>' +
        '</div>' +
        '<div class="mt8">' + esc(h.content) + '</div>' +
        (bits.length ? '<div class="tiny muted mt4">' + esc(bits.join(' · ')) + '</div>' : '') +
        (h.note ? '<div class="tiny muted mt4">备注：' + esc(h.note) + '</div>' : '') +
        '</div>';
    }

    return '<div class="hint mb8">伏笔会随正文生成自动注入提示词（只注入「未回收」的），' +
      '提醒模型写到该收的地方时接住。计划回收章 ≤ 当前章节数时会在列表里高亮。</div>' +
      '<button class="btn block primary" data-act="hook.add">＋ 新增伏笔</button>' +
      '<div class="section-title">未回收（' + open.length + '）</div>' +
      (open.length ? open.map(card).join('') : '<div class="empty-tip">还没有伏笔</div>') +
      (done.length ? '<div class="section-title">已回收 / 已放弃（' + done.length + '）</div>' + done.map(card).join('') : '');
  }

  /* 任务分工一览：只显示「当前启用方案」会让人以为模型不能分工，
   * 这里按 Store.routingTable() 把七类任务各自实际会走哪套方案逐条列出，
   * 专职 / 兜底 / 冲突（同一任务被多套认领）/ 失效（提供商没了）一眼可见。 */
  function renderRouting() {
    var rows = Store.routingTable();
    if (!rows.length) return '';
    var out = '<div class="hint mb8">每类任务可以单独指派一套方案（在方案里设「专用于」），' +
      '没指派的任务用下面的兜底方案。改完这里立刻变。</div>';
    rows.forEach(function (r) {
      var badge = r.source === 'dedicated'
        ? '<span class="chip on">专职</span>'
        : '<span class="chip">用兜底</span>';
      var what = r.preset
        ? esc(r.providerName + ' · ' + r.model) + (r.presetName ? '　' + esc(r.presetName) : '')
        : '<span class="muted">未配置任何接口</span>';
      out += '<div class="entry">' +
        '<div class="entry-head"><div class="entry-name">' + esc(r.label) + ' ' + badge + '</div>' +
        '<button class="btn sm" data-act="route.assign" data-task="' + esc(r.task) + '">指派…</button></div>' +
        '<div class="entry-body">' + what + '</div>' +
        (r.conflict ? '<div class="tiny muted mt4">⚠ 有 ' + r.conflict + ' 套方案都指派了这个任务，只认第一套（请到方案里改掉多余的）</div>' : '') +
        (r.broken ? '<div class="tiny muted mt4" style="color:var(--danger)">⚠ 指派的那套方案提供商已删除，实际已回落到兜底方案</div>' : '') +
        '</div>';
    });
    return out;
  }

  /* 用量与成本：把「钱花在哪」摊开给用户看。
   * 未配置单价时只显示 token 数，不假装有金额。 */
  function usageCard(u, title) {
    if (!u || !u.requests) return '';
    function cell(num, label) {
      return '<div class="stat-cell"><b>' + fmtNum(num) + '</b><span>' + label + '</span></div>';
    }
    var cost = u.cost > 0 ? cell('¥' + u.cost.toFixed(2), '估算成本') : '';
    return '<div class="section-title">' + title + '</div>' +
      '<div class="stat-grid">' +
      cell(u.requests, '请求次数') +
      cell(u.promptTokens, '输入 token') +
      cell(u.completionTokens, '输出 token') +
      cost +
      '</div>' +
      (u.cost > 0 ? '' : '<div class="hint">想看金额：到「设置 → 模型方案」里给方案填上单价（元 / 百万 token）。</div>');
  }

  /* =========================================================
   * AI 小编 · 对话页
   * 一轮对话一次请求：小编看到的上下文与写正文时完全一致，
   * 要动数据时在回复末尾附一个 actions 代码块，这里把它渲染成可勾选的提案。
   * ========================================================= */
  function chatCtxChapter(b) {
    var id = b.chatChapterId;
    var c = id ? Store.getChapter(b, id) : null;
    if (c) return c;
    return b.chapters[b.chapters.length - 1] || b.chapters[0] || null;
  }

  function clip(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* 一条 AI 回复里的提案清单：可勾选、能看清「从什么改成什么」
   * 定位不到 / 名字有歧义的条目直接禁选并说明原因——绝不猜着改。 */
  function chatActsHtml(b, m) {
    var props = Store.resolveEditorActions(b, m.actions || []);
    if (!props.length) return '';
    var okN = props.filter(function (p) { return p.ok; }).length;
    var rows = props.map(function (p) {
      var i = p.idx;
      if (!p.ok) {
        // 定位不到 / 名字有歧义：说清楚为什么，别给一个点了没反应的按钮
        return '<div class="chat-act bad">' +
          '<div class="chat-act-body">' +
          '<div class="chat-act-head">' + esc(p.label) + ' · ' + esc(p.title) + ' <span class="chip warn">不适用</span></div>' +
          '<div class="chat-act-why">⚠ ' + esc(p.reason) + '</div>' +
          '</div>' +
          '<div class="chat-act-btns">' +
          '<button class="btn xs ghost" data-act="chat.drop" data-mid="' + m.id + '" data-idx="' + i + '">忽略</button>' +
          '</div></div>';
      }
      var expanded = !!p.raw && p.raw.__open;
      return '<div class="chat-act">' +
        '<div class="chat-act-body">' +
        '<div class="chat-act-head">' + esc(p.label) + ' · ' + esc(p.title) + '</div>' +
        '<div class="chat-act-diff' + (expanded ? '' : ' one-line') + '">' +
        (p.kind === 'create' ? '<span class="chat-act-tag">新增</span>' : '<s>' + esc(p.before) + '</s> → ') +
        '<b>' + esc(p.after) + '</b></div>' +
        (p.warn ? '<div class="chat-act-why">' + esc(p.warn) + '</div>' : '') +
        '</div>' +
        '<div class="chat-act-btns">' +
        '<button class="btn xs ghost" data-act="chat.preview" data-mid="' + m.id + '" data-idx="' + i + '">' + (expanded ? '收起' : '预览') + '</button>' +
        (p.editKind ? '<button class="btn xs ghost" data-act="chat.editAct" data-mid="' + m.id + '" data-idx="' + i + '">修改</button>' : '') +
        '<button class="btn xs primary" data-act="chat.applyOne" data-mid="' + m.id + '" data-idx="' + i + '">应用</button>' +
        '<button class="btn xs ghost" data-act="chat.drop" data-mid="' + m.id + '" data-idx="' + i + '">忽略</button>' +
        '</div></div>';
    }).join('');
    return '<div class="chat-acts">' +
      '<div class="chat-acts-title">小编建议的改动 · ' + okN + ' / ' + props.length + ' 项可用（可逐条预览 / 修改 / 应用 / 忽略）</div>' +
      rows +
      '</div>' +
      (okN > 1 ? '<button class="btn sm primary mt8" data-act="chat.apply" data-id="' + m.id + '">✓ 全部应用（' + okN + ' 项）</button>' : '');
  }

  function renderChat(b) {
    var c = chatCtxChapter(b);
    var ctxInfo = '';
    if (c) {
      var s = AI.injectStats(b, c);
      var total = 0;
      ['world', 'memory', 'recent', 'hooks', 'style', 'outline'].forEach(function (k) { total += s[k].tokens; });
      ctxInfo = '<div class="hint">上下文：第 ' + (Store.chapterIndex(b, c.id) + 1) + ' 章' +
        (c.title ? '《' + esc(c.title) + '》' : '') + ' · 约 ' + total + ' token' +
        '（和写正文时看到的是同一份：设定 / 记忆 / 最近正文 / 伏笔 / 文风 / 分卷大纲）</div>';
    }

    var html = '<div class="chat-ctx">' +
      '<div class="chat-ctx-row"><span class="chat-ctx-label">基于</span>' +
      '<button class="btn sm" data-act="chat.pick">' +
      (c ? '第 ' + (Store.chapterIndex(b, c.id) + 1) + ' 章' + (c.title ? ' · ' + esc(c.title) : '') : '（本书还没有章节）') +
      '</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn sm ghost" data-act="chat.clear">清空对话</button>' +
      '</div>' + ctxInfo + '</div>';

    var txns = (b.txns || []).slice(-3).reverse();
    if (txns.length) {
      html += '<div class="chat-txns">' + txns.map(function (t) {
        return '<div class="chat-txn">' +
          '<span class="tiny muted">已应用 · ' + esc(clip(t.label, 26)) + '（' + t.changes.length + ' 项）</span>' +
          '<button class="btn sm ghost" data-act="chat.undoTxn" data-id="' + t.id + '">撤销</button>' +
          '</div>';
      }).join('') + '</div>';
    }

    var msgs = (b.chat || []).slice(-40);
    html += '<div class="chat-list" id="chatList">';
    if (!msgs.length) {
      html += '<div class="chat-empty">' +
        '和小编聊聊你的书。可以问它剧情、让它挑毛病，也可以直接让它改设定 / 伏笔 / 大纲——' +
        '它会把改动写成提案，你勾选后才会生效，随时能撤销。<br><br>' +
        '试试：「老周这个角色太单薄了」「第 2 卷的节奏是不是有问题」「帮我给雾都补两条别名」' +
        '</div>';
    } else {
      html += msgs.map(function (m) {
        return '<div class="chat-msg ' + (m.role === 'user' ? 'me' : 'ai') + '" data-mid="' + m.id + '">' +
          '<div class="chat-bubble">' + esc(m.text) + '</div>' +
          (m.role === 'ai' ? chatActsHtml(b, m) : '') +
          '</div>';
      }).join('');
    }
    html += '</div>';

    html += '<div class="chat-input">' +
      '<textarea class="textarea" id="chatText" rows="2" placeholder="和小编说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>' +
      '<button class="btn primary" data-act="chat.send">发送</button>' +
      '</div>';
    return html;
  }

  function renderData(b) {
    var info = Store.storageInfo();
    return usageCard(b.usage, '本书累计用量') +
      '<div class="section-title">导出 / 导入</div>' +
      '<div class="row-wrap">' +
      '<button class="btn sm" data-act="book.export" data-id="' + b.id + '">导出本书 JSON</button>' +
      '<button class="btn sm" data-act="book.import">导入书本 JSON</button>' +
      '<button class="btn sm" data-act="book.exportTxt" data-id="' + b.id + '">导出正文 TXT</button>' +
      '<button class="btn sm" data-act="book.exportMd" data-id="' + b.id + '">导出 Markdown</button>' +
      '<button class="btn sm" data-act="book.stats" data-id="' + b.id + '">📊 写作统计</button>' +
      '</div>' +
      '<div class="hint mt8">正文字数：' +
      fmtNum(b.chapters.reduce(function (s, c) { return s + AI.wordCount(c.content); }, 0)) +
      ' 字 · 本地占用约 ' + esc(info.text) + '</div>' +
      (info.healthy ? '' : '<div class="hint" style="color:var(--danger)">⚠ 最近一次保存失败，请立即导出数据备份。</div>') +
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
  /* 正文里的【【】】→ 高亮 HTML：框里的字高亮显示，方括号本身不出现。
   * 序号用 CSS ::after（attr(data-n)）画，不写成真文本节点——阅读器上渲染的是
   * 「去掉方括号」的文本，插入哪怕一个字符都会让读者看到的和正文对不上。 */
  function markedHtml(content, chapter) {
    var items = Util.parseBracketMarks(content || '');
    var notes = {};
    if (chapter) {
      // 用与 Store 同一套对齐规则，高亮上才能带出对应那条意见
      var used = {};
      var pool = (chapter.marks || []).slice();
      items.forEach(function (it) {
        var hit = pool.filter(function (m) { return !used[m.id] && String(m.anchor || '') === it.anchor; })[0];
        if (hit) { used[hit.id] = 1; notes[it.id] = hit.note || ''; }
      });
    }
    return Util.bracketSegments(content || '').map(function (s) {
      if (!s.mark) return esc(s.text);
      var it = s.mark;
      var note = notes[it.id] ? ' title="' + esc(notes[it.id]) + '"' : '';
      return '<mark class="mk" data-act="mark.tap" data-idx="' + it.idx + '"' +
        ' data-n="' + (it.idx + 1) + '"' + note + '>' + esc(s.text) + '</mark>';
    }).join('');
  }

  var Reader = {
    book: null, index: 0,
    el: {}, H: 0, dragging: false, startY: 0, dir: 0, atEdge: false,

    /* 当前正在阅读的章节。
     * 这个 getter 之前漏了定义，`Reader.chapter` 一直是 undefined——
     * 于是靠它取章节的动作（一致性审计）在 `if (!c) return` 处静默失效，页面上点了没反应。 */
    get chapter() {
      if (!this.book) return null;
      return this.book.chapters[this.index] || null;
    },

    mount: function (book, idx) {
      this.book = book; this.index = idx;
      /* 每次重新挂载都重置跟随意愿 + 清掉流式标记：
       * 上一章的「暂停跟随」不该带到下一章，否则新章会莫名其妙不跟随。 */
      this.follow = true;
      this.streaming = false;
      this.el = {
        vp: $('rv'), prev: $('rpPrev'), cur: $('rpCur'), next: $('rpNext'), prog: $('rProg'),
        follow: $('rFollow')
      };
      this.el.progNum = $('rProgNum');
      this.showFollow(false);
      this.H = this.el.vp.clientHeight;
      this.fill(this.el.prev, idx - 1, -1);
      this.fill(this.el.cur, idx, 0);
      this.fill(this.el.next, idx + 1, 1);
      this.bindGestures();
      this.bindScroll();
      this.updateProgress();
    },

    base: function (pos) { return 'translateY(' + (pos * this.H) + 'px)'; },

    fill: function (elm, idx, pos) {
      var b = this.book;
      if (idx < 0 || idx >= b.chapters.length) { elm.innerHTML = ''; elm.style.transform = this.base(pos); return; }
      var c = b.chapters[idx];
      var fs = Store.state.ui.fontSize || 17;
      var lh = Store.state.ui.lineHeight || 1.85;
      var para = Store.state.ui.paraSpacing == null ? 1 : Store.state.ui.paraSpacing;
      var body = '<div class="reader-content">' + markedHtml(c.content, c) + '</div>' +
        (c.content ? '' : '<div class="reader-empty">本章还没有正文。<br><br>点击底部「✨ AI 写」按本章大纲生成，或「编辑」手动撰写。</div>');
      var wc = AI.wordCount(c.content);
      elm.innerHTML = '<div class="reader-inner">' +
        '<div class="reader-chapter-title">第' + (idx + 1) + '章' + (c.title ? ' · ' + esc(c.title) : '') + '</div>' +
        '<div class="reader-chapter-sub">' + (c.outline ? esc(c.outline) : '（暂无大纲）') +
        (wc ? '<span class="muted"> · 本章 ' + fmtNum(wc) + ' 字</span>' : '') + '</div>' +
        '<div class="reader-body" style="font-size:' + fs + 'px;line-height:' + lh + ';--para-gap:' + para + 'em">' + body + '</div>' +
        '</div>';
      elm.scrollTop = 0;
      elm.style.transform = this.base(pos);
    },

    /* 显示在阅读条上的全书进度百分比 */
    updateProgress: function () {
      var q = this.el && this.el.progNum;
      if (!q) return;
      var b = this.book;
      var total = b.chapters.length || 1;
      // 章节进度 + 本章内滚动进度，给出一个连续值
      var e = this.el.cur;
      var max = e ? (e.scrollHeight - e.clientHeight) : 0;
      var inChapter = max > 0 ? Math.min(1, e.scrollTop / max) : 1;
      var pct = Math.round(((this.index + inChapter) / total) * 100);
      this.el.progNum.textContent = pct + '%';
    },

    /* 重画当前页。阅读条上的「改稿 N」也一并刷新——
     * 框是在正文里的，正文一变处数就变，计数必须跟着走
     * （否则会留下一个点了没反应的按钮）。 */
    refreshCur: function () {
      this.fill(this.el.cur, this.index, 0);
      this.updateMarkBtn(this.chapter);
    },

    /* ---------- 框选标记（正文里的【【】】） ---------- */
    /* 有几处标记 = 正文里有几个【【】】。纯解析，不依赖任何缓存状态。 */
    liveMarkCount: function (chapter) {
      if (!chapter || !chapter.content) return 0;
      return Util.parseBracketMarks(chapter.content).length;
    },
    /* 就地刷新阅读条上的「改稿 N」按钮：不整页重渲（会丢掉滚动位置） */
    updateMarkBtn: function (chapter) {
      var bar = document.querySelector('.reader-bar');
      if (!bar) return;
      var btn = bar.querySelector('[data-act="mark.list"]');
      var n = Reader.liveMarkCount(chapter);
      if (!n) { if (btn) btn.remove(); return; }
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'btn sm';
        btn.setAttribute('data-act', 'mark.list');
        var ref = bar.querySelector('[data-act="reader.generate"]');
        bar.insertBefore(btn, ref);
      }
      btn.textContent = '🖍 ' + n;
      btn.title = '框选改稿（' + n + ' 处）';
    },

    /* 自动跟随：默认开着，流式输出时把页面按到底部。
     * 用户主动往上拖（scrollTop 明显离开底部）就暂停跟随，避免「看前文时被不断拽回底部」；
     * 点右下角的小按钮或自己滚回底部即恢复。 */
    follow: true,
    showFollow: function (on) {
      var btn = this.el && this.el.follow;
      if (!btn) return;
      if (on) btn.classList.remove('hidden'); else btn.classList.add('hidden');
    },
    /* 由用户滚动触发：判断是否还贴着底部 */
    onUserScroll: function () {
      var e = this.el && this.el.cur;
      if (!e) return;
      var max = e.scrollHeight - e.clientHeight;
      var atBottom = max <= 2 || (max - e.scrollTop) <= 24;
      if (atBottom) {
        if (!this.follow) { this.follow = true; this.showFollow(false); }
      } else if (this.follow && this.streaming) {
        // 只有「正在流式输出」时才因为上翻而暂停；正常阅读滚动不受影响
        this.follow = false;
        this.showFollow(true);
      }
    },
    resumeFollow: function () {
      this.follow = true;
      this.showFollow(false);
      var e = this.el && this.el.cur;
      if (e) e.scrollTop = e.scrollHeight;
    },

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
        this.streaming = true;
        box.classList.add('cursor-blink');
        if (this.follow) el.scrollTop = el.scrollHeight;
      } else {
        this.streaming = false;
        box.classList.remove('cursor-blink');
        this.showFollow(false);
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
        self.updateProgress();
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
        self.updateProgress();
        self.onUserScroll();
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
