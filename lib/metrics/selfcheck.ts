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
import { meanDice, meanDiceTrap, meanIou } from "./segmentation";
import { rankingMetrics } from "./ranking";
import { regressionMetrics } from "./regression";
import { CONVERSIONS, type ConversionRule } from "./registry";
import type { BinaryCounts, ConfusionMatrix, SegmentationClass } from "./types";

/**
 * 自检用例的期望值由 dev/selfcheck_reference.py 独立算出。
 * 那份脚本只依据数学定义重写一遍计算，不共用这里的代码路径，
 * 因此两侧一致说明口径与索引顺序都没写错。
 */

const BINARY_MATRIX: ConfusionMatrix = {
  labels: ["负类", "正类"],
  m: [
    [50, 25],
    [10, 915],
  ],
};

const BINARY_COUNTS: BinaryCounts = { tp: 50, fp: 10, fn: 25, tn: 915 };

const MULTICLASS_MATRIX: ConfusionMatrix = {
  labels: ["A", "B", "C"],
  m: [
    [8, 1, 1],
    [1, 7, 2],
    [1, 2, 8],
  ],
};

const SEGMENTATION_CLASSES: SegmentationClass[] = [
  { label: "前景", intersection: 10, union: 190, predArea: 100, gtArea: 100 },
  { label: "背景", intersection: 90, union: 110, predArea: 100, gtArea: 100 },
];

const RANKING_ITEMS = [
  { id: "r1", relevance: 2 },
  { id: "r2", relevance: 0 },
  { id: "r3", relevance: 1 },
  { id: "r4", relevance: 0 },
  { id: "r5", relevance: 3 },
  { id: "r6", relevance: 0 },
];

const REGRESSION_TRUE = [3, -0.5, 2, 7];
const REGRESSION_PRED = [2.5, 0, 2, 8];

export interface SelfCheckCase {
  id: string;
  group: string;
  name: string;
  expected: number;
  actual: number | null;
  tolerance: number;
  passed: boolean;
}

export interface SelfCheckReport {
  total: number;
  passed: number;
  cases: SelfCheckCase[];
}

const TOLERANCE = 1e-9;

function check(
  group: string,
  name: string,
  id: string,
  expected: number,
  actual: number | null,
  tolerance = TOLERANCE,
): SelfCheckCase {
  const passed =
    actual !== null && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  return { id, group, name, expected, actual, tolerance, passed };
}

/** 找到某个换算规则并执行，失败时抛出以便自检立刻暴露问题。 */
function runConversion(rule: ConversionRule, values: Record<string, number | string>): number {
  // 列表类字段（各类别 IoU）按字符串传入，其余字段都是数字
  const outcome = rule.compute(values as Record<string, number>);
  if (!outcome.ok) {
    throw new Error(`换算 ${rule.id} 失败：${outcome.reason}`);
  }
  return outcome.value;
}

