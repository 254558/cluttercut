<script setup lang="ts">
// Memory 记忆板块（Home | Memory | Todo 三模块之一，渲染在 .ds-main 整页）。
// AI 对用户的长期记忆全在这里：自动收集常开（顶栏标题与 Auto-collect 开关已撤掉，暂停的
// 能力仍留在 core/memory-state 供日后恢复；手动增删改查不受影响）；「Profile」画像
// （全部记忆定期合成的性格/身份/偏好快照，可手动重绘，开放区块不套卡）；语义检索
// （带相似度，模型不可用时自动降级文本匹配）+ 手动新增合成一条快速捕获工具行；逐条行内
// 编辑/删除（hover 才现操作钮，行去盒化）；每条可展开「Related」看与它语义最相近的记忆
// 并跳转串联；底部压缩整理。
// 所有读写都走 /api/memory（与聊天自动沉淀同一份数据与去重）。
// 方面软标签（facets）由后端全自动维护（提取/手动增改/补标签，AI 打、用户零负担），
// 本板块只做三件只读的事：行 meta 小标签、按方面筛选的 chips、「给旧记忆补标签」按钮。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { apiRequest, tryPost } from "../core/api";
import { fmtTs, useFlash } from "../core/board";
import {
  addMemory,
  compactMemory,
  deleteMemory,
  editMemory,
  MEM_FACETS,
  memoryState,
  refreshMemory,
  tagMissingMemory,
  type MemoryItem,
} from "../core/memory-state";
import AppIcon from "./AppIcon.vue";

// 板块行 = 共享 MemoryItem + 检索/串联结果才带的语义相似度（列表数据里没有该字段）
type Row = MemoryItem & { s?: number | null };
interface ProfileInfo {
  exists: boolean;
  card: string;
  at: number;
  fromCount: number;
}

/* ---------------- Profile 画像（开放区块） ---------------- */

const profile = ref<ProfileInfo | null>(null);
const profileLoading = ref(false);
const regenerating = ref(false);
const profileMsg = ref("");

async function fetchProfile() {
  profileLoading.value = true;
  try {
    const r = await apiRequest<{ exists?: boolean; card?: string; at?: number; fromCount?: number }>(
      "/api/profile",
    );
    profile.value = {
      exists: !!r?.exists,
      card: String(r?.card ?? "").trim(),
      at: Number(r?.at) || 0,
      fromCount: Number(r?.fromCount) || 0,
    };
  } catch {
    profile.value = null;
  } finally {
    profileLoading.value = false;
  }
}

async function regenProfile() {
  if (regenerating.value) return;
  regenerating.value = true;
  profileMsg.value = "";
  const r = await tryPost<{ ok?: boolean; changed?: boolean; exists?: boolean }>("/api/memory", {
    action: "refresh-profile",
  });
  if (r.ok && r.data?.ok) {
    await fetchProfile();
    profileMsg.value = r.data.changed
      ? "Profile regenerated from the current memories."
      : r.data.exists
        ? "A regeneration is already running — check back shortly."
        : "Nothing to synthesize yet (memories too sparse, or the model was busy).";
  } else {
    profileMsg.value = "Couldn’t reach the local service.";
  }
  regenerating.value = false;
}

const profileMeta = computed(() => {
  if (!profile.value || !profile.value.at) return "";
  const n = profile.value.fromCount;
  return `Synthesized from ${n} ${n === 1 ? "memory" : "memories"} · ${fmtTs(profile.value.at)}`;
});

/* ---------------- 语义检索 ---------------- */

const query = ref("");
const searching = ref(false);
const searchMode = ref(""); // "semantic" | "text" | ""
const results = ref<Row[]>([]);
let searchTimer = 0;

