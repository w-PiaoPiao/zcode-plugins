// session-stats-bar.js — 注入 ZCode 渲染器的会话统计条（双 pill + 弹层）
//
// 由 patch-app.mjs 注入 index.html（<script type="module" src="./assets/session-stats-bar.js">）。
// 职责：
//   1. 在输入框下方留白区渲染一条统计行（对齐 DeepSeek Harness 官方
//      「双图标 pill + 点击弹层」设计）：
//        - 仪表盘 pill：N 轮 M 步 · X tok/s，点击打开「会话统计」弹层
//        - 数据库 pill：紧凑总量 tok · 缓存命中 P%，点击打开「Token 用量」弹层
//        - （不做上下文胶囊：ZCode 输入框自带上下文读数，重复展示已移除）
//   2. 每秒从本地统计守护进程（127.0.0.1:47771/v1/stats）拉取数据并渲染，
//      弹层打开期间随轮询同步刷新
//   3. daemon 未就绪（如 ZCode 刚重启、hook 尚未拉起 daemon）时显示等待占位，
//      一旦就绪立即显示真实指标 —— 永不隐藏
// 弹层交互对齐官方 stat-dialog 模块：portal 到 body、锚定触发器上方、
// 点击外部/Escape 关闭、弹层互斥（同一时刻至多开一个）。
// 数据由 session-stats 插件的守护进程从 ~/.zcode/cli/db/db.sqlite 聚合而来；
// 上下文窗口取自 ZCode 的模型配置（见 core/stats-core.mjs resolveContextWindow）。
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
  gap: 8px;
  max-width: min(96vw, 760px);
  font-size: 11.5px;
  line-height: 16px;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  color: var(--color-foreground-subtle, #71717a);
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  pointer-events: none; /* 容器透明不拦事件，pill 自行恢复 */
}
/* 给输入框下方留出悬浮条空间：输入框整体上移，下方留白由 pill 占用
   （pill 高约 28px：留白 36px = 条体 28 + 上 2 + 下 6） */
