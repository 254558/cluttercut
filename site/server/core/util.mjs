// 跨模块共享的小工具：HTTP 读 body、唯一 id、文本规范化、宽松 JSON 解析、日期键、
// JSON 文件读写。宽松 JSON 解析与日期键原属旧 organize 时代的工具，随记忆压缩整理
// （memory-tidy.mjs）回归。
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const toFsPath = (p) => (p instanceof URL ? fileURLToPath(p) : p);

/** 读满请求体（超限销毁连接）。所有 JSON handler 共用。 */
export function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > maxBytes) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** 读满请求体并 JSON.parse；解析失败抛错（各 handler 自行按原有语义回 400）。 */
export async function readJson(req, maxBytes = 1e6) {
  return JSON.parse(await readBody(req, maxBytes));
}

/* ---------- JSON 文件读写（原子写：先写临时文件再 rename，避免进程中断留下半截）
 * ai-memory.json / ai-todo.json / ai-profile.json 等个人数据的唯一读写出口。 */

/** 读 JSON 文件；文件缺失/损坏返回 fallback。file 接受路径字符串或 URL。 */
export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(toFsPath(file), "utf8"));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON 文件（带 2 空格缩进）；写失败会清掉临时文件再抛出。 */
export function writeJsonFile(file, value) {
  const p = toFsPath(file);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    renameSync(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** 记录/条目用唯一 id（沿用原 memoryUid 的短 id 格式）。 */
export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 归一化：压空白、去句末标点，便于去重比较 */
export function normFact(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。．.！!？?；;，,、]+$/g, "");
}

/** 本地日期键 YYYY-MM-DD（服务端视角的“今天”）。 */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 宽松 JSON 解析 ----------
 * 模型输出常带代码块围栏、前后说明或中文全角引号，逐级降级尝试还原成对象/数组。
 * 记忆逐轮提取与压缩整理的方案解析共用这一份。 */

function parseJsonObj(s) {
  if (!s) return null;
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const d = JSON.parse(obj[0]);
      if (d && typeof d === "object") return d;
    } catch {
      /* 整段再试 */
    }
  }
  try {
    const d = JSON.parse(s);
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

function tryParseJsonish(s) {
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const d = parseJsonObj(fence[1].trim());
    if (d) return d;
    s = fence[1].trim(); // 围栏内容整体再试一次
  }
  return parseJsonObj(s);
}

export function parseLooseJson(raw) {
  const base = String(raw ?? "").trim();
  if (!base) return null;
  // 第一遍原样解析：ASCII 引号的合法 JSON 直接过；正文里带中文引号（“…”）也不受影响。
  const a = tryParseJsonish(base);
  if (a) return a;
  // 第二遍：模型有时把 JSON 的引号整体打成中文全角——归一化成 ASCII 再试
  // （正文里再夹中文引号的极端情况会解析失败，任务编辑路径另有 salvage 兜底）
  const norm = base.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  if (norm !== base) {
    const b = tryParseJsonish(norm);
    if (b) return b;
  }
  return null;
}

/* ---------- HTTP 路由样板 ----------
 * 各领域 handler 顶部原来各自重复一段：CORS 头 + OPTIONS 预检 + JSON 405。
 * 统一收敛到这里，行为完全一致（chat.mjs 走 SSE / 纯文本错误，只借用 corsOpen）。 */

/** 打开 CORS 头并吞掉 OPTIONS 预检；返回 true 表示预检已由本函数应答 */
export function corsOpen(req, res, methods) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", `${methods}, OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

/** 标 JSON content-type；方法不在允许列表就回 405 JSON 并返回 true */
export function jsonMethod(req, res, methods) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!methods.includes(req.method)) {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    return true;
  }
  return false;
}

/** 一步守卫：corsOpen 吞 OPTIONS 预检，方法不符由 jsonMethod 回 405 JSON。
 *  返回 true 表示本轮已应答，handler 直接 return。chat.mjs 不用它（走 SSE/纯文本错误）。 */
export function methodGuard(req, res, methods) {
  return corsOpen(req, res, methods) || jsonMethod(req, res, methods);
}
