import type { Paper } from "../data/types";
import { buildDocument, type WeightedDocument } from "./tokenize";

/** 一篇论文参与分析的各个来源及其权重。标题与关键词最能代表主题，摘要权重最低。 */
export function paperSources(paper: Paper): { text: string; weight: number }[] {
  return [
    { text: paper.title, weight: 3 },
    { text: paper.keywords.join(" "), weight: 3 },
    { text: paper.topics.join(" "), weight: 2 },
    { text: paper.abstract ?? "", weight: 1 },
  ];
}

export function buildCorpus(papers: Paper[]): WeightedDocument[] {
  return papers.map((paper) => buildDocument(paperSources(paper)));
}
