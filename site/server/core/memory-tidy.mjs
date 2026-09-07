// 「压缩整理」长期记忆（原 organize 附带的 tidyMemory 回归，只保留本机记忆场景）：
// 记忆按轮自动提取，时间久了会积下重复、互相覆盖、已过时或被新信息取代的条目。
// 把整单交给模型出「删 / 合」方案，经两道护栏（数量底线 + 引用链兜底）校验后，
// 先把被删/被合并的原文追加归档到 ai-memory-archive.json，再落盘 ai-memory.json。
// 任何失败都安全返回 ran:false、记忆未改动；HTTP 挂载在 handlers/memory.mjs。
// 合并重建出的条目会继承所有来源条目的 facets 并集（经 sanitizeFacets 去重、限 3 个），
// 否则一整理标签就丢，方面筛选/覆盖兜底就慢慢失效了。
import { readFileSync, writeFileSync } from "node:fs";
import { dateKey, parseLooseJson, uid } from "./util.mjs";
import { apiKey, callDeepSeek } from "./deepseek.mjs";
import { loadMemory, saveMemory, sanitizeFacets } from "./memory-store.mjs";
import { MEMORY_ARCHIVE_FILE } from "./paths.mjs";

const COMPACT_MIN = 8; // 低于这个条数不空跑模型（旧 tidyMemory 同阈值）
const MAX_ROUNDS = 3; // 方案连续「过猛」的容忍轮数
const ARCHIVE_CAP = 30; // ai-memory-archive.json 只留最近 N 次快照
const ARCHIVE_LABEL = "site/data/ai-memory-archive.json"; // 给用户的展示路径（不暴露机器绝对路径）

// —— 自动后台整理 ——
// 记忆每轮自动提取会缓慢增长；存储上限已放宽到 1 万条（memory-store），不再 100 条就静默挤旧。
// 记忆攒到约 500 条就整理一次，把搜索面压在健康规模：不再依赖“用户记得手动点压缩整理”。
// 有冷却（内存态，重启后失效可接受：自动整理失败/没得整理时盘面不变，重启只多试一次）。
const AUTO_TIDY_AT = 500; // 条数 ≥ 此值触发（给 1 万上限留出积累空间：能攒到几百条才整理）
const AUTO_TIDY_COOLDOWN_MS = 4 * 3600 * 1000; // 两次自动整理至少间隔 4 小时

let running = false; // 单飞锁：压缩整理要几十秒，拒绝并发触发
let lastAutoAt = 0; // 上次自动整理的发起时刻（进程内）

/**
 * 后台自动整理入口：条数够多、冷却已过、没有整理在跑时才真正调 compactMemory。
 * 返回 compactMemory 的完整结果（调用方成功后可 force 重绘画像），没触发返回 null。
 * 完全静默——自动整理失败不打扰聊天；手动压缩整理（/api/memory compact）不受这里的冷却约束。
 */
export async function maybeAutoTidy() {
  if (running) return null;
  const items = loadMemory();
  if (items.length < AUTO_TIDY_AT) return null;
  const now = Date.now();
  if (now - lastAutoAt < AUTO_TIDY_COOLDOWN_MS) return null;
  lastAutoAt = now;
  return compactMemory();
}

