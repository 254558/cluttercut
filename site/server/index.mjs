// ClutterCut 本地助手 —— 常驻服务入口（原名 dooit）
// 用法：node server/index.mjs（或 npm run ai）
// 环境变量：
//   AI_PORT            监听端口（默认 9765，仅绑定 127.0.0.1）
//   DEEPSEEK_API_KEY   可选，覆盖 deepseek-key.txt
//   DOOIT_DATA_DIR     可选，把数据目录指到别处（沙盒/打包应用；见 core/paths.mjs）
// 说明：
//   - 路由处理按领域拆在 handlers/ 下：chat.mjs · memory.mjs · todo.mjs · store.mjs ·
//     keys.mjs · backup.mjs，路由表就列在本文件下方；共享基础设施在 core/。
//   - 提供 GET /healthz 供 Vite dev 的提示插件 / 守护脚本探测。
import { createServer } from "node:http";
import { handleChat } from "./handlers/chat.mjs";
import { handleRemember, handleMemory, handleProfile } from "./handlers/memory.mjs";
import { handleTodo } from "./handlers/todo.mjs";
import { handleStore } from "./handlers/store.mjs";
import { handleKeyStatus, handleKeySet } from "./handlers/keys.mjs";
import { handleBackup } from "./handlers/backup.mjs";
import { handleRestore, applyPendingRestore } from "./handlers/restore.mjs";
import { warmMemoryVectors } from "./core/mem-recall.mjs";
import { DATA_DIR } from "./core/paths.mjs";

// 路由表：按 pathname 精确匹配。路径与请求/响应形状在拆分前 handlers.mjs 时代就已定型。
// 记忆「压缩整理/检索/串联/手动增删」不占新路由，作为 /api/memory 的 action 并入 memory.mjs；
// 画像卡读取单列 GET /api/profile（记忆板块展示）；待办清单由 /api/todo 提供（板块 + AI 只读注入）。
const routes = [
  { path: "/api/chat", handler: handleChat },
  { path: "/api/remember", handler: handleRemember },
  { path: "/api/memory", handler: handleMemory },
  { path: "/api/profile", handler: handleProfile },
  { path: "/api/todo", handler: handleTodo },
  { path: "/api/store", handler: handleStore },
  { path: "/api/key/status", handler: handleKeyStatus },
  { path: "/api/key", handler: handleKeySet },
  { path: "/api/backup", handler: handleBackup },
  { path: "/api/restore", handler: handleRestore },
];

const PORT = Number(process.env.AI_PORT) || 9765;
const HOST = "127.0.0.1";
const APP = "dooit-assistant";

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/** 一行请求日志（只记路径与状态，不落消息正文） */
function attachLog(req, res, pathname) {
  const t0 = Date.now();
  res.on("finish", () => {
    log(`${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  res.on("close", () => {
    if (!res.writableEnded) log(`${req.method} ${pathname} -> aborted`);
  });
}

const server = createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === "/healthz") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ ok: true, app: APP, ts: Date.now() }));
    return;
  }
  const route = routes.find((r) => pathname === r.path);
  if (!route) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return;
  }
  attachLog(req, res, pathname);
  try {
    route.handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.end(`internal error: ${err?.message ?? err}`);
  }
});

// 待恢复备份：有暂存包（上次恢复流程请求重启）就先写回数据目录，再开任何库/向量预热。
applyPendingRestore();

// 后台预热长期记忆的本地向量模型（首次全量建向量已完成的话只加载模型，不阻塞启动、不影响首句聊天）
warmMemoryVectors();

server.listen(PORT, HOST, () => {
  log(`${APP} 已启动 -> http://${HOST}:${PORT}  (健康检查 /healthz)`);
  log(`  数据目录: ${DATA_DIR}`);
  log(`  关闭: Ctrl-C`);
});

function shutdown(sig) {
  log(`收到 ${sig}，正在关闭…`);
  server.close(() => process.exit(0));
  // SSE / 渲染中的长连接不拖慢退出
  setTimeout(() => {
    try {
      server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }, 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
