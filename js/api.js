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

  /* 读取 SSE 流，逐条回调 data 内容 */
  async function readSSE(res, onData, signal) {
    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    while (true) {
      if (signal && signal.aborted) { try { reader.cancel(); } catch (e) { } break; }
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t) continue;
        if (t.indexOf('data:') !== 0) continue;
        var d = t.slice(5).trim();
        if (!d) continue;
        if (d === '[DONE]') return;
        try { onData(JSON.parse(d)); } catch (e) { /* 忽略心跳/非 JSON 行 */ }
      }
    }
    // 处理残留
    if (buf.trim().indexOf('data:') === 0) {
      var d2 = buf.trim().slice(5).trim();
      if (d2 && d2 !== '[DONE]') { try { onData(JSON.parse(d2)); } catch (e) { } }
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

      var headers = { 'Content-Type': 'application/json' };
      if (p.apiKey) headers['Authorization'] = 'Bearer ' + p.apiKey;
      var extra = parseExtraHeaders(p.extraHeaders);
      Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });

      var useStream = opts.stream && typeof opts.onDelta === 'function';
      if (useStream) body.stream = true;

      var res = await fetch(url, {
        method: 'POST', headers: headers, body: JSON.stringify(body), signal: opts.signal
      });
      if (!res.ok) {
        var t = await res.text();
        // 端点不支持流式时自动降级
        if (useStream && res.status === 400 && /stream/i.test(t)) {
          delete body.stream;
          var r2 = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: opts.signal });
          if (!r2.ok) throw new Error(errText(r2.status, await r2.text()));
          var j2 = await r2.json();
          var txt2 = (j2.choices && j2.choices[0] && j2.choices[0].message && j2.choices[0].message.content) || '';
          if (opts.onDelta) opts.onDelta(txt2);
          return { text: txt2 };
        }
        throw new Error(errText(res.status, t));
      }

      if (!useStream) {
        var j = await res.json();
        var txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        if (opts.onDelta) opts.onDelta(txt);
        return { text: txt };
      }

      var full = '';
      await readSSE(res, function (d) {
        var delta = '';
        if (d.choices && d.choices[0]) {
          var c = d.choices[0];
          if (c.delta && typeof c.delta.content === 'string') delta = c.delta.content;
          else if (c.delta && c.delta.reasoning_content) delta = '';   // 思考内容不写入正文
        }
        if (delta) { full += delta; opts.onDelta(delta, full); }
      }, opts.signal);
      return { text: full };
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

      var res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: opts.signal });
      if (!res.ok) throw new Error(errText(res.status, await res.text()));

      if (!useStream) {
        var j = await res.json();
        var txt = '';
        if (j.content) {
          j.content.forEach(function (c) { if (c.type === 'text') txt += c.text; });
        }
        if (opts.onDelta) opts.onDelta(txt);
        return { text: txt };
      }

      var full = '';
      await readSSE(res, function (d) {
        if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') {
          full += d.delta.text;
          opts.onDelta(d.delta.text, full);
        }
      }, opts.signal);
      return { text: full };
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
      var headers = { 'Content-Type': 'application/json' };
      var extra = parseExtraHeaders(p.extraHeaders);
      Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });

      var res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: opts.signal });
      if (!res.ok) throw new Error(errText(res.status, await res.text()));

      if (!useStream) {
        var j = await res.json();
        var txt = '';
        if (j.candidates && j.candidates[0] && j.candidates[0].content) {
          (j.candidates[0].content.parts || []).forEach(function (pt) { txt += (pt.text || ''); });
        }
        if (opts.onDelta) opts.onDelta(txt);
        return { text: txt };
      }

      var full = '';
      await readSSE(res, function (d) {
        if (d.candidates && d.candidates[0] && d.candidates[0].content) {
          (d.candidates[0].content.parts || []).forEach(function (pt) {
            if (pt.text) { full += pt.text; opts.onDelta(pt.text, full); }
          });
        }
      }, opts.signal);
      return { text: full };
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
    }
  };

  global.API = API;
})(window);
