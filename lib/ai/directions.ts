import type { CooccurrenceGraph, TermPair } from "@/lib/analysis/cooccurrence";
import type { RadarResult } from "@/lib/analysis/radar";

export type { TermPair };

export type EvidenceKind = "cluster" | "pair" | "corpus";

/**
 * 稳定证据条目：模型只能引用这些 ID，不能自由编造引用文本。
 * ID 一旦生成就固定不变，前端可以据此回查到具体数字。
 */
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  label: string;
  value: string;
  /** 这个数字来自哪里 */
  origin: string;
}

export interface ClusterBrief {
  name: string;
  verdict: string;
  size: number;
  sizeShare: number;
  yearRange: [number, number];
  medianYear: number;
  recentShare: number;
  fiveYearShare: number;
  citationMedian: number;
  crowding: number;
  reason: string;
  terms: string[];
  venues: { name: string; count: number }[];
  /** 该方向内被引最高的代表论文，方案与对话只允许引用这些真实论文 */
  papers: { title: string; year: number; venue: string | null; citedByCount: number }[];
  /** 该方向内部共现最紧密的词对 */
  pairs: TermPair[];
}

export interface DirectionContext {
  query: string;
  corpus: {
    size: number;
    yearRange: [number, number];
    clusterCount: number;
    abstractCoverage: number;
    oaCoverage: number;
  };
  clusters: ClusterBrief[];
  /** 全语料共现提升度最高的词对 */
  pairs: TermPair[];
  /** 允许模型引用的证据条目 */
  evidence: EvidenceItem[];
}

const VERDICT_LABEL: Record<string, string> = {
  saturated: "高密度成熟方向",
  mature: "稳定产出方向",
  emerging: "增长窗口",
  gap: "当前检索未观察到",
  insufficient: "证据不足",
};

/** 方向名里带空格和点，构造 ID 时换成安全字符 */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}

function buildEvidence(
  clusters: ClusterBrief[],
  pairs: TermPair[],
  corpus: DirectionContext["corpus"],
): EvidenceItem[] {
  const items: EvidenceItem[] = [
    {
      id: "corpus:size",
      kind: "corpus",
      label: "当前检索样本规模",
      value: `${corpus.size} 篇`,
      origin: "检索快照",
    },
    {
      id: "corpus:yearRange",
      kind: "corpus",
      label: "样本年份跨度",
      value: `${corpus.yearRange[0]}–${corpus.yearRange[1]}`,
      origin: "检索快照",
    },
    {
      id: "corpus:abstractCoverage",
      kind: "corpus",
      label: "摘要覆盖率",
      value: `${corpus.abstractCoverage}%`,
      origin: "检索快照",
    },
  ];

  for (const cluster of clusters) {
    const base = `cluster:${slug(cluster.name)}`;
    items.push(
      {
        id: `${base}:size`,
        kind: "cluster",
        label: `${cluster.name} · 样本论文数`,
        value: `${cluster.size} 篇`,
        origin: "方向雷达",
      },
      {
        id: `${base}:sizeShare`,
        kind: "cluster",
        label: `${cluster.name} · 占当前检索样本`,
        value: `${cluster.sizeShare}%`,
        origin: "方向雷达",
      },
      {
        id: `${base}:recentShare`,
        kind: "cluster",
        label: `${cluster.name} · 近三年占比`,
        value: `${cluster.recentShare}%`,
        origin: "方向雷达",
      },
      {
        id: `${base}:crowding`,
        kind: "cluster",
        label: `${cluster.name} · 拥挤度`,
        value: `${cluster.crowding}/100`,
        origin: "方向雷达",
      },
      {
        id: `${base}:citationMedian`,
        kind: "cluster",
        label: `${cluster.name} · 被引中位数`,
        value: String(cluster.citationMedian),
        origin: "方向雷达",
      },
      {
        id: `${base}:medianYear`,
        kind: "cluster",
        label: `${cluster.name} · 中位发表年份`,
        value: String(cluster.medianYear),
        origin: "方向雷达",
      },
    );
  }

  for (const pair of pairs) {
    const base = `pair:${slug(pair.a)}-${slug(pair.b)}`;
    items.push(
      {
        id: `${base}:lift`,
        kind: "pair",
        label: `${pair.a}—${pair.b} · 共现提升度`,
        value: String(pair.lift),
        origin: "共现图",
      },
      {
        id: `${base}:count`,
        kind: "pair",
        label: `${pair.a}—${pair.b} · 共现论文数`,
        value: `${pair.count} 篇`,
        origin: "共现图",
      },
    );
  }

  return items;
}

