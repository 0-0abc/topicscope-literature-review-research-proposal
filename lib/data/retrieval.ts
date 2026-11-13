import type { Paper, SearchReport, SourceName, SourceReport } from "./types";
import { fetchOpenAlex } from "./openalex";
import { fetchCrossref } from "./crossref";
import { dedupPapers } from "./dedup";
import { filterOnTopic } from "./relevance";

const CACHE_PREFIX = "topicscope.cache.v2.";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export type RetrievalSource = "openalex" | "crossref" | "server";

export function sourceLabel(name: string): string {
  if (name === "openalex") return "OpenAlex";
  if (name === "crossref") return "Crossref";
  if (name === "semanticscholar") return "Semantic Scholar";
  if (name === "snapshot") return "离线快照";
  if (name === "user_import") return "用户导入";
  return name;
}

export interface RetrievalResult {
  papers: Paper[];
  report: SearchReport;
  source: RetrievalSource;
  /** 是否命中本地缓存（未发出网络请求） */
  fromCache: boolean;
  /** 数据来源是否降级（OpenAlex 不可用，退到 Crossref） */
  degraded: boolean;
  /** 展示给用户的一句话说明 */
  detail: string;
}

interface CacheEntry {
  ts: number;
  source: RetrievalSource;
  papers: Paper[];
  report: SearchReport;
}

function cacheKey(query: string): string {
  return CACHE_PREFIX + query.trim().toLowerCase();
}

function readCache(query: string): CacheEntry | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(query));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || !Array.isArray(entry.papers) || entry.papers.length === 0) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(query: string, entry: CacheEntry): void {
  try {
    window.localStorage.setItem(cacheKey(query), JSON.stringify(entry));
  } catch {
    // 超出配额时放弃缓存，不影响检索本身
  }
}

function cacheLabel(source: RetrievalSource): string {
  if (source === "crossref") return "Crossref";
  if (source === "server") return "站点服务端多源";
  return "OpenAlex";
}

interface ServerSearchResponse {
  ok: boolean;
  papers: Paper[];
  report: SearchReport;
  source: string;
  degraded: boolean;
  cached: boolean;
  detail: string;
}

async function serverSearch(query: string, force: boolean): Promise<ServerSearchResponse | null> {
  try {
    const response = await fetch(
      `/functions/v1/app/search?q=${encodeURIComponent(query)}${force ? "&refresh=1" : ""}`,
      { credentials: "same-origin" },
    );
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return null;
    const body = (await response.json().catch(() => null)) as ServerSearchResponse | null;
    // ok:true 且 papers 为数组即视为服务端有效应答（含 0 命中）；
    // 0 命中是「确实没检索到」，不能回退直连 Crossref 产出噪声。
    if (!body || body.ok !== true || !Array.isArray(body.papers)) return null;
    return body;
  } catch {
    return null;
  }
}

function coverage(papers: Paper[]): { abstractCoverage: number; oaCoverage: number } {
  if (papers.length === 0) return { abstractCoverage: 0, oaCoverage: 0 };
  const withAbstract = papers.filter((paper) => paper.provenance.abstractAvailable).length;
  const withOa = papers.filter((paper) => paper.oaUrl).length;
  return {
    abstractCoverage: Math.round((withAbstract / papers.length) * 100),
    oaCoverage: Math.round((withOa / papers.length) * 100),
  };
}

/**
 * 在线检索的样本框：按被引与发表日期各取一批，偏向高被引与最新，
 * 因此界面里的占比不能当成真实领域产出比例。
 */
const ONLINE_SAMPLE_FRAME =
  "在线检索分别取「高被引」与「最新发表」两批结果，属于偏向性抽样；界面里的占比不等于真实领域产出比例。";

export interface RetrieveOptions {
  apiKey?: string;
  /** 忽略本地缓存强制重新检索 */
  force?: boolean;
}

/**
 * 检索主流程：本地缓存 → OpenAlex → Crossref 降级。
 *
 * OpenAlex 的免费额度按 IP 计（1000 额度/天，一次检索 2 次请求），
 * 同一网络下多人使用很容易被限流，所以这里必须准备一条无 key 的降级路径，
 * 并把缓存放在最前面，避免重复检索反复消耗额度。
 */
