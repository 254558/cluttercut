<script setup>
// 单窗口应用外壳：左侧会话列表 + 右侧主区。主区按板块渲染：
//   Home（聊天：发送/SSE 流式渲染、会话存储绑定）· Memory（记忆板块：长期记忆的
//   增删改查/画像/检索/压缩，自动沉淀与开关在 memory-state 共享）· Todo（待办清单：
//   手动维护、AI 每轮只读注入）。板块由栏头 ModuleRailTabs 切换（appChrome.view）；
//   设置页（拆出的 SessionSettings，只剩 Key/备份）由顶条齿轮打开。
//   记忆管理弹层已并入 Memory 板块（MemoryPanel 删除）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { renderMarkdown, unwrapMarkdown } from "../core/md-render.mjs";
import AppIcon from "./AppIcon.vue";
import WelcomeLogo from "./WelcomeLogo.vue";
import ModuleRailTabs from "./ModuleRailTabs.vue";
import SessionSettings from "./SessionSettings.vue";
import MemoryBoard from "./MemoryBoard.vue";
import TodoBoard from "./TodoBoard.vue";
import { DMX_HELIX, ensureDmxHelixCss } from "../effects/dmx-dots.js";
// 双股螺旋需要 25 段点阵 @keyframes，模块注入一次（幂等）
ensureDmxHelixCss();
import { bindChatPersistence, makeConvo, nowTs } from "../core/chat-persist";
import { appChrome, closeSettings, goView } from "../core/app-chrome";
import { memoryState, rememberTurn, digestSession } from "../core/memory-state";

// msg: { role:'user', text? } | { role:'assistant', text?, html?, markdown?, streaming?, pending? }
const convos = ref([]); // [{ id, title, createdAt, updatedAt, messages:[msg] }]，新对话在前
const activeId = ref("");
const messages = ref([]); // 当前会话的消息数组（与 convos 中对应对象是同一个引用）
const input = ref("");
const sending = ref(false);
const error = ref("");
const ready = ref(false); // 会话从本机存储载入完成后才可交互
const thread = ref(null);
const field = ref(null);

/* ---------- 会话存储（读写/迁移/删除墓碑逻辑集中在 ../chat-persist.ts，这里只接状态） ---------- */
// activate 声明在下方「会话切换」区——函数声明会提升，这里可直接引用；
// 它只会在 initStore 异步载入完成后被调用，届时 setup 已执行完毕。
const chatPersist = bindChatPersistence({ convos, activeId, ready, activate });

// SPA 切页卸载前把最后一笔改动立刻提交并摘除 pagehide 监听，
// 避免重挂载读到旧快照、或旧实例过后用过期整档覆盖新数据
onBeforeUnmount(() => {
  chatPersist.dispose();
  closeSettings(); // 设置面板状态是应用级共享：离开时收掉，回来不残留
});

if (typeof window !== "undefined") {
  void chatPersist.initStore();
}

/* ---------- 会话切换 ---------- */

function activate(id) {
  const c = convos.value.find((x) => x.id === id);
  if (!c) return;
  activeId.value = id;
  messages.value = c.messages;
  scrollBottom();
}

function newChat() {
  if (!ready.value || sending.value) return; // 生成中不打断当前会话
  if (appChrome.view !== "chat") goView("chat"); // 在 Memory/Todo 板块点「+」= 回聊天开新会话
  absorbConvo(currentConvo()); // 离开当前对话的边界：先整段消化再开新的
  const c = makeConvo();
  convos.value.unshift(c);
  activate(c.id);
  focusField();
}

function selectChat(id) {
  if (!ready.value || sending.value) return;
  if (appChrome.view !== "chat") goView("chat"); // 会话属于 Home：点了就切回聊天再打开
  if (id === activeId.value) {
    focusField();
    return;
  }
  absorbConvo(currentConvo()); // 切走当前对话：离开边界，整段消化
  activate(id);
  focusField();
}

/* ---------- 删除会话（直接删除，不确认） ---------- */

