import { useEffect, useState } from "react";

/**
 * 探测站点后端接口是否可用：GET /functions/v1/app/status 返回 200 与 upstream 状态。
 * 站点没有部署后端、或服务端 key 被上游拒绝过时返回 false，调用方据此隐藏整块功能。
 */
export function useFunctionProbe(path = "/functions/v1/app/status"): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    fetch(path, {
      method: "GET",
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) {
          setAvailable(false);
          return;
        }
        const body = (await response.json().catch(() => null)) as { upstream?: string } | null;
        setAvailable(body?.upstream !== "auth_failed");
      })
      .catch(() => setAvailable(false))
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path]);

  return available;
}