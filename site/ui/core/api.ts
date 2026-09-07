// 主题统一的 /api 请求层：Vite dev 把 /api/* 代理到本机 AI 服务
// （site/scripts/local.mjs），各页面组件的请求都走这里。
// 约定：apiRequest 非 2xx → 抛错（消息取响应体前 300 字符，
// 取不到再退 HTTP 状态码）；2xx → 按 JSON 解析返回（解析失败直接 reject）。
// 是否还要看响应里的 ok 字段，由调用方按各自语义把关——不同接口在这点上
// 原本就不一致，这里不做统一裁决。
// 静态构建 / 纯静态预览下端点不存在，fetch 会直接 reject → 各调用方兜底文案。
//
// tryPost 是不抛错的变体：网络失败、非 2xx、解析失败都收敛进返回结构，
// 适合「失败静默 / 失败要给用户看一行提示」的调用方。

export async function apiRequest<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface TryPostResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  errorText: string;
}

/** POST 但不抛错：非 2xx / 网络失败都返回 { ok:false }，errorText 优先取响应体 error 字段 */
export async function tryPost<T = unknown>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<TryPostResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      // 无 body 时不带 Content-Type（如 POST /api/backup），与旧版直连 fetch 一致
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      ...init,
    });
  } catch (e) {
    return { ok: false, status: 0, data: null, errorText: String((e as Error)?.message ?? e) };
  }
  const data = (await res.json().catch(() => null)) as T | null;
  if (!res.ok) {
    const errorText =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? ((data as { error: string }).error as string)
        : res.statusText || `HTTP ${res.status}`;
    return { ok: false, status: res.status, data, errorText };
  }
  return { ok: true, status: res.status, data, errorText: "" };
}
