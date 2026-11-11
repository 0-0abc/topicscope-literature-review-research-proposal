import {
  accuracy,
  balancedAccuracy,
  binaryStats,
  cohensKappa,
  macroF1,
  meanSpecificity,
  microF1,
  multiclassMcc,
  stats,
  weightedF1,
} from "./classification";
import { meanDice, meanDiceTrap, meanIou, segmentationStats } from "./segmentation";
import { rankingMetrics } from "./ranking";
import { regressionMetrics } from "./regression";
import type { BinaryCounts, ConfusionMatrix, RankingItem, SegmentationClass } from "./types";

export type MetricFamily = "classification" | "segmentation" | "ranking" | "regression";

export interface MetricDefinition {
  id: string;
  name: string;
  aliases: string[];
  family: MetricFamily;
  formula: string;
  higherIsBetter: boolean;
}

export interface MetricResult extends MetricDefinition {
  value: number | null;
  note: string;
  trap?: string;
}

export const METRICS: MetricDefinition[] = [
  {
    id: "accuracy",
    name: "Accuracy 准确率",
    aliases: ["acc", "ACC", "accuracy"],
    family: "classification",
    formula: "(TP + TN) / N",
    higherIsBetter: true,
  },
  {
    id: "balanced_accuracy",
    name: "Balanced Accuracy 平衡准确率",
    aliases: ["balanced acc", "bacc"],
    family: "classification",
    formula: "各类 recall 的算术平均 = (TPR + TNR) / 2",
    higherIsBetter: true,
  },
  {
    id: "macro_f1",
    name: "Macro-F1 宏平均 F1",
    aliases: ["macro f1", "macro-F1"],
    family: "classification",
    formula: "各类 F1 的算术平均",
    higherIsBetter: true,
  },
  {
    id: "weighted_f1",
    name: "Weighted-F1 加权 F1",
    aliases: ["weighted f1"],
    family: "classification",
    formula: "Σ F1_c × support_c / N",
    higherIsBetter: true,
  },
  {
    id: "micro_f1",
    name: "Micro-F1 微平均 F1",
    aliases: ["micro f1", "micro-F1"],
    family: "classification",
    formula: "汇总 TP/FP/FN 后计算 F1；单标签多分类下等于 Accuracy",
    higherIsBetter: true,
  },
  {
    id: "mean_specificity",
    name: "Mean Specificity 平均特异度",
    aliases: ["specificity", "tnr"],
    family: "classification",
    formula: "各类 specificity 的算术平均",
    higherIsBetter: true,
  },
  {
    id: "mcc",
    name: "MCC 马修斯相关系数",
    aliases: ["mcc", "Matthews"],
    family: "classification",
    formula:
      "(n_correct·N − Σ_k t_k·p_k) / √((N² − Σ_k p_k²)(N² − Σ_k t_k²))",
    higherIsBetter: true,
  },
  {
    id: "cohen_kappa",
    name: "Cohen's Kappa",
    aliases: ["kappa"],
    family: "classification",
    formula: "(p_o − p_e) / (1 − p_e)",
    higherIsBetter: true,
  },
  {
    id: "precision",
    name: "Precision 精确率",
    aliases: ["precision", "ppv"],
    family: "classification",
    formula: "TP / (TP + FP)",
    higherIsBetter: true,
  },
  {
    id: "recall",
    name: "Recall 召回率",
    aliases: ["recall", "sensitivity", "tpr"],
    family: "classification",
    formula: "TP / (TP + FN)",
    higherIsBetter: true,
  },
  {
    id: "f1",
    name: "F1",
    aliases: ["f1", "f1 score"],
    family: "classification",
    formula: "2PR / (P + R)",
    higherIsBetter: true,
  },
  {
    id: "iou",
    name: "IoU 交并比",
    aliases: ["iou", "jaccard"],
    family: "segmentation",
    formula: "intersection / union",
    higherIsBetter: true,
  },
  {
    id: "dice",
    name: "Dice 系数",
    aliases: ["dice", "f1 score (segmentation)"],
    family: "segmentation",
    formula: "2 × intersection / (predArea + gtArea) = 2·IoU / (1 + IoU)",
    higherIsBetter: true,
  },
  {
    id: "miou",
    name: "mIoU 平均交并比",
    aliases: ["miou", "m iou"],
    family: "segmentation",
    formula: "各类 IoU 的算术平均",
    higherIsBetter: true,
  },
  {
    id: "mdice",
    name: "mDice 平均 Dice",
    aliases: ["mdice", "m dice"],
    family: "segmentation",
    formula: "各类 Dice 的算术平均",
    higherIsBetter: true,
  },
  {
    id: "precision_at_k",
    name: "Precision@k",
    aliases: ["p@k"],
    family: "ranking",
    formula: "前 k 项中相关项占比",
    higherIsBetter: true,
  },
  {
    id: "recall_at_k",
    name: "Recall@k",
    aliases: ["r@k"],
    family: "ranking",
    formula: "前 k 项命中的相关项 / 全部相关项",
    higherIsBetter: true,
  },
  {
    id: "map",
    name: "MAP 平均准确率均值",
    aliases: ["map", "ap"],
    family: "ranking",
    formula: "各相关位置上 Precision 的平均",
    higherIsBetter: true,
  },
  {
    id: "ndcg",
    name: "NDCG@k 归一化折损累积增益",
    aliases: ["ndcg", "ndcg@k"],
    family: "ranking",
    formula: "DCG@k / IDCG@k",
    higherIsBetter: true,
  },
  {
    id: "mrr",
    name: "MRR 平均倒数排名",
    aliases: ["mrr"],
    family: "ranking",
    formula: "首个相关项位次的倒数",
    higherIsBetter: true,
  },
  {
    id: "mae",
    name: "MAE 平均绝对误差",
    aliases: ["mae"],
    family: "regression",
    formula: "Σ |y − ŷ| / n",
    higherIsBetter: false,
  },
  {
    id: "mse",
    name: "MSE 均方误差",
    aliases: ["mse"],
    family: "regression",
    formula: "Σ (y − ŷ)² / n",
    higherIsBetter: false,
  },
  {
    id: "rmse",
    name: "RMSE 均方根误差",
    aliases: ["rmse"],
    family: "regression",
    formula: "√MSE",
    higherIsBetter: false,
  },
  {
    id: "r2",
    name: "R² 决定系数",
    aliases: ["r2", "r squared"],
    family: "regression",
    formula: "1 − SS_res / SS_tot",
    higherIsBetter: true,
  },
  {
    id: "mape",
    name: "MAPE 平均绝对百分比误差",
    aliases: ["mape"],
    family: "regression",
    formula: "Σ |(y − ŷ)/y| / n（跳过 y = 0）",
    higherIsBetter: false,
  },
  {
    id: "smape",
    name: "SMAPE 对称平均绝对百分比误差",
    aliases: ["smape"],
    family: "regression",
    formula: "Σ 2|y − ŷ| / (|y| + |ŷ|) / n",
    higherIsBetter: false,
  },
];

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));