export function runSelfCheck(): SelfCheckReport {
  const cases: SelfCheckCase[] = [];

  // ── 二分类混淆矩阵 ────────────────────────────────────────────
  cases.push(check("二分类", "Accuracy", "binary.accuracy", 0.965, accuracy(BINARY_MATRIX)));
  cases.push(
    check(
      "二分类",
      "Balanced Accuracy",
      "binary.balanced_accuracy",
      0.8279279279279279,
      balancedAccuracy(BINARY_MATRIX),
    ),
  );
  cases.push(
    check("二分类", "Macro-F1", "binary.macro_f1", 0.8609869923542846, macroF1(BINARY_MATRIX)),
  );
  cases.push(
    check(
      "二分类",
      "Weighted-F1",
      "binary.weighted_f1",
      0.9631963062257968,
      weightedF1(BINARY_MATRIX),
    ),
  );
  cases.push(check("二分类", "Micro-F1", "binary.micro_f1", 0.965, microF1(BINARY_MATRIX)));
  cases.push(
    check(
      "二分类",
      "Mean Specificity",
      "binary.mean_specificity",
      0.8279279279279279,
      meanSpecificity(BINARY_MATRIX),
    ),
  );
  cases.push(
    check("二分类", "MCC", "binary.mcc", 0.7273950588619387, multiclassMcc(BINARY_MATRIX)),
  );
  cases.push(
    check(
      "二分类",
      "Cohen's Kappa",
      "binary.cohen_kappa",
      0.722222222222222,
      cohensKappa(BINARY_MATRIX),
    ),
  );

  const binary = binaryStats(BINARY_COUNTS);
  cases.push(check("二分类", "Precision", "binary.precision", 0.8333333333333334, binary.precision!));
  cases.push(check("二分类", "Recall", "binary.recall", 0.6666666666666666, binary.recall!));
  cases.push(check("二分类", "F1", "binary.f1", 0.7407407407407408, binary.f1!));
  cases.push(check("二分类", "Specificity", "binary.specificity", 0.9891891891891892, binary.specificity!));
  cases.push(check("二分类", "MCC（计数口径）", "binary_counts.mcc", 0.7273950588619387, binary.mcc));

  // ── 多分类混淆矩阵 ────────────────────────────────────────────
  cases.push(
    check("多分类", "Accuracy", "multi.accuracy", 0.7419354838709677, accuracy(MULTICLASS_MATRIX)),
  );
  cases.push(
    check(
      "多分类",
      "Balanced Accuracy",
      "multi.balanced_accuracy",
      0.7424242424242425,
      balancedAccuracy(MULTICLASS_MATRIX),
    ),
  );
  cases.push(
    check("多分类", "Macro-F1", "multi.macro_f1", 0.7424242424242425, macroF1(MULTICLASS_MATRIX)),
  );
  cases.push(
    check(
      "多分类",
      "Weighted-F1",
      "multi.weighted_f1",
      0.7419354838709677,
      weightedF1(MULTICLASS_MATRIX),
    ),
  );
  cases.push(
    check("多分类", "Micro-F1", "multi.micro_f1", 0.7419354838709677, microF1(MULTICLASS_MATRIX)),
  );
  cases.push(
    check(
      "多分类",
      "Mean Specificity",
      "multi.mean_specificity",
      0.8706349206349207,
      meanSpecificity(MULTICLASS_MATRIX),
    ),
  );
  cases.push(
    check("多分类", "MCC", "multi.mcc", 0.6125, multiclassMcc(MULTICLASS_MATRIX)),
  );
  cases.push(
    check(
      "多分类",
      "Cohen's Kappa",
      "multi.cohen_kappa",
      0.6125,
      cohensKappa(MULTICLASS_MATRIX),
    ),
  );

  const multiStats = stats(MULTICLASS_MATRIX);
  cases.push(check("多分类", "A 类 Precision", "multi.a.precision", 0.8, multiStats[0].precision!));
  cases.push(check("多分类", "A 类 Recall", "multi.a.recall", 0.8, multiStats[0].recall!));
  cases.push(check("多分类", "A 类 F1", "multi.a.f1", 0.8000000000000002, multiStats[0].f1!));
  cases.push(check("多分类", "C 类 Precision", "multi.c.precision", 0.7272727272727273, multiStats[2].precision!));
  cases.push(check("多分类", "C 类 Recall", "multi.c.recall", 0.7272727272727273, multiStats[2].recall!));
  cases.push(check("多分类", "C 类 F1", "multi.c.f1", 0.7272727272727273, multiStats[2].f1!));

  // Micro-F1 与 Accuracy 在单标签多分类下必须严格相等
  cases.push(
    check(
      "多分类",
      "Micro-F1 与 Accuracy 相等",
      "multi.micro_equals_accuracy",
      0,
      microF1(MULTICLASS_MATRIX) - accuracy(MULTICLASS_MATRIX),
    ),
  );

  // ── 分割指标 ────────────────────────────────────────────────
  const miouValue = meanIou(SEGMENTATION_CLASSES);
  const mdiceValue = meanDice(SEGMENTATION_CLASSES);
  const trapValue = meanDiceTrap(SEGMENTATION_CLASSES);
  cases.push(check("分割", "mIoU", "seg.miou", 0.43540669856459335, miouValue));
  cases.push(check("分割", "mDice", "seg.mdice", 0.5, mdiceValue));
  cases.push(
    check(
      "分割",
      "先平均再变换的近似值",
      "seg.trap_mean_dice",
      0.6066666666666668,
      trapValue,
    ),
  );
  cases.push(
    check(
      "分割",
      "mDice 与「由 mIoU 变换而来」的差值",
      "seg.mdice_gap_from_miou_trap",
      0.1066666666666668,
      mdiceValue !== null && trapValue !== null ? Math.abs(mdiceValue - trapValue) : null,
    ),
  );

  // ── 排序指标 ────────────────────────────────────────────────
  const ranking = rankingMetrics(RANKING_ITEMS, 3, 1);
  cases.push(check("排序", "Precision@3", "rank.precision_at_k", 0.6666666666666666, ranking.precisionAtK!));
  cases.push(check("排序", "Recall@3", "rank.recall_at_k", 0.6666666666666666, ranking.recallAtK!));
  cases.push(check("排序", "MAP", "rank.map", 0.7555555555555555, ranking.map!));
  cases.push(check("排序", "NDCG@3", "rank.ndcg", 0.3726262671130988, ranking.ndcgAtK!));
  cases.push(check("排序", "MRR", "rank.mrr", 1.0, ranking.mrr!));

  // ── 回归指标 ────────────────────────────────────────────────
  const regression = regressionMetrics(REGRESSION_TRUE, REGRESSION_PRED);
  cases.push(check("回归", "MAE", "reg.mae", 0.5, regression.mae));
  cases.push(check("回归", "MSE", "reg.mse", 0.375, regression.mse));
  cases.push(check("回归", "RMSE", "reg.rmse", 0.6123724356957945, regression.rmse));
  cases.push(check("回归", "R²", "reg.r2", 0.9486081370449679, regression.r2!));
  cases.push(check("回归", "MAPE", "reg.mape", 32.73809523809524, regression.mape!));
  cases.push(check("回归", "SMAPE", "reg.smape", 57.87878787878788, regression.smape!));

  // ── 口径换算 ────────────────────────────────────────────────
  const f1FromPr = CONVERSIONS.find((c) => c.id === "f1_from_pr")!;
  const precisionFromF1Recall = CONVERSIONS.find((c) => c.id === "precision_from_f1_recall")!;
  const recallFromF1Precision = CONVERSIONS.find((c) => c.id === "recall_from_f1_precision")!;
  const diceFromIou = CONVERSIONS.find((c) => c.id === "dice_from_iou")!;
  const iouFromDice = CONVERSIONS.find((c) => c.id === "iou_from_dice")!;
  const mdiceFromClassIou = CONVERSIONS.find((c) => c.id === "mdice_from_class_iou")!;

  cases.push(
    check(
      "换算",
      "P + R → F1",
      "conv.f1_from_pr",
      0.7407407407407408,
      runConversion(f1FromPr, { precision: 5 / 6, recall: 2 / 3 }),
    ),
  );
  cases.push(
    check(
      "换算",
      "F1 + R → P",
      "conv.precision_from_f1_recall",
      0.8333333333333334,
      runConversion(precisionFromF1Recall, { f1: 10 / 13.5, recall: 2 / 3 }),
    ),
  );
  cases.push(
    check(
      "换算",
      "F1 + P → R",
      "conv.recall_from_f1_precision",
      0.6666666666666665,
      runConversion(recallFromF1Precision, { f1: 10 / 13.5, precision: 5 / 6 }),
    ),
  );
  cases.push(
    check(
      "换算",
      "IoU → Dice",
      "conv.dice_from_iou",
      0.7368421052631579,
      runConversion(diceFromIou, { iou: 7 / 12 }),
    ),
  );
  cases.push(
    check(
      "换算",
      "Dice → IoU",
      "conv.iou_from_dice",
      0.588235294117647,
      runConversion(iouFromDice, { dice: 10 / 13.5 }),
    ),
  );
  cases.push(
    check(
      "换算",
      "逐类别 IoU → mDice",
      "conv.mdice_from_class_iou",
      0.5,
      runConversion(mdiceFromClassIou, { iouList: "0.05263157894736842,0.8181818181818182" }),
    ),
  );

  // 换算与直接计算必须自洽：F1 → P → F1 回到原值
  const roundTripP = runConversion(precisionFromF1Recall, { f1: 10 / 13.5, recall: 2 / 3 });
  const roundTripF1 = runConversion(f1FromPr, { precision: roundTripP, recall: 2 / 3 });
  cases.push(
    check(
      "换算",
      "F1 → P → F1 回到原值",
      "conv.round_trip_f1",
      10 / 13.5,
      roundTripF1,
      1e-12,
    ),
  );

  const passed = cases.filter((c) => c.passed).length;
  return { total: cases.length, passed, cases };
}
