// DeepSeek 客户端：密钥来源（env 优先 / deepseek-key.txt 兜底）与请求构造。
// 请求头/体的唯一组装点：callDeepSeek（非流式拿全文）与 chat.mjs 的 SSE 流式转发都走
// fetchDeepSeek，两处不再各写一份 fetch。密钥值只在服务端使用，绝不下发到浏览器。
import { readFileSync } from "node:fs";
import { KEY_FILE } from "./paths.mjs";

// 环境变量优先，运行期固定；否则每次实时读密钥文件（deepseek-key.txt），改完不用重启即生效
const ENV_DEEPSEEK_KEY = (process.env.DEEPSEEK_API_KEY ?? "").trim();
export const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

function readKeyFile() {
  try {
    return readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

/** 当前生效的 API Key */
export function apiKey() {
  return ENV_DEEPSEEK_KEY || readKeyFile();
}

export function keySource() {
  return ENV_DEEPSEEK_KEY ? "env" : readKeyFile() ? "file" : null;
}

/**
 * DeepSeek chat/completions 请求（共用的 URL/头/body 组装），返回裸 fetch Response。
 * 默认 AbortSignal.timeout(opts.timeoutMs ?? 120s)；调用方给了 opts.signal 则用它
 * （chat 流式用自建 AbortController + 180s 定时器 + 客户端断开即 abort）。
 * opts.maxTokens 默认 8192；opts.stream 默认 false（true 时调用方自行消费 body）。
 */
export function fetchDeepSeek(messages, opts = {}) {
  return fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: 0.6,
      max_tokens: opts.maxTokens ?? 8192,
      stream: !!opts.stream,
    }),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 120000),
  });
}

/** 非流式调用，返回模型正文；HTTP 错误抛带状态码与响应摘要的 Error */
export async function callDeepSeek(messages, opts = {}) {
  const res = await fetchDeepSeek(messages, { maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}