[data-testid="v4-composer"] {
  margin-bottom: 36px !important;
}
[data-zcstats-bar] .zcstats-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--color-surface, #ffffff);
  background: color-mix(in srgb, var(--color-surface, #ffffff) 82%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--color-border, #e4e4e7);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
  pointer-events: auto;
  cursor: default;
  min-width: 0;
}
[data-zcstats-bar] .zcstats-pill[data-zcstats-clickable="1"] { cursor: pointer; }
[data-zcstats-bar] .zcstats-pill[data-zcstats-clickable="1"]:hover {
  border-color: var(--color-foreground-subtlest, #a1a1aa);
}
[data-zcstats-bar] .zcstats-pill[data-zcstats-clickable="1"]:hover .zcstats-pill-text {
  color: var(--color-foreground, #18181b);
}
[data-zcstats-bar] .zcstats-pill:focus-visible {
  outline: 2px solid var(--color-accent, #3b82f6);
  outline-offset: 1px;
}
[data-zcstats-bar] .zcstats-pill-icon {
  display: inline-flex;
  color: var(--color-foreground-subtlest, #a1a1aa);
  flex: none;
}
[data-zcstats-bar] .zcstats-pill-text { overflow: hidden; text-overflow: ellipsis; }
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
@keyframes zcstats-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  [data-zcstats-bar].zcstats-live .zcstats-dot,
  [data-zcstats-bar].zcstats-wait .zcstats-dot { animation: none; }
}
/* —— 统计弹层（对齐官方 stat-dialog 皮肤）—— */
[data-zcstats-dialog] {
  position: fixed;
  z-index: 2147483001;
  min-width: 250px;
  max-width: min(92vw, 380px);
  padding: 4px 0 6px;
  border-radius: 12px;
  background: var(--color-surface, #ffffff);
  background: color-mix(in srgb, var(--color-surface, #ffffff) 97%, transparent);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--color-border, #e4e4e7);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.16);
  font-size: 12px;
  line-height: 18px;
  color: var(--color-foreground, #18181b);
  user-select: none;
  -webkit-user-select: none;
}
[data-zcstats-dialog] .zcstats-dialog-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 14px;
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--color-border, #e4e4e7);
  font-weight: 500;
}
[data-zcstats-dialog] .zcstats-dialog-head .zcstats-pill-icon {
  color: var(--color-foreground-subtle, #71717a);
}
[data-zcstats-dialog] .zcstats-dialog-sum {
  margin-left: auto;
  font-weight: 400;
  color: var(--color-foreground-subtle, #71717a);
  font-variant-numeric: tabular-nums;
}
[data-zcstats-dialog] .zcstats-dialog-rows { margin: 0; padding: 7px 14px 5px; }
[data-zcstats-dialog] .zcstats-dialog-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 24px;
  padding: 3.5px 0;
}
[data-zcstats-dialog] .zcstats-dialog-row dt {
  margin: 0;
  color: var(--color-foreground-subtle, #71717a);
}
[data-zcstats-dialog] .zcstats-dialog-row dd {
  margin: 0;
  color: var(--color-foreground, #18181b);
  font-variant-numeric: tabular-nums;
}
`;

// 内联 SVG 图标（currentColor 跟随主题；官方为 IconGaugeOutline16 / IconDatabaseOutline16）
const ICON_GAUGE =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">' +
  '<path d="M2.7 10a5.5 5.5 0 1 1 10.6 0" stroke-linecap="round"/>' +
  '<path d="M8 9.7 10.6 6.9" stroke-linecap="round"/>' +
  '<circle cx="8" cy="9.9" r="1.1" fill="currentColor" stroke="none"/></svg>';
const ICON_DB =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">' +
  '<ellipse cx="8" cy="3.8" rx="5.3" ry="2.1"/>' +
  '<path d="M2.7 3.8v8.4c0 1.16 2.37 2.1 5.3 2.1s5.3-.94 5.3-2.1V3.8"/>' +
  '<path d="M2.7 8c0 1.16 2.37 2.1 5.3 2.1s5.3-.94 5.3-2.1"/></svg>';

let bar = null;
let pills = {}; // { time, usage }
let lastData = null;
let lastViewKey;
let failCount = 0;
let dialog = null; // { root, kind, pill } —— 单槽位即互斥

// ---------- DOM 写入守卫 ----------
// 每秒 tick 一次，但绝大多数 tick 里数值没变。若无条件重写样式/文本，每次写入都会让
// 样式或布局失效，下一次 tick 的 getBoundingClientRect 又要强制重排 —— 白白的每秒开销。
// 下面这些小工具在写入前先与 DOM 现值比较，只写真正变化的部分：稳态下每秒零写入，
// 像素结果与无条件写入完全一致（同值写入本就是 no-op）。

const composerCache = { el: null }; // 输入框元素引用（React 重渲染会让它断开 → 重新查找）
const textElCache = new Map(); // kind -> 文本节点

function composerEl() {
  if (composerCache.el && composerCache.el.isConnected) return composerCache.el;
  composerCache.el = document.querySelector('[data-testid="v4-composer"]');
  return composerCache.el;
}

function pillTextEl(kind) {
  let el = textElCache.get(kind);
  if (!el || !el.isConnected) {
    el = pills[kind]?.querySelector(".zcstats-pill-text");
    if (!el) return null;
    textElCache.set(kind, el);
  }
  return el;
}

function setStyle(el, prop, value) {
  if (el && el.style[prop] !== value) el.style[prop] = value;
}

function setClass(el, name, on) {
  if (el && el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

function fmtTokens(n) {
  if (n == null || isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : k.toFixed(1)) + "K";
  }
  return (n / 1_000_000).toFixed(2) + "M";
}

function fmtExact(n) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-US");
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

// ---------- 口径（对齐 DeepSeek Harness）----------

// 有计时数字才可点开「会话统计」，否则 pill 是静态读数（官方规则：无数字弹层会空）
function hasTiming(t) {
  return !!(t && (t.llmMs > 0 || t.avgTtftMs != null));
}
// 有任何 token 数字才可点开「Token 用量」（官方规则：无 tokenUsage 不渲染用量区）
function hasUsage(t) {
  return !!(
    t &&
    ((t.inputTokens || 0) > 0 ||
      (t.outputTokens || 0) > 0 ||
      (t.cacheReadTokens || 0) > 0 ||
      (t.cacheWriteTokens || 0) > 0)
  );
}
// 计费总量 = 未缓存输入 + 缓存读 + 缓存写 + 输出
// （本插件 inputTokens 为含缓存读的总输入，故不含 cacheRead；与官方口径一致）
function billedTotal(t) {
  return (t.inputTokens || 0) + (t.cacheWriteTokens || 0) + (t.outputTokens || 0);
}
// 缓存命中率展示：>99.5% 显示 100%（官方细则）；denom 与 daemon 口径一致
function cacheHitDisplay(t) {
  if (t.cacheHitPct == null) return null;
  const denom = (t.inputTokens || 0) + (t.cacheWriteTokens || 0);
  if (denom <= 0) return t.cacheHitPct;
  const raw = ((t.cacheReadTokens || 0) / denom) * 100;
  return raw >= 99.5 ? 100 : Math.round(raw);
}

// ---------- pill 构建 ----------

function setPillClickable(el, clickable, label) {
  const wantFlag = clickable ? "1" : null;
  // label 省略时保持既有 aria-label（与旧行为一致：只在传入 label 时改写）
  const wantLabel = label || null;
  // 属性状态已是目标值 → 整块写入可跳过（不可点态的其余属性由本函数成对增删，
  // 故「标记缺失」即可推出它们也不存在；aria-expanded 由 open/closeDialog 维护）
  if (
    el.getAttribute("data-zcstats-clickable") === wantFlag &&
    (wantLabel == null || el.getAttribute("aria-label") === wantLabel)
  ) {
    return;
  }
  if (clickable) {
    el.setAttribute("data-zcstats-clickable", "1");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-haspopup", "dialog");
    if (!el.hasAttribute("aria-expanded")) el.setAttribute("aria-expanded", "false");
  } else {
    el.removeAttribute("data-zcstats-clickable");
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.removeAttribute("aria-haspopup");
    el.removeAttribute("aria-expanded");
  }
  if (wantLabel) el.setAttribute("aria-label", wantLabel);
}

function buildPill(kind, withDot, icon) {
  const el = document.createElement("div");
  el.className = "zcstats-pill";
  el.setAttribute("data-zcstats-pill", kind);
  if (withDot) {
    const dot = document.createElement("span");
    dot.className = "zcstats-dot";
    dot.title = "会话统计";
    el.appendChild(dot);
  }
  const iconSpan = document.createElement("span");
  iconSpan.className = "zcstats-pill-icon";
  iconSpan.innerHTML = icon;
  const text = document.createElement("span");
  text.className = "zcstats-pill-text";
  el.append(iconSpan, text);
  el.addEventListener("click", () => toggleDialog(kind));
  el.addEventListener("keydown", (e) => {
    if (el.getAttribute("data-zcstats-clickable") !== "1") return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleDialog(kind);
    }
  });
  return el;
}

function buildBar() {
  const el = document.createElement("div");
  el.setAttribute("data-zcstats-bar", "");
  el.style.display = "none";
  pills = {
    time: buildPill("time", true, ICON_GAUGE),
    usage: buildPill("usage", false, ICON_DB),
  };
  el.append(pills.time, pills.usage);
  return el;
}

function setPillText(kind, text) {
  const t = pillTextEl(kind);
  if (t && t.textContent !== text) t.textContent = text;
}

function setWaitState() {
  if (!bar) return;
  setClass(bar, "zcstats-wait", true);
  setClass(bar, "zcstats-live", false);
  setStyle(pills.usage, "display", "none");
  setPillText("time", "会话统计 · 等待本地服务…");
  setPillClickable(pills.time, false, "统计守护进程尚未就绪，正在自动重试");
  closeDialog();
}

function render(data) {
  if (!bar) return;
  lastData = data;
  setClass(bar, "zcstats-wait", false);
  const t = data && data.available ? data.totals : null;
  setStyle(pills.usage, "display", "");
  // daemon 可达但无数据（空会话/新会话）：显示全 0，绝不隐藏
  if (!t) {
    setClass(bar, "zcstats-live", false);
    setPillText("time", "0 轮 0 步");
    setPillText("usage", "0 tok · 缓存命中 —");
    setPillClickable(pills.time, false, "会话统计：当前会话暂无统计数据");
    setPillClickable(pills.usage, false, "Token 用量：当前会话暂无统计数据");
    syncOpenDialog();
    setStyle(bar, "display", "");
    return;
  }
  setClass(bar, "zcstats-live", !!data.live);
  if (data.live) {
    // 悬停提示里的「已 Ns」需要随秒走动，故意不做去重
    const dot = bar.querySelector(".zcstats-dot");
    if (dot) dot.title = `进行中 · 已 ${fmtDur(Date.now() - data.live.since)}`;
  }

  const timeClickable = hasTiming(t);
  const tpsText = t.tokPerSec > 0 ? ` · ${t.tokPerSec} tok/s` : "";
  setPillText("time", `${t.turns} 轮 ${t.steps} 步${tpsText}`);
  setPillClickable(
    pills.time,
    timeClickable,
    `会话统计：${t.turns} 轮 ${t.steps} 步${t.tokPerSec > 0 ? `，输出 ${t.tokPerSec} tok/s` : ""}，点击查看详情`
  );

  const p = cacheHitDisplay(t);
  const usageClickable = hasUsage(t);
  setPillText("usage", `${fmtTokens(billedTotal(t))} tok · 缓存命中 ${p != null ? p + "%" : "—"}`);
  setPillClickable(
    pills.usage,
    usageClickable,
    `Token 用量：共 ${fmtExact(billedTotal(t))} tok，缓存命中 ${p != null ? p + "%" : "—"}，点击查看详情`
  );
  syncOpenDialog();
  setStyle(bar, "display", "");
}

// ---------- 统计弹层（对齐官方 stat-dialog：portal / 锚定 / 外点关闭 / 互斥）----------

const DIALOG_META = {
  time: { title: "会话统计" },
  usage: { title: "Token 用量" },
};

function dialogRows(rows) {
  return (
    `<dl class="zcstats-dialog-rows">` +
    rows
      .map(
        ([k, v]) =>
          `<div class="zcstats-dialog-row"><dt>${k}</dt><dd>${v}</dd></div>`
      )
      .join("") +
    `</dl>`
  );
}

function updateDialog() {
  if (!dialog) return;
  const t = lastData && lastData.available ? lastData.totals : null;
  let head;
  let rows;
  if (dialog.kind === "time") {
    head =
      `<span class="zcstats-pill-icon">${ICON_GAUGE}</span><span>会话统计</span>`;
    rows = [
      ["模型用时", fmtDur(t?.llmMs)],
      ["工具调用用时", t?.toolMs != null ? fmtDur(t.toolMs) : "—"],
      ["首 token 平均（TTFT）", fmtSec(t?.avgTtftMs)],
      ["输出速度（TPS）", t && t.tokPerSec > 0 ? `${t.tokPerSec} tok/s` : "—"],
    ];
  } else {
    const total = t ? billedTotal(t) : null;
    const p = t ? cacheHitDisplay(t) : null;
    head =
      `<span class="zcstats-pill-icon">${ICON_DB}</span><span>Token 用量</span>` +
      (total != null
        ? `<span class="zcstats-dialog-sum">${fmtExact(total)} tok</span>`
        : "");
    rows = [
      ["缓存命中", p != null ? p + "%" : "—"],
      ["未缓存输入", t ? `${fmtExact((t.inputTokens || 0) - (t.cacheReadTokens || 0))} tok` : "—"],
      ["缓存读取", t ? `${fmtExact(t.cacheReadTokens || 0)} tok` : "—"],
      ["输出", t ? `${fmtExact(t.outputTokens || 0)} tok` : "—"],
    ];
    // 官方细则：缓存写入为 0 时省略该行
    if (t && (t.cacheWriteTokens || 0) !== 0) {
      rows.push(["缓存写入", `${fmtExact(t.cacheWriteTokens)} tok`]);
    }
  }
  setDialogHtml(`<div class="zcstats-dialog-head">${head}</div>` + dialogRows(rows));
}

// 弹层内容去重：每秒 tick 都会重算一遍，但内容多数时候没变；整段 innerHTML 重写会
// 让弹层内的布局失效、并让随后的 placeDialog() 强制重排，白烧 CPU。
function setDialogHtml(html) {
  if (!dialog) return;
  if (dialog.lastHtml === html) return;
  dialog.lastHtml = html;
  dialog.root.innerHTML = html;
}

// 「上下文容量」弹层已随上下文胶囊一并移除（ZCode 输入框自带上下文读数）。

// 锚定 pill 上方 gap 8px，视口 12px 边距钳制；上方放不下时落下方
function placeDialog() {
  if (!dialog) return;
  const r = dialog.pill.getBoundingClientRect();
  const w = dialog.root.offsetWidth;
  const h = dialog.root.offsetHeight;
  if (!w || !h) return;
  const M = 12;
  const GAP = 8;
  let top = r.top - h - GAP;
  if (top < M) top = r.bottom + GAP;
  if (top + h > window.innerHeight - M) top = Math.max(M, window.innerHeight - M - h);
  let left = r.left + r.width / 2 - w / 2;
  left = Math.min(Math.max(M, left), window.innerWidth - M - w);
  setStyle(dialog.root, "left", Math.round(left) + "px");
  setStyle(dialog.root, "top", Math.round(top) + "px");
}

function openDialog(kind) {
  closeDialog();
  const pill = pills[kind];
  if (!pill || pill.getAttribute("data-zcstats-clickable") !== "1") return;
  const root = document.createElement("div");
  root.setAttribute("data-zcstats-dialog", "");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", DIALOG_META[kind].title);
  root.style.visibility = "hidden"; // 先隐藏挂载测尺寸，再定位（两段式）
  document.body.appendChild(root);
  dialog = { root, kind, pill };
  pill.setAttribute("aria-expanded", "true");
  updateDialog();
  placeDialog();
  root.style.visibility = "visible";
}

function closeDialog() {
  if (!dialog) return;
  dialog.root.remove();
  dialog.pill.removeAttribute("aria-expanded");
  dialog = null;
}

function toggleDialog(kind) {
  if (dialog && dialog.kind === kind) {
    closeDialog();
    return;
  }
  openDialog(kind);
}

// 数据/可点性变化后同步已打开的弹层：pill 失效则关，否则随轮询刷新
function syncOpenDialog() {
  if (!dialog) return;
  const pill = pills[dialog.kind];
  if (
    !pill ||
    pill.getAttribute("data-zcstats-clickable") !== "1" ||
    pill.style.display === "none"
  ) {
    closeDialog();
    return;
  }
  updateDialog();
  placeDialog();
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
// 统计条只在聊天对话视图显示：
//   - 更新弹窗是独立窗口但加载同一 index.html（windowKind=update-status）→ 不启动
//   - 设置页是同窗覆盖层（聊天区被 inert 隐藏）→ 隐藏统计条
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
//   visible=false → 不在聊天视图（设置/其他），统计条应隐藏
//   sessionId      → sess_* 或 null（无会话/新建对话 → 不带 session 查询）
function resolveViewState() {
  // 设置页开着，或聊天区被 inert 覆盖 → 不可见
  if (document.querySelector('[data-testid="settings-page"]')) return { visible: false, sessionId: null };
  if (document.querySelector('[data-root-workspace-surface="inert"]')) return { visible: false, sessionId: null };

  const composer = composerEl();
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

// 给输入框下方腾出统计条空间：内联样式优先级最高、必定生效。
// React 重渲染可能清掉非受控内联属性，因此每次 tick 幂等补设（读的是 DOM 现值，
// 已一致就不写——避免每秒给输入框制造一次样式失效）。
function ensureComposerSpace() {
  try {
    const composer = composerEl();
    if (composer && composer.style.marginBottom !== "36px") {
      composer.style.marginBottom = "36px";
    }
  } catch {}
}

// 动态定位：统计条放在聊天输入框**下方**的留白区内（输入框通过
// margin-bottom 腾出空间），水平方向与输入框对齐居中——互不遮挡。
// 位置公式：条底边 = 留白高度 − 条自身高度 − 2px 间隙，
// 即条顶边贴输入框底边下方 2px（diag 实测修正：此前 +2 方向反了且未减
// 条高度，导致整个叠回输入框内部）。
function placeBar() {
  if (!bar) return;
  try {
    const composer = composerEl();
    if (composer) {
      const r = composer.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 0 && r.bottom <= window.innerHeight + 40) {
        const barH = bar.offsetHeight || 28;
        const spaceBelow = window.innerHeight - r.bottom; // 输入框底边之下的留白高度
        setStyle(bar, "bottom", Math.max(4, Math.round(spaceBelow - barH - 2)) + "px");
        // 水平：与输入框中心对齐（而非窗口中心）
        setStyle(bar, "left", Math.round(r.left + r.width / 2) + "px");
        setStyle(bar, "transform", "translateX(-50%)");
        return;
      }
    }
  } catch {}
  // 回退：窗口底部居中
  setStyle(bar, "left", "50%");
  setStyle(bar, "transform", "translateX(-50%)");
  setStyle(bar, "bottom", "8px");
}

// 不再跨会话沿用 lastSessionId 缓存：新建对话/无会话时用 DRAFT_SENTINEL 强制全 0
async function tick() {
  if (!bar || !bar.isConnected) {
    bar = buildBar();
    document.body.appendChild(bar);
    setWaitState();
    setStyle(bar, "display", "");
  }
  if (document.hidden) return;

  const view = resolveViewState();
  if (!view.visible) {
    setStyle(bar, "display", "none"); // 设置页/非聊天视图 → 隐藏
    closeDialog();
    lastViewKey = undefined;
    return;
  }
  // 会话切换 → 关闭弹层，避免上一会话的明细残留到下一帧刷新
  if (lastViewKey !== undefined && lastViewKey !== view.sessionId) closeDialog();
  lastViewKey = view.sessionId;
  ensureComposerSpace(); // 先保证输入框下方有留白，再定位统计条
  placeBar();

  const data = await fetchStats(view.sessionId);
  if (data) {
    failCount = 0;
    render(data);
  } else {
    failCount++;
    setWaitState();
  }
  setStyle(bar, "display", "");
  reportDiag(view);
}

// 诊断上报（排障用）：把 renderer 内部状态发给 daemon 写日志，每 15s 一次。
// 默认关闭——它会遍历 composer 读 getComputedStyle/getBoundingClientRect，还会在
// daemon.log 里堆积（实测 27 小时 752 行、其中 99% 是它）。排障时打开即可，无需重装：
//   · 渲染器控制台：localStorage.setItem("zcstats:diag", "1")（删除该键即关闭）
//   · 或注入前设 window.__zcstatsDiag = true
function diagEnabled() {
  try {
    if (window.__zcstatsDiag === true) return true;
    return localStorage.getItem("zcstats:diag") === "1";
  } catch {
    return false;
  }
}

let lastDiagAt = 0;
function reportDiag(view) {
  const now = Date.now();
  if (now - lastDiagAt < 15000) return;
  lastDiagAt = now;
  if (!diagEnabled()) return;
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
      dialog: dialog ? dialog.kind : null,
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
  // 通过 windowKind=update-status 识别并直接不启动（该窗口不显示统计条）
  try {
    if (new URLSearchParams(location.search).get("windowKind") === "update-status") return;
  } catch {}

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  bar = buildBar();
  document.body.appendChild(bar);
  setWaitState();
  setStyle(bar, "display", "");

  // 弹层全局关闭：点击面板/触发器之外，或 Escape
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!dialog) return;
      if (dialog.root.contains(e.target) || dialog.pill.contains(e.target)) return;
      closeDialog();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (dialog && e.key === "Escape") closeDialog();
    },
    true
  );

  setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("resize", () => {
    placeBar();
    placeDialog();
  });
  tick();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
