#!/bin/bash
# doctor.sh — session-stats 一键自检（跨平台）
# 检查：app 补丁 / fuse / 备份版本 / 运行时与配置 / daemon 鉴权与数据链路 / CLI
# 用法：bash doctor.sh   （有问题时以非零码退出）

set -uo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SRC_DIR/lib/zcenv.sh"

# 未装 node 时仍尽量给出诊断
zc_find_node 2>/dev/null || NODE_BIN=""

CONFIG="$ZCODE_DIR/cli/config.json"
TOKEN_FILE="$RUNTIME_DIR/daemon-token"
PORT="${ZC_STATS_PORT:-47771}"

# 免补丁路线是否已配置（用户级 NODE_OPTIONS 带 inject-main.cjs）
UOPT="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('NODE_OPTIONS','User')" 2>/dev/null || true)"
B_ACTIVE=0
[[ "$UOPT" == *inject-main.cjs* ]] && B_ACTIVE=1

ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[1;31m✘\033[0m %s\n' "$*"; }
info() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
sec()  { printf '\n\033[1m[%s]\033[0m\n' "$*"; }

FAILS=0

# ---------- 1. app 补丁与 fuse ----------
sec "1. app 补丁与 fuse"
if [[ -z "$NODE_BIN" ]]; then
  bad "未找到 node，无法检查补丁"
  FAILS=$((FAILS+1))
elif zc_locate_asar --soft 2>/dev/null; then
  ST="$("$NODE_BIN" "$SRC_DIR/app-patch/patch-app.mjs" status --asar "$ZC_ASAR" 2>/dev/null || true)"
  if [[ -z "$ST" ]]; then
    bad "无法读取补丁状态（patch-app.mjs status 失败）"
    FAILS=$((FAILS+1))
  else
    eval "$("$NODE_BIN" -e '
      const j = JSON.parse(process.argv[1]);
      const out = [];
      out.push(`PATCHED=${j.patched ? 1 : 0}`);
      out.push(`FUSE=${j.fuse?.status || "?"}`);
      out.push(`ZV=${JSON.stringify(j.zcodeVersion || "")}`);
      out.push(`BV=${JSON.stringify(j.backupVersion || "")}`);
      console.log(out.join("; "));
    ' "$ST")"
    if [[ "$PATCHED" == "1" ]]; then
      ok "app.asar 已注入状态栏 ($ZC_ASAR)"
    elif [[ "$B_ACTIVE" == "1" ]]; then
      info "asar 未注入 —— 渲染端走 NODE_OPTIONS 免补丁路线（正常）"
    else
      bad "app.asar 未注入 —— 状态栏不会显示，请重跑 install.sh"
      FAILS=$((FAILS+1))
    fi
    if [[ "$FUSE" == "ok" ]]; then
      ok "asar 完整性 fuse 关闭，注入安全"
    elif [[ "$FUSE" == "blocked" ]]; then
      bad "asar 完整性 fuse 已开启 —— 不能注入（强行打补丁会导致 app 无法启动）"
      FAILS=$((FAILS+1))
    else
      info "fuse 状态未知（$FUSE），跳过"
    fi
    if [[ -n "$ZV" && -n "$BV" && "$ZV" != "$BV" ]]; then
      info "备份来自 ZCode $BV，当前为 $ZV —— 建议重跑 install.sh 刷新备份"
    elif [[ -z "$BV" ]]; then
      info "备份暂无版本元数据（旧版脚本生成，内容仍有效；下次刷新备份时自动补上）"
    else
      ok "备份版本与当前 ZCode 一致 ($ZV)"
    fi
    # 状态栏脚本为固定底部悬浮条（不再依赖 .chat-composer-region 锚点）
    if LC_ALL=C grep -aq "position: fixed" "$SRC_DIR/app-patch/session-stats-bar.js"; then
      ok "状态栏脚本为固定悬浮条实现（无 composer 锚点依赖）"
    else
      bad "状态栏脚本缺少固定定位特征，请确认使用的是新版 session-stats-bar.js"
      FAILS=$((FAILS+1))
    fi
  fi
else
  bad "未能定位 ZCode 的 app.asar —— 请确认 ZCode 桌面版已安装（Linux AppImage 需解包）"
  FAILS=$((FAILS+1))
fi

# ---------- 2. 运行时与配置 ----------
sec "2. 运行时与配置"
check() {
  if "$@" >/dev/null 2>&1; then ok "${CHECK_DESC}"; else bad "${CHECK_DESC}"; FAILS=$((FAILS+1)); fi
}
CHECK_DESC="运行时目录 $RUNTIME_DIR";                 check test -d "$RUNTIME_DIR"
CHECK_DESC="hook 入口 on-event.mjs 存在";             check test -f "$RUNTIME_DIR/hooks/on-event.mjs"
CHECK_DESC="hooks 已注册（config.json 含标记）";      check grep -q "zc-session-stats" "$CONFIG"
CHECK_DESC="/stats 命令已安装";                       check test -f "$ZCODE_DIR/commands/stats.md"
CHECK_DESC="cli.mjs 存在";                            check test -f "$RUNTIME_DIR/bin/cli.mjs"
if [[ "$B_ACTIVE" == "1" ]]; then
  CHECK_DESC="NODE_OPTIONS 免补丁路线已配置（用户级）";  check test -f "$RUNTIME_DIR/inject-main.cjs"
  CHECK_DESC="悬浮条源码就位（bar/session-stats-bar.js）"; check test -f "$RUNTIME_DIR/bar/session-stats-bar.js"
fi
if [[ -f "$TOKEN_FILE" ]]; then
  # Windows 无 POSIX 权限位，跳过权限检查
  if [[ $IS_WIN -eq 1 ]]; then
    ok "token 文件存在"
  else
    P="$(stat -f %Lp "$TOKEN_FILE" 2>/dev/null || stat -c %a "$TOKEN_FILE" 2>/dev/null || true)"
    if [[ "$P" == "600" ]]; then ok "token 文件存在且权限 600"; else info "token 文件权限为 ${P:-?}（建议 600，重跑 install.sh 修正）"; fi
  fi
else
  bad "token 文件缺失 —— 请重跑 install.sh"
  FAILS=$((FAILS+1))
fi
if [[ -f "$RUNTIME_DIR/current-session.json" ]] && [[ -n "$(find "$RUNTIME_DIR/current-session.json" -mmin -120 2>/dev/null)" ]]; then
  ok "会话指针 2h 内有更新（hooks 在正常触发）"
else
  info "会话指针超过 2h 未更新（可能只是近期没有对话）"
fi

# ---------- 3. daemon 与数据链路 ----------
sec "3. daemon 与数据链路"
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
if [[ -z "$TOKEN" ]]; then
  bad "无 token，跳过 daemon 检查"
  FAILS=$((FAILS+1))
else
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "x-zcstats-token: $TOKEN" "http://127.0.0.1:$PORT/v1/health" || true)"
  if [[ "$CODE" == "200" ]]; then
    ok "daemon 健康 (127.0.0.1:$PORT)"
  else
    bad "daemon 未运行或 token 不符（HTTP ${CODE:-无响应}）—— 请重跑 install.sh"
    FAILS=$((FAILS+1))
  fi
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/v1/stats" || true)"
  if [[ "$CODE" == "403" ]]; then
    ok "无 token 请求被拒绝（403）—— 鉴权生效"
  else
    info "无 token 请求返回 ${CODE:-无响应}（旧版 daemon？重跑 install.sh 重启它）"
  fi
  BODY="$(curl -s -m 3 -H "x-zcstats-token: $TOKEN" "http://127.0.0.1:$PORT/v1/stats" || true)"
  AVAIL="$("$NODE_BIN" -e '
    try {
      const j = JSON.parse(process.argv[1]);
      console.log(j.available ? "yes" : "no:" + (j.reason || "?"));
    } catch { console.log("parse-error"); }
  ' "$BODY" 2>/dev/null || echo "empty")"
  if [[ "$AVAIL" == "yes" ]]; then
    ok "统计数据可用（daemon → db.sqlite 链路正常）"
  else
    bad "统计数据不可用：$AVAIL"
    FAILS=$((FAILS+1))
  fi
fi

# ---------- 4. CLI 冒烟 ----------
sec "4. CLI 冒烟"
if [[ -n "$NODE_BIN" ]] && OUT="$("$NODE_BIN" "$RUNTIME_DIR/bin/cli.mjs" --json 2>&1)" && printf '%s' "$OUT" | grep -q '"available": true'; then
  ok "cli.mjs --json 正常（含 token 请求头路径）"
else
  info "cli.mjs 未返回可用统计（daemon 未就绪或未装 node）：$(printf '%s' "$OUT" | head -c 120)"
fi

# ---------- 结果 ----------
printf '\n'
if [[ $FAILS -eq 0 ]]; then
  printf '\033[1;32m自检通过 ✔\033[0m\n'
else
  printf '\033[1;31m%d 项未通过 —— 见上方 ✘ 条目\033[0m\n' "$FAILS"
fi
exit "$FAILS"
