# ClutterCut

本地优先的**单窗口 AI 助手**：一个窗口里同时给你会话聊天、长期记忆和待办清单。名字取「修剪杂念」——日常琐事丢给它记，回答越来越贴你。

- **Home**：和 AI 聊天（SSE 流式）。每问自动带上当前本地时间，凡涉「今天 / 现在 / 几点」都按真实系统时钟答。
- **Memory**：AI 对「你是谁」的长期记忆。聊完的稳定事实被自动逐条提取入库，多轮对话结束后还会做一次整段消化沉淀跨轮进展；定期合成一张「用户画像」随对话恒定注入，让回答越来越贴。
- **Todo**：手动维护的待办清单。AI 每轮只读注入未完成事项给建议，从不写入。

界面是裸 Vite + Vue 的 Hermes 风单页；AI 由**常驻本地的纯 Node 服务**（`site/server/`）提供，调用 DeepSeek。数据全部只存本机，会话整档存 SQLite，刷新、重启、跨页往返不丢。

## 快速开始

```bash
cd site
npm install

# 1) 放 DeepSeek API Key（二选一）
export DEEPSEEK_API_KEY=sk-...                  # A：环境变量
echo 'sk-...' > data/deepseek-key.txt          # B：本地密钥文件（已 gitignore）

# 2) 一条命令同时起 Vite dev + AI 本地服务（Ctrl-C 一起退）
npm run local
```

打开 <http://localhost:5173/dooit/> 即可。AI 服务只绑 `127.0.0.1:9765`；只跑 `npm run dev` 界面可用但聊天/记忆不可用。环境要求 Node ≥ 22.5（内置 `node:sqlite`），不用 bun（以 `package-lock.json` 为准）。

## 页面与板块

| 板块 | 位置 | 说明 |
| --- | --- | --- |
| Home 会话 | 栏头 Home | 左侧会话列表 + 右侧聊天流。新建 / 切换 / 删除 / 置顶会话、SSE 流式回答、相关记忆注入 |
| Memory | 栏头 Memory | AI 长期记忆板块：画像卡（可重绘）/ 按方面筛选 / 语义检索 / 逐条增删改查（含手动纠错，改后置为最新并触发画像重绘）/ 逐条「串联」相近记忆 / 给旧记忆补标签 / 压缩整理 |
| Todo | 栏头 Todo | 手动待办清单（新增 / 勾选 / 行内改文 / 删除 / 清空已完成）；AI 只读注入未完成项、从不写入 |
| 设置 | 顶条齿轮 | DeepSeek Key（状态 / 保存 / 清除）、一键备份、从备份 zip 恢复 |

## 架构

```
浏览器 (Vite dev /dooit/ —— 裸 Vue 单页 site/ui)
   │  聊天(SSE 流式) · 记忆板块 · 待办板块 · 备份/恢复 · Key 设置
   ▼
site/server/   ← 常驻本地 Node 服务 (127.0.0.1:9765, /api/* 由 vite 代理)
   │  调 DeepSeek API（key 只存在于服务端）
   ▼
site/data/ 或 $DOOIT_DATA_DIR（个人数据，唯一读写位置）
```

- **AI 聊天**：`deepseek-chat`，SSE 流式。发送前先注入当前本地时间，再注入语义召回的相关记忆 + 用户画像 + 未完成待办（≤15 条）作为上下文。
- **记忆链路两条**：逐轮提取（每轮落定后服务端静默提取「关于你的稳定事实」逐条入长期记忆）+ 整段消化（离开一段多轮对话时把最近 ≤60 轮一次性消化，UI 记账防重复）。记忆较多时服务端自动后台压缩整理（4 小时冷却、静默失败，不阻塞聊天）；存储上限 1 万条，只作宽松兜底。
- **方面软标签**：每条记忆 1–3 个方面词（9 词白名单：身份背景 / 技能工具 / 工作项目 / 目标计划 / 偏好习惯 / 性格风格 / 雷区注意 / 家庭人际 / 健康时间）。不参与相似度计算，只用于召回方面覆盖兜底、串联同方面优先、板块按方面筛选。
- **语义召回**：本地 bge-small-zh 向量化（`@huggingface/transformers`）+ SQLite 旁路索引 + 余弦 top-k（相关度门槛 / 新鲜度小加成 / 同义去重 / 话题簇限流 / 方面覆盖兜底）。
- **会话存储**：整份会话文档 `{active, convos:[…]}` 走 SQLite kv 表；多会话删除记 30 天墓碑，多窗口旧快照不会把已删会话写回来。
- **桌面版**：Electron 壳。dev 模式起本地整套并开窗；packaged 模式不依赖 Vite——主进程内嵌 node:http 静态宿主 + 反代 AI 子进程，前端零改动同一份站。

