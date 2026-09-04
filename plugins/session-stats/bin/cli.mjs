// cli.mjs — 会话统计命令行（/stats 命令与人工排查用）
//
// 优先读守护进程缓存；不可用则直接查库。
// 用法：node cli.mjs [--json] [--session <id>]

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSessionStats } from "../core/stats-core.mjs";

const PORT = Number(process.env.ZC_STATS_PORT || 47771);
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(RUNTIME_DIR, "daemon-token");

function fetchStats() {
  return new Promise((resolve) => {
    // daemon 有 token 鉴权：从运行时目录读 token（0600），CLI 以请求头传递
    const headers = {};
    try {
      const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (token) headers["x-zcstats-token"] = token;
    } catch {}
    const req = http.get(
      { host: "127.0.0.1", port: PORT, path: "/v1/stats", timeout: 2000, headers },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function fmtTokens(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : k.toFixed(1)) + "K";
  }
  return (n / 1_000_000).toFixed(2) + "M";
}

function fmtDur(ms) {
  if (ms == null || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function pretty(s) {
  if (!s || !s.available) {
    return "暂无会话统计数据。\n提示：先在 ZCode 里发送一条消息，等一轮对话完成后再试。";
  }
  const t = s.totals;
  const lines = [];
  lines.push(`会话：${s.session.title || s.session.id}`);
  if (s.session.directory) lines.push(`目录：${s.session.directory}`);
  if (s.live) lines.push(`状态：⟳ 进行中（已 ${fmtDur(Date.now() - s.live.since)}）`);
  lines.push("");
  lines.push(
    [
      `${t.turns} 轮`,
      `${t.steps} 步`,
      `LLM ${fmtDur(t.llmMs)}`,
      `首 token 平均 ${t.avgTtftMs != null ? (t.avgTtftMs / 1000).toFixed(2) + "s" : "—"}`,
      `${t.tokPerSec} tok/s`,
      `缓存命中 ${t.cacheHitPct != null ? t.cacheHitPct + "%" : "—"}`,
      `输入 ${fmtTokens(t.inputTokens)} tok`,
      `输出 ${fmtTokens(t.outputTokens)} tok`,
    ].join("  |  ")
  );
  lines.push(
    `工具调用 ${t.toolCalls} 次（失败 ${t.toolErrors}）· 请求 ${t.attempts} 次（重试 ${t.retries}）· 模型 ${t.model || "—"} · 上下文 ≈ ${fmtTokens(t.contextTokens)} tok`
  );
  if (s.turns?.length) {
    lines.push("");
    lines.push("最近轮次：");
    lines.push("  # | 状态 | LLM 耗时 | 首 token | 步数 | 输入 | 输出");
    s.turns.forEach((r, i) => {
      lines.push(
        `  ${i + 1} | ${r.isRunning ? "进行中" : "完成"} | ${fmtDur(r.llmMs)} | ${
          r.ttftMs != null ? (r.ttftMs / 1000).toFixed(2) + "s" : "—"
        } | ${r.steps} | ${fmtTokens(r.inputTokens)} | ${fmtTokens(r.outputTokens)}`
      );
    });
  }
  return lines.join("\n");
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sessionIdx = args.indexOf("--session");
let sessionId;
if (sessionIdx >= 0) {
  const v = args[sessionIdx + 1];
  if (!v || v.startsWith("--")) {
    console.error("用法: node cli.mjs [--json] [--session <session_id>]");
    process.exit(1);
  }
  sessionId = v;
}

let stats = sessionId ? null : await fetchStats();
if (!stats) {
  stats = await computeSessionStats(sessionId ? { sessionId } : {});
}
if (asJson) {
  console.log(JSON.stringify(stats, null, 2));
} else {
  console.log(pretty(stats));
}
