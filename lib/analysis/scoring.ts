import type { Paper } from "../data/types";

export type ScoreDimensionKey =
  | "问题匹配度"
  | "方法相关度"
  | "证据完整度"
  | "可复现程度"
  | "时效与趋势价值"
  | "用户约束适配";

export interface ScoreBreakdown {
  dimension: ScoreDimensionKey;
  /** 实际得分 */
  score: number;
  /** 满分 */
  max: number;
  /** 这一项为什么是这个分 */
  reason: string;
  /** 可回查的证据 ID（论文与检索快照） */
  evidenceIds: string[];
}

export type ScorePreference = "balanced" | "low_compute" | "newest" | "open_data";

export const PREFERENCE_LABEL: Record<ScorePreference, string> = {
  balanced: "综合",
  low_compute: "低算力",
  newest: "最新",
  open_data: "开放数据",
};

export interface ScoreContext {
  /** 用户检索式 */
  query: string;
  /** 检索式拆出的词 */
  queryTerms: string[];
  /** 论文所属方向 id */
  clusterOf: (paper: Paper) => number | undefined;
  /** 方向的代表词与近三年占比 */
  clusterInfo: (
    id: number,
  ) => { terms: string[]; recentShare: number; crowding: number } | undefined;
  /** 排序偏好 */
  preference: ScorePreference;
  /** 语料里的最新年份 */
  maxYear: number;
}

const WEIGHTS: Record<ScoreDimensionKey, number> = {
  问题匹配度: 30,
  方法相关度: 20,
  证据完整度: 15,
  可复现程度: 15,
  时效与趋势价值: 10,
  用户约束适配: 10,
};

const STOP_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "using",
  "based",
  "via",
  "into",
  "a",
  "an",
  "of",
  "in",
  "on",
  "to",
]);

/** 把检索式拆成词，去掉过短的词和停用词 */
export function queryTermsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9一-龥]+/)
    .filter((term) => term.length > 2 && !STOP_TERMS.has(term));
}

