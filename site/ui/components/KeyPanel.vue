<script setup lang="ts">
// DeepSeek API Key 设置弹层：填写/清除写本机密钥文件，即时生效无需重启。
// 状态徽标文案（Manage…/Set key…）由设置页维护，这里只管弹层内的填写流。
import { nextTick, ref } from "vue";
import { tryPost } from "../core/api";
import AppIcon from "./AppIcon.vue";

const emit = defineEmits<{ close: [] }>();

interface KeyStatus {
  ok?: boolean;
  configured?: boolean;
  source?: "env" | "file" | null;
}

const keySaving = ref(false);
const keyValue = ref("");
const keyInputEl = ref<HTMLInputElement | null>(null);
const keyStatus = ref<KeyStatus | null>(null);
const keyMsg = ref<{ kind: "ok" | "err"; text: string } | null>(null);
// 已配置 Key 时输入框显示的占位星号（不是真实 Key；原封不动直接保存 = 什么都不做）
const KEY_MASK = "*".repeat(16);

async function refreshKeyStatus() {
  try {
    const res = await fetch("/api/key/status");
    if (res.ok) keyStatus.value = await res.json();
  } catch {
    /* 未运行服务时静默 */
  }
}

// 打开即刷新一次状态，已配置时用星号占位（不显示原文）
refreshKeyStatus().then(() => {
  if (keyStatus.value?.configured) keyValue.value = KEY_MASK;
  nextTick(() => keyInputEl.value?.focus());
});

function onKeyFocus() {
  // 占位星号整段选中：直接输入新 Key 会整段替换，不会和星号混在一起
  if (keyValue.value === KEY_MASK) keyInputEl.value?.select();
}

function close() {
  keyMsg.value = null;
  emit("close");
}

async function saveKey() {
  // 星号占位原封不动：说明用户没打算改，直接关掉，别把一串 * 当真 Key 写进文件
  if (keyValue.value === KEY_MASK) {
    keyValue.value = "";
    close();
    return;
  }
  if (keySaving.value) return;
  keySaving.value = true;
  keyMsg.value = null;
  const r = await tryPost<KeyStatus & { error?: string }>("/api/key", { key: keyValue.value });
  if (r.ok && r.data) {
    keyStatus.value = r.data;
    const cleared = keyValue.value.trim() === "";
    // 保存/清除后仍按服务端状态回填星号占位（环境变量 Key 清不掉时同理），
    // 不把真实 Key 或一串 * 一直留在输入框里
    keyValue.value = r.data.configured ? KEY_MASK : "";
    keyMsg.value = cleared
      ? { kind: "ok", text: "Deleted the saved key (an env var still takes precedence if set)." }
      : { kind: "ok", text: "Saved and active — you can chat now." };
  } else {
    keyMsg.value = {
      kind: "err",
      text: r.data?.error || r.errorText || `Save failed (${r.status})`,
    };
  }
  keySaving.value = false;
}
</script>

<template>
  <div class="ds-overlay" @click.self="close">
    <div class="ds-mpanel ds-kpanel" role="dialog" aria-modal="true" aria-label="设置 DeepSeek API Key">
      <div class="ds-mp-head">
        <div class="ds-mp-title">
          <AppIcon name="key" class="ds-ic" :size="16" :sw="1.5" />
          <span>DeepSeek API Key</span>
        </div>
        <button class="ds-mp-close" type="button" aria-label="关闭" title="关闭" @click="close">
          <AppIcon name="close" :size="16" :sw="1.5" />
        </button>
      </div>

      <div class="ds-k-body">
        <input
          ref="keyInputEl"
          v-model="keyValue"
          class="ds-k-input"
          :type="keyValue === KEY_MASK ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-…"
          :disabled="keySaving"
          @focus="onKeyFocus"
          @keydown.enter.prevent="saveKey"
        />

        <p v-if="keyMsg" class="ds-k-msg" :class="'is-' + keyMsg.kind">{{ keyMsg.text }}</p>
      </div>

      <div class="ds-mp-foot ds-k-foot">
        <div class="ds-mp-spacer"></div>
        <button class="ds-mp-btn ds-k-cancel" type="button" :disabled="keySaving" @click="close">Cancel</button>
        <button class="ds-mp-btn" type="button" :disabled="keySaving" @click="saveKey">
          {{ keySaving ? "Saving…" : keyValue.trim() === "" && keyStatus && keyStatus.configured ? "Clear saved key" : "Save" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Key 弹层专有样式；面板基座见 hermes-theme.css「弹层原语」 */

.ds-kpanel {
  width: min(520px, 94vw);
}
.ds-k-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 18px 8px;
}
.ds-k-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--do-divider);
  border-radius: 10px;
  background: var(--do-bg-soft);
  color: var(--do-text-1);
  font: inherit;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  transition: border-color 0.15s;
}
.ds-k-input:focus {
  outline: none;
  border-color: var(--do-brand-1);
}
.ds-k-input::placeholder {
  color: var(--do-text-3);
}
.ds-k-msg {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.ds-k-msg.is-ok {
  color: var(--do-brand-1);
  background: var(--do-brand-soft, rgba(100, 108, 255, 0.12));
}
.ds-k-msg.is-err {
  color: var(--do-danger-1, #dc2626);
  background: var(--do-danger-soft, rgba(220, 38, 38, 0.1));
}
.ds-k-foot {
  padding: 12px 18px 16px;
}
/* .ds-k-cancel 配色收进 hermes-theme.css「Hermes 收口」一节（那里要压过
   vercel.css 老的高特指规则），这里不再重复定义 */

</style>
