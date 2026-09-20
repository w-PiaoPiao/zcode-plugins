// stats-core.mjs — 从 ZCode 本地数据库聚合会话统计（只读，零依赖）
//
// 数据来源：~/.zcode/cli/db/db.sqlite
//   model_usage  每次模型请求一行、请求结束即写入（实时）：
//                query_source 区分 main_turn / subagent / session_title
//                logical_request_id 同一逻辑请求的重试共享；parent_user_message_id 标识所属轮
//   turn_usage   每轮聚合（轮结束后才落盘；本插件当前未读取，历史轮列表直接聚合 model_usage）
//   tool_usage   每次工具调用一行
//   session      会话元信息
//
// 口径（与 DeepSeek 对话框信息栏对齐，另加扩展项）：
//   轮   = COUNT(DISTINCT parent_user_message_id)  —— 用户消息触发的轮
//   步   = COUNT(DISTINCT logical_request_id)      —— 智能体循环里的模型请求步数
//   LLM  = SUM(duration_ms)                        —— 纯模型耗时（含重试，不含工具执行）
//   工具 = SUM(duration_ms where completed)        —— 工具调用用时（并行调用按时长求和，与官方折算一致）
//   首 token = 请求级 TTFT 均值（对齐 DeepSeek 官方「首 token 平均」口径）
//   tok/s    = 总输出 / (总耗时 - 总 TTFT)
//   缓存命中 = cache_read / (input + cache_write)  —— input 为含缓存读的总输入
//   上下文   = 最近一次已完成主轮请求的 input_tokens（含缓存读）÷ 模型上下文窗口
//              （窗口来自 ZCode 的模型配置，见 resolveContextWindow）
//
// 所有查询走 node:sqlite（Node 22.5+ 内置），以只读模式打开，不影响运行中的 ZCode。
// 跨平台：macOS/Linux/Windows 均无需外部 sqlite3（Windows 无系统 sqlite3，
// 统一用 node:sqlite 彻底消除平台差异；Node 22.5 前或禁用时自动退回快照+外部 sqlite3）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
const require = createRequire(import.meta.url);

export const DEFAULT_DB_PATH = path.join(os.homedir(), ".zcode/cli/db/db.sqlite");
export const DEFAULT_POINTER_PATH = path.join(
  os.homedir(),
  ".zcode/session-stats/current-session.json"
);

const SQLITE_BIN = process.platform === "win32" ? "sqlite3.exe" : "sqlite3"; // 外部 sqlite3（仅兜底）
// 环境显式禁用 node:sqlite 时退回外部 sqlite3（供调试/特殊环境），且不触发 require
const USE_NODE_SQLITE =
  process.env.ZC_STATS_FORCE_SQLITE3 !== "1" && (() => {
    try {
      require("node:sqlite");
      return true;
    } catch {
      return false;
    }
  })();

let DatabaseSync = null;
if (USE_NODE_SQLITE) {
  ({ DatabaseSync } = require("node:sqlite"));
}

// ---------- 查询核心（同步，node:sqlite）----------

function querySqlNode(dbPath, statements) {
  const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
  try {
    // ZCode 运行中会写库，Windows 上并发比 macOS 严格，读前先给足等待避免
    // "database is locked"（daemon.log 已实际出现过）
    db.exec("PRAGMA busy_timeout = 5000");
    return statements.map((sql) => db.prepare(sql).all());
  } finally {
    db.close();
  }
}

// 兜底快照：node:sqlite 不可用时用外部 sqlite3 .backup 做一致性快照
async function snapshotDb(dbPath) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcstats-"));
    const tmp = path.join(dir, path.basename(dbPath));
    await pExecFile(
      SQLITE_BIN,
      ["-cmd", ".timeout 2000", `file:${dbPath}?mode=ro`, `.backup ${tmp}`],
      { timeout: 8000, windowsHide: true }
    );
    return tmp;
  } catch {
    return null;
  }
}