function delConvo(c) {
  if (sending.value || !c) return;
  forgetPin(c.id); // 置顶记录跟着会话一起清掉，不留孤儿 id
  const idx = convos.value.findIndex((x) => x.id === c.id);
  if (idx < 0) return;
  convos.value.splice(idx, 1);
  // 删除要真落服务端（记墓碑，其他窗口/标签页用旧整份文档就写不回来）；本地照常更新
  chatPersist.queueDelete(c.id);
  if (!convos.value.length) convos.value.push(makeConvo());
  if (activeId.value === c.id) activate(convos.value[0].id);
  void chatPersist.persist();
}

/* ---------- 置顶（Hermes 同款：独立 localStorage 顺序表，不动会话本体/服务端契约） ----------
 * 只记「已置顶会话 id 的手排顺序」。会话数据仍走 doc-copilot-convos-v2 / /api/store 整档，
 * 结构与字段一律不动（置顶塞进会话对象会被 sanitize 丢弃，且改 /api 契约违反仓库铁律）。 */
const PIN_KEY = "dooit-pinned-chats-v1";

function loadPinnedIds() {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string");
  } catch {
    /* 损坏的缓存当没有 */
  }
  return [];
}

const pinnedIds = ref(loadPinnedIds());

function savePinnedIds() {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pinnedIds.value));
  } catch {
    /* 忽略 */
  }
}

function isPinned(c) {
  return pinnedIds.value.includes(c.id);
}

function togglePin(c) {
  const i = pinnedIds.value.indexOf(c.id);
  if (i >= 0) pinnedIds.value.splice(i, 1);
  else pinnedIds.value.push(c.id); // 新置顶进 Pinned 区末尾（Hermes：append）
  savePinnedIds();
}

function forgetPin(id) {
  const i = pinnedIds.value.indexOf(id);
  if (i >= 0) {
    pinnedIds.value.splice(i, 1);
    savePinnedIds();
  }
}

// Pinned 分组置顶、Sessions（head=""）紧随其后：两组成员互斥——被钉会话只在 Pinned 组、
// Sessions 组只含未钉会话；Pinned 无内容时整组不出现。置顶组按 pinnedIds 手排顺序显示
// （新钉 append 到组末尾，不受会话新旧排序影响）
const convoGroups = computed(() => {
  const pin = [];
  const rest = [];
  for (const c of convos.value) (isPinned(c) ? pin : rest).push(c);
  const pinOrder = new Map(pinnedIds.value.map((id, i) => [id, i]));
  pin.sort((a, b) => (pinOrder.get(a.id) ?? 0) - (pinOrder.get(b.id) ?? 0));
  const groups = [];
  if (pin.length) groups.push({ head: "Pinned", items: pin });
  if (rest.length) groups.push({ head: "", items: rest });
  return groups;
});

/* ---------- 会话溢出菜单（行尾 ⋮ → Pin/Unpin · Delete，Hermes 同款） ----------
 * ⋮ 平时透明、行 hover/选中时显现；点击在按钮下/上方 Teleport 到 body 弹小菜单，
 * 列表是滚动容器，菜单若挂在行内会被裁掉，故用 fixed 定位。点菜单外 / Esc 关闭。 */
const menuFor = ref(""); // 菜单归属会话 id；"" = 关闭
const menuPos = ref({ x: 0, y: 0, up: false });
const menuBox = ref(null);
const convosNav = ref(null);

const menuConvo = computed(() => convos.value.find((c) => c.id === menuFor.value) || null);

function openMenu(c, ev) {
  if (!c || sending.value) return;
  const r = ev.currentTarget.getBoundingClientRect();
  const W = 160; // 面板估算宽
  const H = 92; // 两项 + 分隔条 ≈ 高
  const below = window.innerHeight - r.bottom;
  const up = below < H + 8 && r.top > H + 8;
  menuPos.value = {
    x: Math.min(Math.max(r.left, 8), window.innerWidth - W - 8),
    y: up ? r.top - H - 4 : r.bottom + 4,
    up,
  };
  menuFor.value = c.id;
}

function closeMenu() {
  menuFor.value = "";
}

function toggleMenu(c, ev) {
  if (menuFor.value === c.id) closeMenu();
  else openMenu(c, ev);
}

function menuTogglePin() {
  const c = menuConvo.value;
  if (!c) return;
  togglePin(c);
  closeMenu();
}

function menuDelete() {
  const c = menuConvo.value;
  if (!c) return;
  delConvo(c);
  closeMenu();
}

