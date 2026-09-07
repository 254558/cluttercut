<script setup lang="ts">
// Todo 待办板块（Home | Memory | Todo 三模块之一，渲染在 .ds-main 整页）。
// 手动维护的基本待办清单：新增/勾选/行内改文/删除/清空已完成，存 ai-todo.json（/api/todo）。
// AI 每轮对话都会只读注入未完成项（见 server chat.mjs）来对齐「你接下来要做什么」、
// 给出更贴合的建议 —— 但 AI 从不写这里，本板块没有任何 AI 写入入口。
// 布局：新增行（输入框 + 沉在框内右端的圆形加号）；去盒化行（hover 才现编辑/删除）；
// 复选框 16px 方角小号；Done 区默认收起（表头可展开），右侧 Clear completed ghost。
import { computed, onMounted, ref } from "vue";
import { apiRequest, tryPost } from "../core/api";
import { fmtTs, useFlash } from "../core/board";
import AppIcon from "./AppIcon.vue";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  ts: number;
  doneAt?: number;
}

const items = ref<TodoItem[]>([]);
const loading = ref(true);
const adding = ref(false);
const newText = ref("");
const editingId = ref("");
const editText = ref("");
const doneOpen = ref(false); // 已完成区默认收起

function applyItems(data: { items?: TodoItem[] } | null) {
  if (data && Array.isArray(data.items)) items.value = data.items;
}

async function load() {
  try {
    const r = await apiRequest<{ items?: TodoItem[] }>("/api/todo");
    applyItems(r);
  } catch {
    /* 本机服务未跑时静默，保留原样 */
  } finally {
    loading.value = false;
  }
}

const openItems = computed(() => items.value.filter((t) => !t.done));
const doneItems = computed(() => items.value.filter((t) => t.done));

// 底部提示条（共用 useFlash，见 core/board.ts）
const { note, flash: flashNote } = useFlash();

/* ---- 新增 ---- */

async function addOne() {
  const text = newText.value.trim();
  if (!text || adding.value) return;
  adding.value = true;
  const r = await tryPost<{ items?: TodoItem[] }>("/api/todo", { action: "add", text });
  if (r.ok && r.data) {
    applyItems(r.data);
    newText.value = "";
  } else {
    flashNote("Couldn’t add — the local service isn’t responding.", "err");
  }
  adding.value = false;
}

/* ---- 勾选 / 删除 ---- */

const busyId = ref("");
async function toggle(it: TodoItem) {
  if (busyId.value) return;
  busyId.value = it.id;
  const r = await tryPost<{ items?: TodoItem[] }>("/api/todo", { action: "toggle", id: it.id });
  if (r.ok && r.data) applyItems(r.data);
  busyId.value = "";
}

async function onDelete(it: TodoItem) {
  if (busyId.value) return;
  busyId.value = it.id;
  if (editingId.value === it.id) editingId.value = "";
  const r = await tryPost<{ items?: TodoItem[] }>("/api/todo", { action: "delete", id: it.id });
  if (r.ok && r.data) applyItems(r.data);
  busyId.value = "";
}

/* ---- 行内编辑 ---- */

function startEdit(it: TodoItem) {
  editingId.value = it.id;
  editText.value = it.text;
}
function cancelEdit() {
  editingId.value = "";
  editText.value = "";
}
async function saveEdit() {
  if (!editingId.value) return;
  const r = await tryPost<{ items?: TodoItem[] }>("/api/todo", {
    action: "edit",
    id: editingId.value,
    text: editText.value,
  });
  if (r.ok && r.data) {
    applyItems(r.data);
    editingId.value = "";
  } else {
    flashNote("Couldn’t save that change.", "err");
  }
}

/* ---- 清空已完成 ---- */

async function clearDone() {
  const r = await tryPost<{ items?: TodoItem[] }>("/api/todo", { action: "clear-done" });
  if (r.ok && r.data) applyItems(r.data);
}

onMounted(load);
</script>

