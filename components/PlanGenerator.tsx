import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, requestJson } from "@/lib/api";
import type { DirectionContext } from "@/lib/ai/directions";
import { auditTextNumbers, buildNumericWhitelist } from "@/lib/ai/grounding";
import {
  PLAN_SECTIONS,
  RESOURCE_KIND_LABEL,
  RESOURCE_STATUS_LABEL,
  buildEvidenceIndexText,
  findUnauthorizedResourceTerms,
  isPlaceholderSection,
  parsePlan,
  resolvePlanEvidence,
  type PlanConstraints,
  type ResearchPlan,
  type ResourceKind,
  type ResourceRoute,
  type ResourceStatus,
} from "@/lib/ai/plan";
import type { Paper, SearchReport } from "@/lib/data/types";
import { downloadText, formatGB7714, researchPlanToMarkdown } from "@/lib/export";
import { useFunctionProbe } from "@/hooks/useFunctionProbe";
import { AiServiceNotice } from "@/components/AiServiceNotice";
import { EVIDENCE_FIELDS, type EvidenceNote } from "@/hooks/useEvidenceStore";

const ERROR_MESSAGES: Record<string, string> = {
  service_not_configured: "方案生成暂时不可用：服务端还没有配置模型接口的 key。",
  upstream_auth_failed: "方案生成暂时不可用：服务端配置的模型接口 key 没有通过鉴权。",
  upstream_rate_limited: "模型接口当前限流，请稍后再试。",
  upstream_timeout: "模型这次响应超时，请稍后再试。",
  upstream_error: "模型接口暂时不可用，请稍后再试。",
  upstream_invalid_output: "模型这次没有给出可用格式的方案，请再试一次。",
  upstream_truncated: "模型这次输出超长被截断，请精简约束描述后重试。",
  bad_request: "提交的分析数据不完整，请重新检索后再试。",
  rate_limited: "调用过于频繁，请过几分钟再试。",
  network_error: "请求没能发出去，请检查网络后重试。",
};

const CONSTRAINT_FIELDS: {
  key: keyof PlanConstraints;
  label: string;
  placeholder: string;
  type?: string;
}[] = [
  { key: "object", label: "研究对象与任务", placeholder: "例如：CT 器官分割" },
  { key: "task", label: "任务设定", placeholder: "例如：低标注（每类 5 张标注）下的全器官分割" },
  { key: "datasets", label: "可用数据集", placeholder: "例如：AMOS、Synapse；只能申请不能下载" },
  { key: "compute", label: "算力条件", placeholder: "例如：单卡 24G，最多 2 周" },
  { key: "timeline", label: "目标完成时间", placeholder: "例如：3 个月" },
  { key: "openCode", label: "是否要求开放代码", placeholder: "例如：要求，需要能复现" },
  { key: "target", label: "预期产出", placeholder: "例如：开题报告 + 一篇会议投稿" },
];

const CONSTRAINT_LABELS: Record<string, string> = {
  ...Object.fromEntries(CONSTRAINT_FIELDS.map((field) => [field.key, field.label])),
  metricCaliber: "指标口径",
};

/**
 * M6 空壳修复：用当前检索样本里的真实论文（标题+年份+被引）填充第 14 节。
 * 能在完整论文列表里匹配到标题时用 GB/T 7714 格式，否则用标题+出处+年份兜底。
 */
function buildClusterReferences(context: DirectionContext | null, fullPapers?: Paper[]): string {
  if (!context) return "当前检索样本没有可列出的论文。";
  const byTitle = new Map((fullPapers ?? []).map((paper) => [paper.title.trim().toLowerCase(), paper]));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const cluster of context.clusters) {
    for (const paper of cluster.papers) {
      const key = paper.title.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const n = lines.length + 1;
      const full = byTitle.get(key);
      const cite = full
        ? formatGB7714(full, n)
        : `[${n}] ${paper.title}. ${paper.venue ?? "出处不详"}, ${paper.year}.`;
      lines.push(`${cite} 被引 ${paper.citedByCount} 次.`);
      if (lines.length >= 20) break;
    }
    if (lines.length >= 20) break;
  }
  if (lines.length === 0) return "当前检索样本没有可列出的论文。";
  return lines.join("\n");
}

