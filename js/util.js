/* =========================================================
 * Util —— 跨模块共用的纯函数
 * 原来 esc / fmtTime / wordCount / parseJsonMaybe 散落在
 * ui.js、ai.js、app.js 三处，或定义在错误的层里（比如 UI 需要
 * copyText 但它在 app.js），这里集中一份并保证行为一致。
 * ========================================================= */
(function (global) {
  'use strict';

  /* 【【…】】的匹配源。每次调用都新建一个 RegExp —— 带 g 的正则对象
   * 自己带着 lastIndex 状态，复用同一个会在连续调用之间互相干扰。 */
  var BRACKET_SRC = '【【([\\s\\S]*?)】】';

  var Util = {
    /* HTML 转义。
     * 除了常规五字符，这里额外处理反引号：属性值虽然用双引号包裹，
     * 但一旦将来有人把插值写进模板字符串或未加引号的属性里，反引号会成为逃逸口。
     */
    esc: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');
    },

    /* 时间：今天显示「今天 HH:mm」，否则「M/D HH:mm」 */
    fmtTime: function (ts) {
      if (!ts) return '';
      var d = new Date(ts), n = new Date();
      var p = function (x) { return x < 10 ? '0' + x : '' + x; };
      if (d.toDateString() === n.toDateString()) return '今天 ' + p(d.getHours()) + ':' + p(d.getMinutes());
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    /* 数字：过万折算成「N.N万」 */
    fmtNum: function (n) {
      n = n || 0;
      return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
    },

    /* 中文字数：按非空白字符计。
     * 注意这是「字数」而非 token 数，对中文写作的直觉更准。
     */
    wordCount: function (t) {
      return String(t == null ? '' : t).replace(/\s/g, '').length;
    },

    /* token 粗估（不看 API 返回值时用）。
     * 混合中英文时 1 个中文字约 0.6 token、1 个英文词约 1.3 token；
     * 这里统一按「1 字符 ≈ 0.65 token」折算，用途是生成前让用户知道量级，
     * 精确数字以接口返回的 usage 为准。
     */
    estimateTokens: function (t) {
      var s = String(t == null ? '' : t);
      if (!s) return 0;
      var cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length;
      var rest = s.length - cjk;
      return Math.ceil(cjk * 0.6 + rest * 0.3);
    },

    /* 本地文风扫描：找出正文里命中禁词的片段（纯前端，零 API 成本）。
     * banned 支持换行 / 逗号 / 分号分隔。返回 [{ word, count, hits:[{at, excerpt}] }]
     */
    scanBanned: function (text, banned) {
      var s = String(text == null ? '' : text);
      var words = String(banned == null ? '' : banned)
        .split(/[\n,，、;；]+/).map(function (x) { return x.trim(); })
        .filter(function (x) { return x && x.length <= 40; });
      var out = [];
      words.forEach(function (w) {
        var hits = [], at = 0, guard = 0;
        while ((at = s.indexOf(w, at)) >= 0 && guard++ < 200) {
          hits.push({ at: at, excerpt: Util.safeSliceEnd(s.slice(Math.max(0, at - 18), at + w.length + 18), 60) });
          at += w.length;
        }
        if (hits.length) out.push({ word: w, count: hits.length, hits: hits.slice(0, 20) });
      });
      return out;
    },

    /* 按「字符」安全截断尾部：避免把 emoji 的代理对劈成半个 */
    safeSliceEnd: function (s, n) {
      s = String(s || '');
      if (s.length <= n) return s;
      var start = s.length - n;
      var c = s.charCodeAt(start);
      if (c >= 0xDC00 && c <= 0xDFFF) start += 1;
      return s.slice(start);
    },

    /* 按「字符」安全截断头部 */
    safeSliceStart: function (s, n) {
      s = String(s || '');
      if (s.length <= n) return s;
      var end = n;
      var c = s.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) end -= 1;
      return s.slice(0, end);
    },

    /* 从 AI 回复里尽力抠出 JSON。
     * 依次尝试：整体 → 代码块内 → 第一个 {..} → 第一个 [..]
     */
    parseJsonMaybe: function (text) {
      var s = String(text || '').trim();
      s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      var tries = [];
      try { tries.push(JSON.parse(s)); } catch (e) { }
      var a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) { try { tries.push(JSON.parse(s.slice(a, b + 1))); } catch (e) { } }
      var c = s.indexOf('['), d = s.lastIndexOf(']');
      if (c >= 0 && d > c) { try { tries.push(JSON.parse(s.slice(c, d + 1))); } catch (e) { } }
      for (var i = 0; i < tries.length; i++) {
        if (tries[i] && typeof tries[i] === 'object') return tries[i];
      }
      throw new Error('AI 返回内容无法解析为 JSON，请重试或调低温度。\n\n原始返回前 200 字：\n' + Util.safeSliceStart(text, 200));
    },

    /* 清理正文：去掉包装用的 markdown 围栏和开头的标题行 */
    cleanText: function (t) {
      var s = String(t || '');
      s = s.replace(/\r\n/g, '\n');
      s = s.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
      s = s.replace(/^\s*#{1,6}\s*.*\n+/, '');
      s = s.replace(/^\s*\n+/, '');
      return s.trim();
    },

    /* 把数值钳制在 [min, max]，非数字时返回 fallback */
    clampInt: function (v, min, max, fallback) {
      var n = parseInt(v, 10);
      if (isNaN(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    },

    clampFloat: function (v, min, max, fallback) {
      var n = parseFloat(v);
      if (isNaN(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    },

    /* 复制到剪贴板：优先用 async API，失败回落到 execCommand（老 WebView / file:// 场景） */
    copyText: function (t) {
      t = String(t == null ? '' : t);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).catch(function () { Util._legacyCopy(t); });
          return true;
        }
      } catch (e) { }
      return Util._legacyCopy(t);
    },
    _legacyCopy: function (t) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    },

    /* 触发浏览器下载 */
    download: function (text, filename, mime) {
      var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    },

    /* 文件名净化：去掉路径分隔符与非法字符，防止下载名异常 */
    safeFilename: function (name, fallback) {
      var s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
      s = s.replace(/^\.+/, '');
      if (!s) s = fallback || 'untitled';
      return s.slice(0, 80);
    },

    /* =========================================================
     * 正文标记（【【】】框选改稿）
     *
     * 做法：作者直接在正文里用【【】】把要改的地方框起来，系统解析成条目。
     * 不用浏览器的选区 —— 选区的 DOM Range 与原文偏移的换算在移动端
     * （换行、软键盘、手势翻页叠加时）太不可靠，框选是纯文本层面的，所见即所得。
     * ========================================================= */

    /* 解析正文里所有的【【…】】。
     * start/end 覆盖**含方括号的整体**（替换时连框一起换掉，成稿里不会留下方括号）；
     * innerStart/innerEnd 是框内的正文范围。 */
    parseBracketMarks: function (content) {
      var s = String(content == null ? '' : content);
      var re = new RegExp(BRACKET_SRC, 'g');
      var out = [], m;
      while ((m = re.exec(s))) {
        var inner = m[1];
        if (!inner.trim()) continue;          // 空的【【】】不当标记
        var innerStart = m.index + 2;
        out.push({
          id: 'bk' + out.length,
          idx: out.length,
          start: m.index, end: m.index + m[0].length,
          innerStart: innerStart, innerEnd: innerStart + inner.length,
          anchor: inner,
          raw: m[0]
        });
      }
      return out;
    },

    /* 去掉正文里所有【【】】（保留框里的文字）：取消标记时用 */
    stripBrackets: function (content) {
      var s = String(content == null ? '' : content);
      return s.replace(new RegExp(BRACKET_SRC, 'g'), '$1');
    },

    /* 给渲染用：把正文切成「普通段 / 高亮段」。
     * 高亮段只显示框里的文字，方括号本身不出现。 */
    bracketSegments: function (content) {
      var s = String(content == null ? '' : content);
      var items = Util.parseBracketMarks(s);
      var out = [], at = 0;
      items.forEach(function (it) {
        if (it.start > at) out.push({ text: s.slice(at, it.start), mark: null });
        out.push({ text: it.anchor, mark: it });
        at = it.end;
      });
      if (at < s.length) out.push({ text: s.slice(at), mark: null });
      return out;
    },

    /* 把 AI 给的新文本放回正文：连【【】】一起换成新文本。
     * patches: [{ id, text }]（id 是 'bk0' 这种按出现顺序的编号）。
     * 倒序替换 → 前面片段变长不影响后面片段的位置。 */
    applyBracketPatches: function (content, items, patches) {
      var s = String(content == null ? '' : content);
      var byId = {};
      (patches || []).forEach(function (p) { if (p && p.id) byId[p.id] = String(p.text == null ? '' : p.text); });
      var jobs = [], applied = [], skipped = [];
      (items || []).forEach(function (it) {
        var nt = byId[it.id];
        if (nt == null || !String(nt).trim()) { skipped.push(it.id); return; }
        jobs.push({ start: it.start, end: it.end, text: nt, id: it.id });
      });
      jobs.sort(function (a, b) { return b.start - a.start; });
      var out = s;
      jobs.forEach(function (j) {
        out = out.slice(0, j.start) + j.text + out.slice(j.end);
        applied.push(j.id);
      });
      return { text: out, applied: applied, skipped: skipped };
    },

    /* =========================================================
     * 旧的选区标记（仍保留：给「按偏移/原文定位」这类通用需求用）
     * ========================================================= */

    /* 在正文里定位一条标记，返回 {start, end} 或 null（定位不到）。
     * 优先用记录下来的偏移（正文没变过时最准）；偏移处的文字对不上（正文被重新
     * 生成 / 手动编辑过）就退回按原文查找——**只在全文中唯一出现时才认**，
     * 否则同一句出现多次会静默改错地方。 */
    locateMark: function (content, mark) {
      var s = String(content == null ? '' : content);
      var anchor = mark && mark.anchor != null ? String(mark.anchor) : '';
      if (!anchor) return null;
      var st = typeof mark.start === 'number' ? mark.start : -1;
      if (st >= 0 && s.slice(st, st + anchor.length) === anchor) {
        return { start: st, end: st + anchor.length };
      }
      var at = s.indexOf(anchor);
      if (at < 0) return null;
      if (s.indexOf(anchor, at + 1) >= 0) return null;   // 多处出现，不敢猜
      return { start: at, end: at + anchor.length };
    },

    /* 把正文按标记切成带高亮的片段（供阅读器渲染）。
     * 返回 [{ start, end, text, mark }]，相邻两段之间的 text 是未标记的普通文本。
     * 重叠的标记只保留靠前那条（后标记的 start 落在前一条里就跳过）。 */
    splitByMarks: function (content, marks) {
      var s = String(content == null ? '' : content);
      var list = [];
      (marks || []).forEach(function (m) {
        var pos = Util.locateMark(s, m);
        if (pos) list.push({ start: pos.start, end: pos.end, mark: m });
      });
      list.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
      var out = [], at = 0;
      list.forEach(function (x) {
        if (x.start < at) return;                    // 与前一条重叠，丢弃
        if (x.start > at) out.push({ start: at, end: x.start, text: s.slice(at, x.start), mark: null });
        out.push({ start: x.start, end: x.end, text: s.slice(x.start, x.end), mark: x.mark });
        at = x.end;
      });
      if (at < s.length) out.push({ start: at, end: s.length, text: s.slice(at), mark: null });
      return out;
    },

    /* 只把标记处替换成 AI 给的新文本，其余一字不动。
     * patches: [{ id, text }]。倒序替换 → 前面的偏移不被后面的长度变化影响。
     * 返回 { text, applied: [id], skipped: [id] }。 */
    applyPatches: function (content, marks, patches) {
      var s = String(content == null ? '' : content);
      var byId = {};
      (patches || []).forEach(function (p) { if (p && p.id) byId[p.id] = String(p.text == null ? '' : p.text); });
      var jobs = [], applied = [], skipped = [];
      (marks || []).forEach(function (m) {
        var pos = Util.locateMark(s, m);
        var nt = byId[m.id];
        /* 空白（含只有空格 / 换行）一律当「没给」：直接写回去等于把原文删了 */
        if (!pos || nt == null || !String(nt).trim()) { skipped.push(m.id); return; }
        jobs.push({ start: pos.start, end: pos.end, text: nt, id: m.id });
      });
      jobs.sort(function (a, b) { return b.start - a.start; });
      var out = s;
      jobs.forEach(function (j) {
        out = out.slice(0, j.start) + j.text + out.slice(j.end);
        applied.push(j.id);
      });
      return { text: out, applied: applied, skipped: skipped };
    }
  };

  global.Util = Util;
})(window);