function onDocPointerdown(ev) {
  if (!menuFor.value) return;
  const t = ev.target;
  if (menuBox.value?.contains(t)) return;
  if (t.closest?.(".ds-convo-more")) return; // 点 ⋮ 本体走 click 开/关，这里不抢
  closeMenu();
}

function onDocKeydown(ev) {
  if (ev.key === "Escape") closeMenu();
}

watch(sending, (v) => {
  if (v) closeMenu(); // 开始生成就收掉菜单，避免悬在禁用态行上
});

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerdown, true);
  document.addEventListener("keydown", onDocKeydown, true);
  convosNav.value?.addEventListener("scroll", closeMenu);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerdown, true);
  document.removeEventListener("keydown", onDocKeydown, true);
  convosNav.value?.removeEventListener("scroll", closeMenu);
});

function currentConvo() {
  return convos.value.find((c) => c.id === activeId.value) || convos.value[0];
}

/* ---------- 离开会话：整段消化（跨轮伏笔只有纵观整段才能沉淀） ----------
 * 在「离开一段对话」的边界（新建 / 切到另一段）触发：把该对话最近若干轮整段送后端做
 * 总结提取，补逐轮提取看不到的跨轮进展。fire-and-forget，不阻塞切换；失败/暂停静默。
 * 记账只推进到「送达」而非「确有新增」，且只有后端确认收到后才写 c.absorbed——关窗时
 * 没来得及吸收的，下次离开该对话时会带上全部新轮次补上，不会丢。删除对话不走这里
 * （用户弃掉的对话内容不该回流成记忆）。
 * 注意：暂停记忆期间聊的轮次不逐轮沉淀；若之后恢复记忆并离开该对话，整段消化会把这些
 * 内容一并纳入（消息不带时间戳，无法只排除暂停段）。介意的话可去 Memory 板块逐条删。
 * 窗口取最近 60 轮、总字符 24000 预算（对话上限内给模型留足上下文余量）：更早的轮次
 * 各自在当时的逐轮/整段消化里覆盖过。 */
function absorbConvo(c) {
  if (!c || memoryState.paused) return;
  const msgs = (c.messages || []).filter(
    (m) =>
      m &&
      !m.pending &&
      !m.streaming &&
      ((m.role === "user" && m.text) || (m.role === "assistant" && m.markdown)),
  );
  if (msgs.filter((m) => m.role === "user").length < 2) return; // 单轮收益=逐轮提取，不重复付一次模型
  if (msgs.length <= (c.absorbed ?? 0)) return; // 自上次吸收后没有新轮次
  const turns = [];
  let budget = 24000;
  for (const m of msgs.slice(-60)) {
    const content = String(m.role === "user" ? m.text : m.markdown || "").slice(0, 1200);
    if (!content) continue;
    budget -= content.length + 8;
    if (budget < 0) break;
    turns.push({ role: m.role, content });
  }
  if (turns.length < 2) return;
  digestSession(turns).then((ok) => {
    if (ok) c.absorbed = msgs.length; // 送达即看过这一段：即使 added=0 也不必下次整段再付一遍
  });
}

function touchTitle(convo, text) {
  if (convo.title === "New chat" && text) {
    convo.title = text.length > 24 ? text.slice(0, 24) + "…" : text;
  }
}

/* ---------- 滚动 / 输入 ---------- */

function scrollBottom() {
  nextTick(() => {
    if (thread.value) thread.value.scrollTop = thread.value.scrollHeight;
  });
}

// 流式生成中只跟随滚动条贴底（用户手动往上翻时不打扰）
function keepPinned() {
  const el = thread.value;
  if (!el) return;
  const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  if (!pinned) return;
  nextTick(() => {
    el.scrollTop = el.scrollHeight;
  });
}

function focusField() {
  nextTick(() => field.value?.focus());
}

function onKeydown(ev) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    send();
  }
}

/* ---------- 流式气泡：指令式直写 DOM ----------
 * 观察发现：本环境（Electron 内嵌/浏览器）在 fetch 流式进行期间，
 * Vue 的调度器不会逐帧 flush，DOM 会一直停在“正在思考…”直到流结束才整体渲染。
 * 因此气泡内容不走 v-if/v-html 的响应式切换，而是挂载后由 JS 直接更新容器 innerHTML，
 * 只把「流结束后出现的操作区」这类低频结构交给 Vue。 */