function paperText(paper: Paper): string {
  return [
    paper.title,
    paper.keywords.join(" "),
    paper.topics.join(" "),
    paper.abstract ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/** 标题与关键词命中的检索词数量 */
function matchedTerms(paper: Paper, terms: string[]): string[] {
  const title = `${paper.title} ${paper.keywords.join(" ")}`.toLowerCase();
  return terms.filter((term) => title.includes(term));
}

export function scorePaper(paper: Paper, ctx: ScoreContext): ScoreBreakdown[] {
  const terms = ctx.queryTerms.length > 0 ? ctx.queryTerms : queryTermsOf(ctx.query);
  const matched = matchedTerms(paper, terms);
  const text = paperText(paper);
  const clusterId = ctx.clusterOf(paper);
  const cluster = clusterId === undefined ? undefined : ctx.clusterInfo(clusterId);

  // 1. 问题匹配度：检索词命中越多越高，摘要里命中也算但权重低
  const titleHits = matched.length;
  const abstractHits = terms.filter((term) => !matched.includes(term) && text.includes(term)).length;
  const hitRate = terms.length === 0 ? 1 : Math.min(1, (titleHits * 2 + abstractHits) / (terms.length * 2));
  const matchScore = terms.length === 0 ? 30 : Math.round(hitRate * 30);

  // 2. 方法相关度：与所属方向的代表词重合，以及是否是该方向的代表方法
  const methodHits = cluster
    ? cluster.terms.filter((term) => text.includes(term.toLowerCase())).length
    : 0;
  const methodScore = Math.min(
    20,
    Math.round((methodHits / Math.max(1, Math.min(3, cluster?.terms.length ?? 1))) * 20),
  );

  // 3. 证据完整度：只反映材料有多少，不评价论文好坏
  let evidenceScore = 3;
  if (paper.abstract) evidenceScore += 6;
  if (paper.topics.length > 0) evidenceScore += 3;
  if (paper.keywords.length > 0) evidenceScore += 2;
  if (paper.oaUrl) evidenceScore += 1;

  // 4. 可复现程度：有开放获取或明确的代码/数据线索才算高，否则标记为需要自行重建
  const hasCodeHint = /github|code|repository|source code|implement/i.test(text);
  const hasDataHint = /dataset|benchmark|data set/i.test(text);
  let reproScore = 4;
  if (paper.oaUrl) reproScore += 5;
  if (hasCodeHint) reproScore += 5;
  if (hasDataHint) reproScore += 4;
  reproScore = Math.min(15, reproScore);
  const reproReason = !paper.oaUrl && !hasCodeHint && !hasDataHint
    ? "没有开放获取入口，也没有代码或数据线索，复现需要自行重建。"
    : paper.oaUrl
      ? "有开放获取入口，可以先读全文再评估复现成本。"
      : "材料里出现了代码或数据线索，但仍需人工核验链接是否可用。";

  // 5. 时效与趋势价值：只看年份和方向趋势，引用数不计入这一项
  const age = Math.max(0, ctx.maxYear - paper.year);
  const trend = cluster ? cluster.recentShare : 0;
  const trendScore = Math.max(0, Math.min(10, Math.round((10 - age * 0.8) * 0.6 + trend * 4)));

  // 6. 用户约束适配：按偏好调整，低算力偏好看轻量方法与综述，新只看年份，开放数据看是否有数据线索
  let fitScore = 7;
  let fitReason = "未指定额外偏好，按默认权重计入。";
  if (ctx.preference === "low_compute") {
    const light = /review|survey|lightweight|efficient|low-cost|benchmark/i.test(text);
    fitScore = light ? 10 : 5;
    fitReason = light
      ? "偏轻量或综述型工作，资源占用通常较低。"
      : "材料里没有轻量化或低算力信号，需要自行评估资源需求。";
  } else if (ctx.preference === "newest") {
    fitScore = paper.year >= ctx.maxYear - 1 ? 10 : paper.year >= ctx.maxYear - 3 ? 6 : 3;
    fitReason = `发表年份 ${paper.year}，越新越贴近当前进展。`;
  } else if (ctx.preference === "open_data") {
    fitScore = hasDataHint ? 10 : paper.oaUrl ? 6 : 3;
    fitReason = hasDataHint
      ? "材料里出现了数据集相关描述，但仍要确认能否公开下载。"
      : paper.oaUrl
        ? "有开放获取入口，但材料里没有明确的数据集线索。"
        : "材料里没有数据线索，可能无法拿到公开数据。";
  }

  return [
    {
      dimension: "问题匹配度",
      score: Math.max(0, Math.min(30, matchScore)),
      max: 30,
      reason:
        terms.length === 0
          ? "没有可用的检索词，匹配度按满分计入，请补一个更具体的检索式。"
          : matched.length > 0
            ? `标题与关键词命中检索词：${matched.join("、")}${abstractHits > 0 ? `；摘要另有 ${abstractHits} 个命中` : ""}。`
            : "标题、关键词与摘要都没有命中检索词。",
      evidenceIds: [`paper:${paper.id}:title`],
    },
    {
      dimension: "方法相关度",
      score: methodScore,
      max: 20,
      reason:
        cluster && cluster.terms.length > 0
          ? `与所属方向「${cluster.terms.slice(0, 3).join("、")}」的代表词有 ${methodHits} 处重合。`
          : "没有归入任何方向，无法判断方法相关性。",
      evidenceIds: clusterId === undefined ? [] : [`cluster:${clusterId}:terms`],
    },
    {
      dimension: "证据完整度",
      score: evidenceScore,
      max: 15,
      reason: [
        paper.abstract ? "有摘要" : "只有元数据，没有摘要",
        paper.topics.length > 0 ? "有主题标签" : "没有主题标签",
        paper.keywords.length > 0 ? "有关键词" : "没有关键词",
        paper.oaUrl ? "有开放获取入口" : "没有开放获取入口",
      ].join("，"),
      evidenceIds: [`paper:${paper.id}:materials`],
    },
    {
      dimension: "可复现程度",
      score: reproScore,
      max: 15,
      reason: reproReason,
      evidenceIds: [`paper:${paper.id}:links`],
    },
    {
      dimension: "时效与趋势价值",
      score: trendScore,
      max: 10,
      reason: `发表于 ${paper.year} 年；所属方向近三年占比 ${Math.round((cluster?.recentShare ?? 0) * 100)}%。引用次数只作背景信号，不计入这一项。`,
      evidenceIds: clusterId === undefined ? [`paper:${paper.id}:year`] : [`paper:${paper.id}:year`, `cluster:${clusterId}:recentShare`],
    },
    {
      dimension: "用户约束适配",
      score: fitScore,
      max: 10,
      reason: fitReason,
      evidenceIds: [],
    },
  ];
}

/** 加权总分（0–100），只用于排序 */
export function totalScore(breakdown: ScoreBreakdown[]): number {
  return Math.round(breakdown.reduce((sum, item) => sum + item.score, 0));
}

export function scorePaperTotal(paper: Paper, ctx: ScoreContext): number {
  return totalScore(scorePaper(paper, ctx));
}
