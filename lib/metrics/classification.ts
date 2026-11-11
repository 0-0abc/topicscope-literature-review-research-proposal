import type { BinaryCounts, ClassCounts, ClassStat, ConfusionMatrix } from "./types";

export function matrixTotal(matrix: ConfusionMatrix): number {
  let total = 0;
  for (const row of matrix.m) for (const value of row) total += value;
  return total;
}

/** 把混淆矩阵拆成每个类别的一对其余（one-vs-rest）计数。 */
export function toClassCounts(matrix: ConfusionMatrix): ClassCounts[] {
  const n = matrix.labels.length;
  const total = matrixTotal(matrix);
  return matrix.labels.map((label, k) => {
    let tp = 0;
    let fn = 0;
    let fp = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === k && j === k) tp += matrix.m[i][j];
        else if (i === k) fn += matrix.m[i][j];
        else if (j === k) fp += matrix.m[i][j];
      }
    }
    return { label, tp, fp, fn, tn: total - tp - fp - fn };
  });
}

export function classStat(counts: ClassCounts): ClassStat {
  const support = counts.tp + counts.fn;
  const precision = counts.tp + counts.fp > 0 ? counts.tp / (counts.tp + counts.fp) : null;
  const recall = counts.tp + counts.fn > 0 ? counts.tp / (counts.tp + counts.fn) : null;
  const specificity = counts.tn + counts.fp > 0 ? counts.tn / (counts.tn + counts.fp) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return { label: counts.label, support, precision, recall, specificity, f1 };
}

export function stats(matrix: ConfusionMatrix): ClassStat[] {
  return toClassCounts(matrix).map(classStat);
}

/** 整体准确率 = 所有正确预测数 / 样本总数。 */
export function accuracy(matrix: ConfusionMatrix): number {
  const total = matrixTotal(matrix);
  if (total === 0) return 0;
  let correct = 0;
  for (let i = 0; i < matrix.m.length; i++) correct += matrix.m[i][i];
  return correct / total;
}

