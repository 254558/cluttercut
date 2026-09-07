<script setup lang="ts">
/**
 * 主页欢迎区动态字标 —— 桌面 logo-maker(ttfx) 的 Vue 化移植。
 * 每次 App 运行只播一遍：首次挂载时随机挑 2 款 figlet 字标(见 welcome-logo-presets.js)
 * × 12 种精选特效之一，120fps 播完即定格；整段运行里之后再出现（新建对话/切回空会话）
 * 都直接画同一款组合的静止终帧，不重摇、不重播（含点击）。刷新页面 = 新的运行。
 * 一帧不依赖后端，纯静态也能播。
 * wasm 引擎: ttfx(TerminalTextEffects 的 Rust 移植, MIT) —— /dooit/ttfx.wasm（site/public/ 本地托管）
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { LOGO_PRESETS } from "../effects/welcome-logo-presets.js";
import { DMX_HELIX, ensureDmxHelixCss } from "../effects/dmx-dots.js";
import { wlSession, whenWlStatic } from "../effects/welcome-logo-session";
ensureDmxHelixCss();

const FONT_STACK = '"IBM Plex Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';

const EFFECTS = [
  "spray",
  "rain",
  "orbittingvolley",
  "middleout",
  "laseretch",
  "highlight",
  "expand",
  "fireworks",
  "errorcorrect",
  "bubbles",
  "bouncyballs",
  "blackhole",
];

const FPS = 120; // 播放节奏；这一款播完就定格，不自动循环
const WASM_URL = `${import.meta.env.BASE_URL}ttfx.wasm`;

const canvas = ref<HTMLCanvasElement | null>(null);
const loadErr = ref("");
const ready = ref(false);
const staticReady = ref(false); // 后续实例：静止终帧已画好（终帧到货前展示 loader）

// 每次运行只认第一个挂载的实例来「挑组合 + 播放」；播完（或在后台推进到定格）后，
// 后续实例只把同一款终帧静态画出来。auth 认领在 setup 就做，防止两个实例抢播。
const auth = !wlSession.started;
wlSession.started = true;
let begun = false; // 本次实例是否已真正开播（区分「没轮到播」和「播到一半被拆走」）

const showLoader = computed(() =>
  auth
    ? !ready.value && !loadErr.value
    : !loadErr.value && !staticReady.value,
);

let ctx: CanvasRenderingContext2D | null = null;
let ex: WebAssembly.Exports & Record<string, any> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let paused = false;
let uiGone = false; // 组件已卸载：不再碰 DOM/canvas，但 auth 实例可在后台把动画走完

/* ---------- 文字与网格 ---------- */

function normalizeText(t: string) {
  return t
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
function textSize(text: string) {
  const lines = text.split("\n");
  let cols = 0;
  for (const line of lines) cols = Math.max(cols, [...line].length);
  return { rows: lines.length, cols };
}

/* ---------- wasm io(移植自 logo-maker/app.js) ---------- */

let nameBuf: { ptr: number; cap: number; len: number } | null = null;
let textBuf: { ptr: number; cap: number; len: number } | null = null;

function ensureBuf(ref: { ptr: number; cap: number; len: number } | null, capacity: number) {
  if (ref && ref.cap >= capacity) return ref;
  const p = ex.fx_alloc(capacity);
  return { ptr: p, cap: capacity, len: 0 };
}
function writeBuf(refPtr: "nameBuf" | "textBuf", str: string) {
  const bytes = new TextEncoder().encode(str);
  const ref = ensureBuf(refPtr === "nameBuf" ? nameBuf : textBuf, Math.max(bytes.length + 1, 64));
  if (refPtr === "nameBuf") nameBuf = ref;
  else textBuf = ref;
  new Uint8Array(ex.memory.buffer, ref.ptr, bytes.length).set(bytes);
  ref.len = bytes.length;
  return ref;
}
function readCStr(ptr: number, len: number) {
  return len > 0 ? new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len)) : "";
}

