// 「待办清单」域：/api/todo —— 用户手动维护的简单待办（新增/勾选/改文/删除/清已完成）。
// AI 不写这里（只读注入见 chat.mjs），所以不需要提取/勾选模型链路；
// 存储唯一入口是 core/todo-store.mjs（ai-todo.json）。
import { uid, readJson, methodGuard } from "../core/util.mjs";
import { loadTodo, saveTodo } from "../core/todo-store.mjs";

function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** GET /api/todo：列清单；POST：{action:"add"|"toggle"|"edit"|"delete"|"clear-done"} */
async function handleTodo(req, res) {
  if (methodGuard(req, res, ["GET", "POST"])) return;
  if (req.method === "GET") {
    res.end(JSON.stringify({ ok: true, items: loadTodo() }));
    return;
  }
  try {
    const body = await readJson(req);
    const items = loadTodo();
    if (body?.action === "add") {
      const text = normalizeText(body.text);
      if (!text) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "待办内容不能为空" }));
        return;
      }
      items.push({ id: uid(), text, done: false, ts: Date.now() });
      saveTodo(items);
      res.end(JSON.stringify({ ok: true, items: loadTodo() }));
      return;
    }
    if (body?.action === "toggle" && typeof body.id === "string") {
      const it = items.find((x) => x.id === body.id);
      if (!it) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "该待办不存在" }));
        return;
      }
      it.done = !it.done;
      if (it.done) it.doneAt = Date.now();
      else delete it.doneAt;
      saveTodo(items);
      res.end(JSON.stringify({ ok: true, items: loadTodo() }));
      return;
    }
    if (body?.action === "edit" && typeof body.id === "string") {
      const text = normalizeText(body.text);
      const it = items.find((x) => x.id === body.id);
      if (!it) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "该待办不存在" }));
        return;
      }
      if (!text) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "待办内容不能为空" }));
        return;
      }
      it.text = text;
      saveTodo(items);
      res.end(JSON.stringify({ ok: true, items: loadTodo() }));
      return;
    }
    if (body?.action === "delete" && typeof body.id === "string") {
      saveTodo(items.filter((it) => it.id !== body.id));
      res.end(JSON.stringify({ ok: true, items: loadTodo() }));
      return;
    }
    if (body?.action === "clear-done") {
      saveTodo(items.filter((it) => !it.done));
      res.end(JSON.stringify({ ok: true, items: loadTodo() }));
      return;
    }
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "unknown action" }));
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "bad request" }));
  }
}

export { handleTodo };
