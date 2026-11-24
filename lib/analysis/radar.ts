import type { Paper } from "../data/types";
import { buildCorpus } from "./corpus";
import { buildTfIdf, topTerms } from "./tfidf";
import { kmeans, suggestClusterCount } from "./kmeans";

export type CoverageVerdict = "saturated" | "mature" | "emerging" | "gap" | "insufficient";

export const VERDICT_META: Record<
  CoverageVerdict,
  { label: string; tone: string; summary: string; cannotConclude: string }
> = {
  saturated: {
    label: "高密度成熟方向",
    tone: "text-foreground",
    summary: "当前检索样本中论文多、历史积累明显，常规增量竞争激烈。",
    cannotConclude:
      "不能据此断定这个方向已经没有价值：换成新任务设定、新数据或新评测口径，仍然可能有空间。",
  },
  mature: {
    label: "稳定产出方向",
    tone: "text-foreground",
    summary: "样本内有持续研究，但仍可能通过数据、任务设定或评测设计形成差异。",
    cannotConclude:
      "不能据此断定这个方向缺少研究空间：样本内占比可能来自检索式的偏好，而不是领域真实密度。",
  },
  emerging: {
    label: "增长窗口",
    tone: "text-foreground",
    summary: "当前检索样本量不大，但样本内近期占比高，值得进一步核查。",
    cannotConclude:
      "样本内近期占比高，当前样本框（见检索快照）不能证明真实发文增长；也不能断定这个方向尚未被其他数据库或未公开论文覆盖，增长是否持续需独立检索验证。",
  },
  gap: {
    label: "当前检索未观察到",
    tone: "text-foreground",
    summary: "当前检索范围内命中很少，不能直接等价于真实领域空白。",
    cannotConclude:
      "不能据此断定这是真实空白：可能是检索式用词、数据库覆盖或发表渠道不同造成的召回不足。",
  },
  insufficient: {
    label: "样本内稀疏 · 证据不足",
    tone: "text-foreground",
    summary: "样本内论文数或占比过低（size < 10 或占比 < 5%），证据不足，暂不适合做强判断。",
    cannotConclude:
      "不能据此判断方向真实密度或冷热：样本内材料太少，可能只是检索式或数据库覆盖不足，需扩大检索并补全文后再下结论。",
  },
};

export interface TopicCluster {
  id: number;
  name: string;
  terms: string[];
  paperIds: string[];
  size: number;
  sizeShare: number;
  yearRange: [number, number];
  medianYear: number;
  /** 样本内近三年论文比例（当前样本框口径，见检索快照；不能证明真实发文增长） */
  recentShare: number;
  /** 样本内近五年论文比例 */
  fiveYearShare: number;
  citationTotal: number;
  citationMedian: number;
  crowding: number;
  verdict: CoverageVerdict;
  verdictReason: string;
  /** 命中的判定规则分支与阈值，供人工核对（如「size 4 < 10 → 样本内稀疏」） */
  ruleTrace: string;
  /** 按该簇实际 sizeShare/recentShare 动态生成的边界说明；sizeShare < 0.1 时不得出现「占比高」 */
  cannotConclude: string;
  /** 当前材料能支持的强度说明 */
  coverageNote: string;
  /** 材料覆盖不足（摘要覆盖率低），判定只能当线索 */
  evidenceWeak: boolean;
  topVenues: { name: string; count: number }[];
  /** 该方向内被引最高的代表论文 */
  topPapers: {
    id: string;
    title: string;
    year: number;
    venue: string | null;
    citedByCount: number;
    doi: string | null;
  }[];
  /** 该方向内摘要覆盖率（%） */
  abstractCoverage: number;
  /** 该方向内已验证开放获取覆盖率（%，只计已验证 OA 全文，不含出版商落地页） */
  oaCoverage: number;
  /** 按年发文量（当前样本，覆盖全局年份区间） */
  yearCounts: { year: number; count: number }[];
}

