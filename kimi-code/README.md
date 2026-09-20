# Kimi Code 会话统计条

给 **Kimi Code 桌面版**（Moonshot AI 的 `Kimi Code.app`）在输入框下方加一行会话统计：

```
● 1 轮 · 34 步 · 157 tok/s   81.84k tok · 缓存命中 97%   ◔ 12%
```

三块都可点击，弹出明细：总量 / 未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 缓存命中 / 输出速度 /
首 token 平均 / 上下文 / 轮数 / 步数 / 模型 / 数据来源。

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

统计条就会随界面一起加载。**不需要改 app.asar、不需要守护进程、不需要额外端口。**

取数走应用自己的 WebSocket 事件流：`renderer/kimi-session-stats.js` 用 `Proxy` 包住
`window.WebSocket`（静态成员、原型、`instanceof` 全部保持原样），只观察 URL 含
`/api/v1/ws` 的连接，把渲染进程本来就会收到的帧再解析一遍。classic `<script>` 会先于
defer 的 module 脚本执行，所以包装一定早于应用建连。

使用的真实帧（都能在 `~/.kimi-code/server/events/*.jsonl` 里查到）：

| 帧 | 用途 |
| --- | --- |
| `turn.step.completed` | usage（inputOther/output/cacheRead/cacheCreate）、stream 时长、首 token 延迟 |
| `transcript.reset` / `transcript.ops` | 会话快照与增量（按 stepId 去重，重放不重复计数） |
| `turn.started` / `turn.step.started` / `turn.ended` | 轮次与运行状态 |
| `event.session.work_changed` | 服务端的 busy 标志（覆盖工具执行阶段） |
| `subagent.spawned` | 模型名（这条线上只有子代理帧带 model） |
| `event.session.created` | 会话级 usage（含 context_tokens / context_limit，若服务端给出） |

## 口径

- **总量** = 未缓存输入 + 缓存写入 + 输出（不含缓存读取，与本项目 ZCode 版一致）。
- **缓存命中** = 缓存读取 /（未缓存输入 + 缓存读取 + 缓存写入）。
- **输出速度** = 输出 tokens / 累计 stream 时长。
- **首 token 平均** = 各步 `llmFirstTokenLatencyMs` 的平均。
- **上下文**：事件流里没有「已用上下文」字段，用**最后一步的 prompt tokens**
  （未缓存输入 + 缓存读取 + 缓存写入）近似；圆环只在服务端给出窗口大小时才显示百分比，
  否则详情里只给绝对值。
- 子代理步骤不计入（会话里一旦出现主代理步骤，非 `main` 的步骤会被跳过）。

## 自检与测试

```bash
bash doctor.sh                       # 全部检查
node --test test/                    # 核心逻辑 + 渲染层冒烟测试
```

- `test/stats-core.test.mjs`：纯逻辑单测，其中一项会**回放 `~/.kimi-code/server/events/`
  里真实录制的帧**并和独立计算的参考值对齐。
- `test/renderer-smoke.test.mjs`：在无头 Chrome 里加载真实脚本 + 模拟 composer，
  并让页面持续产生 DOM 变动，断言**渲染进程仍然响应**（防白屏回归）。没有 Chrome 时自动跳过。

## 权限

macOS 把「修改已安装 App 的内容」视为敏感操作（App 管理 / App Management）。
从终端执行 `install.sh` 时若提示不可写，用：

```bash
sudo bash install.sh
```

改动会让 App 的代码签名封条失效；本地注入不会触发 Gatekeeper（`install.sh` 会顺带
清理 `com.apple.quarantine`），但**不要**用这种改法去分发 App。

## 已知边界

- Kimi Code 升级会覆盖 `desktop-dist/`，统计条随之消失 —— 重跑 `install.sh` 即可。
- 若应用改了 URL 路由（`/sessions/<id>`）或 `.composer` 类名，统计条会挂不上（不会有其它副作用）。
