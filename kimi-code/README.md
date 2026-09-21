# Kimi Code 会话统计条

给 **Kimi Code 桌面版**（Moonshot AI 的 `Kimi Code.app`）在输入框下方加一行会话统计。
皮肤与 ZCode 版一致（官方 DeepSeek Harness 那套：`999px` 胶囊 + 14px 描边图标 +
ContextMeter 几何的圆环），元素依次是：

```
3 轮 · 189 步 · 186 tok/s   │   37.76M tok · 缓存命中 100%   │   ◔ 33%
仪表盘图标                    数据库图标                        上下文圆环
```

三块都可点击，弹出明细：总量 / 未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 缓存命中 / 输出速度 /
首 token 平均 / 上下文 / 轮数 / 步数 / 模型 / 数据来源。

打开一个很久以前结束的会话同样有数据（总量与缓存命中来自服务端累计），只有需要实时耗时的
两项显示 `—`：

```
2 轮 · 148 步   │   424k tok · 缓存命中 99%   │   ◔ 25%
```

## 快速开始

```bash
bash install.sh      # 安装（幂等，可重复执行）
bash uninstall.sh    # 卸载，界面立刻还原
bash doctor.sh       # 自检：注入状态、脚本版本、语法、单测、渲染层冒烟测试
```

也可以直接双击 **`fix.command`**：它会先还原界面、再装最新版（白屏急救用）。

安装/卸载后需要 **退出并重开 Kimi Code**（Cmd+Q 再打开）才生效。

## 白屏了怎么办（重要）

统计条跑在应用的渲染进程里。如果注入的脚本有 bug（例如挂载时反复写 DOM，被自己的
DOM 观察者观察到 → 微任务永不停歇 → 渲染主线程饿死），界面就会**整片白屏**，连
DevTools 都连不上。

急救：

```bash
bash uninstall.sh        # 撤销注入，把 index.html 还原
```

`uninstall.sh` 不依赖备份文件（App 升级后备份可能过期），它是从当前 index.html 里
删掉注入行，所以跨版本安全。还原后重开 App 即可恢复。

## 原理

桌面版的界面是一份**磁盘上的静态产物**：

```
Kimi Code.app/Contents/Resources/desktop-dist/
```

主进程用 `app://renderer/` 自定义协议按文件直接提供它（见 app.asar 里的
`handleRendererRequest`：读文件、按扩展名给 content-type，没有 CSP、没有完整性校验）。
所以只要在 `desktop-dist/index.html` 里加一行

```html
<script src="/kimi-session-stats.js"></script>
```

统计条就会随界面一起加载。**不需要改 app.asar、不需要守护进程、不需要额外端口**——唯一的
主动请求是每个会话读一次本机 server 的 `/snapshot`（见下文取数通道 3）。

取数有三条通道：

1. **WebSocket**（观察）：用 `Proxy` 包住 `window.WebSocket`（静态成员、原型、`instanceof` 全部保持原样），
   只观察 URL 含 `/api/v1/ws` 的连接，把渲染进程本来就会收到的帧再解析一遍。classic `<script>`
   先于 defer 的 module 脚本执行，所以包装一定早于应用建连。
2. **HTTP 嗅探**（观察）：用 `Proxy` 包住 `window.fetch`，只读 `res.clone()`，解析应用自己请求的
   `GET /sessions/<id>/status` 与 `GET /sessions/<id>/transcript`。
3. **HTTP 自取**（主动，唯一的例外）：`GET /sessions/<id>/snapshot` —— **应用从不请求它**，
   而 `session.usage`（整会话累计 token）只有这里有。统计条自己去读，地址取自
   `sessionStorage['kimi-desktop-server-origin']`（desktop 主进程写给应用的；拿不到时退回
   应用 socket 的 host），每个会话最多一次、失败 60 秒后重试；本地服务对 loopback 请求不校验
   凭据，因此不带任何 token。

实测的数据来源（帧格式与字段都在 `desktop-dist` 的前端 bundle 里核对过）：

| 来源 | 提供什么 |
| --- | --- |
| HTTP `GET /sessions/<id>/snapshot`（**自己取**） | **整会话累计 usage**：`session.usage.input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens`，以及 `context_tokens` / `context_limit`、`agent_config.model`、`busy` |
| HTTP `GET /sessions/<id>/status` | **模型名、上下文已用/窗口**（`context_tokens` / `max_context_tokens` / `context_usage`）、`busy` |
| HTTP `GET /sessions/<id>/transcript?agent_id=main` | 轮/步清单：`items[].kind==='turn'`，`turnId` 形如 `t1`，`steps[]` 带 `ordinal` |
| WS `transcript.reset` / `transcript.ops` | 与上面同构的清单（`payload.snapshot.items`），打开会话时由服务端推送 |
| WS `turn.step.completed` | **usage**（`inputOther`/`output`/`inputCacheRead`/`inputCacheCreation`）、`llmStreamDurationMs`、`llmFirstTokenLatencyMs` |
| WS `turn.started` / `turn.step.started` / `turn.ended`、`event.session.work_changed` | 轮次与运行状态（`busy`） |
| WS `subagent.spawned` | 模型名（兜底；这条线上只有子代理帧带 `model`） |
| WS `event.session.created` | 会话级 usage（含 `context_tokens` / `context_limit`，若服务端给出） |