<template>
  <div class="tb-root">
    <!-- 新增一行：输入框，圆形加号沉在框内最右端（顶栏标题已随 Hermes 去字化，不再重复页名） -->
    <div class="tb-add">
      <input
        v-model="newText"
        class="tb-input"
        type="text"
        placeholder="What do you need to do?"
        aria-label="新增待办"
        :disabled="adding"
        @keydown.enter="addOne"
      />
      <button
        class="tb-addbtn"
        type="button"
        aria-label="新增待办"
        :disabled="adding || !newText.trim()"
        @click="addOne"
      ><AppIcon name="plus" :size="14" :sw="2.6" /></button>
    </div>

    <div v-if="loading" class="tb-empty">Loading…</div>

    <div v-else-if="!items.length" class="tb-empty">
      <span class="tb-empty__mark" aria-hidden="true"><AppIcon name="plus" :size="15" :sw="2.4" /></span>
      <p class="tb-empty__main">Nothing on the list yet.</p>
    </div>

    <template v-else>
      <!-- 未完成区 -->
      <div v-if="openItems.length" class="tb-section">
        <div class="tb-listhead">
          <span class="tb-listhead__label">
            To do <span class="tb-listhead__n">{{ openItems.length }}</span>
          </span>
        </div>
        <ul class="tb-list">
          <li v-for="it in openItems" :key="it.id" class="tb-it">
            <button
              class="tb-check"
              type="button"
              role="checkbox"
              :aria-checked="false"
              aria-label="标记为已完成"
              title="标记为已完成"
              :disabled="busyId === it.id"
              @click="toggle(it)"
            ></button>

            <template v-if="editingId === it.id">
              <input
                v-model="editText"
                class="tb-input tb-it__editfield"
                type="text"
                aria-label="编辑待办内容"
                @keydown.enter="saveEdit"
                @keydown.esc="cancelEdit"
              />
              <button class="tb-textbtn tb-textbtn--strong" type="button" @click="saveEdit">
                Save
              </button>
              <button class="tb-textbtn" type="button" @click="cancelEdit">
                Cancel
              </button>
            </template>
            <template v-else>
              <p class="tb-it__text" @dblclick="startEdit(it)">{{ it.text }}</p>
              <span class="tb-it__meta">{{ fmtTs(it.ts) }}</span>
              <span class="tb-it__acts">
                <button
                  class="tb-iconbtn"
                  type="button"
                  title="编辑内容"
                  aria-label="编辑待办"
                  @click="startEdit(it)"
                ><AppIcon name="edit" :size="13" /></button>
                <button
                  class="tb-iconbtn is-danger"
                  type="button"
                  title="删除这项"
                  aria-label="删除待办"
                  @click="onDelete(it)"
                ><AppIcon name="trash" :size="13" /></button>
              </span>
            </template>
          </li>
        </ul>
      </div>

      <!-- 已完成区（默认收起：点表头展开/收起） -->
      <div v-if="doneItems.length" class="tb-section tb-section--done">
        <div class="tb-listhead">
          <button
            class="tb-disclose"
            type="button"
            :aria-expanded="doneOpen"
            :aria-label="doneOpen ? '收起已完成' : '展开已完成'"
            @click="doneOpen = !doneOpen"
          >
            <AppIcon
              name="chevronDown"
              :size="12"
              :sw="2.2"
              class="tb-disclose__chev"
              :class="{ 'is-open': doneOpen }"
            />
            <span class="tb-listhead__label">
              Done <span class="tb-listhead__n">{{ doneItems.length }}</span>
            </span>
          </button>
          <button class="tb-textbtn tb-clear" type="button" @click="clearDone">
            Clear completed
          </button>
        </div>
        <ul v-show="doneOpen" class="tb-list">
          <li v-for="it in doneItems" :key="it.id" class="tb-it is-done">
            <button
              class="tb-check is-checked"
              type="button"
              role="checkbox"
              :aria-checked="true"
              aria-label="移回未完成"
              title="移回未完成"
              :disabled="busyId === it.id"
              @click="toggle(it)"
            >
              <AppIcon name="check" :size="10" :sw="3.2" />
            </button>
            <p class="tb-it__text">{{ it.text }}</p>
            <span class="tb-it__meta">{{ fmtTs(it.doneAt || it.ts) }}</span>
            <span class="tb-it__acts">
              <button
                class="tb-iconbtn"
                type="button"
                title="恢复为未完成"
                aria-label="恢复待办"
                @click="toggle(it)"
              ><AppIcon name="restore" :size="13" /></button>
              <button
                class="tb-iconbtn is-danger"
                type="button"
                title="删除这项"
                aria-label="删除待办"
                @click="onDelete(it)"
              ><AppIcon name="trash" :size="13" /></button>
            </span>
          </li>
        </ul>
      </div>
    </template>

    <p v-if="note" class="tb-flash" :class="'is-' + note.kind">{{ note.text }}</p>
  </div>
