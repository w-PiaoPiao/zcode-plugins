#!/bin/bash
# uninstall.sh — 跨平台卸载 ZCode 会话统计
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SRC_DIR/lib/zcenv.sh"
zc_find_node

# ---------- 1. 还原 app.asar ----------
if [[ -f "$RUNTIME_DIR/.installed-asar" ]] && [[ -f "$(cat "$RUNTIME_DIR/.installed-asar" 2>/dev/null)" ]]; then
  ASAR="$(cat "$RUNTIME_DIR/.installed-asar")"
elif [[ -f "$ZC_ASAR.zcstats-orig" ]]; then
  ASAR="$ZC_ASAR"
else
  ASAR=""
fi

if [[ -n "$ASAR" ]] && [[ -f "$ASAR.zcstats-orig" ]]; then
  zc_log "还原 app.asar ($ASAR)"
  "$NODE_BIN" "$SRC_DIR/app-patch/patch-app.mjs" restore --asar "$ASAR" --purge
else
  zc_log "未发现 app.asar 备份，跳过还原"
fi

# ---------- 2. 移除 hooks 与命令 ----------
zc_log "移除 hooks 与 /stats 命令"
# 优先用运行时里的 configure.mjs（可能在 ~/.zcode），否则用源码里的
if [[ -f "$RUNTIME_DIR/bin/configure.mjs" ]]; then
  "$NODE_BIN" "$RUNTIME_DIR/bin/configure.mjs" uninstall --zcode-dir "$ZCODE_DIR" 2>/dev/null \
    || "$NODE_BIN" "$SRC_DIR/plugins/session-stats/bin/configure.mjs" uninstall --zcode-dir "$ZCODE_DIR"
else
  "$NODE_BIN" "$SRC_DIR/plugins/session-stats/bin/configure.mjs" uninstall --zcode-dir "$ZCODE_DIR"
fi

# ---------- 3. 停止 daemon + 清理运行时 ----------
zc_log "停止统计守护进程并清理运行时"
zc_daemon_stop || true
rm -f "$RUNTIME_DIR/.installed-asar" "$RUNTIME_DIR/zcode.pid"
rm -rf "$RUNTIME_DIR"

zc_log "卸载完成，重启 ZCode 生效"
