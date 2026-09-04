// on-event.mjs — ZCode hook 入口（SessionStart / UserPromptSubmit / Stop）
//
// 职责（必须快进快出，<300ms）：
//   1. 从 stdin JSON / 环境变量里拿 sessionId，写入会话指针文件
//   2. 确保统计守护进程存活（不在则后台拉起，不等待）
// 输出必须为空（hook stdout 会被当作 hook 结果解析）。
//
// 用法：node on-event.mjs <event-name>

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(__dirname, "..");
const POINTER_PATH =
  process.env.ZC_STATS_POINTER || path.join(RUNTIME_DIR, "current-session.json");
const PORT = Number(process.env.ZC_STATS_PORT || 47771);

const event = process.argv[2] || "unknown";

function readStdinJson() {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      try {
        resolve(buf.trim() ? JSON.parse(buf) : null);
      } catch {
        resolve(null);
      }
    };
    if (!process.stdin.readable) return resolve(null);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", done);
    setTimeout(done, 1500).unref(); // 兜底：stdin 迟迟不关也继续
  });
}

function portAlive(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(400, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function ensureDaemon() {
  try {
    if (await portAlive(PORT)) return;
    const daemon = path.join(RUNTIME_DIR, "daemon", "daemon.mjs");
    if (!fs.existsSync(daemon)) return;
    // 低版本 Node 需 --experimental-sqlite 才能用 node:sqlite（≥22.13 已默认开启，加了也无害）
    const args = [];
    try {
      createRequire(import.meta.url)("node:sqlite");
    } catch {
      args.push("--experimental-sqlite");
    }
    args.push(daemon);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {}
}

async function main() {
  const input = await readStdinJson();
  const sessionId =
    (input && input.sessionId) || process.env.ZCODE_SESSION_ID || null;
  if (sessionId) {
    try {
      fs.mkdirSync(path.dirname(POINTER_PATH), { recursive: true });
      fs.writeFileSync(
        POINTER_PATH + ".tmp",
        JSON.stringify({
          session_id: sessionId,
          event,
          ts: Date.now(),
          updated_at: new Date().toISOString(),
        })
      );
      fs.renameSync(POINTER_PATH + ".tmp", POINTER_PATH);
    } catch {}
  }
  await ensureDaemon();
  process.exit(0);
}

main().catch(() => process.exit(0));