async function runSearch() {
  const q = query.value.trim();
  if (!q) {
    searching.value = false;
    searchMode.value = "";
    results.value = [];
    return;
  }
  searching.value = true;
  const r = await tryPost<{ ok?: boolean; mode?: string; items?: Row[] }>("/api/memory", {
    action: "search",
    q,
  });
  if (r.ok && r.data) {
    results.value = Array.isArray(r.data.items) ? r.data.items : [];
    searchMode.value = r.data.mode === "semantic" ? "semantic" : "text";
  } else {
    results.value = [];
    searchMode.value = "text";
  }
  searching.value = false;
}

function onQueryInput() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 280);
}
function clearQuery() {
  query.value = "";
  runSearch();
}

/* 列表来源：有检索词时显示结果，否则显示全部记忆 */
const pool = computed<Row[]>(() =>
  query.value.trim() ? results.value : (memoryState.items as Row[]),
);

/* ---------------- 方面（facet）筛选 + 旧记忆补标签 ---------------- */
// 纯客户端筛选：chips 计数跟着当前 pool（检索中=结果集，否则=全部记忆）走。
const activeFacet = ref("");
const facetCounts = computed(() => {
  const m = new Map<string, number>();
  for (const it of pool.value) for (const f of it.facets ?? []) m.set(f, (m.get(f) ?? 0) + 1);
  return m;
});
const facetOptions = computed(() =>
  MEM_FACETS.filter((f) => (facetCounts.value.get(f) ?? 0) > 0).map((f) => ({
    f,
    n: facetCounts.value.get(f) ?? 0,
  })),
);
const untaggedCount = computed(
  () => pool.value.filter((it) => !(it.facets ?? []).length).length,
);

function setFacet(f: string) {
  activeFacet.value = activeFacet.value === f ? "" : f; // 再点一次取消筛选
}

const tagging = ref(false);
async function tagOld() {
  if (tagging.value) return;
  tagging.value = true;
  const n = await tagMissingMemory();
  tagging.value = false;
  if (n > 0) {
    flashNote(`Tagged ${n} old ${n === 1 ? "memory" : "memories"} by aspect.`, "ok");
  } else {
    flashNote("Nothing tagged — the model may be busy, no key set, or nothing left to tag.", "warn");
  }
  if (query.value.trim()) runSearch();
}

const visibleItems = computed<Row[]>(() => {
  if (!activeFacet.value) return pool.value;
  return pool.value.filter((it) => (it.facets ?? []).includes(activeFacet.value));
});

/* ---------------- 手动新增 ---------------- */

const addText = ref("");
const adding = ref(false);

async function addOne() {
  const text = addText.value.trim();
  if (!text || adding.value) return;
  adding.value = true;
  const r = await addMemory(text);
  if (!r.ok) {
    flashNote("Couldn’t save — the local service isn’t responding.", "err");
  } else if (r.dup) {
    flashNote("A nearly identical memory already exists — not added.", "warn");
  } else {
    addText.value = "";
    if (query.value.trim()) runSearch();
  }
  adding.value = false;
}

/* ---------------- 逐条行内编辑 / 删除 ---------------- */

const editingId = ref("");
const editText = ref("");
const busyId = ref("");

function startEdit(it: Row) {
  editingId.value = it.id;
  editText.value = it.text;
}
function cancelEdit() {
  editingId.value = "";
  editText.value = "";
}
async function saveEdit() {
  if (!editingId.value) return;
  const ok = await editMemory(editingId.value, editText.value);
  if (!ok) flashNote("That memory may have been merged away — nothing changed.", "err");
  editingId.value = "";
  if (query.value.trim()) runSearch();
}

async function onDelete(it: Row) {
  if (busyId.value) return;
  busyId.value = it.id;
  if (relatedFor.value === it.id) closeRelated();
  await deleteMemory(it.id);
  busyId.value = "";
  if (query.value.trim()) runSearch();
}

/* ---------------- 串联（Related）：看一条与它语义相近的记忆 ---------------- */

const relatedFor = ref("");
const relatedItems = ref<Row[]>([]);
const relatedLoading = ref(false);

