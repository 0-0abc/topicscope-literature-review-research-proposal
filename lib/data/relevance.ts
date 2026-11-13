/**
 * 统一的主题相关性门禁（M5）：导师汇报代表文献与综述编号文献共用同一套过滤，
 * 避免「检索词是 A、推荐/引用却是 B」的噪声。只依赖标题/摘要/关键词/topics，
 * 不引入新依赖，也不改动聚类与检索本身。
 */

/** 英文停用词（长度 >= 3 的部分；更短的词会被长度门槛直接挡掉） */
const ENGLISH_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "these", "those", "are", "was", "were",
  "been", "being", "have", "has", "had", "not", "but", "can", "could", "should", "would",
  "will", "shall", "may", "might", "must", "about", "above", "after", "again", "against",
  "all", "also", "any", "because", "before", "below", "between", "both", "during", "each",
  "few", "further", "here", "how", "into", "its", "itself", "just", "more", "most", "other",
  "once", "only", "our", "out", "over", "own", "same", "some", "such", "than", "then",
  "there", "they", "through", "too", "under", "until", "very", "what", "when", "where",
  "which", "while", "who", "whom", "why", "you", "your", "using", "use", "used", "based",
  "via", "toward", "towards", "does", "did", "doing", "don", "down", "off", "nor", "now",
  "ought", "ourselves", "herself", "himself", "themselves", "yourselves",
]);

/** 中文停用词与高频元词：描述写作方式而非研究主题，命中它们几乎等于没过滤 */
const CHINESE_STOPWORDS = new Set([
  "我们", "本文", "提出", "方法", "模型", "结果", "实验", "表明", "能够", "可以", "进行",
  "通过", "对于", "关于", "一种", "这个", "那个", "以及", "并且", "然而", "因此", "所以",
  "同时", "目前", "已经", "没有", "不是", "就是", "其中", "具有", "基于", "针对",
  "研究", "分析", "综述", "进展", "应用", "如何", "怎么", "什么", "哪些", "方向", "选题",
]);

const ENGLISH_WORD = /[a-z][a-z0-9+#-]*/g;
const CJK_RUN = /[一-鿿]+/g;

/**
 * 把检索词切成主题 token：小写、分词、去停用词、长度 >= 3。
 * 英文按单词切；中文保留整段（>= 3 字）并补充滑动三字组，
 * 以便「医学影像分割」能命中标题里的「影像分割」。
 */
export function topicTokens(query: string): string[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const tokens = new Set<string>();

  for (const match of lower.matchAll(ENGLISH_WORD)) {
    const raw = match[0].replace(/-+$/, "");
    if (raw.length < 3) continue;
    if (ENGLISH_STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }

  for (const match of lower.matchAll(CJK_RUN)) {
    const chars = [...match[0]];
    if (chars.length < 3) continue;
    const whole = chars.join("");
    if (!CHINESE_STOPWORDS.has(whole)) tokens.add(whole);
    for (let i = 0; i + 3 <= chars.length; i++) {
      const trigram = chars.slice(i, i + 3).join("");
      if (!CHINESE_STOPWORDS.has(trigram)) tokens.add(trigram);
    }
  }

  return [...tokens];
}

/** 参与相关性判断的最小论文形状（Paper 与聚类代表文献都满足） */
export interface TopicMatchable {
  title: string;
  abstract?: string | null;
  keywords?: string[];
  topics?: string[];
}

/**
 * 标题/摘要/关键词/topics 命中 >= 1 个 token 即视为在主题内。
 * tokens 为空时视为无检索词约束，返回 true（避免空查询把文献全部清空）。
 */
export function isOnTopic(paper: TopicMatchable, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    paper.title,
    paper.abstract ?? "",
    ...(paper.keywords ?? []),
    ...(paper.topics ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/** 按检索词过滤文献；query 切不出有效 token 时原样返回，不做过滤。 */
export function filterOnTopic<T extends TopicMatchable>(papers: T[], query: string): T[] {
  const tokens = topicTokens(query);
  if (tokens.length === 0) return papers;
  return papers.filter((paper) => isOnTopic(paper, tokens));
}