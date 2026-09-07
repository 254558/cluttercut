// 「用户画像快照」：把全部长期记忆交给模型合成一张连贯的画像卡（身份 / 当前状态 /
// 目标 / 性格与行事风格 / 偏好 / 雷区），单独存 ai-profile.json（个人数据，已 gitignore）。
// 聊天入口恒定注入这张卡（chat.mjs），再叠加按问题语义召回的散条记忆——让建议始终
// 锚定用户的整体状况，而不是只依赖和本轮问题碰巧相关的碎片。
// 刷新有节流（记忆指纹变化 + 距上次成功 ≥10 分钟才真正调模型）；压缩整理成功后 force 一次；
// 任何失败静默保留旧卡，绝不影响聊天与提取。
import { dateKey, readJsonFile, writeJsonFile } from "./util.mjs";
import { apiKey, callDeepSeek } from "./deepseek.mjs";
import { loadMemory } from "./memory-store.mjs";
import { PROFILE_FILE } from "./paths.mjs";

const MIN_GAP_MS = 10 * 60 * 1000; // 记忆持续沉淀时，两次合成至少间隔这么久
const CARD_MAX = 1400; // 卡片正文上限（超出会被截断）

const PROFILE_SYSTEM = `你是这位用户的「画像整合员」。助手会把逐轮记录的全部长期记忆条目发给你——它们可能重复、过时或只言片语。请整合成一张「用户画像卡」，让之后任何一次回答都能基于它给出贴合他本人的建议。

规则：
1. 只整合、不新增：卡上每个信息都必须能在给定条目里找到依据；拿不准就略过，绝不脑补或编造。
2. 有依据的方面才写，一个要点一行、以「用户」开头，按重要性排：身份与背景 / 当前状态与正在推进的事 / 目标 / 性格与行事风格 / 偏好与习惯 / 雷区（如不喜欢绕弯子、讨厌套话）。
3. 现状只取条目里最新的说法（条目新的在前）：不要「计划去 X」和「已在 X」打架并存；被取代的旧表述直接忽略，不写进卡。
4. 条目太少或太杂时，宁可只写有把握的几行，也不要硬凑。
5. 简体中文，客观平实、像助手心里对他的认识；直接输出要点即可，不要编号模板、不要前后缀说明、不要逐句照抄记忆原文。
6. 不超过 900 字。`;

function memoryHash(items) {
  // 记忆指纹：loadMemory 已按时间新→旧排序，id:ts 即可代表“这条清单”，
  // 手动修改正文会顶新 ts → 指纹随之变化 → 纠错后画像快照会在下个节流窗口被刷新
  return items.map((it) => `${it.id}:${it.ts}`).join("|");
}

/** 读画像文件一次并统一解析（卡片文本 + 元信息）；没有卡或读失败一律空状态。
 *  loadProfileCard / loadProfileFull / 节流判断共用，不再各自重复读文件。 */
function readProfile() {
  const raw = readJsonFile(PROFILE_FILE, null);
  const card = typeof raw?.card === "string" ? raw.card.trim() : "";
  return {
    exists: !!card,
    card,
    at: Number(raw?.at) || 0,
    fromCount: Number(raw?.fromCount) || 0,
    hash: String(raw?.hash ?? ""),
  };
}

/** 聊天入口用的画像卡文本；还没有卡或读失败一律返回空串（不影响聊天） */
export function loadProfileCard() {
  return readProfile().card;
}

/** 画像完整状态（记忆板块展示用）：卡文本 + 元信息 */
export function loadProfileFull() {
  return readProfile();
}

function saveCard(card, items) {
  writeJsonFile(PROFILE_FILE, {
    at: Date.now(),
    hash: memoryHash(items),
    fromCount: items.length,
    card,
  });
}

/** 是否该重新合成：记忆有新增/变化（指纹不同）且距上次成功够久，或显式 force。
 *  纯函数，便于沙箱直接断言 gate 逻辑。 */
export function shouldRefreshProfile(meta, items, now, force) {
  if (!items || !items.length) return false;
  const h = memoryHash(items);
  if (force) return true;
  if (meta.hash === h) return false;
  return now - meta.at >= MIN_GAP_MS;
}

let building = false; // 单飞锁：合成是模型长调用，拒绝并发

async function synthesizeCard(items) {
  if (!apiKey()) return "";
  const list = items.map((it) => it.text).join("\n").slice(0, 30000);
  const raw = await callDeepSeek(
    [
      { role: "system", content: PROFILE_SYSTEM },
      {
        role: "user",
        content: `今天是 ${dateKey()}。长期记忆条目（新的在前，id 已省略）：\n${list}`,
      },
    ],
    { maxTokens: 1400, timeoutMs: 90000 },
  );
  let s = String(raw ?? "").trim();
  const fence = s.match(/```(?:markdown|md|json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  s = s.slice(0, CARD_MAX).trim();
  return s.length >= 20 ? s : ""; // 太短视为没整合出来，不落盘
}

/** 节流刷新入口：fire-and-forget 安全（内部全捕获），由记忆新增 / 手动修改 / 压缩整理后调用 */
export async function refreshProfileMaybe({ force = false } = {}) {
  if (building) return;
  const items = loadMemory();
  if (!items.length) return;
  const meta = readProfile();
  if (!shouldRefreshProfile(meta, items, Date.now(), force)) return;
  building = true;
  try {
    const card = await synthesizeCard(items);
    if (card) saveCard(card, items);
  } catch {
    /* 模型失败等一律静默：保留旧卡 */
  } finally {
    building = false;
  }
}
