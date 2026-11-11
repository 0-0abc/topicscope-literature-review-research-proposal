import type { EvidenceItem } from "@/lib/ai/directions";

/** 方案生成前的用户约束，缺项不猜，写进「待补充条件」。 */
export interface PlanConstraints {
  /** 研究对象与任务 */
  object?: string;
  task?: string;
  /** 可用数据集或数据获取渠道 */
  datasets?: string;
  /** 算力条件 */
  compute?: string;
  /** 目标完成时间 */
  timeline?: string;
  /** 是否要求开放代码 */
  openCode?: string;
  /** 预期产出形式 */
  target?: string;
}

export type ResourceKind = "dataset" | "code" | "model" | "annotation";

/**
 * 资源可获得性。数据公开不代表标注与划分公开，
 * 所以「可取得」和「可复现」必须分开判断。
 */
export type ResourceStatus =
  | "public"
  | "controlled"
  | "third_party_restricted"
  | "within_paper"
  | "not_verified";

export interface ResourceRoute {
  kind: ResourceKind;
  name: string;
  status: ResourceStatus;
  url?: string;
  license?: string;
  accessCondition?: string;
}

export const RESOURCE_STATUS_LABEL: Record<ResourceStatus, string> = {
  public: "公开可取",
  controlled: "需申请或审批",
  third_party_restricted: "受第三方许可限制",
  within_paper: "只在论文里描述",
  not_verified: "尚未核验",
};

export const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = {
  dataset: "数据集",
  code: "代码",
  model: "预训练模型",
  annotation: "标注",
};

export const PLAN_SECTIONS = [
  { key: "problem", number: 1, title: "一句话研究问题" },
  { key: "background", number: 2, title: "背景与已有证据" },
  { key: "novelty", number: 3, title: "方向位置与新颖性边界" },
  { key: "hypotheses", number: 4, title: "可验证假设" },
  { key: "datasets", number: 5, title: "数据集与获取方式" },
  { key: "baselines", number: 6, title: "基线与对照" },
  { key: "method", number: 7, title: "方法设计" },
  { key: "metrics", number: 8, title: "指标与统计方法" },
  { key: "experiments", number: 9, title: "实验矩阵" },
  { key: "resources", number: 10, title: "复现与资源需求" },
  { key: "risks", number: 11, title: "风险与失败判据" },
  { key: "milestones", number: 12, title: "里程碑与时间安排" },
  { key: "outcomes", number: 13, title: "预期结果与替代路线" },
  { key: "references", number: 14, title: "参考文献" },
  { key: "evidenceIndex", number: 15, title: "证据索引" },
] as const;

export type PlanSectionKey = (typeof PLAN_SECTIONS)[number]["key"];

export const SCORE_DIMENSIONS = [
  "证据充分度",
  "研究问题清晰度",
  "基线可获得性",
  "资源可行性",
  "风险可控性",
] as const;

export interface PlanScore {
  dimension: string;
  score: number;
  reason: string;
}

export interface ResearchPlan {
  title: string;
  sections: Record<PlanSectionKey, string>;
  /** 四步逻辑链自洽检查（局限→想法→挑战→方法→结果） */
  chainAudit: string;
  scores: PlanScore[];
  /** 缺少的关键约束 */
  missing: string[];
  /** 方案引用的证据 ID */
  evidenceIds: string[];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parsePlan(raw: unknown): ResearchPlan | null {
  if (!isRecord(raw)) return null;
  const sections = isRecord(raw.sections) ? raw.sections : null;
  if (!sections) return null;

  const parsed = {} as Record<PlanSectionKey, string>;
  for (const section of PLAN_SECTIONS) {
    parsed[section.key] = asText(sections[section.key]);
  }

  const scores: PlanScore[] = [];
  if (Array.isArray(raw.scores)) {
    for (const item of raw.scores) {
      if (!isRecord(item)) continue;
      const dimension = asText(item.dimension);
      const score = Number(item.score);
      if (!dimension || !Number.isFinite(score)) continue;
      scores.push({
        dimension,
        score: Math.min(5, Math.max(0, Math.round(score))),
        reason: asText(item.reason),
      });
    }
  }
  for (const dimension of SCORE_DIMENSIONS) {
    if (!scores.some((score) => score.dimension === dimension)) {
      scores.push({ dimension, score: 0, reason: "模型未给出该维度评分" });
    }
  }

  const missing = Array.isArray(raw.missing)
    ? raw.missing.map(asText).filter(Boolean).slice(0, 10)
    : [];
  const evidenceIds = Array.isArray(raw.evidenceIds)
    ? raw.evidenceIds.map(asText).filter(Boolean).slice(0, 12)
    : [];

  return {
    title: asText(raw.title) || "研究方案",
    sections: parsed as Record<PlanSectionKey, string>,
    chainAudit: asText(raw.chainAudit),
    scores,
    missing,
    evidenceIds,
  };
}

/** 把证据 ID 解析成条目，分开列出模型编造的引用。 */
export function resolvePlanEvidence(
  evidenceIds: string[],
  evidence: EvidenceItem[],
): { items: EvidenceItem[]; unknown: string[] } {
  const index = new Map(evidence.map((item) => [item.id, item]));
  const items: EvidenceItem[] = [];
  const unknown: string[] = [];
  for (const id of evidenceIds) {
    const item = index.get(id);
    if (item) items.push(item);
    else unknown.push(id);
  }
  return { items, unknown };
}
