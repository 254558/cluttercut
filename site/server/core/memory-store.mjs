// ai-memory.json 属主：长期记忆（个人信息，只存本机、已 gitignore）。
// 读/写/封顶都只走这里；mem-recall / memory.mjs / memory-tidy.mjs 都从本模块取数。
// 每条记忆除 id/text/ts 外可带 facets（「方面」软标签，1–3 个，白名单固定见下）。
// loadMemory 是 facets 存活的唯一咽喉：任何来源（落盘/模型输出/板块新增）都要经它归一化，
// 白名单外/超量的标签在这里被过滤掉；saveMemory 原样透传。
import { readJsonFile, writeJsonFile } from "./util.mjs";
import { MEMORY_FILE } from "./paths.mjs";

// 条数上限：1 万（用户要求从 100 放宽——100 条容易“塞满”、超限静默挤掉最旧的事实；纯本地
// JSON，万级排序/落盘仍轻量）。真正约束规模的还有 memory-tidy 的 AUTO_TIDY_AT=500 自动整理。
const MEMORY_MAX = 10000;

// 全站唯一的「方面」白名单：自动提取 prompt、手动打标、召回覆盖、板块筛选都认这组词。
// 展示顺序即此处顺序（前端 MemoryBoard 筛选 chips 需与它保持一致）；要加新方面时，
// 同步改 memory.mjs 的打标提示词，旧记忆可借「补标签」动作慢慢带上新方面。
export const MEMORY_FACETS = [
  "身份背景",
  "技能工具",
  "工作项目",
  "目标计划",
  "偏好习惯",
  "性格风格",
  "雷区注意",
  "家庭人际",
  "健康时间",
];

const FACETS_MAX = 3; // 一条记忆最多几个方面：软标签要克制，多了等于没分

/** 白名单化方面标签：只认 MEMORY_FACETS 里的词、去重、按白名单顺序、最多 FACETS_MAX 个。
 *  facets 是「软标签」，只用来铺匀召回名额 / 串联时同方面优先 / 板块按方面浏览，
 *  不参与向量相似度计算（相关度判据仍是纯余弦，见 mem-recall.mjs）。 */
export function sanitizeFacets(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const out = [];
  for (const f of MEMORY_FACETS) {
    if (raw.includes(f) && !out.includes(f)) out.push(f);
    if (out.length >= FACETS_MAX) break;
  }
  return out;
}

export function loadMemory() {
  const raw = readJsonFile(MEMORY_FILE, null);
  if (raw && Array.isArray(raw.items)) {
    return raw.items
      .filter((it) => it && typeof it.text === "string")
      .map((it) => ({
        id: String(it.id ?? ""),
        text: String(it.text).trim().slice(0, 420),
        ts: Number(it.ts) || 0,
        facets: sanitizeFacets(it.facets),
      }))
      .filter((it) => it.id && it.text)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MEMORY_MAX);
  }
  return [];
}

export function saveMemory(items) {
  const out = [...items].sort((a, b) => b.ts - a.ts).slice(0, MEMORY_MAX);
  writeJsonFile(MEMORY_FILE, { items: out });
}