// 等待指示统一用 dmx 双股螺旋 Twin Helix：走 innerHTML 直写，
// 每点内联自己的 @keyframes 名与静止姿态；基础样式在 hermes-theme.css 全局定义。
const PENDING_HTML =
  '<div class="ds-pending"><span class="ds-dmx" aria-hidden="true">' +
  '<svg viewBox="0 0 24 24">' +
  DMX_HELIX.map(
    (d) =>
      `<circle cx="${d.cx}" cy="${d.cy}" r="1.6" fill="currentColor" class="ds-dmx-dot" style="animation-name:${d.kf};opacity:${d.base}"></circle>`,
  ).join("") +
  "</svg></span>正在思考…</div>";

function answerHtml(m) {
  if (m.html) return m.html;
  return m.markdown ? renderMarkdown(m.markdown) : "";
}

function paintAnswer(m) {
  const el = m && m.__host;
  if (!el) return;
  if (m.pending) {
    el.innerHTML = PENDING_HTML;
    return;
  }
  const caret = m.streaming ? '<span class="ds-caret-live">▍</span>' : "";
  el.innerHTML = (answerHtml(m) || "") + caret;
}

function attachAnswer(el, m) {
  if (!m) return;
  if (el) {
    m.__host = el;
    paintAnswer(m);
  } else {
    m.__host = null;
  }
}

/* ---------- 发送 / 流式 ---------- */

async function send() {
  const text = input.value.trim();
  if (!text || !ready.value || sending.value) return;

  const convo = currentConvo();
  if (!convo) return;
  const list = convo.messages;

  input.value = "";
  error.value = "";
  touchTitle(convo, text);
  convo.updatedAt = nowTs();
  list.push({ role: "user", text });

  const history = list
    .filter((m) => !m.pending && !m.streaming)
    .slice(0, -1)
    .map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.role === "user" ? m.text : (m.markdown || ""),
    }));

  sending.value = true;
  const assistant = { role: "assistant", pending: true, streaming: false };
  list.push(assistant);
  scrollBottom();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history,
        stream: true,
        remember: !memoryState.paused,
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(detail || `HTTP ${res.status}`);
    }

    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("text/event-stream")) {
      await streamAnswer(res, assistant);
    } else {
      // 服务端只承诺 SSE；HTTP 200 却返回整段非流式 = 契约被破坏，宁可报错也不吞
      throw new Error("服务端返回了非流式响应（预期 SSE）");
    }

    assistant.pending = false;
    assistant.streaming = false;
    // 模型偶尔会裹一层 {"markdown": ...}，流式结束后再兜底解一次
    const clean = unwrapMarkdown(assistant.markdown || "");
    if (clean !== (assistant.markdown || "")) {
      assistant.markdown = clean;
      assistant.html = renderMarkdown(clean);
    }
    if (!assistant.markdown) {
      list.pop();
      throw new Error("Model returned no content, please retry");
    }
    paintAnswer(assistant);
    // 一条回答完整落地后异步提炼长期记忆；暂停中或失败都静默
    rememberTurn(text, assistant.markdown);
  } catch (e) {
    // 已收到部分内容时保留气泡（内容继续显示），只提示出错
    const last = list[list.length - 1];
    if (!(last === assistant && assistant.markdown)) {
      list.pop();
    } else {
      paintAnswer(assistant);
    }
    error.value = e.message || "Request failed, please retry";
  } finally {
    sending.value = false;
    convo.updatedAt = nowTs();
    scrollBottom();
  }
}

/** 消费 SSE：解析 data 行里的 choices[0].delta.content，节流渲染 Markdown 上屏 */
async function streamAnswer(res, msg) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let md = "";
  let done = false;
  let timer = 0;
  let dirty = false;
  let serverError = "";

  const paint = () => {
    timer = 0;
    if (!dirty) return;
    dirty = false;
    msg.markdown = md;
    msg.html = renderMarkdown(md);
    paintAnswer(msg);
    keepPinned();
  };
  const kick = () => {
    dirty = true;
    if (!timer) timer = setTimeout(paint, 45);
  };

  while (!done) {
    const { done: ended, value } = await reader.read();
    if (ended) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        break;
      }
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        if (msg.pending) {
          msg.pending = false;
          msg.streaming = true; // 首个字落地：占位文案换成真内容
          paintAnswer(msg);
        }
        md += delta;
        kick();
      } else if (typeof json?.message === "string") {
        serverError = json.message;
      }
    }
  }

  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  if (dirty) {
    dirty = false;
    msg.markdown = md;
    msg.html = renderMarkdown(md);
    paintAnswer(msg);
  }

  if (serverError) throw new Error(serverError);
}
</script>

