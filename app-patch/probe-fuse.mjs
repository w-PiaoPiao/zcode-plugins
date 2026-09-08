// probe-fuse.mjs — 读取 ZCode.exe 的 Electron fuse 区（v1），打印全部开关状态。
// 用途：判断 NODE_OPTIONS 免补丁注入路线是否可行（fuse 索引 2 = node_options）。
// 用法：node probe-fuse.mjs <exe 路径，缺省自动探测>
import fs from "node:fs";
import path from "node:path";

const exe = process.argv[2] || path.join("C:\\Program Files\\ZCode", "ZCode.exe");
const data = fs.readFileSync(exe);
const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const idx = data.indexOf(SENTINEL, 0, "latin1");
if (idx < 0) {
  console.log("fuse sentinel not found");
  process.exit(1);
}
const base = idx + SENTINEL.length;
const ver = data[base];
const count = data[base + 1];
const NAMES = [
  "RUN_AS_NODE",
  "COOKIE_ENCRYPTION",
  "NODE_OPTIONS",
  "NODE_CLI_INSPECT_ARGS",
  "ASAR_INTEGRITY_VALIDATION",
  "ONLY_LOAD_APP_FROM_ASAR",
];
const STATE = { 48: "DISABLE", 49: "ENABLE", 114: "REMOVED", 144: "INHERIT" };
console.log(`fuseVersion: ${ver}  count: ${count}`);
for (let i = 0; i < count; i++) {
  const s = STATE[data[base + 2 + i]] || `?${data[base + 2 + i]}`;
  console.log(`  ${(NAMES[i] || `fuse${i}`).padEnd(28)} ${s}`);
}
