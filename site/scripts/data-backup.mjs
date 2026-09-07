#!/usr/bin/env node
// ClutterCut 个人数据 备份 / 恢复 工具（原名 dooit）
//
// 用法(在 site/ 下,或任意位置用绝对路径):
//   node scripts/data-backup.mjs backup [--out 目录]     # 默认 ~/ClutterCut-backups/
//   node scripts/data-backup.mjs restore <备份文件.zip>
//   node scripts/data-backup.mjs list   <备份文件.zip>   # 只看包内清单
//
// 备份内容(全部是本机数据,不包含代码/主题/配置模板):
//   对话记录     ai-chat.db             (SQLite,整份会话)
//   长期记忆     ai-memory.json + ai-memory-archive.json (逐条记忆与整理归档)
//   用户画像     ai-profile.json        (由记忆合成的综合画像快照;可随时重生成)
//   待办清单     ai-todo.json           (Todo 板块,手动维护)
//   API Key     deepseek-key.txt        (重新部署时免重配;介意可不含,
//                                        手工删 zip 内该文件即可)
// 个人数据文件清单与数据目录的单一来源是 server/core/paths.mjs(DATA_FILES / DATA_DIR):
// 数据目录默认 site/data,设置 DOOIT_DATA_DIR 时以它为准——打包应用的数据在 userData 下,
// 备份/恢复必须落到同一处,不能用脚本所在目录猜。
//
// 恢复会先检查本地服务是否在运行(必须在停止状态才能覆盖写文件),
// 之后把上述数据整体替换回数据目录对应位置。恢复完重启桌面版即可。
// 兼容:更早的备份包把条目放在 zip 内 data/.vitepress/ 下,恢复时自动识别。
// 环境变量:
//   DOOIT_DATA_DIR          数据目录(与 server 端同名变量一致;不设默认 site/data)
//   DOOIT_BACKUP_DIR        备份默认输出目录(等价 --out)
//   DOOIT_RESTORE_SKIP_CHECK=1  恢复时跳过“服务是否在跑”检查(仅测试用)

import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, copyFileSync,
  readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR as DATA, DATA_FILES as FILES } from "../server/core/paths.mjs";

const HELP = `用法:
  node scripts/data-backup.mjs backup [--out 目录]
  node scripts/data-backup.mjs restore <备份文件.zip>
  node scripts/data-backup.mjs list   <备份文件.zip>`;

// 目录型条目为空(旧模块目录已下线);文件型条目见 paths.mjs 的 DATA_FILES
const DIRS = [];

const abs = (rel) => path.join(DATA, rel);
const outDirDefault = () =>
  process.env.DOOIT_BACKUP_DIR || path.join(os.homedir(), "ClutterCut-backups");

/* ---------- 工具 ---------- */

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function countJsonArray(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
  } catch {
    return 0;
  }
}

/* ---------- SQLite 一致性快照 ---------- */

async function snapshotDb(dbFile, outFile) {
  // 服务运行时直接拷贝 db 可能拿到半截状态;优先用 VACUUM INTO 拿一致性副本,
  // 失败(例如库被占用)则退回普通拷贝。
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 8000");
    db.exec(`VACUUM INTO ${JSON.stringify(outFile)}`);
    db.close();
    return "snapshot";
  } catch {
    try {
      copyFileSync(dbFile, outFile);
    } catch {}
    return "copy";
  }
}

/* ---------- 备份 ---------- */

async function doBackup(outDir) {
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `cluttercut-backup-${ts()}.zip`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cluttercut-bak-"));
  const dataDir = path.join(tmp, "data");

  // 1) 拷贝各数据文件(对话库走一致性快照)
  for (const rel of FILES) {
    const src = abs(rel);
    if (!existsSync(src)) continue;
    const dst = path.join(dataDir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    if (rel === "ai-chat.db") await snapshotDb(src, dst);
    else copyFileSync(src, dst);
  }
  // 2) 拷贝数据目录
  for (const rel of DIRS) {
    if (!existsSync(abs(rel))) continue;
    cpSync(abs(rel), path.join(dataDir, rel), { recursive: true });
  }

  // 3) 清单(含条数,方便恢复前预览)。kind 标 cluttercut-data-backup;
  // 恢复端同时认旧档的 dooit-data-backup(见 doRestore),别只改成新名丢兼容。
  const manifest = {
    kind: "cluttercut-data-backup",
    createdAt: new Date().toISOString(),
    sourceDataDir: DATA, // 数据目录绝对路径(DOOIT_DATA_DIR 已尊重)
    counts: {
      chatDb: existsSync(abs("ai-chat.db")) ? "included" : "none",
      memory: countJsonArray(abs("ai-memory.json")),
      memoryArchive: existsSync(abs("ai-memory-archive.json")) ? 1 : 0,
      todo: countJsonArray(abs("ai-todo.json")),
    },
  };
  writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));

  const totalFiles = FILES.filter((f) => existsSync(abs(f))).length +
    DIRS.filter((d) => existsSync(abs(d))).length;
  if (totalFiles === 0) console.error("警告:当前没发现任何个人数据,备份包基本是空的。");

  execFileSync("/usr/bin/zip", ["-r", "-q", outFile, "manifest.json", "data"], {
    cwd: tmp,
    stdio: "inherit",
  });
  rmSync(tmp, { recursive: true, force: true });
  return { outFile, manifest };
}

