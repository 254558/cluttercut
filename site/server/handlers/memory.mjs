// 「长期记忆」领域：逐轮提取（/api/remember）+ 会话整段消化（/api/memory action=digest，
// 跨轮伏笔只有纵观整段对话才能沉淀，见 actDigest）；列表 / 增删改查 / 语义检索 / 串联 /
// 压缩整理 / 画像重绘（/api/memory、GET /api/profile）。
// 存储唯一入口是 memory-store.mjs（facets 归一化白名单也在那）；向量旁路索引在
// core/mem-recall.mjs（编辑/删除后清该条旧向量，下次召回按新正文重算）；模型与 Key 走
// deepseek.mjs；压缩整理核心在 core/memory-tidy.mjs（原 organize 附带的 tidyMemory 回归）。
// 「清空全部」已随 Clear-all 按钮下线：记忆不再有一键全清入口，逐条删除保留，整单瘦身交给压缩整理。
// 方面软标签：自动提取时随 fact 一起给；手动新增/编辑在配了 key 时顺手同步打标；旧的无标签
// 条目由 tag-missing 动作批量补。三者都静默失败（模型坏/没 key 不影响记忆本身），标签只
// 服务召回铺匀与板块浏览，绝不参与相似度计算。
import { uid, normFact, parseLooseJson, readJson, methodGuard } from "../core/util.mjs";
import { apiKey, callDeepSeek } from "../core/deepseek.mjs";
import { loadMemory, saveMemory, sanitizeFacets } from "../core/memory-store.mjs";
import { compactMemory, maybeAutoTidy } from "../core/memory-tidy.mjs";
import { refreshProfileMaybe, loadProfileFull } from "../core/profile-card.mjs";
import { dropMemoryVectors, semanticResults } from "../core/mem-recall.mjs";

// 方面词表（含边界含义括号说明）——提取/手动打标/补标签三条提示词共用一份文案。
// 词序必须与 memory-store.mjs 的 MEMORY_FACETS 白名单一致（那才是真正的单一业务源头；
// 新增方面时两处同改，旧记忆可借「补标签」慢慢带上新方面）。
const FACET_WORDS = `身份背景（职业/身份/城市/经历）、技能工具（语言/框架/工具/软件）、工作项目（当前在做的事/项目）、目标计划（目标/打算/计划）、偏好习惯（喜欢/不喜欢什么/习惯/口味）、性格风格（行事风格/性格/思考方式）、雷区注意（忌讳/讨厌/敏感话题）、
家庭人际（家人朋友/伴侣/关系）、健康时间（身体/睡眠/精力/时间安排）`;

const MEMORY_SYSTEM = `你是「记忆提取器」。下面是一次 AI 助手和用户的对话。请从中提炼「关于这位用户本人的长期事实」，用于之后给他更贴合的建议。

值得记的例子：身份/职业、所在城市、使用的工具与语言（如「用户平时用 Vue 写前端」）、工作与生活习惯、兴趣爱好、目标和正在推进的事情、家人朋友、时间安排等；也包括从对话方式里能看出的「性格与行事风格」，如「用户做决定比较谨慎，重要事情上习惯先权衡风险」「用户性子偏急，希望推进快、不喜欢绕弯子」「用户在意细节和完成度」。

规则：
1. 只记稳定、跨时间的个人画像；不要记一次性任务、具体报错、临时求助的内容本身。
2. 一条一个事实，用简体中文完整陈述句，独立可读；不要用「用户说…」「用户提到…」这种转述开头。
3. 拿不准的、玩笑的、纯情绪化的不要记；宁可少记，也不要凭感觉猜。
4. 性格与行事风格必须依据本段对话里明确可见的信号（用户表达的偏好与态度、做决定的方式、措辞习惯、对建议的反应等），且应是跨情境的稳定倾向、而不是某一次的情绪反应；表述用完整陈述句，可用「比较、偏向、习惯」等程度词（如「用户做事比较谨慎，习惯先想清风险再动手」），不要一句话武断把人定死。
5. 给每条事实打 1–3 个「方面」标签，从这组词里选（边界含义见括号，词本身原样使用，不要造新词）：
${FACET_WORDS}。
拿不准就少给；没有对应方面就给空数组。
只输出一行 JSON：{"facts":[{"text":"...","facets":["偏好习惯"]}]}（facets 可省略）；没有值得记的就输出 {"facts":[]}。不要任何其它文字。`;

