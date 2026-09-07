// 「AI 聊天」域：/api/chat 编排 —— 本地时间（每问必带，模型对“今天/现在”有时效感知）
// → 未完成待办（用户自维护的清单，只读注入，让 AI 知道用户接下来要做什么）→ 用户画像快照
// （有则恒定注入）→ 长效记忆语义召回 → 组装消息 → SSE 流式转发 DeepSeek。
// 画像快照来自 profile-card.mjs（ai-profile.json），记忆召回来自 mem-recall.mjs；
// 两者都在「暂停记忆」（remember:false）时跳过；本地时间与待办清单不是记忆，始终带。
// 模型 Key 走 deepseek.mjs；Markdown 渲染在浏览器端做（md-render.mjs），服务端只透传原文。
import { readJson, corsOpen } from "../core/util.mjs";
import { apiKey, fetchDeepSeek } from "../core/deepseek.mjs";
import { recallMemoryFacts } from "../core/mem-recall.mjs";
import { loadProfileCard } from "../core/profile-card.mjs";
import { loadTodo } from "../core/todo-store.mjs";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 本地时间一行（AI 服务跑在本机，服务器时钟 = 用户系统时钟） */
function localNowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 未完成待办注入文本（Todo 板块自维护，AI 只读）；没有未完成项或读失败返回空串。
 *  只列清单本身与使用原则，不写「我记得你的待办」这类元话语。 */
function todoContextText() {
  try {
    const open = loadTodo()
      .filter((t) => !t.done)
      .slice(0, 15);
    if (!open.length) return "";
    const bullets = open.map((t) => `- ${t.text}`).join("\n");
    return `这是用户自己维护的待办清单，以下只列还没完成的：\n${bullets}\n\n使用原则：用户问接下来做什么、时间/精力怎么安排、某件事怎么推进时，以这份清单为准给贴合建议；用户聊到清单里某项时围绕它展开（拆解步骤/提醒冲突/给资源）都欢迎；用户没在问待办时不要主动复述整张清单。`;
  } catch {
    return "";
  }
}

// 日常聊天：该长则长、该短则短——知识/操作/求助类问题一次讲透，
// 短问答仍保持简短自然。
const CHAT_SYSTEM_PROMPT = `你是 ClutterCut（本机运行的 AI 效率助手，名字意为「修剪杂念」：掌握的有效信息越多，无效动作就越少——它会越来越了解用户、帮用户排除无关选项）用户身边的编程助手，同时也了解通用开发问题。像普通 AI 助手一样直接回答问题：
- 该长则长、该短则短：知识/操作/求助类问题请讲透——把思路、步骤、命令/代码、参数含义与注意点一次给全，让回答本身就能独立照做；几句话能答完的问题或闲聊寒暄保持简短自然，不要硬凑篇幅。
- Markdown 有助于阅读时使用：多步骤用编号列表，命令/代码放进带语言标注的代码块，适合对比的键位或字段可用小表格；不要套固定模板。
- 不要输出任何前言后记（如“好的，我来帮你…”），直接进入正题。
- 用简体中文回答。`;

/* ---------- 流式（SSE）转发 ---------- */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "Access-Control-Allow-Origin": "*",
};

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 以 stream: true 调 DeepSeek，把上游 SSE 字节流原样转发给浏览器。
 * 客户端直接解析 data: 行里的 choices[0].delta.content，即可边收边渲染。
 */
async function streamChat(messages, req, res) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  req.on("close", () => ctrl.abort());
  res.on("error", () => {}); // 客户端中途断开时不至于抛未捕获错误

  let upstream;
  try {
    upstream = await fetchDeepSeek(messages, { stream: true, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    res.writeHead(200, SSE_HEADERS);
    sseSend(res, "error", { message: `无法连接 DeepSeek：${e.message}` });
    res.end();
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  if (!upstream.ok) {
    clearTimeout(timer);
    const text = await upstream.text().catch(() => "");
    sseSend(res, "error", { message: `DeepSeek API ${upstream.status}：${text.slice(0, 300)}` });
    res.end();
    return;
  }

  try {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(dec.decode(value, { stream: true }));
    }
    res.write(dec.decode());
  } catch (e) {
    if (!res.writableEnded) sseSend(res, "error", { message: `流中断：${e.message}` });
  } finally {
    clearTimeout(timer);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

/** POST /api/chat：{message, history?, remember?}——一律 SSE 流式返回（客户端边收边渲染） */
async function handleChat(req, res) {
  if (corsOpen(req, res, "POST")) return;
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("method not allowed");
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.statusCode = 400;
    res.end("bad json");
    return;
  }

  const message = String(body.message ?? "").trim().slice(0, 2000);
  if (!message) {
    res.statusCode = 400;
    res.end("empty message");
    return;
  }

  if (!apiKey()) {
    res.statusCode = 503;
    res.end(
      "服务端没有配置 DeepSeek API Key：请设置环境变量 DEEPSEEK_API_KEY，或在 site/data/deepseek-key.txt 中写入密钥。"
    );
    return;
  }

  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
  // remember:false（前端「暂停收集记忆」）时，画像快照与记忆召回都不注入。
  const rememberOn = body.remember !== false;
  // 画像快照：ai-profile.json 有卡就恒定带上（整体状况的底）；与下面的语义召回互补。
  const profileCard = rememberOn ? loadProfileCard() : "";
  // 有长效记忆且未暂停时：按与本轮消息的相关度做语义召回（本地向量，取最相关几条 + 最近几条）；
  // 向量层不可用（模型未就绪/异常）时自动回退“最近 40 条”的旧行为，任何情况都不打断聊天。
  // recallMemoryFacts 返回的文本自带完整前言（告知这是“长效记忆/不要复述”），这里原样注入即可。
  const memoryFacts = rememberOn ? await recallMemoryFacts(message) : "";
  // 待办清单不属于记忆：暂停记忆不影响它（AI 仍要知道用户接下来要做什么，才能给准确建议）
  const openTodos = todoContextText();
  const messages = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    {
      role: "system",
      content: `当前本地时间：${localNowText()}（取你的系统时钟）。聊天里凡是涉及时间、日期、时效（比如“这周/周末/现在几点/今天几号”），都以此为基准判断，不要凭预训练知识猜时间。`,
    },
    ...(openTodos ? [{ role: "system", content: openTodos }] : []),
    ...(profileCard
      ? [
          {
            role: "system",
            content: `这是你经过多轮对话后对这位用户形成的画像。回答时自然贴合他的状况与偏好给出建议即可；不要向用户复述这张画像，也不要声称“我记得你以前说过”。\n${profileCard}`,
          },
        ]
      : []),
    ...(memoryFacts ? [{ role: "system", content: memoryFacts }] : []),
    ...history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
    { role: "user", content: message },
  ];

  await streamChat(messages, req, res);
}

export { handleChat };