/** 给模型看的整理规则；条数引导随本次实际规模生成（旧版把 97 条写死在模板里） */
function tidySystemText(n, floor, low, high, soft) {
  return `你是这位用户的「长期记忆整理员」。他的助手把关于他的事实存在「长期记忆」里，时间久了会出现重复、过时、琐碎的条目，请把清单整理得更精炼有用。目标不是把条数压到最少，而是「消除重复与过时、不丢任何画像信息」。

安全第一（拿不准就保留，宁可多留也绝不误删）：
1. 完全重复 / 互相包含 / 明显是同一件事的多个说法 → merge 成一条精炼的，覆盖所有要点。同一主题但各条含不同信息点的变体（例：睡眠方面有“作息目标 11 点前睡”“入睡困难/睡眠不规律”“实际熬夜到凌晨”几条）也要 merged 成一条覆盖所有信息点；只有信息被另一条完整覆盖的纯冗余，才允许直接 remove。
2. 已被更新信息取代的旧条目 → remove（例：他先说过“计划去广州发展”，后来明确“已到广州上班”，删掉“计划/考虑去广州”这类旧表述）。
3. 一次性、已经失效的时间安排（根据“今天日期”判断已过期的“明天/后天/几号去…/约了…”）→ remove。
4. 纯瞬时情绪、随口吐槽、只剩当时语境的细节 → remove；有点拿不准是不是长期习惯/状态的，保留。
5. 画像级事实（名字、家人朋友、身份/职业、所在城市、工作、健康、习惯、偏好、性格与行事风格、项目、兴趣、长期目标）→ 一律保留，即使看着“暂时用不上”。
6. 只要存在完全重复或明显同义的条目，就绝不能输出空方案：至少要 merge/remove 到每组只剩最完整的一条。
7. 条数把握：这是健康的目标范围而不是精确要求——本次清单 ${n} 条，请把压缩后的总数控制在 ${low}~${high} 条左右（原规模约 45%~60%），只处理最有把握的重复/被取代/过时条目，拿不准的保留。宁可多留几条冗余，也不要合并过头把不同事实揉成一条长文本；若处理完仍超过 ${soft} 条再删最琐碎的到不超过 ${soft} 条（reason 注明“控制总量”）。压缩后低于 ${floor} 条基本就是删过头了，请放宽、少删少合。
8. 合并出的 text 必须保留被合并条目里的关键具体信息：姓名、人物、地点、项目名、数字、时间范围都别丢；同一事实不同说法冲突时，保留时间较新的说法。
9. 拿不准时效的行程、金额、账号等敏感但有价值的，倾向保留。

只输出一行 JSON：
{"removed":[{"id":"…","reason":"为什么删"}],"merged":[{"ids":["…","…"],"text":"合并后的一句话","reason":"为什么合并"}]}
- id 必须原样来自清单；同一条只能出现在一处；没列出来的条目一律原样保留。
- 不要改动保留条目的文字；合并后的 text 是新的精炼表述，要覆盖原条目的所有要点。
- 不要 JSON 以外的任何文字。`;
}

/** 解析整理模型的输出；只认清单里真实存在、且没有重复出现的 id */
function parseMemoryTidyPlan(raw, byId) {
  const data = parseLooseJson(raw);
  if (!data) return { removed: [], merged: [] };
  const used = new Set();
  const removed = [];
  for (const r of Array.isArray(data.removed) ? data.removed : []) {
    const id = String(r?.id ?? "");
    if (id && byId.has(id) && !used.has(id) && typeof r?.reason === "string") {
      used.add(id);
      removed.push({ id, reason: String(r.reason).slice(0, 80) });
    }
  }
  const merged = [];
  for (const m of Array.isArray(data.merged) ? data.merged : []) {
    const ids = Array.isArray(m?.ids)
      ? m.ids.map((x) => String(x)).filter((id) => byId.has(id) && !used.has(id))
      : [];
    if (ids.length < 2) continue;
    for (const id of ids) used.add(id);
    merged.push({
      ids,
      text: String(m?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 420),
      reason: String(m?.reason ?? "").slice(0, 80),
    });
  }
  return { removed, merged };
}

/**
 * 跑一轮「让模型出方案 → 解析 → 护栏剔除有引用链风险的误删 → 数量底线校验」。
 * ctx 承载本次整理的共享上下文（由 compactMemory 组装）；nudge 是给模型的追加提醒
 * （首轮为空串，过猛重试时引导收敛）。返回 { ok } / { fail } / { aggressive }。
 */
