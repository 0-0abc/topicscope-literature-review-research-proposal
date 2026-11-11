import type { Paper, PaperProvenance } from "./types";
import { normalizeDoi, normalizeTitle } from "./doi";

/**
 * 跨源去重：按 DOI → 来源唯一 ID → 归一化标题的顺序判定同一篇论文。
 * 返回保留后的论文和被去掉的论文数，导出与统计都用去重后的集合。
 */
export function dedupPapers(papers: Paper[]): { papers: Paper[]; removed: number } {
  const byDoi = new Set<string>();
  const bySourceId = new Set<string>();
  const byTitle = new Set<string>();
  const kept: Paper[] = [];
  let removed = 0;

  for (const paper of papers) {
    const doi = paper.provenance.dedupKey.startsWith("doi:")
      ? paper.provenance.dedupKey.slice(4)
      : null;
    const sourceIdKey = `id:${paper.provenance.source}:${paper.provenance.sourceId}`;
    const titleKey = `t:${normalizeTitle(paper.title)}`;

    const duplicate =
      (doi !== null && byDoi.has(doi)) ||
      bySourceId.has(sourceIdKey) ||
      (titleKey !== "t:" && byTitle.has(titleKey));

    if (duplicate) {
      removed += 1;
      continue;
    }
    if (doi !== null) byDoi.add(doi);
    bySourceId.add(sourceIdKey);
    if (titleKey !== "t:") byTitle.add(titleKey);
    kept.push(paper);
  }

  return { papers: kept, removed };
}

/** 为快照论文补齐 provenance（离线快照没有逐篇检索记录，用快照级信息填充）。 */
export function withSnapshotProvenance(
  papers: Paper[],
  meta: { domain: string; generatedAt: string; filters: string },
): Paper[] {
  return papers.map((paper) => {
    const doi = normalizeDoi(paper.doi);
    const sourceId = paper.id.replace(/^https?:\/\/openalex\.org\//, "");
    const provenance: PaperProvenance = {
      source: "snapshot",
      sourceId,
      retrievedAt: meta.generatedAt,
      query: meta.domain,
      filter: meta.filters,
      dedupKey: doi ? `doi:${doi}` : `id:snapshot:${sourceId}`,
      abstractAvailable: Boolean(paper.abstract),
      oaUrl: paper.oaUrl ?? null,
    };
    return { ...paper, doi, provenance };
  });
}