<template>
  <div class="ds-shell vp-tui-raw" :class="{ 'is-side-hidden': appChrome.sidebarHidden }">
    <aside class="ds-side">
      <ModuleRailTabs />
      <nav ref="convosNav" class="ds-convos">
        <!-- 置顶组在整个列表最上（Sessions 标题之前）：只含被钉会话；Sessions 组紧随其后：
             只含未钉会话，组标题行右端挂新建「+」。Pinned 空则整组不渲染（Sessions 变首行） -->
        <template v-for="g in convoGroups" :key="g.head || 'rest'">
          <div v-if="g.head" class="ds-pin-head">
            <span class="ds-sessions-mark" aria-hidden="true"></span>
            <span>{{ g.head }}</span>
          </div>
          <div v-else class="ds-sessions-head">
            <span class="ds-sessions-label">
              <span class="ds-sessions-mark" aria-hidden="true"></span>
              Sessions
            </span>
            <button
              class="ds-new"
              @click="newChat"
              :disabled="sending"
              aria-label="New chat"
              title="New chat"
            >
              <AppIcon name="plus" :size="12" />
            </button>
          </div>
          <div
            v-for="c in g.items"
            :key="c.id"
            class="ds-convo-item"
            :class="{
              'is-active': c.id === activeId,
              'is-streaming': sending && c.id === activeId,
              'is-menu-open': menuFor === c.id,
            }"
          >
            <button class="ds-convo" :disabled="sending" @click="selectChat(c.id)">
              <span
                v-if="sending && c.id === activeId"
                class="ds-arc ds-convo-arc"
                aria-hidden="true"
              ></span>
              <span
                class="ds-dot"
                :class="{ 'is-active': c.id === activeId }"
                aria-hidden="true"
              ></span>
              <span class="ds-convo-title">{{ c.title }}</span>
            </button>
            <button
              class="ds-convo-more"
              :disabled="sending"
              aria-label="Chat actions"
              aria-haspopup="menu"
              :aria-expanded="menuFor === c.id"
              title="Chat actions"
              @click.stop="toggleMenu(c, $event)"
            >
              <AppIcon name="ellipsisV" :size="15" :sw="1.8" />
            </button>
          </div>
        </template>
      </nav>
    </aside>

    <Teleport to="body">
      <div
        v-if="menuFor && menuConvo"
        ref="menuBox"
        class="ds-menu"
        role="menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
      >
        <button class="ds-menu-item" role="menuitem" @click="menuTogglePin">
          <AppIcon name="pin" :size="13" :sw="1.6" />
          <span>{{ isPinned(menuConvo) ? "Unpin" : "Pin" }}</span>
        </button>
        <div class="ds-menu-sep" role="separator"></div>
        <button class="ds-menu-item ds-menu-item--danger" role="menuitem" @click="menuDelete">
          <AppIcon name="trash2" :size="13" :sw="1.5" />
          <span>Delete</span>
        </button>
      </div>
    </Teleport>

    <div class="ds-main">
      <!-- 设置页（SessionSettings：Key/备份）：齿轮在主区打开；弹层由它自己挂 -->
      <SessionSettings v-if="appChrome.settingsOpen" @close="closeSettings" />
      <!-- 板块页：Memory / Todo 独立于会话，各自挂载时拉最新数据 -->
      <MemoryBoard v-else-if="appChrome.view === 'memory'" />
      <TodoBoard v-else-if="appChrome.view === 'todo'" />

      <div v-else class="ds-inner">
        <div ref="thread" class="ds-thread">
          <div v-if="messages.length === 0" class="ds-welcome">
            <WelcomeLogo class="ds-wl" />
          </div>

          <template v-for="(msg, i) in messages" :key="i">
            <div v-if="msg.role === 'user'" class="ds-row ds-row--user">
              <div class="ds-user">{{ msg.text }}</div>
            </div>

            <div v-else-if="msg.role === 'assistant'" class="ds-row ds-row--ai">
              <div class="vp-doc ds-answer" :ref="(el) => attachAnswer(el, msg)"></div>
            </div>
          </template>

          <div v-if="error" class="ds-error">
            <AppIcon name="alert" class="ds-ic" :size="15" :sw="1.5" />
            <span>{{ error }}</span>
          </div>
        </div>

        <form class="ds-bar" @submit.prevent="send">
          <textarea
            ref="field"
            v-model="input"
            rows="1"
            class="ds-field"
            placeholder="你在想什么…"
            @keydown="onKeydown"
          ></textarea>
          <button type="submit" class="ds-send" :disabled="sending || !input.trim()" :aria-label="sending ? 'Stop' : 'Send'">
            <AppIcon v-if="!sending" name="send" :size="14" :sw="2.2" />
            <span v-else class="ds-stop" aria-hidden="true"></span>
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ds-shell {
  display: flex;
  height: calc(100vh - var(--vp-nav-height, 60px));
  margin-top: var(--vp-nav-height, 60px);
}

