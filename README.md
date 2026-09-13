# ZCode Session Stats（会话统计）

[English](#english) · [中文](#中文)

Two **session stats pills** for the ZCode desktop app, pinned to the whitespace below
the chat composer, showing real-time token usage and performance metrics of the
current session. Click a pill to open a detail dialog. Always visible in chat views,
independent of the chat layout.

为 ZCode 桌面版打造的**会话统计双胶囊**，固定在聊天输入框下方的留白区，实时显示
当前会话的 token 用量与性能指标，点击胶囊弹出详情弹层。聊天视图内**始终显示**，
不依赖聊天区布局。

```
● 6 turns · 12 steps · 42 tok/s      12.42M tok · cache hit 98%
  gauge pill → "Session stats"        db pill → "Token usage" dialog

● 6 轮 · 12 步 · 42 tok/s      12.42M tok · 缓存命中 98%
  仪表盘 pill →「会话统计」弹层   数据库 pill →「Token 用量」弹层
```

## Features 功能

- **Two pills below the composer**, aligned with the DeepSeek Harness official design:
  a gauge pill (`N turns · M steps · X tok/s` + live dot) and a db pill
  (`total tok · cache hit %`). Survives React re-renders, session switches, and layout
  rebuilds.
  **输入框下方双胶囊**，对齐 DeepSeek Harness 官方设计：仪表盘 pill（轮/步 + tok/s +
  状态点）与数据库 pill（累计 token · 缓存命中）。React 重渲染、切换会话、布局重建
  都不影响。
- **Click a pill for a detail dialog** — "Session stats" (LLM time, tool time, avg
  TTFT, output speed) and "Token usage" (cache hit, uncached input / cache read /
  cache write / output, all exact token counts). Anchored above the pill, closes on
  outside click / Escape, the two dialogs are mutually exclusive, and content
  refreshes with the 1s polling while open.
  **点击胶囊弹出详情**——「会话统计」（LLM 用时、工具用时、首 token 平均、输出速度）
  与「Token 用量」（缓存命中、未缓存输入/缓存读取/缓存写入/输出，均为精确 token 数）。
  弹层锚定在胶囊上方，点击外部 / Escape 关闭，两个弹层互斥，打开期间随每秒轮询刷新。
- Green breathing dot on the gauge pill while a turn is running; gray while idle;
  pulsing gray while the local daemon is warming up.
  轮次进行中圆点绿色呼吸，空闲灰色，本地服务未就绪时灰色脉动。
- View-gated: shows only in chat conversation views (hidden on the settings page and
  in the update window); a new/draft chat shows all zeros instead of the previous
  session's data.
  视图门控：仅在聊天对话视图显示（设置页、更新弹窗中隐藏）；新建对话显示全 0，
  不残留上一个会话的数据。
- Follows the ZCode light/dark theme; pills shrink gracefully on narrow windows.
  跟随明暗主题；窄窗口自动收缩。
- `/stats` slash command renders a detailed stats card in chat.
  `/stats` 斜杠命令在对话中渲染详细统计卡片。

---

## English

### Install from GitHub

#### Option A — Marketplace (hooks + `/stats` command only)

This repo is a standard ZCode plugin marketplace. In ZCode:

1. **Settings → Plugin Management → Discover** → click **`+` (Add marketplace)** and
   enter the repo URL:
   `https://github.com/w-PiaoPiao/zcode-plugins`
2. Find **session-stats** and click **Get / Install**, then enable it.

This gives you the hooks (session pointer + daemon auto-start) and the `/stats`
command.

> ⚠️ The **status bar itself is NOT installable via the marketplace**: it needs to
> patch `ZCode.app` resources (asar injection), which the plugin-marketplace mechanism
> cannot do. To get the pills, run Option B once on the machine.

#### Option B — Full install (with the stats pills)

Requires **ZCode desktop** + **Node.js ≥ 22.13** (node:sqlite built-in).

```bash
git clone https://github.com/w-PiaoPiao/zcode-plugins.git
cd zcode-plugins
bash install.sh
```

Then **restart ZCode** (Cmd+Q / quit & reopen). The script:

1. Installs the runtime to `~/.zcode/session-stats/` and generates (or reuses) a
   local access token (`daemon-token`, 0600) shared by daemon / pills / CLI. Reusing
   keeps the token baked into an already-patched asar valid across reinstalls.
2. Registers hooks (`SessionStart` / `UserPromptSubmit` / `Stop`) and the `/stats`
   command in `~/.zcode/cli/config.json` + `~/.zcode/commands/stats.md`.
3. Checks the asar integrity fuse, then injects the status bar into ZCode's
   `app.asar` (auto-locates it on macOS / Windows / Linux). Original asar is backed up
   with version metadata; restorable anytime.
4. Restarts the local stats daemon (`127.0.0.1:47771`, token-gated).

#### Platform support 平台支持

| Platform | Status | Notes |
|---|---|---|
| macOS (Intel / Apple Silicon) | ✅ Full | Auto-locates `/Applications/ZCode.app` |
| Linux (x64 / arm64, Beta) | ✅ Full | Auto-detects install path (`~/.local/share`, `/opt`, …); AppImage must be extracted first |
| Windows (x64 / arm64) | ✅ Full | Run `bash install.sh` under Git Bash / MSYS2; auto-locates `%LOCALAPPDATA%\Programs\ZCode` and `C:\Program Files\ZCode` |

#### Windows notes

- ZCode installed under `C:\Program Files` needs **administrator rights** to patch
  `app.asar`. `install.sh` handles it automatically: approve **one UAC prompt**, then a
  hidden helper waits for all ZCode processes to exit, applies the patch (with retry
  against transient locks), and relaunches ZCode with normal privileges. You only need
  to quit ZCode whenever convenient.
- Per-user installs (`%LOCALAPPDATA%\Programs\ZCode`) need no elevation at all.
- All renderer-side child processes (the 30s `tasklist` liveness probe, daemon spawn,
  sqlite3 fallback) are spawned with `windowsHide`, so no console windows flash.
- A no-patch route via `NODE_OPTIONS=--require` was investigated and is **not feasible**:
  Electron filters most `NODE_OPTIONs` in packaged apps
  (`node_bindings.cc: "Most NODE_OPTIONs are not supported in packaged apps"`), so the
  main process never loads the injected module — even with the `node_options` fuse enabled.

#### Uninstall / Doctor

```bash
bash uninstall.sh   # restores app.asar, removes hooks/command, clears the NODE_OPTIONS entry, stops daemon
bash doctor.sh      # one-shot health check (patch, fuse, daemon, data link, CLI)
```

#### Data source

ZCode desktop already records every model request into
`~/.zcode/cli/db/db.sqlite`. This plugin only does **read-only** aggregation via
Node's built-in `node:sqlite` (no external sqlite3 needed on any platform).

| Metric | Definition |
|---|---|
| Turns | Distinct `parent_user_message_id` (user-message turns) |
| Steps | Distinct `logical_request_id` (model requests in the agent loop) |
| LLM time | Sum of `duration_ms` of completed requests (incl. retries, excl. tool time) |
| Tool time | Sum of `duration_ms` of completed tool calls (parallel calls summed) |
| TTFT | **Average** request-level TTFT (aligned with DeepSeek's "first token avg") |
| tok/s | Total output ÷ (total duration − total TTFT) |
| Cache | `cache_read / (input + cache_write)`; displayed as 100% when ≥ 99.5% |
| Total | Uncached input + cache write + output (the db pill value; `inputTokens` already includes cache read) |
| In / Out | Cumulative tokens (input grows with turns — context is resent every step) |

#### Architecture

```
hooks(on-event.mjs)─write session pointer─┐
                                          ▼
ZCode DB ◄─read-only─ daemon.mjs ──HTTP 127.0.0.1:47771──► pills + dialogs (injected renderer)
                                          ▲                              │ polls every 1s
/stats command ─► bin/cli.mjs ───────────┘ (falls back to direct DB)    │ ?session=<active>
                                                                         ▼
                                    gauge pill (turns/steps · tok/s · live dot)
                                    db pill (total tok · cache hit) → detail dialogs
                                    (session id: DOM data-session-id, fiber taskId fallback)
```

The pills also POST their view/positioning diagnostics to the daemon every 15s
(written to `daemon.log`, for troubleshooting only).

#### Known limitations

- **Re-run `bash install.sh` after every ZCode update** (updates replace `app.asar`).
  Run `bash doctor.sh` first to confirm state.
- The patch invalidates the app's code signature; quarantine is auto-removed. If the
  system still reports "damaged", run:
  `sudo xattr -rd com.apple.quarantine /Applications/ZCode.app` (macOS only).
- Right after ZCode launches, before the daemon is up, the gauge pill shows
  "session stats · waiting for local service…" and switches to real metrics
  automatically.
- For troubleshooting: the pills POST their view/positioning state to the daemon
  every 15s; check `~/.zcode/session-stats/daemon.log`.

---

## 中文

### 从 GitHub 安装

#### 方式 A — 作为 marketplace 安装（仅 hooks + `/stats` 命令）

本仓库是标准 ZCode 插件市场。在 ZCode 中：

1. **设置 → 插件管理 → Discover** → 点 **`+`（添加市场）**，填入仓库地址：
   `https://github.com/w-PiaoPiao/zcode-plugins`
2. 找到 **session-stats**，点 **Get / 安装** 并启用。

安装后获得 hooks（会话指针 + daemon 自动拉起）与 `/stats` 命令。

> ⚠️ **统计胶囊本身无法通过 marketplace 安装**：它需要修改 `ZCode.app` 资源
> （asar 注入），而插件市场机制只能分发 manifest 声明的组件。要显示胶囊，
> 请在本机执行一次方式 B。

#### 方式 B — 完整安装（含统计胶囊）

前置：**ZCode 桌面版** + **Node.js ≥ 22.13**（自带 node:sqlite）。

```bash
git clone https://github.com/w-PiaoPiao/zcode-plugins.git
cd zcode-plugins
bash install.sh
```

然后**重启 ZCode**。脚本会：

1. 把运行时装到 `~/.zcode/session-stats/`（排除日志），生成本地访问 token
   `daemon-token`（0600，daemon / 胶囊 / CLI 三方共享；已有则复用，
   避免已打补丁 asar 内烘焙的旧 token 失效）
2. 在 `~/.zcode/cli/config.json` 注册 hooks（SessionStart / UserPromptSubmit / Stop）
   与 `/stats` 命令（`~/.zcode/commands/stats.md`）
3. 先检查 asar 完整性 fuse，再把状态栏注入 ZCode 的 `app.asar`
   （macOS/Windows/Linux 自动定位；原 asar 备份并记录版本，可随时还原）
4. 重启本地统计守护进程（仅监听 127.0.0.1:47771，带 token 才能读取）

#### 平台支持

| 平台 | 支持 | 说明 |
|---|---|---|
| macOS（Intel / Apple Silicon） | ✅ 完整 | 自动定位 `/Applications/ZCode.app` |
| Linux（x64 / arm64，Beta） | ✅ 完整 | 自动探测安装位置（`~/.local/share`、`/opt` 等）；AppImage 需先解包 |
| Windows（x64 / arm64） | ✅ 完整 | 在 Git Bash / MSYS2 下运行 `bash install.sh`；自动定位 `%LOCALAPPDATA%\Programs\ZCode` 与 `C:\Program Files\ZCode` |

#### Windows 说明

- ZCode 装在 `C:\Program Files` 时，打补丁需要**管理员权限**。`install.sh` 已自动处理：
  批准**一次 UAC**后，后台隐藏辅助脚本会等待所有 ZCode 进程退出 → 打补丁（带重试，
  可穿过杀软瞬时锁）→ 以普通权限自动重启 ZCode。你只需在方便时正常关闭 ZCode。
- 用户级安装（`%LOCALAPPDATA%\Programs\ZCode`）全程无需提权。
- 渲染端所有子进程调用（每 30s 的 `tasklist` 探活、daemon 拉起、sqlite3 兜底）均已加
  `windowsHide`，不会闪 cmd 窗口。
- `NODE_OPTIONS=--require` 免补丁路线已验证**不可行**：Electron 对打包应用过滤大多数
  NODE_OPTIONs（`node_bindings.cc: "Most NODE_OPTIONs are not supported in packaged apps"`），
  即使 `node_options` fuse 开启，主进程也不会加载注入模块。

#### 卸载 / 自检

```bash
bash uninstall.sh   # 还原 app.asar、移除 hooks/命令、清理 NODE_OPTIONS 注入项、停 daemon
bash doctor.sh      # 一键自检（补丁/fuse/daemon/数据链路/CLI）
```

#### 数据从哪来

ZCode 桌面版本来就把每次模型请求写进本地数据库
`~/.zcode/cli/db/db.sqlite`。本插件只做**只读**聚合，统一走 Node 内置
`node:sqlite`（任何平台都无需外部 sqlite3）。

| 指标 | 口径 |
|---|---|
| 轮 | 不同 `parent_user_message_id` 数（用户消息触发的轮） |
| 步 | 不同 `logical_request_id` 数（智能体循环中的模型请求） |
| LLM | 已完成请求的 `duration_ms` 总和（含重试，不含工具执行） |
| 工具 | 已完成工具调用的 `duration_ms` 总和（并行调用按时长求和） |
| 首 token | 请求级 TTFT 的**平均值**（对齐 DeepSeek 官方「首 token 平均」口径） |
| tok/s | 总输出 ÷（总耗时 − 总 TTFT） |
| 缓存 | `cache_read / (input + cache_write)`；≥ 99.5% 时显示为 100% |
| 总量 | 未缓存输入 + 缓存写 + 输出（数据库 pill 展示值；`inputTokens` 本身已含缓存读） |
| 输入/输出 | 累计 token（输入随轮数增长是正常的——每步都重发上下文） |

#### 架构

```
hooks(on-event.mjs)──写会话指针──┐
                                 ▼
ZCode 数据库 ◄──只读── daemon.mjs ──HTTP 127.0.0.1:47771──► 双胶囊 + 弹层(注入渲染器)
                                 ▲                          │ 每秒轮询
/stats 命令 ──► bin/cli.mjs ─────┘（daemon 不在时直查库）   │ ?session=<当前会话>
                                                            ▼
                              仪表盘 pill（轮/步 · tok/s · 状态点）
                              数据库 pill（总量 · 缓存命中）→ 点击弹详情弹层
                    （会话 id：DOM data-session-id 优先，React fiber taskId 兜底）
```

渲染端每 15s 把视图/定位诊断 POST 给 daemon，写入 `daemon.log`（仅排障用）。

#### 已知限制

- **ZCode 更新后需重跑 `bash install.sh`**（更新会整体替换 app.asar）。
  可先跑 `bash doctor.sh` 确认状态。
- 补丁使 app 的资源签名封条失效（本地修改的代价）。已自动移除 quarantine；
  若系统仍弹"已损坏"，执行：
  `sudo xattr -rd com.apple.quarantine /Applications/ZCode.app`（仅 macOS）
- ZCode 刚启动、守护进程尚未就绪时，仪表盘 pill 显示「会话统计 · 等待本地服务…」，
  就绪后自动切到真实指标。
- 排障：渲染端每 15s 把视图/定位内部状态上报给 daemon，写在
  `~/.zcode/session-stats/daemon.log`。

---

## File structure 文件结构

```
marketplace.json              Marketplace manifest（ZCode 添加本仓库为市场时读取）
plugins/session-stats/        Plugin package (components installed by the marketplace)
  .zcode-plugin/plugin.json   Plugin manifest（hooks + /stats command）
  hooks/hooks.json            Hook declarations
  hooks/on-event.mjs          Hook entry: session pointer + daemon autostart
  daemon/daemon.mjs           Local stats daemon (127.0.0.1:47771, token-gated)
  core/stats-core.mjs         Read-only DB aggregation (node:sqlite)
  bin/cli.mjs                 CLI (--json for /stats)
  bin/configure.mjs           Hooks/command registrar
  commands/stats.md           /stats command definition
app-patch/
  session-stats-bar.js        Pill bar UI + detail dialogs (injected renderer, vanilla JS)
  patch-app.mjs               asar patch/restore/status (fuse check, backup metadata)
  inject-main.cjs             Main-process injector for the NODE_OPTIONS no-patch route (reserved)
  probe-fuse.mjs              Electron fuse reader (no-patch route feasibility)
  set-node-options.mjs        User-level NODE_OPTIONS read/merge/remove (Windows)
lib/
  zcenv.sh                    Cross-platform env detection + daemon lifecycle
install.sh / uninstall.sh     One-shot install / uninstall (cross-platform)
doctor.sh                     One-shot health check
```

Runtime artifacts (created by `install.sh` in `~/.zcode/session-stats/`):
`daemon-token` (0600), `current-session.json` (session pointer), `daemon.log`
(daemon log + renderer diagnostics), `daemon.pid`, `zcode.pid`, `.inject-mode`
(renderer injection route: `patch` / `no-patch`), `.installed-asar` (patched asar
path, used by uninstall to restore).

## License

MIT
