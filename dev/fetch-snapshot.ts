import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 抓取 OpenAlex 真实论文，生成离线快照。
 * 运行：OPENALEX_API_KEY=xxx node_modules/.bin/jiti dev/fetch-snapshot.ts
 *
 * 快照只包含公开书目信息与摘要，不包含任何 API key。
 */

const API = "https://api.openalex.org/works";
const KEY = process.env.OPENALEX_API_KEY ?? "";
const OUT = resolve(process.cwd(), "public/data/snapshot-medical-segmentation.json");

interface RawWork {
  id: string;
  doi: string | null;
  title: string | null;
  publication_year: number | null;
  cited_by_count: number;
  type: string | null;
  topics: { display_name: string; score?: number }[] | null;
  keywords: { display_name: string }[] | null;
  primary_location: { source: { display_name: string } | null } | null;
  abstract_inverted_index: Record<string, number[]> | null;
  authorships: { author: { display_name: string } }[] | null;
  open_access: { oa_url: string | null; is_oa: boolean } | null;
  best_oa_location: { landing_page_url: string | null; pdf_url: string | null } | null;
}

const SELECT = [
  "id",
  "doi",
  "title",
  "publication_year",
  "cited_by_count",
  "type",
  "topics",
  "keywords",
  "primary_location",
  "abstract_inverted_index",
  "authorships",
  "open_access",
  "best_oa_location",
].join(",");

function rebuildAbstract(index: Record<string, number[]> | null): string | null {
  if (!index) return null;
  const slots: string[] = [];
  for (const [token, positions] of Object.entries(index)) {
    for (const position of positions) slots[position] = token;
  }
  const text = slots.filter(Boolean).join(" ").trim();
  return text.length > 0 ? text : null;
}

async function fetchPage(params: Record<string, string>): Promise<{
  results: RawWork[];
  nextCursor: string;
}> {
  const url = new URL(API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("select", SELECT);
  if (KEY) url.searchParams.set("api_key", KEY);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`OpenAlex 返回 ${response.status}：${await response.text()}`);
  }
  const body = (await response.json()) as {
    results: RawWork[];
    meta: { next_cursor?: string };
  };
  return { results: body.results, nextCursor: body.meta.next_cursor ?? "" };
}

async function collect(params: Record<string, string>, limit: number): Promise<RawWork[]> {
  const collected: RawWork[] = [];
  let cursor = "*";
  while (collected.length < limit) {
    const { results, nextCursor } = await fetchPage({
      ...params,
      cursor,
      "per-page": "200",
    });
    if (results.length === 0) break;
    collected.push(...results);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return collected.slice(0, limit);
}

const BASE_FILTER = {
  "filter": [
    "title_and_abstract.search:medical image segmentation",
    "from_publication_date:2018-01-01",
    "to_publication_date:2026-11-06",
    "type:article|preprint|conference-paper",
  ].join(","),
};

async function main() {
  const FIRST_YEAR = 2018;
  const LAST_YEAR = 2026;
  const PER_YEAR = 60;

  const byId = new Map<string, RawWork>();
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    console.log(`抓取 ${year} 年…`);
    const works = await collect(
      {
        ...BASE_FILTER,
        filter: [
          "title_and_abstract.search:medical image segmentation",
          `from_publication_date:${year}-01-01`,
          `to_publication_date:${year}-12-31`,
          "type:article|preprint|conference-paper",
        ].join(","),
        sort: "cited_by_count:desc",
      },
      PER_YEAR,
    );
    for (const work of works) {
      if (!work.title || !work.publication_year) continue;
      byId.set(work.id, work);
    }
  }

  const papers = [...byId.values()]
    .map((work) => ({
      id: work.id,
      doi: work.doi,
      title: work.title,
      year: work.publication_year,
      citedByCount: work.cited_by_count,
      type: work.type,
      topics: (work.topics ?? []).map((t) => t.display_name).slice(0, 5),
      keywords: (work.keywords ?? []).map((k) => k.display_name).slice(0, 8),
      venue: work.primary_location?.source?.display_name ?? null,
      abstract: rebuildAbstract(work.abstract_inverted_index),
      authors: (work.authorships ?? []).slice(0, 6).map((a) => a.author.display_name),
      authorCount: (work.authorships ?? []).length,
      oaUrl:
        work.best_oa_location?.pdf_url ??
        work.best_oa_location?.landing_page_url ??
        work.open_access?.oa_url ??
        null,
    }))
    .sort((a, b) => b.year - a.year || b.citedByCount - a.citedByCount);

  const snapshot = {
    domain: "medical image segmentation",
    domainLabel: "医学影像分割",
    generatedAt: new Date().toISOString(),
    source: "OpenAlex",
    sourceNote: "书目数据来自 OpenAlex 开放接口，标题与摘要版权归原作者所有。",
    filters: "2018-01-01 至 2026-11-06，检索式 title_and_abstract.search:medical image segmentation",
    papers,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 1), "utf8");
  console.log(`已写入 ${OUT}，共 ${papers.length} 篇。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
