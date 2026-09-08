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

# ---------- 1b. token：优先复用已有的 ----------
# 免补丁（NODE_OPTIONS）路线的注入器在运行时读 token，asar 补丁路线则把 token 烘焙进
# asar——若每次安装都重新生成 token，已打补丁的 asar 里的旧 token 会立刻失效（403）。
# 所以只有 token 文件不存在时才生成新 token。
if [[ -f "$RUNTIME_DIR/daemon-token" ]]; then
  TOKEN="$(cat "$RUNTIME_DIR/daemon-token")"
  zc_log "复用已有访问 token"
else
  zc_log "生成本地访问 token"
  # 跨平台生成 64 hex：优先 node（三平台都有），od -An -tx1 在 Windows Git Bash 也可用
  TOKEN="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  [[ -n "$TOKEN" ]] || die "生成 token 失败"
  ( umask 077; printf '%s\n' "$TOKEN" > "$RUNTIME_DIR/daemon-token" )
fi

# ---------- 2. hooks + 命令 ----------
zc_log "注册 hooks 与 /stats 命令"
"$NODE_BIN" "$RUNTIME_DIR/bin/configure.mjs" install \
  --runtime "$RUNTIME_DIR" --node "$NODE_BIN" --zcode-dir "$ZCODE_DIR"

# ---------- 3. 渲染端注入：asar 补丁（免补丁路线见下注） ----------
# 曾实现过 NODE_OPTIONS=--require 注入主进程的免补丁路线（fuse node_options=ENABLE
# 时自动启用），但实测被 Electron 否决：打包应用强制过滤大多数 NODE_OPTIONs
# （node_bindings.cc: "Most NODE_OPTIONs are not supported in packaged apps"），
# --require 直接被忽略，主进程不会加载。故 asar 补丁是当前唯一可行路线；
# no-patch 分支保留，供未来 Electron 放开限制后用 ZC_STATS_MODE=no-patch 显式启用。
MODE="${ZC_STATS_MODE:-patch}"
if [[ "$MODE" == "auto" ]]; then
  MODE="patch"
fi
# 记录本次选择的路线（doctor 据此判断渲染端来源）
printf '%s\n' "$MODE" > "$RUNTIME_DIR/.inject-mode"

if [[ "$MODE" == "no-patch" ]]; then
  zc_log "渲染端注入路线：NODE_OPTIONS 免补丁（fuse node_options=ENABLE）"
  mkdir -p "$RUNTIME_DIR/bar"
  cp "$APP_PATCH_DIR/session-stats-bar.js" "$RUNTIME_DIR/bar/session-stats-bar.js"
  cp "$APP_PATCH_DIR/inject-main.cjs" "$RUNTIME_DIR/inject-main.cjs"
  "$NODE_BIN" "$APP_PATCH_DIR/set-node-options.mjs" install --require-file "$RUNTIME_DIR/inject-main.cjs"
  zc_log "重启 ZCode 后悬浮条出现；ZCode 更新后无需重新安装"
else
  zc_log "渲染端注入路线：asar 补丁（node_options fuse 关闭或显式指定）"
  if zc_needs_elevation; then
    # asar 目录不可写（如 Windows Program Files）：提权辅助脚本接管（一次 UAC），
    # 等待 ZCode 退出后打补丁并自动重启 ZCode；即使本脚本随终端退出中断，补丁仍会完成
    if ! zc_elevated_patch "$TOKEN"; then
      die "asar 注入未完成（悬浮条不会出现）。其余组件已就绪且幂等，修复后重跑 bash install.sh 即可。"
    fi
  else
    "$NODE_BIN" "$APP_PATCH_DIR/patch-app.mjs" patch --asar "$ZC_ASAR" \
      --bar "$APP_PATCH_DIR/session-stats-bar.js" --token "$TOKEN"
  fi
  # 记录实际注入的 asar 路径，卸载时据此还原（AppImage 等场景重定位可能失败）
  printf '%s\n' "$ZC_ASAR" > "$RUNTIME_DIR/.installed-asar"
fi

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
