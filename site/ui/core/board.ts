// 整页板块（Memory / Todo）共享的零依赖小工具。
// fmtTs 与底部提示条在几块板里各写过一份且行为一致，收拢到这里避免再次漂移；
// 新增板块需要同类展示/提示时直接复用，别在组件里另写。
import { onScopeDispose, ref } from "vue";

/** 毫秒时间戳 → "MM-DD HH:mm"；跨年时补 "YYYY-" 前缀（同一年内不显示年） */
export function fmtTs(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}-`;
  return `${y}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type NoteKind = "ok" | "warn" | "err";

/** 底部提示条：一次 flash 替换上一条，timeoutMs 后自动消失；组件卸载时清定时器 */
export function useFlash(timeoutMs = 6000) {
  const note = ref<{ kind: NoteKind; text: string } | null>(null);
  let timer = 0;
  function flash(text: string, kind: NoteKind) {
    window.clearTimeout(timer);
    note.value = { kind, text };
    timer = window.setTimeout(() => (note.value = null), timeoutMs);
  }
  onScopeDispose(() => window.clearTimeout(timer));
  return { note, flash };
}
