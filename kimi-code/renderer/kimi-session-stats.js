/* Kimi Code — session stats bar
 *
 * Draws two pills (turns/steps/speed + tokens/cache) and a context ring in the
 * whitespace below the chat composer, mirroring the DeepSeek Harness stats row.
 *
 * Data comes from the app's own WebSocket event stream: this script wraps
 * window.WebSocket and reads the frames the renderer already receives. No
 * daemon, no extra port, no filesystem access.
 *
 * Injected by install.sh as <script src="/kimi-session-stats.js"> in
 * Kimi Code.app/Contents/Resources/desktop-dist/index.html.
 */
(function () {
  'use strict';

  var MAIN_AGENT = 'main';

  // ============================================================== core (pure)
  // Everything in this section is DOM-free so it can be unit tested in Node.

  // Canonical field -> wire aliases, in the order the app's own normalizer
  // tries them (agent events use camelCase, provider payloads snake_case).
  var USAGE_FIELDS = [
    { key: 'inputOther', aliases: ['inputOther', 'input_tokens', 'prompt_tokens'] },
    { key: 'output', aliases: ['output', 'output_tokens', 'completion_tokens'] },
    { key: 'cacheRead', aliases: ['inputCacheRead', 'cache_read_input_tokens', 'cache_read', 'cached_tokens'] },
    { key: 'cacheCreate', aliases: ['inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation'] }
  ];
  var TIMING_KEYS = [
    'llmFirstTokenLatencyMs',
    'llmStreamDurationMs',
    'llmRequestBuildMs',
    'llmServerFirstTokenMs',
    'llmServerDecodeMs',
    'llmClientConsumeMs',
    'llmClientBlockedMs'
  ];

  function nonNeg(v) {
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
  }

  function blankUsage() {
    return { inputOther: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  }

  // Wire usage -> canonical shape. Accepts camelCase (agent events) and
  // snake_case (provider payloads).
  function normalizeUsage(raw) {
    var out = blankUsage();
    if (!raw || typeof raw !== 'object') return out;
    for (var i = 0; i < USAGE_FIELDS.length; i++) {
      var field = USAGE_FIELDS[i];
      for (var j = 0; j < field.aliases.length; j++) {
        var v = raw[field.aliases[j]];
        if (typeof v === 'number') {
          out[field.key] = nonNeg(v);
          break;
        }
      }
    }
    return out;
  }

  function addUsage(into, u) {
    into.inputOther += u.inputOther;
    into.output += u.output;
    into.cacheRead += u.cacheRead;
    into.cacheCreate += u.cacheCreate;
    return into;
  }

  function usageOf(u) {
    return u.inputOther + u.output + u.cacheRead + u.cacheCreate;
  }

  function pickTiming(src) {
    if (!src || typeof src !== 'object') return null;
    var out = null;
    for (var i = 0; i < TIMING_KEYS.length; i++) {
      var k = TIMING_KEYS[i];
      if (typeof src[k] === 'number') {
        if (out === null) out = {};
        out[k] = src[k];
      }
    }
    return out;
  }

  function createStore() {
    return { sessions: new Map(), seenFrames: 0 };
  }

  function newSession(id) {
    return {
      id: id,
      // stepId -> { usage, timing, turnId, agentId }. Upserts make every
      // channel idempotent, so a step is never counted twice.
      steps: new Map(),
      turns: new Set(),
      // agentId -> cumulative usage as reported by the server (authoritative)
      auth: new Map(),
      model: '',
      contextTokens: 0,
      contextMax: 0,
      running: false,
      phase: '',
      updatedAt: 0
    };
  }

  function sessionOf(store, id) {
    var s = store.sessions.get(id);
    if (!s) {
      s = newSession(id);
      store.sessions.set(id, s);
    }
    return s;
  }

  function upsertStep(s, stepId, entry) {
    if (!stepId || !entry.usage) return;
    var prev = s.steps.get(stepId);
    if (prev) {
      prev.usage = entry.usage;
      if (entry.timing) prev.timing = entry.timing;
      if (entry.agentId) prev.agentId = entry.agentId;
      if (typeof entry.turnId !== 'undefined') prev.turnId = entry.turnId;
    } else {
      s.steps.set(stepId, entry);
    }
  }

  function sessionIdOf(frame) {
    if (typeof frame.session_id === 'string' && frame.session_id) return frame.session_id;
    var p = frame.payload;
    if (p) {
      if (typeof p.sessionId === 'string' && p.sessionId) return p.sessionId;
      // event.session.created carries the whole session object instead
      if (p.session && typeof p.session.id === 'string' && p.session.id) return p.session.id;
    }
    if (typeof frame.sessionId === 'string' && frame.sessionId) return frame.sessionId;
    return null;
  }

  function agentIdOf(frame) {
    var p = frame.payload;
    var id = p && typeof p.agentId === 'string' ? p.agentId : null;
    return id || MAIN_AGENT;
  }

  // Rebuild the step/turn tables from a transcript snapshot. The server sends
  // transcript.reset with the full step history when a session is (re)opened.
  function applySnapshot(s, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false;
    s.steps.clear();
    s.turns.clear();
    for (var i = 0; i < snapshot.items.length; i++) {
      var item = snapshot.items[i];
      if (!item || item.kind !== 'turn') continue;
      if (typeof item.turnId !== 'undefined') s.turns.add(item.turnId);
      var steps = Array.isArray(item.steps) ? item.steps : [];
      for (var j = 0; j < steps.length; j++) {
        var st = steps[j];
        if (!st || !st.usage) continue;
        s.steps.set(st.stepId || item.turnId + ':' + j, {
          usage: normalizeUsage(st.usage),
          timing: pickTiming(st.timing),
          turnId: item.turnId,
          agentId: MAIN_AGENT
        });
      }
    }
    return true;
  }

  function applyOps(s, ops) {
    if (!Array.isArray(ops)) return false;
    var touched = false;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'reset') {
        applySnapshot(s, op.snapshot);
        touched = true;
      } else if (op.op === 'turn.upsert') {
        if (op.turn && typeof op.turn.turnId !== 'undefined') s.turns.add(op.turn.turnId);
        touched = true;
      } else if (op.op === 'step.upsert' && op.step) {
        var st = op.step;
        if (typeof op.turnId !== 'undefined') s.turns.add(op.turnId);
        if (st.usage) {
          upsertStep(s, st.stepId || op.turnId + ':' + st.ordinal, {
            usage: normalizeUsage(st.usage),
            timing: pickTiming(st.timing),
            turnId: typeof op.turnId !== 'undefined' ? op.turnId : st.turnId,
            agentId: MAIN_AGENT
          });
        }
        touched = true;
      }
    }
    return touched;
  }

  // Returns true when the frame carried something we display.
  function applyFrame(store, frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return false;
    var sessionId = sessionIdOf(frame);
    if (!sessionId) return false;
    var s = sessionOf(store, sessionId);
    var p = frame.payload || {};
    var agentId = agentIdOf(frame);
    var touched = false;

    switch (frame.type) {
      case 'turn.step.completed':
        s.turns.add(p.turnId);
        upsertStep(s, p.stepId || p.turnId + ':' + p.step, {
          usage: normalizeUsage(p.usage),
          timing: pickTiming(p),
          turnId: p.turnId,
          agentId: agentId
        });
        touched = true;
        break;

      case 'turn.step.started':
      case 'turn.started':
        s.turns.add(p.turnId);
        s.running = true;
        touched = true;
        break;

      case 'turn.ended':
      case 'prompt.completed':
      case 'prompt.aborted':
        s.running = false;
        touched = true;
        break;

      case 'transcript.reset':
        if (applySnapshot(s, p.snapshot)) touched = true;
        break;

      case 'transcript.ops':
        if (applyOps(s, p.ops)) touched = true;
        break;

      case 'event.session.work_changed': {
        // The server's own busy flag: the most direct "still working" signal
        // (turn.started/turn.ended only bracket the LLM work, not tool runs).
        if (typeof p.busy === 'boolean') s.running = p.busy || p.main_turn_active === true;
        touched = true;
        break;
      }

      case 'subagent.spawned': {
        // On this wire only subagent frames carry a model id; it is the model
        // the session actually runs on.
        if (typeof p.model === 'string' && p.model) s.model = p.model;
        touched = true;
        break;
      }

      case 'event.session.created': {
        var sessionUsage = p.session && p.session.usage;
        if (sessionUsage && typeof sessionUsage === 'object') {
          if (typeof sessionUsage.context_tokens === 'number' && sessionUsage.context_tokens > 0) {
            s.contextTokens = sessionUsage.context_tokens;
          }
          if (typeof sessionUsage.context_limit === 'number' && sessionUsage.context_limit > 0) {
            s.contextMax = sessionUsage.context_limit;
          }
        }
        touched = true;
        break;
      }

      case 'agent.status.updated': {
        if (typeof p.model === 'string' && p.model) s.model = p.model;
        if (typeof p.contextTokens === 'number') s.contextTokens = nonNeg(p.contextTokens);
        if (typeof p.maxContextTokens === 'number' && p.maxContextTokens > 0) {
          s.contextMax = p.maxContextTokens;
        }
        var total = p.usage && p.usage.total;
        if (total) {
          var normalized = normalizeUsage(total);
          var known = s.auth.get(agentId) || blankUsage();
          // Server-side cumulative totals are authoritative but can lag behind
          // this session's own accumulation; never let them walk backwards.
          var merged = blankUsage();
          for (var k in merged) merged[k] = Math.max(known[k], normalized[k]);
          s.auth.set(agentId, merged);
        }
        if (p.phase && typeof p.phase.kind === 'string' && p.phase.kind) {
          s.phase = p.phase.kind;
          s.running = s.phase === 'running' || s.phase === 'tool_call' || s.phase === 'retrying';
        }
        touched = true;
        break;
      }

      default:
        break;
    }

    if (touched) s.updatedAt = Date.now();
    store.seenFrames++;
    return touched;
  }

  // Collapse a session into the numbers the bar shows.
  function derive(s) {
    var out = {
      turns: 0,
      steps: 0,
      total: 0,
      output: 0,
      inputOther: 0,
      cacheRead: 0,
      cacheCreate: 0,
      cacheHit: 0,
      outputSpeed: 0,
      ttftAvg: 0,
      contextTokens: 0,
      contextMax: 0,
      contextPct: 0,
      hasContext: false,
      model: '',
      running: false,
      source: 'none'
    };
    if (!s) return out;

    var usage = blankUsage();
    var steps = 0;
    var streamMs = 0;
    var ttftMs = 0;
    var ttftCount = 0;
    var sawMain = false;
    var fallbackAuth = null;

    s.steps.forEach(function (entry) {
      if (entry.agentId === MAIN_AGENT) sawMain = true;
    });

    var lastPromptTokens = 0;
    s.steps.forEach(function (entry) {
      if (sawMain && entry.agentId !== MAIN_AGENT) return;
      addUsage(usage, entry.usage);
      steps++;
      // The prompt a step reports is the context size at that moment, so the
      // most recent step is the closest thing to current context occupancy —
      // the wire has no explicit "context used" field of its own.
      var prompt = entry.usage.inputOther + entry.usage.cacheRead + entry.usage.cacheCreate;
      if (prompt > 0) lastPromptTokens = prompt;
      if (entry.timing) {
        if (typeof entry.timing.llmStreamDurationMs === 'number') streamMs += entry.timing.llmStreamDurationMs;
        if (typeof entry.timing.llmFirstTokenLatencyMs === 'number') {
          ttftMs += entry.timing.llmFirstTokenLatencyMs;
          ttftCount++;
        }
      }
    });

    var auth = s.auth.get(MAIN_AGENT) || null;
    if (!auth) {
      s.auth.forEach(function (v) {
        if (fallbackAuth === null) fallbackAuth = v;
      });
      auth = sawMain ? null : fallbackAuth;
    }
    if (auth && usageOf(auth) > usageOf(usage)) {
      // Authoritative totals also cover history the transcript window has
      // trimmed, so prefer them whenever they exceed our own sum.
      usage = {
        inputOther: auth.inputOther,
        output: auth.output,
        cacheRead: auth.cacheRead,
        cacheCreate: auth.cacheCreate
      };
      out.source = 'server';
    } else if (steps > 0) {
      out.source = 'stream';
    }

    out.turns = s.turns.size;
    out.steps = steps;
    out.inputOther = usage.inputOther;
    out.output = usage.output;
    out.cacheRead = usage.cacheRead;
    out.cacheCreate = usage.cacheCreate;
    // Total excludes cache reads (the same definition the ZCode pills use);
    // the popover breaks every bucket out separately.
    out.total = usage.inputOther + usage.cacheCreate + usage.output;
    var promptTokens = usage.inputOther + usage.cacheRead + usage.cacheCreate;
    out.cacheHit = promptTokens > 0 ? usage.cacheRead / promptTokens : 0;
    out.outputSpeed = streamMs > 0 ? usage.output / (streamMs / 1000) : 0;
    out.ttftAvg = ttftCount > 0 ? ttftMs / ttftCount : 0;
    out.contextTokens = s.contextTokens > 0 ? s.contextTokens : lastPromptTokens;
    out.contextMax = s.contextMax;
    out.hasContext = s.contextMax > 0;
    out.contextPct = out.hasContext
      ? Math.min(100, Math.max(0, Math.round((s.contextTokens / s.contextMax) * 100)))
      : 0;
    out.model = s.model;
    out.running = s.running;
    return out;
  }

  function trim(v) {
    var s = v >= 100 ? v.toFixed(0) : v.toFixed(2);
    return s.indexOf('.') === -1 ? s : s.replace(/\.?0+$/, '');
  }

  function formatTokens(n) {
    if (!isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) return trim(n / 1000) + 'k';
    if (n < 1000000000) return trim(n / 1000000) + 'M';
    return trim(n / 1000000000) + 'B';
  }

  function formatPct(ratio) {
    var pct = ratio * 100;
    if (pct >= 99.5) return '100%';
    if (pct >= 10) return Math.round(pct) + '%';
    return (Math.round(pct * 10) / 10) + '%';
  }

  var CORE = {
    createStore: createStore,
    applyFrame: applyFrame,
    derive: derive,
    formatTokens: formatTokens,
    formatPct: formatPct,
    normalizeUsage: normalizeUsage,
    MAIN_AGENT: MAIN_AGENT
  };

  if (typeof module === 'object' && module.exports) module.exports = CORE;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.__KIMI_SESSION_STATS_CORE__ = CORE;

  // ========================================================== browser: state

  var WS_MARK = '/api/v1/ws';
  var BAR_ID = 'kimi-session-stats';
  var MAX_AGE_MS = 6 * 60 * 60 * 1000;
  var store = createStore();

  function activeSessionId() {
    // The renderer is a plain pathname router: /sessions/<id>; "/" is a draft.
    var m = /\/sessions\/([^/?#]+)/.exec(location.pathname || '/');
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  function activeSession() {
    var id = activeSessionId();
    if (!id) return null;
    var s = store.sessions.get(id);
    if (!s || Date.now() - s.updatedAt > MAX_AGE_MS) return null;
    return s;
  }

  // ====================================================== browser: transport

  // Sniff the frames the app already receives rather than opening our own
  // connection: no auth handling, no second subscriber, no replay bookkeeping.
  //
  // The wrapper is a Proxy over the real constructor so every static
  // (CONNECTING/OPEN/…), the prototype and `instanceof` keep working: the app
  // cannot tell the difference, and only `new` is intercepted.
  var wsHooked = false;

  function hookWebSocket() {
    var Native = window.WebSocket;
    if (!Native || wsHooked) return;
    wsHooked = true;

    var proxy;
    try {
      proxy = new Proxy(Native, {
        construct: function (target, args) {
          var ws = Reflect.construct(target, args);
          try {
            if (String(args[0]).indexOf(WS_MARK) !== -1) observe(ws);
          } catch (e) {
            /* never break the app's own socket */
          }
          return ws;
        }
      });
    } catch (e) {
      return; // no Proxy support: leave the app's socket alone
    }

    try {
      window.WebSocket = proxy;
    } catch (e) {
      /* ignore */
    }
  }

  function observe(ws) {
    if (!ws || typeof ws.addEventListener !== 'function') return;
    ws.addEventListener('message', function (ev) {
      var frame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch (e) {
        return;
      }
      if (applyFrame(store, frame)) scheduleRender();
    });
  }

  // ============================================================== browser: ui

  var LANG = String((navigator.languages && navigator.languages[0]) || navigator.language || 'en')
    .toLowerCase()
    .indexOf('zh') === 0
    ? 'zh'
    : 'en';

  var T = {
    zh: {
      turns: '轮',
      steps: '步',
      tokens: 'tok',
      cacheHit: '缓存命中',
      waiting: '会话统计 · 等待数据…',
      popTitle: 'Token 用量',
      running: '进行中',
      idle: '空闲',
      dTotal: '总量',
      dInput: '未缓存输入',
      dCacheRead: '缓存读取',
      dCacheWrite: '缓存写入',
      dOutput: '输出',
      dCacheHit: '缓存命中',
      dSpeed: '输出速度',
      dTtft: '首 token 平均',
      dContext: '上下文',
      dTurns: '轮数',
      dSteps: '步数',
      dModel: '模型',
      dSource: '数据来源',
      srcServer: '服务端累计',
      srcStream: '事件流累计',
      srcNone: '暂无',
      tipGauge: '本会话的轮次、步数与输出速度',
      tipTokens: '累计 token 用量与缓存命中率',
      tipContext: '上下文占用'
    },
    en: {
      turns: 'turns',
      steps: 'steps',
      tokens: 'tok',
      cacheHit: 'cache hit',
      waiting: 'session stats · waiting for data…',
      popTitle: 'Token usage',
      running: 'running',
      idle: 'idle',
      dTotal: 'Total',
      dInput: 'Uncached input',
      dCacheRead: 'Cache read',
      dCacheWrite: 'Cache write',
      dOutput: 'Output',
      dCacheHit: 'Cache hit',
      dSpeed: 'Output speed',
      dTtft: 'First token avg',
      dContext: 'Context',
      dTurns: 'Turns',
      dSteps: 'Steps',
      dModel: 'Model',
      dSource: 'Source',
      srcServer: 'server totals',
      srcStream: 'event stream',
      srcNone: 'none',
      tipGauge: 'Turns, steps and output speed of this session',
      tipTokens: 'Cumulative token usage and cache hit rate',
      tipContext: 'Context occupancy'
    }
  }[LANG];

  var CSS = [
    '.ks-bar{display:flex;align-items:center;gap:6px;position:relative;z-index:2;',
    'margin:2px 0 0 2px;padding:0;user-select:none;',
    'font-family:var(--font-ui,system-ui);font-size:var(--ui-font-size-xs,12px);',
    'line-height:var(--leading-caption,1.4);color:var(--color-text-muted,rgba(0,0,0,.6))}',
    '.ks-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:0;',
    'border-radius:var(--radius-dock-pill,10px);background:var(--color-hover,rgba(0,0,0,.03));',
    'color:inherit;font:inherit;cursor:pointer;white-space:nowrap}',
    '.ks-pill:hover{background:var(--color-selected,rgba(0,0,0,.06))}',
    '.ks-dot{width:6px;height:6px;border-radius:50%;background:var(--color-text-quaternary,rgba(0,0,0,.3));flex:none}',
    '.ks-gauge.ks-running .ks-dot{background:var(--color-success,#0e7a38);animation:ks-breathe 1.6s ease-in-out infinite}',
    '@keyframes ks-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}',
    '.ks-ring{display:inline-flex;align-items:center;gap:4px;padding:2px 7px 2px 3px;border:0;background:transparent;',
    'color:inherit;font:inherit;cursor:pointer;border-radius:var(--radius-full,999px)}',
    '.ks-ring:hover{background:var(--color-hover,rgba(0,0,0,.03))}',
    '.ks-ring svg{width:14px;height:14px;flex:none;transform:rotate(-90deg)}',
    '.ks-ring-track{stroke:var(--line,rgba(0,0,0,.13))}',
    '.ks-ring-fill{stroke:var(--color-accent,#1783ff);transition:stroke-dashoffset .3s ease}',
    '.ks-pop{position:fixed;z-index:300;min-width:250px;padding:10px 12px;border-radius:12px;',
    'border:1px solid var(--color-line,rgba(0,0,0,.13));background:var(--color-menu-bg,rgba(255,255,255,.95));',
    'backdrop-filter:var(--p-menu-backdrop,blur(24px) saturate(1.8));',
    'box-shadow:0 10px 28px -8px rgba(0,0,0,.28);color:var(--color-text,rgba(0,0,0,.9));',
    'font-family:var(--font-ui,system-ui);font-size:var(--ui-font-size-xs,12px)}',
    '.ks-pop-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;',
    'color:var(--color-text,rgba(0,0,0,.9));font-weight:var(--weight-medium,500)}',
    '.ks-pop-state{display:inline-flex;align-items:center;gap:4px;color:var(--muted,rgba(0,0,0,.45));font-weight:400}',
    '.ks-pop-state.ks-live::before{content:"";width:6px;height:6px;border-radius:50%;',
    'background:var(--color-success,#0e7a38);animation:ks-breathe 1.6s ease-in-out infinite}',
    '.ks-pop-list{display:grid;grid-template-columns:auto auto;gap:4px 16px;margin:0}',
    '.ks-pop-list dt{color:var(--muted,rgba(0,0,0,.45))}',
    '.ks-pop-list dd{margin:0;text-align:right;font-family:var(--mono,ui-monospace,monospace);',
    'color:var(--color-text,rgba(0,0,0,.9))}'
  ].join('');

  var barEl = null;
  var hostEl = null;
  var popEl = null;
  var popAnchor = null;
  var renderQueued = false;
  var lastMetrics = null;
  var lastPopSig = null;

  function injectStyles() {
    if (document.getElementById(BAR_ID + '-style')) return;
    var style = document.createElement('style');
    style.id = BAR_ID + '-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // Every write below goes through one of these: assigning the value a node
  // already has still counts as a DOM mutation, and the body observer would
  // see it. Comparing first keeps our own rendering invisible to the observer.
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setDisplay(el, shown) {
    var want = shown ? '' : 'none';
    if (el && el.style.display !== want) el.style.display = want;
  }

  function setAttr(el, name, value) {
    if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function visible(el) {
    return !!el && el.offsetParent !== null && el.getClientRects().length > 0;
  }

  // The composer is mounted in several places (chat dock, empty state, panel
  // teleport, side chat) — always pick the visible one, never the side chat.
  function findComposer() {
    var nodes = document.querySelectorAll('.composer');
    var empty = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      if (el.closest && el.closest('.sc-composer')) continue;
      if (el.classList && el.classList.contains('empty-composer')) {
        if (!empty) empty = el;
        continue;
      }
      return el;
    }
    return empty;
  }

  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function buildBar() {
    var bar = node('div', 'ks-bar');
    bar.id = BAR_ID;

    var gauge = node('button', 'ks-pill ks-gauge');
    gauge.type = 'button';
    gauge.title = T.tipGauge;
    gauge.appendChild(node('i', 'ks-dot'));
    gauge.appendChild(node('span', 'ks-gauge-text'));

    var tokens = node('button', 'ks-pill ks-tokens');
    tokens.type = 'button';
    tokens.title = T.tipTokens;
    tokens.appendChild(node('span', 'ks-tokens-text'));

    var ring = node('button', 'ks-ring');
    ring.type = 'button';
    ring.title = T.tipContext;
    ring.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true">' +
      '<circle class="ks-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.5"/>' +
      '<circle class="ks-ring-fill" cx="10" cy="10" r="7" fill="none" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg>';
    ring.appendChild(node('span', 'ks-ring-label'));

    bar.appendChild(gauge);
    bar.appendChild(tokens);
    bar.appendChild(ring);

    [[gauge, 'gauge'], [tokens, 'tokens'], [ring, 'ring']].forEach(function (pair) {
      pair[0].addEventListener('click', function (e) {
        e.stopPropagation();
        togglePop(pair[0]);
      });
    });

    return bar;
  }

  // Mount (or move) the bar under the visible composer and report whether it
  // really attached. Idempotent by design: the body observer below runs on
  // every mutation of our own writes, so a mount that re-appended the bar each
  // time would re-enter itself through the observer without end — the renderer
  // freezes and the app goes blank.
  function mount() {
    var host = findComposer();
    if (!host) {
      if (barEl && barEl.parentElement) barEl.parentElement.removeChild(barEl);
      hostEl = null;
      return false;
    }
    if (barEl && barEl.parentElement === host && document.contains(barEl)) {
      hostEl = host;
      return false;
    }
    if (barEl && barEl.parentElement) barEl.parentElement.removeChild(barEl);
    if (!barEl) {
      injectStyles();
      barEl = buildBar();
    }
    host.appendChild(barEl);
    hostEl = host;
    return true;
  }

  function unmount() {
    closePop();
    if (barEl && barEl.parentElement) barEl.parentElement.removeChild(barEl);
    barEl = null;
    hostEl = null;
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    var run = function () {
      renderQueued = false;
      render();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function render() {
    if (!barEl || !document.contains(barEl)) {
      if (!mount()) return;
    }
    if (!visible(barEl)) return;

    var m = derive(activeSession());
    lastMetrics = m;

    var gauge = barEl.querySelector('.ks-gauge');
    var tokens = barEl.querySelector('.ks-tokens');
    var ring = barEl.querySelector('.ks-ring');
    if (!gauge || !tokens || !ring) return;

    gauge.classList.toggle('ks-running', !!m.running);

    if (m.steps === 0 && m.turns === 0 && m.total === 0) {
      setText(gauge.querySelector('.ks-gauge-text'), T.waiting);
      setDisplay(tokens, false);
      setDisplay(ring, false);
      if (popEl) fillPop(popEl, m);
      return;
    }

    setDisplay(tokens, true);
    setText(
      gauge.querySelector('.ks-gauge-text'),
      compact([
        m.turns + ' ' + T.turns,
        m.steps + ' ' + T.steps,
        m.outputSpeed > 0 ? trim(m.outputSpeed) + ' tok/s' : null
      ])
    );

    setText(
      tokens.querySelector('.ks-tokens-text'),
      compact([formatTokens(m.total) + ' ' + T.tokens, m.cacheRead > 0 ? T.cacheHit + ' ' + formatPct(m.cacheHit) : null])
    );

    if (m.hasContext) {
      setDisplay(ring, true);
      var circumference = 2 * Math.PI * 7;
      var fill = ring.querySelector('.ks-ring-fill');
      setAttr(fill, 'stroke-dasharray', String(circumference));
      setAttr(fill, 'stroke-dashoffset', String(circumference * (1 - m.contextPct / 100)));
      setText(ring.querySelector('.ks-ring-label'), m.contextPct + '%');
    } else {
      setDisplay(ring, false);
    }

    if (popEl) fillPop(popEl, m);
  }

  function compact(parts) {
    return parts
      .filter(function (p) {
        return !!p;
      })
      .join(' · ');
  }

  // ---------------------------------------------------------------- popover

  function closePop() {
    if (popEl && popEl.parentElement) popEl.parentElement.removeChild(popEl);
    popEl = null;
    popAnchor = null;
    lastPopSig = null;
  }

  function togglePop(anchor) {
    if (popEl) {
      closePop();
      return;
    }
    popEl = node('div', 'ks-pop');
    popEl.id = BAR_ID + '-pop';
    popEl.setAttribute('role', 'dialog');
    popEl.innerHTML =
      '<div class="ks-pop-head"><span class="ks-pop-title"></span>' +
      '<span class="ks-pop-state"></span></div><dl class="ks-pop-list"></dl>';
    document.body.appendChild(popEl);
    popAnchor = anchor;
    fillPop(popEl, lastMetrics || derive(activeSession()));
    positionPop(anchor);
  }

  function positionPop(anchor) {
    if (!popEl) return;
    var a = anchor.getBoundingClientRect();
    var p = popEl.getBoundingClientRect();
    var left = Math.max(8, Math.min(a.left, window.innerWidth - p.width - 8));
    var top = a.top - p.height - 8;
    if (top < 8) top = a.bottom + 8;
    popEl.style.left = Math.round(left) + 'px';
    popEl.style.top = Math.round(top) + 'px';
  }

  function fillPop(pop, m) {
    setText(pop.querySelector('.ks-pop-title'), T.popTitle);
    var state = pop.querySelector('.ks-pop-state');
    setText(state, m.running ? T.running : T.idle);
    state.classList.toggle('ks-live', !!m.running);

    var rows = [
      [T.dTotal, formatTokens(m.total) + ' ' + T.tokens],
      [T.dInput, formatTokens(m.inputOther)],
      [T.dCacheRead, formatTokens(m.cacheRead)],
      [T.dCacheWrite, formatTokens(m.cacheCreate)],
      [T.dOutput, formatTokens(m.output)],
      [T.dCacheHit, m.cacheRead > 0 ? formatPct(m.cacheHit) : '—'],
      [T.dSpeed, m.outputSpeed > 0 ? trim(m.outputSpeed) + ' tok/s' : '—'],
      [T.dTtft, m.ttftAvg > 0 ? trim(m.ttftAvg / 1000) + ' s' : '—'],
      [
        T.dContext,
        m.hasContext
          ? formatTokens(m.contextTokens) + ' / ' + formatTokens(m.contextMax) + ' (' + m.contextPct + '%)'
          : m.contextTokens > 0
            ? formatTokens(m.contextTokens) + ' ' + T.tokens
            : '—'
      ],
      [T.dTurns, String(m.turns)],
      [T.dSteps, String(m.steps)],
      [T.dModel, m.model || '—'],
      [T.dSource, m.source === 'server' ? T.srcServer : m.source === 'stream' ? T.srcStream : T.srcNone]
    ];

    var list = pop.querySelector('.ks-pop-list');
    // Rebuilding the row list on every frame would be a lot of DOM churn for
    // the observer to sweep up; only redraw when a value actually changed.
    var sig = '';
    for (var i = 0; i < rows.length; i++) sig += rows[i][0] + '\u0000' + rows[i][1] + '\u0001';
    if (sig !== lastPopSig) {
      lastPopSig = sig;
      list.textContent = '';
      rows.forEach(function (row) {
        list.appendChild(node('dt', null, row[0]));
        list.appendChild(node('dd', null, row[1]));
      });
    }
    if (popAnchor) positionPop(popAnchor);
  }

  function onDocClick(e) {
    if (!popEl) return;
    if (popEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#' + BAR_ID)) return;
    closePop();
  }

  function onKey(e) {
    if (e.key === 'Escape') closePop();
  }

  // ------------------------------------------------------------------- boot

  function watch() {
    var queued = false;
    // The renderer is a single-page app: the composer is created, replaced and
    // teleported around as the user navigates. Re-attach whenever it moved —
    // and do nothing at all when it did not, so our own writes can never feed
    // this observer back into a render loop.
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      queueMicrotask(function () {
        queued = false;
        if (mount()) render();
      });
    }).observe(document.body, { childList: true, subtree: true });

    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      history[name] = function () {
        var result = original.apply(this, arguments);
        scheduleRender();
        return result;
      };
    });
    window.addEventListener('popstate', scheduleRender);

    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', function () {
      if (popEl) positionPop(popAnchor);
    });
  }

  function start() {
    injectStyles();
    hookWebSocket();
    watch();
    if (mount()) render();
    setInterval(render, 1000);
  }

  // Debug/verification handle.
  window.__kimiSessionStats = {
    store: store,
    derive: derive,
    render: render,
    mount: mount,
    activeSessionId: activeSessionId,
    unmount: unmount
  };

  // Hook the socket immediately: the app's own module scripts run before
  // DOMContentLoaded and may open their connection that early.
  hookWebSocket();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