/* ---------- 帧解析与绘制 ---------- */

let state = {
  cols: 0,
  rows: 0,
  frames: 0,
  seed: 1,
  effect: "",
  text: "",
  done: false, // 当前这款是否已播完（播完定格，不再循环）
};
let lastFrame: { runs: { y: number; x: number; text: string; fg: string | null }[]; bgs: { y: number; x: number; ch: string; bg: string }[] } = {
  runs: [],
  bgs: [],
};
let lastFrameText = ""; // 上一帧原始文本（连续相同判定格）
let stillFrames = 0; // 内容连续未变的帧数
let fontPx = 0;
let cellW = 0;
let cellH = 0;
let baselineAdj = 0;
let lastFire = 0;

function parseFrame(text: string) {
  const runs: { y: number; x: number; text: string; fg: string | null }[] = [];
  const bgs: { y: number; x: number; ch: string; bg: string }[] = [];
  let row = 0;
  let x = 0;
  let run: { y: number; x: number; text: string; fg: string | null } | null = null;
  let fg: string | null = null;
  let bg: string | null = null;
  const flush = () => {
    if (run) {
      runs.push(run);
      run = null;
    }
  };
  const push = (ch: string) => {
    if (ch === "\n") {
      flush();
      row++;
      x = 0;
      fg = null;
      bg = null;
      return;
    }
    if (ch === " " || ch === "\u2001") {
      // U+2001(全方空格)是 ANSI Regular 字形里的"正好一格宽"占位符：
      // 只能推进列号，绝不能随 run 一起 fillText——画布会按它的 1em 步进
      // 推进笔尖(≈1.67 格)，把该段后面每个方块字都推出格子。
      if (bg) bgs.push({ y: row, x, ch, bg });
      x++;
      return;
    }
    if (run && run.fg === fg && run.y === row && run.x + run.text.length === x) {
      run.text += ch;
    } else {
      flush();
      run = { y: row, x, text: ch, fg };
    }
    x++;
  };
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 0x1b) {
      if (text[i + 1] === "[") {
        let j = i + 2;
        let params = "";
        while (j < text.length && text[j] !== "m") {
          params += text[j];
          j++;
        }
        const parts = params.split(";").map(Number);
        if (parts[0] === 0) {
          fg = null;
          bg = null;
        } else if (parts[0] === 38 && parts[1] === 2) {
          fg = `rgb(${parts[2]},${parts[3]},${parts[4]})`;
        } else if (parts[0] === 48 && parts[1] === 2) {
          bg = `rgb(${parts[2]},${parts[3]},${parts[4]})`;
        }
        i = j + 1;
      } else {
        i += 2;
      }
      continue;
    }
    const ch = text[i];
    push(ch);
    i += ch.codePointAt(0)! > 0xffff ? 2 : 1;
  }
  flush();
  return { runs, bgs };
}

function measureFont(size: number) {
  ctx!.font = `${size}px ${FONT_STACK}`;
  const m = ctx!.measureText("M");
  const g = ctx!.measureText("█");
  return {
    charW: m.width,
    cellH: size * 1.28,
    ascent: g.actualBoundingBoxAscent,
  };
}