async function querySql(dbPath, statements) {
  if (USE_NODE_SQLITE) {
    try {
      return querySqlNode(dbPath, statements);
    } catch (err) {
      // 只读打开失败（如 -shm 缺失/被占用）→ 一致性快照后重试（node:sqlite 同样受益）
      const snap = await snapshotDb(dbPath);
      if (!snap) throw err;
      try {
        return querySqlNode(snap, statements);
      } finally {
        fs.rmSync(path.dirname(snap), { recursive: true, force: true });
      }
    }
  }
  // 无 node:sqlite → 外部 sqlite3 -json 子进程（原实现）
  const args = ["-json", "-cmd", ".timeout 2000", `file:${dbPath}?mode=ro`, ...statements];
  try {
    const { stdout } = await pExecFile(SQLITE_BIN, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 8000,
      windowsHide: true,
    });
    return parseMultiJson(stdout);
  } catch (err) {
    const snap = await snapshotDb(dbPath);
    if (!snap) throw err;
    try {
      const { stdout } = await pExecFile(
        SQLITE_BIN,
        ["-json", "-cmd", ".timeout 2000", snap, ...statements],
        { maxBuffer: 16 * 1024 * 1024, timeout: 8000, windowsHide: true }
      );
      return parseMultiJson(stdout);
    } finally {
      fs.rmSync(path.dirname(snap), { recursive: true, force: true });
    }
  }
}

function parseMultiJson(stdout) {
  const docs = [];
  let depth = 0,
    start = -1,
    inStr = false,
    esc = false;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          docs.push(JSON.parse(stdout.slice(start, i + 1)));
        } catch {
          docs.push([]);
        }
        start = -1;
      }
    }
  }
  return docs;
}

// ---------- 会话指针 ----------

export function readPointer(pointerPath = DEFAULT_POINTER_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    return j && typeof j.session_id === "string" ? j : null;
  } catch {
    return null;
  }
}

export function writePointer(sessionId, event, pointerPath = DEFAULT_POINTER_PATH) {
  const dir = path.dirname(pointerPath);
  fs.mkdirSync(dir, { recursive: true });
  const data = {
    session_id: sessionId,
    event,
    ts: Date.now(),
    updated_at: new Date().toISOString(),
  };
  const tmp = pointerPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, pointerPath);
}

function sqlQuote(s) {
  return String(s).replace(/'/g, "''");
}

// 会话解析结果短缓存：指针文件内容不变时 5s 内直接复用，
// 把后台每秒轮询的 sqlite3 spawn 从 ~4-9 次降到 ~1 次
const resolveCache = new Map(); // key: dbPath\0pointerPath -> { raw, sessionId, ts }

async function resolveSessionId(dbPath, pointerPath) {
  const pointer = readPointer(pointerPath);
  const raw = pointer ? JSON.stringify(pointer) : "";
  const key = `${dbPath}\u0000${pointerPath}`;
  const cached = resolveCache.get(key);
  if (cached && cached.raw === raw && Date.now() - cached.ts < 5000) return cached.sessionId;
  const candidates = [];
  if (pointer?.session_id) candidates.push(pointer.session_id);
  // sess_subagent% 前缀是 ZCode 当前约定；若上游改名，子代理会话可能被选为“最近活跃”
  const docs = await querySql(dbPath, [
    `SELECT id FROM session WHERE id NOT LIKE 'sess_subagent%' ORDER BY time_updated DESC LIMIT 5`,
  ]);
  for (const row of docs[0] || []) candidates.push(row.id);
  let resolved = null;
  for (const id of candidates) {
    const check = await querySql(dbPath, [
      `SELECT 1 AS ok FROM model_usage WHERE session_id='${sqlQuote(id)}' LIMIT 1`,
    ]);
    if ((check[0]?.length ?? 0) > 0) {
      resolved = id;
      break;
    }
  }
  resolveCache.set(key, { raw, sessionId: resolved, ts: Date.now() });
  return resolved;
}

// ---------- 模型上下文窗口 ----------
//
// 上下文占用（对齐 DeepSeek Harness 的 contextPressure 口径）需要「已用 ÷ 窗口」，
// 窗口值 ZCode 自己存在两处可按 modelId 查到（都是本机文件，无需外部依赖）：
//   1. ~/.zcode/v2/provider_config.json 的 modelConfigRules.providerModelRules
//      —— 用户/服务端下发的模型设置，providerId + modelId 精确匹配
//   2. ~/.zcode/v2/runtime/provider/<平台-架构>/<版本>/endpoint-*/zcode-builtin.json
//      的 modelConfigRules.modelRules —— 内置模型默认表，按 modelMatch 正则匹配
//      （后写覆盖先写，与 ZCode 配置合并惯例一致），取版本号最大的 runtime 目录
// 两处都查不到窗口值时不上报上下文占用（渲染端据此隐藏圆环，与官方
// contextOccupancy 在无容量时不渲染的行为一致）。

const PROVIDER_CONFIG_PATH = path.join(os.homedir(), ".zcode/v2/provider_config.json");
const RUNTIME_PROVIDER_DIR = path.join(os.homedir(), ".zcode/v2/runtime/provider");

const jsonCache = new Map(); // path -> { mtimeMs, size, json }

function readJsonCached(p) {
  try {
    const st = fs.statSync(p);
    const hit = jsonCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.json;
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    jsonCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, json });
    return json;
  } catch {
    return null;
  }
}

