import { cosineSimilarity, type SparseVector } from "./tfidf";

/** 固定种子的伪随机数发生器，保证同一批文献每次聚类结果一致。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KMeansResult {
  assignments: number[];
  centroids: SparseVector[];
  /** 每个文档到其所属质心的余弦相似度 */
  similarity: number[];
}

function normalizeVector(vector: SparseVector): SparseVector {
  let norm = 0;
  for (const weight of vector.weights.values()) norm += weight * weight;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  const weights = new Map<number, number>();
  for (const [index, weight] of vector.weights) weights.set(index, weight / norm);
  return { weights };
}

/**
 * 球面 k-means：向量已 L2 归一化，余弦相似度等价于夹角，
 * 因此质心只需取成员向量的归一化均值，无需迭代更新半径。
 */
export function kmeans(
  vectors: SparseVector[],
  k: number,
  options: { iterations?: number; seed?: number } = {},
): KMeansResult {
  const iterations = options.iterations ?? 60;
  const random = mulberry32(options.seed ?? 20261106);
  const n = vectors.length;
  if (n === 0) return { assignments: [], centroids: [], similarity: [] };

  const clusterCount = Math.max(1, Math.min(k, n));

  // k-means++ 初始化：以余弦距离衡量「离已有质心最远」
  const centroids: SparseVector[] = [];
  const firstIndex = Math.floor(random() * n);
  centroids.push(vectors[firstIndex]);
  while (centroids.length < clusterCount) {
    let bestIndex = -1;
    let bestDistance = -1;
    for (let i = 0; i < n; i++) {
      let nearest = -Infinity;
      for (const centroid of centroids) {
        nearest = Math.max(nearest, cosineSimilarity(vectors[i], centroid));
      }
      const distance = 1 - nearest;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    centroids.push(vectors[bestIndex]);
  }

  const assignments = new Array<number>(n).fill(0);
  const similarity = new Array<number>(n).fill(0);

  for (let iteration = 0; iteration < iterations; iteration++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bestCluster = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const score = cosineSimilarity(vectors[i], centroids[c]);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) changed = true;
      assignments[i] = bestCluster;
      similarity[i] = bestScore;
    }

    const sums: Map<number, number>[] = centroids.map(() => new Map());
    const sizes = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const cluster = assignments[i];
      sizes[cluster] += 1;
      const target = sums[cluster];
      for (const [index, weight] of vectors[i].weights) {
        target.set(index, (target.get(index) ?? 0) + weight);
      }
    }

    for (let c = 0; c < centroids.length; c++) {
      if (sizes[c] === 0) {
        // 空簇：取离当前质心最远的文档作为新质心
        let worst = 0;
        let worstScore = Infinity;
        for (let i = 0; i < n; i++) {
          if (similarity[i] < worstScore) {
            worstScore = similarity[i];
            worst = i;
          }
        }
        centroids[c] = vectors[worst];
        continue;
      }
      centroids[c] = normalizeVector({ weights: sums[c] });
    }

    if (!changed && iteration > 0) break;
  }

  return { assignments, centroids, similarity };
}

/** 依据语料规模自适应地选择聚类数，保证聚类既不碎片化也不过粗。 */
export function suggestClusterCount(size: number): number {
  if (size < 12) return Math.max(1, Math.min(3, size));
  return Math.max(3, Math.min(8, Math.round(Math.sqrt(size / 15))));
}
