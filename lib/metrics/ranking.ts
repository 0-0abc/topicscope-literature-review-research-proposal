import type { RankingItem } from "./types";

export interface RankingMetrics {
  precisionAtK: number | null;
  recallAtK: number | null;
  map: number | null;
  ndcgAtK: number | null;
  mrr: number | null;
  relevantCount: number;
  total: number;
}

function isRelevant(item: RankingItem, threshold: number): boolean {
  return item.relevance >= threshold;
}

/**
 * 排序指标。threshold 决定「相关」的判定标准（等级相关时用 1）。
 * 列表必须是按预测得分降序排列的顺序。
 */
export function rankingMetrics(items: RankingItem[], k: number, threshold = 1): RankingMetrics {
  const total = items.length;
  const relevantTotal = items.filter((i) => isRelevant(i, threshold)).length;
  const cutoff = Math.min(k, total);
  const topK = items.slice(0, cutoff);

  const relevantInTopK = topK.filter((i) => isRelevant(i, threshold)).length;
  const precisionAtK = cutoff > 0 ? relevantInTopK / cutoff : null;
  const recallAtK = relevantTotal > 0 ? relevantInTopK / relevantTotal : null;

  // Average Precision（非插值）：每个相关项位置上「已检出相关项占已扫描项比例」的平均
  let relevantSeen = 0;
  let precisionSum = 0;
  for (let index = 0; index < items.length; index++) {
    if (isRelevant(items[index], threshold)) {
      relevantSeen++;
      precisionSum += relevantSeen / (index + 1);
    }
  }
  const map = relevantTotal > 0 ? precisionSum / relevantTotal : null;

  // NDCG@k（分级相关度）
  const dcg = topK.reduce((sum, item, index) => {
    const gain = Math.pow(2, item.relevance) - 1;
    return sum + gain / Math.log2(index + 2);
  }, 0);
  const ideal = [...items]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, cutoff)
    .reduce((sum, item, index) => sum + (Math.pow(2, item.relevance) - 1) / Math.log2(index + 2), 0);
  const ndcgAtK = ideal > 0 ? dcg / ideal : null;

  // MRR：首个相关项的倒数位次
  let reciprocalRank: number | null = null;
  for (let i = 0; i < items.length; i++) {
    if (isRelevant(items[i], threshold)) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  return { precisionAtK, recallAtK, map, ndcgAtK, mrr: reciprocalRank, relevantCount: relevantTotal, total };
}