export type MetricInput =
  | { kind: "classification"; matrix: ConfusionMatrix }
  | { kind: "binary"; counts: BinaryCounts }
  | { kind: "segmentation"; classes: SegmentationClass[] }
  | { kind: "ranking"; items: RankingItem[]; k: number; threshold: number }
  | { kind: "regression"; yTrue: number[]; yPred: number[] };

function result(
  id: string,
  value: number | null,
  note: string,
  trap?: string,
): MetricResult {
  const definition = METRIC_BY_ID.get(id)!;
  return { ...definition, value, note, trap };
}

export function computeMetrics(input: MetricInput): MetricResult[] {
  switch (input.kind) {
    case "classification": {
      const matrix = input.matrix;
      const perClass = stats(matrix);
      const micro = microF1(matrix);
      const accuracyValue = accuracy(matrix);
      return [
        result(
          "accuracy",
          accuracyValue,
          "所有预测正确的样本占比。类别不平衡时会被多数类主导。",
        ),
        result(
          "balanced_accuracy",
          balancedAccuracy(matrix),
          "各类 recall 的平均，对类别不平衡不敏感，常与 Accuracy 一起报出。",
        ),
        result(
          "macro_f1",
          macroF1(matrix),
          "各类 F1 的平均，给每个类别同等权重，小类表现会被放大。",
        ),
        result(
          "weighted_f1",
          weightedF1(matrix),
          "按各类真实样本数加权，接近整体表现但不会像 Accuracy 那样被极端不平衡主导。",
        ),
        result(
          "micro_f1",
          micro,
          "汇总全部类别的 TP/FP/FN 后计算。",
          "单标签多分类下 Micro-F1 与 Accuracy 严格相等，把两者当成两个指标报出来是常见错误。",
        ),
        result(
          "mean_specificity",
          meanSpecificity(matrix),
          "各类真负率（TNR）的平均。",
        ),
        result(
          "mcc",
          multiclassMcc(matrix),
          "单值综合指标，对类别不平衡比 Accuracy 更敏感，常作为主指标。",
        ),
        result(
          "cohen_kappa",
          cohensKappa(matrix),
          "校正随机一致性的分类一致性指标。",
        ),
        result(
          "precision",
          perClass[perClass.length - 1]?.precision ?? null,
          "以最后一个类别为正类的精确率。二分类时按你指定的正类取值。",
        ),
        result(
          "recall",
          perClass[perClass.length - 1]?.recall ?? null,
          "以最后一个类别为正类的召回率。二分类时按你指定的正类取值。",
        ),
      ];
    }
    case "binary": {
      const s = binaryStats(input.counts);
      return [
        result("accuracy", s.accuracy, "二分类整体准确率。"),
        result("precision", s.precision, "正类精确率。"),
        result("recall", s.recall, "正类召回率。"),
        result("f1", s.f1, "正类 F1。"),
        result("mean_specificity", s.specificity, "负类真负率。"),
        result("mcc", s.mcc, "二分类马修斯相关系数。"),
        result("cohen_kappa", s.kappa, "二分类 Cohen's Kappa。"),
      ];
    }
    case "segmentation": {
      const list = segmentationStats(input.classes);
      const miou = meanIou(input.classes);
      const mdice = meanDice(input.classes);
      const trap = meanDiceTrap(input.classes);
      return [
        result("iou", list[0]?.iou ?? null, "第一个类别的交并比。"),
        result("dice", list[0]?.dice ?? null, "第一个类别的 Dice 系数。"),
        result("miou", miou, "各类别 IoU 的算术平均。"),
        result(
          "mdice",
          mdice,
          "各类别 Dice 的算术平均。",
          trap !== null && miou !== null && mdice !== null && Math.abs(trap - mdice) > 1e-9
            ? `直接把 mIoU 当作单个 IoU 做变换会得到 ${(trap * 100).toFixed(2)}%，而逐类变换后取平均是 ${(mdice * 100).toFixed(2)}%——两者不等。`
            : undefined,
        ),
      ];
    }
    case "ranking": {
      const m = rankingMetrics(input.items, input.k, input.threshold);
      return [
        result("precision_at_k", m.precisionAtK, `前 ${input.k} 项中相关项的占比。`),
        result("recall_at_k", m.recallAtK, `前 ${input.k} 项命中的相关项占全部相关项的比例。`),
        result("map", m.map, "所有相关位置上 Precision 的平均。"),
        result("ndcg", m.ndcgAtK, `考虑分级相关度的折损累积增益（k = ${input.k}）。`),
        result("mrr", m.mrr, "首个相关项位次的倒数。"),
      ];
    }
    case "regression": {
      const m = regressionMetrics(input.yTrue, input.yPred);
      return [
        result("mae", m.mae, "平均绝对误差，与原始量纲一致。"),
        result("mse", m.mse, "均方误差，对大误差更敏感。"),
        result("rmse", m.rmse, "均方根误差，与原始量纲一致。"),
        result("r2", m.r2, "相对于均值基线的解释方差比例。"),
        result("mape", m.mape, "平均绝对百分比误差，对真值为 0 的样本无定义，已跳过。"),
        result("smape", m.smape, "对称百分比误差，介于 0%–200%，真值与预测同向比较。"),
      ];
    }
  }
}

