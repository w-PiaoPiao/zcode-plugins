# ZCode 会话统计（session-stats）

在 ZCode 窗口**底部固定一条会话统计悬浮栏**，实时显示当前会话的
token 用量与性能指标（不依赖输入框/聊天区结构，任何界面状态下都显示）：

```
● 6 轮 · 159 步 │ LLM 1h 25m │ 首 token 7.2s · 29 tok/s │ 缓存 98% │ 输入 12.39M · 输出 84.0K
```

- 左侧圆点：会话有轮次正在进行时呈绿色呼吸；空闲时灰色空心；
  统计服务未就绪时呈灰色脉动
- 鼠标悬停任意指标可看精确数值与口径说明
- 自动跟随 ZCode 明暗主题；窗口变窄时按优先级收缩
- **始终显示**：daemon 未就绪（如 ZCode 刚重启、守护进程尚未拉起）时
  显示「会话统计 · 等待本地服务…」，一旦就绪立即显示真实指标，不会消失
- 另有 `/stats` 斜杠命令，可在对话里让模型渲染一张更详细的统计卡片

## 作为 marketplace 安装（hooks / /stats 命令）

本仓库是标准 ZCode 插件市场（顶层 `marketplace.json`）。在 ZCode 中：

1. **设置 → 插件管理 → Discover**，点 **`+` 添加市场**，填入本仓库
   GitHub 地址（`https://github.com/<你的用户名>/<仓库名>`）；
2. 找到 **session-stats** 插件，点 **Get / 安装**；
3. 安装后启用，即获得 hooks（会话指针 + daemon 拉起）与 `/stats` 命令。

> ⚠️ **悬浮条不在 marketplace 机制内**：状态栏需要修改 `ZCode.app` 资源
> （asar 注入），插件市场机制只分发 manifest 声明的组件，无法做到这一点。
> 要在本机显示悬浮条，请继续按下方 **安装** 执行一次 `install.sh`。

## 安装（完整功能，含底部悬浮条）

```bash
bash install.sh
```

然后**重启 ZCode**。脚本会：

1. 把运行时装到 `~/.zcode/session-stats/`（排除日志），并生成本地访问 token
   `daemon-token`（0600，daemon / 状态栏 / CLI 三方共享）
2. 在 `~/.zcode/cli/config.json` 注册 hooks（SessionStart / UserPromptSubmit / Stop）
   与 `/stats` 命令（`~/.zcode/commands/stats.md`）
3. 先检查 ZCode 的 asar 完整性 fuse（若已开启则拒绝注入并说明原因），再给
   `/Applications/ZCode.app` 的 `app.asar` 注入状态栏
   （原文件备份为 `app.asar.zcstats-orig` 并记录版本元数据，可随时还原；
   发现备份与当前构建不一致时自动刷新备份）
4. 重启本地统计守护进程（仅监听 127.0.0.1:47771，带 token 才能读取）

## 卸载

```bash
bash uninstall.sh
```

还原 app.asar、移除 hooks 与命令、停掉守护进程并清理运行时（含 token）。重启 ZCode 生效。

## 自检

```bash
bash doctor.sh
```

一键检查：补丁状态、fuse、备份与 ZCode 版本是否一致、hooks/命令/token 是否就位、
daemon 鉴权与数据链路、CLI 输出。ZCode 更新后怀疑插件失效时先跑它。

## 数据从哪来

ZCode 桌面版本来就把每次模型请求写进本地数据库
`~/.zcode/cli/db/db.sqlite`（`model_usage` / `turn_usage` / `tool_usage` 表）。
本插件只做**只读**聚合（macOS 自带 sqlite3，`mode=ro` 打开，不影响运行中的 ZCode）：

| 指标 | 口径 |
|---|---|
| 轮 | 不同 `parent_user_message_id` 数（用户消息触发的轮） |
| 步 | 不同 `logical_request_id` 数（智能体循环中的模型请求） |
| LLM | 已完成请求的 `duration_ms` 总和（含重试，不含工具执行） |
| 首 token | 请求级 TTFT 的**中位数**（抗重试长尾干扰） |
| tok/s | 总输出 ÷（总耗时 − 总 TTFT） |
| 缓存 | `cache_read / (input + cache_write)` |
| 输入/输出 | 累计 token（输入随轮数增长是正常的——每步都重发上下文） |

