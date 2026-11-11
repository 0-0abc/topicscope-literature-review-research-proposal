import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, requestJson } from "@/lib/api";
import { useFunctionProbe } from "@/hooks/useFunctionProbe";
import type { DirectionContext } from "@/lib/ai/directions";
import {
  buildFeasibilityPayload,
  integrityCheck,
  parseFeasibility,
  feasibilityToMarkdown,
  paradigmScore,
  BASIS_LABEL,
  COMPUTE_LABEL,
  DATA_LABEL,
  DECISION_META,
  DEFAULT_CAPABILITY,
  DIMENSION_META,
  type CapabilityProfile,
  type FeasibilityRef,
  type FeasibilityResult,
} from "@/lib/ai/feasibility";
import { NEXT_STEP } from "@/lib/analysis/advisorReport";
import { VERDICT_META, type RadarResult } from "@/lib/analysis/radar";
import type { Paper, SearchReport } from "@/lib/data/types";
import { downloadText, formatGB7714 } from "@/lib/export";

const ERROR_MESSAGES: Record<string, string> = {
  service_not_configured: "选题体检暂时不可用：服务端还没有配置模型接口的 key。",
  upstream_auth_failed: "选题体检暂时不可用：服务端配置的模型接口 key 没有通过鉴权。",
  upstream_rate_limited: "模型接口当前限流，请稍后再试。",
  upstream_timeout: "模型这次响应超时，请稍后再试。",
  upstream_error: "模型接口暂时不可用，请稍后再试。",
  upstream_invalid_output: "模型这次没有给出可用格式的体检报告，请重试。",
  upstream_truncated: "模型这次输出超长被截断，请精简想法描述后重试。",
  bad_request: "提交的内容不完整：请写一段想法或选一个目标方向。",
  network_error: "请求没能发出去，请检查网络后重试。",
};

export interface CheckupSeed {
  idea: string;
  clusterId: number | null;
}

interface Props {
  context: DirectionContext | null;
  radar: RadarResult | null;
  byId: Map<string, Paper>;
  report: SearchReport | null;
  seed: CheckupSeed | null;
}

const SEVERITY_LABEL = { critical: "致命", major: "重大", minor: "轻微" } as const;
const FIT_LABEL = { green: "绿灯 · 匹配", yellow: "黄灯 · 有条件", red: "红灯 · 错配" } as const;
const LEVEL_LABEL = { low: "低", medium: "中", high: "高" } as const;
const ANSWER_LABEL = { yes: "是", partial: "部分", no: "否" } as const;

