#!/bin/bash
# install.sh — 把「会话统计条」注入 Kimi Code 桌面版的渲染层
#
# 原理：桌面版的界面是一份磁盘上的静态产物
#   <App>/Contents/Resources/desktop-dist/
# 由 app://renderer/ 自定义协议直接按文件提供。因此在 index.html 里加一行
# <script src="/kimi-session-stats.js"> 即可让统计条随界面一起加载。
# 不需要改 app.asar、不需要守护进程、不需要额外端口。
#
# 动作：
#   1. 定位 Kimi Code.app（可用 KIMI_CODE_APP 覆盖）
#   2. 语法自检（失败即中止，不动 App）
#   3. 拷贝 renderer/kimi-session-stats.js 到 desktop-dist/
#   4. 清理 index.html 里所有旧的注入行，再插入一行（幂等，对 App 更新安全）
#   5. macOS：移除 quarantine 属性（本地改动会使签名封条失效）
# 重启 Kimi Code 后生效。重复执行安全（幂等）。
#
# 出问题（白屏 / 界面异常）时：bash uninstall.sh 立刻还原。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="kimi-session-stats.js"
MARKER="<script src=\"/$SCRIPT_NAME\"></script>"

log()  { printf '\033[36m[kimi-stats]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[kimi-stats]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[kimi-stats]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. 定位 App ----------
find_app() {
  local candidates=(
    "${KIMI_CODE_APP:-}"
    "/Applications/Kimi Code.app"
    "$HOME/Applications/Kimi Code.app"
    "/Applications/Kimi Code Canary.app"
    "/Applications/Kimi Code Preview.app"
  )
  local c
  for c in "${candidates[@]}"; do
    [[ -n "$c" && -d "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

APP="$(find_app)" || die "未找到 Kimi Code.app；请用 KIMI_CODE_APP=\"/path/to/Kimi Code.app\" 指定"
DIST="$APP/Contents/Resources/desktop-dist"
INDEX="$DIST/index.html"

[[ -d "$DIST" ]] || die "找不到渲染产物目录：$DIST"
[[ -f "$INDEX" ]] || die "找不到 $INDEX"
log "App: $APP"

# ---------- 2. 可写性 ----------
if [[ ! -w "$DIST" || ! -w "$INDEX" ]]; then
  die "目录不可写：$DIST
macOS 会把「修改已安装 App 的内容」当作敏感操作（App 管理权限）。
请在终端里重试：sudo bash \"$SRC_DIR/install.sh\""
fi

# 先确认 App 已退出，避免界面正在使用时留下半新半旧的状态
if pgrep -f "$(basename "$APP")/Contents/MacOS/" >/dev/null 2>&1; then
  warn "检测到 Kimi Code 正在运行 —— 注入会立即写入文件，但需要重启 App 才会生效。"
fi

# ---------- 3. 语法自检 ----------
if command -v node >/dev/null 2>&1; then
  node --check "$SRC_DIR/renderer/$SCRIPT_NAME" \
    || die "脚本语法检查失败，未对 App 做任何改动"
  log "语法自检通过"
else
  warn "未找到 node，跳过语法自检（脚本在 App 内不依赖 node）"
fi

# ---------- 4. 拷贝脚本 ----------
cp "$SRC_DIR/renderer/$SCRIPT_NAME" "$DIST/$SCRIPT_NAME"
log "已拷贝 $SCRIPT_NAME → desktop-dist/"

# ---------- 5. 注入 index.html ----------
BACKUP="$INDEX.kimi-stats.bak"
if [[ ! -f "$BACKUP" ]]; then
  cp "$INDEX" "$BACKUP"
  log "已备份原 index.html → $(basename "$BACKUP")"
fi

# 先把所有旧的注入行清掉再插一行：多次执行不会重复注入，
# 也用不着旧备份去覆盖（App 升级过之后旧备份可能是过期的界面）。
node - "$INDEX" "$MARKER" <<'NODE'
const fs = require('fs');
const [file, marker] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split('\n');
const kept = lines.filter((line) => !line.includes(marker));
const at = kept.findIndex((line) => line.includes('</head>'));
if (at === -1) {
  console.error('index.html 中没有 </head>，无法注入');
  process.exit(1);
}
// classic script 会先于 defer 的 module 脚本执行，因此 WebSocket 包装一定
// 早于应用建立连接。
kept.splice(at, 0, '    ' + marker);
fs.writeFileSync(file, kept.join('\n'));
NODE
log "已注入 index.html（一行 <script>，内容始终只有一份）"

# ---------- 6. macOS：移除 quarantine ----------
if [[ "$(uname -s)" == "Darwin" ]]; then
  if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$APP" 2>/dev/null \
      && log "已移除 com.apple.quarantine（避免 Gatekeeper 因签名封条失效而拦截启动）" \
      || warn "移除 quarantine 失败；若启动时提示「已损坏」，执行：
  sudo xattr -rd com.apple.quarantine \"$APP\""
  fi
fi

# ---------- 7. 自检 ----------
bash "$SRC_DIR/doctor.sh" || true

log "完成。请退出并重新打开 Kimi Code（Cmd+Q 后重开）。"
log "统计条会出现在输入框下方留白处：轮/步·tok/s ｜ 总量·缓存命中 ｜ 上下文圆环（点击看详情）。"
log "白屏或界面异常时：bash \"$SRC_DIR/uninstall.sh\" 立即还原。"
