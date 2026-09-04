#!/bin/bash
# install.sh — 一键安装 ZCode 会话统计（状态栏 + 插件 hooks + /stats 命令）
#
# 动作：
#   1. 拷贝运行时到 ~/.zcode/session-stats/（排除日志），生成本地访问 token（daemon-token，0600）
#   2. 注册 hooks（SessionStart/UserPromptSubmit/Stop）与 /stats 命令到用户配置
#   3. 检查 asar 完整性 fuse 后，给 ZCode.app 的 app.asar 注入状态栏（备份并记录版本，可还原）
#   4. 重启统计守护进程（仅监听 127.0.0.1:47771，带 token 才能读取）
# 重启 ZCode 后生效；重启前旧渲染器里的状态栏会暂时隐藏（不带 token，被新 daemon 拒绝）。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SRC_DIR/session-stats"
APP_PATCH_DIR="$SRC_DIR/app-patch"
ZCODE_DIR="${HOME}/.zcode"
RUNTIME_DIR="${ZCODE_DIR}/session-stats"
ASAR="/Applications/ZCode.app/Contents/Resources/app.asar"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !! \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m xx \033[0m %s\n' "$*"; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "仅支持 macOS"
[[ -d "/Applications/ZCode.app" ]] || die "未找到 /Applications/ZCode.app"
[[ -f "$ASAR" ]] || die "未找到 app.asar: $ASAR"

# 1. 解析 node 绝对路径（GUI 进程 PATH 与终端不同，hook 命令必须用绝对路径）
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  for cand in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$cand" ]] && NODE_BIN="$cand" && break
  done
fi
[[ -n "$NODE_BIN" ]] || die "未找到 node，请先安装 Node.js（或把 node 加入 PATH）"
log "node: $NODE_BIN ($("$NODE_BIN" --version))"

# 2. 拷贝运行时 + 生成本地访问 token
log "安装运行时到 $RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
cp -R "$PLUGIN_DIR/." "$RUNTIME_DIR/"
rm -rf "$RUNTIME_DIR/.zcode-plugin"   # 运行时副本不需要插件 manifest（hooks 走 config.json）
rm -f "$RUNTIME_DIR/daemon.log" "$RUNTIME_DIR/daemon.log.old"   # 不把源目录里的陈旧日志带进运行时

log "生成本地访问 token"
TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[[ -n "$TOKEN" ]] || die "生成 token 失败"
( umask 077; printf '%s\n' "$TOKEN" > "$RUNTIME_DIR/daemon-token" )

# 3. 注册 hooks + /stats 命令
log "注册 hooks 与 /stats 命令"
"$NODE_BIN" "$RUNTIME_DIR/bin/configure.mjs" install \
  --runtime "$RUNTIME_DIR" --node "$NODE_BIN" --zcode-dir "$ZCODE_DIR"

# 4. 注入 app.asar（ZCode 运行中也安全：原子替换，重启后生效）
log "注入状态栏到 app.asar"
"$NODE_BIN" "$APP_PATCH_DIR/patch-app.mjs" patch --asar "$ASAR" --bar "$APP_PATCH_DIR/session-stats-bar.js" --token "$TOKEN"

# 4b. 移除隔离属性（补丁使签名封条失效，带 quarantine 会被 Gatekeeper 拦成"已损坏"）
if xattr -l /Applications/ZCode.app 2>/dev/null | grep -q com.apple.quarantine; then
  log "移除 ZCode.app 的 quarantine 隔离属性"
  xattr -d com.apple.quarantine /Applications/ZCode.app 2>/dev/null || \
    warn "移除 quarantine 失败，若重启后提示'已损坏'，执行: sudo xattr -rd com.apple.quarantine /Applications/ZCode.app"
fi

# 5. 重启守护进程（保证运行中的代码 = 刚安装的代码；token 以文件为准，daemon 每次请求读取）
log "重启统计守护进程"
pkill -f "node .*session-stats/daemon/daemon\.mjs" 2>/dev/null || true
sleep 0.3
( nohup "$NODE_BIN" "$RUNTIME_DIR/daemon/daemon.mjs" >> "$RUNTIME_DIR/daemon.log" 2>&1 & )
sleep 1
if curl -s -m 2 -H "x-zcstats-token: $TOKEN" "http://127.0.0.1:47771/v1/health" >/dev/null 2>&1; then
  log "守护进程就绪 (127.0.0.1:47771)"
else
  warn "守护进程未能启动，查看 $RUNTIME_DIR/daemon.log（发送消息后 hook 也会自动拉起）"
fi

cat <<'EOS'

安装完成 ✔  重启 ZCode 后，聊天输入框下方会出现会话统计栏：
    3 轮 · 12 步 │ LLM 45.2s │ 首 token 1.2s · 58 tok/s │ 缓存 98% │ 输入 118K · 输出 9.8K

  /stats            在对话里让模型展示详细统计卡片
  手动验证          node ~/.zcode/session-stats/bin/cli.mjs
  一键自检          bash doctor.sh
  卸载              bash uninstall.sh

EOS
