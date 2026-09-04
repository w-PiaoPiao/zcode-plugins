# zcenv.sh — session-stats 跨平台环境探测与 daemon 启停（被 install/uninstall/doctor source）
#
# 提供变量：
#   OS_NAME        darwin | linux | win
#   IS_MAC / IS_LINUX / IS_WIN
#   ZCODE_DIR      ~/.zcode（用户配置根，三平台一致）
#   RUNTIME_DIR    $ZCODE_DIR/session-stats
#   NODE_BIN       node 绝对路径（GUI/登录 shell 都可用）
#   ZC_ASAR        ZCode.app 资源 app.asar 绝对路径（按平台定位）
#   ZC_APP_DIR     app 包/安装目录
#   ZC_PID_FILE    daemon 用于探活 ZCode 的 pid 文件（$RUNTIME_DIR/zcode.pid）
# 提供函数：
#   zc_log / zc_warn / zc_die
#   zc_find_node         探测 node（PATH + 常见安装位置）
#   zc_locate_asar       定位 app.asar（darwin: /Applications/ZCode.app；linux: 探测；win: 探测）
#   zc_daemon_start      启动 daemon（nohup/后台），写 zcode.pid
#   zc_daemon_stop       停 daemon
#   zc_app_pid           输出 ZCode 主进程 pid（平台相关）
#   zc_os_quarantine_rm  darwin 移除 quarantine 属性（no-op on win/linux）

# ---------- 平台 ----------
case "$(uname -s)" in
  Darwin) OS_NAME=darwin ;;
  Linux)  OS_NAME=linux ;;
  MINGW*|MSYS*|CYGWIN*) OS_NAME=win ;;
  *) OS_NAME=unknown ;;
esac
IS_MAC=0; IS_LINUX=0; IS_WIN=0
[[ "$OS_NAME" == "darwin" ]] && IS_MAC=1
[[ "$OS_NAME" == "linux"  ]] && IS_LINUX=1
[[ "$OS_NAME" == "win"    ]] && IS_WIN=1

ZCODE_DIR="${HOME}/.zcode"
RUNTIME_DIR="${ZCODE_DIR}/session-stats"
ZC_PID_FILE="$RUNTIME_DIR/zcode.pid"

zc_log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
zc_warn() { printf '\033[1;33m !! \033[0m %s\n' "$*"; }
zc_die()  { printf '\033[1;31m xx \033[0m %s\n' "$*"; exit 1; }

# ---------- node ----------
zc_find_node() {
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [[ -z "$NODE_BIN" ]]; then
    for cand in "$HOME/.local/bin/node" "$HOME/.nvm/current/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$LOCALAPPDATA/Programs/nodejs/node.exe"; do
      [[ -n "$cand" && -x "$cand" ]] && NODE_BIN="$cand" && break
    done
  fi
  [[ -n "$NODE_BIN" ]] || zc_die "未找到 node，请先安装 Node.js ≥ 22.5（建议 ≥ 22.13），或把 node 加入 PATH"
  NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"  # 归一为绝对路径
}

