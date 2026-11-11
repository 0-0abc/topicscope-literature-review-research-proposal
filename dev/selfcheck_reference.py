"""独立计算 TopicScope 自检用例的期望值。

与站点实现（TypeScript）分开写，只共用数学定义，不共用代码路径，
用于交叉验证聚合方式与索引顺序是否正确。
运行：python dev/selfcheck_reference.py
"""

import json
import math


def class_counts(matrix):
    n = len(matrix)
    total = sum(sum(row) for row in matrix)
    out = []
    for k in range(n):
        tp = matrix[k][k]
        fn = sum(matrix[k][j] for j in range(n) if j != k)
        fp = sum(matrix[i][k] for i in range(n) if i != k)
        out.append({"label": str(k), "tp": tp, "fp": fp, "fn": fn, "tn": total - tp - fp - fn})
    return out


def classification(matrix):
    counts = class_counts(matrix)
    total = sum(sum(row) for row in matrix)
    stats = []
    for c in counts:
        precision = c["tp"] / (c["tp"] + c["fp"]) if c["tp"] + c["fp"] else None
        recall = c["tp"] / (c["tp"] + c["fn"]) if c["tp"] + c["fn"] else None
        specificity = c["tn"] / (c["tn"] + c["fp"]) if c["tn"] + c["fp"] else None
        f1 = (2 * precision * recall / (precision + recall)) if precision and recall and precision + recall else None
        stats.append({**c, "precision": precision, "recall": recall, "specificity": specificity, "f1": f1})

    accuracy = sum(matrix[i][i] for i in range(len(matrix))) / total
    recalls = [s["recall"] for s in stats if s["recall"] is not None]
    f1s = [s["f1"] for s in stats if s["f1"] is not None]
    supports = [s["tp"] + s["fn"] for s in stats]
    spec = [s["specificity"] for s in stats if s["specificity"] is not None]

    sum_tp = sum(s["tp"] for s in stats)
    true_counts = [s["tp"] + s["fn"] for s in stats]
    predicted_counts = [s["tp"] + s["fp"] for s in stats]
    n_correct = sum(matrix[i][i] for i in range(len(matrix)))
    cov_ytyp = n_correct * total - sum(t * p for t, p in zip(true_counts, predicted_counts))
    cov_ypyp = total**2 - sum(p * p for p in predicted_counts)
    cov_ytyt = total**2 - sum(t * t for t in true_counts)
    denominator = math.sqrt(cov_ypyp * cov_ytyt)
    mcc = cov_ytyp / denominator if denominator else 0.0

    po = sum_tp / total
    pe = sum((s["tp"] + s["fn"]) / total * (s["tp"] + s["fp"]) / total for s in stats)
    kappa = (po - pe) / (1 - pe)

    tp = sum(s["tp"] for s in stats)
    fp = sum(s["fp"] for s in stats)
    fn = sum(s["fn"] for s in stats)
    micro_p = tp / (tp + fp)
    micro_r = tp / (tp + fn)
    micro_f1 = 2 * micro_p * micro_r / (micro_p + micro_r)

    weighted = sum((s["f1"] or 0) * (s["tp"] + s["fn"]) for s in stats) / total

    return {
        "accuracy": accuracy,
        "balanced_accuracy": sum(recalls) / len(recalls),
        "macro_f1": sum(f1s) / len(f1s),
        "weighted_f1": weighted,
        "micro_f1": micro_f1,
        "mean_specificity": sum(spec) / len(spec),
        "mcc": mcc,
        "cohen_kappa": kappa,
        "per_class": stats,
    }


def binary(tp, fp, fn, tn):
    total = tp + fp + fn + tn
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    specificity = tn / (tn + fp)
    f1 = 2 * precision * recall / (precision + recall)
    accuracy = (tp + tn) / total
    pe = ((tp + fp) * (tp + fn) + (tn + fn) * (tn + fp)) / total**2
    kappa = (accuracy - pe) / (1 - pe)
    mcc = (tp * tn - fp * fn) / math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    return {
        "precision": precision,
        "recall": recall,
        "specificity": specificity,
        "f1": f1,
        "accuracy": accuracy,
        "kappa": kappa,
        "mcc": mcc,
    }


