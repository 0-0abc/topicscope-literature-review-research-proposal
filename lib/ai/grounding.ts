import type { DirectionContext } from "@/lib/ai/directions";

/**
 * 正文数字回查：模型除了引用 evidenceId，还可能在正文里写具体数字
 * （提升度 2.8、占比 7.4%、被引 2348）。这些数字必须能在送进模型的
 * 统计白名单里找到，否则标为「未核对」，避免"看起来可回查"的幻觉。
 */

const NUMBER_PATTERNS: RegExp[] = [
  /(?:提升度|lift|共现强度)\s*(?:达到|为|约|等于|=|:|：)?\s*(\d+(?:\.\d+)?)/gi,
  /(?:占比|份额|比例)\s*(?:达到|为|约|仅|只有|=|:|：)?\s*(\d+(?:\.\d+)?)\s*%?/gi,
  /(\d+(?:\.\d+)?)\s*%/g,
  /(?:被引|引用次数|cited(?:\s*by)?)\s*(?:达到|为|约|次数|=|:|：)?\s*(\d+(?:\.\d+)?)/gi,
  /(\d+(?:\.\d+)?)\s*篇/g,
  /(?:拥挤度)\s*(?:为|约|达到|=|:|：)?\s*(\d+(?:\.\d+)?)/gi,
];

/** 抽出正文里与统计口径绑定的数字（保留原文写法，便于高亮）。 */
export function extractClaimNumbers(text: string): string[] {
  const out: string[] = [];
  for (const pattern of NUMBER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      out.push(match[1]);
    }
  }
  return out;
}

function close(a: number, b: number): boolean {
  const tolerance = Math.max(0.05, Math.abs(b) * 0.01);
  return Math.abs(a - b) <= tolerance;
}

/** 数字是否落在白名单内（兼容百分数与小数两种写法）。 */
export function numberInWhitelist(raw: string, whitelist: number[]): boolean {
  const value = Number(raw);
  if (!Number.isFinite(value)) return true;
  for (const w of whitelist) {
    if (close(value, w)) return true;
    if (close(value, w * 100) || close(value, w / 100)) return true;
  }
  return false;
}

/** 返回正文中无法在白名单里核对的数字（原文写法）。 */
export function auditTextNumbers(text: string, whitelist: number[]): string[] {
  const seen = new Set<string>();
  const unmatched: string[] = [];
  for (const raw of extractClaimNumbers(text)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!numberInWhitelist(raw, whitelist)) unmatched.push(raw);
  }
  return unmatched;
}

/** 从方向上下文收集所有送进模型的统计数字，作为正文数字白名单。 */
export function buildNumericWhitelist(context: DirectionContext | null): number[] {
  if (!context) return [];
  const values: number[] = [
    context.corpus.size,
    context.corpus.clusterCount,
    context.corpus.abstractCoverage,
    context.corpus.oaCoverage,
  ];
  for (const cluster of context.clusters) {
    values.push(
      cluster.size,
      cluster.sizeShare,
      cluster.sizeShare / 100,
      cluster.recentShare,
      cluster.fiveYearShare,
      cluster.citationMedian,
      cluster.crowding,
      cluster.medianYear,
    );
    for (const paper of cluster.papers) values.push(paper.citedByCount, paper.year);
    for (const pair of cluster.pairs ?? []) values.push(pair.lift, pair.count);
  }
  for (const pair of context.pairs) values.push(pair.lift, pair.count);
  for (const item of context.evidence) {
    const n = Number(String(item.value).replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) values.push(n);
  }
  return values;
}