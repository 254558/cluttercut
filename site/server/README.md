# ClutterCut 本地助手服务（site/server/）（原名 dooit）

把长在 Vite dev server 里的 AI 后端拆成的**独立常驻进程**：
DeepSeek 聊天（SSE 流式）、长期记忆（自动沉淀/语义召回/管理）、待办清单与
对话存储/密钥/备份都由这个服务提供；前端是裸 Vite + Vue 单页（`site/ui/`），
只负责展示，dev 时把 `/api/*` 代理过来。前端是三个板块的单窗口：
Home 会话 / Memory 记忆板块 / Todo 待办板块（栏头切换）。

聊天前按问题从长期记忆做语义召回（本机向量，见 `core/mem-recall.mjs`：
相关度门槛 + 新鲜度小加成 + 同义去重 + 话题簇限流 + 方面覆盖兜底，把名额铺向不同侧面）注入上下文，
并恒定注入一份由全部记忆定期合成的「用户画像快照」（见 `core/profile-card.mjs`）。
每轮还会只读注入**未完成待办**（≤15 条，见 `handlers/chat.mjs`），让 AI 对齐
「你接下来要做什么」给建议；待办由用户在 Todo 板块手动维护，AI 从不写入。
记忆攒到较多（≥500 条）时自动后台压缩整理一次（存储上限已放宽到 1 万条，原 100；见 `core/memory-tidy.mjs`，
4 小时冷却、静默失败，不阻塞聊天）。设置页只剩 DeepSeek Key 与备份；
记忆的增删改查/检索/画像/压缩整理 UI 都在 Memory 板块（走后端 `/api/memory`）。

每条记忆还带 **1–3 个「方面」软标签**（固定 9 个词的白名单：身份背景/技能工具/工作项目/
目标计划/偏好习惯/性格风格/雷区注意/家庭人际/健康时间），由 AI 在提取/手动增改/补标签时
全自动维护、用户零负担。标签**不参与相似度计算**，只用来做三件事：召回时给整轮漏掉的
方面补代表条目（不偏科）、「串联」难分伯仲时同方面优先、Memory 板块按方面筛选/浏览。

## 怎么跑

```bash
cd site

# 单独起 AI 服务（常驻；端口 127.0.0.1:9765）
npm run ai

# 或者一条命令同时起 AI 服务 + 前端 dev server（Ctrl-C 一起退）
npm run local
```

- 需要 **Node ≥ 22.5**（对话存储用内置 `node:sqlite`）。目录按用途组织：
  `index.mjs`（HTTP 入口，路由表内联于此）→ `handlers/` 各域模块
  （`chat` / `memory` / `todo` / `store` / `keys` / `backup`），共享基础设施在 `core/`
  （`util` HTTP 工具、`deepseek` 客户端、`paths` 数据锚点、`memory-store`、
  `todo-store`、`mem-recall` 语义召回、`profile-card` 画像、`memory-tidy` 压缩整理）；
  每个数据文件有唯一属主模块
  （`store`→`ai-chat.db`、`memory-store`→`ai-memory.json`、
  `memory-tidy`→`ai-memory-archive.json`、`profile-card`→`ai-profile.json`、
  `mem-recall`→`ai-memory-vec.db`（向量旁路索引）、`todo-store`→`ai-todo.json`、
  `keys`→`deepseek-key.txt`）。
- 只跑 `npm run dev` 也能打开界面，但聊天/记忆/待办不可用（启动时终端会打印提示）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_PORT` | `9765` | 监听端口（只绑 127.0.0.1）。改端口时 `AI_PORT` 要同时传给服务和前端 dev（`vite.config.mts` 里代理目标同读这个变量） |
| `DEEPSEEK_API_KEY` | 空 | 设置后优先于本地密钥文件 |
| `DOOIT_DATA_DIR` | `site/data/` | 覆盖数据目录（测试/沙盒隔离用；缺省行为不变） |

## 数据文件（都不入库，已 gitignore）

数据统一放在 `site/data/`（原 `site/docs/.vitepress/` 整体更名而来，逐字节未动）：

- `site/data/ai-chat.db` —— 对话存储（SQLite）
- `site/data/ai-memory.json` —— 长期记忆（逐条事实/偏好/性格）
- `site/data/ai-memory-archive.json` —— 压缩整理时被替换/合并的旧记忆（归档留底）
- `site/data/ai-profile.json` —— 由全部记忆定期合成的「用户画像快照」（每次提问恒定注入）
- `site/data/ai-memory-vec.db` —— 记忆的本地向量旁路索引（供语义召回）
- `site/data/ai-todo.json` —— 待办清单（Todo 板块手动维护；AI 每轮只读注入未完成项）
- `site/data/deepseek-key.txt` —— DeepSeek API Key（本地密钥）

旧 Doc/今日 模块遗留的 `ai-tasks.json`、`ai-content/` 等仍保留在磁盘上作历史文件，
不再被任何代码读写。

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /healthz` | 健康检查 |
| `POST /api/chat` | DeepSeek 聊天，`stream:true` 时 SSE 流式透传；发送前恒定注入「用户画像快照」与未完成待办（只读），并按问题从长期记忆做语义召回注入（`remember:false` 或记忆暂停时记忆/画像不注入，待办仍注入） |
| `POST /api/remember` | 从一轮对话提取长期记忆（静默失败）；每条事实自动带 1–3 个「方面」标签（AI 打、用户零负担）；有新增且条数逼近上限时后台自动触发压缩整理 |
| `GET/POST /api/memory` | GET 列记忆；POST 动作：`delete`/`edit`（改文并同步重打方面标签、清该条旧向量）/`add`（手动新增，配了 key 时顺手打标签，去重）/`search {q}`（语义检索，向量不可用时降级文本，结果带 `s` 与 `facets`）/`related {id}`（与某条语义相近的记忆；同方面条目难分伯仲时优先）/`tag-missing`（给无方面标签的旧记忆批量补标，单飞锁、静默）/`refresh-profile`（force 重绘画像）/`compact`（先归档旧条目再合并重写；合并出的条目继承来源方面标签） |
| `GET /api/profile` | 读取用户画像卡（`{exists, card, at, fromCount}`，只读） |
| `GET/POST /api/todo` | 待办清单：GET 列清单；POST `add`/`toggle`/`edit`/`delete`/`clear-done`，全部返回最新 items |
| `GET/PUT/POST /api/store` | 整份会话读写（SQLite） |
| `GET /api/key/status` | 查询 DeepSeek Key 是否已配置：`{configured, source}`（source 为 `env`/`file`；密钥值本身不下发到浏览器） |
| `POST /api/key` | 页面内保存本地 DeepSeek Key（写 `deepseek-key.txt`；请求体 `key` 传空串 = 清除本地密钥） |
| `POST /api/backup` | 一键备份个人数据到桌面（调用 `site/scripts/data-backup.mjs`；上一次备份未结束会回 409） |

所有路由都带 `Access-Control-Allow-Origin: *`，未来独立的托盘/提醒应用可直接跨源调用。
