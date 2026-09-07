/**
 * 双股螺旋（Twin Helix）点阵 —— 对齐 dotmatrix.zzzzshawn.cloud 的 DotmCircular13。
 * 该站的动画用 rAF 每帧算各点亮度；这里把 28 步/1750ms 的离散亮度曲线
 * 直接摊平成每个点一段独立的 CSS @keyframes（保留变化节点、线性插值做平滑），
 * 于是无需 JS 引擎也能逐像素复刻引用站的明暗分层：
 *
 *   strandOffset = sin(y·1.35 + θ·1.3) · 1.15      （y = row−2，θ = 步进相位）
 *   左右两条链互为镜像，位置为 ±strandOffset；
 *   某点亮度 = 距最近链的水平距离：<0.34 → 0.95（链芯）
 *                                   <0.8  → 0.5（近链）
 *   若处于两条链之间且 cos(y·2 + θ·2.1) > 0.55 → 0.3（链间 bridge 波）
 *   其余 → 0.07 底亮度。
 *
 * 5×5 网格：viewBox 24 内 cx = 2 + (x+2)·5，cy 同理；点的静止姿态取 θ=0。
 */
const STEP_COUNT = 28; // 引用站一步 = 1750ms / 28

const RAD = Math.PI * 2;
const OP_BASE = 0.07;
const OP_NEAR = 0.5;
const OP_STRAND = 0.95;
const OP_BRIDGE = 0.3;

/** 单个点在某离散步 k（0..STEP_COUNT-1）的亮度（与引用站 resolver 同式）。 */
function dotOpacity(x, y, k) {
  const th = (k / STEP_COUNT) * RAD;
  const off = Math.sin(y * 1.35 + th * 1.3) * 1.15;
  const d = Math.min(Math.abs(x + off), Math.abs(x - off));
  if (d < 0.34) return OP_STRAND;
  if (d < 0.8) return OP_NEAR;
  if (Math.cos(y * 2 + th * 2.1) > 0.55 && Math.abs(x) < Math.abs(off)) return OP_BRIDGE;
  return OP_BASE;
}

function kfName(x, y) {
  return `ds-h${x + 2}${y + 2}`;
}

/** 摊平成 @keyframes：只保留与相邻步不同的节点，0% 与 100% 恒等（周期闭合）。 */
function buildDotKf(x, y) {
  const vals = Array.from({ length: STEP_COUNT + 1 }, (_, k) => dotOpacity(x, y, k % STEP_COUNT));
  const stops = [];
  for (let k = 0; k < vals.length; k++) {
    if (k !== 0 && k !== vals.length - 1 && vals[k] === vals[k - 1] && vals[k] === vals[k + 1]) continue;
    const p = ((k * 100) / STEP_COUNT).toFixed(3).replace(/\.?0+$/, "");
    stops.push(`${p}%{opacity:${vals[k]}}`);
  }
  return `@keyframes ${kfName(x, y)}{${stops.join("")}}`;
}

function buildGrid() {
  const out = [];
  let css = "";
  for (let r = 0; r < 5; r++) {
    const y = r - 2;
    for (let c = 0; c < 5; c++) {
      const x = c - 2;
      css += buildDotKf(x, y);
      out.push({
        cx: 2 + c * 5,
        cy: 2 + r * 5,
        x,
        y,
        kf: kfName(x, y),
        base: dotOpacity(x, y, 0), // 静止姿态（θ=0），reduced-motion / 首帧兜底
      });
    }
  }
  return { grid: out, css };
}

const { grid: DMX_HELIX, css: DMX_HELIX_CSS } = buildGrid();

let styleInjected = false;
/** 往 <head> 注入全量 @keyframes（幂等，浏览器环境才执行）。 */
export function ensureDmxHelixCss() {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const style = document.createElement("style");
  style.id = "ds-helix-kf";
  style.textContent = DMX_HELIX_CSS;
  (document.head || document.documentElement).appendChild(style);
}

export { DMX_HELIX };
