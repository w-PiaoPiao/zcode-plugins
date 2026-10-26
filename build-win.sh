#!/bin/bash
# build-win.sh — 组装 Windows 分发包到 dist/
#
# 产物：dist/zcode-session-stats-<version>-win/    解包即可用的源码 + 一键入口
#       dist/zcode-session-stats-<version>-win.zip
#
# 包内容 = 仓库中被 git 跟踪的文件（天然排除 .git / dist / 日志 / 运行时产物）
#          + 三个 Windows 双击入口（install.cmd / uninstall.cmd / doctor.cmd）
#          + README-Windows.md
#
# 入口 .cmd 只做一件事：定位 Git Bash → cd 到包目录 → 调 bash 跑原有的 *.sh。
# 安装逻辑全部留在原来的 shell 脚本里，不重复实现一份 Windows 版，避免两套逻辑漂移。
#
# 三个 .cmd 一律 ASCII，不内嵌中文：cmd.exe 按当前 OEM 代码页（简中 = 936）解码批处理
# 文件，内嵌 UTF-8 中文会被误解码，把 echo 行撕成非法命令（实测：
# `'部署运行时到' 不是内部或外部命令`）。中文说明放 README-Windows.md；
# install.sh / doctor.sh 自己输出的中文由 bash 直接写字节，配 chcp 65001 显示正常。
#
# 用法：bash build-win.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SRC_DIR"

