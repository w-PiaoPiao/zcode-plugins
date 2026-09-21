/* Unit tests for the session-stats core.
 *
 *   node --test kimi-code/test/
 *
 * The frame-replay test runs against the real frame journals the Kimi Code
 * desktop app writes to ~/.kimi-code/server/events/*.jsonl, so the parser is
 * checked against actual wire data rather than hand-written fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CORE = require('../renderer/kimi-session-stats.js');

const EVENTS_DIR = process.env.KIMI_EVENTS_DIR || join(homedir(), '.kimi-code', 'server', 'events');

function loadJournals() {
  if (!existsSync(EVENTS_DIR)) return [];
  return readdirSync(EVENTS_DIR)
    .filter((f) => f.startsWith('session_') && f.endsWith('.jsonl'))
    .map((f) => join(EVENTS_DIR, f));
}

function framesOf(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row && row.kind === 'event' && row.envelope) out.push(row.envelope);
  }
  return out;
}

function stepCompleted(frames, agentId = 'main') {
  return frames.filter(
    (f) => f.type === 'turn.step.completed' && f.payload && (f.payload.agentId || 'main') === agentId
  );
}

test('normalizeUsage accepts camelCase and snake_case', () => {
  assert.deepEqual(CORE.normalizeUsage({ inputOther: 5, output: 2, inputCacheRead: 1, inputCacheCreation: 0 }), {
    inputOther: 5,
    output: 2,
    cacheRead: 1,
    cacheCreate: 0
  });
  assert.deepEqual(CORE.normalizeUsage({ input_tokens: 7, output_tokens: 3 }), {
    inputOther: 7,
    output: 3,
    cacheRead: 0,
    cacheCreate: 0
  });
  assert.deepEqual(CORE.normalizeUsage(null), { inputOther: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  // negative / non-finite values are clamped away
  assert.equal(CORE.normalizeUsage({ inputOther: -3, output: NaN }).inputOther, 0);
});

test('step events accumulate once per stepId', () => {
  const store = CORE.createStore();
  const frame = (stepId, usage) => ({
    type: 'turn.step.completed',
    session_id: 's1',
    payload: { agentId: 'main', turnId: 0, stepId, usage }
  });

  CORE.applyFrame(store, frame('a', { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 }));
  CORE.applyFrame(store, frame('b', { inputOther: 200, output: 20, inputCacheRead: 50, inputCacheCreation: 0 }));
  // the same step replayed by a reconnect must not be counted twice
  CORE.applyFrame(store, frame('a', { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 }));

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.steps, 2);
  assert.equal(m.turns, 1);
  assert.equal(m.inputOther, 300);
  assert.equal(m.output, 30);
  assert.equal(m.cacheRead, 50);
  assert.equal(m.total, 330);
  assert.equal(m.source, 'stream');
});

test('subagents do not pollute a session that has main-agent steps', () => {
  const store = CORE.createStore();
  const frame = (agentId, usage) => ({
    type: 'turn.step.completed',
    session_id: 's1',
    payload: { agentId, turnId: 0, stepId: agentId + '-1', usage }
  });
  CORE.applyFrame(store, frame('main', { output: 100 }));
  CORE.applyFrame(store, frame('agent-0', { output: 9999 }));

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.steps, 1);
  assert.equal(m.output, 100);
});

test('transcript snapshot rebuilds state and is not additive', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's1',
    payload: { agentId: 'main', turnId: 0, stepId: 'old', usage: { output: 1111 } }
  });

  const snapshot = {
    items: [
      {
        kind: 'turn',
        turnId: 0,
        steps: [{ stepId: 'x', usage: { inputOther: 10, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }]
      },
      {
        kind: 'turn',
        turnId: 1,
        steps: [
          { stepId: 'y', usage: { inputOther: 20, output: 2, inputCacheRead: 0, inputCacheCreation: 0 } },
          { stepId: 'z', usage: { inputOther: 30, output: 3, inputCacheRead: 0, inputCacheCreation: 0 } }
        ]
      }
    ]
  };
  CORE.applyFrame(store, { type: 'transcript.reset', session_id: 's1', payload: { snapshot } });

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.steps, 3);
  assert.equal(m.turns, 2);
  assert.equal(m.output, 6, 'stale pre-snapshot step must be dropped');
});

test('transcript snapshot meta supplies model, context window and totals', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'transcript.reset',
    session_id: 's1',
    payload: {
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 0,
            steps: [
              {
                stepId: 'x',
                usage: { inputOther: 100, output: 10, inputCacheRead: 20, inputCacheCreation: 0 },
                timing: { llmStreamDurationMs: 1000 }
              }
            ]
          }
        ],
        meta: {
          agent: {
            model: 'goat/deepseek/deepseek-v4.1-flash',
            contextTokens: 40000,
            maxContextTokens: 200000,
            usage: { total: { inputOther: 5000, output: 500, inputCacheRead: 40000, inputCacheCreation: 0 } }
          }
        }
      }
    }
  });

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.model, 'goat/deepseek/deepseek-v4.1-flash');
  assert.equal(m.hasContext, true);
  assert.equal(m.contextTokens, 40000);
  assert.equal(m.contextMax, 200000);
  assert.equal(m.contextPct, 20);
  // the meta totals cover more history than the snapshot window
  assert.equal(m.source, 'server');
  assert.equal(m.output, 500);
});

test('snapshot meta can express context as a ratio', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'transcript.reset',
    session_id: 's1',
    payload: {
      snapshot: {
        items: [],
        meta: { agent: { maxContextTokens: 100000, contextUsage: 0.25 } }
      }
    }
  });
  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.contextTokens, 25000);
  assert.equal(m.contextPct, 25);
});

test('without an explicit context reading, tokens and percent agree', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's1',
    payload: {
      agentId: 'main',
      turnId: 0,
      stepId: 'a',
      usage: { inputOther: 3000, output: 40, inputCacheRead: 7000, inputCacheCreation: 0 }
    }
  });
  CORE.applyFrame(store, {
    type: 'transcript.reset',
    session_id: 's1',
    payload: {
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 0,
            steps: [
              {
                stepId: 'a',
                usage: { inputOther: 3000, output: 40, inputCacheRead: 7000, inputCacheCreation: 0 }
              }
            ]
          }
        ],
        meta: { agent: { maxContextTokens: 100000 } }
      }
    }
  });

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.contextTokens, 10000, 'falls back to the last step prompt size');
  assert.equal(m.contextPct, 10, 'percent must be computed from the same number the bar prints');
});

test('a windowed snapshot still reports the session turn count', () => {
  // Opening an old session: the snapshot arrives with zero items but the phase
  // tells us which turn the session is on and that it is still working.
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'transcript.reset',
    session_id: 's1',
    payload: {
      snapshot: {
        items: [],
        hasMoreOlder: true,
        meta: { agent: { model: 'm', phase: { kind: 'tool_call', turnId: 1, step: 40 } } }
      }
    }
  });
  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.turns, 2, 'turnId is 0-based, so the session is on its second turn');
  assert.equal(m.steps, 0, 'step ordinals are per turn and must not be shown as a session total');
  assert.equal(m.running, true);
  assert.equal(m.model, 'm');
});

test('transcript ops upsert steps and turns', () => {
  const store = CORE.createStore();
  const ops = {
    type: 'transcript.ops',
    session_id: 's1',
    payload: {
      ops: [
        { op: 'turn.upsert', turn: { turnId: 3, state: 'completed' } },
        {
          op: 'step.upsert',
          turnId: 3,
          step: { stepId: 'p', ordinal: 1, usage: { inputOther: 5, output: 7, inputCacheRead: 0, inputCacheCreation: 0 } }
        }
      ]
    }
  };
  CORE.applyFrame(store, ops);
  CORE.applyFrame(store, ops); // replay

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.turns, 1);
  assert.equal(m.steps, 1);
  assert.equal(m.output, 7);
});

test('server totals win when they exceed the stream sum', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's1',
    payload: { agentId: 'main', turnId: 0, stepId: 'a', usage: { output: 10 } }
  });
  CORE.applyFrame(store, {
    type: 'agent.status.updated',
    session_id: 's1',
    payload: {
      agentId: 'main',
      model: 'test/model',
      contextTokens: 1500,
      maxContextTokens: 10000,
      usage: { total: { inputOther: 900, output: 90, inputCacheRead: 100, inputCacheCreation: 0 } }
    }
  });

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.source, 'server');
  assert.equal(m.output, 90);
  assert.equal(m.total, 990);
  assert.equal(m.model, 'test/model');
  assert.equal(m.hasContext, true);
  assert.equal(m.contextPct, 15);
});

test('totals never regress when a stale status arrives', () => {
  const store = CORE.createStore();
  const status = (output) => ({
    type: 'agent.status.updated',
    session_id: 's1',
    payload: { agentId: 'main', usage: { total: { inputOther: 0, output, inputCacheRead: 0, inputCacheCreation: 0 } } }
  });
  CORE.applyFrame(store, status(500));
  CORE.applyFrame(store, status(100));
  assert.equal(CORE.derive(store.sessions.get('s1')).output, 500);
});

test('sessions are isolated from each other', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's1',
    payload: { agentId: 'main', turnId: 0, stepId: 'a', usage: { output: 10 } }
  });
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's2',
    payload: { agentId: 'main', turnId: 0, stepId: 'b', usage: { output: 20 } }
  });
  assert.equal(CORE.derive(store.sessions.get('s1')).output, 10);
  assert.equal(CORE.derive(store.sessions.get('s2')).output, 20);
});

test('frames without a session id are ignored', () => {
  const store = CORE.createStore();
  assert.equal(CORE.applyFrame(store, { type: 'turn.step.completed', payload: {} }), false);
  assert.equal(store.sessions.size, 0);
});

test('output speed and cache hit rate derive from timings', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's1',
    payload: {
      agentId: 'main',
      turnId: 0,
      stepId: 'a',
      usage: { inputOther: 100, output: 50, inputCacheRead: 900, inputCacheCreation: 0 },
      llmStreamDurationMs: 1000,
      llmFirstTokenLatencyMs: 400
    }
  });
  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.outputSpeed, 50);
  assert.equal(m.ttftAvg, 400);
  assert.equal(CORE.formatPct(m.cacheHit), '90%');
});

test('formatters', () => {
  assert.equal(CORE.formatTokens(0), '0');
  assert.equal(CORE.formatTokens(999), '999');
  assert.equal(CORE.formatTokens(1500), '1.5k');
  assert.equal(CORE.formatTokens(12420000), '12.42M');
  assert.equal(CORE.formatPct(0.98), '98%');
  assert.equal(CORE.formatPct(0.998), '100%');
  assert.equal(CORE.formatPct(0.074), '7.4%');
});

test('session lifecycle frames drive running state and model', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'event.session.work_changed',
    payload: { busy: true, main_turn_active: true, agentId: 'main', sessionId: 's1' }
  });
  assert.equal(CORE.derive(store.sessions.get('s1')).running, true);

  CORE.applyFrame(store, {
    type: 'subagent.spawned',
    payload: { subagentId: 'agent-0', model: 'goat/deepseek/deepseek-v4.1-flash', agentId: 'main', sessionId: 's1' }
  });
  assert.equal(CORE.derive(store.sessions.get('s1')).model, 'goat/deepseek/deepseek-v4.1-flash');

  CORE.applyFrame(store, {
    type: 'event.session.work_changed',
    payload: { busy: false, main_turn_active: false, agentId: 'main', sessionId: 's1' }
  });
  assert.equal(CORE.derive(store.sessions.get('s1')).running, false);
});

test('context occupancy falls back to the latest step prompt', () => {
  const store = CORE.createStore();
  const step = (stepId, inputOther, cacheRead) => ({
    type: 'turn.step.completed',
    session_id: 's1',
    payload: {
      agentId: 'main',
      turnId: 0,
      stepId,
      usage: { inputOther, output: 1, inputCacheRead: cacheRead, inputCacheCreation: 0 }
    }
  });
  CORE.applyFrame(store, step('a', 1000, 2000));
  CORE.applyFrame(store, step('b', 500, 30000));

  const before = CORE.derive(store.sessions.get('s1'));
  assert.equal(before.contextTokens, 30500, 'the latest step prompt is the context size');
  assert.equal(before.hasContext, false, 'no window size on this wire, so no ring');

  // event.session.created carries the session object itself (usage + limit)
  CORE.applyFrame(store, {
    type: 'event.session.created',
    payload: { session: { id: 's1', usage: { context_tokens: 1200, context_limit: 100000 } } }
  });
  const after = CORE.derive(store.sessions.get('s1'));
  assert.equal(after.hasContext, true);
  assert.equal(after.contextTokens, 1200);
  assert.equal(after.contextMax, 100000);
  assert.equal(after.contextPct, 1);
});

test('a reopened session restores its turn/step inventory from the snapshot', () => {
  const store = CORE.createStore();
  // shape taken from the live server: GET /sessions/<id>/transcript
  const items = [
    {
      kind: 'turn',
      turnId: 't0',
      ordinal: 0,
      state: 'completed',
      steps: [
        { kind: 'step', stepId: 't0.0', ordinal: 0 },
        { kind: 'step', stepId: 't0.1', ordinal: 1 }
      ]
    },
    { kind: 'marker', markerId: 'm1' },
    { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', steps: [{ kind: 'step', stepId: 't1.0', ordinal: 0 }] }
  ];
  assert.equal(CORE.applyRestPayload(store, 's1', 'transcript', { code: 0, msg: 'success', data: { agent_id: 'main', items } }), true);

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.turns, 2, 'turn items are counted even though they carry no usage');
  assert.equal(m.steps, 3, 'steps come from the item inventory');
  assert.equal(m.total, 0, 'a snapshot has no token usage — totals start at zero');
  assert.equal(m.source, 'none');
});

test('live frames extend the snapshot baseline without double counting', () => {
  const store = CORE.createStore();
  const items = [{ kind: 'turn', turnId: 't0', ordinal: 0, steps: [{ kind: 'step', stepId: 't0.0', ordinal: 0 }] }];
  CORE.applyRestPayload(store, 's1', 'transcript', { data: { items } });

  // a frame for the step the snapshot already listed: the step is not counted
  // twice, but its usage is — the snapshot carries none.
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's1',
    payload: { agentId: 'main', turnId: 0, step: 0, stepId: 'uuid-0', usage: { inputOther: 100, output: 10 } }
  });
  let m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.steps, 1, 'already-listed step is not counted again');
  assert.equal(m.total, 110, 'its usage is counted');

  // a genuinely new step extends both
  CORE.applyFrame(store, {
    type: 'turn.step.completed',
    session_id: 's1',
    payload: { agentId: 'main', turnId: 0, step: 1, stepId: 'uuid-1', usage: { inputOther: 200, output: 20 } }
  });
  m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.steps, 2);
  assert.equal(m.total, 330);
});

test('GET /sessions/<id>/status fills model and context for an old session', () => {
  const store = CORE.createStore();
  // shape taken from the live server
  assert.equal(
    CORE.applyRestPayload(store, 's1', 'status', {
      code: 0,
      msg: 'success',
      data: {
        busy: false,
        model: 'goat/deepseek/deepseek-v4.1-flash',
        context_tokens: 246029,
        max_context_tokens: 1000000,
        context_usage: 0.246029
      }
    }),
    true
  );
  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.model, 'goat/deepseek/deepseek-v4.1-flash');
  assert.equal(m.contextTokens, 246029);
  assert.equal(m.contextMax, 1000000);
  assert.equal(m.hasContext, true);
  assert.equal(m.contextPct, 25, '246029 / 1000000 rounds to 25%');
  assert.equal(m.running, false);
  assert.equal(m.turns, 0, 'status alone says nothing about turns');
});

test('a subagent transcript must not wipe the main inventory', () => {
  const store = CORE.createStore();
  CORE.applyRestPayload(store, 's1', 'transcript', {
    data: {
      agent_id: 'main',
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          ordinal: 0,
          steps: [
            { kind: 'step', stepId: 't0.0', ordinal: 0 },
            { kind: 'step', stepId: 't0.1', ordinal: 1 }
          ]
        }
      ]
    }
  });
  assert.equal(CORE.derive(store.sessions.get('s1')).steps, 2);

  // the app subscribes to subagent transcripts as well: theirs must be ignored
  assert.equal(
    CORE.applyRestPayload(store, 's1', 'transcript', { data: { agent_id: 'agent-0', items: [] } }),
    false,
    'a subagent snapshot reports no change'
  );
  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.turns, 1, 'main turns survive');
  assert.equal(m.steps, 2, 'main inventory survives a subagent snapshot');
});

test('a subagent transcript.reset frame is ignored too', () => {
  const store = CORE.createStore();
  CORE.applyFrame(store, {
    type: 'transcript.reset',
    session_id: 's1',
    payload: {
      agent_id: 'main',
      snapshot: { agent_id: 'main', items: [{ kind: 'turn', turnId: 't0', ordinal: 0, steps: [{ kind: 'step', stepId: 't0.0', ordinal: 0 }] }] }
    }
  });
  assert.equal(CORE.derive(store.sessions.get('s1')).steps, 1);

  CORE.applyFrame(store, {
    type: 'transcript.reset',
    session_id: 's1',
    payload: { agent_id: 'agent-0', snapshot: { agent_id: 'agent-0', items: [] } }
  });
  assert.equal(CORE.derive(store.sessions.get('s1')).steps, 1, 'subagent snapshot ignored');
});

test('GET /sessions/<id>/snapshot restores the cumulative session usage', () => {
  const store = CORE.createStore();
  // shape taken from the live server (GET /api/v1/sessions/<id>/snapshot):
  // session.usage is the whole-session tally, millions of tokens included
  assert.equal(
    CORE.applyRestPayload(store, 's1', 'snapshot', {
      code: 0,
      msg: 'success',
      data: {
        as_of_seq: 1778,
        session: {
          id: 's1',
          busy: false,
          agent_config: { model: 'goat/deepseek/deepseek-v4.1-flash' },
          usage: {
            input_tokens: 302245,
            output_tokens: 121767,
            cache_read_tokens: 23521664,
            cache_creation_tokens: 0,
            context_tokens: 246029,
            context_limit: 1000000
          }
        }
      }
    }),
    true
  );

  const m = CORE.derive(store.sessions.get('s1'));
  assert.equal(m.source, 'server', 'the server cumulative is authoritative');
  assert.equal(m.inputOther, 302245);
  assert.equal(m.output, 121767);
  assert.equal(m.cacheRead, 23521664);
  assert.equal(m.total, 424012, 'total = uncached input + cache write + output');
  assert.equal(CORE.formatPct(m.cacheHit), '99%');
  assert.equal(m.model, 'goat/deepseek/deepseek-v4.1-flash');
  assert.equal(m.hasContext, true);
  assert.equal(m.contextTokens, 246029);
  assert.equal(m.contextMax, 1000000);
  assert.equal(m.contextPct, 25);
  assert.equal(m.running, false);
});

test('replaying a real recorded session matches a reference sum', (t) => {
  const journals = loadJournals();
  let best = null;
  for (const file of journals) {
    const frames = framesOf(file);
    const completed = stepCompleted(frames);
    if (!best || completed.length > best.completed.length) best = { file, frames, completed };
  }
  if (!best || best.completed.length === 0) {
    t.skip(`no recorded frames with usage under ${EVENTS_DIR} (set KIMI_EVENTS_DIR to override)`);
    return;
  }

  const store = CORE.createStore();
  let applied = 0;
  for (const frame of best.frames) if (CORE.applyFrame(store, frame)) applied++;

  const sessionId = best.frames[0].session_id;
  const m = CORE.derive(store.sessions.get(sessionId));

  // Reference: a plain sum over the same frames, deduplicated by stepId.
  const seen = new Set();
  const ref = { inputOther: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const turns = new Set();
  for (const f of best.completed) {
    const p = f.payload;
    const key = p.stepId || `${p.turnId}:${p.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    turns.add(p.turnId);
    const u = CORE.normalizeUsage(p.usage);
    ref.inputOther += u.inputOther;
    ref.output += u.output;
    ref.cacheRead += u.cacheRead;
    ref.cacheCreate += u.cacheCreate;
  }

  assert.ok(applied > 0, 'at least one frame must be recognised');
  assert.equal(m.steps, seen.size, 'step count matches the reference');
  assert.equal(m.turns, turns.size, 'turn count matches the reference');
  assert.equal(m.inputOther, ref.inputOther);
  assert.equal(m.output, ref.output);
  assert.equal(m.cacheRead, ref.cacheRead);
  assert.equal(m.cacheCreate, ref.cacheCreate);
  assert.ok(m.outputSpeed > 0, 'output speed derived from real timings');

  console.log(
    `    replayed ${best.frames.length} frames from ${best.file.split('/').pop()}: ` +
      `${m.turns} turns, ${m.steps} steps, ${CORE.formatTokens(m.total)} tok, ` +
      `cache ${CORE.formatPct(m.cacheHit)}, ${m.outputSpeed.toFixed(1)} tok/s`
  );
});