/* ---------- 左侧：历史对话 ---------- */

.ds-side {
  flex: none;
  width: 240px; /* 侧栏内容宽收窄到 240（全局 .ds-side 已 !important 固定；此处是兜底镜像） */
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 4px 10px;
  border-right: 1px solid rgba(255, 255, 255, 0.04); /* Hermes 近隐形分割线（与全局 .ds-side 同步） */
  background: var(--do-bg-soft, rgba(127, 127, 127, 0.04));
}
.ds-new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 12px 4px;
  padding: 8px 10px;
  border: 1px solid var(--do-divider);
  border-radius: 10px;
  background: transparent;
  color: var(--do-text-1);
  font: inherit;
  font-size: 13px; /* Hermes 刻度正文（conversation 13px） */
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, background 0.2s;
}
.ds-new:hover:not(:disabled) {
  border-color: var(--do-brand-1);
  color: var(--do-brand-1);
  background: var(--do-brand-soft);
}
.ds-new:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ds-convos {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 列宽不整列收窄：右内距只留 4px，行右缘仍贴到列尾（与行尾 ⋮、组头 + 同齐）；
     行带的「收短」由 .ds-convo 自身的左 margin 实现（左侧收，见下） */
  padding: 0 4px;
}
.ds-convo-item {
  position: relative;
  border-radius: 2px; /* 兜底镜像：全局 theme.css 已收成近直角（Hermes 缩放 rounded-md≈2px） */
}
.ds-convo {
  display: block;
  /* width:auto 在 <button> 上会收缩到内容宽，须显式扣除左 margin：box-sizing 为 border-box，
     width 与 margin 同扣，背景带右缘就稳定落在整列右 x240（右缘不随左移而动） */
  width: calc(100% - 4px);
  /* 行背景带左侧收 4px（用户：会话左侧再往左移一点，右缘不动）：左缘 x12 与 Sessions/Pinned
     标题同齐，右缘仍到 x240 —— 移动只发生在左边，行尾 ⋮ 与新会话 + 号的对齐不受影响 */
  margin-left: 4px;
  text-align: left;
  border: none;
  background: transparent;
  border-radius: 2px;
  padding: 9px 34px 9px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.ds-convo:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ds-convo-item:hover .ds-convo {
  background: var(--do-bg);
}
.ds-convo-item.is-active .ds-convo {
  background: var(--do-brand-soft);
}
.ds-convo-title {
  display: block;
  color: var(--do-text-1);
  font-size: 13px;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-convo-item.is-active .ds-convo-title {
  color: var(--do-brand-1);
  font-weight: 600;
}
.ds-convo-more {
  position: absolute;
  top: 50%;
  right: 3px;
  transform: translateY(-50%);
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--do-text-3);
  font: inherit;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}
.ds-convo-item:hover .ds-convo-more,
.ds-convo-item.is-active .ds-convo-more,
.ds-convo-item.is-menu-open .ds-convo-more,
.ds-convo-more:focus-visible {
  opacity: 1;
}
.ds-convo-item.is-menu-open .ds-convo-more,
.ds-convo-more:hover:not(:disabled) {
  color: rgba(255, 255, 255, 0.94);
  background: rgba(255, 255, 255, 0.08);
}
.ds-convo-more:focus-visible {
  outline: none;
}
.ds-convo-more:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

/* Pinned 置顶分组标题（Hermes 同款独立分组；无置顶会话时整组不渲染）。组在整个列表最上、
   Sessions 标题之前。标题前带与 Sessions 同一个方形点阵标（.ds-sessions-mark，间距同
   .ds-sessions-label 的 6px）。字与方形矩同蓝 --do-accent（用户要求 pinned 几个字也变蓝）；
   padding 几何照抄 Sessions 组标题行：列表容器先垫 4px，左 8px 落到与 Sessions 标题同 x16 */
.ds-pin-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 与 .ds-sessions-head（theme.css）同几何：列表容器先垫 4px，左 4px 落到与会话行同 x12 */
  padding: 6px 0 4px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--do-accent);
  user-select: none;
}

