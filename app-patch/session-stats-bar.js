// session-stats-bar.js — 注入 ZCode 渲染器的会话统计悬浮条（固定底部）
//
// 由 patch-app.mjs 注入 index.html（<script type="module" src="./assets/session-stats-bar.js">）。
// 职责：
//   1. 在窗口底部固定一条会话统计（不依赖 chat-composer 等任何业务锚点，
//      React 重渲染/切换会话/整体布局重建都不会让它消失）
//   2. 每秒从本地统计守护进程（127.0.0.1:47771/v1/stats）拉取数据并渲染
//   3. daemon 未就绪（如 ZCode 刚重启、hook 尚未拉起 daemon）时显示等待占位，
//      一旦就绪立即显示真实指标 —— 永不隐藏
// 数据由 session-stats 插件的守护进程从 ~/.zcode/cli/db/db.sqlite 聚合而来。
// token 由 patch-app.mjs 通过 --token 注入（与 ~/.zcode/session-stats/daemon-token 一致），
// 占位符 __ZC_STATS_TOKEN__ 在烘焙时被替换。

const DEFAULT_PORT = 47771;
const POLL_MS = 1000;
const TOKEN = "__ZC_STATS_TOKEN__";

const CSS = `
[data-zcstats-bar] {
  position: fixed;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(96vw, 720px);
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--color-surface, #ffffff);
  background: color-mix(in srgb, var(--color-surface, #ffffff) 82%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--color-border, #e4e4e7);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
  font-size: 11.5px;
  line-height: 16px;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  color: var(--color-foreground-subtle, #71717a);
  white-space: nowrap;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  pointer-events: auto;
}
/* 给输入框下方留出悬浮条空间：输入框整体上移，下方留白由悬浮条占用
   （bar 高约 28px：留白 36px = 条体 28 + 上 2 + 下 6） */
[data-testid="v4-composer"] {
  margin-bottom: 36px !important;
}
/* 窄窗口收缩：tokens 段允许省略 */
[data-zcstats-bar] .zcstats-seg { display: inline-flex; align-items: baseline; gap: 4px; flex: 0 0 auto; }
[data-zcstats-bar] .zcstats-seg[data-zcstats-seg="tokens"] { flex: 0 1 auto; min-width: 0; overflow: hidden; }
[data-zcstats-bar] .zcstats-seg .zcstats-v { overflow: hidden; text-overflow: ellipsis; }
[data-zcstats-bar] .zcstats-k { color: var(--color-foreground-subtlest, #a1a1aa); flex: none; }
[data-zcstats-bar] .zcstats-v { color: var(--color-foreground-subtle, #71717a); }
[data-zcstats-bar]:hover .zcstats-v { color: var(--color-foreground, #18181b); }
[data-zcstats-bar] .zcstats-dot {
  width: 7px; height: 7px; border-radius: 9999px;
  background: transparent;
  border: 1.5px solid var(--color-border, #e4e4e7);
  flex: none;
}
[data-zcstats-bar].zcstats-live .zcstats-dot {
  border-color: transparent;
  background: var(--color-git-added, #22c55e);
  animation: zcstats-pulse 1.6s ease-in-out infinite;
}
[data-zcstats-bar].zcstats-wait .zcstats-dot {
  border-color: transparent;
  background: var(--color-foreground-subtlest, #a1a1aa);
  animation: zcstats-pulse 1.2s ease-in-out infinite;
}
[data-zcstats-bar] .zcstats-sep { color: var(--color-border, #e4e4e7); flex: none; }
[data-zcstats-bar].zcstats-wait .zcstats-sep { display: none; }
@keyframes zcstats-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
/* 触屏/悬停不影响展示 */
@media (prefers-reduced-motion: reduce) {
  [data-zcstats-bar].zcstats-live .zcstats-dot,
  [data-zcstats-bar].zcstats-wait .zcstats-dot { animation: none; }
}
`;

const SEG_DEFS = [
  { id: "turns" },
  { id: "llm" },
  { id: "speed" },
  { id: "cache" },
  { id: "tokens" },
];

let bar = null;
let segs = {};
let failCount = 0;

