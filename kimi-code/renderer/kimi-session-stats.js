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
    {
      key: 'cacheRead',
      aliases: ['inputCacheRead', 'cache_read_input_tokens', 'cache_read_tokens', 'cache_read', 'cached_tokens']
    },
    {
      key: 'cacheCreate',
      aliases: ['inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation_tokens', 'cache_creation']
    }
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
      // stepId -> { usage, timing, turnId, ordinal, agentId }. Upserts make
      // every channel idempotent, so a step is never counted twice.
      steps: new Map(),
      turns: new Set(),
      // Turn/step inventory of a transcript snapshot ("turnId:ordinal" keys).
      // The snapshot carries the turn and step list but no token usage, so it
      // is the only way a freshly opened session learns how many turns and
      // steps happened before this window; usage still comes from live frames.
      histTurns: new Set(),
      histSteps: new Set(),
      // agentId -> cumulative usage as reported by the server (authoritative)
      auth: new Map(),
      // Lowest turn count the server has told us about (phase.turnId is a
      // per-session 0-based counter), for sessions whose turn list we never
      // receive — the transcript snapshot of an old session is windowed.
      seedTurns: 0,
      model: '',
      contextTokens: 0,
      contextMax: 0,
      running: false,
      phase: '',
      updatedAt: 0
    };
  }

  // Turn ids arrive as "t3" in snapshots and as 3 in live frames; normalise so
  // the two channels can be compared.
  function normTurnId(raw) {
    if (typeof raw === 'number' && isFinite(raw)) return String(raw);
    if (typeof raw !== 'string' || !raw) return null;
    return raw.charAt(0) === 't' ? raw.slice(1) : raw;
  }

  function stepKey(turnId, ordinal) {
    var t = normTurnId(turnId);
    return t !== null && typeof ordinal === 'number' ? t + ':' + ordinal : null;
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
      if (typeof entry.ordinal === 'number') prev.ordinal = entry.ordinal;
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
    // live frames use camelCase, the transcript/subscribe payloads snake_case
    var id = p && (typeof p.agentId === 'string' ? p.agentId : typeof p.agent_id === 'string' ? p.agent_id : null);
    return id || MAIN_AGENT;
  }

  // Rebuild the turn/step inventory from a transcript snapshot. The server
  // sends it (transcript.reset) whenever a session is (re)opened, and the REST
  // twin is GET /sessions/<id>/transcript.
  //
  // A turn item looks like {kind:'turn', turnId:'t1', state, steps:[{kind,
  // stepId, turnId, ordinal, state, frames}]}: it carries the *inventory* but
  // no token usage at all, so counting must not depend on `usage` being there
  // (live turn.step.completed frames remain the only usage source).
  function applySnapshotItems(s, items) {
    if (!Array.isArray(items)) return false;
    s.histTurns.clear();
    s.histSteps.clear();
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || item.kind !== 'turn') continue;
      var turnId = normTurnId(item.turnId);
      if (turnId !== null) s.histTurns.add(turnId);
      var steps = Array.isArray(item.steps) ? item.steps : [];
      for (var j = 0; j < steps.length; j++) {
        var st = steps[j];
        if (!st) continue;
        var ordinal = typeof st.ordinal === 'number' ? st.ordinal : j;
        if (turnId !== null) s.histSteps.add(turnId + ':' + ordinal);
        // Usage is absent on this wire today; keep the branch so a future
        // server that does send it is picked up for free.
        if (st.usage) {
          upsertStep(s, st.stepId || turnId + ':' + ordinal, {
            usage: normalizeUsage(st.usage),
            timing: pickTiming(st.timing),
            turnId: item.turnId,
            ordinal: ordinal,
            agentId: MAIN_AGENT
          });
        }
      }
    }
    return true;
  }

  function applySnapshot(s, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false;
    s.steps.clear();
    s.turns.clear();
    applySnapshotItems(s, snapshot.items);
    applyAgentMeta(s, snapshot.meta && snapshot.meta.agent);
    return true;
  }

  // GET /sessions/<id>/snapshot — {session, messages, in_flight_turn, ...}.
  // session.usage is the server's cumulative tally for the whole session
  // (millions of tokens of history included), which is exactly what a session
  // reopened hours later needs; nothing else on this wire carries it.
  function applySnapshotPayload(s, data) {
    var session = data && data.session;
    if (!session || typeof session !== 'object') return false;
    var touched = false;

    var usage = session.usage;
    if (usage && typeof usage === 'object') {
      mergeAuthUsage(s, MAIN_AGENT, normalizeUsage(usage));
      // context_tokens / context_limit ride along in the same object
      if (typeof usage.context_tokens === 'number' && usage.context_tokens > 0) {
        s.contextTokens = usage.context_tokens;
      }
      if (typeof usage.context_limit === 'number' && usage.context_limit > 0) {
        s.contextMax = usage.context_limit;
      }
      touched = true;
    }

    var model = session.agent_config && session.agent_config.model;
    if (typeof model === 'string' && model) {
      s.model = model;
      touched = true;
    }
    if (typeof session.busy === 'boolean') {
      s.running = session.busy;
      touched = true;
    }
    return touched;
  }

  // GET /sessions/<id>/status — the authoritative model + context meter, and
  // the one source that works for a session opened long after its last turn.
  function applySessionStatus(s, data) {
    if (!data || typeof data !== 'object') return false;
    var touched = false;
    if (typeof data.model === 'string' && data.model) {
      s.model = data.model;
      touched = true;
    }
    if (typeof data.context_tokens === 'number' && data.context_tokens > 0) {
      s.contextTokens = data.context_tokens;
      touched = true;
    }
    if (typeof data.max_context_tokens === 'number' && data.max_context_tokens > 0) {
      s.contextMax = data.max_context_tokens;
      touched = true;
    }
    if (typeof data.context_usage === 'number' && data.context_usage > 0 && s.contextTokens === 0 && s.contextMax > 0) {
      s.contextTokens = Math.round(data.context_usage * s.contextMax);
      touched = true;
    }
    if (typeof data.busy === 'boolean') {
      s.running = data.busy;
      touched = true;
    }
    return touched;
  }

  // snapshot.meta.agent carries the model, the context meter and the agent's
  // cumulative usage — the durable counterpart of the volatile status frame,
  // and the only place a freshly opened session can learn its context window.
  function applyAgentMeta(s, meta) {
    if (!meta || typeof meta !== 'object') return false;
    if (typeof meta.model === 'string' && meta.model) s.model = meta.model;
    if (typeof meta.contextTokens === 'number' && meta.contextTokens > 0) {
      s.contextTokens = meta.contextTokens;
    }
    if (typeof meta.maxContextTokens === 'number' && meta.maxContextTokens > 0) {
      s.contextMax = meta.maxContextTokens;
    }
    if (typeof meta.contextUsage === 'number' && meta.contextUsage > 0 && s.contextMax > 0) {
      s.contextTokens = Math.round(meta.contextUsage * s.contextMax);
    }
    if (meta.phase && typeof meta.phase.kind === 'string' && meta.phase.kind) {
      s.phase = meta.phase.kind;
      s.running = s.phase === 'running' || s.phase === 'tool_call' || s.phase === 'retrying';
      if (typeof meta.phase.turnId === 'number' && meta.phase.turnId >= 0) {
        s.seedTurns = Math.max(s.seedTurns, meta.phase.turnId + 1);
      }
    }
    var total = meta.usage && meta.usage.total;
    if (total) mergeAuthUsage(s, MAIN_AGENT, normalizeUsage(total));
    return true;
  }

  function mergeAuthUsage(s, agentId, normalized) {
    var known = s.auth.get(agentId) || blankUsage();
    // Authoritative totals can lag a frame or two behind this session's own
    // accumulation; never let them walk backwards.
    var merged = blankUsage();
    for (var k in merged) merged[k] = Math.max(known[k], normalized[k]);
    s.auth.set(agentId, merged);
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
            ordinal: typeof st.ordinal === 'number' ? st.ordinal : undefined,
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
          ordinal: typeof p.step === 'number' ? p.step : undefined,
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
        // Every agent has its own transcript; only the main one describes the
        // session the bar reports on. Letting a subagent snapshot through
        // would wipe the main inventory it was merged into.
        if (agentId === MAIN_AGENT && applySnapshot(s, p.snapshot)) touched = true;
        break;

      case 'transcript.ops':
        if (agentId === MAIN_AGENT && applyOps(s, p.ops)) touched = true;
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
        if (total) mergeAuthUsage(s, agentId, normalizeUsage(total));
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
    var streamMs = 0;
    var ttftMs = 0;
    var ttftCount = 0;
    var sawMain = false;
    var fallbackAuth = null;

    s.steps.forEach(function (entry) {
      if (entry.agentId === MAIN_AGENT) sawMain = true;
    });

    var lastPromptTokens = 0;
    var liveSteps = 0;
    s.steps.forEach(function (entry) {
      if (sawMain && entry.agentId !== MAIN_AGENT) return;
      addUsage(usage, entry.usage);
      // Steps the transcript snapshot already listed are counted from
      // histSteps; only steps new since the snapshot extend it — while their
      // usage always counts, because the snapshot carries none.
      var key = stepKey(entry.turnId, entry.ordinal);
      if (!key || !s.histSteps.has(key)) liveSteps++;
      // The prompt a step reported is the context size at that moment, so the
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
    } else if (liveSteps > 0) {
      out.source = 'stream';
    }

    out.turns = Math.max(s.turns.size, s.histTurns.size, s.seedTurns || 0);
    out.steps = s.histSteps.size + liveSteps;
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
      ? Math.min(100, Math.max(0, Math.round((out.contextTokens / out.contextMax) * 100)))
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
    // Parsing entry point for the REST responses the renderer observes
    // (GET /sessions/<id>/status | /transcript), exposed for tests.
    applyRestPayload: applyRestPayload,
    applySessionStatus: applySessionStatus,
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
            if (String(args[0]).indexOf(WS_MARK) !== -1) {
              captureSocketOrigin(args[0]);
              observe(ws);
            }
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
      // surfaced for diagnostics (doctor.sh / CDP probes)
      window.__kimiStatsWsHooked = true;
    } catch (e) {
      /* ignore */
    }
  }

  // Where the embedded server lives. The desktop shell records it for the app
  // (sessionStorage), and the app's own socket URL falls back to the same host.
  var socketOrigin = '';

  function captureSocketOrigin(url) {
    if (socketOrigin) return;
    var host = /^wss?:\/\/([^/]+)/.exec(String(url));
    if (host) socketOrigin = 'http://' + host[1];
  }

  function serverOrigin() {
    try {
      var recorded = sessionStorage.getItem('kimi-desktop-server-origin');
      if (recorded) return String(recorded).replace(/\/+$/, '');
    } catch (e) {
      /* private mode or blocked storage */
    }
    return socketOrigin;
  }

  var SNAPSHOT_RETRY_MS = 60000;

  // GET /sessions/<id>/snapshot is the only place a reopened session's
  // cumulative usage lives (`session.usage`), and the app itself never asks for
  // it. The embedded server treats loopback requests as trusted — the app sends
  // no credentials on this route either — so we read it ourselves, once per
  // session, never in a loop.
  function ensureServerUsage(s) {
    if (!s || !nativeFetch) return;
    if (s.auth.has(MAIN_AGENT)) return;
    var origin = serverOrigin();
    if (!origin) return;
    var now = Date.now();
    if (s.snapshotTriedAt && now - s.snapshotTriedAt < SNAPSHOT_RETRY_MS) return;
    s.snapshotTriedAt = now;

    nativeFetch(origin + '/api/v1/sessions/' + encodeURIComponent(s.id) + '/snapshot', {
      credentials: 'omit'
    }).then(
      function (res) {
        return res && res.ok ? res.json() : null;
      },
      function () {
        return null;
      }
    ).then(function (json) {
      var data = json && json.data ? json.data : json;
      if (data && applySnapshotPayload(s, data)) scheduleRender();
    }).catch(function () {
      /* the retry window above governs the next attempt */
    });
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

  // A session opened long after its last turn gets no usage frames at all, so
  // the live socket alone can never fill the bar. The app itself asks the
  // server for that session's state over HTTP — GET /sessions/<id>/snapshot
  // (session + cumulative usage), /status (model + context meter) and
  // /transcript (turn/step inventory). Observing those responses costs the app
  // nothing and needs no credentials of our own: we just read a clone of what
  // it already received.
  var REST_MARK = /\/sessions\/([^/?#]+)\/(snapshot|status|transcript)\b/;
  var fetchHooked = false;
  var nativeFetch = null;

  function hookFetch() {
    if (fetchHooked || typeof window.fetch !== 'function') return;
    fetchHooked = true;
    var Native = window.fetch;
    nativeFetch = Native; // kept untouched for our own snapshot read
    try {
      window.fetch = new Proxy(Native, {
        apply: function (target, thisArg, args) {
          var promise = Reflect.apply(target, thisArg, args);
          try {
            inspectRequest(args, promise);
          } catch (e) {
            /* never interfere with the app's own request */
          }
          return promise;
        }
      });
    } catch (e) {
      /* no Proxy support: leave fetch alone */
    }
  }

  function requestUrl(args) {
    var first = args && args[0];
    if (typeof first === 'string') return first;
    if (first && typeof first.url === 'string') return first.url;
    return '';
  }

  function inspectRequest(args, promise) {
    if (!promise || typeof promise.then !== 'function') return;
    var match = REST_MARK.exec(requestUrl(args));
    if (!match) return;
    var sessionId = match[1];
    var kind = match[2];
    try {
      sessionId = decodeURIComponent(sessionId);
    } catch (e) {
      /* keep the raw path segment */
    }
    promise.then(function (res) {
      if (!res || typeof res.clone !== 'function' || res.ok === false) return;
      var body;
      try {
        body = res.clone().json(); // throws once the app has consumed the body
      } catch (e) {
        return;
      }
      body.then(
        function (json) {
          if (applyRestPayload(store, sessionId, kind, json)) scheduleRender();
        },
        function () {
          /* not JSON, or the request was cancelled */
        }
      );
    }, function () {
      /* the app's own failure */
    });
  }

  function applyRestPayload(store, sessionId, kind, json) {
    if (!sessionId) return false;
    // the server wraps success payloads in {code, msg, data}
    var data = json && json.data ? json.data : json;
    if (!data || typeof data !== 'object') return false;
    var s = sessionOf(store, sessionId);
    var touched = false;
    if (kind === 'status') {
      touched = applySessionStatus(s, data);
    } else if (kind === 'snapshot') {
      touched = applySnapshotPayload(s, data);
    } else {
      // subagents have their own transcript; it must not overwrite the main
      // inventory this bar reports on
      if (typeof data.agent_id === 'string' && data.agent_id !== MAIN_AGENT) return false;
      if (Array.isArray(data.items)) touched = applySnapshotItems(s, data.items);
      if (data.meta) touched = applyAgentMeta(s, data.meta.agent) || touched;
    }
    if (touched) s.updatedAt = Date.now();
    return touched;
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
      dTotal: '总量（不含缓存读取）',
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
      srcNone: '仅快照（无 token 数据）',
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
      dTotal: 'Total (excl. cache read)',
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
      srcNone: 'snapshot only (no usage)',
      tipGauge: 'Turns, steps and output speed of this session',
      tipTokens: 'Cumulative token usage and cache hit rate',
      tipContext: 'Context occupancy'
    }
  }[LANG];

  var CSS = [
    // Same skin as the ZCode build (official DeepSeek Harness stats row):
    // 999px pills, hairline border, soft shadow, blurred translucent surface,
    // 11.5px tabular numerals, 14px outline icons.
    '.ks-bar{display:flex;align-items:center;gap:8px;position:relative;z-index:2;',
    'margin:2px 0 0 2px;padding:0;white-space:nowrap;user-select:none;-webkit-user-select:none;',
    'font-family:var(--font-ui,system-ui);font-size:11.5px;line-height:16px;letter-spacing:.01em;',
    'font-variant-numeric:tabular-nums;color:var(--color-text-muted,rgba(0,0,0,.6))}',
    '.ks-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;',
    'background:color-mix(in srgb,var(--color-surface,#fff) 82%,transparent);',
    'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
    'border:1px solid var(--color-line,rgba(0,0,0,.13));box-shadow:0 6px 24px rgba(0,0,0,.08);',
    'color:inherit;font:inherit;cursor:pointer;min-width:0;white-space:nowrap}',
    '.ks-pill:hover{border-color:var(--color-text-faint,rgba(0,0,0,.45))}',
    '.ks-pill:hover .ks-pill-text{color:var(--color-text,rgba(0,0,0,.9))}',
    '.ks-pill-icon{display:inline-flex;color:var(--color-text-faint,rgba(0,0,0,.45));flex:none}',
    '.ks-pill-text{overflow:hidden;text-overflow:ellipsis}',
    '.ks-dot{width:7px;height:7px;border-radius:9999px;background:transparent;',
    'border:1.5px solid var(--color-line,rgba(0,0,0,.13));flex:none}',
    '.ks-gauge.ks-running .ks-dot{border-color:transparent;background:var(--color-success,#0e7a38);',
    'animation:ks-breathe 1.6s ease-in-out infinite}',
    '.ks-bar.ks-wait .ks-dot{border-color:transparent;background:var(--color-text-faint,rgba(0,0,0,.45));',
    'animation:ks-breathe 1.2s ease-in-out infinite}',
    '@keyframes ks-breathe{0%,100%{opacity:1}50%{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.ks-dot{animation:none!important}}',
    // Context ring: official ContextMeter geometry (14px viewBox, r5.5, 2px, -90°)
    '.ks-ring .ks-pill-icon{color:var(--color-text-muted,rgba(0,0,0,.6))}',
    '.ks-ring svg{display:block}',
    '.ks-ring-track{fill:none;stroke:var(--color-line,rgba(0,0,0,.13));stroke-width:2}',
    '.ks-ring-fill{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}',
    '.ks-pop{position:fixed;z-index:300;min-width:250px;padding:10px 12px;border-radius:12px;',
    'border:1px solid var(--color-line,rgba(0,0,0,.13));background:var(--color-surface-overlay,rgba(255,255,255,.95));',
    'backdrop-filter:blur(24px) saturate(1.8);-webkit-backdrop-filter:blur(24px) saturate(1.8);',
    'box-shadow:0 10px 28px -8px rgba(0,0,0,.28);color:var(--color-text,rgba(0,0,0,.9));',
    'font-family:var(--font-ui,system-ui);font-size:var(--ui-font-size-xs,12px)}',
    '.ks-pop-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;',
    'color:var(--color-text,rgba(0,0,0,.9));font-weight:var(--weight-medium,500)}',
    '.ks-pop-state{display:inline-flex;align-items:center;gap:4px;color:var(--color-text-muted,rgba(0,0,0,.45));font-weight:400}',
    '.ks-pop-state.ks-live::before{content:"";width:6px;height:6px;border-radius:50%;',
    'background:var(--color-success,#0e7a38);animation:ks-breathe 1.6s ease-in-out infinite}',
    '.ks-pop-list{display:grid;grid-template-columns:auto auto;gap:4px 16px;margin:0}',
    '.ks-pop-list dt{color:var(--color-text-muted,rgba(0,0,0,.45))}',
    '.ks-pop-list dd{margin:0;text-align:right;font-family:var(--mono,ui-monospace,monospace);',
    'color:var(--color-text,rgba(0,0,0,.9))}'
  ].join('');

  // Inline icons, same shapes as the ZCode build (official IconGaugeOutline16 /
  // IconDatabaseOutline16); currentColor keeps them themed.
  var ICON_GAUGE =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">' +
    '<path d="M2.7 10a5.5 5.5 0 1 1 10.6 0" stroke-linecap="round"/>' +
    '<path d="M8 9.7 10.6 6.9" stroke-linecap="round"/>' +
    '<circle cx="8" cy="9.9" r="1.1" fill="currentColor" stroke="none"/></svg>';
  var ICON_DB =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">' +
    '<ellipse cx="8" cy="3.8" rx="5.3" ry="2.1"/>' +
    '<path d="M2.7 3.8v8.4c0 1.16 2.37 2.1 5.3 2.1s5.3-.94 5.3-2.1V3.8"/>' +
    '<path d="M2.7 8c0 1.16 2.37 2.1 5.3 2.1s5.3-.94 5.3-2.1"/></svg>';

  // Official ContextMeter geometry: 14px viewBox, r=5.5, 2px stroke.
  var RING_R = 5.5;
  var RING_C = 2 * Math.PI * RING_R;

  function ringSvg(percent) {
    var pct = typeof percent === 'number' && isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
    var arc = (RING_C * pct) / 100;
    return (
      '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
      '<circle class="ks-ring-track" cx="7" cy="7" r="' + RING_R + '"/>' +
      '<circle class="ks-ring-fill" cx="7" cy="7" r="' + RING_R + '" ' +
      'stroke-dasharray="' + arc + ' ' + RING_C + '" transform="rotate(-90 7 7)"/></svg>'
    );
  }

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

  function iconSpan(html) {
    var span = node('span', 'ks-pill-icon');
    span.innerHTML = html;
    return span;
  }

  // Every element is the same pill shell (leading icon + text) sharing one
  // skin; the context ring is the third pill, exactly like the ZCode build.
  function buildBar() {
    var bar = node('div', 'ks-bar');
    bar.id = BAR_ID;

    var gauge = node('button', 'ks-pill ks-gauge');
    gauge.type = 'button';
    gauge.title = T.tipGauge;
    gauge.appendChild(node('i', 'ks-dot'));
    gauge.appendChild(iconSpan(ICON_GAUGE));
    gauge.appendChild(node('span', 'ks-gauge-text'));

    var tokens = node('button', 'ks-pill ks-tokens');
    tokens.type = 'button';
    tokens.title = T.tipTokens;
    tokens.appendChild(iconSpan(ICON_DB));
    tokens.appendChild(node('span', 'ks-tokens-text'));

    var ring = node('button', 'ks-pill ks-ring');
    ring.type = 'button';
    ring.title = T.tipContext;
    ring.appendChild(iconSpan(ringSvg(0)));
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
      if (!renderQueued) return;
      renderQueued = false;
      render();
    };
    // rAF coalesces bursts nicely but can stall in an occluded window, so race
    // it with a timer; whichever fires first wins.
    if (typeof requestAnimationFrame === 'function' && !document.hidden) {
      requestAnimationFrame(run);
      setTimeout(run, 120);
    } else {
      setTimeout(run, 16);
    }
  }

  function render() {
    if (!barEl || !document.contains(barEl) || !visible(barEl)) {
      // Not attached, or attached to a composer that is no longer the visible
      // one (side chat, panel teleport, settings overlay): re-target and bail
      // out if there is no visible composer to hang off.
      if (!mount()) return;
      if (!visible(barEl)) return;
    }

    var session = activeSession();
    if (session) ensureServerUsage(session);
    var m = derive(session);
    lastMetrics = m;

    var gauge = barEl.querySelector('.ks-gauge');
    var tokens = barEl.querySelector('.ks-tokens');
    var ring = barEl.querySelector('.ks-ring');
    if (!gauge || !tokens || !ring) return;

    gauge.classList.toggle('ks-running', !!m.running);

    var gaugeParts = compact([
      m.turns > 0 ? m.turns + ' ' + T.turns : null,
      m.steps > 0 ? m.steps + ' ' + T.steps : null,
      m.outputSpeed > 0 ? trim(m.outputSpeed) + ' tok/s' : null
    ]);

    if (!gaugeParts && m.total === 0 && !m.hasContext) {
      barEl.classList.add('ks-wait');
      setText(gauge.querySelector('.ks-gauge-text'), T.waiting);
      setDisplay(gauge, true);
      setDisplay(tokens, false);
      setDisplay(ring, false);
      if (popEl) fillPop(popEl, m);
      return;
    }
    barEl.classList.remove('ks-wait');

    // A freshly opened session reports its totals through the windowed
    // transcript snapshot, which carries no turn list — so say "running"
    // rather than pretending the session has zero turns and zero steps.
    setText(gauge.querySelector('.ks-gauge-text'), gaugeParts || T.running);
    setDisplay(gauge, !!(gaugeParts || m.running));
    setDisplay(tokens, m.total > 0);

    setText(
      tokens.querySelector('.ks-tokens-text'),
      compact([formatTokens(m.total) + ' ' + T.tokens, m.cacheRead > 0 ? T.cacheHit + ' ' + formatPct(m.cacheHit) : null])
    );

    if (m.hasContext) {
      setDisplay(ring, true);
      var arc = (RING_C * Math.min(100, Math.max(0, m.contextPct))) / 100;
      setAttr(ring.querySelector('.ks-ring-fill'), 'stroke-dasharray', arc + ' ' + RING_C);
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

    // A session known only from a transcript snapshot has a turn/step
    // inventory but no usage at all — printing "0 tok" would read as "this
    // session used nothing", so say nothing instead.
    var hasUsage = m.source !== 'none';
    var amount = function (v) {
      return hasUsage ? formatTokens(v) : '—';
    };

    var rows = [
      [T.dTotal, hasUsage ? formatTokens(m.total) + ' ' + T.tokens : '—'],
      [T.dInput, amount(m.inputOther)],
      [T.dCacheRead, amount(m.cacheRead)],
      [T.dCacheWrite, amount(m.cacheCreate)],
      [T.dOutput, amount(m.output)],
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
      [T.dTurns, m.turns > 0 ? String(m.turns) : '—'],
      [T.dSteps, m.steps > 0 ? String(m.steps) : '—'],
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
      // Fast path: while our bar still hangs off a host that is still in the
      // document there is nothing to do. This avoids touching layout on every
      // streamed token, which the subtree observer would otherwise trigger.
      if (barEl && hostEl && barEl.parentElement === hostEl && document.contains(barEl)) return;
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
    hookFetch();
    watch();
    if (mount()) render();
    setInterval(function () {
      if (document.hidden) return; // nothing to repaint while the window is hidden
      render();
    }, 1000);
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

  // Hook the socket and fetch immediately: the app's own module scripts run
  // before DOMContentLoaded and may open their connection (or fetch session
  // state) that early.
  hookWebSocket();
  hookFetch();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