function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const d = String(pa[i] ?? "").localeCompare(String(pb[i] ?? ""));
      if (d !== 0) return d;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

let builtinScan = { at: 0, file: null };

// 版本目录会随 ZCode 升级累积，取版本号最大且含 endpoint-*/zcode-builtin.json 的那个
function builtinConfigFile() {
  const now = Date.now();
  if (builtinScan.file !== null && now - builtinScan.at < 30000) return builtinScan.file;
  let best = null;
  let bestVer = null;
  try {
    for (const plat of fs.readdirSync(RUNTIME_PROVIDER_DIR, { withFileTypes: true })) {
      if (!plat.isDirectory()) continue;
      const platDir = path.join(RUNTIME_PROVIDER_DIR, plat.name);
      let versions = [];
      try {
        versions = fs.readdirSync(platDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ver of versions) {
        if (!ver.isDirectory()) continue;
        if (bestVer !== null && cmpVersion(ver.name, bestVer) <= 0) continue;
        const verDir = path.join(platDir, ver.name);
        let eps = [];
        try {
          eps = fs.readdirSync(verDir);
        } catch {
          continue;
        }
        const ep = eps.find((n) => n.startsWith("endpoint-"));
        if (!ep) continue;
        const f = path.join(verDir, ep, "zcode-builtin.json");
        if (!fs.existsSync(f)) continue;
        best = f;
        bestVer = ver.name;
      }
    }
  } catch {}
  builtinScan = { at: now, file: best };
  return best;
}

function contextWindowFromProviderConfig(modelId, providerId) {
  const rules = readJsonCached(PROVIDER_CONFIG_PATH)?.config?.modelConfigRules?.providerModelRules;
  if (!Array.isArray(rules)) return null;
  const pick = (r) => {
    const w = r?.config?.properties?.contextWindow;
    return Number.isFinite(w) && w > 0 ? w : null;
  };
  if (providerId) {
    for (const r of rules) {
      if (r?.providerId === providerId && r?.modelId === modelId) {
        const w = pick(r);
        if (w) return w;
      }
    }
  }
  for (const r of rules) {
    if (r?.modelId === modelId) {
      const w = pick(r);
      if (w) return w;
    }
  }
  return null;
}

function contextWindowFromBuiltin(modelId) {
  const f = builtinConfigFile();
  if (!f) return null;
  const rules = readJsonCached(f)?.config?.modelConfigRules?.modelRules;
  if (!Array.isArray(rules)) return null;
  let hit = null;
  for (const r of rules) {
    const w = r?.config?.properties?.contextWindow;
    if (!Number.isFinite(w) || w <= 0) continue;
    try {
      if (new RegExp(`^(?:${r.modelMatch})$`).test(modelId)) hit = w;
    } catch {}
  }
  return hit;
}

export function resolveContextWindow(modelId, providerId) {
  if (!modelId) return null;
  return contextWindowFromProviderConfig(modelId, providerId) ?? contextWindowFromBuiltin(modelId);
}

// ---------- 统计聚合 ----------

export async function computeSessionStats(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const pointerPath = opts.pointerPath || DEFAULT_POINTER_PATH;
  const explicitSession = !!opts.sessionId;
  // 入口统一校验会话 id 格式（daemon 与 cli 的所有调用方都收口到这里），
  // 后续 SQL 拼接即使漏了 sqlQuote 也不会被注入
  if (opts.sessionId && !/^[\w:-]{1,200}$/.test(opts.sessionId)) {
    return { available: false, reason: "invalid-session" };
  }
  const sessionId = opts.sessionId || (await resolveSessionId(dbPath, pointerPath));
  if (!sessionId) return { available: false, reason: "no-session" };

  const sessDocs = await querySql(dbPath, [
    `SELECT 1 AS ok FROM session WHERE id='${sqlQuote(sessionId)}' LIMIT 1`,
  ]);
  const sessionKnown = sessDocs[0]?.length > 0;
  if (!sessionKnown && !explicitSession) {
    return { available: false, reason: "session-not-found" };
  }

  const SID = sqlQuote(sessionId);
  const docs = await querySql(dbPath, [
    // 0 会话信息
    `SELECT id, title, directory, time_created, time_updated
       FROM session WHERE id='${SID}'`,
    // 1 主轮模型请求聚合（含重试的真实消耗；completed 才有 usage）
    `SELECT COUNT(DISTINCT parent_user_message_id) AS turns,
            COUNT(DISTINCT logical_request_id) AS steps,
            COUNT(*) AS attempts,
            SUM(status='running') AS running_now,
            SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running_rows,
            COALESCE(MIN(CASE WHEN status='running' THEN started_at END),0) AS live_since,
            COALESCE(SUM(CASE WHEN status='completed' THEN duration_ms END),0) AS llm_ms,
            COALESCE(SUM(CASE WHEN status='completed' THEN input_tokens END),0) AS m_in,
            COALESCE(SUM(CASE WHEN status='completed' THEN output_tokens END),0) AS m_out,
            COALESCE(SUM(CASE WHEN status='completed' THEN cache_read_input_tokens END),0) AS m_cread,
            COALESCE(SUM(CASE WHEN status='completed' THEN cache_creation_input_tokens END),0) AS m_cwrite,
            COALESCE(SUM(CASE WHEN status='completed' THEN time_to_first_token_ms END),0) AS ttft_sum,
            SUM(CASE WHEN status='completed' AND time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_n,
            MAX(started_at) AS last_started_at
       FROM model_usage WHERE session_id='${SID}' AND query_source='main_turn'`,
    // 2 最近一次请求（上下文占用 + 当前模型：模型 + provider 用于查上下文窗口）
    `SELECT model_id, provider_id, input_tokens, output_tokens, duration_ms, time_to_first_token_ms, started_at, status
       FROM model_usage
      WHERE session_id='${SID}' AND query_source='main_turn' AND status='completed'
      ORDER BY started_at DESC LIMIT 1`,
    // 3 工具调用聚合（用时只统计已完成的调用）
    `SELECT COUNT(*) AS tool_calls, COALESCE(SUM(status='error'),0) AS tool_errors,
            COALESCE(SUM(CASE WHEN status='completed' THEN duration_ms END),0) AS tool_ms
       FROM tool_usage WHERE session_id='${SID}'`,
    // 4 最近轮列表（按所属用户消息聚合；进行中的轮也展示）
    `SELECT parent_user_message_id AS msg_id,
            MIN(turn_id) AS turn_id,
            MIN(started_at) AS started_at,
            MAX(CASE WHEN completed_at IS NOT NULL THEN completed_at END) AS completed_at,
            MAX(CASE WHEN status='running' THEN 1 ELSE 0 END) AS is_running,
            SUM(CASE WHEN status='completed' THEN duration_ms ELSE 0 END) AS llm_ms,
            COUNT(DISTINCT logical_request_id) AS steps,
            COALESCE(SUM(CASE WHEN status='completed' THEN input_tokens END),0) AS input_tokens,
            COALESCE(SUM(CASE WHEN status='completed' THEN output_tokens END),0) AS output_tokens,
            COALESCE(SUM(CASE WHEN status='completed' THEN time_to_first_token_ms END),0) AS ttft_sum,
            SUM(CASE WHEN status='completed' AND time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_n
       FROM model_usage
      WHERE session_id='${SID}' AND query_source='main_turn' AND parent_user_message_id IS NOT NULL
      GROUP BY parent_user_message_id
      ORDER BY started_at DESC LIMIT 6`,
  ]);

  const [sessRows, aggRows, lastRows, toolRows, turnRows] = docs;
  const sess = sessRows?.[0] || null;
  const a = aggRows?.[0] || {};
  const last = lastRows?.[0] || null;
  const tools = toolRows?.[0] || {};

  const inputTokens = a.m_in ?? 0;
  const cacheRead = a.m_cread ?? 0;
  const cacheWrite = a.m_cwrite ?? 0;
  const outputTokens = a.m_out ?? 0;
  const llmMs = a.llm_ms ?? 0;
  const avgTtftMs = a.ttft_n > 0 ? Math.round(a.ttft_sum / a.ttft_n) : null;

  const genMs = Math.max(1, llmMs - (a.ttft_sum ?? 0));
  const tokPerSec = outputTokens > 0 ? Math.round((outputTokens * 1000) / genMs) : 0;
  const cacheDenom = inputTokens + cacheWrite;
  const cacheHitPct = cacheDenom > 0 ? Math.round((cacheRead / cacheDenom) * 100) : null;

  const liveRow = (a.running_rows ?? 0) > 0;

  // 上下文占用：已用 = 最近一次已完成主轮请求的 input_tokens（含缓存读，即那次请求的
  // 完整提示词规模）；窗口 = 模型配置里的 contextWindow。缺任一项则三个字段都不给，
  // 渲染端隐藏圆环。
  const contextTokens = last?.input_tokens ?? null;
  const contextWindow = resolveContextWindow(last?.model_id, last?.provider_id);
  const contextPercent =
    contextTokens != null && contextWindow ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : null;

  return {
    available: true,
    version: 1,
    generatedAt: Date.now(),
    session: sess
      ? {
          id: sess.id,
          title: sess.title,
          directory: sess.directory,
          startedAt: sess.time_created,
          lastActiveAt: Math.max(sess.time_updated || 0, a.last_started_at || 0),
        }
      : { id: sessionId },
    live: liveRow
      ? {
          since: a.live_since || Date.now(),
          runningRequests: a.running_now ?? 0,
        }
      : null,
    totals: {
      turns: a.turns ?? 0,
      steps: a.steps ?? 0,
      attempts: a.attempts ?? 0,
      retries: Math.max(0, (a.attempts ?? 0) - (a.steps ?? 0)),
      toolCalls: tools.tool_calls ?? 0,
      toolErrors: tools.tool_errors ?? 0,
      toolMs: tools.tool_ms || null,
      llmMs,
      avgTtftMs,
      tokPerSec,
      cacheHitPct,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      inputTokens,
      outputTokens,
      contextTokens,
      contextWindow,
      contextPercent,
      model: last?.model_id ?? null,
      lastActivityAt: a.last_started_at ?? sess?.time_updated ?? null,
    },
    turns: (turnRows || []).map((r) => ({
      msgId: r.msg_id,
      turnId: r.turn_id,
      isRunning: !!r.is_running,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      llmMs: r.llm_ms,
      ttftMs: r.ttft_n > 0 ? Math.round(r.ttft_sum / r.ttft_n) : null,
      steps: r.steps,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    })),
  };
}
