// DeepSeek Key 状态与写入：GET 只报是否配置/来源（绝不回传密钥值）；POST 写 deepseek-key.txt（已 gitignore）。
import { rmSync, writeFileSync } from "node:fs";
import { KEY_FILE } from "../core/paths.mjs";
import { readBody, methodGuard } from "../core/util.mjs";
import { apiKey, keySource } from "../core/deepseek.mjs";

function keyStatusBody() {
  return { ok: true, configured: !!apiKey(), source: keySource() };
}

async function handleKeyStatus(req, res) {
  if (methodGuard(req, res, ["GET"])) return;
  res.end(JSON.stringify(keyStatusBody()));
}

async function handleKeySet(req, res) {
  if (methodGuard(req, res, ["POST"])) return;
  try {
    // 空 body 按「传空 = 清除」处理（"{}"），保持旧语义：不把空 body 当解析错误
    const body = JSON.parse((await readBody(req)) || "{}");
    const key = String(body?.key ?? "").trim();
    if (key === "") {
      // 传空 = 清除本地密钥（回到“仅环境变量可用”的状态）
      rmSync(KEY_FILE, { force: true });
      res.end(JSON.stringify({ ok: true, cleared: true, ...keyStatusBody() }));
      return;
    }
    if (!/^sk-[\w-]{6,}$/.test(key)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Key 格式不对：应是以 sk- 开头的一串字符（注意别带前后空格）" }));
      return;
    }
    writeFileSync(KEY_FILE, key, "utf8");
    console.log(`[key] DeepSeek key 已更新（${key.slice(0, 6)}…${key.slice(-4)}）`);
    res.end(JSON.stringify({ ok: true, saved: true, ...keyStatusBody() }));
  } catch (err) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: `保存失败：${err?.message ?? err}` }));
  }
}

export { handleKeyStatus, handleKeySet };
