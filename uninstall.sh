#!/bin/bash
# uninstall.sh — 卸载 ZCode 会话统计
set -euo pipefail

ZCODE_DIR="${HOME}/.zcode"
RUNTIME_DIR="${ZCODE_DIR}/session-stats"
ASAR="/Applications/ZCode.app/Contents/Resources/app.asar"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  for cand in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$cand" ]] && NODE_BIN="$cand" && break
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  printf '\033[1;31m xx \033[0m 未找到 node，无法还原 app.asar 与清理配置；请先安装 Node.js 再卸载\n'
  exit 1
fi

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

# 1. 还原 app.asar
if [[ -f "$ASAR.zcstats-orig" ]]; then
  log "还原 app.asar"
  "$NODE_BIN" "$(dirname "$0")/app-patch/patch-app.mjs" restore --asar "$ASAR" --purge
else
  log "未发现 app.asar 备份，跳过还原"
fi

# 2. 移除 hooks 与命令
log "移除 hooks 与 /stats 命令"
"$NODE_BIN" "$RUNTIME_DIR/bin/configure.mjs" uninstall --zcode-dir "$ZCODE_DIR" 2>/dev/null \
  || "$(dirname "$0")/plugins/session-stats/bin/configure.mjs" uninstall --zcode-dir "$ZCODE_DIR"

# 3. 停止守护进程并清理运行时
log "停止守护进程并清理运行时"
pkill -f "node .*session-stats/daemon/daemon\.mjs" 2>/dev/null || true
sleep 0.3
rm -rf "$RUNTIME_DIR"

log "卸载完成，重启 ZCode 生效"