function fmtTokens(n) {
  if (n == null || isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : k.toFixed(1)) + "K";
  }
  return (n / 1_000_000).toFixed(2) + "M";
}

function fmtDur(ms) {
  if (ms == null || ms <= 0) return "—";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

function fmtSec(ms) {
  if (ms == null || isNaN(ms)) return "—";
  return (ms / 1000).toFixed(ms < 9500 ? 1 : 0) + "s";
}

function buildBar() {
  const el = document.createElement("div");
  el.setAttribute("data-zcstats-bar", "");
  el.style.display = "none";
  const dot = document.createElement("span");
  dot.className = "zcstats-dot";
  dot.title = "会话统计";
  el.appendChild(dot);
  for (let i = 0; i < SEG_DEFS.length; i++) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "zcstats-sep";
      sep.textContent = "│";
      el.appendChild(sep);
    }
    const seg = document.createElement("span");
    seg.className = "zcstats-seg";
    seg.setAttribute("data-zcstats-seg", SEG_DEFS[i].id);
    const k = document.createElement("span");
    k.className = "zcstats-k";
    const v = document.createElement("span");
    v.className = "zcstats-v";
    seg.append(k, v);
    el.appendChild(seg);
    segs[SEG_DEFS[i].id] = { seg, k, v };
  }
  return el;
}

function setSeg(id, label, value, title) {
  const s = segs[id];
  if (!s) return;
  s.seg.style.display = "";
  if (s.k) s.k.textContent = label;
  s.v.textContent = value;
  if (title) s.seg.title = title;
  else s.seg.removeAttribute("title");
}

function hideSeg(id) {
  const s = segs[id];
  if (s) s.seg.style.display = "none";
}

function setWaitState() {
  if (!bar) return;
  bar.classList.add("zcstats-wait");
  bar.classList.remove("zcstats-live");
  for (const seg of SEG_DEFS) hideSeg(seg.id);
  // 把整条作为一个可读状态
  setSeg("turns", "", "会话统计 · 等待本地服务…", "统计守护进程尚未就绪，正在自动重试");
}

function render(data) {
  if (!bar) return;
  bar.classList.remove("zcstats-wait");
  const t = data && data.available ? data.totals : null;
  // daemon 可达但无数据（空会话/新会话）：显示全 0，绝不隐藏
  if (!t) {
    bar.classList.remove("zcstats-live");
    setSeg("turns", "", "0 轮 · 0 步", "当前会话暂无统计数据");
    setSeg("llm", "LLM", "—", "纯模型耗时");
    setSeg("speed", "首 token", "—", "首 token / 输出吞吐");
    setSeg("cache", "缓存", "—", "缓存命中");
    setSeg("tokens", "", "输入 0 · 输出 0", "累计输入/输出 token");
    bar.style.display = "";
    return;
  }
  bar.classList.toggle("zcstats-live", !!data.live);
  if (data.live) {
    bar.querySelector(".zcstats-dot").title = `进行中 · 已 ${fmtDur(Date.now() - data.live.since)}`;
  }
  setSeg("turns", "", `${t.turns} 轮 · ${t.steps} 步`,
    `会话：${(data.session?.title || data.session?.id || "").slice(0, 80)}\n用户消息触发的轮：${t.turns}\n智能体步数（模型请求）：${t.steps}${t.retries ? `\n重试：${t.retries} 次` : ""}`);
  setSeg("llm", "LLM", fmtDur(t.llmMs), `纯模型耗时 ${fmtDur(t.llmMs)}（${t.attempts} 次请求，不含工具执行）`);
  setSeg("speed", "首 token", `${fmtSec(t.avgTtftMs)} · ${t.tokPerSec} tok/s`,
    `首 token 中位 ${t.avgTtftMs != null ? (t.avgTtftMs / 1000).toFixed(2) + "s" : "—"}\n输出吞吐 ${t.tokPerSec} tok/s（总输出 / 生成时间）`);
  setSeg("cache", "缓存", t.cacheHitPct != null ? t.cacheHitPct + "%" : "—",
    `缓存命中 ${t.cacheHitPct != null ? t.cacheHitPct + "%" : "—"}\n命中 ${fmtTokens(t.cacheReadTokens)} tok / 输入 ${fmtTokens(t.inputTokens + (t.cacheWriteTokens || 0))} tok`);
  setSeg("tokens", "", `输入 ${fmtTokens(t.inputTokens)} · 输出 ${fmtTokens(t.outputTokens)}`,
    `累计输入 ${t.inputTokens?.toLocaleString()} tok（每步都会重发上下文，随轮数增长是正常的）\n累计输出 ${t.outputTokens?.toLocaleString()} tok`);
  bar.style.display = "";
}

