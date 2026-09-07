// 会话持久化 / 迁移 / 删除墓碑 —— 从 DeepSeekDocChat.vue 拆出的纯逻辑（不碰模板/UI）。
// 组件通过 bindChatPersistence 注入一组状态读写（convos/activeId/ready + activate），
// localStorage 读写、SQLite /api/store、防抖落盘、pagehide sendBeacon
// 都在这里收敛；初始化完成后由组件触发一次 initStore。
// convo.absorbed：该对话已被「会话整段消化（digestSession）」吸收到的消息条数——
// 只做“本次离开是否值得再消化”的判断记账，消息内容本身不落这份存储。
import { watch, type Ref } from "vue";
import { apiRequest } from "./api";

const STORAGE_KEY = "doc-copilot-convos-v2";
const LEGACY_KEY = "doc-copilot-thread-v1";
const DEL_PENDING_KEY = "doc-copilot-del-pending"; // 连不上服务端时暂存的待删对话 id

function uid() {
  return (globalThis.crypto?.randomUUID?.()) || `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

export function nowTs() {
  return Date.now();
}

export function makeConvo() {
  const t = nowTs();
  return { id: uid(), title: "New chat", createdAt: t, updatedAt: t, absorbed: 0, messages: [] };
}

// 清洗：把各来源（本机存储 / 旧浏览器缓存）的文档统一成标准结构
function sanitizeDoc(st: any) {
  if (!st || !Array.isArray(st.convos)) return null;
  const list = st.convos
    .filter((c: any) => c && typeof c.id === "string")
    .map((c: any) => ({
      id: c.id,
      title: typeof c.title === "string" && c.title ? c.title : "新对话",
      createdAt: typeof c.createdAt === "number" ? c.createdAt : 0,
      updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
      absorbed: typeof c.absorbed === "number" ? c.absorbed : 0,
      messages: Array.isArray(c.messages)
        ? c.messages.filter(
            (m: any) => m && (m.role === "user" || m.role === "assistant") && !m.pending && !m.streaming,
          )
        : [],
    }));
  if (!list.length) return null;
  const active =
    typeof st.active === "string" && list.some((c: any) => c.id === st.active) ? st.active : list[0].id;
  return { convos: list, active };
}

/** 读浏览器里的旧缓存：仅用于「本机还没有数据」时的一次性迁移 */
function browserLegacy() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const doc = sanitizeDoc(JSON.parse(raw));
      if (doc) return doc;
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
  // 更早的版本存在 sessionStorage 单线程，迁成一个历史会话
  try {
    const raw = sessionStorage.getItem(LEGACY_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const msgs = arr.filter(
          (m: any) => m && (m.role === "user" || m.role === "assistant") && !m.pending && !m.streaming,
        );
        if (msgs.length) {
          const firstUser = msgs.find((m: any) => m.role === "user");
          const t = nowTs();
          const convo = {
            id: uid(),
            title: firstUser && firstUser.text ? firstUser.text.slice(0, 24) : "Imported",
            createdAt: t,
            updatedAt: t,
            messages: msgs,
          };
          return { convos: [convo], active: convo.id };
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

interface ChatPersistenceState {
  convos: Ref<any[]>; // 整份会话（[{ id, title, createdAt, updatedAt, messages }]，新对话在前）
  activeId: Ref<string>;
  ready: Ref<boolean>; // 载入完成前不落盘，避免把旧数据冲掉
  activate: (id: string) => void; // 载入后切到存档里的 active 会话
}

export function bindChatPersistence(state: ChatPersistenceState) {
  const { convos, activeId, ready, activate } = state;

  async function apiStore(method: string, doc?: unknown) {
    return apiRequest("/api/store", {
      method,
      ...(doc
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) }
        : {}),
    });
  }

  function snapshot() {
    return {
      active: activeId.value,
      convos: convos.value.map((c: any) => ({
        ...c,
        messages: c.messages
          .filter((m: any) => !m.pending && !m.streaming)
          // __host 是挂回答的 DOM 引用，序列化只会变成 {}，不落盘
          .map((m: any) => {
            const { __host, ...rest } = m;
            return rest;
          }),
      })),
    };
  }

  let saveTimer = 0;
  // 已删除但还没送达服务端（当时连不上）的对话 id：下次 persist / 页面卸载前补发删除墓碑，
  // 防止别的窗口/标签页用旧整份文档把它们写回来（服务端会把墓碑 id 一律滤掉）
  const pendingDeletes = new Set<string>();

  function syncPendingDeletes() {
    try {
      localStorage.setItem(DEL_PENDING_KEY, JSON.stringify([...pendingDeletes]));
    } catch {
      /* 忽略 */
    }
  }

  function loadPendingDeletes() {
    try {
      const raw = localStorage.getItem(DEL_PENDING_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) arr.forEach((id: unknown) => typeof id === "string" && pendingDeletes.add(id));
    } catch {
      /* 忽略 */
    }
  }

  async function apiDeleteConvo(id: string) {
    return apiRequest("/api/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete-convo", id }),
      signal: AbortSignal.timeout(6000),
    });
  }

  /** 把没送出去的删除墓碑补发给服务端（幂等；连不上就留着下次再试） */
  async function replayPendingDeletes() {
    for (const id of [...pendingDeletes]) {
      try {
        await apiDeleteConvo(id);
        pendingDeletes.delete(id);
      } catch {
        /* 暂时连不上：留在队列，下次 persist 再试 */
      }
    }
    syncPendingDeletes();
  }

  let dirty = false; // 是否有真实改动（只读浏览离开时不应覆盖服务端）

  async function persist() {
    saveTimer = 0;
    if (!ready.value) return; // 初始化完成前不写，避免把旧数据冲掉
    await replayPendingDeletes();
    try {
      await apiStore("PUT", snapshot());
    } catch {
      // 连不上本机存储：先静默，下次改动会自动重试
    }
  }

  // 页面卸载前的最后一笔改动，用 sendBeacon 带走（比 fetch 可靠）
  function flushBeacon() {
    if (!ready.value) return;
    // 先补发删除墓碑，再走整份快照（避免旧快照把刚删的对话带回去）
    for (const id of [...pendingDeletes]) {
      try {
        const del = JSON.stringify({ action: "delete-convo", id });
        if (navigator.sendBeacon) {
          navigator.sendBeacon("/api/store", new Blob([del], { type: "application/json" }));
        }
      } catch {
        /* 忽略 */
      }
    }
    // 只读浏览（无真实改动）离开时，不整档覆盖服务端——避免多个标签页/实例
    // 用各自的快照互相覆盖，把别人的对话抹掉
    if (!dirty) return;
    dirty = false;
    let data: string;
    try {
      data = JSON.stringify(snapshot());
    } catch {
      return;
    }
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/store", new Blob([data], { type: "application/json" }));
      } else {
        void fetch("/api/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: data,
          keepalive: true,
        });
      }
    } catch {
      /* 忽略 */
    }
  }

  /* ---------- 初始化：从本机 SQLite 载入（浏览器旧缓存仅首次迁移） ---------- */

  async function initStore() {
    let doc: any = null;
    let onServer = true; // 本机存储是否可用
    try {
      const data: any = await apiStore("GET");
      doc = sanitizeDoc(data?.store);
    } catch {
      onServer = false;
    }
    if (!doc && onServer) {
      // 本机还没有对话：才补发删除墓碑 + 把浏览器里的旧数据迁上去（服务端确认收到后才清缓存）
      loadPendingDeletes();
      await replayPendingDeletes();
      const legacy = browserLegacy();
      if (legacy) {
        try {
          await apiStore("PUT", legacy);
          doc = legacy;
        } catch {
          onServer = false;
        }
      }
    }
    if (!doc && !onServer) {
      // 连不上本机存储时，用浏览器缓存兜底展示
      loadPendingDeletes();
      doc = browserLegacy();
    }
    let seeded = false; // 本机确实空库，需要把初始会话落一次
    if (doc) {
      convos.value = doc.convos;
      activeId.value = doc.active;
    } else {
      const c = makeConvo();
      convos.value.push(c);
      activeId.value = c.id;
      seeded = true;
    }
    activate(activeId.value);
    if (onServer) {
      // 已由本机接管，浏览器里的旧副本不再需要
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* 忽略 */
      }
      try {
        sessionStorage.removeItem(LEGACY_KEY);
      } catch {
        /* 忽略 */
      }
    }
    ready.value = true;
    if (seeded) void persist(); // 空库初始会话落一次（此后只随真实改动落盘）
  }

  // 会话内容一变就防抖落盘。注意只在初始化完成后生效：
  // initStore 把 GET 结果赋进 convos 也会命中这个 watch，若那也算改动并回写，
  // 就会拿一份可能比服务端旧的快照做整档覆盖——比如“刚新建的对话还没落库、
  // 就切去文档页又立刻回来”，回来这次 GET 到的是旧档，随后的自动回写会把
  // 那条新对话从服务端抹掉。
  watch(
    convos,
    () => {
      if (!ready.value) return; // 初始化赋值不算用户改动，不触发落盘
      dirty = true; // 真实改动：用户发送/删除/新建会话
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        dirty = false;
        void persist();
      }, 250);
    },
    { deep: true },
  );

  let disposed = false;

  // SPA 切页时组件卸载前调用：取消防抖并把最后一笔改动立刻落库（不等 250ms），
  // 这样马上重进主页时 GET 已能看到新数据；同时摘掉 pagehide 监听，避免旧实例
  // 在以后真正关页时再用旧闭包向服务端发一份过期整档。
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", flushBeacon);
    }
    // 只读浏览（无真实改动）卸载时同样不覆盖服务端
    if (ready.value && dirty) {
      dirty = false;
      void persist();
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushBeacon);
  }

  return {
    persist,
    /** 删除会话：本地队列记墓碑并同步到 localStorage，下次 persist / 卸载时补发服务端 */
    queueDelete(id: string) {
      pendingDeletes.add(id);
      syncPendingDeletes();
    },
    initStore,
    dispose,
  };
}
