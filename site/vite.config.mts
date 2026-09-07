// 裸 Vite + Vue 单页壳配置：应用代码由旧 VitePress 主题目录迁来（现全部在 ui/）。
// base 仍是 /dooit/、/api 全部代理到常驻 AI 本地服务 —— 网络约定与旧站一致。
// dev 端口与 AI 端口都可用环境变量换掉（VITE_PORT / AI_PORT），方便并行跑沙盒实例。
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 常驻 AI 本地服务（server/index.mjs）的端口，与 npm run ai / npm run local 保持一致
const devPort = Number(process.env.VITE_PORT) || 5173;
const aiPort = Number(process.env.AI_PORT) || 9765;
const aiTarget = `http://127.0.0.1:${aiPort}`;

// dev 时把所有 /api/* 转发给常驻服务；服务没启动时打印一行提示，不阻塞页面
const aiGateway = {
  name: "dooit-ai-gateway",
  configureServer() {
    setTimeout(() => {
      fetch(`${aiTarget}/healthz`)
        .then((r) => (r.ok ? true : Promise.reject(new Error(String(r.status)))))
        .catch(() => {
          console.log(
            `\n[ClutterCut] 提示：AI 本地服务未运行（${aiTarget}），聊天/记忆不可用。\n` +
              `  请另开终端运行：npm run ai   （或在 site/ 下用一条命令起全部：npm run local）\n`,
          );
        });
    }, 1200);
  },
};

export default defineConfig({
  base: "/dooit/",
  plugins: [vue(), aiGateway],
  server: {
    port: devPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: aiTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
