import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SelfCheckPanel } from "@/components/SelfCheckPanel";
import {
  computeMetrics,
  INCOMPATIBLE,
  METRIC_BY_ID,
  type MetricInput,
  type MetricResult,
} from "@/lib/metrics/registry";
import {
  binaryCountsToMatrix,
  f1FromPrecisionRecall,
  validateConfusionMatrix,
} from "@/lib/metrics/classification";
import {
  diceFromIou,
  iouFromDice,
  withSegmentationUnion,
} from "@/lib/metrics/segmentation";
import type { ConfusionMatrix, SegmentationClass } from "@/lib/metrics/types";
import { metricValue, percent } from "@/lib/format";
import { downloadText } from "@/lib/export";

type TaskKind = "classification" | "segmentation" | "ranking" | "regression";

const TASK_LABEL: Record<TaskKind, string> = {
  classification: "分类",
  segmentation: "分割",
  ranking: "排序 / 检索",
  regression: "回归",
};

const DEFAULT_MATRIX: ConfusionMatrix = {
  labels: ["A", "B", "C"],
  m: [
    [8, 1, 1],
    [1, 7, 2],
    [1, 2, 8],
  ],
};

const DEFAULT_SEGMENTATION: SegmentationClass[] = [
  { label: "前景", intersection: 10, union: 190, predArea: 100, gtArea: 100 },
  { label: "背景", intersection: 90, union: 110, predArea: 100, gtArea: 100 },
];

export interface AlignViewProps {
  /** 由上层提供时，结果区出现「带入研究方案」按钮，把当前口径结论塞进方案约束输入。 */
  onApplyToPlan?: (text: string) => void;
}

