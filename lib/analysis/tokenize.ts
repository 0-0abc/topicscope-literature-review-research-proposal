const ENGLISH_STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any",
  "are", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "cannot", "could", "did", "do", "does", "doing", "don", "down", "during",
  "each", "few", "for", "from", "further", "had", "has", "have", "having", "he", "her", "here",
  "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its",
  "itself", "just", "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of",
  "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out",
  "over", "own", "same", "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "with", "would", "you", "your", "yours", "yourself",
  "yourselves", "will", "may", "might", "must", "shall", "one", "two", "three",
]);

/**
 * 论文行文里的高频「元词」：它们描述写作方式而不是研究主题，
 * 留在词表里会让聚类名与共现图退化成「image · technique」这类无信息量的组合。
 */
const GENERIC_RESEARCH_WORDS = new Set([
  "paper", "papers", "article", "articles", "study", "studies", "work", "works",
  "propose", "proposed", "proposes", "present", "presents", "presented", "show", "shows",
  "shown", "showcase", "showcases", "result", "results", "method", "methods", "methodology",
  "approach", "approaches", "framework", "frameworks", "based", "use", "uses", "used",
  "using", "utilize", "utilized", "novel", "new", "effective", "effectively", "achieve",
  "achieves", "achieving", "improve", "improves", "improvement", "improvements", "enhance",
  "enhancement", "performance", "experiment", "experiments", "experimental", "evaluation",
  "evaluate", "state", "states", "state-of-the-art", "sota", "art", "intelligence", "artificial",
  "technique", "techniques", "analysis", "analyses", "application", "applications", "apply",
  "applied", "applies", "include", "includes", "including", "included", "consider", "considered",
  "additionally", "furthermore", "moreover", "overall", "various", "different", "several",
  "known", "however", "therefore", "thus", "hence", "recent", "recently", "currently", "current",
  "system", "systems", "algorithm", "algorithms", "data", "dataset", "datasets", "model",
  "models", "network", "networks", "learning", "deep", "training", "train", "trained", "test",
  "testing", "tested", "dataset", "code", "github", "http", "https", "www", "com", "org",
  "et", "al", "fig", "figure", "table", "section", "abstract", "introduction", "conclusion",
  "conclusions", "related", "review", "survey", "tutorial", "overview", "insight", "insights",
  "understanding", "validation", "quantitative", "qualitative", "extensive", "comprehensive",
  "systematic", "detailed", "detailed", "enable", "enables", "enabled", "allow", "allows",
  "provided", "provide", "provides", "obtain", "obtained", "achievable", "compared",
  "comparison", "consistent", "important", "significant", "several", "particular", "specific",
  "general", "generalization", "generality", "towards", "toward", "via", "etn", "al.",
  "ai", "advanced", "large", "small", "high", "low", "main", "major", "key", "full", "entire",
  "complete", "automatic", "automatically", "efficient", "efficiency", "powerful", "robust",
  "accurate", "modern", "traditional", "classical", "global", "local", "spatial", "temporal",
  "manual", "simply", "simply", "clearly", "further", "additionally", "materially",
  "demonstrate", "demonstrates", "demonstrated", "showcase", "achievable", "confirm",
]);

const CHINESE_STOPWORDS = new Set([
  "我们", "本文", "提出", "方法", "模型", "结果", "实验", "表明", "能够", "可以", "进行",
  "通过", "对于", "关于", "一种", "这个", "那个", "以及", "并且", "然而", "因此", "所以",
  "同时", "目前", "已经", "没有", "不是", "就是", "其中", "具有", "基于", "针对",
]);

/**
 * 极轻量的英文词形归一：只处理复数。
 * 不做 -ing / -ed 词干还原——在学术术语上它会制造 "semi-supervis"、"anyth" 这类假词，
 * 把「半监督」「anything」这类真词打散成无法识别的形态。
 */
function normalizeEnglish(word: string): string {
  if (word.length > 4 && word.endsWith("ies") && !word.endsWith("eies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 4 && /(ches|shes|sses|xes|zes)$/.test(word)) {
    return word.slice(0, -2);
  }
  if (
    word.length > 3 &&
    word.endsWith("s") &&
    !/(ss|us|is|as)$/.test(word)
  ) {
    return word.slice(0, -1);
  }
  return word;
}

const CJK_RUN = /[一-鿿]+/g;
const WORD = /[a-z][a-z0-9+#.-]*/g;

/**
 * 把一段中英混排文本切成检索词。
 * 中文按二元组切分（无需词典即可捕捉「影像分割」这类复合概念），
 * 英文按单词切分后做轻量归一。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const match of lower.matchAll(WORD)) {
    const raw = match[0].replace(/[.-]+$/, "");
    if (raw.length < 2) continue;
    if (ENGLISH_STOPWORDS.has(raw)) continue;
    if (GENERIC_RESEARCH_WORDS.has(raw)) continue;
    const normalized = normalizeEnglish(raw);
    if (normalized.length < 2) continue;
    if (ENGLISH_STOPWORDS.has(normalized)) continue;
    if (GENERIC_RESEARCH_WORDS.has(normalized)) continue;
    tokens.push(normalized);
  }

  for (const run of lower.matchAll(CJK_RUN)) {
    const chars = [...run[0]];
    if (chars.length === 1) {
      if (!CHINESE_STOPWORDS.has(chars[0])) tokens.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      const bigram = chars[i] + chars[i + 1];
      if (CHINESE_STOPWORDS.has(bigram)) continue;
      tokens.push(bigram);
    }
  }

  return tokens;
}

export interface WeightedDocument {
  /** 词 → 该文档中的词频 */
  counts: Map<string, number>;
}

/** 把多段来源按不同权重拼成一篇待分析文档。 */
export function buildDocument(sources: { text: string; weight: number }[]): WeightedDocument {
  const counts = new Map<string, number>();
  for (const source of sources) {
    for (const token of tokenize(source.text)) {
      counts.set(token, (counts.get(token) ?? 0) + source.weight);
    }
  }
  return { counts };
}
