// 桌面「恢复备份」：设置页选一个备份 zip 上传到这里，服务端先 list 校验（不落盘写数据）、
// 再把包暂存到数据目录旁（pending-restore.zip），随后以退出码 77 请求 Electron 主进程
// 重启应用；重启时 applyPendingRestore() 在「开库之前」把暂存包真正写回数据目录——
// 而不是在运行中的进程里直接覆盖 ai-chat.db 这类被 sqlite 打开的文件，避免活句柄写坏新库。
// 同一份 site/scripts/data-backup.mjs 仍是恢复/校验的唯一实现（restore 写回、list 校验）。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_SCRIPT, DATA_DIR } from "../core/paths.mjs";
import { methodGuard } from "../core/util.mjs";

/** AI 服务退出码：告知 Electron 主进程「恢复包已暂存，请重启应用」 */
const RESTART_CODE = 77;
const UPLOAD_MAX = 256 * 1e6; // 单包体积上限（备份一般几百 KB～几 MB，留足余量）

let restoreBusy = false; // 一次只处理一个上传

/** 待恢复包暂存路径：放数据目录旁（userData / site 下），跨重启仍在、不进备份清单 */
const pendingZip = () => path.join(path.dirname(DATA_DIR), "pending-restore.zip");

function cliEnv() {
  // packaged 里 process.execPath 是 Electron 本体：子进程必须带上
  // ELECTRON_RUN_AS_NODE 当纯 Node 跑备份 CLI（dev/纯 node 下该变量不存在，原样继承即可）
  const env = { ...process.env };
  if (process.env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [fileURLToPath(BACKUP_SCRIPT), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

/** 读原始上传字节（zip 是二进制，不能走按字符串拼的 readBody） */
function readUpload(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > UPLOAD_MAX) {
        req.destroy(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseListOut(out) {
  const createdAt = (out.match(/备份创建于:\s*(.+)$/m) || [])[1]?.trim() ?? null;
  let counts = null;
  const m = out.match(/清单:\s*(\{.*\})\s*$/m);
  if (m) {
    try {
      counts = JSON.parse(m[1]);
    } catch {
      /* 拿不到条数不影响恢复 */
    }
  }
  return { createdAt, counts };
}

/** POST /api/restore：body = 备份 zip 原样字节。校验通过→暂存→请求重启 */
async function handleRestore(req, res) {
  if (methodGuard(req, res, ["POST"])) return;
  if (restoreBusy) {
    res.statusCode = 409;
    res.end(JSON.stringify({ ok: false, error: "上一次恢复还在处理中，稍等几秒再试。" }));
    return;
  }
  restoreBusy = true;
  let tmp = null;
  let restartArmed = false; // 已暂存并请求重启：成功路径锁到进程退出，不再接新上传
  try {
    const buf = await readUpload(req);
    if (!buf.length) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "空的文件：请选择 ClutterCut 备份 zip。" }));
      return;
    }
    // 先落到临时文件再 list 校验（list 不解包写数据目录，只看 manifest）
    tmp = path.join(os.tmpdir(), `cluttercut-upload-${process.pid}-${Date.now()}.zip`);
    writeFileSync(tmp, buf);

    const { code, out, err } = await runCli(["list", tmp], cliEnv());
    if (code !== 0) {
      const raw = (err || out).trim().slice(0, 300); // CLI 已带完整中文原因（无法解压/缺 manifest）
      rmSync(tmp, { force: true });
      tmp = null;
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          ok: false,
          error: raw || "不是有效的 ClutterCut 备份文件(缺少/损坏 manifest.json)。",
        }),
      );
      return;
    }

    // 暂存（替换掉上一次没来得及应用的旧包）
    const pending = pendingZip();
    mkdirSync(path.dirname(pending), { recursive: true });
    if (existsSync(pending)) rmSync(pending, { force: true });
    renameSync(tmp, pending);
    tmp = null;

    const { createdAt, counts } = parseListOut(out);
    res.end(JSON.stringify({ ok: true, pending: path.basename(pending), createdAt, counts }));

    // 让响应先冲刷回页面，再以哨兵码退出 → Electron 主进程据此重启（重启时开库前写回）
    restartArmed = true;
    setTimeout(() => process.exit(RESTART_CODE), 600);
  } catch (e) {
    if (tmp && existsSync(tmp)) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: `恢复失败：${e?.message ?? e}` }));
  } finally {
    if (!restartArmed) restoreBusy = false;
  }
}

/** 启动钩子：数据目录旁有暂存包就先写回再开库。返回是否发生了恢复 */
function applyPendingRestore() {
  const pending = pendingZip();
  if (!existsSync(pending)) return false;
  const env = { ...cliEnv(), DOOIT_RESTORE_SKIP_CHECK: "1" }; // 本流程保证服务未开、无并发写
  console.log(`[restore] 发现待恢复备份 ${path.basename(pending)}，开库前写回数据目录…`);
  let r;
  try {
    r = spawnSync(process.execPath, [fileURLToPath(BACKUP_SCRIPT), "restore", pending], {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
  } catch (e) {
    console.error(`[restore] 写回失败：${e?.message ?? e}`);
    rmSync(pending, { force: true });
    return false;
  }
  rmSync(pending, { force: true });
  if (r.status === 0) {
    const tail = (r.stdout || "").trim().split("\n").slice(-3).join("\n");
    console.log(`[restore] ${tail || "恢复完成"}`);
    return true;
  }
  console.error(`[restore] 写回失败（exit ${r.status}）：${(r.stderr || r.stdout || "").trim().slice(0, 600)}`);
  return false;
}

export { handleRestore, applyPendingRestore, RESTART_CODE };
