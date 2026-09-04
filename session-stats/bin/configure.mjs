// configure.mjs — 把 hooks / 命令安装进 ZCode 用户配置（或卸载）
//
// 用法：
//   node configure.mjs install  --runtime <dir> --node <nodeAbsPath> [--zcode-dir <dir>]
//   node configure.mjs uninstall [--zcode-dir <dir>]
//
// install 会：
//   1. 在 ~/.zcode/cli/config.json 合并写入 hooks（SessionStart/UserPromptSubmit/Stop）
//   2. 安装 /stats 命令到 ~/.zcode/commands/stats.md（固定运行时路径）
// uninstall 反向移除，保留用户其他配置不动。

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const action = args[0];

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const zcodeDir = argValue("--zcode-dir") || path.join(process.env.HOME, ".zcode");
const configPath = path.join(zcodeDir, "cli", "config.json");
const commandsDir = path.join(zcodeDir, "commands");
const commandFile = path.join(commandsDir, "stats.md");
const MARKER = "zc-session-stats";

// 精确识别本插件写入的 hook 条目（matcher 标记 或 完整 on-event 路径），
// 替代旧的 JSON 子串匹配，避免卸载时误删恰巧引用同名文件的其他 hook
function isOurs(entry) {
  return (
    !!entry &&
    (entry.matcher === MARKER ||
      (typeof entry.command === "string" &&
        entry.command.includes("/session-stats/hooks/on-event.mjs")))
  );
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    // 已存在的配置解析失败时中止：绝不能用空配置覆盖用户文件
    if (fs.existsSync(p)) {
      throw new Error(`配置解析失败，中止以免覆盖用户配置: ${p} (${err.message})`);
    }
    return {};
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function hookEntry(command) {
  return { hooks: [{ type: "command", command, timeoutMs: 5000 }] };
}

if (action === "install") {
  const runtime = path.resolve(argValue("--runtime"));
  const nodeBin = path.resolve(argValue("--node"));
  const onEvent = path.join(runtime, "hooks", "on-event.mjs");
  if (!fs.existsSync(onEvent)) throw new Error(`on-event.mjs not found: ${onEvent}`);
  if (!fs.existsSync(nodeBin)) throw new Error(`node not found: ${nodeBin}`);

  const cfg = readJson(configPath);
  cfg.hooks = cfg.hooks || {};
  if (cfg.hooks.enabled === false) {
    // 尊重用户显式关闭：这是 hooks 的全局开关，不能强行打开
    console.warn("!! hooks.enabled=false 保持不变：hooks 全局关闭，本插件的 hooks 不会触发");
  } else {
    cfg.hooks.enabled = true;
  }
  cfg.hooks.events = cfg.hooks.events || {};
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    const list = (cfg.hooks.events[ev] = cfg.hooks.events[ev] || []);
    const cmd = `"${nodeBin}" "${onEvent}" ${ev.toLowerCase()}`;
    const filtered = list.filter((e) => !isOurs(e));
    filtered.push({ ...hookEntry(cmd), matcher: MARKER });
    cfg.hooks.events[ev] = filtered;
  }
  writeJson(configPath, cfg);

  fs.mkdirSync(commandsDir, { recursive: true });
  const cmdSrc = path.join(runtime, "commands", "stats.md");
  // stats.md 使用固定运行时路径（$HOME/.zcode/session-stats/bin/cli.mjs），无需占位符替换
  const body = fs.readFileSync(cmdSrc, "utf8");
  fs.writeFileSync(commandFile, body);

  console.log("hooks installed ->", configPath);
  console.log("command installed ->", commandFile);
  process.exit(0);
}

if (action === "uninstall") {
  if (fs.existsSync(configPath)) {
    const cfg = readJson(configPath);
    if (cfg.hooks?.events) {
      for (const ev of Object.keys(cfg.hooks.events)) {
        cfg.hooks.events[ev] = (cfg.hooks.events[ev] || []).filter((e) => !isOurs(e));
        if (cfg.hooks.events[ev].length === 0) delete cfg.hooks.events[ev];
      }
      if (Object.keys(cfg.hooks.events).length === 0) delete cfg.hooks.events;
    }
    if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
    writeJson(configPath, cfg);
    console.log("hooks removed ->", configPath);
  }
  if (fs.existsSync(commandFile)) {
    fs.rmSync(commandFile);
    console.log("command removed ->", commandFile);
  }
  const legacyCommand = path.join(commandsDir, "session-stats.md");
  if (fs.existsSync(legacyCommand)) {
    fs.rmSync(legacyCommand);
    console.log("legacy command removed ->", legacyCommand);
  }
  process.exit(0);
}

console.error("usage: configure.mjs install|uninstall [--runtime dir] [--node path] [--zcode-dir dir]");
process.exit(1);
