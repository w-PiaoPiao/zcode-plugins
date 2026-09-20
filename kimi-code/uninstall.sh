#!/bin/bash
# uninstall.sh — 撤销注入，把 Kimi Code 渲染层还原成原样
#
# 只做三件事：从 index.html 移除注入标记、删掉统计条脚本、删掉备份文件。
# 不依赖备份文件（App 更新后备份可能已过期），因此跨版本也安全。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="kimi-session-stats.js"
MARKER="<script src=\"/$SCRIPT_NAME\"></script>"

log()  { printf '\033[36m[kimi-stats]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[kimi-stats]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[kimi-stats]\033[0m %s\n' "$*" >&2; exit 1; }

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

APP="$(find_app)" || die "未找到 Kimi Code.app；可用 KIMI_CODE_APP=\"/path/to/Kimi Code.app\" 指定"
DIST="$APP/Contents/Resources/desktop-dist"
INDEX="$DIST/index.html"
BACKUP="$INDEX.kimi-stats.bak"

[[ -f "$INDEX" ]] || die "找不到 $INDEX"
[[ -w "$INDEX" ]] || die "文件不可写：$INDEX（必要时用 sudo）"

if grep -qF "$MARKER" "$INDEX"; then
  node - "$INDEX" "$MARKER" <<'NODE'
const fs = require('fs');
const [file, marker] = process.argv.slice(2);
const html = fs.readFileSync(file, 'utf8');
// 只删除包含标记的整行，其他内容原样保留
const out = html
  .split('\n')
  .filter((line) => !line.includes(marker))
  .join('\n');
fs.writeFileSync(file, out);
NODE
  log "已从 index.html 移除注入标记"
else
  log "index.html 未包含注入标记（可能已被 App 更新重置）"
fi

rm -f "$DIST/$SCRIPT_NAME" && log "已删除 desktop-dist/$SCRIPT_NAME"
rm -f "$BACKUP" && log "已删除 index.html.kimi-stats.bak"

log "完成。重启 Kimi Code 后统计条消失。"