export function AlignView({ onApplyToPlan }: AlignViewProps = {}) {
  const [task, setTask] = useState<TaskKind>("classification");
  const [matrix, setMatrix] = useState<ConfusionMatrix>(DEFAULT_MATRIX);
  const [binary, setBinary] = useState({ tp: 50, fp: 10, fn: 25, tn: 915 });
  const [binaryMode, setBinaryMode] = useState(false);
  const [segments, setSegments] = useState<SegmentationClass[]>(DEFAULT_SEGMENTATION);
  const [rankingText, setRankingText] = useState("2\n0\n1\n0\n3\n0");
  const [rankingK, setRankingK] = useState(3);
  const [trueText, setTrueText] = useState("3, -0.5, 2, 7");
  const [predText, setPredText] = useState("2.5, 0, 2, 8");

  const input = useMemo<MetricInput>(() => {
    if (task === "segmentation") {
      return { kind: "segmentation", classes: segments };
    }
    if (task === "ranking") {
      const items = rankingText
        .split(/[\n,，\s]+/)
        .filter(Boolean)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((relevance, index) => ({ id: `q${index + 1}`, relevance }));
      return { kind: "ranking", items, k: rankingK, threshold: 1 };
    }
    if (task === "regression") {
      const parse = (text: string) =>
        text
          .split(/[\n,，\s]+/)
          .filter(Boolean)
          .map(Number)
          .filter((value) => Number.isFinite(value));
      const yTrue = parse(trueText);
      const yPred = parse(predText);
      const length = Math.min(yTrue.length, yPred.length);
      return { kind: "regression", yTrue: yTrue.slice(0, length), yPred: yPred.slice(0, length) };
    }
    return {
      kind: "classification",
      matrix: binaryMode ? binaryCountsToMatrix(binary) : matrix,
    };
  }, [task, segments, rankingText, rankingK, trueText, predText, matrix, binaryMode, binary]);

  // S1：分类输入先校验再计算。非法时不产出任何指标，避免负数/小数/N=0
  // 被静默算成「看起来有效」的数字。
  const validation = useMemo(() => {
    if (task !== "classification") return { ok: true, errors: [] as string[] };
    return validateConfusionMatrix(binaryMode ? binary : matrix);
  }, [task, binaryMode, binary, matrix]);

  const results = useMemo(
    () => (validation.ok ? computeMetrics(input) : []),
    [input, validation.ok],
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="heading-cn text-sm">第一步：录入你自己的数</h2>
          <p className="text-xs text-muted-foreground">
            把论文或实验里的数字填进来。左边是你的原始数据，右边列出这些数据能算出哪些指标、每个指标是什么口径。
          </p>
        </div>

        <Tabs value={task} onValueChange={(value) => setTask(value as TaskKind)}>
          <TabsList>
            {(Object.keys(TASK_LABEL) as TaskKind[]).map((kind) => (
              <TabsTrigger key={kind} value={kind}>
                {TASK_LABEL[kind]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="classification" className="mt-3">
            <Card className="gap-3 rounded-md border-border py-4 shadow-none">
              <CardHeader className="px-4">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="heading-cn text-sm">混淆矩阵</CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setBinaryMode((value) => !value)}
                  >
                    {binaryMode ? "改用混淆矩阵" : "改用二分类计数"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="px-4">
                {binaryMode ? (
                  <BinaryInput value={binary} onChange={setBinary} />
                ) : (
                  <MatrixInput value={matrix} onChange={setMatrix} />
                )}
                {!validation.ok ? (
                  <div
                    role="alert"
                    className="mt-3 space-y-1 rounded-md border border-destructive/40 px-3 py-2"
                  >
                    {validation.errors.map((error) => (
                      <p key={error} className="text-xs text-destructive">
                        {error}
                      </p>
                    ))}
                    <p className="text-[11px] text-destructive">
                      输入不合法，已停止计算：请修正后再看指标。
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="segmentation" className="mt-3">
            <Card className="gap-3 rounded-md border-border py-4 shadow-none">
              <CardHeader className="px-4">
                <CardTitle className="heading-cn text-sm">各类别的交集与面积</CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                <SegmentationInput value={segments} onChange={setSegments} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ranking" className="mt-3">
            <Card className="gap-3 rounded-md border-border py-4 shadow-none">
              <CardHeader className="px-4">
                <CardTitle className="heading-cn text-sm">相关性等级</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4">
                <Textarea
                  value={rankingText}
                  onChange={(event) => setRankingText(event.target.value)}
                  rows={6}
                  className="font-mono text-xs"
                  aria-label="相关性等级列表"
                />
                <p className="text-xs text-muted-foreground">
                  每行一个结果的相关性等级：0 = 不相关，1 = 相关，2 / 3 = 高度相关（越高越好）。
                </p>
                <div className="flex items-center gap-3">
                  <label htmlFor="k" className="text-xs text-muted-foreground">
                    截断位置 k
                  </label>
                  <Input
                    id="k"
                    type="number"
                    min={1}
                    max={20}
                    value={rankingK}
                    onChange={(event) => setRankingK(Math.max(1, Number(event.target.value) || 1))}
                    className="h-8 w-20"
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="regression" className="mt-3">
            <Card className="gap-3 rounded-md border-border py-4 shadow-none">
              <CardHeader className="px-4">
                <CardTitle className="heading-cn text-sm">真值与预测</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 px-4 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  真值 y
                  <Input
                    value={trueText}
                    onChange={(event) => setTrueText(event.target.value)}
                    className="h-9 font-mono text-xs"
                  />
                </label>
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  预测 ŷ
                  <Input
                    value={predText}
                    onChange={(event) => setPredText(event.target.value)}
                    className="h-9 font-mono text-xs"
                  />
                </label>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="heading-cn text-sm">第二步：这些数能算出什么</h2>
          <p className="text-xs text-muted-foreground">
            每个指标都标注了口径与公式；带提示的指标说明它在什么情况下会被误读。
          </p>
        </div>
        {validation.ok ? (
          <MetricTable results={results} />
        ) : (
          <div
            role="alert"
            className="space-y-1 rounded-lg border border-destructive/40 px-4 py-6"
          >
            <p className="text-xs font-medium text-destructive">
              输入不合法，未计算任何指标。
            </p>
            {validation.errors.map((error) => (
              <p key={error} className="text-xs text-destructive">
                {error}
              </p>
            ))}
          </div>
        )}
      </section>

      <Separator />

      <AlignmentTool
        results={results}
        taskLabel={TASK_LABEL[task]}
        onApplyToPlan={onApplyToPlan}
      />

      <Separator />

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="heading-cn text-sm">换不了的口径，明确说换不了</h2>
          <p className="text-xs text-muted-foreground">
            下面这些是文献里最常被直接对比、但实际上无法互相换算的口径对。给出原因比给一个假数字有用。
          </p>
        </div>
        <IncompatibleTable />
      </section>

      <SelfCheckPanel />
    </div>
  );
}

/**
 * 计数输入解析：保留用户键入的负数与小数，交给 validateConfusionMatrix 判定。
 * 这里不做 Math.max(0, …) 之类的静默截断——那会把非法输入伪装成合法计数。
 */
function parseCount(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function MatrixInput({
  value,
  onChange,
}: {
  value: ConfusionMatrix;
  onChange: (next: ConfusionMatrix) => void;
}) {
  const size = value.labels.length;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        行 = 真实类别，列 = 预测类别，对角线是预测正确的数量。
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                真实 ＼ 预测
              </th>
              {value.labels.map((label) => (
                <th key={label} className="px-2 py-1 text-center font-medium text-muted-foreground">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.m.map((row, i) => (
              <tr key={value.labels[i]}>
                <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                  {value.labels[i]}
                </th>
                {row.map((cell, j) => (
                  <td key={j} className="px-1 py-1">
                    <Input
                      type="number"
                      min={0}
                      value={cell}
                      aria-label={`${value.labels[i]} 真实、${value.labels[j]} 预测`}
                      onChange={(event) => {
                        const next = value.m.map((line) => [...line]);
                        next[i][j] = parseCount(event.target.value);
                        onChange({ ...value, m: next });
                      }}
                      className="h-8 w-16 text-center tabular-nums"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={size >= 6}
        onClick={() => {
          const nextSize = size + 1;
          const labels = Array.from({ length: nextSize }, (_, i) =>
            i < size ? value.labels[i] : `类别 ${String.fromCharCode(65 + i)}`,
          );
          onChange({
            labels,
            m: Array.from({ length: nextSize }, (_, i) =>
              Array.from({ length: nextSize }, (_, j) =>
                i < size && j < size ? value.m[i][j] : 0,
              ),
            ),
          });
        }}
      >
        增加一个类别
      </Button>
    </div>
  );
}

function BinaryInput({
  value,
  onChange,
}: {
  value: { tp: number; fp: number; fn: number; tn: number };
  onChange: (next: { tp: number; fp: number; fn: number; tn: number }) => void;
}) {
  const fields: { key: keyof typeof value; label: string }[] = [
    { key: "tp", label: "TP 真正例" },
    { key: "fp", label: "FP 假正例" },
    { key: "fn", label: "FN 假负例" },
    { key: "tn", label: "TN 真负例" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {fields.map((field) => (
        <label key={field.key} className="space-y-1.5 text-xs text-muted-foreground">
          {field.label}
          <Input
            type="number"
            min={0}
            value={value[field.key]}
            onChange={(event) =>
              onChange({ ...value, [field.key]: parseCount(event.target.value) })
            }
            className="h-9 tabular-nums"
          />
        </label>
      ))}
    </div>
  );
}

function SegmentationInput({
  value,
  onChange,
}: {
  value: SegmentationClass[];
  onChange: (next: SegmentationClass[]) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        交集 = 预测区域与真实区域的重叠像素数；两者面积用来还原并集。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1 font-medium">类别</th>
              <th className="px-2 py-1 font-medium">交集</th>
              <th className="px-2 py-1 font-medium">预测面积</th>
              <th className="px-2 py-1 font-medium">真实面积</th>
            </tr>
          </thead>
          <tbody>
            {value.map((item, index) => (
              <tr key={index}>
                <td className="px-2 py-1">
                  <Input
                    value={item.label}
                    aria-label="类别名称"
                    onChange={(event) => {
                      const next = [...value];
                      next[index] = { ...item, label: event.target.value };
                      onChange(next);
                    }}
                    className="h-8 w-28"
                  />
                </td>
                {(["intersection", "predArea", "gtArea"] as const).map((key) => (
                  <td key={key} className="px-1 py-1">
                    <Input
                      type="number"
                      min={0}
                      value={item[key]}
                      aria-label={key}
                      onChange={(event) => {
                        const nextValue = Math.max(0, Number(event.target.value) || 0);
                        const nextItem = withSegmentationUnion({ ...item, [key]: nextValue });
                        const next = [...value];
                        next[index] = nextItem;
                        onChange(next);
                      }}
                      className="h-8 w-24 tabular-nums"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([
            ...value,
            { label: `类别 ${value.length + 1}`, intersection: 0, union: 0, predArea: 0, gtArea: 0 },
          ])
        }
      >
        增加一个类别
      </Button>
    </div>
  );
}

function MetricTable({ results }: { results: MetricResult[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-44">指标</TableHead>
            <TableHead className="w-28">数值</TableHead>
            <TableHead>口径与公式</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="align-top font-medium">{item.name}</TableCell>
              <TableCell className="align-top tabular-nums">
                {item.value === null ? "—" : metricValue(item.value)}
              </TableCell>
              <TableCell className="align-top text-xs leading-relaxed text-muted-foreground">
                <div>{item.note}</div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                  {item.formula}
                </div>
                {item.trap ? (
                  <div className="mt-2 rounded border border-dashed border-border px-2 py-1.5 text-[11px] text-foreground">
                    {item.trap}
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface AlignmentCase {
  from: string;
  to: string;
  needs?: { key: string; label: string }[];
  compute?: (values: Record<string, number>) => number | null;
  reason?: string;
}

const ALIGNMENT_CASES: AlignmentCase[] = [
  {
    from: "precision",
    to: "f1",
    needs: [{ key: "recall", label: "Recall" }],
    compute: (v) => f1FromPrecisionRecall(v.precision, v.recall),
  },
  {
    from: "recall",
    to: "f1",
    needs: [{ key: "precision", label: "Precision" }],
    compute: (v) => f1FromPrecisionRecall(v.precision, v.recall),
  },
  {
    from: "f1",
    to: "precision",
    needs: [{ key: "recall", label: "Recall" }],
    compute: (v) => (2 * v.recall - v.f1 === 0 ? null : (v.f1 * v.recall) / (2 * v.recall - v.f1)),
  },
  {
    from: "f1",
    to: "recall",
    needs: [{ key: "precision", label: "Precision" }],
    compute: (v) => (2 * v.precision - v.f1 === 0 ? null : (v.f1 * v.precision) / (2 * v.precision - v.f1)),
  },
  {
    from: "iou",
    to: "dice",
    compute: (v) => diceFromIou(v.iou),
  },
  {
    from: "dice",
    to: "iou",
    compute: (v) => iouFromDice(v.dice),
  },
];

const ALIGNMENT_OPTIONS = [
  { id: "precision", label: "Precision" },
  { id: "recall", label: "Recall" },
  { id: "f1", label: "F1" },
  { id: "iou", label: "IoU（单类别）" },
  { id: "dice", label: "Dice（单类别）" },
  { id: "miou", label: "mIoU" },
  { id: "mdice", label: "mDice" },
  { id: "accuracy", label: "Accuracy" },
  { id: "balanced_accuracy", label: "Balanced Accuracy" },
  { id: "macro_f1", label: "Macro-F1" },
  { id: "micro_f1", label: "Micro-F1" },
  { id: "mcc", label: "MCC" },
  { id: "cohen_kappa", label: "Cohen's Kappa" },
  { id: "mae", label: "MAE" },
  { id: "rmse", label: "RMSE" },
  { id: "r2", label: "R²" },
  { id: "mape", label: "MAPE" },
  { id: "smape", label: "SMAPE" },
];

function labelOf(id: string): string {
  return ALIGNMENT_OPTIONS.find((option) => option.id === id)?.label ?? METRIC_BY_ID.get(id)?.name ?? id;
}

function AlignmentTool({
  results,
  taskLabel,
  onApplyToPlan,
}: {
  results: MetricResult[];
  taskLabel: string;
  onApplyToPlan?: (text: string) => void;
}) {
  const [from, setFrom] = useState("miou");
  const [to, setTo] = useState("mdice");
  const [values, setValues] = useState<Record<string, string>>({ miou: "0.72", mdice: "" });

  const active = ALIGNMENT_CASES.find((item) => item.from === from && item.to === to);
  const incompatible = INCOMPATIBLE.find((item) => item.from === from && item.to === to);
  const reverseIncompatible = INCOMPATIBLE.find((item) => item.from === to && item.to === from);

  const reason =
    incompatible?.reason ??
    reverseIncompatible?.reason ??
    (!active
      ? `「${labelOf(from)}」与「${labelOf(to)}」之间没有已知的换算关系——两者统计的对象并不相同，直接互换得到的数字没有意义。`
      : null);

  const extraValues = active?.needs ?? [];

  const outcome = useMemo(() => {
    if (!active?.compute) return null;
    const parsed: Record<string, number> = {};
    const sourceValue = Number(values[from]);
    if (!Number.isFinite(sourceValue)) return null;
    parsed[from] = sourceValue;
    for (const field of extraValues) {
      const value = Number(values[field.key]);
      if (!Number.isFinite(value)) return null;
      parsed[field.key] = value;
    }
    const result = active.compute(parsed);
    return result === null
      ? { ok: false as const, error: "分母为 0，此时该口径无唯一解。" }
      : { ok: true as const, value: result };
  }, [active, values, from, extraValues]);

  const snapshot: AlignSnapshot = {
    taskLabel,
    results,
    from,
    to,
    values,
    extraValues,
    formula: active ? formulaOf(active) : "",
    outcome,
    reason: reason ?? null,
  };

  // 有任一非空指标值，或换算给出了明确结论（成功 / 无解 / 换不了），才允许导出与带入。
  const hasMetricValues = results.some((item) => item.value !== null);
  const hasConclusion = outcome !== null || snapshot.reason !== null;
  const canExport = hasMetricValues || hasConclusion;

  const stamp = new Date().toISOString().slice(0, 10);

  const exportMarkdown = () => {
    if (!canExport) return;
    downloadText(`topicscope-align-${stamp}.md`, alignToMarkdown(snapshot), "text/markdown");
  };

  const exportCsv = () => {
    if (!canExport) return;
    downloadText(`topicscope-align-${stamp}.csv`, alignToCsv(snapshot), "text/csv");
  };

  const applyToPlan = () => {
    if (!canExport || !onApplyToPlan) return;
    onApplyToPlan(alignToPlanText(snapshot));
  };

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="heading-cn text-sm">第三步：能不能换算</h2>
        <p className="text-xs text-muted-foreground">
          假设论文只给了你一个数字。选择「我手上有的」和「我想要的」，工具会告诉你需要补什么，或者为什么换不了。
        </p>
      </div>

      <Card className="gap-3 rounded-md border-border py-4 shadow-none">
        <CardContent className="space-y-4 px-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-muted-foreground">
              我手上只有
              <NativeSelect
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setValues((prev) => ({ ...prev, [event.target.value]: "" }));
                }}
                className="w-full"
              >
                {ALIGNMENT_OPTIONS.map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>

            <label className="space-y-1.5 text-xs text-muted-foreground">
              我想换算成
              <NativeSelect
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="w-full"
              >
                {ALIGNMENT_OPTIONS.map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs text-muted-foreground">
              {labelOf(from)} 的值
              <Input
                type="number"
                step="any"
                value={values[from] ?? ""}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [from]: event.target.value }))
                }
                className="h-9 tabular-nums"
              />
            </label>
            {extraValues.map((field) => (
              <label key={field.key} className="space-y-1.5 text-xs text-muted-foreground">
                还需要 {field.label}
                <Input
                  type="number"
                  step="any"
                  value={values[field.key] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                  }
                  className="h-9 tabular-nums"
                />
              </label>
            ))}
          </div>

          {active ? (
            <div className="rounded-md border border-border bg-muted px-3 py-2.5 text-xs">
              <div className="font-medium">换算公式：{formulaOf(active)}</div>
              {outcome && outcome.ok ? (
                <div className="mt-2 text-sm">
                  {labelOf(to)} = <span className="font-medium tabular-nums">{metricValue(outcome.value)}</span>
                </div>
              ) : outcome && !outcome.ok ? (
                <div className="mt-2 text-destructive">{outcome.error}</div>
              ) : (
                <div className="mt-2 text-muted-foreground">补齐上面的输入后给出结果。</div>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs">
              <div className="flex items-center gap-2">
                <Badge variant="outline">换不了</Badge>
                <span className="text-muted-foreground">{reason}</span>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="label-caps mr-1">导出与复用</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!canExport}
              onClick={exportMarkdown}
            >
              导出 Markdown
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canExport}
              onClick={exportCsv}
            >
              导出 CSV
            </Button>
            {onApplyToPlan ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canExport}
                onClick={applyToPlan}
              >
                带入研究方案
              </Button>
            ) : null}
            {!canExport ? (
              <span className="text-xs text-muted-foreground">
                补齐输入或算出指标后，才能导出 / 带入。
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function formulaOf(item: AlignmentCase): string {
  switch (`${item.from}->${item.to}`) {
    case "precision->f1":
    case "recall->f1":
      return "F1 = 2PR / (P + R)";
    case "f1->precision":
      return "P = F1·R / (2R − F1)";
    case "f1->recall":
      return "R = F1·P / (2P − F1)";
    case "iou->dice":
      return "Dice = 2·IoU / (1 + IoU)";
    case "dice->iou":
      return "IoU = Dice / (2 − Dice)";
    default:
      return "";
  }
}

/** 导出 / 带入共用的当前对齐快照。 */
interface AlignSnapshot {
  taskLabel: string;
  results: MetricResult[];
  from: string;
  to: string;
  values: Record<string, string>;
  extraValues: { key: string; label: string }[];
  formula: string;
  outcome: { ok: true; value: number } | { ok: false; error: string } | null;
  reason: string | null;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function conversionInputs(s: AlignSnapshot): string[] {
  const bits = [`${labelOf(s.from)} = ${s.values[s.from] || "—"}`];
  for (const field of s.extraValues) {
    const raw = s.values[field.key];
    if (raw !== undefined && raw !== "") bits.push(`${field.label} = ${raw}`);
  }
  return bits;
}

function alignToMarkdown(s: AlignSnapshot): string {
  const lines: string[] = ["# 指标口径对齐", ""];
  lines.push(`- 任务类型：${s.taskLabel}`);
  lines.push(`- 导出时间：${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  lines.push("");

  lines.push("## 当前数据可算出的指标", "");
  lines.push("| 指标 | 数值 | 口径与公式 |");
  lines.push("|---|---|---|");
  for (const item of s.results) {
    const cell = mdCell(`${item.note}（${item.formula}）`);
    lines.push(
      `| ${mdCell(item.name)} | ${item.value === null ? "—" : metricValue(item.value)} | ${cell} |`,
    );
  }
  lines.push("");

  lines.push("## 口径换算结论", "");
  lines.push(`- 换算前口径：${labelOf(s.from)}`);
  lines.push(`- 换算后口径：${labelOf(s.to)}`);
  for (const bit of conversionInputs(s)) lines.push(`- 已知 / 补充输入：${bit}`);
  if (s.formula) lines.push(`- 换算公式：${s.formula}`);
  if (s.outcome?.ok) {
    lines.push(`- 换算结果：${labelOf(s.to)} = ${metricValue(s.outcome.value)}`);
  } else if (s.outcome && !s.outcome.ok) {
    lines.push(`- 换算结果：无法求解 — ${s.outcome.error}`);
  } else if (s.reason) {
    lines.push(`- 换算结果：换不了 — ${s.reason}`);
  } else {
    lines.push("- 换算结果：输入尚未补齐，暂无结论。");
  }
  lines.push("");

  const caveats: string[] = [];
  for (const item of s.results) {
    if (item.trap) caveats.push(`${item.name}：${item.trap}`);
  }
  if (s.outcome && !s.outcome.ok) caveats.push(s.outcome.error);
  if (s.reason) caveats.push(s.reason);
  caveats.push(
    "换算只在口径定义一致时成立；跨数据集、跨平均方式（macro / micro）或不同正类定义的数字不可直接互换。",
  );
  lines.push("## 注意事项与局限", "");
  for (const caveat of caveats) lines.push(`- ${caveat}`);
  lines.push("");

  return lines.join("\n");
}

function alignToCsv(s: AlignSnapshot): string {
  const header = ["指标", "数值", "口径说明", "公式", "注意事项"];
  const rows: string[] = [header.map(csvCell).join(",")];

  for (const item of s.results) {
    rows.push(
      [
        item.name,
        item.value === null ? "" : metricValue(item.value),
        item.note,
        item.formula,
        item.trap ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  const convValue = s.outcome?.ok ? metricValue(s.outcome.value) : "";
  const convNote = s.outcome?.ok
    ? `由 ${conversionInputs(s).join("、")} 换算得到`
    : s.outcome && !s.outcome.ok
      ? s.outcome.error
      : (s.reason ?? "输入尚未补齐，暂无结论");
  const convTrap = s.outcome?.ok
    ? "换算仅在口径定义一致时成立"
    : (s.reason ?? (s.outcome && !s.outcome.ok ? s.outcome.error : ""));
  rows.push(
    [
      `换算：${labelOf(s.from)} → ${labelOf(s.to)}`,
      convValue,
      convNote,
      s.formula,
      convTrap,
    ]
      .map(csvCell)
      .join(","),
  );

  return rows.join("\n");
}

function alignToPlanText(s: AlignSnapshot): string {
  const fromLabel = labelOf(s.from);
  const toLabel = labelOf(s.to);
  if (s.outcome?.ok) {
    return (
      `指标口径：${toLabel} 由 ${conversionInputs(s).join("、")} 按「${s.formula}」换算为 ` +
      `${metricValue(s.outcome.value)}；注意仅在口径定义一致时成立，方案统一按此口径报告。`
    );
  }
  if (s.outcome && !s.outcome.ok) {
    return `指标口径：${fromLabel} 无法唯一换算为 ${toLabel}（${s.outcome.error}）；注意需补充原始数据后再定口径，不要直接引用换算值。`;
  }
  if (s.reason) {
    return `指标口径：${fromLabel} 与 ${toLabel} 不可直接换算；注意${s.reason}`;
  }
  const lead = s.results.find((item) => item.value !== null);
  if (lead) {
    return `指标口径：当前按${s.taskLabel}任务口径计算，${lead.name} = ${metricValue(lead.value)}（${lead.formula}）；注意沿用该口径，勿与不同定义的文献数字直接对比。`;
  }
  return "指标口径：当前暂无可换算或已算出的指标，请先补齐数据。";
}

function IncompatibleTable() {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-56">被误当成能互换的口径对</TableHead>
            <TableHead>为什么换不了</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {INCOMPATIBLE.map((pair) => (
            <TableRow key={`${pair.from}-${pair.to}`}>
              <TableCell className="align-top text-xs font-medium">
                {labelOf(pair.from)} ↔ {labelOf(pair.to)}
              </TableCell>
              <TableCell className="align-top text-xs leading-relaxed text-muted-foreground">
                {pair.reason}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
