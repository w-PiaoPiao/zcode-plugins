// daemon.mjs — 会话统计 HTTP 守护进程（127.0.0.1，仅供本机渲染器状态栏读取）
//
// 职责：
//   1. 周期性从 db.sqlite 聚合当前会话统计（默认 1s）
//   2. GET /v1/stats  返回 JSON（token 鉴权；CORS 只回显请求方 Origin，不给通配符）
//   3. 常驻：随 ZCode 存活（ZCode 退出后自动退出），由 hook 兜底拉起
//
// 鉴权：token 存于 RUNTIME_DIR/daemon-token（0600，install.sh 生成；缺失时自动生成）。
//       状态栏用 ?t= 传参（补丁时烘焙同一 token），CLI 用 x-zcstats-token 头传递；
//       同时校验 Host 头防 DNS rebinding。浏览器里任意网页（无 token）一律 403。
// 启动：node daemon.mjs  （PORT / DB_PATH / POINTER_PATH 可用环境变量覆盖）

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { computeSessionStats, DEFAULT_DB_PATH, DEFAULT_POINTER_PATH } from "../core/stats-core.mjs";

const pExecFile2 = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(__dirname, "..");

const PORT = Number(process.env.ZC_STATS_PORT || 47771);
const DB_PATH = process.env.ZC_STATS_DB || DEFAULT_DB_PATH;
const POINTER_PATH = process.env.ZC_STATS_POINTER || DEFAULT_POINTER_PATH;
const POLL_MS = Number(process.env.ZC_STATS_POLL_MS || 1000);
const LOG = path.join(RUNTIME_DIR, "daemon.log");
const TOKEN_FILE = path.join(RUNTIME_DIR, "daemon-token");
// daemon 自身 pid 文件（install.sh/uninstall.sh 用它在重启/卸载时精确停掉本 daemon）
const DAEMON_PID_FILE = path.join(RUNTIME_DIR, "daemon.pid");
// ZCode 的 app.asar 路径（install.sh 通过 ZC_STATS_ASAR 注入），用于探活匹配
const ASAR_APP_PATH = process.env.ZC_STATS_ASAR || "";

function log(...args) {
  try {
    try {
      if (fs.statSync(LOG).size > 1_000_000) fs.renameSync(LOG, LOG + ".old"); // 超过 1MB 轮转一次
    } catch {}
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(" ")}\n`);
  } catch {}
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function ensureToken() {
  if (readToken()) return;
  try {
    fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    log("token file missing — generated a new one");
  } catch {}
}

function tokenOk(provided) {
  const expected = readToken();
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hostOk(req) {
  const h = String(req.headers.host || "").toLowerCase();
  return /^127\.0\.0\.1(:\d+)?$/.test(h) || /^localhost(:\d+)?$/.test(h) || /^\[::1\](:\d+)?$/.test(h);
}

// CORS 只回显请求方 Origin（走到这里说明已通过 token 校验），绝不返回通配符
function writeCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "null");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

let cache = { available: false, reason: "warming-up", generatedAt: 0 };
let dbMissingLogged = false;

async function refresh() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      if (!dbMissingLogged) {
        log("db not found:", DB_PATH);
        dbMissingLogged = true;
      }
      cache = { available: false, reason: "db-not-found", generatedAt: Date.now() };
      return;
    }
    dbMissingLogged = false;
    cache = await computeSessionStats({ dbPath: DB_PATH, pointerPath: POINTER_PATH });
  } catch (err) {
    log("refresh error:", err?.message || err);
    cache = { available: false, reason: "query-error", error: String(err?.message || err), generatedAt: Date.now() };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  // Host 校验防 DNS rebinding；token 校验防浏览器任意网页/无关进程读取
  if (!hostOk(req) || !tokenOk(url.searchParams.get("t") || req.headers["x-zcstats-token"])) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (req.method === "OPTIONS") {
    writeCORS(req, res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  if (url.pathname === "/v1/health") {
    writeCORS(req, res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: process.pid, version: 2 }));
    return;
  }
  if (url.pathname === "/v1/stats") {
    writeCORS(req, res);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    const wantSession = url.searchParams.get("session");
    if (wantSession && /^[\w:-]{1,200}$/.test(wantSession)) {
      // 显式会话（状态栏按当前窗口/标签的 taskId 查询）：即时计算
      try {
        const data = await computeSessionStats({
          dbPath: DB_PATH,
          pointerPath: POINTER_PATH,
          sessionId: wantSession,
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        log("explicit stats error:", err?.message || err);
        res.end(JSON.stringify({ available: false, reason: "query-error" }));
      }
      return;
    }
    res.end(JSON.stringify(cache));
    return;
  }
  res.writeHead(404);
  res.end();
});

// 单实例：端口被占用（旧守护进程在跑）则直接退出
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log("port in use, another daemon is running — exit");
    process.exit(0);
  }
  log("server error:", err?.message || err);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  log(`daemon started on 127.0.0.1:${PORT} pid=${process.pid} db=${DB_PATH}`);
  try {
    fs.writeFileSync(DAEMON_PID_FILE, String(process.pid)); // 供 install/uninstall 定位本 daemon
  } catch {}
  ensureToken();
  refresh();
  setInterval(refresh, POLL_MS).unref();
});

// ZCode 消失退出（常驻策略）
// 实时检测 ZCode 是否在运行（不依赖可能过期的 zcode.pid）：
//   macOS/Linux —— 用 pgrep 找命令行带 <asar>/app.asar 的 renderer 进程（其父进程即主进程，
//                   或直接认定 renderer 存在即 ZCode 在跑）
//   Windows     —— tasklist 查 ZCode.exe
// 找不到时连续累计 3 次（约 90s）才退出。检测工具缺失时保守常驻，不误判退出。
let zcodeGoneChecks = 0;
setInterval(async () => {
  try {
    const alive = await zcodeRunning();
    zcodeGoneChecks = alive ? 0 : zcodeGoneChecks + 1;
    if (zcodeGoneChecks >= 3) {
      log("ZCode not running — exit");
      process.exit(0);
    }
  } catch {
    zcodeGoneChecks++;
    if (zcodeGoneChecks >= 3) {
      log("ZCode not running — exit");
      process.exit(0);
    }
  }
}, 30_000).unref();

// ZCode 是否在运行（跨平台实时检测）
async function zcodeRunning() {
  if (process.platform === "win32") {
    const { stdout } = await pExecFile2("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/NH"]);
    return /ZCode\.exe/i.test(stdout);
  }
  // macOS/Linux：renderer 进程的命令行带 <app>/Resources/app.asar 的 --app-path，
  // 是 ZCode 在跑的可靠信号（主进程 argv[0] 会被重写成裸 "ZCode"，不可靠）。
  if (ASAR_APP_PATH) {
    try {
      const { stdout } = await pExecFile2("/usr/bin/pgrep", ["-f", "--", `${ASAR_APP_PATH}`]);
      if (stdout.trim()) return true;
    } catch {}
  }
  // 无 asar 锚点或上面没匹配到：宽松匹配兜底（有 ZCode 相关进程即认为在跑）
  try {
    const { stdout } = await pExecFile2("/usr/bin/pgrep", ["-f", "ZCode"]);
    if (stdout.trim()) return true;
  } catch {
    return false;
  }
  return false;
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