async function openRelated(it: Row) {
  if (relatedFor.value === it.id) {
    closeRelated();
    return;
  }
  relatedFor.value = it.id;
  relatedItems.value = [];
  relatedLoading.value = true;
  const r = await tryPost<{ ok?: boolean; items?: Row[] }>("/api/memory", {
    action: "related",
    id: it.id,
  });
  relatedItems.value = r.ok && r.data && Array.isArray(r.data.items) ? r.data.items : [];
  relatedLoading.value = false;
}
function closeRelated() {
  relatedFor.value = "";
  relatedItems.value = [];
  relatedLoading.value = false;
}

/* ---------------- 底部压缩整理 ---------------- */

const compacting = ref(false);

async function tidyNow() {
  if (compacting.value) return;
  compacting.value = true;
  const s = await compactMemory();
  compacting.value = false;
  if (!s) {
    flashNote("Couldn’t reach the local service.", "err");
  } else if (s.ran) {
    flashNote(
      `Tidied ${s.before ?? "?"} → ${s.after ?? "?"} items (merged ${s.mergedGroups ?? 0} groups, removed ${s.removedCount ?? 0}).`,
      "ok",
    );
  } else if (s.busy) {
    flashNote("A tidy is already running — check back shortly.", "warn");
  } else if (s.reason) {
    flashNote(s.reason, "warn");
  }
  if (query.value.trim()) runSearch();
}

/* ---------------- 底部提示条（共用 useFlash，见 core/board.ts） ---------------- */

const { note, flash: flashNote } = useFlash();

onMounted(async () => {
  await Promise.all([refreshMemory(), fetchProfile()]);
});
onBeforeUnmount(() => {
  window.clearTimeout(searchTimer);
});
</script>