## 架构

```
hooks(on-event.mjs)──写会话指针──┐
                                 ▼
ZCode 数据库 ◄──只读查询── daemon.mjs ──HTTP 127.0.0.1:47771──► 悬浮条(注入渲染器)
                                 ▲                              │ 每秒轮询
/stats 命令 ──► bin/cli.mjs ─────┘（守护进程不在时直查数据库）  │ ?session=<当前窗口会话>
                                                                ▼
                                     固定底部悬浮条（尽力探测 taskId，失败回退最近活跃）
```

- 状态栏为**固定底部悬浮条**：`position: fixed` 挂载于 body，不依赖输入框/聊天区
  等业务 DOM，React 重渲染、切换会话、聊天区整体重建都不影响显示；
  窗口/标签会话通过渲染器组件的 taskId 尽力探测（失败自动回退最近活跃会话）。
- 本地 HTTP 接口有 token 鉴权（`~/.zcode/session-stats/daemon-token`，0600）并校验
  Host 头；CORS 只回显请求方 Origin。浏览器里任意网页都无法跨源读取统计
  （无 token 一律 403），也不受 DNS rebinding 影响。
- `app-patch/patch-app.mjs` 负责注入：改写 asar 头部（注入 index.html 一行
  `<script>` + 新增状态栏脚本），流式拷贝原数据后原子替换。
  注入前会检查 Electron 的 asar 完整性 fuse（实测 ZCode 为关闭状态，
  补丁可正常启动；若未来版本开启该 fuse，脚本会拒绝注入而不是把 app 打坏）。

## 已知限制

- **ZCode 更新后需重跑 `bash install.sh`**（更新会整体替换 app.asar）。
  应用设置为不自动更新时无影响。可先跑 `bash doctor.sh` 确认状态。
- ZCode 刚启动、守护进程尚未被拉起时，悬浮条显示「等待本地服务…」占位；
  发送一条消息（hook 拉起 daemon）或 daemon 就绪后自动显示真实指标。
- 补丁使 app 的资源签名封条失效（本地修改的代价）。已自动移除 quarantine
  隔离属性；若系统仍弹"已损坏"，执行：
  `sudo xattr -rd com.apple.quarantine /Applications/ZCode.app`
- 每个窗口/标签显示**自己的**会话统计（状态栏通过渲染器组件的 taskId 定位
  当前会话）；组件结构变化导致定位失败时，自动回退显示最近活跃的会话。
- 首个数据点需要该会话至少有一次模型请求记录；新开的空会话显示全 0。

## 文件结构

```
marketplace.json             市场清单（ZCode 添加本仓库为市场时读取）
plugins/session-stats/       插件本体（marketplace 安装的组件包）
  .zcode-plugin/plugin.json  插件 manifest（hooks + /stats 命令声明）
  hooks/hooks.json           插件版 hook 声明
  hooks/on-event.mjs         hook 入口：记会话指针 + 拉起守护进程
  daemon/daemon.mjs          本地统计守护进程（127.0.0.1:47771，token 鉴权）
  core/stats-core.mjs        数据库只读聚合
  bin/cli.mjs                命令行（--json 供 /stats 用）
  bin/configure.mjs          hooks/命令注册器
  commands/stats.md          /stats 命令定义
app-patch/
  session-stats-bar.js       底部悬浮条 UI（注入渲染器，零依赖 vanilla JS）
  patch-app.mjs              asar 注入/还原/状态工具（含 fuse 检查与备份元数据）
install.sh / uninstall.sh   一键安装/卸载（含 asar 注入）
doctor.sh                   一键自检
# 运行时产物（install.sh 生成于 ~/.zcode/session-stats/）：
#   daemon-token               本地 HTTP 访问 token（0600）
#   current-session.json       当前会话指针（hooks 写入）
```
