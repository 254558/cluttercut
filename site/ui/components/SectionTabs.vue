<script setup lang="ts">
// 38px 全宽应用顶条 —— 顶条本体是空拖拽条，Mac 红绿灯悬浮于左端。
// 红绿灯右侧同排一个「收起/展开侧边栏」钮；右上角是设置齿轮。
// 栏头 Home|Memory|Todo 模块标签条由 ModuleRailTabs.vue 渲染（可点切换视图）。
import { onMounted, onUnmounted } from "vue";
import AppIcon from "./AppIcon.vue";
import {
  appChrome,
  openSettings,
  toggleSidebar,
  syncFullscreen,
  bindNativeFullscreen,
} from "../core/app-chrome";

let unbindFs: (() => void) | undefined;

function onFsChange() {
  syncFullscreen();
}

onMounted(() => {
  syncFullscreen(); // 先按当前窗口状态归位（例如页面加载时已在全屏）
  unbindFs = bindNativeFullscreen(); // Electron 里订阅主进程的 enter/leave-full-screen 推送
  window.addEventListener("resize", onFsChange);
  window.addEventListener("fullscreenchange", onFsChange);
});

onUnmounted(() => {
  unbindFs?.();
  unbindFs = undefined;
  window.removeEventListener("resize", onFsChange);
  window.removeEventListener("fullscreenchange", onFsChange);
});

// 设置面板唯一常驻（聊天模块承载），齿轮只负责弹面板
function onGear() {
  openSettings();
}
</script>

<template>
  <!-- 空顶条：整条可作 Electron 拖拽区，红绿灯悬浮在左端（x≈24，y≈12） -->
  <div class="st-nav" aria-label="应用顶栏"></div>

  <!-- 收起/展开侧边栏：紧挨红绿灯右侧（x=84 起，避开约 52px 宽的灯组），
       与红绿灯同一条 38px 行。收起状态存 appChrome.sidebarHidden，
       同一钮收起后再点即翻成展开图标把侧栏拉回。 -->
  <button
    class="st-nav__btn st-nav__side"
    type="button"
    :class="{ 'is-fs': appChrome.isFullscreen }"
    :title="appChrome.sidebarHidden ? '展开侧边栏' : '收起侧边栏'"
    :aria-label="appChrome.sidebarHidden ? '展开侧边栏' : '收起侧边栏'"
    :aria-expanded="!appChrome.sidebarHidden"
    @click="toggleSidebar()"
  >
    <AppIcon v-if="!appChrome.sidebarHidden" name="panelL" :size="15" :sw="1.7" />
    <AppIcon v-else name="panelR" :size="15" :sw="1.7" />
  </button>

  <!-- 设置齿轮：始终贴窗口最右上角、与红绿灯同一条 38px 高度线（应用级入口） -->
  <button
    class="st-nav__btn st-nav__gear"
    type="button"
    title="设置"
    aria-label="设置"
    :aria-expanded="appChrome.settingsOpen"
    :class="{ 'is-open': appChrome.settingsOpen }"
    @click="onGear"
  >
    <AppIcon name="gear" :size="15" :sw="1.7" />
  </button>
</template>

<style scoped>
/* 空顶条：fixed 横贯窗口顶部 38px，与内容同底（--do-bg，Electron 顶栏要求同底色）。
   无底边发丝——与下方 Home|Memory|Todo 模块条直接同底相接（用户：去掉 Home 上方分割线）。 */
.st-nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  z-index: 55;
  background: var(--do-bg);
  -webkit-user-select: none;
  user-select: none;
}
.st-nav__btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  font: inherit;
  line-height: 1;
  color: rgba(255, 255, 255, 0.54);
  cursor: pointer;
  transition: color 0.18s ease;
}
.st-nav__btn:hover {
  color: rgba(255, 255, 255, 0.94);
}
.st-nav__btn.is-open {
  color: rgba(255, 255, 255, 0.94);
}
/* 收起/展开侧栏：与红绿灯同一条 38px 线，贴在灯组右侧（x84 起）；
   原生全屏时灯组消失，加 .is-fs 贴回左缘，不再空出一截（见下）。 */
.st-nav__btn.st-nav__side {
  position: fixed;
  top: 0;
  left: 84px;
  height: 38px;
  padding: 0 8px;
  z-index: 55;
  transition: left 0.18s ease, color 0.18s ease;
}
/* 系统原生全屏（appChrome.isFullscreen）：红绿灯整个隐藏，不需要再给灯组让位。
   left:16px + 内 padding 8 让图标左缘距窗口 ≈24px，与右上齿轮的右距视觉对称。 */
.st-nav__btn.st-nav__side.is-fs {
  left: 16px;
}
/* 设置齿轮：窗口最右上角、与红绿灯同一条 38px 高度线，fixed 悬浮在条右端 */
.st-nav__btn.st-nav__gear {
  position: fixed;
  top: 0;
  right: 16px;
  height: 38px;
  padding: 0 8px;
  z-index: 55;
}
@media (max-width: 959px) {
  .st-nav,
  .st-nav__btn {
    display: none;
  }
}
</style>