// 会话整段消化用的提取提示词。与逐轮 MEMORY_SYSTEM 的区别全在「跨轮」两条：
// ① 摆在眼前的是整段对话，同一件事多轮推进/反复时只记最终（最新一轮）状态，不把
//    中间态各记一条（例：先说要换工作、后来去面试、最后已入职 → 只记「用户已入职
//    新公司」；仍在进行中的才记「正在…」）；② 只有纵观全段才看得到的伏笔——前几轮
//    埋的打算被后几轮证实/推翻——正是在这里沉淀。输出格式与逐轮完全一致。
const SESSION_DIGEST_SYSTEM = `你是「会话总结记忆提取器」。下面是一次 AI 助手和用户跨多轮、多个话题的完整会话。请纵观整段，提炼「关于这位用户本人的长期事实」，用于之后给他更贴合的建议。

值得记的例子：身份/职业、所在城市、使用的工具与语言（如「用户平时用 Vue 写前端」）、工作与生活习惯、兴趣爱好、目标和正在推进的事情、家人朋友、时间安排等；也包括从对话方式里能看出的「性格与行事风格」（表述用完整陈述句，可带程度词，如「用户做事比较谨慎，习惯先想清风险再动手」，不要一句话把人定死）。

规则：
1. 只记稳定、跨时间的个人画像；不要记一次性任务、具体报错、临时求助的内容本身。
2. 一条一个事实，用简体中文完整陈述句，独立可读；不要用「用户说…」「用户提到…」这种转述开头。
3. 同一件事在多轮里推进或反复时，只记它最终/最新的状态，不要按时间顺序分阶段各记一条；还没尘埃落定的进行中状态可记（如「用户正在面试新工作」）。
4. 拿不准的、玩笑的、纯情绪化的不要记；宁可少记，也不要凭感觉猜。
5. 给每条事实打 1–3 个「方面」标签，从这组词里选（边界含义见括号，词本身原样使用，不要造新词）：
${FACET_WORDS}。
拿不准就少给；没有对应方面就给空数组。
只输出一行 JSON：{"facts":[{"text":"...","facets":["偏好习惯"]}]}（facets 可省略）；没有值得记的就输出 {"facts":[]}。不要任何其它文字。`;

/** 解析提取模型的 JSON 输出（兼容两种格式：{"text","facets?"} 对象或旧版纯字符串）；
 *  解析不出就当作没有新事实（宽容解析走 util.parseLooseJson）。facets 在此白名单化。 */
function parseFacts(raw) {
  const data = parseLooseJson(raw);
  if (!data) return [];
  const list = Array.isArray(data.facts) ? data.facts : Array.isArray(data) ? data : [];
  const out = [];
  for (const x of list) {
    if (typeof x === "string") {
      if (x.trim()) out.push({ text: x, facets: [] });
    } else if (x && typeof x.text === "string" && x.text.trim()) {
      out.push({ text: x.text, facets: sanitizeFacets(x.facets) });
    }
  }
  return out;
}

/** 合并新事实（entry 可以是字符串或 {text, facets}）：归一化后互相包含即视为重复跳过；
 *  返回最新列表与新增数。 */
