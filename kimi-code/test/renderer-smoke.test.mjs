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
// self-feeding observer to lock the renderer up.
const APP_JS = `
setTimeout(function () {
  var host = document.createElement('div');
  host.className = 'composer';
  host.innerHTML = '<div class="composer-card"><textarea></textarea></div>';
  document.getElementById('app').appendChild(host);
  // the app's own event stream — the script must observe this connection
  window.__sock = new window.WebSocket('ws://127.0.0.1:' + location.port + '/api/v1/ws');
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
  const server = createServer((req, res) => {
    if (req.url === '/kimi-session-stats.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(readFileSync(SCRIPT, 'utf8'));
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

  // a frame the app would deliver: server-side cumulative totals
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
  await new Promise((r) => setTimeout(r, 300));

  const text = await evaluate(`(function () {
    var tokens = document.querySelector('#kimi-session-stats .ks-tokens-text');
    var gauge = document.querySelector('#kimi-session-stats .ks-gauge-text');
    var ring = document.querySelector('#kimi-session-stats .ks-ring-label');
    return (tokens ? tokens.textContent : '') + ' | ' + (gauge ? gauge.textContent : '') + ' | ' + (ring ? ring.textContent : '');
  })()`);
  assert.equal(text.blocked, undefined, 'renderer must still answer after rendering a frame');
  assert.match(String(text.value), /990/, `token pill must show the server total (got ${JSON.stringify(text.value)})`);
  assert.match(String(text.value), /15%/, `context ring must show 15% (got ${JSON.stringify(text.value)})`);

  // still alive after the app kept churning under the observer
  const alive = await evaluate('new Promise((r)=>requestAnimationFrame(()=>r("frame")))', 4000);
  assert.equal(alive.value, 'frame', 'the renderer must still be responsive (no observer feedback loop)');

  ws.close();
});
