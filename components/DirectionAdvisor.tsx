import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError, requestJson } from "@/lib/api";
import {
  isGrounded,
  parseSuggestions,
  resolveEvidence,
  type DirectionContext,
  type DirectionSuggestion,
} from "@/lib/ai/directions";
import { useFunctionProbe } from "@/hooks/useFunctionProbe";

const ERROR_MESSAGES: Record<string, string> = {
  service_not_configured: "AI 建议暂时不可用：服务端还没有配置模型接口的 key。",
  upstream_auth_failed: "AI 建议暂时不可用：服务端配置的模型接口 key 没有通过鉴权，请联系站点维护者更新。",
  upstream_rate_limited: "模型接口当前限流，请稍后再试。",
  upstream_timeout: "模型这次响应超时，请稍后再试。",
  upstream_error: "模型接口暂时不可用，请稍后再试。",
  upstream_invalid_output: "模型这次没有给出可用格式的建议，请再点一次。",
  bad_request: "提交的分析数据不完整，请重新检索后再试。",
  network_error: "请求没能发出去，请检查网络后重试。",
};

interface Props {
  context: DirectionContext | null;
  onCheckupIdea?: (idea: string) => void;
}

export function DirectionAdvisor({ context, onCheckupIdea }: Props) {
  // 先探一下后端在不在：status 接口存在时回 200，没有部署后端时是 404。
  // 站点没有部署后端、或服务端 key 被上游拒绝过时，不显示这一块，避免出现点不动的按钮。
  const available = useFunctionProbe();
  const [unavailable, setUnavailable] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [suggestions, setSuggestions] = useState<DirectionSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  if (available !== true) return null;

  const generate = async () => {
    if (!context) return;
    setStatus("loading");
    setError(null);
    try {
      const raw = await requestJson(
        "/functions/v1/app/directions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(context),
        },
        ERROR_MESSAGES,
      );
      const body = raw as { model?: string; suggestions?: unknown };
      const parsed = parseSuggestions(body);
      if (parsed.length === 0) {
        throw new ApiError("模型没有给出可用格式的建议，请再试一次。", "empty_output");
      }
      setSuggestions(parsed);
      setModel(typeof body.model === "string" ? body.model : null);
      setStatus("ready");
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "生成失败，请稍后再试。",
      );
      setStatus("error");
      // 服务端 key 没通过鉴权时，别让访客一次次重试同一个必然失败的请求
      if (cause instanceof ApiError && cause.code === "upstream_auth_failed") {
        setUnavailable(true);
      }
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-2">
        <div className="space-y-1">
          <h2 className="heading-cn text-sm">把统计结果交给模型</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            请它只依据这些数字给出可执行的研究问题。每条建议都会标出它引用了哪些数字，引用对不上的会被标出来。
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => void generate()}
          disabled={!context || status === "loading" || unavailable}
        >
          {status === "loading" ? "生成中…" : unavailable ? "暂时不可用" : "生成方向建议"}
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {status === "ready" ? (
        <div className="space-y-3">
          {suggestions.map((suggestion, index) => {
            const grounded = context ? isGrounded(suggestion, context) : false;
            const resolved = context
              ? resolveEvidence(suggestion.evidenceIds, context)
              : { items: [], unknown: [] };
            return (
              <Card key={`${suggestion.title}-${index}`} className="gap-2 rounded-md border-border py-4 shadow-none">
                <CardContent className="space-y-2.5 px-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="heading-cn text-sm">
                      [{index + 1}] {suggestion.title}
                    </span>
                    <Badge variant="outline" className="rounded-sm">
                      可做性 {suggestion.feasibility}/5
                    </Badge>
                    <Badge
                      variant={grounded ? "secondary" : "destructive"}
                      className="rounded-sm"
                    >
                      {grounded ? "依据可核对" : "依据无法核对"}
                    </Badge>
                    {onCheckupIdea ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto h-7 text-[11px]"
                        onClick={() => onCheckupIdea(`${suggestion.title}：${suggestion.question}`)}
                      >
                        体检这个想法
                      </Button>
                    ) : null}
                  </div>
                  <Line label="问题" value={suggestion.question} />
                  <Line label="为什么" value={suggestion.why} />
                  <Line label="怎么做" value={suggestion.entry} />
                  <Line label="需要准备" value={suggestion.evidence} />
                  <Line label="成本" value={suggestion.cost} />
                  <Line label="风险" value={suggestion.risk} />
                  <div className="space-y-1">
                    <p className="label-caps">引用的证据</p>
                    <div className="flex flex-wrap gap-1.5">
                      {resolved.items.map((item) => (
                        <span
                          key={item.id}
                          title={`${item.label}：${item.value}（${item.origin}）`}
                          className="rounded border border-border px-1.5 py-0.5 text-[11px]"
                        >
                          {item.label}
                          <span className="ml-1 tabular-nums text-muted-foreground">{item.value}</span>
                        </span>
                      ))}
                      {resolved.unknown.map((id) => (
                        <span
                          key={id}
                          className="rounded border border-destructive/40 px-1.5 py-0.5 text-[11px] text-destructive"
                        >
                          未识别的引用：{id}
                        </span>
                      ))}
                      {suggestion.evidenceIds.length === 0 ? (
                        <span className="text-[11px] text-destructive">模型没有给出证据引用</span>
                      ) : null}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            由 {model ?? "大模型"} 基于本页统计数字生成，不是人工结论，也没有替你查证文献；
            请对照上面的占比、年份与提升度逐条核对后再决定投入。
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-xs leading-relaxed">
      <span className="label-caps mr-2">{label}</span>
      {value}
    </p>
  );
}