<template>
  <div class="mb-root">
    <!-- Profile 画像：开放区块（无卡盒），标签行 + 正文靠字阶/留白分层（顶栏标题与
         Auto-collect 开关已撤，板面直接以画像/检索开场） -->
    <section class="mb-profile">
      <div class="mb-profile__head">
        <span class="mb-profile__label">Profile</span>
        <span class="mb-profile__spacer"></span>
        <button
          class="mb-btn mb-btn--ghost mb-btn--xs"
          type="button"
          :disabled="regenerating"
          @click="regenProfile"
        >
          {{ regenerating ? "Synthesizing…" : profile?.exists ? "Regenerate" : "Generate" }}
        </button>
      </div>

      <div v-if="profileLoading" class="mb-profile__body is-muted">Loading…</div>
      <template v-else-if="profile?.exists && profile.card">
        <p class="mb-profile__card">{{ profile.card }}</p>
        <p class="mb-profile__meta">{{ profileMeta }}</p>
      </template>
      <div v-else class="mb-profile__body">
        <p class="mb-profile__hint">No profile yet — it forms from your memories as you chat.</p>
      </div>
    </section>
    <p v-if="profileMsg" class="mb-flash is-ok">{{ profileMsg }}</p>

    <!-- 快速捕获工具行：左侧语义检索 + 右侧手动新增（同一行，窄窗自动换行） -->
    <div class="mb-tools">
      <div class="mb-search">
        <AppIcon name="search" class="mb-search__icon" :size="14" />
        <input
          v-model="query"
          class="mb-input mb-search__field"
          type="text"
          placeholder="Search memories by meaning…"
          aria-label="检索记忆"
          @input="onQueryInput"
        />
        <button
          v-if="query"
          class="mb-iconbtn mb-search__clear"
          type="button"
          title="清除检索"
          aria-label="清除检索"
          @click="clearQuery"
        ><AppIcon name="close" :size="13" /></button>
      </div>

      <div class="mb-add">
        <input
          v-model="addText"
          class="mb-input"
          type="text"
          placeholder="Tell the AI one thing about you — e.g. I do my best deep work in the morning…"
          aria-label="手动新增一条记忆"
          :disabled="adding"
          @keydown.enter="addOne"
        />
        <button
          class="mb-addbtn"
          type="button"
          :disabled="adding || !addText.trim()"
          aria-label="新增一条记忆"
          title="保存这条记忆"
          @click="addOne"
        ><AppIcon name="plus" :size="14" :sw="2.6" /></button>
      </div>
    </div>

    <!-- 方面筛选：安静 chips 行，右侧留 ghost 的「给旧记忆补标签」 -->
    <div v-if="memoryState.items.length" class="mb-facets">
      <button
        class="mb-chip"
        type="button"
        :class="{ 'is-active': !activeFacet }"
        title="显示全部"
        @click="setFacet('')"
      >All<span class="mb-chip__n">{{ pool.length }}</span></button>
      <button
        v-for="o in facetOptions"
        :key="o.f"
        class="mb-chip"
        type="button"
        :class="{ 'is-active': activeFacet === o.f }"
        :title="`只看「${o.f}」方面的记忆`"
        @click="setFacet(o.f)"
      >{{ o.f }}<span class="mb-chip__n">{{ o.n }}</span></button>
      <button
        v-if="untaggedCount > 0"
        class="mb-btn mb-btn--ghost mb-btn--xs mb-facets__tagbtn"
        type="button"
        :disabled="tagging"
        :title="untaggedCount > 0 ? `给还没有方面标签的 ${untaggedCount} 条旧记忆补标签（AI 自动打）` : ''"
        @click="tagOld"
      >{{ tagging ? "Tagging…" : `Tag old ones (${untaggedCount})` }}</button>
    </div>

    <!-- 列表分组标题（仅检索/筛方面时出现；默认全量列表无须再说明） -->
    <div v-if="query.trim() || activeFacet" class="mb-listhead">
      <span class="mb-listhead__label">
        {{
          query.trim()
            ? "Search results"
            : `Tagged “${activeFacet}”`
        }}
        <span v-if="query.trim() && !searching" class="mb-listhead__mode">
          · {{ searchMode === "semantic" ? "semantic match" : "keyword match" }}
        </span>
      </span>
    </div>

    <div v-if="searching" class="mb-empty">Searching…</div>
    <div v-else-if="!visibleItems.length" class="mb-empty">
      <p v-if="query.trim()">Nothing matched “{{ query.trim() }}”.</p>
      <p v-else-if="activeFacet">No memories tagged “{{ activeFacet }}” right now.</p>
      <template v-else>
        <p class="mb-empty__main">No memories yet.</p>
      </template>
    </div>

    <ul v-else class="mb-list">
      <li
        v-for="it in visibleItems"
        :key="it.id"
        class="mb-it"
        :class="{ 'is-rel-open': relatedFor === it.id }"
      >
        <!-- 正文（编辑态换行内输入框） -->
        <div v-if="editingId === it.id" class="mb-it__edit">
          <input
            v-model="editText"
            class="mb-input"
            type="text"
            aria-label="编辑记忆内容"
            @keydown.enter="saveEdit"
            @keydown.esc="cancelEdit"
          />
          <button class="mb-btn mb-btn--ghost mb-btn--xs mb-btn--strong" type="button" @click="saveEdit">Save</button>
          <button class="mb-btn mb-btn--ghost mb-btn--xs" type="button" @click="cancelEdit">Cancel</button>
        </div>
        <template v-else>
          <div class="mb-it__main">
            <p class="mb-it__text">{{ it.text }}</p>
            <span class="mb-it__acts">
              <button
                class="mb-iconbtn"
                type="button"
                title="串联：看语义相近的记忆"
                aria-label="串联相关记忆"
                :class="{ 'is-on': relatedFor === it.id }"
                @click="openRelated(it)"
              ><AppIcon name="link" :size="14" /></button>
              <button
                class="mb-iconbtn"
                type="button"
                title="编辑这条记忆"
                aria-label="编辑记忆"
                @click="startEdit(it)"
              ><AppIcon name="edit" :size="14" /></button>
              <button
                class="mb-iconbtn is-danger"
                type="button"
                title="删除这条记忆"
                aria-label="删除记忆"
                :disabled="busyId === it.id"
                @click="onDelete(it)"
              ><AppIcon name="trash" :size="14" /></button>
            </span>
          </div>
        </template>

        <!-- 元信息：时间 / 相似度 / 方面小标签（编辑态也保留） -->
        <div class="mb-it__meta">
          <span class="mb-it__time">{{ fmtTs(it.ts) }}</span>
          <span v-if="typeof it.s === 'number'" class="mb-it__score" :title="it.s.toFixed(3)">
            {{ Math.round(it.s * 100) }}%
          </span>
          <button
            v-for="f in it.facets"
            :key="f"
            class="mb-tag"
            type="button"
            :class="{ 'is-on': activeFacet === f }"
            :title="`方面：${f} — 点击只看这个方面`"
            @click="setFacet(f)"
          >{{ f }}</button>
        </div>

        <!-- 串联面板 -->
        <div v-if="relatedFor === it.id" class="mb-rel">
          <div class="mb-rel__head">
            <span class="mb-rel__title">Related memories</span>
            <button
              class="mb-iconbtn"
              type="button"
              title="收起"
              aria-label="收起串联"
              @click="closeRelated"
            ><AppIcon name="close" :size="13" /></button>
          </div>
          <p v-if="relatedLoading" class="mb-rel__empty">Searching…</p>
          <p v-else-if="!relatedItems.length" class="mb-rel__empty">No close matches found.</p>
          <div v-else class="mb-rel__list">
            <button
              v-for="rel in relatedItems"
              :key="rel.id"
              class="mb-rel__item"
              type="button"
              :title="`跳到这条记忆（相似度 ${Math.round((rel.s ?? 0) * 100)}%）`"
              @click="openRelated(rel)"
            >
              <span class="mb-rel__text">{{ rel.text }}</span>
              <span v-if="typeof rel.s === 'number'" class="mb-it__score">{{ Math.round(rel.s * 100) }}%</span>
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- 底部：压缩整理（hairline 行）+ 数据源 mono 明细 -->
    <footer class="mb-foot">
      <button
        class="mb-btn mb-btn--ghost mb-btn--strong"
        type="button"
        :disabled="compacting"
        title="合并近似重复、淘汰过期记忆（旧档留底）；记忆攒到较多（≥500 条）时 AI 也会自动跑"
        @click="tidyNow"
      >
        {{ compacting ? "Tidying…" : "Compact & tidy" }}
      </button>
    </footer>

    <p v-if="note" class="mb-flash" :class="'is-' + note.kind">{{ note.text }}</p>
  </div>