## 数据与隐私

统一在 `site/data/`（AI 服务只读写这几处；路径锚点集中在 `server/core/paths.mjs`）。全部 gitignore，绝不提交：

| 文件 | 内容 |
| --- | --- |
| `deepseek-key.txt` | DeepSeek API Key（环境变量 `DEEPSEEK_API_KEY` 优先） |
| `ai-chat.db*` (+wal/shm) | 会话记录 SQLite |
| `ai-memory.json` | 长期记忆（逐条事实/偏好/性格，带方面标签） |
| `ai-memory-vec.db*` | 记忆本地向量索引旁路 |
| `ai-memory-archive.json` | 压缩整理前被替换/合并的旧记忆原文归档 |
| `ai-profile.json` | 由全部记忆定期合成的「用户画像快照」 |
| `ai-todo.json` | 待办清单（Todo 板块手动维护，AI 只读） |

- 密钥只存在于服务端进程，浏览器端不落 key。
- 除发给 DeepSeek 的对话/上下文请求外，没有任何东西上传；向量化与检索都在本机完成。
- `data/deepseek-key.txt` 及全部个人数据文件已 gitignore；可用 `$DOOIT_DATA_DIR` 把数据目录挪到任意位置（沙盒/测试隔离）。
- 兼容性说明：仓库路径 `base /dooit/`、历史沿用下来的 `doc-copilot-*` / `dooit-*` 存储键与 `ai-*.json` 文件名保持原名不动，以便兼容既有本地数据。

## 命令与环境变量

（在 `site/` 下执行）

| 命令 | 作用 |
| --- | --- |
| `npm run local` | Vite dev + AI 服务一起起 |
| `npm run dev` | 只起前端 dev（5173，/api 代理到 AI） |
| `npm run ai` | 只起 AI 常驻服务（9765） |
| `npm run build` / `preview` | 构建 / 预览产物（`site/dist`） |
| `npm run electron` | 桌面壳（自动拉起 local 整套并开窗） |
| `npm run electron:build` | `vite build` 后 electron-builder 打包（macOS：`release/mac-arm64/ClutterCut.app`） |

环境变量：`AI_PORT`（9765）/ `VITE_PORT`（5173，改端口需同时传给 AI 与 vite 代理）、`DEEPSEEK_API_KEY`（优先于密钥文件）、`DOOIT_DATA_DIR`（数据目录覆盖，测试隔离用）、`DOOIT_NO_VECTOR_WARM`（跳过向量模型预热，免首启联网下模型）。

## 目录结构

```
site/
├── index.html                  # 入口 HTML
├── vite.config.mts             # base /dooit/、端口、/api 代理
├── ui/                         # 前端（裸 Vite + Vue 单页壳）
│   ├── main.ts                 # 装配：CSS + 顶条 + 应用壳
│   ├── components/             # 顶条 / 会话与聊天 / Memory 板 / Todo 板 / 设置 / 欢迎字标
│   ├── core/                   # api 层 · 会话持久化 · 记忆状态 · 板块切换 · markdown 渲染
│   ├── effects/                # 欢迎字标特效与数据
│   └── styles/                 # theme.css（设计令牌 + 全站呈现）+ boards.css（两板共享）+ fonts/
├── public/                     # 静态资源 + 欢迎字标引擎（ttfx.wasm）
├── server/                     # AI 本地服务（index.mjs 入口 + 路由表；handlers/ + core/）
├── data/                       # 个人数据（gitignore，运行时生成）
├── electron/main.js            # 桌面壳 dev/packaged 双模式
├── electron/preload.cjs        # contextBridge 原生桥
├── scripts/                    # local.mjs（一键起栈）+ data-backup.mjs（备份）
└── package.json
```

详细的服务接口与数据契约见 [`site/server/README.md`](site/server/README.md)。

## License

MIT，见 [LICENSE](LICENSE)。
