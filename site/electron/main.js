// ClutterCut Electron 壳（dev / packaged 双模式；原名 dooit/Doc_Copilot，内部路径与
// 变量仍用 dooit 前缀，base 仍是 /dooit/ —— 网络约定与既有数据不动）
// dev：起本地 AI 服务 + Vite dev（沿用 scripts/local.mjs），加载 5173 —— 与从前一致。
// packaged：不再依赖 Vite / 固定端口 —— 主进程内嵌一个 node:http 静态宿主，
//   以 /dooit/ 为 base 服务 site/dist，并把 /api 反代给子进程里的 AI 服务
//   （ELECTRON_RUN_AS_NODE 把 Electron 当纯 Node 跑 server/index.mjs，数据目录
//   指到 userData/data）。前端零改动，浏览器/桌面看到的仍是同一个 /dooit/ 站。
// Mac traffic light（关闭/最小化/最大化）用 titleBarStyle:'hidden' 融入页面，
// 不再独占一行 —— 对齐 Hermes 的做法（全宽 38px 顶栏 / TITLEBAR 38 / trafficLight x:24）。
// 前端是裸 Vite+Vue 单页（site/ui/，无 VitePress），页面 CSS 自带全宽 38px 顶栏
// （SectionTabs 固定 y=0，.ds-shell 让位 38px）；这里只注入让顶条可拖拽的规则。
const { app, BrowserWindow, shell, nativeTheme } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

// 顶栏高 38px（SectionTabs 高度）；traffic light 灯串高约 14px，
// y 取 (38/2 - 14/2) = 12 垂直居中悬浮在顶栏内 —— 与 tab 同层，不再独占一行。
const APP_TAB_HEIGHT = 38;
const WINDOW_BUTTON_POSITION = {
  x: 24, // Hermes: trafficLight x:24
  y: (APP_TAB_HEIGHT - 14) / 2, // 12
};
const DEV_APP_URL = "http://localhost:5173/dooit/";

let backend = null; // AI 服务子进程（dev 是 local.mjs，packaged 是 server/index.mjs）
let staticServer = null;
let quitting = false;
let win = null;
let lastAppUrl = null; // 当前窗口加载的站点（mac 上窗口全关后再 activate 时复用）

// AI 服务（server/index.mjs）以该退出码请求“重启应用”：恢复备份流程把包暂存好后退出，
// 主进程据此 relaunch —— 重启后 AI 服务在开库前把暂存包写回数据目录（handlers/restore.mjs）。
const EXIT_RESTART_RESTORE = 77;

// 沙盒/测试（设置了 DOOIT_DATA_DIR）：连 Chromium 用户目录一起指开，
// 绝不碰正式 userData；正常桌面运行不走这里，userData 仍是默认位置。
if (process.env.DOOIT_DATA_DIR) {
  app.setPath("userData", path.join(process.env.DOOIT_DATA_DIR, "..", "dooit-chrome-profile"));
}

/** 拿一个空闲的 127.0.0.1 端口（packaged 静态宿主 / AI 服务用） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 用 http 探测（能正确解析 localhost 的 IPv4/IPv6），避免 TCP 只连 127.0.0.1 漏掉 ::1 */
function probeUp(url, cb) {
  const req = http.get(url, (res) => {
    res.resume();
    req.destroy();
    cb(true);
  });
  req.on("error", () => cb(false));
  req.setTimeout(1200, () => {
    req.destroy();
    cb(false);
  });
}

function waitForServer(url, ok, tries = 80) {
  const req = http.get(url, () => {
    req.destroy();
    ok();
  });
  req.on("error", () => {
    if (tries-- <= 0) return ok(); // 兜底：直接开窗，宿主起来后页面自会请求成功
    setTimeout(() => waitForServer(url, ok, tries), 400);
  });
  req.setTimeout(1500, () => req.destroy());
}

/* ---------- dev 模式：local.mjs 起 [ai]+[web]，页面走 Vite 5173 ---------- */

function startDev(done) {
  // 已有服务在跑（比如 npm run local）就复用，避免端口冲突
  probeUp(DEV_APP_URL, (up) => {
    if (up) return done(DEV_APP_URL);
    const local = path.join(__dirname, "..", "scripts", "local.mjs");
    backend = spawn(process.execPath, [local], {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
    });
    backend.on("exit", () => (backend = null));
    done(DEV_APP_URL);
  });
}