</template>

<style scoped>
/* Memory 板块布局差异（root/input/btn/row/listhead/empty/flash 等共享件见
   styles/boards.css；唯一蓝仍是 --do-accent，只给筛选选中态与相似度读数） */

/* ---------- Profile 开放区块（顶栏已撤，它是板面第一段：仅 4px 落位，靠根部 22px 上边距呼吸） ---------- */
.mb-profile {
  margin-top: 4px;
}
.mb-profile__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mb-profile__label {
  font-size: 10px; /* Hermes 小节大写标 10px */
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--do-text-3);
}
.mb-profile__spacer {
  flex: 1;
}
.mb-profile__card {
  margin: 6px 0 0;
  font-size: 13px; /* 正文 13px，行高收紧到 1.6 */
  line-height: 1.6;
  color: var(--do-text-1);
  white-space: pre-line;
}
.mb-profile__meta {
  margin: 8px 0 0;
  font-size: 11px; /* 元信息 small */
  color: var(--do-text-3);
}
.mb-profile__body.is-muted {
  margin-top: 6px;
  color: var(--do-text-3);
  font-size: 13px;
}
.mb-profile__hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--do-text-3);
}

/* ---------- 快速捕获工具行（search + add 同一行） ---------- */
.mb-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}
.mb-search {
  position: relative;
  flex: 0 1 380px;
  min-width: 230px;
  display: flex;
  align-items: center;
}
.mb-search__field {
  padding-left: 32px;
  padding-right: 34px;
}
.mb-search__icon {
  position: absolute;
  left: 11px;
  color: var(--do-text-3);
  pointer-events: none;
}
.mb-search__clear {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
}
.mb-add {
  flex: 1 1 320px;
  min-width: 260px;
}

