// ai-todo.json 属主：用户自维护的「待办清单」（个人信息，只存本机、已 gitignore）。
// 读/写/规范化只走这里；handlers/todo.mjs 的增删改查与 chat.mjs 的每轮注入都从本模块取数。
// 排序约定：未完成在前（新建的在前），已完成沉底（按完成时间新→旧）。
// 上限兜底，避免文件无限膨胀；到顶时丢最旧的已完成/最早条目，正常使用不易触达。
import { readJsonFile, writeJsonFile } from "./util.mjs";
import { TODO_FILE } from "./paths.mjs";

const TODO_MAX = 500;

export function loadTodo() {
  const raw = readJsonFile(TODO_FILE, null);
  if (raw && Array.isArray(raw.items)) {
    const items = raw.items
      .filter((it) => it && typeof it.text === "string")
      .map((it) => ({
        id: String(it.id ?? ""),
        text: String(it.text).trim().slice(0, 300),
        done: Boolean(it.done),
        ts: Number(it.ts) || 0,
        ...(it.done ? { doneAt: Number(it.doneAt) || Number(it.ts) || 0 } : {}),
      }))
      .filter((it) => it.id && it.text);
    return sortTodo(items);
  }
  return [];
}

function sortTodo(items) {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1; // 未完成在前
    const ka = a.done ? a.doneAt : a.ts;
    const kb = b.done ? b.doneAt : b.ts;
    return kb - ka;
  });
}

export function saveTodo(items) {
  const out = sortTodo(items).slice(0, TODO_MAX);
  writeJsonFile(TODO_FILE, { items: out });
}