function addFacts(entries) {
  const items = loadMemory();
  const added = [];
  for (const e of entries) {
    const text = normFact(typeof e === "string" ? e : e?.text ?? "").slice(0, 300);
    if (!text) continue;
    const dup = items.some((it) => it.text.includes(text) || text.includes(it.text));
    if (dup) continue;
    const it = {
      id: uid(),
      text,
      ts: Date.now(),
      facets: typeof e === "object" ? sanitizeFacets(e?.facets) : [],
    };
    items.push(it);
    added.push(it);
  }
  if (added.length) saveMemory(items);
  return { items: loadMemory(), added };
}

// —— 手动新增/编辑 + 旧记忆补标签的静默打标 ——
// 配了 key 时用一次超小模型调用给正文补 1–3 个方面标签；没 key / 调用失败 / 超时一律
// 回退（fallback），绝不阻塞记忆的新增、纠错或列表本身。标签词表 = memory-store 白名单。
const TAG_SYSTEM = `你是「记忆标签员」。给下面这一条关于用户的长期记忆打 1–3 个「方面」标签。
只能从这组词里选（边界含义见括号，词本身原样使用，不要造新词）：
${FACET_WORDS}。
拿不准就只给最有把握的 1 个；实在没有就给空数组。
只输出一行 JSON：{"facets":["偏好习惯"]}，不要任何其它文字。`;

async function tagFacets(text) {
  const raw = await callDeepSeek(
    [
      { role: "system", content: TAG_SYSTEM },
      { role: "user", content: String(text ?? "").slice(0, 300) },
    ],
    { maxTokens: 80, timeoutMs: 6000 },
  );
  const d = parseLooseJson(raw);
  return sanitizeFacets(Array.isArray(d) ? d : d?.facets);
}

/** 打标签但带兜底：打成非空才用新的，否则保留 fallback（没 key 直接跳过、不等待模型） */
async function retagFacets(text, fallback = []) {
  if (!apiKey()) return fallback;
  try {
    const t = await tagFacets(text);
    return t.length ? t : fallback;
  } catch {
    return fallback;
  }
}

// —— tag-missing：给一直没标签的旧记忆批量补标 ——
let taggingMissing = false; // 单飞锁：批补要多次模型调用，拒绝并发
const TAG_MISSING_CHUNK = 40; // 单次模型调用最多看几条，输出量可控

const TAG_MISSING_SYSTEM = `你是「记忆标签员」。给下面的每条长期记忆打 1–3 个「方面」标签。
只能从这组词里选（边界含义见括号，词本身原样使用，不要造新词）：
${FACET_WORDS}。
编号与每行记忆一一对应。拿不准就少给；实在没有对应方面的给空数组。
只输出一行 JSON：{"tags":{"1":["偏好习惯"],"2":[],"3":["家庭人际","健康时间"]}}，key 用记忆编号（1 起），不要任何其它文字。`;

async function tagMissingChunk(rows) {
  const prompt = rows.map((r, i) => `${i + 1}. ${r.text}`).join("\n").slice(0, 30000);
  const raw = await callDeepSeek(
    [
      { role: "system", content: TAG_MISSING_SYSTEM },
      { role: "user", content: prompt },
    ],
    { maxTokens: 1000, timeoutMs: 45000 },
  );
  const d = parseLooseJson(raw);
  if (!d) return new Map();
  const tags = Array.isArray(d) ? d : d?.tags; // 兼容对象/纯数组两种输出
  const map = new Map();
  if (Array.isArray(tags)) {
    tags.forEach((v, idx) => {
      if (idx < rows.length) map.set(rows[idx].id, sanitizeFacets(v));
    });
  } else if (tags && typeof tags === "object") {
    for (const [k, v] of Object.entries(tags)) {
      const idx = Number(k) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < rows.length) {
        map.set(rows[idx].id, sanitizeFacets(v));
      }
    }
  }
  return map;
}

/** 记忆有实质变化后的派生收尾：画像节流刷新；若自动整理（≥500 条才触发、4h 冷却）
 *  真跑完（可能合并/删掉条目），再 force 重绘画像，让卡与瘦身后的清单一致。 */
