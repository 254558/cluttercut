// ClutterCut preload 桥：contextIsolation 下把主进程的少量原生状态安全暴露给页面。
// 目前只推「macOS 原生全屏进出」（红绿灯随菜单栏消失/复现）——主进程 BrowserWindow 的
// enter/leave-full-screen 事件比渲染层"尺寸≈屏幕"的推断可靠，顶条收起侧栏钮据此归位。
// 页面侧订阅见 ui/core/app-chrome.ts 的 bindNativeFullscreen（浏览器环境无此桥，自动跳过）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nativeWindow", {
  onFullscreen(cb) {
    const handler = (_e, v) => cb(!!v);
    ipcRenderer.on("dooit-native-fullscreen", handler);
    return () => ipcRenderer.removeListener("dooit-native-fullscreen", handler);
  },
});