/* ---------- packaged 模式：AI 子进程 + 主进程静态宿主 ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".map": "application/json",
};

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", file.endsWith("index.html") ? "no-cache" : "max-age=31536000, immutable");
    res.end(buf);
  });
}

/** 静态宿主：/dooit/ 前缀映射到 site/dist，/api 反代给 AI 子进程 */
function createStaticHost(aiPort, distDir) {
  return http.createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      // /api -> 本机 AI 服务（请求行原样转发；SSE / 长响应都不缓存）
      const proxy = http.request(
        { host: "127.0.0.1", port: aiPort, method: req.method, path: req.url, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      proxy.on("error", () => {
        res.statusCode = 502;
        res.end("{}");
      });
      req.pipe(proxy);
      return;
    }
    // /dooit/... -> dist 静态文件（找不到就回 SPA 入口 index.html）
    let rel = pathname.startsWith("/dooit/") ? pathname.slice("/dooit".length) : pathname;
    if (rel === "/" || rel === "") rel = "/index.html";
    if (!rel.startsWith("/")) rel = "/" + rel;
    const file = path.normalize(path.join(distDir, rel));
    const exists = file.startsWith(distDir + path.sep) || file === path.join(distDir, "index.html");
    if (!exists || !fs.existsSync(file)) {
      return serveFile(res, path.join(distDir, "index.html"));
    }
    serveFile(res, file);
  });
}

async function startPackaged(done) {
  // AI 子进程数据目录：默认 userData/data（正式运行）；
  // 设置了 DOOIT_DATA_DIR 时以它为准（沙盒/测试把数据与 Chromium 用户目录一起指开）。
  const dataDir = process.env.DOOIT_DATA_DIR || path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const aiPort = await freePort();
  const serverFile = path.join(__dirname, "..", "server", "index.mjs");
  console.log(`[dooit-shell] AI service -> 127.0.0.1:${aiPort}  data=${dataDir}`);
  backend = spawn(process.execPath, [serverFile], {
    // app.asar 不是真实目录，cwd 必须落在资源目录（真实文件系统）上
    cwd: process.resourcesPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DOOIT_DATA_DIR: dataDir, AI_PORT: String(aiPort) },
    stdio: "inherit",
  });
  backend.on("exit", (code) => {
    backend = null;
    if (quitting) return;
    if (code === EXIT_RESTART_RESTORE) app.relaunch(); // 恢复备份：先重启，重启时写回暂存包
    app.quit(); // AI 服务退出：整窗一起关，别留个连不上后端的空壳
  });
  waitForServer(`http://127.0.0.1:${aiPort}/healthz`, () => {
    const distDir = path.join(__dirname, "..", "dist");
    staticServer = createStaticHost(aiPort, distDir);
    staticServer.listen(0, "127.0.0.1", () => {
      const port = staticServer.address().port;
      console.log(`[dooit-shell] static host -> http://127.0.0.1:${port}/dooit/`);
      done(`http://127.0.0.1:${port}/dooit/`);
    });
  });
}

/* ---------- 窗口 ---------- */

function createWindow(appUrl) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#14161c",
    title: "ClutterCut",
    titleBarStyle: "hidden",
    trafficLightPosition: WINDOW_BUTTON_POSITION,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, "preload.cjs"), // 原生全屏状态桥（见 preload.cjs）
    },
  });

  // macOS 原生全屏进出（绿钮 / Ctrl+⌘F）：红绿灯随菜单栏自动隐现。主进程事件比渲染层
  // "inner 尺寸 ≈ screen" 的推断可靠，直接把 isFullscreen 推送过去——顶条收起侧栏钮据此
  // 在灯组消失时左移归位、复现时退回灯组右侧（renderer 侧在 SectionTabs 订阅）。
  const pushFullscreen = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("dooit-native-fullscreen", win.isFullScreen());
  };
  win.on("enter-full-screen", pushFullscreen);
  win.on("leave-full-screen", pushFullscreen);

  win.loadURL(appUrl);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 无顶栏 + 全宽 38px 顶条：顶条整条可拖拽移窗；红绿灯同排左侧是收起/展开侧栏钮
  // （.st-nav__side，x=84 起避开约 52px 宽的灯组），右上角是设置齿轮 —— 两个交互钮都 no-drag。
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(`
      .st-nav { display: flex !important; -webkit-app-region: drag; }
      .st-nav__side, .st-nav__gear { -webkit-app-region: no-drag; }
    `);
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = "dark"; // 深色 Hermes：原生控件/滚动条跟随暗色
  const boot = app.isPackaged ? startPackaged : startDev;
  boot((appUrl) => {
    lastAppUrl = appUrl;
    waitForServer(appUrl, () => createWindow(appUrl));
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && lastAppUrl) createWindow(lastAppUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  quitting = true;
  if (backend) {
    try {
      backend.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
});
