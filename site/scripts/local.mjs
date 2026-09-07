// npm run local —— 一条命令拉起 ClutterCut 本地整套（原名 dooit）：
//   [ai]  常驻 AI 本地服务（server/index.mjs，默认 127.0.0.1:9765）
//   [web] Vite dev server（site/，把 /api 代理给 ai 服务，端口 5173）
// Ctrl-C 或任一进程退出时，两个一起结束。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url)); // site/
const PAD = 5;
const children = new Set();

function prefixed(name, child) {
  const color = name === "ai" ? "\x1b[36m" : "\x1b[32m";
  const reset = "\x1b[0m";
  const tag = `${color}[${name}]${reset}`;
  const pump = (stream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        console.log(`${tag.padEnd(PAD + 8)} ${line}`);
      }
    });
  };
  pump(child.stdout);
  pump(child.stderr);
  child.on("exit", (code, sig) => {
    console.log(`${tag.padEnd(PAD + 8)} 已退出 (${(sig || code) ?? 0})`);
    children.delete(child);
    shutdownAll();
  });
}

function shutdownAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 800).unref();
}
let shuttingDown = false;
process.on("SIGINT", shutdownAll);
process.on("SIGTERM", shutdownAll);

// 1) AI 常驻服务
const ai = spawn(process.execPath, [fileURLToPath(new URL("../server/index.mjs", import.meta.url))], {
  cwd: SITE,
  stdio: ["ignore", "pipe", "pipe"],
});
children.add(ai);
prefixed("ai", ai);

// 2) Vite dev（优先直接跑 vite 的 bin，避免依赖 npm 是否在 PATH）
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const web = existsSync(viteBin)
  ? spawn(process.execPath, [viteBin], { cwd: SITE, stdio: ["ignore", "pipe", "pipe"] })
  : spawn("npm", ["run", "dev"], { cwd: SITE, stdio: ["ignore", "pipe", "pipe"] });
children.add(web);
prefixed("web", web);