export function buildDirectionContext(
  query: string,
  radar: RadarResult,
  graph: CooccurrenceGraph | null,
  clusterPairs: Map<number, TermPair[]>,
  corpusStats: { abstractCoverage: number; oaCoverage: number },
): DirectionContext {
  const clusters: ClusterBrief[] = radar.clusters.map((cluster) => ({
    name: cluster.name,
    verdict: VERDICT_LABEL[cluster.verdict] ?? cluster.verdict,
    size: cluster.size,
    sizeShare: Math.round(cluster.sizeShare * 1000) / 10,
    yearRange: cluster.yearRange,
    medianYear: cluster.medianYear,
    recentShare: Math.round(cluster.recentShare * 100),
    fiveYearShare: Math.round(cluster.fiveYearShare * 100),
    citationMedian: cluster.citationMedian,
    crowding: cluster.crowding,
    reason: cluster.verdictReason,
    terms: cluster.terms,
    venues: cluster.topVenues,
    papers: cluster.topPapers.map((paper) => ({
      title: paper.title,
      year: paper.year,
      venue: paper.venue,
      citedByCount: paper.citedByCount,
    })),
    pairs: clusterPairs.get(cluster.id) ?? [],
  }));

  const pairs = [...(graph?.edges ?? [])]
    .sort((a, b) => b.lift - a.lift || b.weight - a.weight)
    .slice(0, 12)
    .map((edge) => ({
      a: edge.source,
      b: edge.target,
      lift: Math.round(edge.lift * 100) / 100,
      count: edge.weight,
    }));

  const corpus = {
    size: radar.clusters.reduce((sum, cluster) => sum + cluster.size, 0),
    yearRange: radar.yearRange,
    clusterCount: radar.clusterCount,
    abstractCoverage: corpusStats.abstractCoverage,
    oaCoverage: corpusStats.oaCoverage,
  };

  return {
    query,
    corpus,
    clusters,
    pairs,
    evidence: buildEvidence(clusters, pairs, corpus),
  };
}

export interface DirectionSuggestion {
  title: string;
  /** 一句话说清要解决什么问题 */
  question: string;
  /** 为什么现在做，必须引用给定数字 */
  why: string;
  /** 切入方式 */
  entry: string;
  /** 需要什么数据、复现什么基线 */
  evidence: string;
  /** 算力与时间估计 */
  cost: string;
  /** 最大的不确定性 */
  risk: string;
  /** 可做性 1–5 */
  feasibility: number;
  /** 引用的证据 ID（必须来自 evidence 列表） */
  evidenceIds: string[];
}

const FIELDS: (keyof DirectionSuggestion)[] = [
  "title",
  "question",
  "why",
  "entry",
  "evidence",
  "cost",
  "risk",
];

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseSuggestions(raw: unknown): DirectionSuggestion[] {
  if (!raw || typeof raw !== "object") return [];
  const body = raw as Record<string, unknown>;
  const list = Array.isArray(body.suggestions) ? body.suggestions : [];
  const suggestions: DirectionSuggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const parsed = {} as Record<string, unknown>;
    let valid = true;
    for (const field of FIELDS) {
      const text = asText(record[field]);
      if (!text) valid = false;
      parsed[field] = text;
    }
    if (!valid) continue;
    const feasibility = Number(record.feasibility);
    if (!Number.isFinite(feasibility)) continue;
    const evidenceIds = Array.isArray(record.evidenceIds)
      ? record.evidenceIds.map(asText).filter(Boolean).slice(0, 8)
      : [];
    suggestions.push({
      ...(parsed as unknown as Omit<DirectionSuggestion, "feasibility" | "evidenceIds">),
      feasibility: Math.min(5, Math.max(1, Math.round(feasibility))),
      evidenceIds,
    });
  }
  return suggestions;
}

/** 把证据 ID 解析成可展示的条目；返回未识别的 ID（模型编造的引用）。 */
export function resolveEvidence(
  evidenceIds: string[],
  context: DirectionContext,
): { items: EvidenceItem[]; unknown: string[] } {
  const index = new Map(context.evidence.map((item) => [item.id, item]));
  const items: EvidenceItem[] = [];
  const unknown: string[] = [];
  for (const id of evidenceIds) {
    const item = index.get(id);
    if (item) items.push(item);
    else unknown.push(id);
  }
  return { items, unknown };
}

/**
 * 依据可核对：模型引用的每个 ID 都必须能在证据表里找到，
 * 且至少引用一条；否则标为「依据无法核对」。
 */
export function isGrounded(suggestion: DirectionSuggestion, context: DirectionContext): boolean {
  if (suggestion.evidenceIds.length === 0) return false;
  const { unknown } = resolveEvidence(suggestion.evidenceIds, context);
  return unknown.length === 0;
}