async function proposeRound({ items, byId, userBase, floor, low, high, soft }, nudge) {
  const u0 = nudge ? `${userBase}\n\n（注意：${nudge}）` : userBase;
  let plan;
  let broken = false; // 模型输出不完整/异常（不是“确实没得整理”）
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt
      ? `${u0}\n\n（注意：你上一次的输出不完整或不是合法 JSON。请只输出一行完整 JSON，不要截断、不要多余文字。）`
      : u0;
    let raw;
    try {
      raw = await callDeepSeek(
        [
          { role: "system", content: tidySystemText(items.length, floor, low, high, soft) },
          { role: "user", content: user },
        ],
        { maxTokens: 8192, timeoutMs: 120000 },
      );
    } catch (e) {
      return { fail: `模型调用失败（${String(e.message).slice(0, 60)}），记忆未改动` };
    }
    plan = parseMemoryTidyPlan(raw, byId);
    if (plan.removed.length || plan.merged.length) break;
    // 合法空方案 = 确实没得整理；只有解析失败/截断才重试一次
    if (parseLooseJson(raw) !== null) {
      broken = false;
      break;
    }
    broken = true;
  }

  const removedOut = [];
  const mergedOut = [];
  const gone = new Set();
  for (const r of plan.removed) {
    gone.add(r.id);
    removedOut.push({ id: r.id, text: byId.get(r.id).text, reason: r.reason });
  }
  let mergedItems = 0;
  for (const m of plan.merged) {
    const live = m.ids.filter((id) => !gone.has(id));
    if (live.length < 2) continue;
    for (const id of live) gone.add(id);
    mergedItems += live.length;
    mergedOut.push({
      ids: live,
      texts: live.map((id) => byId.get(id).text),
      text: m.text,
      reason: m.reason,
    });
  }
  // 护栏：模型常把「和 X 重复、已合并」的条目放进 removed，却把 X 也一起删了
  // （引用链成环、无人幸存）——这种“合并式删除”如果没有真正的幸存者/合并文本兜底，
  // 会整组丢信息。凡理由里引用了其它条目 id 的删除，必须能沿引用链到达一个
  // 「未删条目」或「合并组源头」，否则把该条放回（保守保留）。
  const mergedSourceSet = new Set();
  for (const m of mergedOut) m.ids.forEach((id) => mergedSourceSet.add(id));
  const removedMap = new Map(removedOut.map((r) => [r.id, r]));
  const refIds = (reason) => (String(reason).match(/[a-z0-9]{11,14}/g) || []).filter((id) => byId.has(id));
  const hasSafeHome = (id, seen = new Set()) => {
    if (mergedSourceSet.has(id)) return true; // 会并入一条新的合并文本
    if (!removedMap.has(id)) return true; // 原样保留的幸存条目
    if (seen.has(id)) return false; // 引用成环，没人真正留下
    seen.add(id);
    return refIds(removedMap.get(id).reason).some((nid) => hasSafeHome(nid, seen));
  };
  const finalRemoved = removedOut.filter((r) => {
    const refs = refIds(r.reason);
    if (!refs.length) return true; // 语义删除（过时/瞬时/被明确取代），无引用链可查，放行
    return refs.some((nid) => hasSafeHome(nid));
  });
  const droppedBack = removedOut.length - finalRemoved.length;
  if (droppedBack) {
    removedOut.splice(0, removedOut.length, ...finalRemoved);
    const keptIds = new Set(finalRemoved.map((r) => r.id));
    // gone = 最终删除的 id ∪ 合并源 id；被放回的条目要从 gone 里剔除
    for (const id of [...gone]) {
      if (!keptIds.has(id) && !mergedSourceSet.has(id)) gone.delete(id);
    }
  }
  if (!removedOut.length && !mergedOut.length) {
    return {
      fail: broken
        ? "模型这次没给出可用的整理方案（输出不完整），记忆未改动，可稍后再试一次"
        : `检查了 ${items.length} 条记忆，没发现需要删除或合并的`,
    };
  }
  const finalItems = items.filter((it) => !gone.has(it.id));
  for (const m of mergedOut) {
    finalItems.push({
      id: uid(),
      text: m.text,
      ts: Math.max(...m.ids.map((id) => byId.get(id).ts || 0)),
      // 合并文本覆盖了所有来源要点，方面标签也取来源并集继承下来（白名单化、限 3 个）
      facets: sanitizeFacets(m.ids.flatMap((id) => byId.get(id).facets || [])),
    });
  }
  if (finalItems.length < floor) {
    return { aggressive: true };
  }
  return { ok: { removedOut, mergedOut, mergedItems, finalItems } };
}

