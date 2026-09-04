#!/bin/bash
# install.sh — 跨平台安装 ZCode 会话统计（悬浮条 + hooks + /stats 命令 + daemon）
#
# 支持：macOS（Intel/Apple Silicon）/ Linux（x64/arm64）/ Windows（Git Bash / MSYS2）
# 前置：已安装 ZCode 桌面版 + Node.js ≥ 22.5
# 动作：
#   1. 拷贝运行时到 ~/.zcode/session-stats/（排除日志），生成本地访问 token（0600）
#   2. 注册 hooks（SessionStart/UserPromptSubmit/Stop）与 /stats 命令到用户配置
#   3. 检查 asar 完整性 fuse 后，注入状态栏到 ZCode 的 app.asar（备份并记录版本）
#   4. 写入 zcode.pid（供 daemon 探活）并重启 daemon
# 重启 ZCode 后生效。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SRC_DIR/plugins/session-stats"
APP_PATCH_DIR="$SRC_DIR/app-patch"

# ---------- 环境探测 ----------
source "$SRC_DIR/lib/zcenv.sh"
zc_find_node

if [[ "$OS_NAME" == "unknown" ]]; then
  zc_die "不支持的平台: $(uname -s)（支持 macOS / Linux / Windows Git Bash）"
fi
zc_locate_asar
zc_log "平台: $OS_NAME | node: $NODE_BIN | asar: $ZC_ASAR"

# ---------- 1. 运行时 + token ----------
log() { zc_log "$@"; }
warn() { zc_warn "$@"; }
die()  { zc_die "$@"; }

zc_log "安装运行时到 $RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
# Windows Git Bash 的 cp -R 行为与 POSIX 一致；这里统一用 tar 管道避免符号链接/权限差异
( cd "$PLUGIN_DIR" && tar cf - --exclude='daemon.log*' --exclude='.zcode-plugin' . ) | ( cd "$RUNTIME_DIR" && tar xf - )
rm -rf "$RUNTIME_DIR/.zcode-plugin"   # 运行时副本不需要插件 manifest（hooks 走 config.json）

zc_log "生成本地访问 token"
# 跨平台生成 64 hex：优先 node（三平台都有），od -An -tx1 在 Windows Git Bash 也可用
TOKEN="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
[[ -n "$TOKEN" ]] || die "生成 token 失败"
( umask 077; printf '%s\n' "$TOKEN" > "$RUNTIME_DIR/daemon-token" )

# ---------- 2. hooks + 命令 ----------
zc_log "注册 hooks 与 /stats 命令"
"$NODE_BIN" "$RUNTIME_DIR/bin/configure.mjs" install \
  --runtime "$RUNTIME_DIR" --node "$NODE_BIN" --zcode-dir "$ZCODE_DIR"

# ---------- 3. 注入 app.asar（含 fuse 检查） ----------
zc_log "注入状态栏到 app.asar"
"$NODE_BIN" "$APP_PATCH_DIR/patch-app.mjs" patch --asar "$ZC_ASAR" \
  --bar "$APP_PATCH_DIR/session-stats-bar.js" --token "$TOKEN"
# 记录实际注入的 asar 路径，卸载时据此还原（AppImage 等场景重定位可能失败）
printf '%s\n' "$ZC_ASAR" > "$RUNTIME_DIR/.installed-asar"

# 4b. 移除 quarantine（仅 macOS；win/linux no-op）
zc_os_quarantine_rm

# ---------- 4. 写 zcode.pid + 重启 daemon ----------
if [[ $IS_WIN -eq 0 ]]; then
  # POSIX：记录 ZCode 主进程 pid 供 daemon 探活
  APP_PID="$(zc_app_pid || true)"
  if [[ -n "$APP_PID" ]]; then
    printf '%s\n' "$APP_PID" > "$RUNTIME_DIR/zcode.pid"
    zc_log "记录 ZCode pid: $APP_PID"
  fi
fi

zc_log "重启统计守护进程"
zc_daemon_stop || true
zc_daemon_start
sleep 1
if curl -s -m 2 -H "x-zcstats-token: $TOKEN" "http://127.0.0.1:47771/v1/health" >/dev/null 2>&1; then
  zc_log "守护进程就绪 (127.0.0.1:47771)"
else
  zc_warn "守护进程未能启动，查看 $RUNTIME_DIR/daemon.log（发送消息后 hook 也会自动拉起）"
fi

cat <<'EOS'

安装完成 ✔  重启 ZCode 后，窗口底部会出现会话统计悬浮条：
    3 轮 · 12 步 │ LLM 45.2s │ 首 token 1.2s · 58 tok/s │ 缓存 98% │ 输入 118K · 输出 9.8K

  /stats            在对话里让模型展示详细统计卡片
  手动验证          node ~/.zcode/session-stats/bin/cli.mjs
  一键自检          bash doctor.sh
  卸载              bash uninstall.sh
EOS
