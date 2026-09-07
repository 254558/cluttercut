<script setup lang="ts">
// 静态说明文字的入口：平时只露一个小 ⓘ，悬停/键盘聚焦才展开整段提示。
// 用来替代那些占一整行/一整块的灰字说明，让界面更干净。
import AppIcon from "./AppIcon.vue";

withDefaults(defineProps<{ tip: string; align?: "left" | "right" }>(), {
  align: "left",
});
</script>

<template>
  <span class="it" :class="'it--' + align" tabindex="0" role="note" aria-label="说明">
    <AppIcon name="info" :size="15" />
    <span class="it-pop">{{ tip }}</span>
  </span>
</template>

<style scoped>
.it {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--do-text-3);
  cursor: help;
  border-radius: 50%;
  outline: none;
}
.it svg {
  display: block;
}
.it:hover,
.it:focus-visible {
  color: var(--do-text-1);
}
.it-pop {
  position: absolute;
  top: calc(100% + 8px);
  z-index: 80;
  width: max-content;
  max-width: min(390px, 76vw);
  padding: 9px 12px;
  border-radius: 8px;
  background: var(--do-bg-elv);
  border: 1px solid var(--do-divider);
  color: var(--do-text-1);
  font-size: 12px; /* Hermes caption 刻度 */
  font-weight: 400;
  line-height: 1.6;
  text-align: left;
  white-space: pre-line;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: opacity 0.14s ease, transform 0.14s ease, visibility 0.14s;
}
.it:hover .it-pop,
.it:focus-visible .it-pop {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
.it--left .it-pop {
  left: 0;
}
.it--right .it-pop {
  left: auto;
  right: 0;
}
</style>
