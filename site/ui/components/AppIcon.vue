<script setup lang="ts">
// 全站 lucide 线性图标字典：同一种 24×24 描边图标别再在每个组件里手写一份内联 svg，
// 需要时用 <AppIcon name="…" :size="…" :sw="…" class="…"/>（class 透传到根 svg 上）。
// 要新图标就把 lucide 的节点（path/circle/rect/line + 属性）原样加进 ICONS；描边参数
// （fill 无、stroke=currentColor、线帽线接 round）统一由本组件根元素提供，不要各写各的。
import { computed } from "vue";

interface IconNode {
  el: "path" | "circle" | "rect" | "line";
  a: Record<string, string | number>;
}

const props = withDefaults(defineProps<{ name: string; size?: number; sw?: number }>(), {
  size: 14,
  sw: 2,
});

const ICONS: Record<string, IconNode[]> = {
  // 发消息 / 新对话的 +
  send: [
    { el: "path", a: { d: "M12 19V5" } },
    { el: "path", a: { d: "m5 12 7-7 7 7" } },
  ],
  plus: [
    { el: "path", a: { d: "M5 12h14" } },
    { el: "path", a: { d: "M12 5v14" } },
  ],
  // 关闭 / 清除（叉）
  close: [{ el: "path", a: { d: "M18 6 6 18M6 6l12 12" } }],
  // 删除（trash / trash-2 两个版本都保留，别替换成同一个）
  trash: [
    { el: "path", a: { d: "M3 6h18" } },
    { el: "path", a: { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" } },
    { el: "path", a: { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" } },
  ],
  trash2: [
    { el: "path", a: { d: "M3 6h18" } },
    { el: "path", a: { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" } },
    { el: "path", a: { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" } },
    { el: "line", a: { x1: 10, x2: 10, y1: 11, y2: 17 } },
    { el: "line", a: { x1: 14, x2: 14, y1: 11, y2: 17 } },
  ],
  // 行内编辑（铅笔）
  edit: [
    { el: "path", a: { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" } },
  ],
  search: [
    { el: "circle", a: { cx: 11, cy: 11, r: 7 } },
    { el: "path", a: { d: "m20 20-3.5-3.5" } },
  ],
  // 串联 / 链接
  link: [
    { el: "path", a: { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" } },
    { el: "path", a: { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" } },
  ],
  // 行尾溢出菜单：竖排三点（Hermes kebab-vertical）
  ellipsisV: [
    { el: "circle", a: { cx: 12, cy: 5, r: 1 } },
    { el: "circle", a: { cx: 12, cy: 12, r: 1 } },
    { el: "circle", a: { cx: 12, cy: 19, r: 1 } },
  ],
  // 置顶 / 图钉
  pin: [
    { el: "path", a: { d: "M12 17v5" } },
    {
      el: "path",
      a: {
        d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z",
      },
    },
  ],
  // 已完成的对勾
  check: [{ el: "path", a: { d: "M20 6 9 17l-5-5" } }],
  // 恢复为未完成（逆时针循环箭头）
  restore: [
    { el: "path", a: { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" } },
    { el: "path", a: { d: "M3 3v5h5" } },
  ],
  // 收起/展开区块（向下箭头，展开态靠 CSS 旋转）
  chevronDown: [{ el: "path", a: { d: "m6 9 6 6 6-6" } }],
  // API Key
  key: [
    { el: "circle", a: { cx: 7.5, cy: 15.5, r: 5.5 } },
    { el: "path", a: { d: "m21 2-9.6 9.6" } },
    { el: "path", a: { d: "m15.5 7.5 3 3L22 7l-3-3" } },
  ],
  // 警告三角
  alert: [
    { el: "path", a: { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" } },
    { el: "path", a: { d: "M12 9v4" } },
    { el: "path", a: { d: "M12 17h.01" } },
  ],
  // 说明 / 提示
  info: [
    { el: "circle", a: { cx: 12, cy: 12, r: 10 } },
    { el: "path", a: { d: "M12 16v-4" } },
    { el: "path", a: { d: "M12 8h.01" } },
  ],
  // 设置齿轮
  gear: [
    { el: "path", a: { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" } },
    { el: "circle", a: { cx: 12, cy: 12, r: 3 } },
  ],
  // 收起侧边栏（面板-左，箭头朝左）
  panelL: [
    { el: "rect", a: { width: 18, height: 18, x: 3, y: 3, rx: 2 } },
    { el: "path", a: { d: "M9 3v18" } },
    { el: "path", a: { d: "m14 9-3 3 3 3" } },
  ],
  // 展开侧边栏（面板-左，箭头朝右）
  panelR: [
    { el: "rect", a: { width: 18, height: 18, x: 3, y: 3, rx: 2 } },
    { el: "path", a: { d: "M9 3v18" } },
    { el: "path", a: { d: "m10 9 3 3-3 3" } },
  ],
};

const nodes = computed(() => ICONS[props.name] ?? []);
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="sw"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <component :is="n.el" v-for="(n, i) in nodes" :key="i" v-bind="n.a" />
  </svg>
</template>
