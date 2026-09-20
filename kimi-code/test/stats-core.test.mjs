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
