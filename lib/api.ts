// 同源 Function 调用封装：错误码由服务端定义，这里只负责映射成可展示的中文文案，
// 不把服务端原始错误或上游返回直接抛给界面。
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 非 2xx 响应按 HTTP status 的兜底映射：网关拦截/超时常返回 HTML（非 JSON），
 * 这时也要按状态码归类出可展示的 code 与文案，而不是笼统的「非预期响应」。
 */
const STATUS_FALLBACK: Record<number, { code: string; message: string }> = {
  401: { code: "access_denied", message: "需要登录后才能使用这个功能。" },
  403: { code: "access_denied", message: "访问被拒绝：可能是网关拦截或权限受限。" },
  413: { code: "payload_too_large", message: "内容过长，请精简后重试（请求上限约 96KB）。" },
  429: { code: "rate_limited", message: "调用过于频繁，请过几分钟再试。" },
  504: { code: "upstream_timeout", message: "模型这次响应超时，请稍后再试。" },
};
const DEFAULT_FALLBACK = { code: "upstream_error", message: "模型接口暂时不可用，请稍后再试。" };

function pickMessage(
  messages: Readonly<Record<string, string>>,
  code: string,
  fallback: string,
): string {
  return Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : fallback;
}

export async function requestJson(
  url: string,
  init: RequestInit = {},
  messages: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    // 上游/网关超时归为 upstream_timeout；调用方主动取消则原样抛出，其余是网络失败。
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ApiError("模型这次响应超时，请稍后再试。", "upstream_timeout");
    }
    if (init.signal?.aborted) throw error;
    throw new ApiError("请求没能发出去，请检查网络后重试。", "network_error");
  }

  // 非 2xx：先按 status 取兜底 code/文案，再让服务端 JSON 里的具体错误码覆盖
  // （保留 service_not_configured / upstream_invalid_output 等可展示文案）。
  // 413/403/401 强制用状态码语义：服务端可能笼统报 bad_request，网关可能返回 HTML。
  if (!response.ok) {
    const fallback = STATUS_FALLBACK[response.status] ?? DEFAULT_FALLBACK;
    let code = fallback.code;
    let message = pickMessage(messages, fallback.code, fallback.message);
    const forced = response.status === 413 || response.status === 403 || response.status === 401;
    if (!forced && response.headers.get("content-type")?.includes("application/json")) {
      const data = await response.json().catch(() => null);
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      const serverCode =
        typeof body?.error === "string" ? body.error : typeof body?.code === "string" ? body.code : null;
      if (serverCode) {
        code = serverCode;
        const serverMessage = typeof body?.message === "string" ? body.message : "";
        message = pickMessage(messages, serverCode, serverMessage || fallback.message);
      }
    }
    throw new ApiError(message, code, response.status);
  }

  if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError("站点服务返回了非预期的响应，请刷新页面后重试。", "invalid_response", response.status);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError("站点服务返回的内容不是合法 JSON。", "invalid_response", response.status);
  }
  const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code =
    typeof body?.error === "string"
      ? body.error
      : body?.ok === false && typeof body?.code === "string"
        ? body.code
        : null;
  if (body?.ok === false || code) {
    const resolved = code ?? "request_failed";
    const message = pickMessage(messages, resolved, "请求失败，请检查当前状态后再试。");
    throw new ApiError(message, resolved, response.status);
  }
  return data;
}