/* ---------- 方面筛选 chips（quiet：无描边，选中态才用 accent-soft；2px 与行/框同尺，非胶囊） ---------- */
.mb-facets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin-top: 18px;
}
.mb-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: none;
  border-radius: 2px; /* Hermes 近直角：chip 与行/框同尺 */
  background: transparent;
  color: var(--do-text-3);
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  transition: color var(--do-dur-fast), background var(--do-dur-fast);
}
.mb-chip:hover {
  color: var(--do-text-1);
  background: var(--do-bg-hover);
}
.mb-chip.is-active {
  color: var(--do-accent-strong);
  background: var(--do-accent-soft);
}
.mb-chip__n {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}
.mb-chip.is-active .mb-chip__n {
  opacity: 0.85;
}
.mb-facets__tagbtn {
  margin-left: 8px;
}

/* ---------- 列表分组标题 ---------- */
.mb-listhead {
  margin-top: 24px;
}
.mb-listhead__mode {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--do-text-3);
}

/* ---------- 行：正文 + hover 才现的操作组 ---------- */
.mb-list {
  margin-top: 4px;
}
.mb-it__main {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.mb-it__text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
}
.mb-it__acts {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-top: -3px;
  opacity: 0;
  visibility: hidden;
  transition: opacity var(--do-dur-fast) var(--do-dur-fast),
    visibility 0s linear var(--do-dur-fast);
}
.mb-it:hover .mb-it__acts,
.mb-it:focus-within .mb-it__acts,
.mb-it.is-rel-open .mb-it__acts {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
@media (hover: none) {
  .mb-it__acts {
    opacity: 1;
    visibility: visible;
  }
}

/* 行内编辑 */
.mb-it__edit {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mb-it__edit .mb-input {
  flex: 1;
  min-width: 0;
}

/* 元信息：时间 / 相似度 / 方面小标签 */
.mb-it__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin-top: 5px;
}
.mb-it__time {
  font-size: 10px;
  color: var(--do-text-3);
  font-variant-numeric: tabular-nums;
}
.mb-it__score {
  flex: none;
  font-size: 10px;
  line-height: 1;
  font-weight: 600;
  color: var(--do-accent-strong);
  border: 1px solid rgba(91, 155, 255, 0.4);
  border-radius: 2px; /* 小徽标同收近直角，与行/框同尺 */
  padding: 2px 7px;
}
.mb-tag {
  flex: none;
  padding: 1.5px 8px;
  border: none;
  border-radius: 2px; /* 小标签同收近直角，与行/框同尺 */
  background: transparent;
  color: var(--do-text-3);
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  transition: color var(--do-dur-fast), background var(--do-dur-fast);
}
.mb-tag:hover {
  color: var(--do-text-1);
  background: var(--do-bg-hover);
}
.mb-tag.is-on {
  color: var(--do-accent-strong);
  background: var(--do-accent-soft);
}

/* 串联面板：hairline 分隔 + 内联小行（不再套卡） */
.mb-rel {
  margin-top: 9px;
  padding: 9px 2px 2px;
  border-top: 1px solid var(--do-divider);
}
.mb-rel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}
.mb-rel__title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--do-text-3);
}
.mb-rel__empty {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--do-text-3);
}
.mb-rel__list {
  margin-top: 2px;
}
.mb-rel__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 6px 8px;
  border: none;
  border-radius: 2px; /* Hermes 列表行尺：与 .mb-it 同级小圆角，非胶囊 */
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition: background var(--do-dur-fast);
}
.mb-rel__item:hover {
  background: var(--do-bg-active);
}
.mb-rel__text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--do-text-2);
}

/* ---------- 底部：压缩整理（hairline 行，单钮） ---------- */
.mb-foot {
  display: flex;
  align-items: center;
  margin-top: 26px;
  padding-top: 16px;
  border-top: 1px solid var(--do-divider);
}
</style>