async function fetchStats(sessionId) {
  const q = `?t=${encodeURIComponent(TOKEN)}` + (sessionId ? `&session=${encodeURIComponent(sessionId)}` : "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/stats${q}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

// ---------- 视图与会话探测 ----------
// 悬浮条只在聊天对话视图显示：
//   - 更新弹窗是独立窗口但加载同一 index.html（windowKind=update-status）→ 不启动
//   - 设置页是同窗覆盖层（聊天区被 inert 隐藏）→ 隐藏悬浮条
//   - 新建对话（draft）无会话 id → 清缓存、不带 session 查询（显示全 0）

function looksLikeSessionId(v) {
  return typeof v === "string" && /^sess_[\w.-]{6,200}$/.test(v);
}

// 新建对话哨兵：传给 daemon 一个格式合法但必然不存在的会话 id，
// daemon 对显式会话走"查无数据 → 全 0"分支，从而显示全 0 而非上一个对话的数据
const DRAFT_SENTINEL = "sess_draft_empty_00000000-0000-0000-0000-000000000000";

// 会话权威信号：conversation 容器上的 data-session-id（sess_* 或 draft）
function sessionIdFromDom() {
  const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
  if (!pane) return null; // 容器不存在 → 无法判定（交给视图门控）
  const v = pane.getAttribute("data-session-id");
  if (looksLikeSessionId(v)) return v;
  if (v === "draft" || v === "") return DRAFT_SENTINEL; // 新建/空对话
  return null;
}

// 兜底：React fiber 找 taskId（仅当 DOM 属性缺失时）
function sessionIdFromFiber() {
  const region = document.querySelector('[data-testid="v4-composer"], .chat-composer-region');
  if (!region) return null;
  const anchors = [region.querySelector("textarea"), region].filter(Boolean);
  for (const el of anchors) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? el[key] : null;
    let hops = 0;
    while (fiber && hops < 80) {
      const props = fiber.memoizedProps;
      if (props) {
        const v = props.taskId ?? props.activeTaskId;
        if (looksLikeSessionId(v)) return v;
      }
      fiber = fiber.return;
      hops++;
    }
  }
  return null;
}

// 返回 { visible, sessionId }
//   visible=false → 不在聊天视图（设置/其他），悬浮条应隐藏
//   sessionId      → sess_* 或 null（无会话/新建对话 → 不带 session 查询）
function resolveViewState() {
  // 设置页开着，或聊天区被 inert 覆盖 → 不可见
  if (document.querySelector('[data-testid="settings-page"]')) return { visible: false, sessionId: null };
  if (document.querySelector('[data-root-workspace-surface="inert"]')) return { visible: false, sessionId: null };

  const composer = document.querySelector('[data-testid="v4-composer"]');
  if (!composer || composer.offsetParent === null || composer.getBoundingClientRect().height === 0) {
    // 无 composer 或不可见（可能在其他视图/隐藏）→ 隐藏
    return { visible: false, sessionId: null };
  }

  // 聊天视图可见：解析会话
  const fromDom = sessionIdFromDom();
  if (fromDom === DRAFT_SENTINEL) return { visible: true, sessionId: DRAFT_SENTINEL }; // 新建对话 → 全 0
  if (looksLikeSessionId(fromDom)) return { visible: true, sessionId: fromDom };

  // DOM 属性缺失 → fiber 兜底
  const fromFiber = sessionIdFromFiber();
  if (fromFiber) return { visible: true, sessionId: fromFiber };

  // 都拿不到 → 视为无会话（不沿用缓存，避免显示上一个对话）
  return { visible: true, sessionId: DRAFT_SENTINEL };
}

// 给输入框下方腾出悬浮条空间：内联样式优先级最高、必定生效。
// React 重渲染可能清掉非受控内联属性，因此每次 tick 幂等补设。
function ensureComposerSpace() {
  try {
    const composer = document.querySelector('[data-testid="v4-composer"]');
    if (composer && composer.style.marginBottom !== "36px") {
      composer.style.marginBottom = "36px";
    }
  } catch {}
}

// 动态定位：悬浮条放在聊天输入框**下方**的留白区内（输入框通过
// margin-bottom 腾出 36px 空间），水平方向与输入框对齐居中——互不遮挡。
// 输入框多行变高时整体上移，悬浮条跟随；输入框不可见时回退贴底居中。
function placeBar() {
  if (!bar) return;
  try {
    const composer = document.querySelector('[data-testid="v4-composer"]');
    if (composer) {
      const r = composer.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 0 && r.bottom <= window.innerHeight + 40) {
        // 垂直：紧贴输入框底边之下（留白区内，再留 2px 间隙）
        bar.style.bottom = Math.max(4, Math.round(window.innerHeight - r.bottom + 2)) + "px";
        // 水平：与输入框中心对齐（而非窗口中心）
        bar.style.left = Math.round(r.left + r.width / 2) + "px";
        bar.style.transform = "translateX(-50%)";
        return;
      }
    }
  } catch {}
  // 回退：窗口底部居中
  bar.style.left = "50%";
  bar.style.transform = "translateX(-50%)";
  bar.style.bottom = "8px";
}

