import type { Paper } from "./types";
import { normalizeDoi } from "./doi";

const CROSSREF_API = "https://api.crossref.org/works";

/** Crossref 的 polite pool 同样需要一个可联系的邮箱。 */
const CROSSREF_CONTACT = "131755982+0-0abc@users.noreply.github.com";

interface CrossrefWork {
  DOI: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  "is-referenced-by-count"?: number;
  abstract?: string;
  type?: string;
  URL?: string;
  /** Crossref 登记的全文链接；只有 PDF 全文链接才能算开放获取 */
  link?: {
    URL?: string;
    "content-type"?: string;
    "intended-application"?: string;
  }[];
}

/** 只取需要的字段，避免请求整条记录（整条记录含 JATS 摘要时体积会大一个数量级）。 */
const SELECT = [
  "DOI",
  "title",
  "issued",
  "is-referenced-by-count",
  "container-title",
  "type",
  "URL",
  "abstract",
  "author",
  "link",
].join(",");

/** Crossref 的摘要是 JATS XML，抽取纯文本即可。 */
function stripJats(abstract: string | undefined): string | null {
  if (!abstract) return null;
  const text = abstract.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/**
 * 从 Crossref 的 link 数组里找「已验证的开放全文链接」：
 * content-type 为 application/pdf，或 intended-application 为
 * text-mining/unspecified 且 content-type 是 PDF。
 * 普通 DOI 落地页（work.URL）是出版商页面，可能付费墙，不算 OA。
 */
function findVerifiedOaUrl(work: CrossrefWork): string | null {
  for (const link of work.link ?? []) {
    if (!link.URL) continue;
    const contentType = (link["content-type"] ?? "").toLowerCase();
    const application = (link["intended-application"] ?? "").toLowerCase();
    if (contentType === "application/pdf") return link.URL;
    if (
      contentType.includes("pdf") &&
      (application === "text-mining" || application === "unspecified")
    ) {
      return link.URL;
    }
  }
  return null;
}

function toPaper(work: CrossrefWork, ctx: { query: string; filter: string; retrievedAt: string }): Paper {
  const parts = work.issued?.["date-parts"]?.[0];
  const year = parts?.[0] ?? new Date().getFullYear();
  const authors = (work.author ?? []).map((a) =>
    a.name ?? [a.given, a.family].filter(Boolean).join(" "),
  );
  const doi = normalizeDoi(work.DOI);
  const abstract = stripJats(work.abstract);
  // DOI 落地页一律进 publisherUrl；只有 link 里的 PDF 全文才算已验证 OA。
  const publisherUrl = work.URL ?? (doi ? `https://doi.org/${doi}` : null);
  const oaUrl = findVerifiedOaUrl(work);
  const oaStatus: Paper["oaStatus"] = oaUrl
    ? "verified"
    : publisherUrl
      ? "publisher_only"
      : "none";
  return {
    id: `crossref:${work.DOI}`,
    doi,
    title: work.title?.[0] ?? "(无标题)",
    year,
    citedByCount: work["is-referenced-by-count"] ?? 0,
    type: work.type ?? null,
    topics: [],
    keywords: [],
    venue: work["container-title"]?.[0] ?? null,
    abstract,
    authors: authors.slice(0, 6),
    authorCount: authors.length,
    oaUrl,
    publisherUrl,
    oaStatus,
    provenance: {
      source: "crossref",
      sourceId: work.DOI,
      retrievedAt: ctx.retrievedAt,
      query: ctx.query,
      filter: ctx.filter,
      dedupKey: doi ? `doi:${doi}` : `id:crossref:${work.DOI}`,
      abstractAvailable: Boolean(abstract),
      oaUrl,
    },
  };
}

export interface CrossrefQueryOptions {
  rows?: number;
  fromYear?: number;
  toYear?: number;
}

/**
 * Crossref 备选源：不需要 key，CORS 开放，没有额度上限。
 * 覆盖面比 OpenAlex 广，但没有主题/关键词标签，因此只能作为限流时的降级来源。
 * 注意：Crossref 的 sort=is-referenced-by-count 与 query.bibliographic 同时使用会慢到超时，
 * 这里按相关度取回后在本地按被引排序。
 */
export async function fetchCrossref(
  query: string,
  options: CrossrefQueryOptions = {},
): Promise<Paper[]> {
  const rows = options.rows ?? 100;
  const toYear = options.toYear ?? new Date().getFullYear();
  const fromYear = options.fromYear ?? toYear - 7;

  const url = new URL(CROSSREF_API);
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("select", SELECT);
  url.searchParams.set(
    "filter",
    `from-pub-date:${fromYear}-01-01,until-pub-date:${toYear}-12-31`,
  );
  url.searchParams.set("mailto", CROSSREF_CONTACT);

  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Crossref 返回 ${response.status}`);
  }
  const body = (await response.json()) as { message: { items: CrossrefWork[] } };
  const ctx = { query, filter: url.searchParams.get("filter") ?? "", retrievedAt: new Date().toISOString() };
  return body.message.items
    .filter((work) => work.title?.[0])
    .map((work) => toPaper(work, ctx))
    .sort((a, b) => b.citedByCount - a.citedByCount);
}
