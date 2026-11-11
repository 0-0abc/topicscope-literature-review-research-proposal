import type { SegmentationClass } from "./types";

export interface SegmentationStat {
  label: string;
  iou: number | null;
  dice: number | null;
  gtArea: number;
  predArea: number;
}

/** 单个类别的交并比。 */
export function iou(intersection: number, union: number): number | null {
  return union > 0 ? intersection / union : null;
}

/** 单个类别的 Dice，与 IoU 严格等价：dice = 2·iou / (1 + iou)。 */
export function dice(intersection: number, predArea: number, gtArea: number): number | null {
  const denominator = predArea + gtArea;
  return denominator > 0 ? (2 * intersection) / denominator : null;
}

export function diceFromIou(value: number): number {
  return (2 * value) / (1 + value);
}

export function iouFromDice(value: number): number {
  return value / (2 - value);
}

export function segmentationStats(classes: SegmentationClass[]): SegmentationStat[] {
  return classes.map((c) => ({
    label: c.label,
    iou: iou(c.intersection, c.union),
    dice: dice(c.intersection, c.predArea, c.gtArea),
    gtArea: c.gtArea,
    predArea: c.predArea,
  }));
}

/** 各类别 IoU 的算术平均。 */
export function meanIou(classes: SegmentationClass[]): number | null {
  const list = classes.map((c) => iou(c.intersection, c.union)).filter((v): v is number => v !== null);
  if (list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * 各类别 Dice 的算术平均。
 *
 * 注意：mDice ≠ 2·mIoU/(1+mIoU)。IoU→Dice 是逐类非线性变换，
 * 先平均再变换与先变换再平均结果不同，因此只知道 mIoU 无法反解 mDice，
 * 必须拿到每个类别的 IoU。
 */
export function meanDice(classes: SegmentationClass[]): number | null {
  const list = classes.map((c) => dice(c.intersection, c.predArea, c.gtArea)).filter((v): v is number => v !== null);
  if (list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/** 把「先平均再变换」的近似值与真实逐类变换后的均值并列返回，用于口径对照。 */
export function meanDiceTrap(classes: SegmentationClass[]): number | null {
  const m = meanIou(classes);
  return m === null ? null : diceFromIou(m);
}

/** 已知各类别 IoU 时精确还原 mDice。 */
export function meanDiceFromIous(ious: number[]): number | null {
  if (ious.length === 0) return null;
  return ious.map(diceFromIou).reduce((a, b) => a + b, 0) / ious.length;
}