# ---------- asar 定位 ----------
# 跨平台：macOS 在 /Applications/ZCode.app；Linux 常见 ~/.local/share 或解包 AppImage；
# Windows 常见 %LOCALAPPDATA%\Programs\ZCode。找不到时 zc_die。
zc_locate_asar() {
  local cands=() asar
  if [[ $IS_MAC -eq 1 ]]; then
    cands=("/Applications/ZCode.app/Contents/Resources/app.asar")
  elif [[ $IS_WIN -eq 1 ]]; then
    cands=("${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/ZCode/resources/app.asar"
           "$HOME/AppData/Local/Programs/ZCode/resources/app.asar")
  elif [[ $IS_LINUX -eq 1 ]]; then
    cands=("$HOME/.local/share/ZCode/resources/app.asar"
           "$HOME/.local/share/zcode/resources/app.asar"
           "/opt/ZCode/resources/app.asar"
           "/usr/lib/zcode/resources/app.asar")
    # AppImage 解包目录（若用户用 --appimage-extract 挂载过）
    for d in "$HOME"/squashfs-root*/resources "$HOME"/AppImages/*/resources; do
      [[ -d "$d" ]] && cands+=("$d/app.asar")
    done
  fi
  for asar in "${cands[@]}"; do
    if [[ -f "$asar" ]]; then
      ZC_ASAR="$asar"
      # app 目录 = resources 的上一级
      ZC_APP_DIR="$(dirname "$(dirname "$asar")")"
      return 0
    fi
  done
  zc_die "未找到 ZCode 的 app.asar（已探测常见安装位置）。请确认 ZCode 桌面版已安装；Linux AppImage 需先 --appimage-extract 或安装 .deb/.rpm。"
}

# ---------- daemon 启停 ----------
zc_daemon_pid() {
  # 返回运行中 daemon 的 pid（若有）——依赖 daemon 启动时自写的 daemon.pid
  if [[ -f "$RUNTIME_DIR/daemon.pid" ]]; then
    local p; p="$(cat "$RUNTIME_DIR/daemon.pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then echo "$p"; return 0; fi
  fi
  return 1
}

zc_daemon_stop() {
  # 停掉正在运行的 daemon（精确 pid；无 pid 文件时按端口兜底，兼容旧版 daemon）
  local p
  p="$(zc_daemon_pid)" && { kill "$p" 2>/dev/null || true; sleep 0.3; rm -f "$RUNTIME_DIR/daemon.pid"; return 0; }
  # 旧版 daemon 不写 daemon.pid：按监听端口定位并停止（macOS/Linux 用 lsof，Windows 用 netstat）
  if [[ $IS_WIN -eq 1 ]]; then
    local pid
    pid="$(netstat -ano 2>/dev/null | awk '$4 ~ /:47771$/ && $NF!="0" {print $NF; exit}')"
    [[ -n "$pid" ]] && { taskkill //PID "$pid" //F >/dev/null 2>&1 || true; }
  else
    local pid
    pid="$(lsof -ti tcp:47771 2>/dev/null | head -1)"
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null || true; sleep 0.3; }
  fi
  rm -f "$RUNTIME_DIR/daemon.pid"
}

zc_port_in_use() {
  # 端口 47771 是否已被占用（daemon 在跑）——返回 0 占用 / 1 空闲
  # 注意：端口空闲时 lsof/fuser 本身返回非零，勿用 "|| 真值" 兜底（会把空闲误判成占用）
  if [[ $IS_WIN -eq 1 ]]; then
    netstat -ano 2>/dev/null | grep -q ":47771 .*LISTENING"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:47771 >/dev/null 2>&1
  elif command -v fuser >/dev/null 2>&1; then
    fuser 47771/tcp >/dev/null 2>&1
  else
    return 1 # 无探测工具：按空闲处理（daemon 自带 EADDRINUSE 容错）
  fi
}

zc_daemon_start() {
  # 需先 zc_find_node 且 RUNTIME_DIR 就绪；daemon 启动后自写 daemon.pid
  # 幂等：若端口已被占用（daemon 已在跑）则跳过
  if zc_port_in_use; then
    return 0
  fi
  mkdir -p "$RUNTIME_DIR"
  # 用 node detached spawn 启动：daemon 脱离父 shell/进程组，install.sh 退出后仍存活。
  # （nohup ... & 在部分 shell/CI 里会被连带清理；detached spawn 是跨平台可靠做法，
  #   hook 拉起 daemon 用的正是同一机制。）
  # 通过 ZC_STATS_ASAR 把 asar 路径传给 daemon（供其按 --app-path 锚点探活 ZCode）
  "$NODE_BIN" -e '
    const { spawn } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const rt = process.argv[1];
    const asar = process.argv[2] || "";
    const out = fs.openSync(path.join(rt, "daemon.log"), "a");
    const child = spawn(process.execPath, [path.join(rt, "daemon", "daemon.mjs")], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, ZC_STATS_ASAR: asar },
    });
    child.unref();
  ' "$RUNTIME_DIR" "$ZC_ASAR" 2>/dev/null || {
    # 兜底：nohup 后台（带上 ZC_STATS_ASAR）
    ( ZC_STATS_ASAR="$ZC_ASAR" nohup "$NODE_BIN" "$RUNTIME_DIR/daemon/daemon.mjs" >> "$RUNTIME_DIR/daemon.log" 2>&1 & )
  }
}

zc_app_pid() {
  # 输出 ZCode 主进程 pid（用于 zcode.pid 探活；失败则输出空）
  # macOS/Linux 的 Electron 主进程 argv[0] 会被重写成裸 "ZCode"，
  # 但 renderer helper 的 argv 带 --app-path=<...>/app.asar，是可靠锚点；
  # 取其父进程即主进程。Windows 走 tasklist。
  local asar_dir
  if [[ $IS_MAC -eq 1 || $IS_LINUX -eq 1 ]]; then
    # 从带 --app-path 的 renderer 反推主进程 pid
    asar_dir="$(dirname "$ZC_ASAR")"
    local rpid
    rpid="$(pgrep -f -- "--app-path=$asar_dir/app.asar" 2>/dev/null | head -1)"
    if [[ -n "$rpid" ]]; then
      ps -o ppid= -p "$rpid" 2>/dev/null | tr -d ' '
    fi
  elif [[ $IS_WIN -eq 1 ]]; then
    tasklist //FI "IMAGENAME eq ZCode.exe" //FO CSV //NH 2>/dev/null | head -1 | tr -d '"' | cut -d, -f2 | tr -d ' '
  fi
}

zc_os_quarantine_rm() {
  # 仅 macOS 需要移除 quarantine（补丁使签名封条失效）；win/linux no-op
  # 注意 set -e 下函数必须总返回 0（grep 无匹配时返回 1 会让调用方退出）
  if [[ $IS_MAC -eq 1 ]]; then
    if xattr -l /Applications/ZCode.app 2>/dev/null | grep -q com.apple.quarantine; then
      xattr -d com.apple.quarantine /Applications/ZCode.app 2>/dev/null \
        || zc_warn "移除 quarantine 失败，若提示'已损坏'执行: sudo xattr -rd com.apple.quarantine /Applications/ZCode.app"
    fi
  fi
  return 0
}
