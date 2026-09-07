// 欢迎字标「每次 App 运行只播一次」的运行级会话态。
// <script setup> 的作用域按组件实例隔离，卸载即丢；把「已认领播放 + 定格终帧」
// 放到真正的模块里，才能让之后每次新建对话/切回空会话重挂载时直接复用同一款
// 组合的静止结果、不再重摇、不再重播。刷新页面 = 新的运行（模块重新求值），
// 那时才允许再挑一款、再播一遍。

type WlFrame = {
  runs: { y: number; x: number; text: string; fg: string | null }[];
  bgs: { y: number; x: number; ch: string; bg: string }[];
};

export const wlSession: {
  /** 本次运行是否已有实例认领播放（认领后若没等到开播就被拆走，会释放） */
  started: boolean;
  /** 定格终帧是否已产出 */
  done: boolean;
  cols: number;
  rows: number;
  text: string;
  lastFrame: WlFrame | null;
  waiters: (() => void)[];
} = {
  started: false,
  done: false,
  cols: 0,
  rows: 0,
  text: "",
  lastFrame: null,
  waiters: [],
};

/** 等到本次运行的定格终帧产出后再执行；若已产出则立即执行。 */
export function whenWlStatic(cb: () => void) {
  if (wlSession.done) cb();
  else wlSession.waiters.push(cb);
}