function pokeDerived() {
  refreshProfileMaybe().catch(() => {});
  maybeAutoTidy()
    .then((r) => {
      if (r?.ran) refreshProfileMaybe({ force: true }).catch(() => {});
    })
    .catch(() => {});
}

/** POST /api/remember：从一轮对话里提取长期事实并入记忆；失败一律静默 */
async function handleRemember(req, res) {
  if (methodGuard(req, res, ["POST"])) return;
  const items = () => loadMemory();
  try {
    const body = await readJson(req);
    const user = String(body?.user ?? "").slice(0, 4000);
    const reply = String(body?.reply ?? "").slice(0, 6000);
    if (!user && !reply) {
      res.end(JSON.stringify({ ok: true, added: 0, items: items() }));
      return;
    }
    if (!apiKey()) {
      // 没配 key 时聊天本来就用不了，这里静默放行，不阻塞前端
      res.end(JSON.stringify({ ok: true, added: 0, items: items() }));
      return;
    }
    const raw = await callDeepSeek(
      [
        { role: "system", content: MEMORY_SYSTEM },
        { role: "user", content: `【用户】\n${user}\n\n【助手】\n${reply}`.slice(0, 10000) },
      ],
      { maxTokens: 400, timeoutMs: 60000 },
    );
    const { items: list, added } = addFacts(parseFacts(raw));
    if (added.length) pokeDerived();
    res.end(JSON.stringify({ ok: true, added: added.length, items: list }));
  } catch {
    // 提取失败静默：不影响聊天
    res.end(JSON.stringify({ ok: false, added: 0, items: items() }));
  }
}

/* ---------- /api/memory 的 action 们 ----------
 * 每个 action 对应一个模块级函数（入参 { body, res }），自行写完响应。
 * 早期参数不齐（缺 id / 空正文）按原 if 链语义回 400「unknown action」或专属错误文案；
 * 意外抛错统一由 handleMemory 的外层 catch 收敛为 400「bad request」。 */

function err400(res, error) {
  res.statusCode = 400;
  res.end(JSON.stringify({ ok: false, error }));
}

async function actDelete(body, res) {
  if (typeof body.id !== "string") return err400(res, "unknown action");
  const list = loadMemory();
  const next = list.filter((it) => it.id !== body.id);
  if (next.length !== list.length) {
    saveMemory(next);
    dropMemoryVectors([body.id]); // 旁路向量立即清；删除同样是画像过时的信号，节流刷新
    refreshProfileMaybe().catch(() => {});
  }
  res.end(JSON.stringify({ ok: true, items: loadMemory() }));
}

