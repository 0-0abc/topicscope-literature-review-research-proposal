export interface ConfusionMatrix {
  /** 真实类别标签，顺序与 m 的行一致 */
  labels: string[];
  /** m[trueIndex][predIndex] */
  m: number[][];
}

export interface ClassCounts {
  label: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface ClassStat {
  label: string;
  support: number;
  precision: number | null;
  recall: number | null;
  specificity: number | null;
  f1: number | null;
}

export interface SegmentationClass {
  label: string;
  intersection: number;
  union: number;
  predArea: number;
  gtArea: number;
}

export interface RankingItem {
  id: string;
  /** 相关度等级，0 表示不相关 */
  relevance: number;
}

export interface BinaryCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}
