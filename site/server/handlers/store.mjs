// 「对话存储」域：ai-chat.db（SQLite 单文件，个人数据，已 gitignore）的属主。
// 整份会话文档（{active, convos:[...]}）以 JSON 存进本地 ai-chat.db，
// 取代原来只放浏览器 localStorage 的做法：浏览器清了也不丢，换浏览器/重开也在。
// 另管「删除墓碑」（deleted-convos 行）：多窗口各自整份覆盖保存时，服务端据此滤掉已删对话。
import { DatabaseSync } from "node:sqlite";
import { DB_FILE, toPath } from "../core/paths.mjs";
import { readJson, methodGuard } from "../core/util.mjs";

let chatDb = null;

function chatStore() {
  if (!chatDb) {
    chatDb = new DatabaseSync(toPath(DB_FILE));
    chatDb.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }
  return chatDb;
}

/** 只做最基本的形状校验：id 是字符串、messages 是数组；其余原样保留 */
function sanitizeStoreDoc(x) {
  if (!x || typeof x !== "object" || !Array.isArray(x.convos)) return null;
  return {
    active: typeof x.active === "string" ? x.active : "",
    convos: x.convos
      .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
      .slice(0, 200),
  };
}

function loadStoreDoc() {
  try {
    const row = chatStore().prepare("SELECT v FROM kv WHERE k = ?").get("main");
    if (!row) return null;
    return sanitizeStoreDoc(JSON.parse(row.v));
  } catch {
    return null;
  }
}

function saveStoreDoc(doc) {
  chatStore()
    .prepare("INSERT INTO kv (k, v) VALUES ('main', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(JSON.stringify(doc));
}

/* ---------- 删除墓碑：对话可被“多个窗口/标签页同时打开、各自整份覆盖保存” ----------
 * 每个客户端内存里都有一份完整会话文档，删掉某段对话只改了自己这份，别的窗口稍后
 * 整体 PUT 又会把它写回来。服务端记一份“已删除对话 id”（墓碑），PUT/GET 时把墓碑里的
 * id 一律滤掉，旧副本就再也救不回来。墓碑留 30 天，足以盖过任何陈旧副本。 */

const TOMBSTONE_K = "deleted-convos"; // kv 里的墓碑行
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;
const TOMBSTONE_MAX = 500;

function loadTombstoneIds() {
  try {
    const row = chatStore().prepare("SELECT v FROM kv WHERE k = ?").get(TOMBSTONE_K);
    if (!row) return new Set();
    const list = JSON.parse(row.v);
    if (!Array.isArray(list)) return new Set();
    const now = Date.now();
    const fresh = list.filter((t) => t && typeof t.id === "string" && now - (t.ts || 0) < TOMBSTONE_MS);
    if (fresh.length !== list.length) saveTombstones(fresh);
    return new Set(fresh.map((t) => t.id));
  } catch {
    return new Set();
  }
}

function saveTombstones(list) {
  chatStore()
    .prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(TOMBSTONE_K, JSON.stringify(list.slice(-TOMBSTONE_MAX)));
}

function recordTombstone(id) {
  try {
    const row = chatStore().prepare("SELECT v FROM kv WHERE k = ?").get(TOMBSTONE_K);
    const list = row ? JSON.parse(row.v) : [];
    if (!Array.isArray(list)) return;
    const next = list.filter((t) => t && t.id !== id);
    next.push({ id, ts: Date.now() });
    saveTombstones(next);
  } catch {
    /* 墓碑写不进不阻断主流程 */
  }
}

/** 把已删除（墓碑）的对话从文档里滤掉，并修正 active 指向 */
function stripTombstoned(doc) {
  if (!doc) return null;
  const dead = loadTombstoneIds();
  const convos = dead.size ? doc.convos.filter((c) => !dead.has(c.id)) : doc.convos;
  if (!convos.length) return { active: "", convos };
  const active = convos.some((c) => c.id === doc.active) ? doc.active : convos[0].id;
  return { active, convos };
}

/** GET /api/store：取整份会话；PUT /api/store：整体覆盖保存；
 * POST /api/store {action:"delete-convo", id}：权威删除某段对话（记墓碑，别的窗口写不回） */
async function handleStore(req, res) {
  if (methodGuard(req, res, ["GET", "PUT", "POST"])) return;
  if (req.method === "GET") {
    res.end(JSON.stringify({ ok: true, store: stripTombstoned(loadStoreDoc()) }));
    return;
  }
  try {
    // 对话可能很长，放宽单次体积上限
    const body = await readJson(req, 20e6);
    if (body && typeof body === "object" && body.action === "delete-convo") {
      const id = String(body.id ?? "");
      if (!id) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "bad store document" }));
        return;
      }
      recordTombstone(id);
      const doc = loadStoreDoc();
      if (doc && doc.convos.some((c) => c.id === id)) {
        doc.convos = doc.convos.filter((c) => c.id !== id);
        saveStoreDoc(stripTombstoned(doc));
      }
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const doc = stripTombstoned(sanitizeStoreDoc(body));
    if (!doc) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "bad store document" }));
      return;
    }
    saveStoreDoc(doc);
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "bad request" }));
  }
}

export { handleStore };