/** 让字标在欢迎区里尽量大又不溢出：按容器宽/高回退字号 */
function layoutCanvas() {
  const cv = canvas.value!;
  // 以欢迎区容器为准（.wl 是居中的子元素，宽度会被内容撑住，不能作为测量依据）
  const host = cv.closest(".ds-welcome") as HTMLElement | null;
  const availW = Math.max(
    260,
    Math.min((host?.clientWidth ?? window.innerWidth) - 24, 1100),
  );
  const availH = Math.max(
    140,
    Math.min(
      (host?.clientHeight ?? window.innerHeight * 0.5) - 64,
      window.innerHeight * 0.5,
    ),
  );
  let size = 28;
  for (;;) {
    const m = measureFont(size);
    const w = m.charW * state.cols;
    const h = m.cellH * state.rows;
    // 允许一路缩到 4px：手机窄栏里宽字形也要能塞进容器，而不是硬截断
    if ((w <= availW && h <= availH) || size <= 4) {
      fontPx = size;
      cellW = m.charW;
      cellH = m.cellH;
      baselineAdj = m.ascent;
      break;
    }
    size -= 1;
  }
  const m = measureFont(fontPx);
  cellW = m.charW;
  cellH = m.cellH;
  baselineAdj = m.ascent;

  const cssW = Math.ceil(cellW * state.cols);
  const cssH = Math.ceil(cellH * state.rows);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.style.width = `${cssW}px`;
  cv.style.height = `${cssH}px`;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx!.font = `${fontPx}px ${FONT_STACK}`;
  ctx!.textBaseline = "alphabetic";
}

// 字标墨色/画布纸色走令牌（--do-text-0 纯白 / --do-bg），挂载后首次取到就缓存；
// 兜底值 = 当前深色主题的等价灰度，令牌缺失时也能正确显形
let _ink = "";
let _paper = "";
function themeColors() {
  if (!_ink || !_paper) {
    const s = getComputedStyle(document.documentElement);
    _ink = s.getPropertyValue("--do-text-0").trim() || "#ffffff";
    _paper = s.getPropertyValue("--do-bg").trim() || "#1d1f22";
  }
  return { ink: _ink, paper: _paper };
}

function paintFrame(frame: ReturnType<typeof parseFrame>) {
  const { ink, paper } = themeColors();
  const cv = canvas.value!;
  ctx!.fillStyle = paper;
  ctx!.fillRect(0, 0, cv.width, cv.height);
  const yAt = (row: number) => row * cellH + baselineAdj;
  for (const r of frame.runs) {
    // 上一格若画过背景会把 fillStyle 改成纸色，null 前景色必须显式复位
    ctx!.fillStyle = r.fg ?? ink;
    ctx!.fillText(r.text, r.x * cellW, yAt(r.y));
  }
  for (const c of frame.bgs) {
    ctx!.fillStyle = c.bg;
    ctx!.fillRect(c.x * cellW, c.y * cellH, cellW, cellH);
    ctx!.fillStyle = paper;
    ctx!.fillText(c.ch, c.x * cellW, yAt(c.y));
  }
}

/* ---------- 播放控制：每次运行只播一遍，播完即定格 ---------- */

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const LAST_COMBO_KEY = "dc-wl-last-combo";

function rememberCombo(font: string, effect: string) {
  try {
    sessionStorage.setItem(LAST_COMBO_KEY, JSON.stringify({ font, effect }));
  } catch {
    /* 隐私模式等读不到 storage 时忽略 */
  }
}
function lastCombo(): { font: string; effect: string } | null {
  try {
    const raw = sessionStorage.getItem(LAST_COMBO_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d && typeof d.font === "string" && typeof d.effect === "string") return d;
  } catch {
    /* 同上 */
  }
  return null;
}

/** 随机挑一款「字体+特效」；连续两次进页面尽量不撞同一款 */
function pickCombo() {
  const last = lastCombo();
  let font = pickRandom(LOGO_PRESETS);
  let effect = pickRandom(EFFECTS);
  for (let i = 0; i < 8 && last && font.label === last.font && effect === last.effect; i++) {
    font = pickRandom(LOGO_PRESETS);
    effect = pickRandom(EFFECTS);
  }
  rememberCombo(font.label, effect);
  return { font, effect };
}