/** 各类 recall 的算术平均，对类别不平衡不敏感。 */
export function balancedAccuracy(matrix: ConfusionMatrix): number {
  const list = stats(matrix).map((s) => s.recall).filter((v): v is number => v !== null);
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/** 各类 F1 的算术平均。 */
export function macroF1(matrix: ConfusionMatrix): number {
  const list = stats(matrix).map((s) => s.f1).filter((v): v is number => v !== null);
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/** 按各类真实样本数加权的 F1。 */
export function weightedF1(matrix: ConfusionMatrix): number {
  const list = stats(matrix);
  const total = list.reduce((acc, s) => acc + s.support, 0);
  if (total === 0) return 0;
  let sum = 0;
  for (const s of list) {
    if (s.f1 === null) continue;
    sum += s.f1 * s.support;
  }
  return sum / total;
}

/**
 * Micro 口径：把各类别的 TP/FP/FN 汇总后再算。
 * 单标签多分类下 micro-F1 与 accuracy 相等——这是最常被误用的口径之一。
 */
export function microF1(matrix: ConfusionMatrix): number {
  const counts = toClassCounts(matrix);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const c of counts) {
    tp += c.tp;
    fp += c.fp;
    fn += c.fn;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

/** 各类 specificity 的算术平均。 */
export function meanSpecificity(matrix: ConfusionMatrix): number {
  const list = stats(matrix).map((s) => s.specificity).filter((v): v is number => v !== null);
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * Matthews 相关系数（Gorodkin 形式，scikit-learn 实现）。
 *
 * cov_ytyp = n_correct·N − Σ_k t_k·p_k
 * cov_ypyp = N² − Σ_k p_k²
 * cov_ytyt = N² − Σ_k t_k²
 *
 * t_k 为类别 k 的真实样本数，p_k 为预测样本数。K=2 时该式退化为
 * (tp·tn − fp·fn) / √((tp+fp)(tp+fn)(tn+fp)(tn+fn))，即经典二分类 MCC。
 */
export function multiclassMcc(matrix: ConfusionMatrix): number {
  const n = matrix.labels.length;
  if (n < 2) return 0;
  const trueCounts = new Array<number>(n).fill(0);
  const predictedCounts = new Array<number>(n).fill(0);
  let correct = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const value = matrix.m[i]?.[j] ?? 0;
      trueCounts[i] += value;
      predictedCounts[j] += value;
      if (i === j) correct += value;
    }
  }
  const total = matrixTotal(matrix);
  if (total === 0) return 0;
  let sumTrueTimesPredicted = 0;
  let sumPredictedSquared = 0;
  let sumTrueSquared = 0;
  for (let k = 0; k < n; k++) {
    sumTrueTimesPredicted += trueCounts[k] * predictedCounts[k];
    sumPredictedSquared += predictedCounts[k] * predictedCounts[k];
    sumTrueSquared += trueCounts[k] * trueCounts[k];
  }
  const covYtyp = correct * total - sumTrueTimesPredicted;
  const covYpyp = total * total - sumPredictedSquared;
  const covYtYt = total * total - sumTrueSquared;
  const denominator = Math.sqrt(covYpyp * covYtYt);
  return denominator === 0 ? 0 : covYtyp / denominator;
}

/** 多分类 Cohen's Kappa。 */
export function cohensKappa(matrix: ConfusionMatrix): number {
  const counts = toClassCounts(matrix);
  const total = matrixTotal(matrix);
  if (total === 0) return 0;
  let po = 0;
  let pe = 0;
  for (const c of counts) {
    const trueProportion = (c.tp + c.fn) / total;
    const predictedProportion = (c.tp + c.fp) / total;
    po += c.tp / total;
    pe += trueProportion * predictedProportion;
  }
  return pe === 1 ? 0 : (po - pe) / (1 - pe);
}

/** 二分类口径：正类与负类的划分。 */
export function binaryStats(counts: BinaryCounts) {
  const total = counts.tp + counts.fp + counts.fn + counts.tn;
  const precision = counts.tp + counts.fp > 0 ? counts.tp / (counts.tp + counts.fp) : null;
  const recall = counts.tp + counts.fn > 0 ? counts.tp / (counts.tp + counts.fn) : null;
  const specificity = counts.tn + counts.fp > 0 ? counts.tn / (counts.tn + counts.fp) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  const accuracy = total > 0 ? (counts.tp + counts.tn) / total : 0;
  const pe =
    total > 0
      ? ((counts.tp + counts.fp) * (counts.tp + counts.fn) +
          (counts.tn + counts.fn) * (counts.tn + counts.fp)) /
        (total * total)
      : 0;
  const kappa = pe === 1 ? 0 : (accuracy - pe) / (1 - pe);
  const mccDenominator = Math.sqrt(
    (counts.tp + counts.fp) *
      (counts.tp + counts.fn) *
      (counts.tn + counts.fp) *
      (counts.tn + counts.fn),
  );
  const mcc =
    mccDenominator === 0
      ? 0
      : (counts.tp * counts.tn - counts.fp * counts.fn) / mccDenominator;
  return { precision, recall, specificity, f1, accuracy, kappa, mcc, total };
}

export function f1FromPrecisionRecall(precision: number, recall: number): number | null {
  if (precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

/** 由 F1 与 Recall 反解 Precision：F1(P+R) = 2PR ⇒ P = F1·R / (2R − F1)。 */
export function precisionFromF1Recall(f1: number, recall: number): number | null {
  const denominator = 2 * recall - f1;
  if (denominator === 0) return null;
  return (f1 * recall) / denominator;
}

/** 由 F1 与 Precision 反解 Recall：R = F1·P / (2P − F1)。 */
export function recallFromF1Precision(f1: number, precision: number): number | null {
  const denominator = 2 * precision - f1;
  if (denominator === 0) return null;
  return (f1 * precision) / denominator;
}

/**
 * 由各类 recall 与真实样本数还原 accuracy 与 balanced accuracy。
 * 缺少类别分布时二者无法互相换算——这正是「口径对不上」的根因。
 */
export function accuracyFromClassRecalls(recalls: number[], supports: number[]): number | null {
  const total = supports.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let correct = 0;
  for (let i = 0; i < recalls.length; i++) correct += recalls[i] * supports[i];
  return correct / total;
}

export function balancedAccuracyFromClassRecalls(recalls: number[]): number | null {
  if (recalls.length === 0) return null;
  return recalls.reduce((a, b) => a + b, 0) / recalls.length;
}

/** 二分类 log loss，需要每个样本的真实标签与预测概率。 */
export function logLoss(samples: { probability: number; label: 0 | 1 }[]): number | null {
  if (samples.length === 0) return null;
  let sum = 0;
  for (const s of samples) {
    const p = Math.min(Math.max(s.probability, 1e-15), 1 - 1e-15);
    sum += s.label === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / samples.length;
}

/** ROC-AUC（梯形法）。scores 越大越倾向正类。 */
export function rocAuc(scores: number[], labels: (0 | 1)[]): number | null {
  const positives = labels.filter((l) => l === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return null;
  const pairs = scores.map((score, i) => ({ score, label: labels[i] }));
  pairs.sort((a, b) => b.score - a.score);
  let rank = 1;
  let sumPositiveRanks = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].score === pairs[i].score) j++;
    const averageRank = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k++) if (pairs[k].label === 1) sumPositiveRanks += averageRank;
    rank += j - i + 1;
    i = j + 1;
  }
  return (sumPositiveRanks - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** PR-AUC（平均精度法）。 */
export function prAuc(scores: number[], labels: (0 | 1)[]): number | null {
  const positives = labels.filter((l) => l === 1).length;
  if (positives === 0) return null;
  const pairs = scores.map((score, i) => ({ score, label: labels[i] }));
  pairs.sort((a, b) => b.score - a.score);
  let truePositives = 0;
  let falsePositives = 0;
  let sumPrecision = 0;
  for (const p of pairs) {
    if (p.label === 1) {
      truePositives++;
      sumPrecision += truePositives / (truePositives + falsePositives);
    } else {
      falsePositives++;
    }
  }
  return sumPrecision / positives;
}
