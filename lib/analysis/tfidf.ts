import type { WeightedDocument } from "./tokenize";

export interface SparseVector {
  /** 词索引 → TF-IDF 权重（已 L2 归一化） */
  weights: Map<number, number>;
}

export interface TfIdfModel {
  vocabulary: string[];
  idf: Float64Array;
  vectors: SparseVector[];
  documentFrequency: Int32Array;
}

export function buildTfIdf(documents: WeightedDocument[]): TfIdfModel {
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const vocabulary = [...documentFrequency.keys()].sort();
  const termIndex = new Map(vocabulary.map((term, index) => [term, index]));
  const total = documents.length;

  const idf = new Float64Array(vocabulary.length);
  for (let i = 0; i < vocabulary.length; i++) {
    const df = documentFrequency.get(vocabulary[i]) ?? 0;
    idf[i] = Math.log((total + 1) / (df + 1)) + 1;
  }

  const dfCounts = new Int32Array(vocabulary.length);
  for (let i = 0; i < vocabulary.length; i++) {
    dfCounts[i] = documentFrequency.get(vocabulary[i]) ?? 0;
  }

  const vectors: SparseVector[] = documents.map((document) => {
    const weights = new Map<number, number>();
    let norm = 0;
    for (const [term, count] of document.counts) {
      const index = termIndex.get(term);
      if (index === undefined) continue;
      const weight = (1 + Math.log(count)) * idf[index];
      weights.set(index, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (const [index, weight] of weights) {
        weights.set(index, weight / norm);
      }
    }
    return { weights };
  });

  return { vocabulary, idf, vectors, documentFrequency: dfCounts };
}

export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [index, weight] of small.weights) {
    const other = large.weights.get(index);
    if (other !== undefined) sum += weight * other;
  }
  return sum;
}

/** 取向量中权重最高的 n 个词索引。 */
export function topTerms(vector: SparseVector, n: number): { index: number; weight: number }[] {
  return [...vector.weights.entries()]
    .map(([index, weight]) => ({ index, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n);
}
