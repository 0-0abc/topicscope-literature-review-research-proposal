import type { BinaryCounts, ClassCounts, ClassStat, ConfusionMatrix } from "./types";

/** 输入校验结果：errors 为可直接展示给用户的行内提示。 */
export interface InputValidation {
  ok: boolean;
  errors: string[];
}

const BINARY_COUNT_FIELDS: { key: keyof BinaryCounts; label: string }[] = [
  { key: "tp", label: "TP 真正例" },
  { key: "fp", label: "FP 假正例" },
  { key: "fn", label: "FN 假负例" },
  { key: "tn", label: "TN 真负例" },
];

/** 单个计数必须是有限的非负整数；返回 null 表示合法。 */
function countError(label: string, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${label} 不是有效数字`;
  }
  if (value < 0) return `${label} 不能为负数（当前 ${value}）`;
  if (!Number.isInteger(value)) return `${label} 必须是整数（当前 ${value}）`;
  return null;
}

/**
 * 计算前的输入校验（S1）：二分类计数 {tp,fp,fn,tn} 或多分类混淆矩阵 {labels,m}。
 *
 * 规则：四个计数（矩阵为每个单元格）都是非负整数，且样本总数 N > 0。
 * 非法时返回 ok:false 与逐条原因，调用方必须停止计算——
 * 负数被静默截断、小数被当成计数、N=0 时算出的 0 都会伪装成「有效指标」。
 */
export function validateConfusionMatrix(
  values: BinaryCounts | ConfusionMatrix,
): InputValidation {
  const errors: string[] = [];
  if (!values || typeof values !== "object") {
    return { ok: false, errors: ["缺少混淆矩阵或二分类计数输入"] };
  }

  // 多分类混淆矩阵：先校验形状，再逐格校验计数。
  if ("m" in values) {
    const labels = values.labels;
    const rows = values.m;
    if (!Array.isArray(labels) || labels.length === 0) {
      errors.push("类别标签不能为空");
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      errors.push("混淆矩阵不能为空");
    }
    if (errors.length > 0) return { ok: false, errors };

    const size = labels.length;
    if (rows.length !== size) {
      errors.push(`矩阵行数（${rows.length}）与类别数（${size}）不一致`);
    }
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) {
        errors.push(`第 ${i + 1} 行不是数组`);
        continue;
      }
      if (row.length !== size) {
        errors.push(`第 ${i + 1} 行的列数（${row.length}）与类别数（${size}）不一致`);
      }
      for (let j = 0; j < row.length; j++) {
        const label = `真实「${labels[i] ?? i + 1}」预测「${labels[j] ?? j + 1}」的计数`;
        const error = countError(label, row[j]);
        if (error) errors.push(error);
        else total += row[j] as number;
      }
    }
    if (errors.length === 0 && total <= 0) {
      errors.push("样本总数 N 必须大于 0（当前矩阵全为 0）");
    }
    return { ok: errors.length === 0, errors };
  }

  // 二分类计数：tp / fp / fn / tn。
  let total = 0;
  for (const field of BINARY_COUNT_FIELDS) {
    const value = values[field.key];
    const error = countError(field.label, value);
    if (error) errors.push(error);
    else total += value as number;
  }
  if (errors.length === 0 && total <= 0) {
    errors.push("样本总数 N 必须大于 0（TP+FP+FN+TN = 0）");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 二分类计数转为混淆矩阵：行 = 真实类别，列 = 预测类别。
 * 正类是第二个类别，因此顺序固定为 [[TN, FP], [FN, TP]]。
 */
export function binaryCountsToMatrix(counts: BinaryCounts): ConfusionMatrix {
  return {
    labels: ["负类", "正类"],
    m: [
      [counts.tn, counts.fp],
      [counts.fn, counts.tp],
    ],
  };
}

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
