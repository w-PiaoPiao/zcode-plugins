// inject-main.cjs — 经 NODE_OPTIONS=--require 加载进 ZCode 桌面版主进程的悬浮条注入器
//
// 这是免 asar 补丁路线（install.sh 在 fuse node_options=ENABLE 时默认启用）：
//   · 用户级环境变量 NODE_OPTIONS 携带 --require=本文件 → ZCode 主进程启动时加载
//   · 主进程在 did-finish-load 时把悬浮条源码 executeJavaScript 进渲染器
//   · 悬浮条源码与 daemon token 从 ~/.zcode/session-stats/ 运行时读取（不烘焙），
//     token 变更无需重装
// 相比 asar 补丁（app-patch/patch-app.mjs）：不写 Program Files、无需管理员、
// ZCode 更新后无需重新安装。
//
// 安全性：用户级 NODE_OPTIONS 会作用于该用户的所有 node 进程，本文件第一行就按
// process.type 静默退出，保证对普通 node CLI / 渲染进程是 no-op；全程 try/catch，
// 绝不阻塞应用启动。执行结果写 ~/.zcode/session-stats/inject-main.log 供 doctor 核查。
(function () {
  if (process.type !== "browser") return; // 仅 Electron 主进程继续；其余一律 no-op
  try {
    const electron = require("electron");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const RT = path.join(os.homedir(), ".zcode", "session-stats");
    const BAR_FILE = path.join(RT, "bar", "session-stats-bar.js");
    const TOKEN_FILE = path.join(RT, "daemon-token");
    const LOG = path.join(RT, "inject-main.log");
    const log = (m) => {
      try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch {}
    };

    log(`main-process loaded pid=${process.pid}`);

    let cached = null;
    const loadBar = () => {
      if (cached) return cached;
      const src = fs.readFileSync(BAR_FILE, "utf8");
      const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      cached = src.split("__ZC_STATS_TOKEN__").join(token);
      return cached;
    };

    // 只认应用的渲染页（file:…/index.html），跳过 devtools、更新弹窗外的其它窗口
    const looksLikeAppPage = (url) => !!url && /^file:/i.test(url) && /index\.html/i.test(url);

    const inject = (wc) => {
      let src;
      try {
        src = loadBar();
      } catch (err) {
        log(`wc#${wc.id} loadBar failed: ${err.message}`);
        return;
      }
      // 防双注入：页面里已有 bar（如 asar 补丁路线同时生效）则跳过
      const probe = 'document.querySelector("[data-zcstats-bar]") ? "zcstats:present" : "zcstats:absent"';
      wc.executeJavaScript(probe, false)
        .then((r) => {
          if (r !== "zcstats:absent") {
            log(`wc#${wc.id} skip: bar already present`);
            return null;
          }
          return wc.executeJavaScript(src, false).then(() =>
            log(`wc#${wc.id} injected ok url=${String(wc.getURL() || "").slice(0, 90)}`)
          );
        })
        .catch((err) => log(`wc#${wc.id} inject failed: ${err.message}`));
    };

    const watch = (wc) => {
      if (!wc) return;
      try {
        wc.on("did-finish-load", () => {
          if (looksLikeAppPage(wc.getURL())) inject(wc);
        });
        // 注入器挂上时窗口可能已经加载完（早启动竞态兜底）
        if (!wc.isLoading() && looksLikeAppPage(wc.getURL())) inject(wc);
      } catch (err) {
        log(`watch failed: ${err.message}`);
      }
    };

    electron.app.on("web-contents-created", (_e, wc) => watch(wc));
    electron.app.whenReady().then(() => {
      try {
        electron.webContents.getAllWebContents().forEach(watch);
      } catch (err) {
        log(`scan failed: ${err.message}`);
      }
    });
  } catch (err) {
    try {
      require("fs").appendFileSync(
        require("path").join(require("os").homedir(), ".zcode", "session-stats", "inject-main.log"),
        `[${new Date().toISOString()}] FATAL ${err.message}\n`
      );
    } catch {}
  }
})();