/** 压缩长期记忆（一次完整整理）。成功会把原文归档进 ai-memory-archive.json 后重写
 *  ai-memory.json；模型失败/无 Key/方案过猛一律 ran:false 且不动盘。 */
export async function compactMemory() {
  if (running) {
    return { ran: false, busy: true, reason: "上一次压缩整理还在进行，请稍后再点" };
  }
  const items = loadMemory();
  if (items.length < COMPACT_MIN) {
    return { ran: false, reason: `记忆还不多（${items.length} 条），暂无需要整理` };
  }
  if (!apiKey()) {
    return { ran: false, reason: "未配置 DeepSeek Key，暂时无法整理记忆" };
  }
  running = true;
  try {
    const byId = new Map(items.map((it) => [it.id, it]));
    const userBase = `今天日期：${dateKey()}\n\n长期记忆清单（id 与内容）：\n${items
      .map((it) => `${it.id}\t${it.text}`)
      .join("\n")}`.slice(0, 30000);
    // 激进方案中止线：模型偶发会“合并过头”把几十条压成个位数（关键事实也被揉丢）。
    // 压缩后少于下限视为不可信，整单作废、绝不动盘。
    // 下限必须低于引导区间（low~high）的下沿：否则模型按引导压到区间内反而被判「过猛」，
    // 白白空转 3 轮——下限只拦「删到只剩零头」的真激进方案。
    const floor = Math.max(10, Math.round(items.length * 0.3));
    const low = Math.round(items.length * 0.45);
    const high = Math.round(items.length * 0.6);
    const soft = Math.max(high, Math.round(items.length * 0.72));
    const ctx = { items, byId, userBase, floor, low, high, soft };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const nudge =
        round === 0
          ? ""
          : `你上一次的方案过于激进，把 ${items.length} 条压到了 ${floor} 条以下。这次请克制：只合并最明显、最确定的重复/被取代条目，压缩后总条数保留在 ${low}~${high} 条左右（下限 ${floor} 条），拿不准的全部保留。`;
      const res = await proposeRound(ctx, nudge);
      if (res.fail) {
        return { ran: false, reason: res.fail };
      }
      if (res.aggressive) continue; // 换一轮重试
      const { removedOut, mergedOut, mergedItems, finalItems } = res.ok;
      finalItems.sort((a, b) => b.ts - a.ts);
      // 先备份再删，可回滚
      const snap = {
        at: new Date().toISOString(),
        removed: removedOut.map(({ id, text, reason }) => ({ id, text, reason })),
        merged: mergedOut.map((m) => ({ sources: m.texts, into: m.text, reason: m.reason })),
      };
      try {
        const prev = JSON.parse(readFileSync(MEMORY_ARCHIVE_FILE, "utf8"));
        if (!Array.isArray(prev)) throw new Error("bad archive");
        prev.push(snap);
        if (prev.length > ARCHIVE_CAP) prev.splice(0, prev.length - ARCHIVE_CAP);
        writeFileSync(MEMORY_ARCHIVE_FILE, JSON.stringify(prev, null, 2), "utf8");
      } catch {
        writeFileSync(MEMORY_ARCHIVE_FILE, JSON.stringify([snap], null, 2), "utf8");
      }
      saveMemory(finalItems);
      return {
        ran: true,
        before: items.length,
        after: finalItems.length,
        removedCount: removedOut.length,
        mergedGroups: mergedOut.length,
        mergedItems,
        archiveFile: ARCHIVE_LABEL,
      };
    }
    return {
      ran: false,
      reason: `连试 ${MAX_ROUNDS} 轮模型方案都过猛（都想压到 ${floor} 条以下），已中止、记忆未改动；可稍后再点一次`,
    };
  } finally {
    running = false;
  }
}