export interface RadarResult {
  clusters: TopicCluster[];
  /** 每篇论文所属的聚类 id */
  assignment: Map<string, number>;
  vocabulary: string[];
  clusterCount: number;
  yearRange: [number, number];
  /** 全局词权重，用于共现图与标签云 */
  globalWeights: { term: string; weight: number }[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 按簇实际占比动态生成「不能推出什么」：
 * sizeShare < 0.1 的簇绝不出现「占比高」字样，也不假设抽样方式（样本框见检索快照）。
 */
function buildCannotConclude(
  verdict: CoverageVerdict,
  sizeShare: number,
  recentShare: number,
): string {
  const sizePct = (sizeShare * 100).toFixed(1);
  const recentPct = (recentShare * 100).toFixed(0);
  switch (verdict) {
    case "saturated":
      return `样本内占比 ${sizePct}% 只反映当前检索样本；不能据此断定这个方向已经没有价值：换成新任务设定、新数据或新评测口径，仍然可能有空间。`;
    case "mature":
      return sizeShare >= 0.1
        ? `不能据此断定这个方向缺少研究空间：样本内占比 ${sizePct}% 可能来自检索式的偏好，而不是领域真实密度。`
        : `样本内占比仅 ${sizePct}%，不能据此断定这个方向缺少研究空间或真实冷门；占比低可能只是当前样本框（见检索快照）的召回偏好，需独立检索验证。`;
    case "emerging":
      return `样本内近三年占比 ${recentPct}%，但当前样本框（见检索快照）不能证明真实发文增长；也不能断定这个方向尚未被其他数据库或未公开论文覆盖，增长是否持续需独立检索验证。`;
    case "gap":
      return "不能据此断定这是真实空白：可能是检索式用词、数据库覆盖或发表渠道不同造成的召回不足。";
    case "insufficient":
      return `样本内占比仅 ${sizePct}%、样本稀疏，不能据此判断方向真实密度或冷热；需扩大检索、补全文后再下结论。`;
  }
}

export function classifyCoverage(
  size: number,
  sizeShare: number,
  recentShare: number,
  medianYear: number,
  maxYear: number,
): CoverageVerdict {
  if (size < 10 || sizeShare < 0.05) return "insufficient";
  if (sizeShare < 0.1 && recentShare >= 0.6) return "emerging";
  if (sizeShare >= 0.12 && medianYear <= maxYear - 4 && recentShare <= 0.35) return "saturated";
  return "mature";
}

export function analyzeTopics(papers: Paper[]): RadarResult {
  if (papers.length === 0) {
    return {
      clusters: [],
      assignment: new Map(),
      vocabulary: [],
      clusterCount: 0,
      yearRange: [0, 0],
      globalWeights: [],
    };
  }

  const documents = buildCorpus(papers);

  const model = buildTfIdf(documents);
  const clusterCount = suggestClusterCount(papers.length);
  const result = kmeans(model.vectors, clusterCount);

  const years = papers.map((p) => p.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const recentThreshold = maxYear - 2;
  const fiveYearThreshold = maxYear - 4;

  // 聚类命名时排除「几乎每个聚类都出现」的通用词，避免所有簇都叫「分割 / 网络」
  const clusterTermSets: Set<number>[] = [];
  for (let c = 0; c < result.centroids.length; c++) {
    const set = new Set<number>();
    for (const { index } of topTerms(result.centroids[c], 24)) set.add(index);
    clusterTermSets.push(set);
  }
  const termClusterCount = new Map<number, number>();
  for (const set of clusterTermSets) {
    for (const index of set) termClusterCount.set(index, (termClusterCount.get(index) ?? 0) + 1);
  }
  const genericThreshold = Math.max(2, Math.ceil(clusterTermSets.length * 0.7));

  const papersByCluster: Paper[][] = result.centroids.map(() => []);
  result.assignments.forEach((cluster, index) => {
    papersByCluster[cluster].push(papers[index]);
  });

  const globalWeight = new Map<string, number>();
  papers.forEach((paper, index) => {
    for (const { index: termIndex, weight } of topTerms(model.vectors[index], 8)) {
      const term = model.vocabulary[termIndex];
      globalWeight.set(term, (globalWeight.get(term) ?? 0) + weight);
    }
  });

  const totalCitations = papers.reduce((sum, paper) => sum + paper.citedByCount, 0);
  const maxSizeShare = Math.max(
    ...papersByCluster.map((members) => members.length / papers.length),
  );

  const clusters: TopicCluster[] = papersByCluster.map((members, clusterIndex) => {
    const size = members.length;
    const sizeShare = size / papers.length;
    const memberYears = members.map((m) => m.year);
    const yearCounts: { year: number; count: number }[] = [];
    for (let year = minYear; year <= maxYear; year++) {
      yearCounts.push({ year, count: memberYears.filter((y) => y === year).length });
    }
    const yearRange: [number, number] = [
      Math.min(...memberYears),
      Math.max(...memberYears),
    ];
    const medianYear = median(memberYears);
    const recentShare =
      members.filter((m) => m.year >= recentThreshold).length / size;
    const fiveYearShare =
      members.filter((m) => m.year >= fiveYearThreshold).length / size;
    const citationTotal = members.reduce((sum, m) => sum + m.citedByCount, 0);
    const citationMedian = median(members.map((m) => m.citedByCount));
    const abstractCoverage = Math.round(
      (members.filter((m) => m.provenance?.abstractAvailable).length / size) * 100,
    );
    const oaCoverage = Math.round(
      (members.filter((m) => Boolean(m.oaUrl)).length / size) * 100,
    );

    const venueCounts = new Map<string, number>();
    for (const member of members) {
      if (!member.venue) continue;
      venueCounts.set(member.venue, (venueCounts.get(member.venue) ?? 0) + 1);
    }
    const topVenues = [...venueCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);

    const ranked = topTerms(result.centroids[clusterIndex], 40)
      .filter(({ index }) => (termClusterCount.get(index) ?? 0) < genericThreshold)
      .map(({ index }) => model.vocabulary[index]);

    const terms = ranked.slice(0, 12);
    const nameParts = ranked.slice(0, 2);

    const venueConcentration = topVenues.length > 0 ? topVenues[0].count / size : 0;
    const crowding = Math.round(
      Math.min(1, sizeShare / Math.max(maxSizeShare, 0.0001)) * 40 +
        Math.min(1, totalCitations > 0 ? citationTotal / totalCitations / Math.max(maxSizeShare, 0.0001) : 0) * 30 +
        venueConcentration * 30,
    );

    const sizePct = (sizeShare * 100).toFixed(1);
    const recentPct = (recentShare * 100).toFixed(0);
    const verdict = classifyCoverage(size, sizeShare, recentShare, medianYear, maxYear);
    let verdictReason: string;
    let ruleTrace: string;
    if (size < 10 || sizeShare < 0.05) {
      const hits: string[] = [];
      if (size < 10) hits.push(`size ${size} < 10`);
      if (sizeShare < 0.05) hits.push(`占比 ${sizePct}% < 5%`);
      ruleTrace = `${hits.join(" 且 ")} → 样本内稀疏 · 证据不足`;
      verdictReason = `样本内仅 ${size} 篇、占比 ${sizePct}%，样本内稀疏、证据不足；不能据此判断方向冷热，需扩大检索或补材料后再判断。`;
    } else if (sizeShare < 0.1 && recentShare >= 0.6) {
      ruleTrace = `占比 ${sizePct}% < 10% 且近三年 ${recentPct}% ≥ 60% → 增长窗口`;
      verdictReason = `样本内占比 ${sizePct}%，且样本内 ${recentPct}% 的论文集中在 ${recentThreshold}–${maxYear} 年；当前样本框（见检索快照）内近期占比高，不能证明真实发文增长，需独立检索验证。`;
    } else if (sizeShare >= 0.12 && medianYear <= maxYear - 4 && recentShare <= 0.35) {
      ruleTrace = `占比 ${sizePct}% ≥ 12% 且中位年份 ${medianYear} ≤ ${maxYear - 4} 且近三年 ${recentPct}% ≤ 35% → 高密度成熟方向`;
      verdictReason = `样本内占比 ${sizePct}%、中位发表年份 ${medianYear}，样本内早期工作较多，${recentThreshold} 年后新增很少。`;
    } else {
      ruleTrace = `size ${size} ≥ 10 且占比 ${sizePct}% ≥ 5%，未命中增长窗口与高密度条件 → 稳定产出方向`;
      verdictReason = `样本内占比 ${sizePct}%，中位发表年份 ${medianYear}，样本内属于有稳定产出的常规方向。`;
    }
    const cannotConclude = buildCannotConclude(verdict, sizeShare, recentShare);

    const topPapers = [...members]
      .sort((a, b) => b.citedByCount - a.citedByCount || b.year - a.year)
      .slice(0, 5)
      .map((member) => ({
        id: member.id,
        title: member.title,
        year: member.year,
        venue: member.venue,
        citedByCount: member.citedByCount,
        doi: member.doi,
      }));

    const coverageNote =
      abstractCoverage >= 80
        ? "材料以摘要级为主，可用于方向判断；具体结论仍需核对全文。"
        : abstractCoverage >= 50
          ? "部分论文只有元数据，涉及方法与结果的判断需补全文。"
          : "摘要覆盖不足，此处只反映标题与关键词的分布，方向判断只能当作线索。";

    return {
      id: clusterIndex,
      name: nameParts.length > 0 ? nameParts.join(" · ") : `方向 ${clusterIndex + 1}`,
      terms,
      paperIds: members.map((m) => m.id),
      size,
      sizeShare,
      yearRange,
      medianYear,
      recentShare,
      fiveYearShare,
      citationTotal,
      citationMedian,
      crowding,
      verdict,
      verdictReason,
      ruleTrace,
      cannotConclude,
      coverageNote,
      evidenceWeak: abstractCoverage < 50,
      topVenues,
      topPapers,
      abstractCoverage,
      oaCoverage,
      yearCounts,
    };
  });

  clusters.sort((a, b) => b.size - a.size);

  const assignment = new Map<string, number>();
  result.assignments.forEach((cluster, index) => {
    assignment.set(papers[index].id, cluster);
  });

  return {
    clusters,
    assignment,
    vocabulary: model.vocabulary,
    clusterCount: result.centroids.length,
    yearRange: [minYear, maxYear],
    globalWeights: [...globalWeight.entries()]
      .map(([term, weight]) => ({ term, weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 60),
  };
}
