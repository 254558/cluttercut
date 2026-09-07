// 顶条（SectionTabs）与各板块共享的“应用级 chrome”状态。
// 单窗口应用 = 三个真实板块：Home（聊天会话）· Memory（记忆板块）· Todo（待办清单），
// 由栏头 ModuleRailTabs 切换；左侧会话栏与「设置」面板的 DOM 都在聊天壳（DeepSeekDocChat）
// 里，顶条按钮、栏头 tab 与组件只通过这里的状态互相通信，避免 provide/inject、
// 事件总线或 DOM 事件互相找组件。
import { reactive } from "vue";

const LS_SIDEBAR = "dooit-chat-sidebar-hidden";
const LS_VIEW = "dooit-app-view";

export type AppView = "chat" | "memory" | "todo";

function loadSidebarHidden() {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(LS_SIDEBAR) === "1";
  } catch {
    return false;
  }
}

function loadView(): AppView {
  if (typeof window === "undefined") return "chat";
  try {
    const v = localStorage.getItem(LS_VIEW);
    return v === "memory" || v === "todo" ? v : "chat";
  } catch {
    return "chat";
  }
}

export const appChrome = reactive({
  // 左侧栏是否收起（顶条左侧按钮 + 会话栏共用）
  sidebarHidden: loadSidebarHidden(),
  // 右上「设置」面板是否展开（顶条齿轮 + 主区共用；切板块会自动收掉）
  settingsOpen: false,
  // 当前板块：栏头 Home/Memory/Todo 切换，跨会话记忆上次所在
  view: loadView(),
  // 是否处于系统原生全屏：macOS 全屏时顶栏红绿灯消失、内容铺满整块屏幕。
  // SectionTabs 据此把「收起侧栏」钮从灯组右侧挪到左缘，避免左侧空出一截。
  isFullscreen: false,
});

export function toggleSidebar() {
  appChrome.sidebarHidden = !appChrome.sidebarHidden;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(LS_SIDEBAR, appChrome.sidebarHidden ? "1" : "0");
    } catch {
      /* 忽略 */
    }
  }
}

/** 切板块（Home 聊天 / Memory 记忆 / Todo 待办）；点板块一律先收掉设置面板，
 * 让主区直接落到目标页（即使已在该板块，也视为“回到页面”而非停在设置）。 */
export function goView(v: AppView) {
  const changed = appChrome.view !== v;
  appChrome.view = v;
  appChrome.settingsOpen = false;
  if (changed && typeof window !== "undefined") {
    try {
      localStorage.setItem(LS_VIEW, v);
    } catch {
      /* 忽略 */
    }
  }
}

export function openSettings() {
  appChrome.settingsOpen = true;
}

export function closeSettings() {
  appChrome.settingsOpen = false;
}

/* ---------- 原生全屏检测 ---------- */

// macOS 原生全屏把窗口铺满整块屏幕（inner 尺寸 == screen 尺寸）；窗口化时窗口
// 最高也只能到菜单栏之下，innerHeight 必然小于 screen.height —— 用这个尺寸差即可
// 判定，Electron 里靠 DOM resize 事件驱动（进/出全屏都会触发一次 resize）。
function detectNativeFullscreen(): boolean {
  if (typeof window === "undefined" || typeof window.screen === "undefined") return false;
  const s = window.screen;
  if (window.innerWidth >= s.width - 1 && window.innerHeight >= s.height - 1) return true;
  try {
    return window.matchMedia("(display-mode: fullscreen)").matches;
  } catch {
    return false;
  }
}

/** 把当前窗口是否处于原生全屏同步进 appChrome.isFullscreen（供顶条等订阅） */
export function syncFullscreen() {
  appChrome.isFullscreen = detectNativeFullscreen();
}

/* ---------- Electron 原生全屏桥 ---------- */

// 主进程（electron/main.js）在 enter/leave-full-screen 时经 preload（preload.cjs）推送
// 真实全屏态。渲染层只有尺寸推断（detectNativeFullscreen），个别 Electron 全屏过渡会漏，
// 双保险：桥存在就用桥，纯浏览器里没有桥则维持 resize 推断。
type NativeFsBridge = { onFullscreen: (cb: (v: boolean) => void) => () => void };
declare global {
  interface Window {
    nativeWindow?: { onFullscreen?: NativeFsBridge["onFullscreen"] };
  }
}

/** 订阅主进程推送的原生全屏态；无桥（浏览器）时返回 undefined。返回解绑函数 */
export function bindNativeFullscreen(): (() => void) | undefined {
  if (typeof window === "undefined") return undefined;
  const on = window.nativeWindow?.onFullscreen;
  if (!on) return undefined;
  return on((v) => {
    appChrome.isFullscreen = v;
  });
}