/* ---------- 恢复 ---------- */

function serviceRunningName() {
  if (process.env.DOOIT_RESTORE_SKIP_CHECK === "1") return null;
  const targets = [
    ["http://127.0.0.1:9765/healthz", "AI 服务"],
    ["http://localhost:5173/dooit/", "网页服务"],
  ];
  for (const [url, name] of targets) {
    try {
      const r = execFileSync("curl", ["-sf", "-m", "1", url], { stdio: "pipe" });
      if (r) return name;
    } catch {}
  }
  return null;
}

// 备份包内取条目:新版条目在 data/ 顶层;更早的备份包把条目放在 data/.vitepress/ 下,自动兼容。
function backupEntry(dataDir, rel) {
  const cur = path.join(dataDir, rel);
  if (existsSync(cur)) return cur;
  const legacy = path.join(dataDir, ".vitepress", rel);
  return existsSync(legacy) ? legacy : null;
}

function doRestore(zipFile) {
  if (!existsSync(zipFile)) {
    console.error(`找不到备份文件: ${zipFile}`);
    process.exit(1);
  }
  const running = serviceRunningName();
  if (running) {
    console.error(`检测到 ${running} 正在运行。请先退出桌面版 / 停止本地服务,再执行恢复。`);
    process.exit(1);
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "cluttercut-rst-"));
  try {
    execFileSync("/usr/bin/unzip", ["-q", zipFile, "-d", tmp], { stdio: "pipe" });
  } catch {
    console.error("这不是一个有效的 ClutterCut 备份文件(无法解压)。");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(path.join(tmp, "manifest.json"), "utf8"));
    if (!["cluttercut-data-backup", "dooit-data-backup"].includes(manifest.kind))
      throw new Error("kind mismatch");
  } catch {
    console.error("这不是一个有效的 ClutterCut 备份文件(缺少/损坏 manifest.json)。");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  const dataDir = path.join(tmp, "data");
  let replaced = 0;

  // 目录型条目:整体替换(先清空旧的个人数据,再放回备份版本)
  for (const rel of DIRS) {
    const src = backupEntry(dataDir, rel);
    if (!src) continue;
    rmSync(abs(rel), { recursive: true, force: true });
    cpSync(src, abs(rel), { recursive: true });
    replaced += 1;
  }
  // 文件型条目:覆盖
  for (const rel of FILES) {
    const src = backupEntry(dataDir, rel);
    if (!src) continue;
    const dst = abs(rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    replaced += 1;
  }
  rmSync(tmp, { recursive: true, force: true });

  const c = manifest.counts ?? {};
  console.log(`恢复完成,来自备份: ${path.basename(zipFile)}`);
  console.log(`  覆盖条目: ${replaced} 个`);
  console.log(`  对话库: ${c.chatDb ?? "?"}  长期记忆: ${c.memory ?? 0} 条  待办: ${c.todo ?? 0} 条`);
  console.log(`数据已恢复到: ${DATA}`);
  console.log("现在启动桌面版(或 npm run local)即可。");
}

/* ---------- list ---------- */

function doList(zipFile) {
  if (!existsSync(zipFile)) {
    console.error(`找不到备份文件: ${zipFile}`);
    process.exit(1);
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cluttercut-lst-"));
  try {
    execFileSync("/usr/bin/unzip", ["-q", zipFile, "-d", tmp], { stdio: "pipe" });
  } catch {
    console.error("这不是一个有效的 ClutterCut 备份文件(无法解压)。");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(path.join(tmp, "manifest.json"), "utf8"));
  } catch {}
  // list 兼做“上传前验证器”（应用内恢复流程先 list 再暂存）：不是可认备份就报错退出，
  // 别把一坨不认识的文件暂存起来、等下次启动才发现。判断口径与 doRestore 一致。
  if (!["cluttercut-data-backup", "dooit-data-backup"].includes(manifest.kind)) {
    console.error("这不是一个有效的 ClutterCut 备份文件(缺少/损坏 manifest.json)。");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  const files = [];
  const dataDir = path.join(tmp, "data");
  const walkRel = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walkRel(p);
      else files.push(path.relative(dataDir, p));
    }
  };
  walkRel(dataDir);
  console.log(`备份创建于: ${manifest.createdAt ?? "?"}`);
  console.log(`来源数据目录: ${manifest.sourceDataDir ?? "?"}`);
  console.log(`清单:       ${JSON.stringify(manifest.counts ?? {})}`);
  console.log(`包内文件(${files.length}):`);
  for (const f of files.sort()) console.log("  " + f);
  rmSync(tmp, { recursive: true, force: true });
}

/* ---------- main ---------- */

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "backup") {
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : outDirDefault();
  const { outFile, manifest } = await doBackup(outDir);
  console.log(JSON.stringify({ ok: true, outFile, manifest }, null, 2));
} else if (cmd === "restore") {
  const zipFile = args.find((a) => !a.startsWith("-") && a !== "restore");
  if (!zipFile) {
    console.error(HELP);
    process.exit(1);
  }
  doRestore(zipFile);
} else if (cmd === "list") {
  const zipFile = args.find((a) => !a.startsWith("-") && a !== "list");
  if (!zipFile) {
    console.error(HELP);
    process.exit(1);
  }
  doList(zipFile);
} else {
  console.error(HELP);
  process.exit(1);
}
