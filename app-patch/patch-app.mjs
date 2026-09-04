// patch-app.mjs — 把会话统计状态栏注入 ZCode.app 的 app.asar
//
// 原理：读取 app.asar 头部 → 修改 index.html 内容、追加状态栏脚本条目 →
//       重新分配所有文件偏移 → 流式拷贝原数据到新归档 → 原子替换。
//       ZCode 的 Electron asar 完整性校验 fuse 已确认关闭，改动可正常启动。
//
// 用法：
//   node patch-app.mjs patch   [--asar <path>] [--bar <file>] [--token <hex>]  注入（幂等，自动备份）
//   node patch-app.mjs restore [--asar <path>] [--purge]                       从备份还原
//   node patch-app.mjs status  [--asar <path>]                                 查看状态（含 fuse 检查）
//
// 备份位置：<asar 所在目录>/app.asar.zcstats-orig（伴随 .json 元数据，记录备份时的 ZCode 版本）
// --token：daemon 访问令牌，注入前替换 session-stats-bar.js 里的 __ZC_STATS_TOKEN__ 占位符

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ASAR = "/Applications/ZCode.app/Contents/Resources/app.asar";
const DEFAULT_BAR = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-stats-bar.js");
const INDEX_HTML_KEY = "index.html";
const INDEX_HTML_DIR = ["out", "renderer"];
const BAR_ASSET = "session-stats-bar.js";
const BAR_ASSET_DIR = ["out", "renderer", "assets"];
const INJECT_TAG = `<script type="module" src="./assets/${BAR_ASSET}"></script><!-- data-zcode-session-stats -->`;
const BACKUP_SUFFIX = ".zcstats-orig";
const META_SUFFIX = ".zcstats-orig.json";
const TOKEN_PLACEHOLDER = "__ZC_STATS_TOKEN__";
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const FUSE_INTEGRITY_INDEX = 4; // EnableEmbeddedAsarIntegrityValidation
const FUSE_ONLY_ASAR_INDEX = 5; // OnlyLoadAppFromAsar
const FUSE_STATE = { 48: "DISABLE", 49: "ENABLE", 114: "REMOVED", 144: "INHERIT" };

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const hasFlag = (argv, name) => argv.includes(name);

// ---------- asar 头部 ----------
// 布局（经实测校准）：
//   [0..3]=4  [4..7]=pickle_total  [8..11]=pickle_total-4  [12..15]=json_len
//   json@16，文件数据起始于 8 + pickle_total（= 16 + json_len + pad）

function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const pickleTotal = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  return {
    header: JSON.parse(jsonBuf.toString("utf8")),
    dataStart: 8 + pickleTotal,
  };
}