function build(): boolean {
  const name = writeBuf("nameBuf", state.effect);
  const text = writeBuf("textBuf", state.text);
  const [w, h] = canvasDims();
  const rc = ex.fx_build(name.ptr, name.len, text.ptr, text.len, w, h, FPS, state.seed >>> 0, Math.floor(state.seed / 0x100000000));
  if (rc !== 0) {
    loadErr.value = `构建失败（${state.effect}）: ${readCStr(ex.fx_error(), ex.fx_error_len())}`;
    return false;
  }
  loadErr.value = "";
  state.cols = ex.fx_cols();
  state.rows = ex.fx_rows();
  state.frames = 0;
  layoutCanvas();
  paintFrame({ runs: [], bgs: [] });
  return true;
}

function canvasDims(): [number, number] {
  const { cols: tc, rows: tr } = textSize(state.text);
  const w = Math.min(150, Math.max(60, tc + 24));
  const h = Math.min(40, Math.max(12, tr + 8));
  return [w, h];
}

/** 播放 state 里当前这款（先已选好字体/特效/种子）；播完自动定格 */
function startPlay() {
  if (uiGone || !ex) return;
  begun = true;
  state.done = false;
  state.frames = 0;
  if (!build()) return;
  lastFire = performance.now();
  scheduleTick(16);
}

function endRun() {
  state.done = true; // 定格：停在最后一帧，不再推进
  // 把定格结果存进运行级会话：后续实例直接复用，不再重新组合/播放
  wlSession.cols = state.cols;
  wlSession.rows = state.rows;
  wlSession.text = state.text;
  wlSession.lastFrame = lastFrame;
  wlSession.done = true;
  const waiters = wlSession.waiters;
  wlSession.waiters = [];
  for (const cb of waiters) cb();
}

function stepOnce() {
  if (!ex || state.done) return;
  const r = ex.fx_step();
  if (r >= 0) {
    state.frames++;
    const bytes = new Uint8Array(ex.memory.buffer, ex.fx_frame(), r);
    const text = new TextDecoder().decode(bytes);
    // 组件被拆走时不再画（无 DOM），只把帧推进到定格，让后续实例能拿到终帧
    if (text === lastFrameText) stillFrames++;
    else {
      lastFrameText = text;
      stillFrames = 0;
    }
    lastFrame = parseFrame(text);
    if (!uiGone && canvas.value) paintFrame(lastFrame);
    // 视觉定格即算播完：fx_step 在终帧后还会继续吐同一帧（有的特效直到很晚
    // 才返回 -1），只等结束信号会让「定格+快照」拖到几秒甚至永不发生。
    if (state.frames > 40 && stillFrames >= 60) endRun();
    else if (state.frames > 900 * FPS) endRun(); // 兜底：个别特效不结束也停住
    return;
  }
  endRun();
}

function scheduleTick(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, Math.max(1, delayMs));
}

function tick() {
  if (state.done) return; // 播完即静置，不再起新定时器
  if (paused && !uiGone) {
    scheduleTick(300);
    return;
  }
  const now = performance.now();
  const iv = 1000 / FPS;
  if (ex && state.cols && now - lastFire >= iv * 0.8) {
    lastFire = now;
    stepOnce();
  }
  if (!state.done) scheduleTick(iv - Math.max(0, now - lastFire));
}

/* ---------- 生命周期 ---------- */

let wasmPromise: Promise<boolean> | null = null;
function loadEngine(): Promise<boolean> {
  if (!wasmPromise) {
    wasmPromise = fetch(WASM_URL, { cache: "no-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
        ex = instance.exports;
        ready.value = true;
        return true;
      })
      .catch((err: Error) => {
        loadErr.value = `ttfx 引擎加载失败：${err.message}`;
        wlSession.started = false; // 引擎不可用：让后续挂载可以重新接管/重试
        return false;
      });
  }
  return wasmPromise;
}

function onVisibility() {
  paused = document.hidden;
  if (!paused && !state.done) {
    lastFire = performance.now();
    scheduleTick(16); // 切回来且还没播完时，继续推进
  }
}

