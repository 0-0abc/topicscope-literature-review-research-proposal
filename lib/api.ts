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
    if (init.signal?.aborted) throw error;
    throw new ApiError("请求没能发出去，请检查网络后重试。", "network_error");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(
      response.status === 401 ? "需要登录后才能使用这个功能。" : "没有访问这个功能的权限。",
      "access_denied",
      response.status,
    );
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
      : (!response.ok || body?.ok === false) && typeof body?.code === "string"
        ? body.code
        : response.ok
          ? null
          : "request_failed";
  if (!response.ok || body?.ok === false || code) {
    const resolved = code ?? "request_failed";
    const message = Object.prototype.hasOwnProperty.call(messages, resolved)
      ? messages[resolved]
      : "请求失败，请检查当前状态后再试。";
    throw new ApiError(message, resolved, response.status);
  }
  return data;
}
