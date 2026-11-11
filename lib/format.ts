export function percent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/** 指标数值统一展示：比例类保留两位小数，比率类按原值。 */
export function metricValue(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits).replace(/\.?0+$/, (match) => (match.includes(".") ? "" : match));
}

export function signedPercent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}