export interface ConversionField {
  key: string;
  label: string;
}

export type ConversionOutcome =
  | { ok: true; value: number; basis: string }
  | { ok: false; reason: string };

export interface ConversionRule {
  id: string;
  from: string;
  to: string;
  fields: ConversionField[];
  formula: string;
  caveat?: string;
  compute(values: Record<string, number>): ConversionOutcome;
}

export const CONVERSIONS: ConversionRule[] = [
  {
    id: "f1_from_pr",
    from: "precision_recall",
    to: "f1",
    fields: [
      { key: "precision", label: "Precision" },
      { key: "recall", label: "Recall" },
    ],
    formula: "F1 = 2PR / (P + R)",
    compute(values) {
      const { precision, recall } = values;
      if (precision + recall === 0) return { ok: false, reason: "P 与 R 同时为 0 时 F1 无定义（没有任何正类被命中）。" };
      return {
        ok: true,
        value: (2 * precision * recall) / (precision + recall),
        basis: "由 Precision 与 Recall 直接推导",
      };
    },
  },
  {
    id: "precision_from_f1_recall",
    from: "f1_recall",
    to: "precision",
    fields: [
      { key: "f1", label: "F1" },
      { key: "recall", label: "Recall" },
    ],
    formula: "P = F1·R / (2R − F1)",
    caveat: "当 2R = F1 时分母为 0，无唯一解。",
    compute(values) {
      const { f1, recall } = values;
      const denominator = 2 * recall - f1;
      if (denominator === 0) return { ok: false, reason: "2R − F1 = 0，此时 Precision 无唯一解。" };
      return { ok: true, value: (f1 * recall) / denominator, basis: "由 F1 与 Recall 反解 Precision" };
    },
  },
  {
    id: "recall_from_f1_precision",
    from: "f1_precision",
    to: "recall",
    fields: [
      { key: "f1", label: "F1" },
      { key: "precision", label: "Precision" },
    ],
    formula: "R = F1·P / (2P − F1)",
    caveat: "当 2P = F1 时分母为 0，无唯一解。",
    compute(values) {
      const { f1, precision } = values;
      const denominator = 2 * precision - f1;
      if (denominator === 0) return { ok: false, reason: "2P − F1 = 0，此时 Recall 无唯一解。" };
      return { ok: true, value: (f1 * precision) / denominator, basis: "由 F1 与 Precision 反解 Recall" };
    },
  },
  {
    id: "dice_from_iou",
    from: "iou",
    to: "dice",
    fields: [{ key: "iou", label: "IoU" }],
    formula: "Dice = 2·IoU / (1 + IoU)",
    compute(values) {
      const { iou } = values;
      return {
        ok: true,
        value: (2 * iou) / (1 + iou),
        basis: "单类别上 IoU 与 Dice 严格等价",
      };
    },
  },
  {
    id: "iou_from_dice",
    from: "dice",
    to: "iou",
    fields: [{ key: "dice", label: "Dice" }],
    formula: "IoU = Dice / (2 − Dice)",
    compute(values) {
      const { dice } = values;
      return { ok: true, value: dice / (2 - dice), basis: "单类别上 Dice 与 IoU 严格等价" };
    },
  },
  {
    id: "mdice_from_class_iou",
    from: "class_iou_list",
    to: "mdice",
    fields: [{ key: "iouList", label: "各类别 IoU（逗号分隔）" }],
    formula: "mDice = mean(2·IoU_c / (1 + IoU_c))",
    caveat: "必须逐类别换算后再取平均，不能只用一个平均 IoU 代入。",
    compute(values) {
      const raw = String(values.iouList ?? "")
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map(Number)
        .filter((v) => Number.isFinite(v));
      if (raw.length === 0) return { ok: false, reason: "需要至少一个类别的 IoU 值。" };
      const value = raw.map((v) => (2 * v) / (1 + v)).reduce((a, b) => a + b, 0) / raw.length;
      return {
        ok: true,
        value,
        basis: `${raw.length} 个类别逐类变换后取平均`,
      };
    },
  },
  {
    id: "accuracy_from_class_recall",
    from: "class_recall_list",
    to: "accuracy",
    fields: [{ key: "recallList", label: "各类 Recall（逗号分隔）" }],
    formula: "Balanced Accuracy = mean(R_c)；缺少 support 时无法还原真正的 Accuracy",
    compute(values) {
      const raw = String(values.recallList ?? "")
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map(Number)
        .filter((v) => Number.isFinite(v));
      if (raw.length === 0) return { ok: false, reason: "需要至少一个类别的 Recall 值。" };
      if (raw.some((v) => v < 0 || v > 1)) return { ok: false, reason: "Recall 必须是 0–1 之间的比例。" };
      return {
        ok: true,
        value: raw.reduce((a, b) => a + b, 0) / raw.length,
        basis: "各类 Recall 等权时的 Balanced Accuracy；缺少 support 时无法还原真正的 Accuracy。",
      };
    },
  },
];

