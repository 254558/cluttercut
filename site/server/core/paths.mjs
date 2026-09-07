// 路径锚点集中地：本文件位于 site/server/core/，数据文件统一放在站点数据目录
// （默认 site/data/；支持 DOOIT_DATA_DIR 环境变量整体改指别处，沙盒/测试/打包应用
// userData 都用它——不设置时行为与原来完全一致）。全项目（mem-recall / memory /
// store / backup 脚本）只从这里取路径与数据文件清单，避免各处重复写相对 URL。
// 已下线的旧 Doc/Today 模块数据（ai-content / ai-meta / ai-archive / ai-tasks.json）
// 不再被任何代码读写，路径也不保留。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function dataDirUrl() {
  const override = process.env.DOOIT_DATA_DIR;
  if (override) {
    const abs = path.resolve(override);
    const withSlash = abs.endsWith(path.sep) ? abs : abs + path.sep;
    return pathToFileURL(withSlash);
  }
  return new URL("../../data/", import.meta.url);
}

const DATA = dataDirUrl();
export const DATA_DIR = fileURLToPath(DATA); // 数据目录绝对路径（备份/恢复脚本用）

const MEMORY_FILE = new URL("ai-memory.json", DATA); // 长期记忆（个人信息，已 gitignore）
const KEY_FILE = new URL("deepseek-key.txt", DATA); // 本地密钥（已 gitignore）
const DB_FILE = new URL("ai-chat.db", DATA); // 对话记录 SQLite（已 gitignore）
const VEC_DB_FILE = new URL("ai-memory-vec.db", DATA); // 记忆向量旁路索引（已 gitignore）
const MEMORY_ARCHIVE_FILE = new URL("ai-memory-archive.json", DATA); // 记忆压缩整理前的原文快照（已 gitignore）
const PROFILE_FILE = new URL("ai-profile.json", DATA); // 从长期记忆合成的「用户画像快照」（已 gitignore）
const TODO_FILE = new URL("ai-todo.json", DATA); // 待办清单（个人信息，已 gitignore）
const BACKUP_SCRIPT = new URL("../../scripts/data-backup.mjs", import.meta.url); // site/scripts/data-backup.mjs

/** 「个人数据」文件相对清单（相对数据目录）：备份/恢复只碰这些，与 data-backup.mjs 共用一份 */
export const DATA_FILES = [
  "ai-chat.db",
  "ai-chat.db-wal",
  "ai-chat.db-shm",
  "ai-memory.json",
  "ai-memory-archive.json",
  "ai-profile.json",
  "ai-todo.json",
  "deepseek-key.txt",
];

export const toPath = (u) => fileURLToPath(u);
export {
  MEMORY_FILE,
  KEY_FILE,
  DB_FILE,
  VEC_DB_FILE,
  MEMORY_ARCHIVE_FILE,
  PROFILE_FILE,
  TODO_FILE,
  BACKUP_SCRIPT,
};