/** 复现包用的简单内容哈希（FNV-1a 32 位），用于校验导出文本是否被改动。 */
function simpleHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

interface Props {
  context: DirectionContext | null;
  report: SearchReport | null;
  /** 证据卡标注，用于把用户已核对的内容送进模型上下文 */
  evidenceNotes?: Record<string, EvidenceNote>;
  /** 当前论文，用于给已核对证据标注标题 */
  papers?: import("@/lib/data/types").Paper[];
  /** 从研究档案载入的方案（完整恢复） */
  restoredPlan?: { plan: ResearchPlan; markdown: string } | null;
  /** 研究对话里用户认可的结论草稿 */
  draftConclusions?: string[];
  /** 前置选题体检结论摘要（随生成提交并写入导出） */
  checkupSummary?: string | null;
  /** 前置文献综述结论摘要（随生成提交并写入导出） */
  reviewSummary?: string | null;
  /** 指标口径对齐带入的约束种子 */
  constraintSeed?: { text: string; token: number } | null;
  /** 把最新的方案交给上层，便于存进研究档案 */
  onPlanChange?: (plan: ResearchPlan | null, markdown: string) => void;
}

interface ResourceDraft {
  kind: ResourceKind;
  name: string;
  status: ResourceStatus;
  url: string;
  license: string;
  accessCondition: string;
}

const EMPTY_RESOURCE: ResourceDraft = {
  kind: "dataset",
  name: "",
  status: "not_verified",
  url: "",
  license: "",
  accessCondition: "",
};

/** 用户已核对、将被送进模型上下文的证据字段。 */
interface VerifiedEvidence {
  paperId: string;
  paperTitle: string;
  fields: { key: string; label: string; value: string; location?: string; verifiedAt?: string }[];
}

function fingerprint(input: unknown): string {
  return JSON.stringify(input);
}

