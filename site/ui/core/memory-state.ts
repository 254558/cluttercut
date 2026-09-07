// 「长期记忆」共享状态：聊天页逐轮自动沉淀（rememberTurn）/ 离开会话时整段消化
// （digestSession）、Memory 板块的开关/增删改查共用同一份 items / paused —— 模块级
// 单例（仿 chat-persist），避免各处各自维护列表后互相覆盖。提取/存取全走后端，这里只接
// 状态。暂停语义：AI 既不自动沉淀、对话也不读/注入记忆与画像（仍是单开关，位置从设置页
// 迁到 Memory 板块顶部）。
// facets（方面软标签）由后端全自动维护（提取/手动增改/补标签都静默完成），前端只读展示
// 与筛选，绝不手改——Memory 板块要自己打标/改标时统一走后端 action，别绕。
import { reactive } from "vue";
import { tryPost } from "./api";

const MEM_PAUSE_KEY = "doc-copilot-memory-off";

// 方面词表的前端只读副本：仅用于渲染/筛选顺序，顺序必须与后端 memory-store.mjs 的
// MEMORY_FACETS 完全一致（Memory 板块的 chips/行内标签都按这个顺序排）。
export const MEM_FACETS = [
  "身份背景",
  "技能工具",
  "工作项目",
  "目标计划",
  "偏好习惯",
  "性格风格",
  "雷区注意",
  "家庭人际",
  "健康时间",
] as const;

export interface MemoryItem {
  id: string;
  text: string;
  ts: number;
  /** 「方面」软标签（1–3 个；词表见上方 MEM_FACETS，真正落盘的由后端白名单归一化。
   *  早期/整理前沉淀的旧记忆可能没有该字段，属正常。 */
  facets?: string[];
}

function loadPaused(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(MEM_PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}

export const memoryState = reactive({
  paused: loadPaused(),
  items: [] as MemoryItem[],
  loading: false, // 拉取中（防连点重复请求）
});

function savePaused() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MEM_PAUSE_KEY, memoryState.paused ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

export function toggleMemoryPause() {
  memoryState.paused = !memoryState.paused;
  savePaused();
}

function applyItems(data: { items?: MemoryItem[] } | null) {
  if (data && Array.isArray(data.items)) memoryState.items = data.items;
}

/** 拉最新记忆清单；本机服务未跑/失败时静默保持原样 */
export async function refreshMemory() {
  if (memoryState.loading) return;
  memoryState.loading = true;
  try {
    const res = await fetch("/api/memory");
    if (res.ok) {
      const data = await res.json().catch(() => null);
      applyItems(data);
    }
  } catch {
    /* 静默 */
  } finally {
    memoryState.loading = false;
  }
}

/** 一轮对话完整结束后调用；暂停中或失败都静默（body 截断与旧版一致） */
export async function rememberTurn(userText: string, replyMd: string) {
  if (memoryState.paused) return;
  const user = String(userText ?? "").slice(0, 4000);
  const reply = String(replyMd ?? "").slice(0, 6000);
  if (!user || !reply) return;
  const r = await tryPost<{ items?: MemoryItem[] }>("/api/remember", { user, reply });
  if (r.ok) applyItems(r.data);
}

/** 会话收尾整段消化：离开一段多轮对话时调用，把该对话（最近若干轮、按时间顺序）送后端做
 *  纵观全段的总结提取，沉淀逐轮提取看不到的跨轮伏笔/进展。暂停中或失败静默并返回 false；
 *  仅在后端确认收到（2xx）时返回 true —— 调用方据此推进「已吸收」记账，失败的留待下次
 *  离开再补。 */
export async function digestSession(
  turns: { role: "user" | "assistant"; content: string }[],
): Promise<boolean> {
  if (memoryState.paused) return false;
  if (!Array.isArray(turns) || !turns.length) return false;
  const r = await tryPost<{ items?: MemoryItem[] }>("/api/memory", {
    action: "digest",
    turns: turns.map((t) => ({
      role: t.role,
      content: String(t.content ?? "").slice(0, 1200),
    })),
  });
  if (!r.ok) return false;
  applyItems(r.data);
  return true;
}

export async function deleteMemory(id: string) {
  const r = await tryPost<{ items?: MemoryItem[] }>("/api/memory", { action: "delete", id });
  if (r.ok) applyItems(r.data);
}

/** 手动修改一条记忆的正文；后端会规范化并把它顶成最新。返回 false 供面板提示失败原因 */
export async function editMemory(id: string, text: string): Promise<boolean> {
  const r = await tryPost<{ items?: MemoryItem[] }>("/api/memory", { action: "edit", id, text });
  if (r.ok) {
    applyItems(r.data);
    return true;
  }
  return false;
}

/** 手动新增一条记忆（Memory 板块直接写一句话）；与已有记忆重复时后端不落盘。
 *  返回 {ok, dup} 供界面提示。 */
export async function addMemory(text: string): Promise<{ ok: boolean; dup: boolean }> {
  const r = await tryPost<{ items?: MemoryItem[]; added?: number }>("/api/memory", {
    action: "add",
    text,
  });
  if (r.ok && r.data) {
    applyItems(r.data);
    return { ok: true, dup: (r.data.added ?? 0) < 1 };
  }
  return { ok: false, dup: false };
}

/** 给还没带方面标签的旧记忆批量补标（后端分批小调模型，全静默）。返回这次补上的条数；
 *  0 表示没有可补/没配 key/模型没打上，前端提示一次即可，不阻塞其它操作。 */
export async function tagMissingMemory(): Promise<number> {
  const r = await tryPost<{ items?: MemoryItem[]; tagged?: number }>("/api/memory", {
    action: "tag-missing",
  });
  if (r.ok && r.data) {
    applyItems(r.data);
    return r.data.tagged ?? 0;
  }
  return 0;
}

export interface CompactSummary {
  ran: boolean;
  busy?: boolean;
  reason?: string;
  before?: number;
  after?: number;
  removedCount?: number;
  mergedGroups?: number;
  mergedItems?: number;
}

/** 压缩整理：整单交后端去重/合并/清过时（成功会先备份原文再落盘）。返回 null 表示服务不可用 */
export async function compactMemory() {
  const r = await tryPost<CompactSummary & { items?: MemoryItem[] }>("/api/memory", {
    action: "compact",
  });
  if (!r.ok || !r.data) return null;
  applyItems(r.data);
  return r.data;
}