def segmentation(classes):
    ious, dices = [], []
    for intersection, pred_area, gt_area in classes:
        union = pred_area + gt_area - intersection
        ious.append(intersection / union)
        dices.append(2 * intersection / (pred_area + gt_area))
    miou = sum(ious) / len(ious)
    mdice = sum(dices) / len(dices)
    return {
        "ious": ious,
        "dices": dices,
        "miou": miou,
        "mdice": mdice,
        "trap_mean_dice": 2 * miou / (1 + miou),
    }


def ranking(items, k, threshold=1):
    total = len(items)
    relevant_total = sum(1 for r in items if r >= threshold)
    top_k = items[:k]
    relevant_in_top_k = sum(1 for r in top_k if r >= threshold)
    precision_at_k = relevant_in_top_k / k if k else None
    recall_at_k = relevant_in_top_k / relevant_total if relevant_total else None

    seen = 0
    precision_sum = 0.0
    for index, relevance in enumerate(items):
        if relevance >= threshold:
            seen += 1
            precision_sum += seen / (index + 1)
    ap = precision_sum / relevant_total if relevant_total else None

    dcg = sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(top_k))
    ideal = sorted(items, reverse=True)[:k]
    idcg = sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(ideal))
    ndcg = dcg / idcg if idcg else None

    mrr = None
    for index, relevance in enumerate(items):
        if relevance >= threshold:
            mrr = 1 / (index + 1)
            break

    return {
        "precision_at_k": precision_at_k,
        "recall_at_k": recall_at_k,
        "map": ap,
        "ndcg_at_k": ndcg,
        "mrr": mrr,
    }


def regression(y_true, y_pred):
    n = len(y_true)
    mae = sum(abs(p - t) for t, p in zip(y_true, y_pred)) / n
    mse = sum((p - t) ** 2 for t, p in zip(y_true, y_pred)) / n
    mean_true = sum(y_true) / n
    ss_res = sum((p - t) ** 2 for t, p in zip(y_true, y_pred))
    ss_tot = sum((t - mean_true) ** 2 for t in y_true)
    ratios = [abs((p - t) / t) for t, p in zip(y_true, y_pred) if t != 0]
    symmetric = [
        abs(p - t) / ((abs(t) + abs(p)) / 2) * 100 for t, p in zip(y_true, y_pred)
    ]
    return {
        "mae": mae,
        "mse": mse,
        "rmse": math.sqrt(mse),
        "r2": 1 - ss_res / ss_tot,
        "mape": sum(ratios) / len(ratios) * 100,
        "smape": sum(symmetric) / n,
    }


BINARY_MATRIX = [[50, 25], [10, 915]]
MULTICLASS_MATRIX = [[8, 1, 1], [1, 7, 2], [1, 2, 8]]
SEGMENTATION_CLASSES = [(10, 100, 100), (90, 100, 100)]
RANKING_ITEMS = [2, 0, 1, 0, 3, 0]
REGRESSION_TRUE = [3.0, -0.5, 2.0, 7.0]
REGRESSION_PRED = [2.5, 0.0, 2.0, 8.0]

reference = {
    "binary_matrix": classification(BINARY_MATRIX),
    "binary_counts": binary(50, 10, 25, 915),
    "multiclass_matrix": classification(MULTICLASS_MATRIX),
    "segmentation": segmentation(SEGMENTATION_CLASSES),
    "ranking": ranking(RANKING_ITEMS, 3, 1),
    "regression": regression(REGRESSION_TRUE, REGRESSION_PRED),
    "conversions": {
        "f1_from_pr": 2 * (5 / 6) * (2 / 3) / ((5 / 6) + (2 / 3)),
        "precision_from_f1_recall": ((10 / 13.5) * (2 / 3)) / (2 * (2 / 3) - (10 / 13.5)),
        "recall_from_f1_precision": ((10 / 13.5) * (5 / 6)) / (2 * (5 / 6) - (10 / 13.5)),
        "dice_from_iou": 2 * (7 / 12) / (1 + 7 / 12),
        "iou_from_dice": (10 / 13.5) / (2 - 10 / 13.5),
        "mdice_from_class_iou": sum(2 * i / (1 + i) for i in [1 / 19, 9 / 11]) / 2,
    },
}

if __name__ == "__main__":
    print(json.dumps(reference, indent=2, ensure_ascii=False))