export function PlanGenerator({ context, report, evidenceNotes, papers, draftConclusions, checkupSummary, reviewSummary, constraintSeed, restoredPlan, onPlanChange }: Props) {
  const available = useFunctionProbe();
  const [constraints, setConstraints] = useState<Record<string, string>>({});
  const [resources, setResources] = useState<ResourceDraft[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    restoredPlan ? "ready" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ReturnType<typeof parsePlan>>(restoredPlan?.plan ?? null);
  const [model, setModel] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  // 生成时冻结的输入与导出文本：导出/展示都用冻结版本，避免旧方案被挂到新上下文上
  const [frozen, setFrozen] = useState<null | {
    context: DirectionContext | null;
    report: SearchReport | null;
    constraints: Record<string, string>;
    resources: ResourceDraft[];
    verified: VerifiedEvidence[];
    draftConclusions: string[];
    checkupSummary: string | null;
    reviewSummary: string | null;
  }>(null);
  const [storedMarkdown, setStoredMarkdown] = useState<string | null>(restoredPlan?.markdown ?? null);
  const [excludedPapers, setExcludedPapers] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [revised, setRevised] = useState(false);
  // M6/M3 客户端校验结果：代猜的资源词与未核对的正文数字
  const [resourceWarnings, setResourceWarnings] = useState<string[]>([]);
  const [numberWarnings, setNumberWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (!constraintSeed) return;
    setConstraints((prev) => ({ ...prev, metricCaliber: constraintSeed.text }));
  }, [constraintSeed]);

  const verifiedAll = useMemo<VerifiedEvidence[]>(() => {
    const titleOf = new Map((papers ?? []).map((p) => [p.id, p.title]));
    const out: VerifiedEvidence[] = [];
    for (const note of Object.values(evidenceNotes ?? {})) {
      const fields = (note.verifiedFields ?? [])
        .map((key) => {
          const meta = EVIDENCE_FIELDS.find((f) => f.key === key);
          const value = note.fields?.[key];
          if (!meta || !value?.trim()) return null;
          return {
            key,
            label: meta.label,
            value: value.trim(),
            location: note.fieldMeta?.[key]?.location,
            verifiedAt: note.fieldMeta?.[key]?.verifiedAt,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (fields.length > 0) {
        out.push({ paperId: note.paperId, paperTitle: titleOf.get(note.paperId) ?? note.paperId, fields });
      }
    }
    return out;
  }, [evidenceNotes, papers]);

  const verified = useMemo(
    () => verifiedAll.filter((item) => !excludedPapers.includes(item.paperId)),
    [verifiedAll, excludedPapers],
  );

  const resolved = useMemo(() => {
    if (!plan) return { items: [], unknown: [] };
    return resolvePlanEvidence(plan.evidenceIds, (frozen?.context ?? context)?.evidence ?? []);
  }, [plan, context, frozen]);

  const stale =
    frozen !== null &&
    fingerprint({ context, report, constraints, resources, verified, draftConclusions, checkupSummary, reviewSummary }) !==
      fingerprint(frozen);

  if (available !== "ready") {
    return <AiServiceNotice status={available} feature="研究方案生成" />;
  }

  const updateResource = (index: number, patch: Partial<ResourceDraft>) => {
    setResources((prev) =>
      prev.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
  };

  const generate = async () => {
    if (!context) return;
    setStatus("loading");
    setError(null);
    setResourceWarnings([]);
    setNumberWarnings([]);
    const inputConstraints = Object.fromEntries(
      Object.entries(constraints).filter(([, value]) => value.trim()),
    );
    const inputResources = resources
      .filter((item) => item.name.trim())
      .map((item) => ({
        kind: item.kind,
        name: item.name.trim(),
        status: item.status,
        url: item.url.trim() || undefined,
        license: item.license.trim() || undefined,
        accessCondition: item.accessCondition.trim() || undefined,
      }));
    const snapshot = { context, report, constraints: inputConstraints, resources, verified, draftConclusions: draftConclusions ?? [], checkupSummary: checkupSummary ?? null, reviewSummary: reviewSummary ?? null };
    try {
      const payload = {
        context,
        constraints: inputConstraints,
        resources: inputResources,
        verifiedEvidence: verified,
        draftConclusions: draftConclusions ?? [],
        checkupSummary: checkupSummary ?? null,
        reviewSummary: reviewSummary ?? null,
      };
      const raw = await requestJson(
        "/functions/v1/app/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        ERROR_MESSAGES,
      );
      const body = raw as { model?: string; plan?: unknown; generatedAt?: string };
      const parsed = parsePlan(body.plan);
      if (!parsed) {
        throw new ApiError("模型没有给出可用格式的方案，请再试一次。", "empty_output");
      }
      // M6 禁代猜：用户约束/资源没有覆盖的具体资源词，收集进待补充并明示
      const unauthorized = findUnauthorizedResourceTerms(parsed, [
        ...Object.values(inputConstraints),
        ...inputResources.map((item) => item.name),
      ]);
      if (unauthorized.length > 0) {
        parsed.missing = [
          ...parsed.missing,
          `模型代猜了未提供的约束：${unauthorized.join("、")}，已移入待补充`,
        ];
      }
      // M6 空壳修复：14/15 节为空或只有占位句时，用真实论文与证据解析结果填充
      const resolvedItems = resolvePlanEvidence(parsed.evidenceIds, context.evidence);
      if (isPlaceholderSection(parsed.sections.references)) {
        parsed.sections.references = buildClusterReferences(context, papers);
      }
      if (isPlaceholderSection(parsed.sections.evidenceIndex)) {
        parsed.sections.evidenceIndex = buildEvidenceIndexText(resolvedItems);
      }
      // M3 数字回查：正文数字必须能在送入模型的统计白名单里找到
      const unmatchedNumbers = auditTextNumbers(
        PLAN_SECTIONS.map((section) => parsed.sections[section.key]).join("\n"),
        buildNumericWhitelist(context),
      );
      setResourceWarnings(unauthorized);
      setNumberWarnings(unmatchedNumbers);
      const md = buildMarkdown(parsed, {
        model: body.model,
        generatedAt: body.generatedAt,
        snapshot,
      });
      setPlan(parsed);
      setModel(typeof body.model === "string" ? body.model : null);
      setGeneratedAt(typeof body.generatedAt === "string" ? body.generatedAt : null);
      setFrozen(snapshot);
      setStoredMarkdown(md);
      setStatus("ready");
      onPlanChange?.(parsed, md);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "生成失败，请稍后再试。");
      setStatus("error");
    }
  };

  const buildMarkdown = (
    target: NonNullable<typeof plan>,
    meta: {
      model?: string | null;
      generatedAt?: string | null;
      snapshot?: NonNullable<typeof frozen>;
    },
  ): string => {
    const src = meta.snapshot ?? frozen;
    const useConstraints = src?.constraints ?? constraints;
    const useResources = (src?.resources ?? resources)
      .filter((item) => item.name.trim())
      .map((item) => ({
        kind: item.kind,
        name: item.name.trim(),
        status: item.status,
        url: item.url.trim() || undefined,
        license: item.license.trim() || undefined,
        accessCondition: item.accessCondition.trim() || undefined,
      }));
    const useVerified = src?.verified ?? verified;
    const resolvedItems = resolvePlanEvidence(target.evidenceIds, (src?.context ?? context)?.evidence ?? []);
    return researchPlanToMarkdown(target, {
      report: src?.report ?? report,
      constraints: useConstraints,
      resources: useResources,
      evidence: resolvedItems.items.map((item) => ({
        id: item.id,
        label: item.label,
        value: item.value,
        origin: item.origin,
      })),
      unknownEvidence: resolvedItems.unknown,
      verifiedEvidence: useVerified,
      draftConclusions: src?.draftConclusions ?? draftConclusions ?? [],
      checkupSummary: src?.checkupSummary ?? checkupSummary ?? null,
      reviewSummary: src?.reviewSummary ?? reviewSummary ?? null,
      generatedAt: meta.generatedAt ?? undefined,
      model: meta.model ?? undefined,
    });
  };

  const exportPlan = () => {
    if (!plan || !storedMarkdown) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const body = revised
      ? `> 本导出含人工修订（修订于 ${new Date().toISOString().slice(0, 16).replace("T", " ")}），修订内容未经模型重新生成。\n\n${storedMarkdown}`
      : storedMarkdown;
    downloadText(`topicscope-plan-${stamp}.md`, body, "text/markdown");
  };

  /** S4/A2 复现包：冻结的输入 + 提示词摘要 + 证据白名单 + 导出文本哈希。 */
  const exportRepro = () => {
    if (!plan || !frozen || !storedMarkdown) return;
    const repro = {
      model,
      generatedAt,
      temperature: 0,
      temperatureNote:
        "temperature=0 为复现建议值；生成时服务端实际调用 temperature=0.4（functions/handler.ts callModel）",
      promptSummary: "PLAN_SYSTEM_PROMPT+资源规则",
      contextStats: frozen.context?.corpus ?? null,
      evidenceWhitelist: (frozen.context?.evidence ?? []).map((item) => item.id),
      constraints: frozen.constraints,
      resources: frozen.resources
        .filter((item) => item.name.trim())
        .map((item) => ({
          kind: item.kind,
          name: item.name.trim(),
          status: item.status,
          url: item.url.trim() || undefined,
          license: item.license.trim() || undefined,
          accessCondition: item.accessCondition.trim() || undefined,
        })),
      verified: frozen.verified,
      draftConclusions: frozen.draftConclusions,
      contentHash: simpleHash(storedMarkdown),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(
      `topicscope-plan-repro-${stamp}.json`,
      JSON.stringify(repro, null, 2),
      "application/json",
    );
  };

  return (
    <div className="space-y-5">
      <Card className="gap-3 rounded-md border-border py-4 shadow-none">
        <CardContent className="space-y-4 px-4">
          <div className="space-y-1">
            <h2 className="heading-cn text-base">研究方案生成器</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              先把你的现实约束填清楚，模型只在这个范围里设计方案。
              没填的条件不会被它替你猜，而是写进「待补充条件」。
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {CONSTRAINT_FIELDS.map((field) => (
              <label key={field.key} className="space-y-1.5 text-xs text-muted-foreground">
                {field.label}
                <Input
                  value={constraints[field.key] ?? ""}
                  onChange={(event) =>
                    setConstraints((prev) => ({ ...prev, [field.key]: event.target.value }))
                  }
                  placeholder={field.placeholder}
                  className="h-9 text-xs"
                />
              </label>
            ))}
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-xs font-semibold">数据与代码的可获得性</h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => setResources((prev) => [...prev, { ...EMPTY_RESOURCE }])}
              >
                添加一项
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              「数据公开」不等于「标注与划分公开」，所以分开记：数据能拿到是一回事，方法能复现是另一回事。
            </p>

            {resources.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">还没有登记任何资源。</p>
            ) : null}

            <div className="space-y-2">
              {resources.map((resource, index) => (
                <div
                  key={index}
                  className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-6"
                >
                  <NativeSelect
                    value={resource.kind}
                    onChange={(event) =>
                      updateResource(index, { kind: event.target.value as ResourceKind })
                    }
                    className="sm:col-span-1"
                    aria-label="资源类型"
                  >
                    {(Object.keys(RESOURCE_KIND_LABEL) as ResourceKind[]).map((kind) => (
                      <NativeSelectOption key={kind} value={kind}>
                        {RESOURCE_KIND_LABEL[kind]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Input
                    value={resource.name}
                    onChange={(event) => updateResource(index, { name: event.target.value })}
                    placeholder="名称"
                    className="sm:col-span-2"
                    aria-label="资源名称"
                  />
                  <NativeSelect
                    value={resource.status}
                    onChange={(event) =>
                      updateResource(index, { status: event.target.value as ResourceStatus })
                    }
                    className="sm:col-span-1"
                    aria-label="可获得性状态"
                  >
                    {(Object.keys(RESOURCE_STATUS_LABEL) as ResourceStatus[]).map((status) => (
                      <NativeSelectOption key={status} value={status}>
                        {RESOURCE_STATUS_LABEL[status]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Input
                    value={resource.url}
                    onChange={(event) => updateResource(index, { url: event.target.value })}
                    placeholder="链接（可选）"
                    className="sm:col-span-1"
                    aria-label="资源链接"
                  />
                  <div className="flex gap-2 sm:col-span-6">
                    <Input
                      value={resource.license}
                      onChange={(event) => updateResource(index, { license: event.target.value })}
                      placeholder="许可（可选）"
                      className="h-8 text-xs"
                      aria-label="许可"
                    />
                    <Input
                      value={resource.accessCondition}
                      onChange={(event) =>
                        updateResource(index, { accessCondition: event.target.value })
                      }
                      placeholder="获取条件（可选）"
                      className="h-8 text-xs"
                      aria-label="获取条件"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() =>
                        setResources((prev) => prev.filter((_, position) => position !== index))
                      }
                    >
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
            <p className="label-caps">研究对话里加入的草稿结论（{draftConclusions?.length ?? 0}）</p>
            {(draftConclusions?.length ?? 0) === 0 ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                到「研究对话」页签围绕当前样本追问，认可的回答点「加入方案草稿」后会出现在这里，并随本次生成提交给模型。
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                {draftConclusions!.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
            <p className="label-caps">前置分析（体检 / 综述，随本次生成提交）</p>
            {!checkupSummary && !reviewSummary ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                还没有前置分析。到「选题体检」或「文献综述」生成结论后，这里会带上摘要，方案将参考它们而不是从零推断。
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                {checkupSummary ? <li>体检：{checkupSummary}</li> : null}
                {reviewSummary ? <li>综述：{reviewSummary}</li> : null}
              </ul>
            )}
          </div>

          <div className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
            <p className="label-caps">已核对证据（会随约束一起提交给模型）</p>
            {verifiedAll.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                还没有任何已核对的证据字段。到「文献库 → 证据卡」逐字段填写并标记已核对后，这里会列出可提交的内容；
                模型将能引用你核对过的论文内容，而不只是聚类统计。
              </p>
            ) : (
              <div className="space-y-1.5">
                {verifiedAll.map((item) => {
                  const included = !excludedPapers.includes(item.paperId);
                  return (
                    <label key={item.paperId} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() =>
                          setExcludedPapers((prev) =>
                            included ? [...prev, item.paperId] : prev.filter((id) => id !== item.paperId),
                          )
                        }
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium">{item.paperTitle}</span>
                        <span className="text-muted-foreground">
                          {" "}· {item.fields.map((f) => f.label).join(" / ")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              本次提交 {verified.length} 篇 / {verified.reduce((n, v) => n + v.fields.length, 0)} 个已核对字段。
              未勾选的不会发送。模型看到的是这些人工核对内容 + 聚类统计 + 论文标题/摘要节选。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              onClick={() => void generate()}
              disabled={!context || status === "loading"}
            >
              {status === "loading" ? "生成中…" : "生成研究方案"}
            </Button>
            {status === "ready" && plan ? (
              <>
                <Button variant="outline" size="sm" onClick={exportPlan}>
                  导出方案 Markdown
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportRepro}
                  disabled={!frozen || !storedMarkdown}
                  title={frozen ? undefined : "档案载入的方案没有生成时输入快照，无法导出复现包"}
                >
                  导出复现包 JSON
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (editing) {
                      setStoredMarkdown(editText);
                      setRevised(true);
                      setEditing(false);
                    } else {
                      setEditText(storedMarkdown ?? "");
                      setEditing(true);
                    }
                  }}
                >
                  {editing ? "保存修订" : "人工修订"}
                </Button>
                {revised ? <Badge variant="secondary">含人工修订</Badge> : null}
              </>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              {context
                ? `基于当前检索样本 ${context.corpus.size} 篇、${context.clusters.length} 个方向`
                : "还没有检索结果"}
            </span>
          </div>

          {editing ? (
            <div className="space-y-1.5">
              <p className="label-caps">人工修订方案文本（保存后导出使用修订版）</p>
              <Textarea
                value={editText}
                onChange={(event) => setEditText(event.target.value)}
                rows={16}
                className="font-mono text-[11px]"
              />
              <p className="text-[11px] text-muted-foreground">
                修订只改导出文本，不重新调用模型；导出会标注「含人工修订」。点「保存修订」生效。
              </p>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {plan && stale ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          依据已变化（检索 / 约束 / 资源 / 已核对证据与生成时不一致）。下面显示的是上次生成的方案，
          导出仍用生成时的冻结内容；请重新生成以匹配当前研究现场。
        </div>
      ) : null}

      {plan && !frozen && restoredPlan ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          此方案载入自研究档案，导出使用存档时的方案内容。若当前检索或约束已变化，请重新生成。
        </div>
      ) : null}

      {status === "ready" && plan ? (
        <div className="space-y-4">
          {resourceWarnings.length > 0 ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">
              模型代猜了未提供的约束：{resourceWarnings.join("、")}。已移入「待补充条件」；
              请补充对应约束或核实这些资源后重新生成，不要直接采信正文里的这些设定。
            </div>
          ) : null}
          {numberWarnings.length > 0 ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              正文数字未核对：{numberWarnings.join("、")}。这些数字不在送入模型的统计白名单内，
              请回到论文原文人工核对后再引用。
            </div>
          ) : null}
          <section className="space-y-2">
            <h2 className="heading-cn text-base">{plan.title}</h2>
            <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-5">
              {plan.scores.map((score) => (
                <div key={score.dimension} className="bg-background px-3 py-2">
                  <div className="label-caps">{score.dimension}</div>
                  <div className="mt-0.5 font-display text-sm font-medium tabular-nums">
                    {score.score}/5
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {score.reason || "模型未给出原因"}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              评分只用于排序，不替代你的判断；每项分数旁边是它的扣分原因。
            </p>
          </section>

          {plan.chainAudit ? (
            <figure className="figure-panel px-3 py-2.5">
              <figcaption className="label-caps mb-1">
                逻辑链自洽检查（局限→想法→挑战→方法→结果）
              </figcaption>
              <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                {plan.chainAudit}
              </p>
            </figure>
          ) : null}

          {plan.missing.length > 0 ? (
            <figure className="figure-panel px-3 py-2.5">
              <figcaption className="label-caps mb-1">待补充条件（模型没有替你猜）</figcaption>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                {plan.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </figure>
          ) : null}

          <section className="space-y-3">
            {PLAN_SECTIONS.map((section) => (
              <article key={section.key} className="rounded-md border border-border px-4 py-3">
                <h3 className="heading-cn text-sm">
                  <span className="mr-2 tabular-nums text-muted-foreground">
                    {String(section.number).padStart(2, "0")}
                  </span>
                  {section.title}
                </h3>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  {plan.sections[section.key] || "当前材料无法判断。"}
                </p>
              </article>
            ))}
          </section>

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold">方案引用的证据</h3>
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
              {plan.evidenceIds.length === 0 ? (
                <span className="text-[11px] text-destructive">模型没有给出证据引用</span>
              ) : null}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              由 {model ?? "大模型"} 基于当前检索样本生成。方案中的每个判断都要回到上面的数字核对，
              还没有经过全文核对。
            </p>
          </section>

          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">
              {plan.evidenceIds.length} 条证据引用
            </Badge>
            {resolved.unknown.length > 0 ? (
              <Badge variant="destructive">{resolved.unknown.length} 条引用无法核对</Badge>
            ) : null}
          </div>

          {frozen ? (
            <details className="rounded-md border border-border px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium">
                生成时输入快照（已冻结，导出与复现包均以此为准）
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed text-muted-foreground">
                <p>
                  模型：{model ?? "未记录"} ｜ 生成时间：{generatedAt ?? "未记录"}
                </p>
                <div>
                  <p className="font-medium text-foreground">约束</p>
                  {Object.keys(frozen.constraints).length === 0 ? (
                    <p>未填写任何约束（缺项全部进入待补充，不允许模型代猜）。</p>
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {Object.entries(frozen.constraints).map(([key, value]) => (
                        <li key={key}>
                          {CONSTRAINT_LABELS[key] ?? key}：{value}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    资源（{frozen.resources.filter((item) => item.name.trim()).length} 项）
                  </p>
                  {frozen.resources.filter((item) => item.name.trim()).length === 0 ? (
                    <p>未登记任何资源。</p>
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {frozen.resources
                        .filter((item) => item.name.trim())
                        .map((item, index) => (
                          <li key={index}>
                            {RESOURCE_KIND_LABEL[item.kind]} · {item.name} ·{" "}
                            {RESOURCE_STATUS_LABEL[item.status]}
                            {item.url.trim() ? ` · ${item.url.trim()}` : ""}
                            {item.license.trim() ? ` · 许可：${item.license.trim()}` : ""}
                            {item.accessCondition.trim()
                              ? ` · 获取条件：${item.accessCondition.trim()}`
                              : ""}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    已核对证据（{frozen.verified.length} 篇）
                  </p>
                  {frozen.verified.length === 0 ? (
                    <p>未提交已核对证据。</p>
                  ) : (
                    <ul className="list-disc space-y-1 pl-4">
                      {frozen.verified.map((item) => (
                        <li key={item.paperId}>
                          <span className="text-foreground">{item.paperTitle}</span>
                          <ul className="list-[circle] space-y-0.5 pl-4">
                            {item.fields.map((field) => (
                              <li key={field.key}>
                                {field.label}：{field.value}
                                {field.location ? `（位置：${field.location}）` : ""}
                                {field.verifiedAt ? `（核对于 ${field.verifiedAt}）` : ""}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    草稿结论（{frozen.draftConclusions.length} 条）
                  </p>
                  {frozen.draftConclusions.length === 0 ? (
                    <p>无。</p>
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {frozen.draftConclusions.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <p>体检摘要：{frozen.checkupSummary ?? "无"}</p>
                <p>综述摘要：{frozen.reviewSummary ?? "无"}</p>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
