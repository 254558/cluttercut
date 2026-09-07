// 桌面备份：页面按钮触发，spawn 同一份 site/scripts/data-backup.mjs，zip 落在 ~/Desktop。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { BACKUP_SCRIPT } from "../core/paths.mjs";
import { methodGuard } from "../core/util.mjs";

let backupBusy = false; // 简单互斥：一次只跑一份备份，连点不重复触发

function runBackupCli(desktopDir) {
  return new Promise((resolve) => {
    // packaged 里 process.execPath 是 Electron 本体：子进程必须带上
    // ELECTRON_RUN_AS_NODE 当纯 Node 跑备份 CLI（dev/纯 node 下该变量不存在，原样继承即可）
    const env = { ...process.env };
    if (process.env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = "1";
    const p = spawn(
      process.execPath,
      [fileURLToPath(BACKUP_SCRIPT), "backup", "--out", desktopDir],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

async function handleBackup(req, res) {
  if (methodGuard(req, res, ["POST"])) return;
  if (backupBusy) {
    res.statusCode = 409;
    res.end(JSON.stringify({ ok: false, error: "上一次备份还在进行中，稍等几秒再点。" }));
    return;
  }
  backupBusy = true;
  try {
    const desktopDir = path.join(os.homedir(), "Desktop");
    const { code, out, err } = await runBackupCli(desktopDir);
    if (code === 0) {
      const data = JSON.parse(out);
      res.end(
        JSON.stringify({
          ok: true,
          dir: desktopDir,
          name: data.outFile ? path.basename(data.outFile) : null,
          file: data.outFile ?? null,
          counts: data.manifest?.counts ?? null,
        })
      );
    } else {
      const raw = (err || out).slice(0, 600);
      const blocked = /EPERM|EACCES|not permitted|denied/i.test(raw);
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          ok: false,
          error: blocked
            ? "没有权限写入桌面：请在 系统设置 → 隐私与安全性 → 文件与文件夹 中允许 ClutterCut 访问“桌面”文件夹，然后重试。"
            : `备份失败：${raw || "未知错误"}`,
        })
      );
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: `备份失败：${e?.message ?? e}` }));
  } finally {
    backupBusy = false;
  }
}

export { handleBackup };