export async function retrieve(
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const trimmed = query.trim();
  const retrievedAt = new Date().toISOString();

  if (!options.force) {
    const cached = readCache(trimmed);
    if (cached) {
      return {
        papers: cached.papers,
        report: cached.report,
        source: cached.source,
        fromCache: true,
        degraded: cached.source === "crossref",
        detail: `命中本地缓存：${cached.papers.length} 篇 ${cacheLabel(cached.source)} 结果，12 小时内重复检索不再消耗接口额度。`,
      };
    }
  }

  // 服务端检索优先：站点 Function 用 Secret 里的 key 检索（OpenAlex 主源 + Semantic Scholar
  // 第二主源合并），结果在服务端缓存 12 小时供所有访客共享；静态部署（无后端）时回退浏览器直连。
  const server = await serverSearch(trimmed, options.force === true);
  if (server) {
    // 服务端明确 0 命中：直接返回空结果，交给上层提示「未检索到」，不回退直连产出噪声。
    if (server.papers.length === 0) {
      return {
        papers: [],
        report: server.report,
        source: "server",
        fromCache: server.cached,
        degraded: server.degraded,
        detail: server.detail || `未检索到「${trimmed}」相关结果，换个说法试试。`,
      };
    }
    writeCache(trimmed, {
      ts: Date.now(),
      source: "server",
      papers: server.papers,
      report: server.report,
    });
    return {
      papers: server.papers,
      report: server.report,
      source: "server",
      fromCache: server.cached,
      degraded: server.degraded,
      detail: server.detail,
    };
  }

  const sourcePlan: SourceName[] = ["openalex", "crossref"];
  const limitations: string[] = [];

  try {
    const papers = await fetchOpenAlex(trimmed, { apiKey: options.apiKey });
    if (papers.length === 0) {
      // 主源成功但 0 命中：确实没检索到，不降级 Crossref 产出噪声。
      const emptyReport: SearchReport = {
        job: { rawQuestion: trimmed, queryVariants: [trimmed], constraints: {}, sourcePlan },
        sourceReports: [
          { source: "openalex", filter: `title_and_abstract.search:${trimmed}`, returned: 0, failed: false, abstractCoverage: 0, oaCoverage: 0 },
        ],
        totalBeforeDedup: 0,
        totalAfterDedup: 0,
        removedByDedup: 0,
        abstractCoverage: 0,
        oaCoverage: 0,
        limitations: [],
        sampleFrame: ONLINE_SAMPLE_FRAME,
        fromCache: false,
        degraded: false,
        retrievedAt,
      };
      return {
        papers: [],
        report: emptyReport,
        source: "openalex",
        fromCache: false,
        degraded: false,
        detail: `未检索到「${trimmed}」相关结果，换个说法试试。`,
      };
    }
    const before = papers.length;
    const { papers: deduped, removed } = dedupPapers(papers);
    const cov = coverage(deduped);
    const openAlexReport: SourceReport = {
      source: "openalex",
      filter: `title_and_abstract.search:${trimmed}`,
      returned: before,
      failed: false,
      abstractCoverage: cov.abstractCoverage,
      oaCoverage: cov.oaCoverage,
    };
    if (removed > 0) limitations.push(`去重后移除 ${removed} 篇重复记录（按 DOI、来源 ID、标题归一化）。`);
    if (cov.abstractCoverage < 80) {
      limitations.push(`摘要覆盖率 ${cov.abstractCoverage}%，部分结论只能基于元数据。`);
    }
    limitations.push(ONLINE_SAMPLE_FRAME);
    const report: SearchReport = {
      job: {
        rawQuestion: trimmed,
        queryVariants: [trimmed],
        constraints: {},
        sourcePlan,
      },
      sourceReports: [openAlexReport],
      totalBeforeDedup: before,
      totalAfterDedup: deduped.length,
      removedByDedup: removed,
      abstractCoverage: cov.abstractCoverage,
      oaCoverage: cov.oaCoverage,
      limitations,
      sampleFrame: ONLINE_SAMPLE_FRAME,
      fromCache: false,
      degraded: false,
      retrievedAt,
    };
    writeCache(trimmed, { ts: Date.now(), source: "openalex", papers: deduped, report });
    return {
      papers: deduped,
      report,
      source: "openalex",
      fromCache: false,
      degraded: false,
      detail: `在线检索：${deduped.length} 篇，来自 OpenAlex 实时接口。`,
    };
  } catch (openAlexError) {
    const reason = openAlexError instanceof Error ? openAlexError.message : "未知错误";
    const openAlexReport: SourceReport = {
      source: "openalex",
      filter: `title_and_abstract.search:${trimmed}`,
      returned: 0,
      failed: true,
      error: reason,
      abstractCoverage: 0,
      oaCoverage: 0,
    };
    try {
      const rawCrossref = await fetchCrossref(trimmed);
      const papers = filterOnTopic(rawCrossref, trimmed);
      if (papers.length === 0) throw new Error("备选源没有返回与检索词相关的结果");
      const before = papers.length;
      const { papers: deduped, removed } = dedupPapers(papers);
      const cov = coverage(deduped);
      limitations.push(`主来源 OpenAlex 不可用（${reason}），已降级到 Crossref：没有主题标签，摘要覆盖也低。`);
      if (removed > 0) limitations.push(`去重后移除 ${removed} 篇重复记录。`);
      limitations.push(ONLINE_SAMPLE_FRAME);
      const report: SearchReport = {
        job: {
          rawQuestion: trimmed,
          queryVariants: [trimmed],
          constraints: {},
          sourcePlan,
        },
        sourceReports: [
          openAlexReport,
          {
            source: "crossref",
            filter: `query.bibliographic:${trimmed}`,
            returned: before,
            failed: false,
            abstractCoverage: cov.abstractCoverage,
            oaCoverage: cov.oaCoverage,
          },
        ],
        totalBeforeDedup: before,
        totalAfterDedup: deduped.length,
        removedByDedup: removed,
        abstractCoverage: cov.abstractCoverage,
        oaCoverage: cov.oaCoverage,
        limitations,
        sampleFrame: ONLINE_SAMPLE_FRAME,
        fromCache: false,
        degraded: true,
        retrievedAt,
      };
      writeCache(trimmed, { ts: Date.now(), source: "crossref", papers: deduped, report });
      return {
        papers: deduped,
        report,
        source: "crossref",
        fromCache: false,
        degraded: true,
        detail:
          `OpenAlex 暂时不可用（${reason}）→ 已自动改用 Crossref 备选源：${deduped.length} 篇。` +
          "Crossref 不需要 key、没有额度上限，但没有主题标签、摘要覆盖也低，方向判定会偏粗。",
      };
    } catch (crossrefError) {
      const fallbackReason =
        crossrefError instanceof Error ? crossrefError.message : "未知错误";
      throw new Error(`${reason} 备选源 Crossref 也没能取回数据（${fallbackReason}）。`);
    }
  }
}
