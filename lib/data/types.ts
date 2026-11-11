export type SourceName = "openalex" | "crossref" | "snapshot" | "user_import";

/** 每篇论文的来源与访问状态，判断结论时必须知道材料来自哪里、到哪一层。 */
export interface PaperProvenance {
  source: SourceName;
  /** 来源内部的唯一 ID */
  sourceId: string;
  /** 检索时间（ISO） */
  retrievedAt: string;
  /** 触发这次检索的查询原文 */
  query?: string;
  /** 实际使用的过滤条件 */
  filter?: string;
  /** 去重键：doi:<裸DOI> 或 id:<source>:<sourceId> */
  dedupKey: string;
  /** 当前材料是否包含摘要 */
  abstractAvailable: boolean;
  /** 已验证的开放全文 URL（不含出版商/DOI 落地页）；未验证时为 null */
  oaUrl?: string | null;
}

export interface Paper {
  id: string;
  /** 统一存裸 DOI */
  doi: string | null;
  title: string;
  year: number;
  citedByCount: number;
  type: string | null;
  topics: string[];
  keywords: string[];
  venue: string | null;
  abstract: string | null;
  authors: string[];
  authorCount: number;
  /**
   * 已验证的开放全文 URL（OA 全文 PDF 或 OA 全文页）。
   * 出版商/DOI 落地页一律放 publisherUrl，不得计入开放获取统计与评分。
   */
  oaUrl: string | null;
  /** 出版商/DOI 落地页（可能付费墙，不代表开放获取） */
  publisherUrl?: string | null;
  /**
   * 开放获取核验状态：
   * verified = 来源明确给出的 OA 全文链接；
   * publisher_only = 只有出版商/DOI 落地页；
   * none = 没有任何全文入口。
   */
  oaStatus?: "verified" | "publisher_only" | "none";
  provenance: PaperProvenance;
}

export interface Snapshot {
  domain: string;
  domainLabel: string;
  generatedAt: string;
  source: string;
  sourceNote: string;
  filters: string;
  papers: Paper[];
}

/** 单个来源的检索结果报告 */
export interface SourceReport {
  source: SourceName;
  /** 请求的检索表达式 */
  filter: string;
  returned: number;
  /** 该来源是否失败 */
  failed: boolean;
  error?: string;
  abstractCoverage: number;
  oaCoverage: number;
}

/** 一次检索的完整记录：既是快照元数据，也是导出的 provenance。 */
export interface SearchReport {
  job: {
    rawQuestion: string;
    queryVariants: string[];
    constraints: {
      fromYear?: number;
      toYear?: number;
      openAccessOnly?: boolean;
    };
    sourcePlan: SourceName[];
  };
  sourceReports: SourceReport[];
  totalBeforeDedup: number;
  totalAfterDedup: number;
  removedByDedup: number;
  abstractCoverage: number;
  oaCoverage: number;
  /** 这次检索的已知局限（抽样方式、来源降级等） */
  limitations: string[];
  /** 样本框说明：当前占比不等于真实领域产出比例 */
  sampleFrame: string;
  /** 是否命中本地缓存 */
  fromCache: boolean;
  /** 是否发生了来源降级 */
  degraded: boolean;
  retrievedAt: string;
}

export type PaperSource = "snapshot" | "openalex" | "crossref";

export interface FetchOutcome {
  papers: Paper[];
  source: PaperSource;
  fetchedAt: string;
  query: string;
  /** 离线快照无法联网时的说明文案 */
  notice?: string;
}
