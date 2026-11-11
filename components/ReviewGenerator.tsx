import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, requestJson } from "@/lib/api";
import { useFunctionProbe } from "@/hooks/useFunctionProbe";
import { AiServiceNotice } from "@/components/AiServiceNotice";
import type { DirectionContext } from "@/lib/ai/directions";
import {
  buildReviewPayload,
  parseReview,
  reviewQualityGates,
  reviewToMarkdown,
  GATE_VERDICT_LABEL,
  type ResearchReview,
  type ReviewRef,
} from "@/lib/ai/review";
import type { RadarResult } from "@/lib/analysis/radar";
import type { Paper, SearchReport } from "@/lib/data/types";
import { downloadText, formatGB7714 } from "@/lib/export";

const ERROR_MESSAGES: Record<string, string> = {
  service_not_configured: "综述生成暂时不可用：服务端还没有配置模型接口的 key。",
  upstream_auth_failed: "综述生成暂时不可用：服务端配置的模型接口 key 没有通过鉴权。",
  upstream_rate_limited: "模型接口当前限流，请稍后再试。",
  upstream_timeout: "模型这次响应超时，请稍后再试。",
  upstream_error: "模型接口暂时不可用，请稍后再试。",
  upstream_invalid_output: "模型这次没有给出可用格式的综述，请重试。",
  upstream_truncated: "模型这次输出超长被截断，请重试。",
  bad_request: "提交的样本不完整，请重新检索后再试。",
  network_error: "请求没能发出去，请检查网络后重试。",
};

interface Props {
  context: DirectionContext | null;
  radar: RadarResult | null;
  byId: Map<string, Paper>;
  report: SearchReport | null;
}

export function ReviewGenerator({ context, radar, byId, report }: Props) {
  const available = useFunctionProbe();
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [review, setReview] = useState<ResearchReview | null>(null);
  const [refs, setRefs] = useState<ReviewRef[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prepared = useMemo(() => {
    if (!context || !radar || radar.clusters.length === 0) return null;
    return buildReviewPayload(context, radar, byId);
  }, [context, radar, byId]);

  if (available !== "ready") {
    return <AiServiceNotice status={available} feature="文献综述生成" />;
  }

  const generate = async () => {
    if (!prepared) return;
    setStatus("loading");
    setError(null);
    try {
      const raw = await requestJson(
        "/functions/v1/app/review",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prepared.payload),
        },
        ERROR_MESSAGES,
      );
      const body = raw as { model?: string; review?: unknown };
      const parsed = parseReview(body.review);
      if (!parsed) throw new ApiError("模型没有给出可用格式的综述，请重试。", "empty_output");
      setReview(parsed);
      setRefs(prepared.refs);
      setModel(body.model ?? null);
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "生成失败，请稍后再试。");
      setStatus("error");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="heading-cn text-base">文献综述草稿生成器</h2>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            把当前检索样本按方向综合成综述草稿：每个方向选被引最高的 4 篇（共最多 24 篇），
            模型只允许引用这些编号文献，[n] 与文末 GB/T 7714 参考文献一一对应。
            措辞按证据强度校准，生成后附本地质量门禁与自我对抗检查。草稿是起点，不是成品。
          </p>
        </div>
        <Button size="sm" onClick={() => void generate()} disabled={status === "loading" || !prepared}>
          {status === "loading" ? "生成中…" : "生成综述草稿"}
        </Button>
      </div>

      {!prepared ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          先检索一个方向或载入离线示例，再基于当前样本生成综述。
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</p>
      ) : null}

      {review ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <h3 className="heading-cn text-sm">{review.title}</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadText(
                  `topicscope-review-${review.title.slice(0, 20)}.md`,
                  reviewToMarkdown(review, refs, report, model),
                  "text/markdown",
                )
              }
            >
              导出 Markdown
            </Button>
          </div>

          {review.sections.map((section) => (
            <section key={section.heading} className="space-y-1.5">
              <h4 className="heading-cn text-sm">{section.heading}</h4>
              <p className="text-xs leading-relaxed">{renderCitations(section.body, refs.length)}</p>
            </section>
          ))}

          {review.gaps ? (
            <section className="space-y-1.5">
              <h4 className="heading-cn text-sm">研究空白与可切入点</h4>
              <p className="text-xs leading-relaxed">{renderCitations(review.gaps, refs.length)}</p>
            </section>
          ) : null}

          <section className="space-y-1.5 rounded-md border border-border px-4 py-3">
            <h4 className="heading-cn text-sm">质量门禁（本地核对，不替代人工）</h4>
            <ul className="space-y-1">
              {reviewQualityGates(review).map((gate) => (
                <li key={gate.name} className="text-[11px] leading-relaxed">
                  <span
                    className={
                      gate.verdict === "clear"
                        ? "font-medium"
                        : gate.verdict === "insufficient"
                          ? "font-medium text-destructive"
                          : "font-medium text-muted-foreground"
                    }
                  >
                    {gate.name} · {GATE_VERDICT_LABEL[gate.verdict]}
                  </span>
                  <span className="ml-1.5 text-muted-foreground">{gate.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          {review.selfCheck ? (
            <section className="space-y-1.5 rounded-md bg-muted px-4 py-3">
              <h4 className="heading-cn text-sm">自我对抗检查</h4>
              <p className="text-xs leading-relaxed text-muted-foreground">{review.selfCheck}</p>
            </section>
          ) : null}

          <section className="space-y-1.5 rounded-md bg-muted px-4 py-3">
            <h4 className="heading-cn text-sm">参考文献（GB/T 7714）</h4>
            <ol className="space-y-1">
              {refs.map(({ n, paper }) => (
                <li key={n} className="text-[11px] leading-relaxed text-muted-foreground">
                  {formatGB7714(paper, n)}
                </li>
              ))}
            </ol>
          </section>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            由 {model ?? "大模型"} 基于当前检索样本生成。
            {review.limitation ? ` ${review.limitation}` : ""}
            {" "}综合判断未经全文核对，提交或引用前请逐条核实；编号之外的文献模型一律不得引入。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function renderCitations(text: string, maxN: number) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      const n = Number(match[1]);
      if (n >= 1 && n <= maxN) {
        return (
          <sup key={i} className="ml-0.5 tabular-nums text-muted-foreground">
            [{n}]
          </sup>
        );
      }
      return <span key={i}>[?]</span>;
    }
    return <span key={i}>{part}</span>;
  });
}