export interface IncompatiblePair {
  from: string;
  to: string;
  reason: string;
}

/** 明确标注「换不了」的常见口径对——诚实比假装能算更重要。 */
export const INCOMPATIBLE: IncompatiblePair[] = [
  {
    from: "miou",
    to: "mdice",
    reason:
      "IoU→Dice 是逐类非线性变换，先平均再变换与先变换再平均结果不同。只有一个 mIoU 无法唯一确定 mDice，必须拿到每个类别的 IoU。",
  },
  {
    from: "accuracy",
    to: "balanced_accuracy",
    reason:
      "Accuracy 与 Balanced Accuracy 的差异完全来自类别分布。只有 Accuracy 一个数，无法推出 Balanced Accuracy；需要各类别的 recall 及其 support。",
  },
  {
    from: "macro_f1",
    to: "micro_f1",
    reason:
      "两者的差异由类别分布与各类 F1 共同决定，无法从单一数值互相反解；需要各类别的完整混淆矩阵。",
  },
  {
    from: "macro_f1",
    to: "accuracy",
    reason: "Macro-F1 依赖每类 F1，Accuracy 依赖总正确数，二者之间没有确定的映射关系。",
  },
  {
    from: "mape",
    to: "smape",
    reason:
      "MAPE 与 SMAPE 对正负误差的惩罚方式不同且都依赖逐样本误差分布，单个汇总值无法互相还原。",
  },
];

export function findConversion(from: string, to: string): ConversionRule | undefined {
  return CONVERSIONS.find((c) => c.from === from && c.to === to);
}

export function findIncompatible(from: string, to: string): IncompatiblePair | undefined {
  return INCOMPATIBLE.find((c) => c.from === from && c.to === to);
}
