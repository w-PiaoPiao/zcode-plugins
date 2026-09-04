// daemon.mjs — 会话统计 HTTP 守护进程（127.0.0.1，仅供本机渲染器状态栏读取）
//
// 职责：
//   1. 周期性从 db.sqlite 聚合当前会话统计（默认 1s）
//   2. GET /v1/stats  返回 JSON（token 鉴权；CORS 只回显请求方 Origin，不给通配符）
//   3. 自愈：ZCode 退出且长期空闲后自动退出，由 hook 在下次会话时重新拉起
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
const IDLE_EXIT_MS = 30 * 60 * 1000; // 30 分钟无请求则退出（hook 会重新拉起）
const LOG = path.join(RUNTIME_DIR, "daemon.log");
const TOKEN_FILE = path.join(RUNTIME_DIR, "daemon-token");

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
let lastHitAt = Date.now();
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
  lastHitAt = Date.now();
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
  ensureToken();
  refresh();
  setInterval(refresh, POLL_MS).unref();
});

// 空闲退出 + ZCode 消失退出
let zcodeGoneChecks = 0;
setInterval(async () => {
  if (Date.now() - lastHitAt > IDLE_EXIT_MS) {
    log("idle timeout — exit");
    process.exit(0);
  }
  try {
    const { stdout } = await pExecFile2("/usr/bin/pgrep", ["-f", "ZCode.app"]);
    zcodeGoneChecks = stdout.trim() ? 0 : zcodeGoneChecks + 1;
    if (zcodeGoneChecks >= 3) {
      log("ZCode.app not running — exit");
      process.exit(0);
    }
  } catch {
    // pgrep 无匹配时非零退出码
    zcodeGoneChecks++;
    if (zcodeGoneChecks >= 3) {
      log("ZCode.app not running — exit");
      process.exit(0);
    }
  }
}, 30_000).unref();

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