/** 后续实例：直接复用本次运行的组合与定格终帧，不碰引擎、不重摇 */
function paintStaticFromSession() {
  if (uiGone || !canvas.value || !ctx) return;
  if (!wlSession.cols || !wlSession.lastFrame) return;
  state.cols = wlSession.cols;
  state.rows = wlSession.rows;
  state.text = wlSession.text;
  lastFrame = wlSession.lastFrame;
  layoutCanvas();
  paintFrame(lastFrame);
  staticReady.value = true;
  // 字体就绪后按真实字宽重新排版一次（静态帧同样受益，避免字体切换造成字距偏差）
  document.fonts?.ready.then(() => {
    if (!uiGone && state.cols) {
      layoutCanvas();
      paintFrame(lastFrame);
    }
  });
  window.addEventListener("resize", onResize);
}

onMounted(async () => {
  const cv = canvas.value;
  if (!cv) return;
  ctx = cv.getContext("2d");

  if (!auth) {
    // 本次运行已播过：不再组合、不再重播——直接画同一款组合的静止终帧；
    // 首实例仍在后台收尾时先亮 loader，终帧一到立即补画。
    if (wlSession.done && wlSession.lastFrame) {
      paintStaticFromSession();
    } else {
      whenWlStatic(() => {
        if (!uiGone && canvas.value) paintStaticFromSession();
      });
    }
    return;
  }

  const ok = await loadEngine();
  if (!ok || uiGone || !ctx) return;
  // 只在本次运行的首次挂载里随机挑一款「字体+特效」（尽量不与上次刷新撞款），播一遍
  const { font, effect } = pickCombo();
  state.text = normalizeText(font.art);
  state.effect = effect;
  state.seed = (Math.random() * 0x100000000) >>> 0;
  startPlay();
  // 等 IBM Plex Mono 等宽字体就绪后按真实字宽重新排版一次（避免字体切换造成字距偏差）
  document.fonts?.ready.then(() => {
    if (!uiGone && state.cols) {
      layoutCanvas();
      paintFrame(lastFrame);
    }
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);
});

function onResize() {
  if (!state.cols || uiGone) return;
  layoutCanvas();
  paintFrame(lastFrame);
}

onBeforeUnmount(() => {
  uiGone = true;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("resize", onResize);
  if (!auth) return; // 静止实例：没有播放状态，直接收
  if (!begun) {
    // 首实例没轮到开播就被拆走（如引擎还在加载）：把「已播」让渡给下一个实例
    wlSession.started = false;
  } else if (!wlSession.done) {
    // 播到一半被拆走：不能靠后台定时器收尾——页面/面板一旦隐藏，浏览器会把
    // setTimeout 节流到每秒一次，剩余几百帧会拖成几分钟。这里同步把剩余帧
    // 推到定格并快照，让之后挂载的实例能立刻画出同一终帧。
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (let i = 0; i < 12000 && ex && !state.done; i++) stepOnce();
    if (!state.done) endRun(); // 极限兜底：无论如何都要把定格快照落给后续实例
  } else if (timer) {
    clearTimeout(timer);
    timer = null;
  }
});
</script>

<template>
  <div class="wl">
    <canvas ref="canvas" class="wl-canvas" aria-label="ClutterCut 动态字标"></canvas>
    <div v-if="showLoader" class="ds-dmx ds-dmx--lg" aria-label="Loading">
      <svg viewBox="0 0 24 24">
        <circle
          v-for="d in DMX_HELIX"
          :key="d.x + '-' + d.y"
          :cx="d.cx"
          :cy="d.cy"
          r="1.6"
          fill="currentColor"
          class="ds-dmx-dot"
          :style="{ animationName: d.kf, opacity: d.base }"
        />
      </svg>
    </div>
    <p v-if="!ready && loadErr" class="wl-fallback">{{ loadErr }}</p>
  </div>
</template>

<style scoped>
.wl {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  max-width: 100%;
}
.wl-canvas {
  display: block;
  margin: 0 auto;
  image-rendering: pixelated;
}
.wl-fallback {
  color: var(--do-text-3);
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  margin: 0;
}
</style>
