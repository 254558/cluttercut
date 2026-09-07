// 长期记忆「语义召回」层：本地 bge-small-zh 向量化 + sqlite 旁路索引 + 余弦 top-k。
// 挑选规则集中在 pickRelevant：相关度门槛只看余弦；排序叠 30 天内的新鲜度小加成
// （让刚纠错/刚更新的说法压过旧版）；与已选近乎同义（≥0.85）的跳过、同一话题簇
// （≥0.78）最多 3 条——名额铺向不同侧面，减少“同一件事多个说法”占位。
// 不改变 ai-memory.json 的存储结构（那仍是唯一权威源，和整理/备份逻辑零耦合）——
// 向量只是旁路缓存：缺的惰性补齐、条目删了自动清、本地模型不可用时整体回退旧逻辑。
// 条目读取统一走 memory-store.mjs（ai-memory.json 的唯一属主），这里不再自带解析。
// 方面软标签（facets）只在这里做两件与向量无关的事：recallRaw 的覆盖兜底（长对话聊着
// 聊着偏科时，给没覆盖到的方面补 1–2 条代表）和 semanticResults 的「同方面优先」平局
// 加成（+0.02，只改排序、不动余弦判据）。相关度判据永远是纯余弦，返回的 s 恒为纯相似度。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { VEC_DB_FILE } from "./paths.mjs";
import { loadMemory, MEMORY_FACETS } from "./memory-store.mjs";

const MODEL_ID = "Xenova/bge-small-zh-v1.5";
const MODEL_DIM = 512;
// bge 检索指令：只加在“查询”一侧，文档侧不加
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const TOP_RELEVANT = 6; // 语义最相关取几条（score ≥ 相关度门槛才算）
const RELEVANT_FLOOR = 0.42; // 实测：无关闲聊的噪声在 0.41 以下，真相关一般 ≥0.45
const DUP_COS = 0.85; // 与已选条目近乎同义（同义重复占位）就跳过：记忆多了后放宽到 0.85，
// 让“同一件事的多个说法”少挤占名额（原先 0.9 只挡得住完全复读）
const CLUSTER_COS = 0.78; // 同一“话题簇”的判据（对簇代表向量的相似度）
const CLUSTER_MAX = 3; // 每个话题簇最多进几条：6 个名额尽量铺向不同侧面，而不是被一个话题占满
const TOP_RECENT = 2; // 无论相关与否都保底带最近几条（承接刚聊过的上下文）
const RECALL_CAP = 12; // 注入总上限（语义 + 最近 + 方面覆盖兜底；原 10，给兜底留名额）
const BACKFILL_MAX = 2; // 方面覆盖兜底至多补几条：只兜「偏科」，不喧宾夺主
const MAX_CHARS = 2500; // 沿用旧注入上限
const RECENCY_WINDOW_MS = 30 * 24 * 3600 * 1000; // 30 天内的记忆算“新鲜”，获得召回加成
const RECENCY_BONUS_MAX = 0.06; // 新鲜度加成上限：只用于排序倾斜“刚更新的说法”，
// 不改变相关度门槛（余弦不达标的不会因加成混进来）

let db = null;
let extractorPromise = null;

function openDb() {
  if (db) return db;
  mkdirSync(path.dirname(fileURLToPath(VEC_DB_FILE)), { recursive: true });
  db = new DatabaseSync(fileURLToPath(VEC_DB_FILE));
  db.exec(
    "CREATE TABLE IF NOT EXISTS mem (id TEXT PRIMARY KEY, vec BLOB NOT NULL);",
  );
  return db;
}

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const tf = await import("@huggingface/transformers");
      // 打包应用里模块目录在只读的 app.asar 内，transformers 默认把模型缓存写在模块旁的
      // .cache/（＝ asar 里，写不进去）—— 由 ELECTRON_RUN_AS_NODE 子进程启动时挪到数据
      // 目录下的 models/（不进备份清单）；纯 node / dev 保持库默认，缓存仍落 node_modules 旁。
      if (process.env.ELECTRON_RUN_AS_NODE === "1") {
        tf.env.cacheDir = path.join(path.dirname(fileURLToPath(VEC_DB_FILE)), "models") + path.sep;
      }
      return tf.pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
    })();
  }
  return extractorPromise;
}

