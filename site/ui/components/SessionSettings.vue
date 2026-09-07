<script setup lang="ts">
// 设置页（精简单页）：右上齿轮在主区打开。行两端对齐（左名右控件）。
// 三件事：DeepSeek Key（自持状态徽标 + Key 弹层）、一键备份到桌面、从备份 zip 恢复。
// 记忆的一切（自动收集/条数/增删改查/压缩）已迁入 Memory 板块，这里不再有记忆行。
import { computed, onMounted, ref } from "vue";
import { apiRequest, tryPost } from "../core/api";
import AppIcon from "./AppIcon.vue";
import KeyPanel from "./KeyPanel.vue";

const emit = defineEmits<{ close: [] }>();

/* ---- DeepSeek Key 行：状态徽标文字 + Key 弹层 ---- */

const showKey = ref(false);
const keyStatus = ref<{ ok?: boolean; configured?: boolean; source?: string } | null>(null);

const keyRowLabel = computed(() => (keyStatus.value?.configured ? "Manage…" : "Set key…"));

async function refreshKeyStatus() {
  try {
    keyStatus.value = await apiRequest<{ ok?: boolean; configured?: boolean; source?: string }>(
      "/api/key/status",
    );
  } catch {
    /* 本机服务未跑时静默 */
  }
}

async function onKeyPanelClose() {
  showKey.value = false;
  await refreshKeyStatus(); // 清除/保存后让行内按钮文案（Manage…/Set key…）跟着刷新
}

/* ---- 备份到桌面：调本地服务打包个人数据成一个 zip 放到桌面 ---- */

const backingUp = ref(false);
const backupMsg = ref<{ kind: "ok" | "err"; text: string } | null>(null);

async function backupNow() {
  if (backingUp.value) return;
  backingUp.value = true;
  backupMsg.value = null;
  const r = await tryPost<{ ok?: boolean; name?: string; error?: string }>("/api/backup");
  if (r.ok && r.data?.ok) {
    backupMsg.value = {
      kind: "ok",
      text: r.data.name ? `Backed up to Desktop: ${r.data.name}` : "Backed up to Desktop.",
    };
  } else {
    backupMsg.value = {
      kind: "err",
      text: r.data?.error || r.errorText || "Backup failed.",
    };
  }
  backingUp.value = false;
}

onMounted(() => {
  refreshKeyStatus();
});

/* ---- 恢复备份：选 zip → 上传本地服务校验并暂存，随后应用自动重启写回数据 ----
 * 不走 tryPost：zip 是二进制，须原样 POST（Content-Type: application/zip）。
 * 服务端只校验 + 暂存，真正覆盖写回发生在重启后的开库前（避免在运行的进程里
 * 直接替换被 sqlite 打开的 ai-chat.db）。 */

const fileInput = ref<HTMLInputElement | null>(null);
const restoring = ref(false);
const restoreMsg = ref<{ kind: "ok" | "err"; text: string } | null>(null);

function onPickRestoreFile(e: Event) {
  const el = e.target as HTMLInputElement;
  const file = el.files?.[0];
  el.value = ""; // 允许重复选同一个文件再次触发 change
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) {
    restoreMsg.value = { kind: "err", text: "请选择 ClutterCut 备份 zip 文件。" };
    return;
  }
  void restoreFrom(file);
}

async function restoreFrom(file: File) {
  if (restoring.value) return;
  restoring.value = true;
  restoreMsg.value = null;
  try {
    const res = await fetch("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: await file.arrayBuffer(),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      createdAt?: string;
      error?: string;
    } | null;
    if (res.ok && data?.ok) {
      const when = data.createdAt ? new Date(data.createdAt).toLocaleString() : "";
      restoreMsg.value = {
        kind: "ok",
        text: `Backup accepted${when ? ` (created ${when})` : ""} — ClutterCut is restarting to apply it.`,
      };
    } else {
      restoreMsg.value = {
        kind: "err",
        text: (data && typeof data.error === "string" ? data.error : "Restore failed.") as string,
      };
    }
  } catch (e) {
    restoreMsg.value = { kind: "err", text: `Restore failed: ${String((e as Error)?.message ?? e)}` };
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="ds-settings">
    <header class="ds-settings-head">
      <button
        class="ds-settings-close"
        type="button"
        title="关闭设置"
        aria-label="关闭设置"
        @click="emit('close')"
      >
        <AppIcon name="close" :size="14" :sw="1.8" />
      </button>
    </header>

    <div class="ds-settings-body">
      <div class="ds-setrow">
        <span class="ds-setrow__name">DeepSeek API key</span>
        <button class="ds-sbtn" type="button" @click="showKey = true">{{ keyRowLabel }}</button>
      </div>
      <div class="ds-setrow">
        <span class="ds-setrow__name">Backup to Desktop</span>
        <button class="ds-sbtn ds-sbtn--primary" type="button" :disabled="backingUp" @click="backupNow">
          {{ backingUp ? "Backing up…" : "Back up now" }}
        </button>
      </div>
      <p v-if="backupMsg" class="ds-settings-msg" :class="'is-' + backupMsg.kind">{{ backupMsg.text }}</p>
      <div class="ds-setrow">
        <span class="ds-setrow__name">Restore backup</span>
        <button class="ds-sbtn" type="button" :disabled="restoring" @click="fileInput?.click()">
          {{ restoring ? "Restoring…" : "Choose zip…" }}
        </button>
        <input ref="fileInput" class="ds-file" type="file" accept=".zip,application/zip" @change="onPickRestoreFile" />
      </div>
      <p v-if="restoreMsg" class="ds-settings-msg" :class="'is-' + restoreMsg.kind">{{ restoreMsg.text }}</p>
    </div>
  </div>

  <KeyPanel v-if="showKey" @close="onKeyPanelClose" />
</template>

<style scoped>
/* 设置页（精简单页）：右上叉关闭，行两端对齐（左名右控件） */

.ds-settings {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  padding: 20px clamp(20px, 4vw, 48px) 40px;
  overflow-y: auto;
}
.ds-settings-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 0 14px;
}
.ds-settings-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--do-text-3);
  cursor: pointer;
  transition: color 0.15s;
}
.ds-settings-close:hover {
  color: var(--do-text-1);
}
.ds-settings-body {
  width: 100%;
  margin-top: 6px;
}
.ds-setrow {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 2px;
}
.ds-setrow__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--do-text-1);
}
.ds-setrow__value {
  flex: none;
  font-size: 12px;
  color: var(--do-text-3);
  white-space: nowrap;
}
.ds-sbtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 3px 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  font-weight: 500;
  color: var(--do-text-2);
  cursor: pointer;
  transition: color 0.15s, opacity 0.2s;
}
.ds-sbtn:hover:not(:disabled) {
  color: var(--do-text-1);
}
.ds-sbtn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ds-sbtn--primary {
  color: #f4f4f6;
}
.ds-sbtn--primary:hover:not(:disabled) {
  color: #ffffff;
}
.ds-settings-msg {
  margin: 12px 2px 0;
  font-size: 12px;
  line-height: 1.5;
}
.ds-settings-msg.is-ok {
  color: #e8e8ec;
}
.ds-settings-msg.is-err {
  color: var(--do-danger-1);
}
.ds-file {
  display: none;
}
</style>
