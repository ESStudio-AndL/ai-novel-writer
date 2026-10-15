/* =========================================================
 * API —— 多提供商适配层
 * 支持：openai(兼容 OpenAI 的一切) / anthropic / google / custom
 * ========================================================= */
(function (global) {
  'use strict';

  var PRESETS = {
    openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    moonshot: { name: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    siliconflow: { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct' },
    dashscope: { name: '阿里百炼(兼容模式)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    volcengine: { name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
    ollama: { name: 'Ollama(本地)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
    anthropic: { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-latest' },
    google: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' }
  };

  function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

  function parseExtraHeaders(str) {
    var out = {};
    if (!str) return out;
    var s = String(str).trim();
    if (!s) return out;
    if (s[0] === '{') {
      try { return JSON.parse(s); } catch (e) { /* 继续按行解析 */ }
    }
    s.split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) {
        var k = line.slice(0, i).trim();
        var v = line.slice(i + 1).trim();
        if (k) out[k] = v;
      }
    });
    return out;
  }

  /* 读取 SSE 流，逐条回调 data 内容
   * 要点：
   *  1) 按 \r\n | \r | \n 切分。只认 \n 的话，网关返回 \r\n 时行尾会残留 \r，
   *     JSON.parse 失败被静默吞掉 → 表现为正文丢字。
   *  2) 遇到 [DONE] 不能直接 return，缓冲区里可能还有未处理的行，要先读完。
   *  3) 无论正常结束、提前结束还是抛错，都要 releaseLock，否则流一直占着连接。
   */
  async function readSSE(res, onData, signal) {
    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    var done = false;

    function feed(chunk) {
      buf += chunk;
      // 统一换行；用交替切分保留「最后一段可能是半行」的语义
      var lines = buf.split(/\r\n|\r|\n/);
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (handleLine(lines[i])) return true;   // 收到 [DONE]
      }
      return false;
    }

    function handleLine(line) {
      var t = String(line).replace(/^\uFEFF/, '').trim();
      if (!t || t.charAt(0) === ':') return false;       // 空行 / SSE 注释心跳
      if (t.indexOf('data:') !== 0) return false;
      var d = t.slice(5).trim();
      if (!d) return false;
      if (d === '[DONE]') return true;
      try { onData(JSON.parse(d)); } catch (e) { /* 非 JSON 行忽略 */ }
      return false;
    }

    try {
      while (!done) {
        if (signal && signal.aborted) break;
        var r = await reader.read();
        if (r.done) break;
        if (feed(dec.decode(r.value, { stream: true }))) { done = true; break; }
      }
      if (!done) {
        // 冲刷解码器 + 处理没有换行结尾的残留行
        buf += dec.decode();
        for (var k = 0; k < buf.split(/\r\n|\r|\n/).length; k++) {
          if (handleLine(buf.split(/\r\n|\r|\n/)[k])) break;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (e) { }
      if (signal && signal.aborted) { try { res.body.cancel(); } catch (e) { } }
    }
  }

  function errText(status, body) {
    var msg = body || '';
    try {
      var j = JSON.parse(body);
      msg = (j.error && (j.error.message || j.error)) || j.message || j.msg || body;
      if (typeof msg === 'object') msg = JSON.stringify(msg);
    } catch (e) { }
    return 'HTTP ' + status + '：' + String(msg).slice(0, 300);
  }

  /* =========================================================
   * 用量（usage）归一化：三家返回结构不同，统一成
   * { promptTokens, completionTokens, cachedTokens }
   * OpenAI:  { prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens }
   * 流式时最后一个 chunk 带 usage（需 stream_options.include_usage）
   * Anthropic: { input_tokens, output_tokens }
   * Google: { promptTokenCount, candidatesTokenCount, cachedContentTokenCount }
   * ========================================================= */
  function num0(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return (isNaN(n) || n < 0) ? 0 : n;
  }
  function normUsage(u) {
    if (!u || typeof u !== 'object') return null;
    var pt = num0(u.prompt_tokens) || num0(u.input_tokens) || num0(u.promptTokenCount);
    var ct = num0(u.completion_tokens) || num0(u.output_tokens) || num0(u.candidatesTokenCount) || num0(u.total_output_tokens);
    var cache = num0(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || num0(u.cachedContentTokenCount);
    if (!pt && !ct) return null;
    return { promptTokens: pt, completionTokens: ct, cachedTokens: cache };
  }

  /* =========================================================
   * 请求记录：把最近几次实际发出的 API 请求留下来（环形缓冲，最多 3 条），
   * 供悬浮球里的「查看上次 AI 上下文」使用。密钥一律脱敏。
   * 生成正文 / 整理记忆 / 拆分大纲等会连续发多次请求，只留一条会被
   * 后一次（记忆）覆盖前一次（正文）的上下文，所以保留最近三条。
   * ========================================================= */
  var REQ_LOG_MAX = 3;
  var reqLog = [];

  function maskKey(v) {
    v = String(v || '');
    if (!v) return '';
    // 「Bearer xxx」只脱敏 xxx 部分，保留认证方式，便于阅读
    var m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(v);
    if (m) return m[1] + ' ' + maskKey(m[2]);
    if (v.length <= 8) return '******';
    return v.slice(0, 6) + '…******';
  }
  function maskUrl(u) {
    // Google 风格把 key 放在 query 里
    return String(u || '').replace(/([?&]key=)[^&]+/g, function (m, p1) { return p1 + maskKey(m.slice(p1.length)); });
  }
  function maskHeaders(h) {
    var out = {};
    Object.keys(h || {}).forEach(function (k) {
      var lk = k.toLowerCase();
      out[k] = (lk === 'authorization' || lk === 'x-api-key' || lk === 'api-key')
        ? maskKey(h[k]) : h[k];
    });
    return out;
  }
  function prettyBody(b) {
    try { return JSON.stringify(JSON.parse(b), null, 2); } catch (e) { return String(b || ''); }
  }
  function recordRequest(p, url, headers, body, kind) {
    var rec = {
      at: Date.now(),
      kind: kind || 'AI 请求',
      provider: (p && p.name) || '',
      model: (p && p.model) || '',
      url: maskUrl(url),
      headers: maskHeaders(headers),
      body: prettyBody(body)
    };
    reqLog.unshift(rec);
    if (reqLog.length > REQ_LOG_MAX) reqLog.length = REQ_LOG_MAX;
    return rec;   // 返回引用：请求完成后把 usage 回填进去
  }

  /* =========================================================
   * 拉取模型列表 / 查询余额
   * 三者端点格式不同，分别适配；失败时给出可操作的中文提示。
   * ========================================================= */
  async function fetchModels(provider) {
    var p = provider;
    if (!p) throw new Error('尚未配置 API 提供商');
    var type = p.type || 'openai';
    var base = trimSlash(p.baseUrl);
    var headers = { 'Content-Type': 'application/json' };
    if (p.apiKey) {
      if (type === 'anthropic') {
        headers['x-api-key'] = p.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = 'Bearer ' + p.apiKey;
      }
    }
    var extra = parseExtraHeaders(p.extraHeaders);
    Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });

    var url, parse;
    if (type === 'anthropic') {
      url = (/\/v1\/models$/.test(base) ? base : base + '/v1/models');
      parse = function (j) { return ((j.data || []).map(function (m) { return m.id; })).filter(Boolean); };
    } else if (type === 'google') {
      url = base + '/models?key=' + encodeURIComponent(p.apiKey || '') + '&pageSize=200';
      parse = function (j) {
        return ((j.models || []).map(function (m) {
          return String(m.name || '').replace(/^models\//, '');
        })).filter(Boolean);
      };
    } else {
      url = (/\/models$/.test(base) ? base : base + '/models');
      parse = function (j) { return ((j.data || j.models || []).map(function (m) { return m.id || m.name; })).filter(Boolean); };
    }

    var res = await doFetch(url, { method: 'GET', headers: headers, timeout: 30000 });
    if (!res.ok) throw new Error(errText(res.status, await res.text()));
    var j;
    try { j = await res.json(); } catch (e) { throw new Error('接口返回的不是合法 JSON，无法解析模型列表'); }
    var ids = parse(j);
    if (!ids.length) throw new Error('接口返回的模型列表为空');
    return ids.sort();
  }

  /* 余额查询：各提供商端点不统一，按域名匹配已知端点；
   * 提供商里填了 balanceUrl 时优先用它，并尝试解析常见字段。 */
  var BALANCE_ENDPOINTS = [
    { match: /deepseek\.com/i, path: '/user/balance', auth: 'bearer' },
    { match: /moonshot\.(cn|com)/i, path: '/v1/users/me/balance', auth: 'bearer' },
    { match: /siliconflow\.(cn|com)/i, path: '/v1/user/info', auth: 'bearer' },
    { match: /bigmodel\.cn/i, path: '', auth: '' },       // 智谱无公开余额接口
    { match: /api\.openai\.com/i, path: '', auth: '' },   // OpenAI 无公开余额接口
    { match: /aliyuncs\.com|dashscope/i, path: '', auth: '' },
    { match: /volces\.com/i, path: '', auth: '' }
  ];
  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  function pickBalance(j) {
    // 常见字段穷举：total_balance / available_balance / balance / totalBalance …
    var cands = [
      j && j.total_balance, j && j.totalBalance,
      j && j.available_balance, j && j.availableBalance,
      j && j.balance, j && j.data && j.data.total_balance,
      j && j.data && j.data.totalBalance, j && j.data && j.data.available_balance,
      j && j.data && j.data.balance, j && j.data && j.data.quota,
      j && j.data && j.data.total, j && j.granted && j.data
    ];
    for (var i = 0; i < cands.length; i++) {
      var n = num(cands[i]);
      if (n != null) return n;
    }
    // 形如 { balance_infos: [{ total_balance: "..." }] }（DeepSeek）
    var infos = j && j.balance_infos;
    if (Array.isArray(infos) && infos.length) {
      var sum = 0, got = false;
      infos.forEach(function (b2) {
        var n2 = num(b2 && (b2.total_balance || b2.totalBalance || b2.available_balance));
        if (n2 != null) { sum += n2; got = true; }
      });
      if (got) return sum;
    }
    return null;
  }
  async function fetchBalance(provider) {
    var p = provider;
    if (!p) throw new Error('尚未配置 API 提供商');
    var type = p.type || 'openai';
    var base = trimSlash(p.baseUrl);
    var headers = { 'Content-Type': 'application/json' };
    if (p.apiKey) headers['Authorization'] = 'Bearer ' + p.apiKey;
    var extra = parseExtraHeaders(p.extraHeaders);
    Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });

    var url = '';
    if (p.balanceUrl) {
      url = /^https?:\/\//i.test(p.balanceUrl) ? p.balanceUrl : base + '/' + String(p.balanceUrl).replace(/^\/+/, '');
    } else {
      for (var i = 0; i < BALANCE_ENDPOINTS.length; i++) {
        var ep = BALANCE_ENDPOINTS[i];
        if (ep.match.test(base)) {
          if (!ep.path) throw new Error('该提供商（' + base + '）没有公开的余额查询接口，请到对应官网后台查看');
          url = base + ep.path;
          break;
        }
      }
      if (!url) throw new Error('暂不支持查询该接口的余额。可在提供商设置里填写「余额查询地址」手动指定');
    }

    var res = await doFetch(url, { method: 'GET', headers: headers, timeout: 30000 });
    if (!res.ok) throw new Error(errText(res.status, await res.text()));
    var j;
    try { j = await res.json(); } catch (e) { throw new Error('接口返回的不是合法 JSON，无法解析余额'); }
    var n = pickBalance(j);
    if (n == null) throw new Error('已查到接口，但没能识别余额字段（返回：' + JSON.stringify(j).slice(0, 120) + '）');
    return { amount: n, raw: j };
  }

  /* 给一次请求套上超时。
   * 原来的实现没有超时：网关半死不活时 fetch 永不返回，界面就一直卡在 busy 上，
   * 用户只能强杀页面。这里默认 180s（长文生成需要时间），
   * 只有「首字节都收不到」才会超时，不影响正常流式输出。
   */
  var DEFAULT_TIMEOUT = 180000;
  function withTimeout(signal, ms) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, ms || DEFAULT_TIMEOUT);
    var onAbort = function () { clearTimeout(timer); ac.abort(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: ac.signal,
      timedOut: function () { return ac.signal.aborted && !(signal && signal.aborted); },
      done: function () {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    };
  }

  /* 统一发请求：接管超时与网络错误文案 */
  async function doFetch(url, init, signal) {
    var t = withTimeout(signal, init.timeout);
    var res;
    try {
      res = await fetch(url, {
        method: init.method, headers: init.headers, body: init.body, signal: t.signal
      });
    } catch (e) {
      t.done();
      if (e && e.name === 'AbortError') {
        if (t.timedOut()) throw new Error('请求超时（' + Math.round((init.timeout || DEFAULT_TIMEOUT) / 1000) + ' 秒无响应），请检查网络或代理设置');
        throw e;   // 用户主动中止，交给上层识别 AbortError
      }
      if (e && /Failed to fetch|NetworkError|load failed/i.test(e.message || '')) {
        throw new Error('无法连接到接口地址，请检查 Base URL、网络或代理设置');
      }
      throw e;
    }
    t.done();
    return res;
  }

  var API = {
    PRESETS: PRESETS,

    /* 统一聊天接口
     * opts: { provider, system, user, temperature, maxTokens, topP, stream, onDelta, signal }
     * 返回 { text }
     */
    chat: async function (opts) {
      var p = opts.provider;
      if (!p) throw new Error('尚未配置 API 提供商');
      if (!p.apiKey && p.type !== 'custom') throw new Error('未填写 API Key');
      var type = p.type || 'openai';
      opts.kind = opts.kind || 'AI 请求';
      if (type === 'anthropic') return this._anthropic(p, opts);
      if (type === 'google') return this._google(p, opts);
      return this._openaiLike(p, opts);
    },

    _openaiLike: async function (p, opts) {
      var base = trimSlash(p.baseUrl);
      var url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
      var messages = [];
      if (opts.system) messages.push({ role: 'system', content: opts.system });
      messages.push({ role: 'user', content: opts.user });

      var body = {
        model: p.model,
        messages: messages,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : (typeof p.temperature === 'number' ? p.temperature : 0.85),
        max_tokens: opts.maxTokens || p.maxTokens || 4096
      };
      if (p.topP && p.topP < 1) body.top_p = p.topP;
      if (opts.jsonMode) {
        body.response_format = { type: 'json_object' };
      }
      /* 关闭思考（模型方案里勾选后生效）：不同网关字段名不同，
       * 两份都带上；严格网关（如 OpenAI 官方）对未知参数会 400，
       * 下方有 400 兜底——剥掉这些参数重试一次。 */
      if (p.noThink) {
        body.enable_thinking = false;
        body.thinking = { type: 'disabled' };
      }

      var headers = { 'Content-Type': 'application/json' };
      if (p.apiKey) headers['Authorization'] = 'Bearer ' + p.apiKey;
      var extra = parseExtraHeaders(p.extraHeaders);
      Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });

      var useStream = opts.stream && typeof opts.onDelta === 'function';
      if (useStream) {
        body.stream = true;
        /* OpenAI 兼容流式要在最后一个 chunk 才吐 usage，必须显式开启 */
        body.stream_options = { include_usage: true };
      }

      var timeout = opts.timeout || (useStream ? 300000 : 120000);
      var rec = recordRequest(p, url, headers, JSON.stringify(body), opts.kind);
      var res = await doFetch(url, {
        method: 'POST', headers: headers, body: JSON.stringify(body), timeout: timeout
      }, opts.signal);

      /* 400 兜底：老网关不认 stream_options / 思考开关 / response_format 之类的新参数时
       * 逐步剥掉再重试，最多三次（流式 → 去掉 stream_options 的流式 → 非流式）。
       * 每次重试都重新记录请求，避免「看到的上行」与实际发送的不一致。
       *
       * ⚠ 错误正文只读一次：一个 Response 的 body 只能被消费一次，
       * 读过之后再 await res.text() 会抛 "Failed to execute 'text' on 'Response':
       * body stream already read"。原实现在循环里读过一次、跳出循环后又读第二次，
       * 只要网关是「对 enable_thinking 之类参数回 400」就会直接把这个内部错误
       * 抛给用户（表现是正文都生成完了却弹「生成失败」）。这里统一只读一次。
       *
       * 另：进了这个循环就必有未处理的问题（否则不会 400），所以剥参后一定要重试一次；
       * 只有「没有任何可剥的参数」时才认输，直接把错误报出去。 */
      var errBody = null;
      var retried = 0;
      while (!res.ok && res.status === 400 && retried < 3) {
        if (errBody == null) errBody = await res.text();
        var t = errBody;
        var stripStreamOpt = body.stream_options && /stream/i.test(t);
        var stripThink = (body.enable_thinking || body.thinking) && /think|argument|param|field|unknown|unrecognized|not supported/i.test(t);
        var stripStream = body.stream && /stream/i.test(t) && !stripStreamOpt && !stripThink;
        var changed = true;
        if (body.response_format && /response_format/i.test(t)) {
          delete body.response_format;
        } else if (stripStreamOpt) {
          delete body.stream_options;
        } else if (stripThink) {
          delete body.enable_thinking; delete body.thinking;
        } else if (stripStream) {
          delete body.stream; useStream = false;
        } else {
          changed = false;   // 没有可剥的参数了，报错出去
        }
        if (!changed) break;
        retried++;
        errBody = null;      // 下一次响应是新的 Response，得重新读
        rec = recordRequest(p, url, headers, JSON.stringify(body), opts.kind);
        res = await doFetch(url, {
          method: 'POST', headers: headers, body: JSON.stringify(body), timeout: timeout
        }, opts.signal);
      }

      if (!res.ok) {
        if (errBody == null) errBody = await res.text();
        throw new Error(errText(res.status, errBody));
      }

      if (!useStream) {
        var j = await res.json();
        var txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        var usage = normUsage(j.usage);
        if (usage) rec.usage = usage;
        if (opts.onDelta) opts.onDelta(txt, txt);
        return { text: txt, usage: usage };
      }

      var full = '';
      var usage2 = null;
      await readSSE(res, function (d) {
        if (d.usage) usage2 = normUsage(d.usage) || usage2;   // 末 chunk 带 usage
        var delta = '';
        if (d.choices && d.choices[0]) {
          var c = d.choices[0];
          if (c.delta && typeof c.delta.content === 'string') delta = c.delta.content;
          else if (c.delta && c.delta.reasoning_content) delta = '';   // 思考内容不写入正文
        }
        if (delta) { full += delta; opts.onDelta(delta, full); }
      }, opts.signal);
      if (usage2) rec.usage = usage2;
      return { text: full, usage: usage2 };
    },

    _anthropic: async function (p, opts) {
      var base = trimSlash(p.baseUrl) || 'https://api.anthropic.com';
      var url = /\/v1\/messages$/.test(base) ? base : base + '/v1/messages';
      var body = {
        model: p.model,
        max_tokens: opts.maxTokens || p.maxTokens || 4096,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : (typeof p.temperature === 'number' ? p.temperature : 0.85),
        messages: [{ role: 'user', content: opts.user }]
      };
      if (opts.system) body.system = opts.system;
      var headers = {
        'Content-Type': 'application/json',
        'x-api-key': p.apiKey || '',
        'anthropic-version': '2023-06-01'
      };
      var extra = parseExtraHeaders(p.extraHeaders);
      Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });

      var useStream = opts.stream && typeof opts.onDelta === 'function';
      if (useStream) body.stream = true;

      var timeout = opts.timeout || (useStream ? 300000 : 120000);
      var rec = recordRequest(p, url, headers, JSON.stringify(body), opts.kind);
      var res = await doFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), timeout: timeout }, opts.signal);
      if (!res.ok) throw new Error(errText(res.status, await res.text()));

      if (!useStream) {
        var j = await res.json();
        var txt = '';
        if (j.content) {
          j.content.forEach(function (c) { if (c.type === 'text') txt += c.text; });
        }
        var usage = normUsage(j.usage);
        if (usage) rec.usage = usage;
        if (opts.onDelta) opts.onDelta(txt, txt);
        return { text: txt, usage: usage };
      }

      var full = '';
      var usage2 = null;
      await readSSE(res, function (d) {
        /* usage 分布在两类事件里：message_start 带输入 token（嵌在 d.message.usage 里），
         * message_delta 带输出 token（在 d.usage 顶层）。两处都要接，否则输入 token 会漏记。 */
        var rawU = (d && d.usage) || (d && d.message && d.message.usage) || null;
        if (rawU) {
          var u = normUsage(rawU);
          if (u) {
            usage2 = usage2 || { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
            if (u.promptTokens) usage2.promptTokens = u.promptTokens;
            if (u.completionTokens) usage2.completionTokens = u.completionTokens;
            if (u.cachedTokens) usage2.cachedTokens = u.cachedTokens;
          }
        }
        if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') {
          full += d.delta.text;
          opts.onDelta(d.delta.text, full);
        }
      }, opts.signal);
      if (usage2) rec.usage = usage2;
      return { text: full, usage: usage2 };
    },

    _google: async function (p, opts) {
      var base = trimSlash(p.baseUrl) || 'https://generativelanguage.googleapis.com/v1beta';
      var model = p.model || 'gemini-2.0-flash';
      var key = encodeURIComponent(p.apiKey || '');
      var useStream = opts.stream && typeof opts.onDelta === 'function';
      var url = base + '/models/' + encodeURIComponent(model) +
        (useStream ? ':streamGenerateContent?alt=sse&key=' : ':generateContent?key=') + key;

      var body = {
        contents: [{ role: 'user', parts: [{ text: opts.user || ' ' }] }],
        generationConfig: {
          temperature: typeof opts.temperature === 'number' ? opts.temperature : (typeof p.temperature === 'number' ? p.temperature : 0.85),
          maxOutputTokens: opts.maxTokens || p.maxTokens || 4096
        }
      };
      if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
      /* Gemini 2.5 系列默认思考且思考 token 按输出计费；方案里勾了「关闭思考」就显式置 0。
       * 老模型不认识 thinkingConfig 会 400，这里做一次剥参重试。 */
      if (p.noThink) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
      var headers = { 'Content-Type': 'application/json' };
      var extra = parseExtraHeaders(p.extraHeaders);
      Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });

      var timeout = opts.timeout || (useStream ? 300000 : 120000);
      var rec = recordRequest(p, url, headers, JSON.stringify(body), opts.kind);
      var res = await doFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), timeout: timeout }, opts.signal);
      if (!res.ok && res.status === 400 && p.noThink) {
        var t0 = await res.text();
        if (/thinking|budget|unknown|invalid|argument/i.test(t0)) {
          delete body.generationConfig.thinkingConfig;
          rec = recordRequest(p, url, headers, JSON.stringify(body), opts.kind);
          res = await doFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), timeout: timeout }, opts.signal);
        }
      }
      if (!res.ok) throw new Error(errText(res.status, await res.text()));

      if (!useStream) {
        var j = await res.json();
        var txt = '';
        if (j.candidates && j.candidates[0] && j.candidates[0].content) {
          (j.candidates[0].content.parts || []).forEach(function (pt) { txt += (pt.text || ''); });
        }
        var usage = normUsage(j.usageMetadata);
        if (usage) rec.usage = usage;
        if (opts.onDelta) opts.onDelta(txt, txt);
        return { text: txt, usage: usage };
      }

      var full = '';
      var usage2 = null;
      await readSSE(res, function (d) {
        if (d.usageMetadata) usage2 = normUsage(d.usageMetadata) || usage2;
        if (d.candidates && d.candidates[0] && d.candidates[0].content) {
          (d.candidates[0].content.parts || []).forEach(function (pt) {
            if (pt.text) { full += pt.text; opts.onDelta(pt.text, full); }
          });
        }
      }, opts.signal);
      if (usage2) rec.usage = usage2;
      return { text: full, usage: usage2 };
    },

    /* 连通性测试 */
    test: async function (provider) {
      return await this.chat({
        provider: provider,
        system: '你是一个连通性测试助手。',
        user: '请只回复两个字：正常',
        maxTokens: 16,
        temperature: 0.1,
        stream: false
      });
    },

    /* 拉取该提供商的模型列表，返回模型 id 数组 */
    fetchModels: fetchModels,
    /* 查询余额，返回 { amount, raw }；不支持时抛错（中文说明） */
    fetchBalance: fetchBalance,
    /* 上一次实际发出的请求（密钥已脱敏），无则 null */
    lastRequest: function () { return reqLog[0] || null; },
    requestLog: function () { return reqLog.slice(); }
  };

  global.API = API;
})(window);