/** 文本批量 → 单位向量（normalize 后余弦 = 点积） */
async function embed(ex, texts) {
  const out = await ex(texts, { pooling: "cls", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const rows = out.dims[out.dims.length - 2] ?? texts.length;
  const vecs = [];
  for (let i = 0; i < rows; i++) {
    vecs.push(Array.from(out.data.slice(i * dim, (i + 1) * dim)));
  }
  return vecs;
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** 新鲜度小加成：0~30 天内线性衰减到 0；更老的不加也不罚（老条目在“只有它相关”时仍能被召回） */
function recencyBonus(ts, now) {
  if (!ts) return 0;
  const age = Math.max(0, now - ts);
  if (age >= RECENCY_WINDOW_MS) return 0;
  return RECENCY_BONUS_MAX * (1 - age / RECENCY_WINDOW_MS);
}

/** 从候选里挑最多 TOP_RELEVANT 条注入。scored: [{it:{id,text,ts}, vec, s(纯余弦)}]，调用方已按
 *  s 降序。返回选中的条目（保留原引用）。规则（纯函数，便于沙箱直接断言）：
 *  1. 排序分 = 余弦 + 新鲜度加成；相关度门槛仍只看余弦，加成不会把不达标的拉进来；
 *  2. 与已选条目余弦 ≥ DUP_COS 视为同义重复，跳过；
 *  3. 同一话题簇（余弦 ≥ CLUSTER_COS）最多进 CLUSTER_MAX 条，把名额铺向不同侧面。 */
export function pickRelevant(scored, now = Date.now()) {
  const ranked = scored
    .map((x) => ({ ...x, score: x.s + recencyBonus(x.it.ts, now) }))
    .sort((a, b) => b.score - a.score);
  const chosen = []; // 已选条目的 it
  const chosenVecs = []; // 与 chosen 一一对应，供同义/簇比较用
  const clusters = []; // { vec: 簇代表向量, count: 已占名额 }
  for (const c of ranked) {
    if (c.s < RELEVANT_FLOOR) continue; // 余弦不达标，不因加成破例
    if (chosen.length >= TOP_RELEVANT) break; // 名额已满，后面分只会更低
    if (chosenVecs.some((vv) => cosine(c.vec, vv) >= DUP_COS)) continue; // 同义重复
    const cl = clusters.find((g) => cosine(c.vec, g.vec) >= CLUSTER_COS);
    if (!cl) clusters.push({ vec: c.vec, count: 1 });
    else if (cl.count >= CLUSTER_MAX) continue; // 该话题已经占了够多名额
    else cl.count += 1;
    chosen.push(c.it);
    chosenVecs.push(c.vec);
  }
  return chosen;
}

/** 方面覆盖兜底（纯函数，便于沙盒断言）：语义选中 + 最近保底之后，已选条目把某些「方面」
 *  整个漏掉了（比如一整天都在聊工作项目，家里/目标方面一条没进），从全量记忆里按时间新→
 *  旧补至多 BACKFILL_MAX 条「代表」，让每轮注入不偏科。规则：
 *  1. 只认 facets 软标签贡献的方面（无标签旧条目对任何方面都无贡献，天然不入选——等板块
 *     「补标签」后再参与兜底）；MEMORY_FACETS 外的值已在 memory-store 归一化时滤掉。
 *  2. 每挑一条，就把该条覆盖到的所有未覆盖方面标记为已覆盖——一条能补多个方面更好；
 *     已经全覆盖 / 名额满 / 条目用完就停。
 *  3. 返回保持 items 传入顺序（时间新→旧）的条目引用，绝不与 exclude 集合重复。
 *  @param items   全量记忆（memory-store 已按时间新→旧排序）
 *  @param exclude 已选条目 id（语义选中 ∪ 最近保底），兜底绝不重复选
 *  @param max     至多补几条（默认 BACKFILL_MAX） */
export function coverageBackfill(items, exclude, { max = BACKFILL_MAX } = {}) {
  const excluded = exclude instanceof Set ? exclude : new Set(exclude || []);
  if (!items?.length || max <= 0) return [];
  // 已选条目已经覆盖到的方面不算缺口；missing = 白名单里还没被覆盖的方面
  const missing = new Set(MEMORY_FACETS);
  for (const it of items) {
    if (excluded.has(it.id)) (it.facets || []).forEach((f) => missing.delete(f));
  }
  const picked = [];
  for (const it of items) {
    if (excluded.has(it.id) || picked.some((p) => p.id === it.id)) continue;
    const hits = (it.facets || []).filter((f) => missing.has(f));
    if (!hits.length) continue;
    hits.forEach((f) => missing.delete(f));
    picked.push(it);
    if (picked.length >= max || missing.size === 0) break;
  }
  return picked;
}

/** 让每个现存记忆都有向量（缺的算一次并落库；已被删的清理掉）。只读不改 ai-memory.json。
 * 模块私有：仅本文件召回/预热使用，聊天入口不直接调。 */async function ensureMemoryVectors(items) {
  if (!items || !items.length) return;
  const d = openDb();
  const have = new Set(d.prepare("SELECT id FROM mem").all().map((r) => r.id));
  const stale = [...have].filter((id) => !items.some((it) => it.id === id));
  const missing = items.filter((it) => !have.has(it.id));
  if (stale.length) {
    const del = d.prepare("DELETE FROM mem WHERE id = ?");
    for (const id of stale) del.run(id);
  }
  if (missing.length) {
    const ex = await getExtractor();
    const vecs = await embed(ex, missing.map((it) => it.text));
    const ins = d.prepare("INSERT OR REPLACE INTO mem (id, vec) VALUES (?, ?)");
    for (let i = 0; i < missing.length; i++) {
      ins.run(missing[i].id, Buffer.from(Float32Array.from(vecs[i]).buffer));
    }
  }
}

function loadVecMap(items) {
  const d = openDb();
  const map = new Map();
  const rows = d.prepare("SELECT id, vec FROM mem").all();
  for (const r of rows) {
    if (!map.has(r.id)) {
      const u8 = r.vec; // Uint8Array
      map.set(r.id, Array.from(new Float32Array(u8.buffer, u8.byteOffset, MODEL_DIM)));
    }
  }
  return map;
}

/** 手动改/删一条记忆后清掉它的旁路向量：编辑保留 id，旧向量会继续按旧文本匹配，
 *  必须显式删掉让下次 ensureMemoryVectors 按新正文重算；删除是保险起见立即清理。 */
export function dropMemoryVectors(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return;
  const del = openDb().prepare("DELETE FROM mem WHERE id = ?");
  for (const id of list) del.run(id);
}

/** 给任意文本做语义排序（记忆板块的检索 / 「串联」用）：先补齐向量再算余弦。
 *  返回 [{id,text,ts,s,facets}]（s 为余弦相似度 0~1，恒为纯相似度），已按相关度降序。
 *  boostFacets（可选，如目标条目的方面标签）只在「难分伯仲」时给同方面条目 +0.02 平局加成：
 *  只影响排序先后，不参与门槛判定、不改返回的 s。本地模型不可用会抛错，调用方自行降级。 */
export async function semanticResults(
  text,
  { limit = 20, floor = -1, excludeId = null, boostFacets = null } = {},
) {
  const q = String(text ?? "").trim().slice(0, 500);
  if (!q) return [];
  const items = loadMemory(); // 时间新→旧（memory-store 已排序）
  if (!items.length) return [];
  await ensureMemoryVectors(items);
  const ex = await getExtractor();
  const [qv] = await embed(ex, [QUERY_PREFIX + q]);
  const vecs = loadVecMap(items);
  const scored = [];
  for (const it of items) {
    if (excludeId && it.id === excludeId) continue;
    const v = vecs.get(it.id);
    if (!v) continue;
    scored.push({ id: it.id, text: it.text, ts: it.ts, facets: it.facets, s: cosine(qv, v) });
  }
  const boost = boostFacets?.length ? new Set(boostFacets) : null;
  const rank = (r) => r.s + (boost && r.facets.some((f) => boost.has(f)) ? 0.02 : 0);
  return scored
    .filter((r) => r.s >= floor)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, limit);
}

/** 语义召回核心：返回注入文本。任何一步失败返回空串，由调用方决定回退 */
async function recallRaw(message) {
  if (!message) return "";
  const items = loadMemory(); // 时间新→旧（memory-store 已排序）
  if (!items.length) return "";
  await ensureMemoryVectors(items);
  const ex = await getExtractor();
  const [qv] = await embed(ex, [QUERY_PREFIX + message]);
  const vecs = loadVecMap(items);
  const scored = items
    .filter((it) => vecs.has(it.id))
    .map((it) => ({ it, vec: vecs.get(it.id), s: cosine(qv, vecs.get(it.id)) }));
  // 挑选逻辑集中在 pickRelevant（纯函数）：相关门槛 / 同义剪枝 / 话题簇限流 / 新鲜度排序
  const chosen = pickRelevant(scored);
  // 最近几条保底（还没被相关命中选中的）
  const recent = items.slice(0, TOP_RECENT).filter((it) => !chosen.some((c) => c.id === it.id));
  // 方面覆盖兜底：语义 + 最近已经把某些方面整面漏掉时，按新→旧补 1–2 条代表（不偏科）
  const excludedIds = new Set([...chosen, ...recent].map((it) => it.id));
  const backfill = coverageBackfill(items, excludedIds);
  const all = [...chosen, ...recent, ...backfill].slice(0, RECALL_CAP);
  if (!all.length) return "";
  const bullets = all.map((it) => `- ${it.text}`).join("\n").slice(0, MAX_CHARS);
  return `下面是这位用户的长效记忆（按与本轮消息的相关度挑出的，回答时自然用上、不要复述清单）：\n${bullets}`;
}

/** 供 /api/chat 使用：语义召回优先，模型不可用/异常时回退“最近 40 条”的旧行为。
 * 返回的文本自带完整前言（长效记忆/不要复述清单），调用方原样注入即可、不要再包一层。 */
export async function recallMemoryFacts(message) {
  try {
    const out = await recallRaw(message);
    if (out) return out;
  } catch {
    /* 落到下面的旧逻辑 */
  }
  try {
    const items = loadMemory().slice(0, 40);
    if (!items.length) return "";
    const bullets = items.map((it) => `- ${it.text}`).join("\n").slice(0, MAX_CHARS);
    return `下面是这位用户的长效记忆，回答时自然用上、不要复述清单：\n${bullets}`;
  } catch {
    return "";
  }
}

/** 服务启动时后台预热：让模型加载 + 首次全量向量化不落在第一句聊天上。
 *  DOOIT_NO_VECTOR_WARM=1 时跳过（沙盒/打包冒烟用，避免首启联网拉模型）。 */
export function warmMemoryVectors() {
  if (process.env.DOOIT_NO_VECTOR_WARM === "1") return;
  (async () => {
    try {
      await ensureMemoryVectors(loadMemory());
      await getExtractor();
    } catch {
      /* 预热失败没关系，对话时会再试并按需回退 */
    }
  })();
}
