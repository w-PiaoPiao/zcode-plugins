// set-node-options.mjs — 用户级 NODE_OPTIONS 环境变量的读改写（install/uninstall 共用）
//
// 为什么不用 setx：setx 有 1024 字符截断且不能读回现有值做合并；
// 走 PowerShell [Environment]::SetEnvironmentVariable('...','User') 无截断、可合并。
// 值形如 --require="C:/Users/<name>/.zcode/session-stats/inject-main.cjs"：
//   · 路径用正斜杠——NODE_OPTIONS 的解析器把双引号内的反斜杠当转义符吃掉
//   · 路径含空格必须整体双引号（Node 的 NODE_OPTIONS 解析支持引号值）
//
// 用法：
//   node set-node-options.mjs install --require-file <path>
//   node set-node-options.mjs remove   --require-file <path>
// 识别"我们写的条目"：含 inject-main.cjs 的 --require 条目；用户其余内容原样保留。
import { execFileSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const action = args[0];
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const MARKER = "inject-main.cjs";
const psGet = `[Environment]::GetEnvironmentVariable('NODE_OPTIONS','User')`;
const psSet = (v) =>
  `[Environment]::SetEnvironmentVariable('NODE_OPTIONS',${v ? `'${v.replace(/'/g, "''")}'` : "$null"},'User')`;

const getUser = () => {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", psGet], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const setUser = (v) => {
  execFileSync("powershell", ["-NoProfile", "-Command", psSet(v)], { encoding: "utf8" });
};

// 引号感知分词：--require="..." 是一个条目（引号内可含空格）；其余按空白切
// （兼容修复历史脏数据：旧版本按空格粗暴分词可能留下未闭合的残片，也按条目处理）
function tokenize(v) {
  return v.match(/--require="[^"]*"|--require="[^"]*|--\S+/g) || [];
}

const requireFile = argValue("--require-file");
if ((action !== "install" && action !== "remove") || !requireFile) {
  console.error("usage: set-node-options.mjs install|remove --require-file <path>");
  process.exit(1);
}
const requireEntry = `--require="${path.resolve(requireFile).replace(/\\/g, "/")}"`;
const cur = getUser();

if (action === "install") {
  if (cur === requireEntry) {
    console.log("NODE_OPTIONS already configured (user level)");
    process.exit(0);
  }
  if (cur && !cur.includes(MARKER)) {
    // 用户有自己的 NODE_OPTIONS 且与本文无关 → 追加保留
    setUser(`${cur} ${requireEntry}`);
    console.log("NODE_OPTIONS (user) appended ->", requireEntry);
  } else {
    // 变量为空，或此前由本插件写入（可能含历史脏值）→ 直接覆写为唯一干净条目
    setUser(requireEntry);
    console.log("NODE_OPTIONS (user) set ->", requireEntry);
  }
  process.exit(0);
}

// remove：本插件条目存在则整体清空（我们拥有这个变量的写入权；用户自有内容
// 在 install 时会被保留，所以 remove 清空不会误删——它们的组合从未被我们写入过）
if (!cur.includes(MARKER)) {
  console.log("NODE_OPTIONS not configured (user level)");
  process.exit(0);
}
setUser("");
console.log("NODE_OPTIONS (user) removed");