function serializeHeader(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const pickleTotal = 8 + jsonBuf.length + pad;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(pickleTotal, 4);
  head.writeUInt32LE(pickleTotal - 4, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  return { head, jsonBuf, pad, dataStart: 8 + pickleTotal };
}

function getDir(root, segments, create) {
  let node = root;
  for (const seg of segments) {
    if (!node.files) node.files = {};
    if (!node.files[seg]) {
      if (!create) return null;
      node.files[seg] = { files: {} };
    }
    node = node.files[seg];
  }
  return node;
}

function walkFiles(node, prefix, visit) {
  if (!node || !node.files) return;
  for (const [name, entry] of Object.entries(node.files)) {
    const p = [...prefix, name];
    if (entry && entry.files) walkFiles(entry, p, visit);
    else visit(p, entry);
  }
}

function readPayload(fd, dataStart, entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
  return buf;
}

function copyRange(srcFd, dstFd, offset, size) {
  const CHUNK = 4 * 1024 * 1024;
  const buf = Buffer.alloc(Math.min(CHUNK, size));
  let done = 0;
  while (done < size) {
    const n = Math.min(CHUNK, size - done);
    fs.readSync(srcFd, buf, 0, n, offset + done);
    fs.writeSync(dstFd, buf, 0, n);
    done += n;
  }
}

// ---------- 环境/备份辅助 ----------

function hashFile(p) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function readZcodeVersion(asarPath) {
  // macOS 从 Contents/Info.plist 读；win/linux 读 resources 旁 package.json 的 version
  if (process.platform === "darwin") {
    try {
      const contentsDir = path.dirname(path.dirname(path.resolve(asarPath)));
      const xml = fs.readFileSync(path.join(contentsDir, "Info.plist"), "utf8");
      const m = xml.match(/CFBundleShortVersionString[\s\S]{0,200}?<string>([^<]+)<\/string>/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }
  try {
    const resourcesDir = path.dirname(path.resolve(asarPath));
    const pkg = JSON.parse(fs.readFileSync(path.join(resourcesDir, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function writeBackupMeta(asarPath) {
  const meta = {
    zcodeVersion: readZcodeVersion(asarPath),
    asarSize: fs.statSync(asarPath).size,
    backedUpAt: new Date().toISOString(),
  };
  fs.writeFileSync(asarPath + META_SUFFIX, JSON.stringify(meta, null, 2) + "\n");
}

function readBackupMeta(asarPath) {
  try {
    return JSON.parse(fs.readFileSync(asarPath + META_SUFFIX, "utf8"));
  } catch {
    return null;
  }
}

// 检查 Electron fuse：EnableEmbeddedAsarIntegrityValidation 开启时，
// 改动 app.asar 会让 app 直接拒绝启动（“已损坏”），必须中止注入
function checkFuses(asarPath) {
  const resourcesDir = path.dirname(path.resolve(asarPath));
  let candidates;
  if (process.platform === "darwin") {
    const contentsDir = path.dirname(path.dirname(path.resolve(asarPath)));
    candidates = [
      path.join(contentsDir, "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework"),
      path.join(contentsDir, "MacOS", "ZCode"),
    ];
  } else {
    // win: <resources>/../ZCode.exe（electron 主 exe）；linux: <resources>/../zcode 或同目录二进制
    candidates = [
      path.join(resourcesDir, "..", "ZCode.exe"),
      path.join(resourcesDir, "..", "zcode"),
      path.join(resourcesDir, "..", "..", "zcode"),
      path.join(resourcesDir, "..", "..", "..", "zcode"),
    ];
  }
  let found = null;
  for (const bin of candidates) {
    if (!fs.existsSync(bin)) continue;
    try {
      const data = fs.readFileSync(bin);
      const idx = data.indexOf(FUSE_SENTINEL, 0, "latin1");
      if (idx < 0) continue;
      const base = idx + FUSE_SENTINEL.length;
      const version = data[base];
      const count = data[base + 1];
      const states = [...data.subarray(base + 2, base + 2 + count)].map((s) => FUSE_STATE[s] || `?${s}`);
      found = { binary: path.basename(bin), fuseVersion: version, states };
      break;
    } catch {}
  }
  if (!found) {
    return { status: "unknown", reason: "未找到 fuse 哨兵（旧版 Electron 或布局变化），无法校验完整性开关" };
  }
  if (found.fuseVersion !== 1) {
    return { status: "unknown", reason: `fuse 版本 ${found.fuseVersion} 未知，跳过校验`, ...found };
  }
  const integrity = found.states[FUSE_INTEGRITY_INDEX];
  if (integrity === "ENABLE") {
    return {
      status: "blocked",
      reason: "EnableEmbeddedAsarIntegrityValidation 已开启：修改 app.asar 会导致 ZCode 无法启动，已拒绝注入",
      ...found,
    };
  }
  return { status: "ok", onlyLoadAppFromAsar: found.states[FUSE_ONLY_ASAR_INDEX], ...found };
}

// ---------- patch ----------

function cmdPatch(argv) {
  const asarPath = path.resolve(argValue(argv, "--asar") || DEFAULT_ASAR);
  const barPath = path.resolve(argValue(argv, "--bar") || DEFAULT_BAR);
  const backupPath = asarPath + BACKUP_SUFFIX;

  if (!fs.existsSync(asarPath)) throw new Error(`app.asar not found: ${asarPath}`);

  const fuse = checkFuses(asarPath);
  console.log(`fuse check: ${fuse.status}${fuse.reason ? ` (${fuse.reason})` : ""}`);
  if (fuse.status === "blocked") throw new Error(fuse.reason);

  let barText = fs.readFileSync(barPath, "utf8");
  if (barText.includes(TOKEN_PLACEHOLDER)) {
    const token = argValue(argv, "--token");
    if (!token) {
      throw new Error(`${path.basename(barPath)} 含 ${TOKEN_PLACEHOLDER} 占位符，需通过 --token 提供 daemon token`);
    }
    barText = barText.split(TOKEN_PLACEHOLDER).join(token);
  }
  const barBuf = Buffer.from(barText, "utf8");
  const barSize = barBuf.length;

  // 已打过补丁则刷新注入；未打补丁但备份已存在时，校验备份是否还是当前构建（防陈旧备份）
  {
    const fd = fs.openSync(asarPath, "r");
    let isPatched = false;
    try {
      const { header } = readHeader(fd);
      isPatched = !!getDir(header, BAR_ASSET_DIR, false)?.files?.[BAR_ASSET];
    } catch (err) {
      throw new Error(`cannot parse asar header: ${err.message}`);
    } finally {
      fs.closeSync(fd);
    }
    if (isPatched) {
      console.log("already patched — refreshing injection (idempotent)");
    } else if (fs.existsSync(backupPath)) {
      const same =
        fs.statSync(asarPath).size === fs.statSync(backupPath).size &&
        hashFile(asarPath) === hashFile(backupPath);
      if (same) {
        console.log("backup already exists, keep it:", backupPath);
      } else {
        // 未打补丁且与备份不一致 → 当前是新版 app 的干净构建，旧备份已过期
        console.log("live asar differs from backup (new app build?) — refreshing backup:", backupPath);
        fs.copyFileSync(asarPath, backupPath);
        writeBackupMeta(asarPath);
      }
    } else {
      console.log("backup ->", backupPath);
      fs.copyFileSync(asarPath, backupPath);
      writeBackupMeta(asarPath);
    }
  }

  const srcFd = fs.openSync(asarPath, "r");
  try {
    const { header, dataStart } = readHeader(srcFd);

    // 1. index.html 注入
    const indexDir = getDir(header, INDEX_HTML_DIR, false);
    const indexEntry = indexDir?.files?.[INDEX_HTML_KEY];
    if (!indexEntry) throw new Error("out/renderer/index.html not found in asar");
    let html = readPayload(srcFd, dataStart, indexEntry).toString("utf8");
    const tagRe = /<script type="module" src="\.\/assets\/session-stats-bar\.js"><\/script><!-- data-zcode-session-stats -->/g;
    html = html.replace(tagRe, "");
    if (!html.includes("</head>")) throw new Error("index.html has no </head>");
    html = html.replace("</head>", INJECT_TAG + "\n</head>");
    const newHtml = Buffer.from(html, "utf8");

    // 2. 头部条目
    const indexPathRel = [...INDEX_HTML_DIR, INDEX_HTML_KEY].join("/");
    const barPathRel = [...BAR_ASSET_DIR, BAR_ASSET].join("/");
    indexEntry.size = newHtml.length;
    delete indexEntry.integrity; // 内容已变，integrity 不再匹配（fuse 关闭，不会校验）
    const barDir = getDir(header, BAR_ASSET_DIR, true);
    barDir.files[BAR_ASSET] = { size: barSize };

    // 3. 收集写盘计划：walk 顺序 = 数据顺序
    const overrides = new Map([
      [indexPathRel, newHtml],
      [barPathRel, barBuf],
    ]);
    const plan = []; // {rel, entry, source}
    walkFiles(header, [], (p, entry) => {
      if (!entry || entry.unpacked) return;
      const rel = p.join("/");
      const buf = overrides.get(rel);
      plan.push({
        rel,
        entry,
        size: buf ? buf.length : entry.size,
        buf: buf || null,
        srcFdOffset: buf ? null : dataStart + Number(entry.offset),
      });
    });

    // 4. 迭代求偏移（头部大小取决于 offset 数字长度，需收敛）
    let dataStartGuess = dataStart;
    let serialized = null;
    for (let iter = 0; iter < 6; iter++) {
      let cursor = 0;
      for (const item of plan) {
        item.entry.offset = String(cursor);
        cursor += item.size;
      }
      serialized = serializeHeader(header);
      if (serialized.dataStart === dataStartGuess) break;
      dataStartGuess = serialized.dataStart;
    }
    if (serialized.dataStart !== dataStartGuess) throw new Error("offset iteration did not converge");

    const totalData = plan.reduce((s, it) => s + it.size, 0);
    const totalSize = serialized.dataStart + totalData;

    // 5. 写临时文件：头部 + 数据
    const tmpPath = asarPath + ".zcstats-tmp";
    const out = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(out, serialized.head, 0, 16);
      fs.writeSync(out, serialized.jsonBuf, 0, serialized.jsonBuf.length);
      if (serialized.pad) fs.writeSync(out, Buffer.alloc(serialized.pad, 0), 0, serialized.pad);
      let expect = serialized.dataStart;
      if (fs.fstatSync(out).size !== expect) throw new Error("header size bookkeeping error");
      for (const item of plan) {
        if (item.buf) {
          fs.writeSync(out, item.buf, 0, item.size);
        } else {
          copyRange(srcFd, out, item.srcFdOffset, item.size);
        }
        expect += item.size;
      }
      if (fs.fstatSync(out).size !== expect) throw new Error("written size mismatch");
    } finally {
      fs.closeSync(out);
    }

    // 6. 原子替换 + 保留权限
    const mode = fs.statSync(asarPath).mode;
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, asarPath);
    console.log(
      `patched ok: +${barSize}B bar, index.html ${indexEntry ? "rewritten" : ""}, total ${(totalSize / 1048576).toFixed(1)}MB -> ${asarPath}`
    );
    console.log("restart ZCode to see the stats bar.");
  } finally {
    fs.closeSync(srcFd);
  }
}

// ---------- restore ----------

function cmdRestore(argv) {
  const asarPath = path.resolve(argValue(argv, "--asar") || DEFAULT_ASAR);
  const backupPath = asarPath + BACKUP_SUFFIX;
  if (!fs.existsSync(backupPath)) {
    console.error("no backup found:", backupPath);
    process.exit(1);
  }
  const meta = readBackupMeta(asarPath);
  const currentVersion = readZcodeVersion(asarPath);
  if (meta?.zcodeVersion && currentVersion && meta.zcodeVersion !== currentVersion) {
    console.warn(`!! 备份来自 ZCode ${meta.zcodeVersion}，当前为 ${currentVersion} —— 还原可能造成版本错配，请确认`);
  }
  const tmpPath = asarPath + ".zcstats-restore-tmp";
  fs.copyFileSync(backupPath, tmpPath);
  fs.chmodSync(tmpPath, fs.statSync(asarPath).mode);
  fs.renameSync(tmpPath, asarPath);
  if (hasFlag(argv, "--purge")) {
    fs.rmSync(backupPath, { force: true });
    fs.rmSync(asarPath + META_SUFFIX, { force: true });
  }
  console.log("restored app.asar from backup" + (hasFlag(argv, "--purge") ? " (backup purged)" : ` (backup kept: ${backupPath})`));
}

// ---------- status ----------

function cmdStatus(argv) {
  const asarPath = path.resolve(argValue(argv, "--asar") || DEFAULT_ASAR);
  const backupPath = asarPath + BACKUP_SUFFIX;
  const fd = fs.openSync(asarPath, "r");
  try {
    const { header } = readHeader(fd);
    const patched = !!getDir(header, BAR_ASSET_DIR, false)?.files?.[BAR_ASSET];
    const fuse = checkFuses(asarPath);
    const meta = readBackupMeta(asarPath);
    console.log(
      JSON.stringify({
        asarPath,
        patched,
        backupExists: fs.existsSync(backupPath),
        zcodeVersion: readZcodeVersion(asarPath),
        backupVersion: meta?.zcodeVersion ?? null,
        fuse: {
          status: fuse.status,
          integrityValidation: fuse.states?.[FUSE_INTEGRITY_INDEX] ?? null,
          reason: fuse.reason ?? null,
        },
      })
    );
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- main ----------

const argv = process.argv.slice(2);
const action = argv[0];
try {
  if (action === "patch") cmdPatch(argv);
  else if (action === "restore") cmdRestore(argv);
  else if (action === "status") cmdStatus(argv);
  else {
    console.error("usage: patch-app.mjs patch|restore|status [--asar path] [--bar file] [--purge]");
    process.exit(1);
  }
} catch (err) {
  console.error("error:", err?.message || err);
  process.exit(1);
}
