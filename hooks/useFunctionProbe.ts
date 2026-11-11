import { useEffect, useState } from "react";

/**
 * 后端 AI 服务的具体状态，而不是一个简单的可用/不可用布尔值。
 * 调用方据此展示「为什么不可用 + 还能做什么」，避免页签整块空白。
 */
export type ProbeStatus =
  | "loading"
  | "ready"
  | "not_deployed"
  | "not_configured"
  | "auth_failed"
  | "error";

export function useFunctionProbe(path = "/functions/v1/app/status"): ProbeStatus {
  const [status, setStatus] = useState<ProbeStatus>("loading");

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    fetch(path, {
      method: "GET",
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (response.status === 404) {
          setStatus("not_deployed");
          return;
        }
        if (!response.ok) {
          setStatus("error");
          return;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          // 静态托管把未知路径回落到 index.html，说明后端 Function 没有部署
          setStatus("not_deployed");
          return;
        }
        const body = (await response.json().catch(() => null)) as {
          upstream?: string;
          configured?: boolean;
        } | null;
        if (!body) {
          setStatus("not_deployed");
          return;
        }
        if (body.upstream === "auth_failed") setStatus("auth_failed");
        else if (body.configured === false) setStatus("not_configured");
        else setStatus("ready");
      })
      .catch(() => setStatus("error"))
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path]);

  return status;
}