async function actEdit(body, res) {
  if (typeof body.id !== "string") return err400(res, "unknown action");
  // 手动纠错：规范化后写回正文，并把 ts 顶到现在——让「现状取最新说法」的记忆/
  // 画像逻辑把改过的条目当成最新权威版；随后节流触发画像刷新（失败静默保旧卡）。
  const text = String(body.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return err400(res, "修改内容不能为空");
  const list = loadMemory();
  const it = list.find((x) => x.id === body.id);
  if (!it) return err400(res, "该条记忆不存在（可能已被压缩整理合并）");
  if (it.text !== text) {
    it.text = text;
    it.ts = Date.now();
    // 正文变了语义也随之变：顺手按新正文重打方面标签（静默；失败保留旧标签兜底）
    it.facets = await retagFacets(text, it.facets);
    saveMemory(list);
    // 编辑保留 id：不重算的话语义召回会一直拿旧正文的向量匹配——清掉等下次按新正文补
    dropMemoryVectors([body.id]);
    refreshProfileMaybe().catch(() => {});
  }
  res.end(JSON.stringify({ ok: true, items: loadMemory() }));
}

async function actAdd(body, res) {
  // 手动新增：去重/规范化与自动提取同一套；重复时 added=0，前端提示不重复落盘。
  // 配了 key 时顺手打方面标签（静默；失败/没 key 则无标签，之后可走「补标签」）。
  const text = String(body.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return err400(res, "记忆内容不能为空");
  const facets = await retagFacets(text, []);
  const { items: list, added } = addFacts([{ text, facets }]);
  if (added.length) pokeDerived();
  res.end(JSON.stringify({ ok: true, items: list, added: added.length }));
}

async function actTagMissing(body, res) {
  // 给还没有方面标签的旧记忆批量补标（压缩整理前/早期版本存的记忆可能一直没标签）。
  // 分批小调模型；单飞锁防并发；每批失败静默，能补多少算多少。
  if (!apiKey()) {
    res.end(JSON.stringify({ ok: true, tagged: 0, items: loadMemory() }));
    return;
  }
  if (taggingMissing) {
    res.end(JSON.stringify({ ok: true, tagged: 0, busy: true, items: loadMemory() }));
    return;
  }
  taggingMissing = true;
  try {
    const untagged = loadMemory().filter((it) => !(it.facets || []).length);
    if (!untagged.length) {
      res.end(JSON.stringify({ ok: true, tagged: 0, items: loadMemory() }));
      return;
    }
    const assigned = new Map(); // id -> 新标签（只在打成非空时记）
    for (let i = 0; i < untagged.length; i += TAG_MISSING_CHUNK) {
      const chunk = untagged.slice(i, i + TAG_MISSING_CHUNK);
      try {
        const map = await tagMissingChunk(chunk);
        for (const [id, facets] of map) if (facets.length) assigned.set(id, facets);
      } catch {
        /* 该批模型失败静默，不阻塞其它批 */
      }
    }
    if (assigned.size) {
      const next = loadMemory();
      for (const it of next) if (assigned.has(it.id)) it.facets = assigned.get(it.id);
      saveMemory(next);
    }
    res.end(JSON.stringify({ ok: true, tagged: assigned.size, items: loadMemory() }));
  } finally {
    taggingMissing = false;
  }
}

async function actSearch(body, res) {
  const q = String(body.q ?? "").trim().slice(0, 300);
  if (!q) {
    res.end(JSON.stringify({ ok: true, mode: "none", q: "", items: [] }));
    return;
  }
  try {
    const hits = await semanticResults(q, { limit: 24 });
    res.end(JSON.stringify({ ok: true, mode: "semantic", q, items: hits }));
  } catch {
    // 本地向量模型不可用/异常时不报错，降级为文本包含匹配（facets 一并透传，前端可筛选）
    const needle = q.toLowerCase();
    const hits = loadMemory()
      .filter((it) => it.text.toLowerCase().includes(needle))
      .map((it) => ({ id: it.id, text: it.text, ts: it.ts, s: null, facets: it.facets }));
    res.end(JSON.stringify({ ok: true, mode: "text", q, items: hits }));
  }
}

async function actRelated(body, res) {
  if (typeof body.id !== "string") return err400(res, "unknown action");
  const target = loadMemory().find((x) => x.id === body.id);
  if (!target) return err400(res, "该条记忆不存在");
  try {
    // boostFacets：目标条目的方面标签——难分伯仲时优先串到同方面的其它记忆（s 仍是纯余弦）
    const hits = await semanticResults(target.text, {
      limit: 6,
      floor: 0.35,
      excludeId: target.id,
      boostFacets: target.facets,
    });
    res.end(JSON.stringify({ ok: true, items: hits }));
  } catch {
    // 向量不可用时「串联」无结果即可，不报错
    res.end(JSON.stringify({ ok: true, items: [] }));
  }
}

async function actRefreshProfile(body, res) {
  // force 重绘画像卡（记忆板块「重新生成」）；单飞锁若在跑会直接返回不排队
  const before = loadProfileFull().at;
  await refreshProfileMaybe({ force: true }).catch(() => {});
  const p = loadProfileFull();
  res.end(
    JSON.stringify({
      ok: true,
      exists: p.exists,
      at: p.at,
      changed: p.exists && p.at !== before, // 没变化 = 生成被锁/内容太短/模型失败，让前端提示
    }),
  );
}

async function actCompact(body, res) {
  // 可能耗时几十秒（要调模型出方案），交给 core/memory-tidy.mjs 的内部单飞锁防并发
  const summary = await compactMemory();
  // 记忆被重排/瘦身后，旧画像卡过时了：force 重绘画像（fire-and-forget，失败静默保旧卡）
  if (summary.ran) refreshProfileMaybe({ force: true }).catch(() => {});
  res.end(JSON.stringify({ ok: true, items: loadMemory(), ...summary }));
}

async function actDigest(body, res) {
  // 会话整段消化：客户端在「离开一段对话」时把该对话（最近若干轮）整段送来，做一次
  // 纵观全段的总结提取。逐轮提取只喂「用户+回复」两段，跨轮伏笔（前几轮埋打算、隔几轮
  // 说进展/结果）单轮都看不到，只有整段一起看才能沉淀——这是 digest 与 remember 的分工。
  // 落盘/去重/画像刷新与逐轮同一条路（addFacts + pokeDerived）；静默失败，无 key 直接放行。
  if (!apiKey()) {
    res.end(JSON.stringify({ ok: true, added: 0, items: loadMemory() }));
    return;
  }
  const turns = Array.isArray(body?.turns)
    ? body.turns
        .filter(
          (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
        )
        .slice(-60) // 窗口内保留最近 60 轮；更早的轮次各自在当时的 digest/逐轮里覆盖过
        .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }))
    : [];
  if (!turns.length) {
    res.end(JSON.stringify({ ok: true, added: 0, items: loadMemory() }));
    return;
  }
  const transcript = turns
    .map((m) => `${m.role === "assistant" ? "助手" : "用户"}：${m.content}`)
    .join("\n\n")
    .slice(0, 24000); // 与客户端同一预算，给 DeepSeek 上下文留余量
  const raw = await callDeepSeek(
    [
      { role: "system", content: SESSION_DIGEST_SYSTEM },
      { role: "user", content: transcript },
    ],
    { maxTokens: 1200, timeoutMs: 120000 },
  );
  const { items: list, added } = addFacts(parseFacts(raw));
  if (added.length) pokeDerived();
  res.end(JSON.stringify({ ok: true, added: added.length, items: list }));
}

