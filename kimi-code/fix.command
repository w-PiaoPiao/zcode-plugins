#!/bin/bash
# fix.command — 双击运行（macOS）：白屏急救 + 装最新版统计条
#
# 做两件事：
#   1. 还原 Kimi Code 的 index.html（撤销任何旧注入）→ 界面立刻恢复可用
#   2. 安装当前仓库里的统计条 → 重启后统计条出现
#
# 双击即可。若系统提示权限不足，请在终端里手动执行：
#   bash uninstall.sh && bash install.sh
set -uo pipefail
cd "$(dirname "$0")"

echo "=============================================="
echo " Kimi Code 会话统计条 — 修复并安装"
echo "=============================================="
echo
echo "[1/2] 还原 Kimi Code 界面（撤销旧注入）"
bash ./uninstall.sh || true
echo
echo "[2/2] 安装当前版本的统计条"
bash ./install.sh

echo
echo "按回车关闭此窗口。"
read -r _