</template>

<style scoped>
/* Todo 板块布局差异（input/btn/row/listhead 等共享件见 styles/boards.css） */

/* 新增行 = 带框输入单元：沉框圆形加号与结构已在 boards.css「带框新增单元」单一来源，
   这里只留它在板内的落位；独立的大矩形「Add」钮已随 Hermes 撤除 */
.tb-add {
  margin-top: 16px;
}

/* 无盒文字钮（Hermes text / textStrong）：编辑态 Save/Cancel、Done 区 Clear */
.tb-textbtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 8px;
  border: none;
  border-radius: 2px; /* 近直角：无盒钮与行同尺，hover 才现底色 */
  background: transparent;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--do-text-3);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--do-dur-fast), background var(--do-dur-fast);
}
.tb-textbtn:hover {
  color: var(--do-text-1);
  background: var(--do-bg-hover);
}
.tb-textbtn--strong {
  color: var(--do-text-2);
  font-weight: 600;
}
.tb-textbtn--strong:hover {
  color: var(--do-text-1);
}
.tb-clear {
  font-size: 11px;
}

.tb-section {
  margin-top: 24px;
}
.tb-section--done {
  margin-top: 18px;
}

/* Done 区表头 = 可点开的 disclosure：chevron + 大写标签，hover 提字色 */
.tb-disclose {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 0;
  border: none;
  background: transparent;
  font: inherit;
  color: var(--do-text-3);
  cursor: pointer;
  border-radius: 2px; /* 近直角：disclosure 与行同尺 */
  transition: color var(--do-dur-fast);
}
.tb-disclose:hover {
  color: var(--do-text-1);
}
.tb-disclose .tb-disclose__chev {
  color: var(--do-text-3);
  transition: transform var(--do-dur-base);
}
.tb-disclose:hover .tb-disclose__chev {
  color: var(--do-text-2);
}
.tb-disclose__chev.is-open {
  transform: rotate(180deg);
}

/* 行内布局：方形复选框 + 正文（flex 拉伸）+ 时间 + hover 操作 */
.tb-it {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tb-it__text {
  flex: 1;
  min-width: 0;
  cursor: default;
}
.tb-it__meta {
  flex: none;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--do-text-3);
  white-space: nowrap;
}
.tb-it__acts {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  visibility: hidden;
  transition: opacity var(--do-dur-fast) var(--do-dur-fast),
    visibility 0s linear var(--do-dur-fast);
}
.tb-it:hover .tb-it__acts,
.tb-it:focus-within .tb-it__acts {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
@media (hover: none) {
  .tb-it__acts {
    opacity: 1;
    visibility: visible;
  }
}

/* 计数小徽标：2px 与行/框同尺（Hermes 近直角），不再是一颗胶囊 */
.tb-listhead__n {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 2px;
  background: var(--do-bg-hover);
  color: var(--do-text-3);
  font-size: 10px;
  line-height: 1.6;
}

/* 16px 小号方形复选框：hairline 描边，勾选 = 墨底 + 纸色对勾（不再大圆环） */
.tb-check {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1.5px solid var(--do-text-3);
  border-radius: 2px; /* 16px 小方块近直角，收法与列表行同尺 */
  background: transparent;
  color: var(--do-bg);
  cursor: pointer;
  transition: border-color var(--do-dur-fast), background var(--do-dur-fast);
}
.tb-check:hover:not(:disabled) {
  border-color: var(--do-text-1);
}
.tb-check:disabled {
  opacity: 0.4;
  cursor: default;
}
.tb-check.is-checked {
  background: var(--do-text-0); /* 勾选纸底纯白 */
  border-color: var(--do-text-0);
}
.tb-check.is-checked:hover:not(:disabled) {
  background: var(--do-brand-3);
  border-color: var(--do-brand-3);
}

/* 已完成行：整行文字退到灰阶，删除线用 hairline */
.tb-it.is-done .tb-it__text {
  color: var(--do-text-3);
  text-decoration: line-through;
  text-decoration-color: var(--do-border-strong);
}
.tb-it.is-done .tb-it__meta {
  color: var(--do-text-placeholder);
}

.tb-it__editfield {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
}

/* 空态图形：一圈 faint 圆环里的加号（提示下一步可做之事，不加框不上色） */
.tb-empty__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin-bottom: 10px;
  border-radius: 50%;
  border: 1px solid var(--do-border);
  color: var(--do-text-3);
}
</style>