**两条容易踩空的事实**：

- `transcript` 快照只有"清单"，**没有任何 usage**——turn item 没有 `usage` 字段，step 只有
  `{kind, stepId, turnId, ordinal, state, frames}`，`meta` 只有 `{activity}`（`meta.agent` 在当前
  版本里不出现）。历史会话的 token 累积只能靠 `/snapshot`。
- `GET /sessions/<id>`（应用会请求的那条）里的 `usage` 字段**恒为 0**，别拿它当数据源。

## 口径

- **总量** = 未缓存输入 + 缓存写入 + 输出（不含缓存读取，与本项目 ZCode 版一致）。
- **缓存命中** = 缓存读取 /（未缓存输入 + 缓存读取 + 缓存写入）。
- **输出速度** = 输出 tokens / 累计 stream 时长。**需要 `llmStreamDurationMs`，只有实时帧有**；
  纯历史会话这一行显示 `—`（服务端不提供每步耗时，拿 turn 的墙钟时长顶替会偏低）。
- **首 token 平均** = 各步 `llmFirstTokenLatencyMs` 的平均（同样只来自实时帧）。
- **上下文**：优先用 `/status` 或 `/snapshot` 给的 `context_tokens` / `max_context_tokens`；
  拿不到时退回**最后一步的 prompt tokens**（未缓存输入 + 缓存读取 + 缓存写入）近似。圆环只在
  知道窗口大小时显示百分比，否则详情里只给绝对值。
- **轮/步**：快照清单给出历史基数（轮数 = `kind:'turn'` 的条目数，步数 = 各 turn 的 `steps`
  总数），打开后的实时帧按 `turnId:ordinal` 去重后追加，所以同一步不会重复计数。
- **token 用量**：优先用 `/snapshot` 的服务端累计（详情里"数据来源"显示"服务端累计"）；
  没有任何用量数据时详情显示 `—`（而不是 0），统计条上隐藏用量 pill。
- 子代理步骤不计入（会话里一旦出现主代理步骤，非 `main` 的步骤会被跳过）。

## 自检与测试

```bash
bash doctor.sh                       # 全部检查
node --test test/                    # 核心逻辑 + 渲染层冒烟测试
```

- `test/stats-core.test.mjs`：纯逻辑单测，其中一项会**回放 `~/.kimi-code/server/events/`
  里真实录制的帧**并和独立计算的参考值对齐；其余用例按实测响应形状构造（`transcript` 清单、
  `/status`、`/snapshot` 的 `session.usage`），并覆盖子代理快照不得覆盖主清单这类回归。
- `test/renderer-smoke.test.mjs`：在无头 Chrome 里加载真实脚本 + 模拟 composer + 模拟
  `/status` / `/transcript` 响应，让页面持续产生 DOM 变动，并断言统计条**自己去取**
  `/snapshot` 后由服务端累计接管总量。既防白屏回归，也防"等待数据"回归。没有 Chrome 时自动跳过。

## 权限

macOS 把「修改已安装 App 的内容」视为敏感操作（App 管理 / App Management）。
从终端执行 `install.sh` 时若提示不可写，用：

```bash
sudo bash install.sh
```

改动会让 App 的代码签名封条失效；本地注入不会触发 Gatekeeper（`install.sh` 会顺带
清理 `com.apple.quarantine`），但**不要**用这种改法去分发 App。

## 已知边界

- 皮肤与 ZCode 版一致：三个 `999px` 胶囊（仪表盘图标 + 轮/步/速度、数据库图标 + 总量/缓存命中、
  官方 ContextMeter 几何的圆环 + 百分比），同款描边 / 阴影 / 毛玻璃 / 11.5px 等宽数字。
  **定位方式不同**：ZCode 版把统计条 `position: fixed` 钉在窗口底部、并给输入框加 36px 下边距让位；
  这里作为输入框容器的子元素渲染（跟随输入框，视觉上同样落在输入框下方留白处），
  这样不必改动应用自身的布局。
- Kimi Code 升级会覆盖 `desktop-dist/`，统计条随之消失 —— 重跑 `install.sh` 即可。
- 若应用改了 URL 路由（`/sessions/<id>`）或 `.composer` 类名，统计条会挂不上（不会有其它副作用）。
- **历史空闲会话**：轮数 / 步数 / 总量 / 缓存命中 / 上下文 / 模型都齐全（总量来自 `/snapshot`），
  但**输出速度和首 token 平均显示 `—`** —— 服务端不下发每步耗时（`llmStreamDurationMs` 只出现在
  实时帧里），拿 turn 的墙钟时长顶替会系统性偏低。会话一旦有新活动，这两项立即出现。
- 统计条显示的是**主代理**口径；子代理自身消耗不计入。
- 输入框工具条里本来就有一个 16px 的上下文圆环（应用自带，只显示环形）。统计条里的圆环
  是 DeepSeek Harness 同款样式、额外带百分比数字；如果觉得重复，可以删掉 `buildBar()` 里的
  ring 节点。
- 想现场检查解析结果（不重启 App）：给主进程加 `--remote-debugging-port=9444` 启动，
  用 CDP 连 `app://renderer/...` 的 page target，读 `window.__kimiSessionStats.derive(...)`
  与 `window.__kimiSessionStats.store`。
