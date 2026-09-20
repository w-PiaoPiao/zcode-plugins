#!/bin/bash
# doctor.sh — 一键自检：注入状态、文件版本、数据链路、核心逻辑、渲染层
set -uo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="kimi-session-stats.js"
MARKER="<script src=\"/$SCRIPT_NAME\"></script>"
EVENTS_DIR="${KIMI_CODE_HOME:-$HOME/.kimi-code}/server/events"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

FAIL=0

head_ "1. App"
APP=""
for c in "${KIMI_CODE_APP:-}" "/Applications/Kimi Code.app" "$HOME/Applications/Kimi Code.app" "/Applications/Kimi Code Canary.app"; do
  [[ -n "$c" && -d "$c" ]] && { APP="$c"; break; }
done
if [[ -z "$APP" ]]; then
  bad "未找到 Kimi Code.app"
  FAIL=1
else
  ok "App: $APP"
  DIST="$APP/Contents/Resources/desktop-dist"
  INDEX="$DIST/index.html"
fi

head_ "2. 注入状态"
if [[ -n "$APP" ]]; then
  if [[ -f "$INDEX" ]]; then
    COUNT=$(grep -cF "$MARKER" "$INDEX" 2>/dev/null || true)
    COUNT=${COUNT:-0}
    if [[ "$COUNT" -eq 1 ]]; then
      ok "index.html 已注入（1 行）"
    elif [[ "$COUNT" -eq 0 ]]; then
      bad "index.html 未注入 —— 运行 bash install.sh"
      FAIL=1
    else
      warn "index.html 里有 $COUNT 行注入（旧的重复注入）—— 重跑 bash install.sh 会清理成 1 行"
    fi
  fi
  if [[ -f "$DIST/$SCRIPT_NAME" ]]; then
    ok "脚本已就位：$DIST/$SCRIPT_NAME"
    if diff -q "$SRC_DIR/renderer/$SCRIPT_NAME" "$DIST/$SCRIPT_NAME" >/dev/null 2>&1; then
      ok "与仓库版本一致"
    else
      warn "与仓库版本不一致（App 更新过？重跑 install.sh 可刷新）"
    fi
  else
    bad "缺少 $SCRIPT_NAME"
    FAIL=1
  fi
  if [[ -f "$INDEX.kimi-stats.bak" ]]; then
    ok "原 index.html 备份存在"
  else
    warn "没有备份文件（首次安装会创建；缺失不影响卸载）"
  fi
fi

head_ "3. 脚本语法 / 核心逻辑 / 渲染层"
if command -v node >/dev/null 2>&1; then
  if node --check "$SRC_DIR/renderer/$SCRIPT_NAME" 2>/dev/null; then
    ok "语法检查通过（node $(node -v)）"
  else
    bad "语法检查失败"
    FAIL=1
  fi
  if [[ -f "$SRC_DIR/test/stats-core.test.mjs" ]]; then
    if OUT="$(node --test "$SRC_DIR/test/" 2>&1)"; then
      PASSED=$(printf '%s' "$OUT" | grep -c '^✔' || true)
      ok "单元测试 + 渲染层冒烟测试通过（${PASSED:-?} 项）"
    else
      bad "测试失败：node --test test/"
      printf '%s\n' "$OUT" | grep -E '^(✖|not ok)' | head -5 | sed 's/^/      /'
      FAIL=1
    fi
  fi
else
  warn "未找到 node，跳过（仅影响自检，不影响 App 内运行）"
fi

head_ "4. 数据链路"
if [[ -d "$EVENTS_DIR" ]]; then
  COUNT=$(ls -1 "$EVENTS_DIR"/session_*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$COUNT" -gt 0 ]]; then
    ok "$EVENTS_DIR 下有 $COUNT 个会话帧日志（App 运行中会持续追加）"
  else
    warn "$EVENTS_DIR 下暂无会话帧日志（用 App 发一轮对话即可产生）"
  fi
else
  warn "未找到 $EVENTS_DIR（Kimi Code 还没跑过会话？）"
fi

head_ "5. 运行时环境"
if grep -q 'ks-bar' "$SRC_DIR/renderer/$SCRIPT_NAME"; then
  ok "样式已内联（随主题变量自适应深浅色）"
else
  bad "脚本中缺少样式"
  FAIL=1
fi
if command -v pgrep >/dev/null 2>&1 && pgrep -f "MacOS/Kimi Code" >/dev/null 2>&1; then
  warn "Kimi Code 正在运行 —— 修改需重启 App 才生效"
fi

printf '\n'
if [[ "$FAIL" -eq 0 ]]; then
  printf '\033[32m自检通过。\033[0m\n'
  printf '界面白屏 / 异常时：\033[36mbash %s/uninstall.sh\033[0m 还原，再重跑 install.sh。\n' "$SRC_DIR"
else
  printf '\033[31m自检发现问题（见上）。\033[0m\n'
fi
exit "$FAIL"