export function FeasibilityChecker({ context, radar, byId, report, seed }: Props) {
  const available = useFunctionProbe();
  const [idea, setIdea] = useState("");
  const [clusterId, setClusterId] = useState<number | null>(null);
  const [capability, setCapability] = useState<CapabilityProfile>(DEFAULT_CAPABILITY);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [result, setResult] = useState<FeasibilityResult | null>(null);
  const [refs, setRefs] = useState<FeasibilityRef[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seed) return;
    setIdea(seed.idea);
    setClusterId(seed.clusterId);
    setStatus("idle");
    setResult(null);
    setError(null);
  }, [seed]);

  const cluster = useMemo(
    () => (radar && clusterId !== null ? radar.clusters.find((c) => c.id === clusterId) ?? null : null),
    [radar, clusterId],
  );

  const effectiveIdea =
    idea.trim() ||
    (cluster ? `评估进入「${cluster.name}」方向开展研究的可行性（方向级体检，具体想法待补充）` : "");

  const prepared = useMemo(() => {
    if (!context || !radar || radar.clusters.length === 0 || !effectiveIdea) return null;
    return buildFeasibilityPayload(context, radar, byId, clusterId, effectiveIdea, capability);
  }, [context, radar, byId, clusterId, effectiveIdea, capability]);

  if (available !== true) return null;

  const generate = async () => {
    if (!prepared) return;
    setStatus("loading");
    setError(null);
    try {
      const raw = await requestJson(
        "/functions/v1/app/feasibility",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prepared.payload),
        },
        ERROR_MESSAGES,
      );
      const body = raw as { model?: string; checkup?: unknown };
      const parsed = parseFeasibility(body.checkup);
      if (!parsed) throw new ApiError("模型没有给出可用格式的体检报告，请重试。", "empty_output");
      setResult(parsed);
      setRefs(prepared.refs);
      setModel(body.model ?? null);
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "体检失败，请稍后再试。");
      setStatus("error");
    }
  };

  const setCapabilityField = <K extends keyof CapabilityProfile>(key: K, value: CapabilityProfile[K]) =>
    setCapability((prev) => ({ ...prev, [key]: value }));

  const integrity = result ? integrityCheck(result) : null;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="heading-cn text-base">选题体检 · 这个想法值不值得做</h2>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          像审稿人加导师一样体检一个想法：致命缺陷审计 → 生命周期与能力匹配 → 五维评分（更高/更快/更强/更省/更广）→
          范式跃迁探测 → 三档结论。新颖性用当前检索样本里的真实文献核对，结论与评分不一致时会自动降级。
        </p>
      </div>

      {!radar || radar.clusters.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          先检索一个方向或载入离线示例，再做选题体检。
        </p>
      ) : (
        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            想法描述（写清要解决什么问题、打算怎么做；只选方向不写想法也可以做方向级体检）
            <Textarea
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="例：把 Mamba 状态空间模型引入医学图像分割的瓶颈层，期望在保持 Dice 的同时降低显存占用"
              className="min-h-20 text-xs"
              maxLength={1200}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1.5 text-xs text-muted-foreground">
              目标方向（新颖性核对的文献范围）
              <Select
                value={clusterId === null ? "all" : String(clusterId)}
                onValueChange={(value) => setClusterId(value === "all" ? null : Number(value))}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">不指定 · 全样本核对</SelectItem>
                  {radar.clusters.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name} · {VERDICT_META[c.verdict].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              每周有效小时（专注科研的时间）
              <Input
                type="number"
                min={1}
                max={80}
                value={capability.weeklyHours}
                onChange={(event) =>
                  setCapabilityField("weeklyHours", Math.min(80, Math.max(1, Number(event.target.value) || 1)))
                }
                className="h-9 text-xs"
              />
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              时间预算（月，到必须产出为止）
              <Input
                type="number"
                min={1}
                max={36}
                value={capability.months}
                onChange={(event) =>
                  setCapabilityField("months", Math.min(36, Math.max(1, Number(event.target.value) || 1)))
                }
                className="h-9 text-xs"
              />
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              编码与实验工程能力（1–5）
              <Select
                value={String(capability.coding)}
                onValueChange={(value) => setCapabilityField("coding", Number(value))}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} · {["入门", "能跑通", "独立复现", "熟练改进", "精通"][n - 1]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              理论与数学能力（1–5）
              <Select
                value={String(capability.theory)}
                onValueChange={(value) => setCapabilityField("theory", Number(value))}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} · {["入门", "读懂推导", "独立推导", "能证明", "精通"][n - 1]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              算力条件
              <Select
                value={capability.compute}
                onValueChange={(value) => setCapabilityField("compute", value as CapabilityProfile["compute"])}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(COMPUTE_LABEL) as CapabilityProfile["compute"][]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {COMPUTE_LABEL[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              数据获取
              <Select
                value={capability.data}
                onValueChange={(value) => setCapabilityField("data", value as CapabilityProfile["data"])}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(DATA_LABEL) as CapabilityProfile["data"][]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {DATA_LABEL[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          {cluster ? (
            <div className="space-y-1 rounded-md bg-muted px-3 py-2.5 text-[11px] leading-relaxed">
              <p>
                <span className="font-medium text-foreground">{VERDICT_META[cluster.verdict].label}</span>
                <span className="ml-1.5 text-muted-foreground">{NEXT_STEP[cluster.verdict]}</span>
              </p>
              <p className="text-muted-foreground">
                新颖性核对将使用该方向被引最高与最新的 {prepared?.refs.length ?? 0} 篇文献（含摘要节选）；
                判定只反映当前样本，不能证明真实空白或真实拥挤。
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void generate()} disabled={status === "loading" || !prepared}>
              {status === "loading" ? "体检中…" : "开始选题体检"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              能力为自报，未经核验；体检约需 20–40 秒。
            </span>
          </div>
        </div>
      )}

      {error ? (
        <p className="rounded-md bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</p>
      ) : null}

      {result && integrity ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <h3 className="heading-cn text-sm">体检报告</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadText(
                  `topicscope-checkup-${result.firstImpression.story.slice(0, 16) || "report"}.md`,
                  feasibilityToMarkdown(result, refs, effectiveIdea, capability, cluster, report, model),
                  "text/markdown",
                )
              }
            >
              导出 Markdown
            </Button>
          </div>

          <section
            className={
              integrity.decision === "reject"
                ? "space-y-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3"
                : "space-y-1.5 rounded-md border border-border bg-muted px-4 py-3"
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={integrity.decision === "reject" ? "destructive" : "default"} className="rounded-sm">
                {DECISION_META[integrity.decision].label}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {DECISION_META[integrity.decision].summary}
              </span>
            </div>
            <p className="text-xs leading-relaxed">{result.verdict.reason}</p>
            {integrity.notes.map((note) => (
              <p key={note} className="text-[11px] leading-relaxed text-destructive">
                完整性自检：{note}
              </p>
            ))}
          </section>

          <section className="space-y-1.5">
            <h4 className="heading-cn text-sm">一、第一印象</h4>
            <p className="text-xs leading-relaxed">
              <span className="text-muted-foreground">论文类型：</span>
              {result.firstImpression.paperType || "未给出"}
            </p>
            <p className="text-xs leading-relaxed">
              <span className="text-muted-foreground">一句话故事：</span>
              {result.firstImpression.story}
            </p>
          </section>

          <section className="space-y-1.5">
            <h4 className="heading-cn text-sm">二、致命缺陷审计（早期闸门）</h4>
            {result.flaws.length === 0 ? (
              <p className="text-xs text-muted-foreground">未发现致命缺陷（基于当前样本与自报能力）。</p>
            ) : (
              <div className="space-y-2">
                {result.flaws.map((flaw) => (
                  <div key={`${flaw.code}-${flaw.name}`} className="rounded-md border border-border px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          flaw.severity === "critical"
                            ? "text-xs font-semibold text-destructive"
                            : "text-xs font-semibold"
                        }
                      >
                        {flaw.code} {flaw.name} · {SEVERITY_LABEL[flaw.severity]}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed">{flaw.detail}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      防御：{flaw.defense || "当前资源下无法防御"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {result.lifecycle.category !== "未分类" || result.lifecycle.reason ? (
            <section className="space-y-1.5">
              <h4 className="heading-cn text-sm">三、生命周期与能力匹配</h4>
              <p className="text-xs leading-relaxed">
                <span className="font-medium">{result.lifecycle.category}</span>
                {result.lifecycle.window ? (
                  <span className="ml-1.5 text-muted-foreground">窗口 {result.lifecycle.window}</span>
                ) : null}
                <span className="ml-1.5 text-muted-foreground">· {FIT_LABEL[result.lifecycle.fit]}</span>
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">{result.lifecycle.reason}</p>
            </section>
          ) : null}

          {result.dimensions.some((d) => d.evidence !== "模型未给出该维度依据") ? (
            <section className="space-y-2">
              <h4 className="heading-cn text-sm">四、五维评分（从 5 分起步，给依据才加分）</h4>
              <div className="space-y-2">
                {result.dimensions.map((dim) => (
                  <div key={dim.key} className="rounded-md border border-border px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {DIMENSION_META[dim.key].label}
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {DIMENSION_META[dim.key].goal}
                        </span>
                      </span>
                      <span className="text-xs tabular-nums">{dim.score}/10</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-foreground" style={{ width: `${dim.score * 10}%` }} />
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      <span className={dim.basis === "mechanism" ? "font-medium text-foreground" : ""}>
                        {BASIS_LABEL[dim.basis]}
                      </span>
                      ：{dim.evidence}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {result.paradigm.length > 0 ? (
            <section className="space-y-1.5">
              <h4 className="heading-cn text-sm">
                五、范式跃迁探测（{paradigmScore(result.paradigm)}/8）
              </h4>
              <ul className="space-y-1">
                {result.paradigm.map((probe) => (
                  <li key={probe.probe} className="text-xs leading-relaxed">
                    <span className="font-medium">{probe.probe}</span>
                    <span className="ml-1.5 text-muted-foreground">
                      {ANSWER_LABEL[probe.answer]} — {probe.reason}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                0–2 纯增量；3–4 有颠覆种子；5–6 有颠覆潜力；7–8 范式跃迁候选。探测不是门槛，增量工作也能发好论文。
              </p>
            </section>
          ) : null}

          {result.risks.length > 0 ? (
            <section className="space-y-1.5">
              <h4 className="heading-cn text-sm">六、可行性风险</h4>
              <ul className="space-y-1">
                {result.risks.map((risk) => (
                  <li key={risk.kind} className="text-xs leading-relaxed">
                    <span className={risk.level === "high" ? "font-medium text-destructive" : "font-medium"}>
                      {risk.kind} · {LEVEL_LABEL[risk.level]}风险
                    </span>
                    <span className="ml-1.5 text-muted-foreground">{risk.mitigation}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {result.verdict.actions.length > 0 ? (
            <section className="space-y-1.5">
              <h4 className="heading-cn text-sm">七、先做的三件事</h4>
              <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed">
                {result.verdict.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ol>
            </section>
          ) : null}

          {refs.length > 0 ? (
            <section className="space-y-1.5 rounded-md bg-muted px-4 py-3">
              <h4 className="heading-cn text-sm">新颖性核对文献（GB/T 7714）</h4>
              <ol className="space-y-1">
                {refs.map(({ n, paper }) => (
                  <li key={n} className="text-[11px] leading-relaxed text-muted-foreground">
                    {formatGB7714(paper, n)}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            由 {model ?? "大模型"} 基于当前检索样本生成。{result.limitation}
            {" "}评估框架改编自 HKUSTDial/Supervisor-Skills 的 idea-evaluator（CC-BY-4.0）；
            机制推断类高分需先完成报告里指定的验证实验，再决定是否立项。
          </p>
        </div>
      ) : null}
    </div>
  );
}