/* 行尾 ⋮ 弹出菜单：Hermes 小圆角浮层（elevated 玻璃 + hairline）。Teleport 到 body，
   用 fixed 定位避开 .ds-convos 滚动容器的裁剪；scoped 属性随 Teleport 内容保留 */
.ds-menu {
  position: fixed;
  z-index: 300;
  box-sizing: border-box;
  min-width: 150px;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: color-mix(in srgb, var(--do-bg-elv) 96%, transparent);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
  backdrop-filter: blur(12px) saturate(1.1);
  box-shadow: 0 10px 28px -6px rgba(0, 0, 0, 0.5);
  font-size: 12px;
  animation: ds-menu-in 0.12s ease-out;
}
@keyframes ds-menu-in {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.ds-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: rgba(255, 255, 255, 0.84);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.ds-menu-item svg {
  flex: none;
  color: rgba(255, 255, 255, 0.4);
}
.ds-menu-item:hover {
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.94);
}
.ds-menu-item--danger,
.ds-menu-item--danger svg {
  color: var(--do-danger-1);
}
.ds-menu-item--danger:hover {
  background: color-mix(in srgb, var(--do-danger-1) 14%, transparent);
  color: var(--do-danger-1);
}
.ds-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: rgba(255, 255, 255, 0.08);
}
@media (prefers-reduced-motion: reduce) {
  .ds-menu {
    animation: none;
  }
}

/* ---------- 右侧：聊天主区 ---------- */

.ds-main {
  flex: 1;
  min-width: 0;
  display: flex;
}
.ds-inner {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  /* 不再固定 940px 上限：窄窗保持内距呼吸，宽窗/全屏时整列随窗口铺开，
     输入框（.ds-bar）也随之变长；超大屏才由 max-width 兜底并居中。 */
  max-width: 1760px;
  margin: 0 auto;
  padding: 0 clamp(20px, 3vw, 96px);
}
.ds-thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 2px 4px;
  scroll-behavior: smooth;
}
.ds-welcome {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 12px;
}
.ds-wl {
  width: 100%;
}
.ds-row {
  margin-bottom: 20px;
}
.ds-row--user {
  display: block; /* Hermes「独占一行」：用户消息占满整行，不是右对齐气泡 */
}
/* 兜底镜像（全局 theme.css .ds-user 为 Hermes 全宽卡片，!important 接管；
   此块只在无全局环境的场景下兜底，值保持一致） */
