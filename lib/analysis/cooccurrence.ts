import type { Paper } from "../data/types";
import { buildCorpus } from "./corpus";

export interface GraphNode {
  id: string;
  label: string;
  /** 出现在多少篇论文中 */
  documentFrequency: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** 两词在多少篇论文中同时出现 */
  weight: number;
  /**
   * 共现强度 = 实际共现次数 / 独立假设下的期望次数。
   * 大于 1 表示两词出现得比随机情况更紧密。
   */
  lift: number;
}

export interface CooccurrenceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TermPair {
  a: string;
  b: string;
  /** 共现提升度：实际共现次数 ÷ 随机假设下的期望次数 */
  lift: number;
  /** 同时出现的论文数 */
  count: number;
}

/** 按提升度排序取前若干个词对，count 低于下限的组合不作为「方法组合」呈现。 */
export function topPairs(edges: GraphEdge[], limit: number, minCount = 3): TermPair[] {
  return [...edges]
    .filter((edge) => edge.weight >= minCount)
    .sort((a, b) => b.lift - a.lift || b.weight - a.weight)
    .slice(0, limit)
    .map((edge) => ({
      a: edge.source,
      b: edge.target,
      lift: Math.round(edge.lift * 100) / 100,
      count: edge.weight,
    }));
}

export interface CooccurrenceOptions {
  /** 参与统计的高频词数量 */
  terms?: number;
  /** 词至少要出现在这么多篇论文里 */
  minDocumentFrequency?: number;
  /** 词出现在超过这个比例的论文里就视为过于泛化，不参与统计 */
  maxDocumentFrequencyRatio?: number;
  /** 边至少要共现多少次才保留 */
  minEdgeWeight?: number;
  /** 共现强度下限，低于该值说明两词的关联不比随机更强 */
  minLift?: number;
  /** 每篇论文最多取前多少个词参与共现统计 */
  termsPerPaper?: number;
}

const SEPARATOR = "\t";

export function buildCooccurrence(
  papers: Paper[],
  options: CooccurrenceOptions = {},
): CooccurrenceGraph {
  const termCount = options.terms ?? 28;
  const minDocumentFrequency = options.minDocumentFrequency ?? 5;
  const maxDocumentFrequency = Math.floor(
    papers.length * (options.maxDocumentFrequencyRatio ?? 0.45),
  );
  const minEdgeWeight = options.minEdgeWeight ?? 4;
  const minLift = options.minLift ?? 1.15;
  const termsPerPaper = options.termsPerPaper ?? 9;

  if (papers.length === 0) return { nodes: [], edges: [] };

  const corpus = buildCorpus(papers);

  const documentFrequency = new Map<string, number>();
  for (const document of corpus) {
    for (const term of document.counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const selected = [...documentFrequency.entries()]
    .filter(
      ([, df]) =>
        df >= minDocumentFrequency &&
        df <= Math.max(maxDocumentFrequency, minDocumentFrequency),
    )
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, termCount)
    .map(([term]) => term);

  const selectedSet = new Set(selected);

  const edgeCounts = new Map<string, number>();
  for (const document of corpus) {
    const present = [...document.counts.keys()].filter((term) => selectedSet.has(term));
    present.sort(
      (a, b) => (documentFrequency.get(b) ?? 0) - (documentFrequency.get(a) ?? 0),
    );
    const limited = present.slice(0, termsPerPaper);
    for (let i = 0; i < limited.length; i++) {
      for (let j = i + 1; j < limited.length; j++) {
        const [a, b] =
          limited[i] < limited[j] ? [limited[i], limited[j]] : [limited[j], limited[i]];
        const key = `${a}${SEPARATOR}${b}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const edges: GraphEdge[] = [];
  const total = papers.length;
  for (const [key, weight] of edgeCounts) {
    if (weight < minEdgeWeight) continue;
    const [source, target] = key.split(SEPARATOR);
    const dfSource = documentFrequency.get(source) ?? 0;
    const dfTarget = documentFrequency.get(target) ?? 0;
    const expected = (dfSource * dfTarget) / total;
    const lift = expected > 0 ? weight / expected : 0;
    if (lift < minLift) continue;
    edges.push({ source, target, weight, lift });
  }
  edges.sort((a, b) => b.weight - a.weight);

  const used = new Set<string>();
  for (const edge of edges) {
    used.add(edge.source);
    used.add(edge.target);
  }

  const nodes: GraphNode[] = [...used]
    .map((id) => ({
      id,
      label: id,
      documentFrequency: documentFrequency.get(id) ?? 0,
    }))
    .sort((a, b) => b.documentFrequency - a.documentFrequency);

  return { nodes, edges };
}