// 不再跨会话沿用 lastSessionId 缓存：新建对话/无会话时用 DRAFT_SENTINEL 强制全 0
async function tick() {
  if (!bar || !bar.isConnected) {
    bar = buildBar();
    document.body.appendChild(bar);
    setWaitState();
    bar.style.display = "";
  }
  if (document.hidden) return;

  const view = resolveViewState();
  if (!view.visible) {
    bar.style.display = "none"; // 设置页/非聊天视图 → 隐藏
    return;
  }
  ensureComposerSpace(); // 先保证输入框下方有留白，再定位悬浮条
  placeBar();

  const data = await fetchStats(view.sessionId);
  if (data) {
    failCount = 0;
    render(data);
    bar.style.display = "";
  } else {
    failCount++;
    setWaitState();
    bar.style.display = "";
  }
  reportDiag(view);
}

// 诊断上报（排障用）：把 renderer 内部状态发给 daemon 写日志，每 15s 一次
let lastDiagAt = 0;
function reportDiag(view) {
  const now = Date.now();
  if (now - lastDiagAt < 15000) return;
  lastDiagAt = now;
  try {
    const composers = [...document.querySelectorAll('[data-testid="v4-composer"]')].map((el, i) => {
      const r = el.getBoundingClientRect();
      let computedMB = "";
      try { computedMB = getComputedStyle(el).marginBottom; } catch {}
      return {
        i,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        h: Math.round(r.height),
        inlineMB: el.style.marginBottom || "",
        computedMB,
        visible: !!el.offsetParent,
      };
    });
    const b = bar ? bar.getBoundingClientRect() : null;
    const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
    const payload = JSON.stringify({
      kind: new URLSearchParams(location.search).get("windowKind"),
      composerCount: composers.length,
      composers,
      bar: b
        ? {
            bottomGap: Math.round(window.innerHeight - b.bottom),
            left: Math.round(b.left),
            w: Math.round(b.width),
            h: Math.round(b.height),
          }
        : null,
      settingsOpen: !!document.querySelector('[data-testid="settings-page"]'),
      paneSessionId: pane ? pane.getAttribute("data-session-id") : null,
      view,
    });
    fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/diag?t=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" }, // 简单请求，免 CORS 预检
      body: payload,
    }).catch(() => {});
  } catch {}
}

function start() {
  // 窗口级门控：更新弹窗是独立 BrowserWindow 但加载同一 index.html，
  // 通过 windowKind=update-status 识别并直接不启动（该窗口不显示悬浮条）
  try {
    if (new URLSearchParams(location.search).get("windowKind") === "update-status") return;
  } catch {}

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  bar = buildBar();
  document.body.appendChild(bar);
  setWaitState();
  bar.style.display = "";

  setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("resize", placeBar);
  tick();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
