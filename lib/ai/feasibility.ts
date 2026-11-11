import type { RadarResult, TopicCluster } from "../analysis/radar";
import type { Paper, SearchReport } from "../data/types";
import { formatGB7714 } from "../export";
import type { DirectionContext } from "./directions";

/**
 * 选题体检：评估框架改编自 HKUSTDial/Supervisor-Skills 的 idea-evaluator（CC-BY-4.0），
 * 新颖性核对改为绑定 TopicScope 当前检索样本里的真实编号文献。
 */

export type Decision = "accept" | "revise" | "reject";
export type Severity = "critical" | "major" | "minor";
export type Fit = "green" | "yellow" | "red";
export type Basis = "data" | "mechanism" | "none";
export type DimensionKey = "higher" | "faster" | "stronger" | "cheaper" | "broader";

export const DECISION_META: Record<Decision, { label: string; summary: string }> = {
  accept: { label: "强烈接受 · 可以启动", summary: "两个以上维度有明确优势，且没有致命缺陷。" },
  revise: { label: "修改后接受 · 先调整范围", summary: "有潜力但存在可修复的缺陷或能力错配，先按建议收窄或补强。" },
  reject: { label: "拒绝并转向 · 不建议做这个版本", summary: "存在当前资源下无法防御的致命缺陷，换方向或换设定。" },
};

export const DIMENSION_META: Record<DimensionKey, { label: string; goal: string }> = {
  higher: { label: "更高", goal: "精度与效果提升" },
  faster: { label: "更快", goal: "效率与推理成本下降" },
  stronger: { label: "更强", goal: "鲁棒性与泛化" },
  cheaper: { label: "更省", goal: "数据与标注成本下降" },
  broader: { label: "更广", goal: "跨领域移植或统一" },
};

export const DIMENSION_ORDER: DimensionKey[] = ["higher", "faster", "stronger", "cheaper", "broader"];

export const BASIS_LABEL: Record<Basis, string> = {
  data: "有数据支撑",
  mechanism: "机制推断，未经数据验证",
  none: "未给出依据",
};

export interface CapabilityProfile {
  weeklyHours: number;
  months: number;
  coding: number;
  theory: number;
  compute: "none" | "consumer" | "server";
  data: "public" | "apply" | "private";
}

export const DEFAULT_CAPABILITY: CapabilityProfile = {
  weeklyHours: 20,
  months: 6,
  coding: 3,
  theory: 2,
  compute: "consumer",
  data: "public",
};

export const COMPUTE_LABEL: Record<CapabilityProfile["compute"], string> = {
  none: "无 GPU，只有 CPU",
  consumer: "1–2 张消费级 GPU",
  server: "多卡服务器（A100 级）",
};

export const DATA_LABEL: Record<CapabilityProfile["data"], string> = {
  public: "公开数据即可开展",
  apply: "数据需申请或审批",
  private: "依赖私有/受限数据",
};

export interface FeasibilityRef {
  n: number;
  paper: Paper;
}

export interface Flaw {
  code: string;
  name: string;
  severity: Severity;
  detail: string;
  defense: string;
}

export interface DimensionScore {
  key: DimensionKey;
  score: number;
  basis: Basis;
  evidence: string;
}

export interface ParadigmProbe {
  probe: string;
  answer: "yes" | "partial" | "no";
  reason: string;
}

export interface RiskItem {
  kind: string;
  level: "low" | "medium" | "high";
  mitigation: string;
}

export interface FeasibilityResult {
  firstImpression: { paperType: string; story: string };
  flaws: Flaw[];
  lifecycle: { category: string; window: string; fit: Fit; reason: string };
  dimensions: DimensionScore[];
  paradigm: ParadigmProbe[];
  risks: RiskItem[];
  verdict: { decision: Decision; reason: string; actions: string[] };
  limitation: string;
  maxN: number;
}

