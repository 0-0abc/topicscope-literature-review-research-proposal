export interface RegressionMetrics {
  mae: number | null;
  mse: number | null;
  rmse: number | null;
  r2: number | null;
  mape: number | null;
  smape: number | null;
  count: number;
}

/** 回归指标。MAPE 会跳过真值为 0 的样本（相对误差无定义）。 */
export function regressionMetrics(yTrue: number[], yPred: number[]): RegressionMetrics {
  const n = Math.min(yTrue.length, yPred.length);
  if (n === 0) {
    return { mae: null, mse: null, rmse: null, r2: null, mape: null, smape: null, count: 0 };
  }
  let absSum = 0;
  let squaredSum = 0;
  let absPercentSum = 0;
  let percentCount = 0;
  let symmetricSum = 0;
  let meanTrue = 0;
  for (let i = 0; i < n; i++) {
    const error = yPred[i] - yTrue[i];
    absSum += Math.abs(error);
    squaredSum += error * error;
    if (yTrue[i] !== 0) {
      absPercentSum += Math.abs(error / yTrue[i]);
      percentCount++;
    }
    const denominator = (Math.abs(yTrue[i]) + Math.abs(yPred[i])) / 2;
    if (denominator !== 0) symmetricSum += (Math.abs(error) / denominator) * 100;
    meanTrue += yTrue[i];
  }
  meanTrue /= n;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (yPred[i] - yTrue[i]) ** 2;
    ssTot += (yTrue[i] - meanTrue) ** 2;
  }

  const mse = squaredSum / n;
  return {
    mae: absSum / n,
    mse,
    rmse: Math.sqrt(mse),
    r2: ssTot === 0 ? null : 1 - ssRes / ssTot,
    mape: percentCount === 0 ? null : (absPercentSum / percentCount) * 100,
    smape: symmetricSum / n,
    count: n,
  };
}
