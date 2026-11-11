/**
 * DOI 规范化：不同来源给的 DOI 形态不一致（裸 DOI、doi.org 链接、带结尾标点的），
 * 展示和导出统一使用裸 DOI，链接再由裸 DOI 拼出来，避免出现重复的域名。
 */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text) return null;

  text = text.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  text = text.replace(/^doi:\s*/i, "");
  text = text.replace(/^info:doi\//i, "");
  text = text.trim();
  // 末尾的标点常常是抓取时带出来的引用符号
  text = text.replace(/[.,;)\]]+$/, "");

  if (!/^10\.\d{4,9}\//.test(text)) return null;
  return text.toLowerCase();
}

export function doiUrl(doi: string | null | undefined): string | null {
  const bare = normalizeDoi(doi);
  return bare ? `https://doi.org/${bare}` : null;
}

/** 标题归一：用于跨源去重的兜底匹配（同一篇论文在不同来源的标题可能差大小写与标点）。 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
    .trim();
}