/** 从目标方向挑最相关文献做新颖性核对：被引最高 6 篇 + 最新 4 篇（去重）。 */
export function buildFeasibilityRefs(
  radar: RadarResult,
  byId: Map<string, Paper>,
  clusterId: number | null,
): FeasibilityRef[] {
  let members: Paper[];
  if (clusterId !== null) {
    const cluster = radar.clusters.find((c) => c.id === clusterId);
    members = (cluster?.paperIds ?? [])
      .map((id) => byId.get(id))
      .filter((paper): paper is Paper => Boolean(paper));
  } else {
    members = radar.clusters
      .slice(0, 3)
      .flatMap((c) => c.paperIds.map((id) => byId.get(id)))
      .filter((paper): paper is Paper => Boolean(paper));
  }
  const byCited = [...members].sort((a, b) => b.citedByCount - a.citedByCount);
  const byYear = [...members].sort((a, b) => b.year - a.year);
  const picked: Paper[] = [];
  const seen = new Set<string>();
  for (const paper of [...byCited.slice(0, 6), ...byYear.slice(0, 4)]) {
    if (seen.has(paper.id)) continue;
    seen.add(paper.id);
    picked.push(paper);
    if (picked.length >= 10) break;
  }
  return picked.map((paper, i) => ({ n: i + 1, paper }));
}

