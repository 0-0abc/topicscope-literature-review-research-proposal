import type { Paper } from "./types";
import { normalizeDoi } from "./doi";

const OPENALEX_API = "https://api.openalex.org/works";

/**
 * OpenAlex 的 polite pool 需要一个可联系的邮箱，请求会进入更宽松的队列。
 * 公开站点填写真实联系方式是 OpenAlex 官方推荐的做法。
 */
const OPENALEX_CONTACT = "209879754@qq.com";

interface OpenAlexWork {
  id: string;
  doi: string | null;
  title: string | null;
  publication_year: number | null;
  cited_by_count: number;
  type: string | null;
  topics: { display_name: string }[] | null;
  keywords: { display_name: string }[] | null;
  primary_location: {
    source: { display_name: string } | null;
    landing_page_url?: string | null;
  } | null;
  abstract_inverted_index: Record<string, number[]> | null;
  authorships: { author: { display_name: string } }[] | null;
  open_access: { oa_url: string | null } | null;
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

export type OpenAlexFailureKind = "rate" | "quota" | "auth" | "server" | "network";

/** 检索上下文：写入每篇论文的 provenance，保证结论能回查到来源与条件。 */
export interface ProvenanceContext {
  query: string;
  filter: string;
  retrievedAt: string;
}

export class OpenAlexError extends Error {
  constructor(
    message: string,
    readonly kind: OpenAlexFailureKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "OpenAlexError";
  }
}

function rebuildAbstract(index: Record<string, number[]> | null): string | null {
  if (!index) return null;
  const slots: string[] = [];
  for (const [token, positions] of Object.entries(index)) {
    for (const position of positions) slots[position] = token;
  }
  const text = slots.filter(Boolean).join(" ").trim();
  return text.length > 0 ? text : null;
}

function toPaper(work: OpenAlexWork, ctx: ProvenanceContext): Paper {
  const doi = normalizeDoi(work.doi);
  const sourceId = work.id.replace(/^https?:\/\/openalex\.org\//, "");
  // best_oa_location 与 open_access.oa_url 都是 OpenAlex 标注的 OA 位置，
  // 本身即开放获取，可视为已验证 OA 全文入口。
  const oaUrl =
    work.best_oa_location?.pdf_url ??
    work.best_oa_location?.landing_page_url ??
    work.open_access?.oa_url ??
    null;
  // 出版商落地页单独存放，不计入开放获取统计。
  const publisherUrl =
    work.primary_location?.landing_page_url ??
    (doi ? `https://doi.org/${doi}` : null);
  const oaStatus: Paper["oaStatus"] = oaUrl
    ? "verified"
    : publisherUrl
      ? "publisher_only"
      : "none";
  return {
    id: work.id,
    doi,
    title: work.title ?? "(无标题)",
    year: work.publication_year ?? new Date().getFullYear(),
    citedByCount: work.cited_by_count,
    type: work.type,
    topics: (work.topics ?? []).map((t) => t.display_name).slice(0, 5),
    keywords: (work.keywords ?? []).map((k) => k.display_name).slice(0, 8),
    venue: work.primary_location?.source?.display_name ?? null,
    abstract: rebuildAbstract(work.abstract_inverted_index),
    authors: (work.authorships ?? []).slice(0, 6).map((a) => a.author.display_name),
    authorCount: (work.authorships ?? []).length,
    oaUrl,
    publisherUrl,
    oaStatus,
    provenance: {
      source: "openalex",
      sourceId,
      retrievedAt: ctx.retrievedAt,
      query: ctx.query,
      filter: ctx.filter,
      dedupKey: doi ? `doi:${doi}` : `id:openalex:${sourceId}`,
      abstractAvailable: Boolean(work.abstract_inverted_index),
      oaUrl,
    },
  };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [1200, 3000, 7000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAlex 的限流有两条独立的线：
 * 1) 突发速率限制 → 短时间后自行恢复，值得重试；
 * 2) 每日额度（响应头 X-RateLimit-Remaining）→ 当天不会恢复，重试无意义。
 */
function describeFailure(response: Response, attempts: number): OpenAlexError {
  const status = response.status;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const limit = response.headers.get("x-ratelimit-limit");
  const quotaLeft = remaining !== null && Number(remaining) <= 0;

  if (status === 401 || status === 403) {
    return new OpenAlexError(
      "OpenAlex 拒绝了这次请求（" + status + "）：API key 无效或已被撤销，请在「设置」里检查或清空后重试。",
      "auth",
      status,
    );
  }
  if (status === 429 && quotaLeft) {
    return new OpenAlexError(
      "OpenAlex 今日额度已用完（429）。免费额度按 IP 计（" +
        (limit ?? "1000") +
        " 额度/天，一次检索消耗 2 次请求），同一网络下多人共用一个额度很容易被用尽；在「设置」里填自己的 API key 可把额度提高到 10 倍。",
      "quota",
      status,
    );
  }
  if (status === 429) {
    return new OpenAlexError(
      "OpenAlex 触发了限流（429），已自动重试 " + attempts + " 次仍未成功，稍后再试或在「设置」里填自己的 API key。",
      "rate",
      status,
    );
  }
  if (status >= 500) {
    return new OpenAlexError(
      "OpenAlex 服务暂时不可用（" + status + "），已自动重试 " + attempts + " 次。",
      "server",
      status,
    );
  }
  return new OpenAlexError("OpenAlex 返回 " + status, "server", status);
}

async function fetchWorks(
  params: Record<string, string>,
  apiKey: string | undefined,
): Promise<OpenAlexWork[]> {
  const url = new URL(OPENALEX_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("select", SELECT);
  url.searchParams.set("mailto", OPENALEX_CONTACT);
  if (apiKey) url.searchParams.set("api_key", apiKey);

  let attempts = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new OpenAlexError(
        "无法连接 OpenAlex（" + (error instanceof Error ? error.message : "网络错误") + "），请检查网络后重试。",
        "network",
      );
    }

    if (response.ok) {
      const body = (await response.json()) as { results: OpenAlexWork[] };
      return body.results;
    }

    const remaining = response.headers.get("x-ratelimit-remaining");
    const quotaExhausted = remaining !== null && Number(remaining) <= 0;
    const canRetry = RETRYABLE.has(response.status) && !quotaExhausted && attempts < BACKOFF_MS.length;

    if (!canRetry) throw describeFailure(response, attempts);

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BACKOFF_MS[attempts] + Math.random() * 500;
    attempts += 1;
    await sleep(waitMs);
  }
}

export interface LiveQueryOptions {
  apiKey?: string;
  /** 高被引经典部分抓取条数 */
  classics?: number;
  /** 最新部分抓取条数 */
  recent?: number;
  fromYear?: number;
  toYear?: number;
}

/**
 * 浏览器直连 OpenAlex。接口本身开放 CORS，无需自建后端；
 * API key 只在用户自己填写时附带，且仅存在于本机浏览器。
 */
export async function fetchOpenAlex(
  query: string,
  options: LiveQueryOptions = {},
): Promise<Paper[]> {
  const classics = options.classics ?? 100;
  const recent = options.recent ?? 100;
  const toYear = options.toYear ?? new Date().getFullYear();
  const fromYear = options.fromYear ?? toYear - 7;

  const filter = [
    `title_and_abstract.search:${query}`,
    `from_publication_date:${fromYear}-01-01`,
    `to_publication_date:${toYear}-12-31`,
  ].join(",");
  const ctx: ProvenanceContext = {
    query,
    filter,
    retrievedAt: new Date().toISOString(),
  };

  const [classicWorks, recentWorks] = await Promise.all([
    fetchWorks({ filter, sort: "cited_by_count:desc", "per-page": String(classics) }, options.apiKey),
    fetchWorks({ filter, sort: "publication_date:desc", "per-page": String(recent) }, options.apiKey),
  ]);

  const byId = new Map<string, OpenAlexWork>();
  for (const work of [...classicWorks, ...recentWorks]) {
    if (work.title) byId.set(work.id, work);
  }
  return [...byId.values()].map((work) => toPaper(work, ctx));
}