log() { printf '\033[36m[build-win]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[build-win]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "需要 node（用于读取版本号）"
command -v tar  >/dev/null 2>&1 || die "需要 tar"
git rev-parse --git-dir >/dev/null 2>&1 || die "不是 git 仓库"

# zip 用 Windows 自带的 bsdtar：Git Bash 里的 tar 是 GNU tar，不支持 zip 格式。
# 不用 Compress-Archive —— PowerShell 5.1 写出来的是反斜杠分隔符（不合 ZIP 规范，
# 在 macOS/Linux 上解压会得到带反斜杠的文件名），只在没有 bsdtar 时才退回它。
BSDTAR="${SYSTEMROOT:-C:\\Windows}/System32/tar.exe"
[[ -x "$BSDTAR" ]] || BSDTAR="$(command -v tar.exe || true)"

# 用相对路径：$SRC_DIR 是 Git Bash 的 /c/... 形式，Windows 上的 node 解析不了
VERSION="$(node -p "require('./marketplace.json').plugins[0].version")"
NAME="zcode-session-stats-${VERSION}-win"
OUT="$SRC_DIR/dist/$NAME"
ZIP="$SRC_DIR/dist/$NAME.zip"

log "版本 $VERSION → dist/$NAME"

# 有未提交改动时，包里装的是工作区当前内容而不是某个提交，先说清楚
if [[ -n "$(git status --porcelain)" ]]; then
  log "注意：工作区有未提交改动，打包内容 = 当前文件内容"
fi

rm -f "$ZIP" 2>/dev/null || true

# Windows 上 rm -rf 偶尔报 "Device or resource busy"：有进程（终端 cwd、Defender 扫描）
# 短暂持有目录句柄。重试一次，仍失败就改名挪开，不阻塞本次打包。
remove_dir() {
  local d="$1"
  [[ -e "$d" ]] || return 0
  rm -rf "$d" 2>/dev/null && return 0
  sleep 1
  rm -rf "$d" 2>/dev/null && return 0
  mv "$d" "$d.stale.$$" 2>/dev/null || die "无法清理 $d（请关掉占用它的终端后重试）"
  log "旧目录被占用，已改名为 $(basename "$d").stale.$$，可稍后手动删除"
}
remove_dir "$OUT"
mkdir -p "$OUT"

# ---------- 1. 复制被跟踪的文件 ----------
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$OUT"
log "已复制 $(git ls-files | wc -l | tr -d ' ') 个跟踪文件"

# ---------- 2. 入口共用片段 ----------
# 定位 Git for Windows。不用 for 列表写候选路径：%ProgramFiles(x86)% 里的括号会让
# for 的解析出错。同样不把 set 放进 if ( ... ) 块里，避免整块预展开。
# 最后一条 where bash 的兜底要求路径含 "Git"，否则会选中 WSL 的 System32\bash.exe。
locate_block() {
  cat <<'CMD'

rem ---------- locate Git Bash ----------
set "BASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH if exist "%USERPROFILE%\scoop\apps\git\current\bin\bash.exe" set "BASH=%USERPROFILE%\scoop\apps\git\current\bin\bash.exe"
if not defined BASH for /f "delims=" %%G in ('where git 2^>nul') do if not defined BASH if exist "%%~dpG..\bin\bash.exe" set "BASH=%%~dpG..\bin\bash.exe"
if not defined BASH for /f "delims=" %%B in ('where bash 2^>nul') do if not defined BASH set "CAND=%%B"
if not defined BASH if defined CAND echo %CAND% | findstr /i "Git" >nul && set "BASH=%CAND%"
set "CAND="
if not defined BASH goto nobash
CMD
}

nobash_block() {
  cat <<'CMD'

:nobash
echo.
echo [ERROR] Git Bash not found - cannot continue.
echo.
echo   This package runs its shell installers through Git Bash.
echo   Please install Git for Windows first:
echo       https://git-scm.com/download/win
echo   Accept the default options (Git Bash is included),
echo   then double-click this file again.
echo.
pause
exit /b 1
CMD
}

# 入口 .cmd 必须是 CRLF：CRLF + goto 标签在 LF-only 下会跳错位置
crlf() { sed -i 's/\r$//; s/$/\r/' "$1"; }

# ---------- 3. install.cmd ----------
{
  cat <<'CMD'
@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title ZCode Session Stats - Install

cd /d "%~dp0"

echo.
echo ============================================================
echo   ZCode Session Stats - Windows one-click install
echo ============================================================
echo.
echo   This will:
echo     [1] Deploy the runtime to  %USERPROFILE%\.zcode\session-stats
echo     [2] Register hooks (SessionStart / UserPromptSubmit / Stop)
echo         and the /stats command
echo     [3] Inject the stats bar into ZCode's app.asar
echo         - one UAC prompt if ZCode lives under Program Files
echo         - waits for ZCode to exit, patches, then relaunches it
echo     [4] Start the local stats daemon on 127.0.0.1:47771
echo.
echo   The plugin only READS ZCode's own session database.
echo   Your original app.asar is backed up first; uninstall.cmd restores it.
echo.
echo   Chinese details, requirements and troubleshooting: README-Windows.md
echo.
pause
CMD
  locate_block
  cat <<'CMD'

echo.
echo [1/1] Running install.sh through Git Bash
echo        %BASH%
echo.
"%BASH%" -lc "bash ./install.sh"
if errorlevel 1 goto failed

echo.
echo ============================================================
echo   Done. Quit and reopen ZCode - two pills appear in the
echo   whitespace below the composer. Click either one for details.
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo [FAILED] install.sh returned a non-zero code.
echo          Send the whole output above to the developer, or run
echo          doctor.cmd first. Every step is idempotent: fix the
echo          cause and double-click this file again.
echo.
pause
exit /b 1
CMD
  nobash_block
} > "$OUT/install.cmd"

# ---------- 4. uninstall.cmd ----------
{
  cat <<'CMD'
@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title ZCode Session Stats - Uninstall

cd /d "%~dp0"

echo.
echo ============================================================
echo   ZCode Session Stats - uninstall / restore
echo ============================================================
echo.
echo   Restores app.asar from backup, unregisters the hooks and the
echo   /stats command, removes the injection entry from the user-level
echo   NODE_OPTIONS, and stops the local daemon.
echo   ZCode is back to stock after the next restart.
echo.
pause
CMD
  locate_block
  cat <<'CMD'

echo.
echo [1/1] Running uninstall.sh through Git Bash
echo        %BASH%
echo.
"%BASH%" -lc "bash ./uninstall.sh"
if errorlevel 1 goto failed

echo.
echo [DONE] Uninstall finished. Reopen ZCode.
echo.
pause
exit /b 0

:failed
echo.
echo [FAILED] uninstall.sh returned a non-zero code.
echo          Please send the output above to the developer.
echo.
pause
exit /b 1
CMD
  nobash_block
} > "$OUT/uninstall.cmd"

# ---------- 5. doctor.cmd ----------
{
  cat <<'CMD'
@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title ZCode Session Stats - Doctor

cd /d "%~dp0"
CMD
  locate_block
  cat <<'CMD'

echo.
echo ============================================================
echo   ZCode Session Stats - health check (read-only)
echo ============================================================
echo.
"%BASH%" -lc "bash ./doctor.sh"
set "RC=%ERRORLEVEL%"
echo.
echo Exit code %RC%   (0 = all checks passed; see the X marks above)
echo.
pause
exit /b %RC%
CMD
  nobash_block
} > "$OUT/doctor.cmd"

for f in install.cmd uninstall.cmd doctor.cmd; do crlf "$OUT/$f"; done
log "已写入 3 个 Windows 入口（CRLF，纯 ASCII）"

# ---------- 6. 包内说明 ----------
cat > "$OUT/README-Windows.md" <<'MD'
# Windows 分发包

解压后**双击 `install.cmd`** 即可，其余什么都不用做。

| 文件 | 作用 |
|---|---|
| `install.cmd` | 一键安装：部署运行时 + 注册 hooks/命令 + 注入 `app.asar` + 启动守护进程 |
| `doctor.cmd` | 一键自检（只读）：补丁 / fuse / daemon / 数据链路 / CLI 各自的状态 |
| `uninstall.cmd` | 一键还原：`app.asar` 恢复备份、清 hooks 与 NODE_OPTIONS、停守护进程 |

三个 `.cmd` 自身的提示是英文的——`cmd.exe` 按本机 OEM 代码页（简中为 936）解码批处理
文件，内嵌 UTF-8 中文会被误解码、把命令行撕成非法命令。真正干活的 `install.sh` /
`doctor.sh` 输出的中文不受影响，照常显示。

## 前置条件

1. 已安装 **ZCode 桌面版**。
2. 已安装 **Node.js ≥ 22.13**。命令行里 `node -v` 能出结果即可；
   取数用 Node 内置的 `node:sqlite`，不需要另外装 sqlite3。
3. 已安装 **Git for Windows**。入口靠它自带的 Git Bash 运行 `.sh`；
   没装的话双击 `install.cmd` 会直接给出下载地址。

## 会发生什么

- ZCode 装在 `C:\Program Files\ZCode` 时：注入 `app.asar` 需要管理员权限，会弹**一次 UAC**。
  点「是」后由一个隐藏 helper 等待 ZCode 全部退出、打补丁，然后自动把 ZCode 重新拉起，
  不需要你手动开管理员终端，也不需要掐着时机退出 ZCode。
- ZCode 装在 `%LOCALAPPDATA%\Programs\ZCode` 时完全不需要提权。
- 装完**退出并重开 ZCode**，输入框下方留白区出现两枚胶囊，点击弹出详情弹层。
- 想还原就双击 `uninstall.cmd`；原 `app.asar` 是从备份恢复的。

## 出问题

先跑 `doctor.cmd`，把输出整段留着。卸载永远可用：`uninstall.cmd` 不依赖安装时的备份文件
（它是从当前文件里删掉注入内容），所以跨 ZCode 版本也安全。

安装/卸载/自检的完整说明见包内 `README.md`（仓库主文档）。
MD

# ---------- 7. 打包 ----------
if [[ -x "$BSDTAR" ]]; then
  "$BSDTAR" -a -cf "$ZIP" -C "$SRC_DIR/dist" "$NAME" || die "bsdtar 打包失败"
else
  log "未找到 bsdtar，退回 PowerShell Compress-Archive（分隔符会是反斜杠）"
  powershell -NoProfile -Command "\$ErrorActionPreference='Stop'; Compress-Archive -Path '$(cygpath -w "$OUT")' -DestinationPath '$(cygpath -w "$ZIP")' -Force" \
    || die "Compress-Archive 失败"
fi
[[ -f "$ZIP" ]] || die "zip 未生成"

log "打包完成"
printf '\n  %s\n  目录 %s  （%s）\n\n' "dist/$NAME.zip" "dist/$NAME/" "$(du -sh "$ZIP" | cut -f1)"