export function buildFeasibilityPayload(
  context: DirectionContext,
  radar: RadarResult,
  byId: Map<string, Paper>,
  clusterId: number | null,
  idea: string,
  capability: CapabilityProfile,
): { payload: Record<string, unknown>; refs: FeasibilityRef[]; cluster: TopicCluster | null } {
  const refs = buildFeasibilityRefs(radar, byId, clusterId);
  const cluster = clusterId !== null ? radar.clusters.find((c) => c.id === clusterId) ?? null : null;
  const payload = {
    context,
    idea,
    capability: {
      weeklyHours: capability.weeklyHours,
      months: capability.months,
      coding: capability.coding,
      theory: capability.theory,
      compute: COMPUTE_LABEL[capability.compute],
      data: DATA_LABEL[capability.data],
    },
    target: cluster
      ? {
          name: cluster.name,
          verdict: cluster.verdict,
          size: cluster.size,
          sizeShare: Math.round(cluster.sizeShare * 1000) / 10,
          recentShare: Math.round(cluster.recentShare * 100),
          medianYear: cluster.medianYear,
          crowding: cluster.crowding,
          reason: cluster.verdictReason,
        }
      : null,
    papers: refs.map(({ n, paper }) => ({
      n,
      title: paper.title,
      year: paper.year,
      venue: paper.venue,
      doi: paper.doi,
      abstract: (paper.abstract ?? "").slice(0, 500),
    })),
  };
  return { payload, refs, cluster };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** 客户端兜底解析：服务端已校验过一遍，这里只保证渲染安全。 */
export function parseFeasibility(value: unknown): FeasibilityResult | null {
  const body = asRecord(value);
  if (!body) return null;
  const first = asRecord(body.firstImpression);
  const verdict = asRecord(body.verdict);
  if (!first || !verdict) return null;
  const decision = asText(verdict.decision);
  if (decision !== "accept" && decision !== "revise" && decision !== "reject") return null;

  const flaws: Flaw[] = [];
  if (Array.isArray(body.flaws)) {
    for (const item of body.flaws) {
      const record = asRecord(item);
      if (!record) continue;
      const severity = asText(record.severity);
      if (severity !== "critical" && severity !== "major" && severity !== "minor") continue;
      flaws.push({
        code: asText(record.code),
        name: asText(record.name),
        severity,
        detail: asText(record.detail),
        defense: asText(record.defense),
      });
      if (flaws.length >= 2) break;
    }
  }

  const lifecycleRaw = asRecord(body.lifecycle) ?? {};
  const fit = asText(lifecycleRaw.fit);
  const lifecycle = {
    category: asText(lifecycleRaw.category) || "未分类",
    window: asText(lifecycleRaw.window),
    fit: (fit === "green" || fit === "yellow" || fit === "red" ? fit : "yellow") as Fit,
    reason: asText(lifecycleRaw.reason),
  };

  const dimensions: DimensionScore[] = [];
  const dimRaw = Array.isArray(body.dimensions) ? body.dimensions : [];
  for (const key of DIMENSION_ORDER) {
    const record = dimRaw.map(asRecord).find((d) => d && asText(d.key) === key) ?? null;
    const score = record ? Number(record.score) : NaN;
    const basis = record ? asText(record.basis) : "";
    dimensions.push({
      key,
      score: Number.isFinite(score) ? Math.min(10, Math.max(1, Math.round(score))) : 5,
      basis: basis === "data" || basis === "mechanism" ? (basis as Basis) : "none",
      evidence: record ? asText(record.evidence) : "模型未给出该维度依据",
    });
  }

  const paradigm: ParadigmProbe[] = [];
  if (Array.isArray(body.paradigm)) {
    for (const item of body.paradigm) {
      const record = asRecord(item);
      if (!record) continue;
      const answer = asText(record.answer);
      if (answer !== "yes" && answer !== "partial" && answer !== "no") continue;
      paradigm.push({ probe: asText(record.probe), answer, reason: asText(record.reason) });
      if (paradigm.length >= 4) break;
    }
  }

  const risks: RiskItem[] = [];
  if (Array.isArray(body.risks)) {
    for (const item of body.risks) {
      const record = asRecord(item);
      if (!record) continue;
      const level = asText(record.level);
      if (level !== "low" && level !== "medium" && level !== "high") continue;
      risks.push({ kind: asText(record.kind), level, mitigation: asText(record.mitigation) });
      if (risks.length >= 4) break;
    }
  }

  const actions = Array.isArray(verdict.actions)
    ? verdict.actions.map(asText).filter(Boolean).slice(0, 3)
    : [];

  return {
    firstImpression: { paperType: asText(first.paperType), story: asText(first.story) },
    flaws,
    lifecycle,
    dimensions,
    paradigm,
    risks,
    verdict: { decision, reason: asText(verdict.reason), actions },
    limitation: asText(body.limitation),
    maxN: typeof body.maxN === "number" ? body.maxN : 0,
  };
}

/**
 * 完整性自检（对应 idea-evaluator 的 Integrity gate）：
 * 结论必须与评分、缺陷一致，不一致就降级并明示原因。
 */
export function integrityCheck(result: FeasibilityResult): { decision: Decision; notes: string[] } {
  const notes: string[] = [];
  let decision = result.verdict.decision;
  const hasCritical = result.flaws.some((f) => f.severity === "critical");
  if (hasCritical && decision !== "reject") {
    decision = "reject";
    notes.push("存在 CRITICAL 级致命缺陷，结论已按规则降级为「拒绝并转向」。");
  }
  const strong = result.dimensions.filter((d) => d.score >= 8).length;
  if (decision === "accept" && strong < 2) {
    decision = "revise";
    notes.push(`「强烈接受」需要至少两个维度 ≥8 分，当前只有 ${strong} 个，已降级为「修改后接受」。`);
  }
  for (const dim of result.dimensions) {
    if (dim.basis === "none" && dim.score > 5) {
      notes.push(`「${DIMENSION_META[dim.key].label}」维度未给出依据却高于默认 5 分，该分数不可采信。`);
    }
  }
  return { decision, notes };
}

export function paradigmScore(probes: ParadigmProbe[]): number {
  return probes.reduce((sum, p) => sum + (p.answer === "yes" ? 2 : p.answer === "partial" ? 1 : 0), 0);
}

export function feasibilityToMarkdown(
  result: FeasibilityResult,
  refs: FeasibilityRef[],
  idea: string,
  capability: CapabilityProfile,
  cluster: TopicCluster | null,
  report: SearchReport | null,
  model?: string | null,
): string {
  const { decision, notes } = integrityCheck(result);
  const lines: string[] = [`# 选题体检报告：${result.firstImpression.story.slice(0, 40) || "未命名想法"}`, ""];
  if (report) {
    lines.push(
      `> 检索：${report.job.rawQuestion}｜样本 ${report.totalAfterDedup} 篇｜检索于 ${report.retrievedAt.slice(0, 10)}`,
    );
  }
  lines.push(`> 想法：${idea}`);
  lines.push(
    `> 能力自报：每周 ${capability.weeklyHours} 小时｜预算 ${capability.months} 个月｜编码 ${capability.coding}/5｜理论 ${capability.theory}/5｜${COMPUTE_LABEL[capability.compute]}｜${DATA_LABEL[capability.data]}`,
  );
  if (cluster) lines.push(`> 目标方向：${cluster.name}（样本 ${cluster.size} 篇，占 ${(cluster.sizeShare * 100).toFixed(1)}%）`);
  lines.push("", `## 结论：${DECISION_META[decision].label}`, "", result.verdict.reason, "");
  for (const note of notes) lines.push(`> 完整性自检：${note}`);
  if (notes.length > 0) lines.push("");

  lines.push("## 一、第一印象", "", `- 论文类型：${result.firstImpression.paperType}`, `- 一句话故事：${result.firstImpression.story}`, "");

  lines.push("## 二、致命缺陷审计", "");
  if (result.flaws.length === 0) {
    lines.push("未发现致命缺陷（基于当前样本与自报能力）。", "");
  } else {
    lines.push("| 缺陷 | 严重性 | 说明 | 防御 |", "|---|---|---|---|");
    for (const flaw of result.flaws) {
      lines.push(`| ${flaw.code} ${flaw.name} | ${flaw.severity.toUpperCase()} | ${flaw.detail} | ${flaw.defense} |`);
    }
    lines.push("");
  }

  lines.push(
    "## 三、生命周期与能力匹配",
    "",
    `- 类别：${result.lifecycle.category}（窗口 ${result.lifecycle.window}）`,
    `- 匹配：${result.lifecycle.fit === "green" ? "绿灯" : result.lifecycle.fit === "yellow" ? "黄灯" : "红灯"} — ${result.lifecycle.reason}`,
    "",
  );

  lines.push("## 四、五维评分", "", "| 维度 | 分数 | 依据类型 | 证据 |", "|---|---|---|---|");
  for (const dim of result.dimensions) {
    lines.push(`| ${DIMENSION_META[dim.key].label}（${DIMENSION_META[dim.key].goal}） | ${dim.score}/10 | ${BASIS_LABEL[dim.basis]} | ${dim.evidence} |`);
  }
  lines.push("");

  if (result.paradigm.length > 0) {
    lines.push(`## 五、范式跃迁探测（${paradigmScore(result.paradigm)}/8）`, "");
    for (const probe of result.paradigm) {
      lines.push(`- ${probe.probe}：${probe.answer === "yes" ? "是" : probe.answer === "partial" ? "部分" : "否"} — ${probe.reason}`);
    }
    lines.push("");
  }

  if (result.risks.length > 0) {
    lines.push("## 六、可行性风险", "", "| 风险 | 等级 | 缓解 |", "|---|---|---|");
    for (const risk of result.risks) {
      lines.push(`| ${risk.kind} | ${risk.level} | ${risk.mitigation} |`);
    }
    lines.push("");
  }

  if (result.verdict.actions.length > 0) {
    lines.push("## 七、先做的三件事", "");
    result.verdict.actions.forEach((action, i) => lines.push(`${i + 1}. ${action}`));
    lines.push("");
  }

  if (refs.length > 0) {
    lines.push("## 新颖性核对文献（GB/T 7714）", "");
    for (const { n, paper } of refs) lines.push(formatGB7714(paper, n));
    lines.push("");
  }

  if (result.limitation) lines.push("## 局限", "", result.limitation, "");
  lines.push("---", "");
  lines.push(
    `由 ${model ?? "大模型"} 基于 TopicScope 当前检索样本生成。评估框架改编自 HKUSTDial/Supervisor-Skills 的 idea-evaluator（CC-BY-4.0）。判定只反映当前样本与自报能力，不构成真实投稿结果预测；机制推断类高分需先完成指定的验证实验。`,
  );
  return lines.join("\n");
}