/* Renderer smoke test — the guard against the blank-window freeze.
 *
 *   node --test kimi-code/test/
 *
 * The bar lives in the app's own DOM and watches that DOM for the composer.
 * An observer callback that writes DOM again re-enters itself through its own
 * mutation: the microtask queue never drains, the renderer main thread starves,
 * and the app shows a blank window. This test loads the real script in a real
 * (headless Chrome) renderer against a mock composer that keeps mutating, and
 * fails if the renderer stops answering, or if the bar never renders.
 *
 * Skips itself when no Chrome/Chromium binary is available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'renderer', 'kimi-session-stats.js');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

// A stand-in for the app's own socket: the script wraps window.WebSocket and
// must observe this without disturbing it.
const FAKE_WS = `
window.__sockets = [];
function FakeWS(url) {
  this.url = String(url);
  this.readyState = 1;
  this._l = {};
  window.__sockets.push(this);
}
FakeWS.prototype.addEventListener = function (type, fn) { (this._l[type] = this._l[type] || []).push(fn); };
FakeWS.prototype.send = function () {};
FakeWS.prototype.close = function () {};
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
window.WebSocket = FakeWS;
window.__pushFrame = function (frame) {
  window.__sockets.forEach(function (s) {
    (s._l.message || []).forEach(function (fn) { fn({ data: JSON.stringify(frame) }); });
  });
};
`;

// The composer appears late (like the real SPA) and the app keeps re-rendering
// unrelated nodes afterwards — every one of those mutations is a chance for a
// self-feeding observer to lock the renderer up. The two fetches replay what
// the real app does when a session (re)opens: status + transcript.
const APP_JS = `
setTimeout(function () {
  var host = document.createElement('div');
  host.className = 'composer';
  host.innerHTML = '<div class="composer-card"><textarea></textarea></div>';
  document.getElementById('app').appendChild(host);
  // the desktop shell records the embedded server's origin for the app; the
  // bar reads it from here to reach /snapshot on its own
  sessionStorage.setItem('kimi-desktop-server-origin', location.origin);
  // the app's own event stream — the script must observe this connection
  window.__sock = new window.WebSocket('ws://127.0.0.1:' + location.port + '/api/v1/ws');
  window.__rest = Promise.all([
    fetch('/api/v1/sessions/test-session/status').then(function (r) { return r.json(); }),
    fetch('/api/v1/sessions/test-session/transcript?agent_id=main').then(function (r) { return r.json(); })
  ]);
  setInterval(function () {
    var old = document.getElementById('churn');
    if (old) old.remove();
    var span = document.createElement('span');
    span.id = 'churn';
    span.textContent = String(Date.now());
    document.getElementById('app').appendChild(span);
  }, 120);
}, 40);
`;

const STATUS_BODY = {
  code: 0,
  msg: 'success',
  data: {
    busy: false,
    model: 'goat/deepseek/deepseek-v4.1-flash',
    context_tokens: 246029,
    max_context_tokens: 1000000,
    context_usage: 0.246029
  }
};

// the inventory as the live server sends it: turn items with steps, no usage
const TRANSCRIPT_BODY = {
  code: 0,
  msg: 'success',
  data: {
    agent_id: 'main',
    items: [
      {
        kind: 'turn',
        turnId: 't0',
        ordinal: 0,
        state: 'completed',
        steps: [
          { kind: 'step', stepId: 't0.0', ordinal: 0 },
          { kind: 'step', stepId: 't0.1', ordinal: 1 }
        ]
      }
    ]
  }
};

// GET /sessions/<id>/snapshot — the whole-session tally. The app never asks
// for it; the bar has to fetch it on its own.
const SNAPSHOT_BODY = {
  code: 0,
  msg: 'success',
  data: {
    as_of_seq: 1778,
    session: {
      id: 'test-session',
      busy: false,
      agent_config: { model: 'goat/deepseek/deepseek-v4.1-flash' },
      usage: {
        input_tokens: 400000,
        output_tokens: 100000,
        cache_read_tokens: 1000000,
        cache_creation_tokens: 0,
        context_tokens: 246029,
        context_limit: 1000000
      }
    }
  }
};

function pageHtml() {
  const script = readFileSync(SCRIPT, 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><title>smoke</title>
<script>${FAKE_WS}</script>
<script>${script}</script>
</head><body><div id="app"></div>
<script>${APP_JS}</script>
</body></html>`;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitFor(probe, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test('renderer smoke: the bar mounts and the app keeps running', { timeout: 90000 }, async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chrome/Chromium binary found (set CHROME_PATH to run this test)');
    return;
  }

  const html = pageHtml();
  let snapshotHits = 0;
  const server = createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/kimi-session-stats.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(readFileSync(SCRIPT, 'utf8'));
      return;
    }
    if (url.startsWith('/api/v1/sessions/test-session/snapshot')) {
      snapshotHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SNAPSHOT_BODY));
      return;
    }
    if (url.startsWith('/api/v1/sessions/test-session/status')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STATUS_BODY));
      return;
    }
    if (url.startsWith('/api/v1/sessions/test-session/transcript')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(TRANSCRIPT_BODY));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  const port = await listen(server);

  const profile = mkdtempSync(join(tmpdir(), 'kimi-smoke-'));
  const debugPort = 9222 + Math.floor(Math.random() * 400);
  const child = spawn(chrome, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    `http://127.0.0.1:${port}/sessions/test-session`
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch {}
    try { server.close(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  t.after(cleanup);

  const version = await waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    },
    20000
  );
  assert.ok(version, 'headless Chrome must expose a debugging endpoint');

  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.url.includes('/sessions/test-session')) ?? null;
  }, 20000);
  assert.ok(target, 'the test page must be open');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')));
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params, timeoutMs = 5000) => {
    const myId = ++id;
    return Promise.race([
      new Promise((resolve) => {
        pending.set(myId, resolve);
        ws.send(JSON.stringify({ id: myId, method, params }));
      }),
      new Promise((r) => setTimeout(() => r({ timedOut: true }), timeoutMs))
    ]);
  };
  const evaluate = async (expression, timeoutMs = 5000) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.timedOut) return { blocked: true };
    if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text };
    return { value: res.result?.result?.value };
  };

  await send('Runtime.enable');
  // let the app "boot": composer mounted, churn interval running
  await new Promise((r) => setTimeout(r, 2000));

  const composed = await evaluate('document.readyState');
  assert.equal(composed.blocked, undefined, 'renderer must not be blocked after mount (blank-window freeze)');
  assert.equal(composed.value, 'complete', 'the page must finish loading');

  const mounted = await evaluate(`(function () {
    var bar = document.getElementById('kimi-session-stats');
    if (!bar) return 'no bar';
    if (!bar.closest('.composer')) return 'bar not inside .composer';
    return 'ok';
  })()`);
  assert.equal(mounted.value, 'ok', 'the bar must be attached under the composer');

  // The two REST responses the app fetched on open must fill the bar on their
  // own: the turn/step inventory comes from /transcript, the context meter and
  // model from /status — the only data a session opened long after its last
  // turn can offer.
  const restRead = async () =>
    String(
      (
        await evaluate(`(function () {
          var bar = document.getElementById('kimi-session-stats');
          var gauge = bar && bar.querySelector('.ks-gauge-text');
          var ring = bar && bar.querySelector('.ks-ring-label');
          return ((gauge && gauge.textContent) || '') + ' | ' + ((ring && ring.textContent) || '');
        })()`)
      ).value
    );
  const inventory = await waitFor(async () => {
    const text = await restRead();
    return /(1\s*(轮|turns?))/.test(text) ? text : null;
  }, 6000);
  assert.ok(inventory, 'the transcript snapshot must restore the turn count');
  assert.match(inventory, /(2\s*(步|steps?))/, `step count from the snapshot (got ${JSON.stringify(inventory)})`);
  assert.match(inventory, /25%/, `context ring from /status (got ${JSON.stringify(inventory)})`);

  // The app never asks the server for the session's cumulative usage, so the
  // bar reads GET /sessions/<id>/snapshot itself, authenticating with the
  // subprotocol token it observed on the app's own WebSocket handshake.
  const cumulative = await waitFor(async () => {
    const t = String(
      (
        await evaluate(
          "(function(){var e=document.querySelector('#kimi-session-stats .ks-tokens-text');return e?e.textContent:''})()"
        )
      ).value
    );
    return /500k/.test(t) ? t : null;
  }, 9000);
  assert.ok(cumulative, `the bar must read the server tally itself (got ${JSON.stringify(cumulative)})`);
  assert.ok(snapshotHits >= 1, 'GET /snapshot must be issued by the bar itself');
  assert.match(cumulative, /71%/, `cache hit comes from the server tally (got ${JSON.stringify(cumulative)})`);

  // a live frame for the same session: its context meter wins (it is fresher),
  // while the larger server tally keeps the totals
  await evaluate(`window.__pushFrame(${JSON.stringify({
    type: 'agent.status.updated',
    session_id: 'test-session',
    payload: {
      agentId: 'main',
      model: 'test/model',
      contextTokens: 1500,
      maxContextTokens: 10000,
      usage: { total: { inputOther: 900, output: 90, inputCacheRead: 100, inputCacheCreation: 0 } }
    }
  })})`);
  await new Promise((r) => setTimeout(r, 400));

  const text = await evaluate(`(function () {
    var tokens = document.querySelector('#kimi-session-stats .ks-tokens-text');
    var gauge = document.querySelector('#kimi-session-stats .ks-gauge-text');
    var ring = document.querySelector('#kimi-session-stats .ks-ring-label');
    return (tokens ? tokens.textContent : '') + ' | ' + (gauge ? gauge.textContent : '') + ' | ' + (ring ? ring.textContent : '');
  })()`);
  assert.equal(text.blocked, undefined, 'renderer must still answer after rendering a frame');
  assert.match(String(text.value), /500k/, `the larger server tally still wins (got ${JSON.stringify(text.value)})`);
  assert.match(String(text.value), /15%/, `the live frame refreshes the context meter (got ${JSON.stringify(text.value)})`);

  // still alive after the app kept churning under the observer
  const alive = await evaluate('new Promise((r)=>requestAnimationFrame(()=>r("frame")))', 4000);
  assert.equal(alive.value, 'frame', 'the renderer must still be responsive (no observer feedback loop)');

  // the skin must stay aligned with the ZCode build: one pill shell per
  // metric with a 14px outline icon, and the official ring geometry
  const skin = await evaluate(`(function () {
    var bar = document.getElementById('kimi-session-stats');
    var pills = Array.prototype.slice.call(bar.querySelectorAll('.ks-pill'));
    var ring = bar.querySelector('.ks-ring svg');
    var cs = getComputedStyle(pills[0]);
    return {
      pills: pills.length,
      icons: pills.map(function (p) { return p.querySelectorAll('.ks-pill-icon svg').length; }).join(','),
      viewBox: ring ? ring.getAttribute('viewBox') : 'none',
      radius: cs.borderTopLeftRadius,
      size: cs.fontSize
    };
  })()`);
  assert.equal(skin.value.pills, 3, 'gauge + usage + context');
  assert.equal(skin.value.icons, '1,1,1', 'every pill carries an inline icon');
  assert.equal(skin.value.viewBox, '0 0 14 14', 'official ContextMeter ring geometry');
  assert.match(String(skin.value.radius), /999/, 'pills use the 999px capsule radius');
  assert.match(String(skin.value.size), /11\.5px/, 'pills use the 11.5px stats-row type scale');

  ws.close();
});