const ACTIONS = {
  delete: actDelete,
  edit: actEdit,
  add: actAdd,
  "tag-missing": actTagMissing,
  search: actSearch,
  related: actRelated,
  "refresh-profile": actRefreshProfile,
  compact: actCompact,
  digest: actDigest,
};

/**
 * GET /api/memory：列全部记忆（含 facets）。
 * POST /api/memory：action 之一（见上方 ACTIONS / 各 act* 函数）——
 *   delete{id} / edit{id,text} / add{text} / search{q} / related{id} /
 *   tag-missing / compact / refresh-profile / digest{turns[]}（会话整段消化）
 */
async function handleMemory(req, res) {
  if (methodGuard(req, res, ["GET", "POST"])) return;
  if (req.method === "GET") {
    res.end(JSON.stringify({ ok: true, items: loadMemory() }));
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return err400(res, "bad request");
  }
  const action = body && typeof body === "object" ? body.action : null;
  const fn = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!fn) return err400(res, "unknown action");
  try {
    await fn(body, res);
  } catch {
    err400(res, "bad request");
  }
}

/** GET /api/profile：画像卡完整状态（文本 + 生成时间 + 依据条数），记忆板块展示用 */
async function handleProfile(req, res) {
  if (methodGuard(req, res, ["GET"])) return;
  const p = loadProfileFull();
  res.end(
    JSON.stringify({ ok: true, exists: p.exists, card: p.card, at: p.at, fromCount: p.fromCount }),
  );
}

export { handleRemember, handleMemory, handleProfile };