.ds-user {
  width: 100%;
  max-width: none;
  box-sizing: border-box;
  background: var(--do-user-bg);
  border: 1px solid var(--do-user-border);
  border-radius: 3px; /* Hermes 缩放 rounded-xl≈2.4→3px：近乎直角（兜底镜像与全局一致） */
  color: var(--do-text-1);
  font-size: 13px; /* Hermes 对话刻度 13px */
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  padding: 8px 12px; /* Hermes px-3 py-2 */
}
.ds-row--ai .ds-answer {
  font-size: 13px;
  /* 兜底镜像：全局 theme.css 已给 .ds-answer 加 13px 左内缩（= .ds-user 1px 边框 + 12px 左内边距，
     让 AI 回复文字列跟用户消息框内文字同起点）；此处仅在无全局环境的场景下生效，值保持一致 */
  padding-left: 13px;
}
.ds-answer :deep(h1) {
  font-size: 1.125rem;
  line-height: 1.35;
  margin: 0 0 10px;
  border-bottom: none;
  padding-bottom: 0;
  letter-spacing: -0.01em;
}
.ds-answer :deep(h2) {
  font-size: 1rem;
  margin: 18px 0 8px;
  padding-bottom: 0;
  border-bottom: none;
}
.ds-answer :deep(h3) {
  font-size: 0.875rem;
}
.ds-answer :deep(p) {
  margin: 8px 0;
  line-height: 1.5;
}
.ds-answer :deep(ul),
.ds-answer :deep(ol) {
  padding-left: 22px;
  margin: 8px 0;
}
.ds-answer :deep(blockquote) {
  margin: 10px 0;
}
.ds-answer :deep(pre) {
  margin: 10px 0;
}
.ds-answer :deep(table) {
  display: block;
  overflow-x: auto;
  margin: 10px 0;
}
.ds-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--do-danger-1);
  background: var(--do-danger-soft);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 13px;
  word-break: break-word;
  margin-bottom: 12px;
}
.ds-error .ds-ic {
  margin: 2px 0 0;
}
.ds-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 4px 0 14px;
  padding: 3px 4px 3px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 3px; /* 全局 Hermes 覆盖会接管（矮条近直角 3px）；此处是给无全局环境的兜底 */
  background: #101114; /* 沉槽暗井（全局覆盖同值）：比画布 #1d1f22 更暗，矩形框整体凹下一档 */
  /* 聚焦不加白边（用户：选中不白边）——hairline 边框恒定，状态只由光标/内容表达 */
}
.ds-field {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: rgba(230, 237, 243, 0.94); /* Hermes text-foreground：主题前景 94% */
  font: inherit;
  font-size: 13px; /* 与全局 Hermes 13px 对齐；此值无 !important，仍以全局为准 */
  line-height: 18px;
  padding: 3px 0;
  /* 外高 24px = 行盒 18 + 上下 3px 内距：与右侧圆形发送钮（24px）等高相切，不再上下悬空；
     打字不把发送框顶高，长内容在框内滚动（滚动条已全站隐藏，仍可滚） */
  height: 18px;
  resize: none;
  overflow-y: auto;
}
.ds-field:focus {
  outline: none;
}
.ds-field::placeholder {
  color: var(--do-text-3);
}
.ds-send {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  padding: 0;
  background: rgba(255, 255, 255, 0.94); /* 圆形墨钮：近白底黑字（全局 Hermes 覆盖会接管） */
  color: #000000;
  cursor: pointer;
  transition: background-color 0.15s;
}
.ds-send:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.85); /* Hermes hover：实心钮微降一档 */
}
.ds-send:disabled {
  background: rgba(255, 255, 255, 0.28);
  color: rgba(0, 0, 0, 0.55);
  cursor: not-allowed;
}

/* ---------- 应用级 chrome 状态：收起侧栏（顶条按钮）藏左侧会话栏 ---------- */

.ds-shell.is-side-hidden .ds-side {
  display: none;
}

/* 会话/聊天列表不显示竖向滚动条（保留滚动能力），避免出现滑块 */
.ds-convos,
.ds-thread,
.ds-field {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.ds-convos::-webkit-scrollbar,
.ds-thread::-webkit-scrollbar,
.ds-field::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

@media (max-width: 760px) {
  .ds-side {
    display: none;
  }
  .ds-inner {
    padding: 0 14px;
  }
}
</style>

<!-- 直写 innerHTML 注入的气泡内容无法命中 scoped 选择器，这里用全局样式补齐占位与光标 -->
<style>
.ds-pending {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--do-text-2);
  font-size: 13px;
  padding: 6px 0;
}
.ds-caret-live {
  display: inline-block;
  color: var(--do-brand-1);
  font-size: 13px;
  line-height: 1;
  margin: 2px 0 0 2px;
  animation: ds-caret-blink 0.9s steps(2, start) infinite;
}
@keyframes ds-caret-blink {
  0% { opacity: 0; }
  50% { opacity: 1; }
  100% { opacity: 1; }
}
</style>
