// 裸 Vue 壳入口：装配 38px 顶栏（SectionTabs）与聊天工作区（DeepSeekDocChat）。
// CSS 按级联顺序加载：styles/tui-base.css（vendored 基础）→ styles/theme.css
// （lucide 图标 → vercel → hermes → bare-shell 按序拼接，见文件头注释）
// → styles/boards.css（Memory/Todo 两板块共享层，颜色全走 --do-* 令牌）。
// <html> 上的 dark tui-theme-default 已由 index.html 静态写好（深色首帧不闪白）；
// 令牌层写在 :root + html.dark，类缺省时仍可读色。
import { createApp, h } from "vue";
import "./styles/tui-base.css";
import "./styles/theme.css";
import "./styles/boards.css";
import SectionTabs from "./components/SectionTabs.vue";
import DeepSeekDocChat from "./components/DeepSeekDocChat.vue";

// 防御性兜底：确保 dark tui-theme-default 状态类存在（哪怕未来有人删掉 index.html 里的静态类）
if (typeof document !== "undefined") {
  const el = document.documentElement;
  el.classList.add("dark", "tui-theme-default");
}

createApp({
  // 两条平铺根节点：SectionTabs = 38px 顶条（fixed），DeepSeekDocChat = 聊天工作区
  // （原 AppWorkspace.vue 只是 DeepSeekDocChat 的透传壳，已并入这里）
  render: () => [h(SectionTabs), h(DeepSeekDocChat)],
}).mount("#app");
