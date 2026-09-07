<script setup lang="ts">
// 栏头模块条：Home（聊天会话）| Memory（记忆板块）| Todo（待办清单）三枚字标。
// 是应用真实的板块切换入口：点击切到对应板块（appChrome.view），激活态蓝色下划线
// 呼应当前所在板块；切换由 ModuleRailTabs 发起、主区内容由 DeepSeekDocChat 按 view 渲染。
// 三块 = #0f1319 方角无框线矩形：紧密相邻（0 缝连成一条沉槽）、矮 24px、极窄取字宽、
// 不铺满侧栏；激活态为更亮文字 + 与所在矩形等宽的块底蓝短杠。若处于 macOS 原生全屏
// （appChrome.isFullscreen，红绿灯消失）整条贴左缘。
import { appChrome, goView, type AppView } from "../core/app-chrome";

const MODULES: { id: AppView; label: string; hint: string }[] = [
  { id: "chat", label: "Home", hint: "会话聊天" },
  { id: "memory", label: "Memory", hint: "长期记忆板块" },
  { id: "todo", label: "Todo", hint: "待办清单板块" },
];
</script>

<template>
  <nav class="mrt" aria-label="应用模块">
    <button
      v-for="m in MODULES"
      :key="m.id"
      type="button"
      class="mrt-tab"
      :class="{ 'is-active': appChrome.view === m.id }"
      :aria-current="appChrome.view === m.id ? 'true' : undefined"
      :title="`${m.label}（${m.hint}）`"
      @click="goView(m.id)"
      >{{ m.label }}</button
    >
  </nav>
</template>

<style scoped>
/* 栏头单行：Home|Memory|Todo 三个模块字标块 —— 每块 #0f1319（比画布 #1d1f22 再暗一档的
   沉槽色）方角无框线矩形：零圆角、无描边。三块紧密相邻（块间 0 缝，视觉成一条连续沉槽）、
   取字本身宽再收紧（内距只留 6px），不铺满侧栏。激活态 = 更亮文字 + 与所在矩形等宽的
   块底 Hermes 蓝短杠（left/right 0，不再内缩）。 */
.mrt {
  display: flex;
  align-items: center;
  flex: none;
  height: 34px; /* 行高保持 34：三块 24px 在其中上下留白，不压挤下方会话列表的节奏 */
  margin-left: -4px; /* 左移抵消 .ds-side 的 4px 内距，让模块矩形贴到侧栏/窗口最左缘（用户：左边不留空隙） */
  min-width: 0;
  user-select: none;
}
.mrt-tab {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 0 6px;
  border: none;
  border-radius: 0; /* 方角：明确零圆角 */
  background: #0f1319;
  font: inherit;
  line-height: 1;
  font-size: 11px;
  letter-spacing: 0.01em;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.54);
  cursor: pointer;
  transition: color 0.18s ease;
}
.mrt-tab:hover {
  color: rgba(255, 255, 255, 0.94);
}
.mrt-tab::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: 0; /* 方角矩形内的激活短杠同样收直角 */
  background: transparent;
  transition: background 0.18s ease;
}
.mrt-tab.is-active {
  color: rgba(255, 255, 255, 0.94);
}
.mrt-tab.is-active::after {
  background: #5b9bff; /* Hermes 蓝下划线：全站唯一蓝色强调点 */
}
</style>
