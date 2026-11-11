// 站点自带的唯一后端：把浏览器端的统计结果转成研究方向建议与研究方案。
// 模型 API key 只从服务端环境变量读取，绝不出现在响应里。

const DEFAULT_BASE_URL = "https://maas.qianwenaiapi.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.8-flash";
const MAX_BODY_BYTES = 96 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * 同一个 key 在不同计费方案/地域下要配不同的 Base URL（百炼与千问 AI 平台的规则），
 * 这里按可信地址依次尝试，只在鉴权被拒时换地址，不接受调用方传入的任意地址。
 */
const BASE_URL_CANDIDATES = [
  DEFAULT_BASE_URL,
  "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
];

/** 公开接口的调用保护：同一 IP 每 10 分钟最多 20 次模型调用。 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
// 进程级总预算：防止代理头变化或脚本绕过把模型 key 的额度打穿。
// 这是单实例的基础保护，不是分布式限流；多实例部署需要网关或共享存储层面的限制。
const INSTANCE_BUDGET_MAX = 400;
const INSTANCE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let instanceBudget = { count: 0, resetAt: Date.now() + INSTANCE_BUDGET_WINDOW_MS };

/** 上游是否拒绝过当前的 key：用于让前端在 key 失效时自动隐藏这个面板。 */
let upstreamAuthFailed = false;

const SYSTEM_PROMPT = `你是一名科研选题分析助手，服务于正在读文献、写综述的学生和科研新人。
硬性约束：
1. 只能使用用户给出的 JSON 数据推理，不得引入数据之外的文献、作者、期刊、数字或结论。
2. 任何结论都要给出 evidenceIds，只能从用户给出的 evidence 列表里挑现成的 ID，不允许自己编造 ID。
3. 如果数据不足以支撑某个判断，就写"当前材料无法判断"，不要硬凑。

输出格式：只输出一个 JSON 对象，不要任何解释文字或代码块以外的内容。
{"suggestions":[{"title":"方向短名","question":"一句话说清要回答的研究问题","why":"为什么值得做，必须引用给定数字","entry":"具体怎么做：用什么数据、什么方法、跟谁对照","evidence":"需要准备的数据与需要复现的基线","cost":"算力与时间的量级估计","risk":"这个方向最可能失败的原因","feasibility":3,"evidenceIds":["cluster:xxx:size","pair:xxx-yyy:lift"]}]}
suggestions 给 3 到 5 条，按可做性从高到低排列；feasibility 是 1–5 的整数，5 表示用现有数据和方法就能启动；evidenceIds 给 2–6 个，全部来自用户提供的 evidence 列表。`;

const CHAT_SYSTEM_PROMPT = `你是 TopicScope 的研究对话助手，围绕用户当前检索样本与已核对证据回答追问。硬约束：
1. 只依据输入里的 context（聚类统计）、papers（编号论文标题/摘要节选）、verifiedEvidence（用户人工核对字段）回答；不要编造论文、数字或结论。
2. 每条事实性陈述都要给 refs：[{n: 论文编号, field?: 核对字段label}]；统计类陈述给 evidenceIds（只能从 context.evidence 挑现成 ID）。没有依据就明说"当前材料无法判断"。
3. 区分证据等级：verifiedEvidence 是人工核对（可信度最高），papers 摘要次之，仅标题再次之；回答里注明你用的是哪一层。
4. 措辞按证据强度校准：单篇用"提示/说明"，多篇一致才用"表明"，仅机制用"可能"；不写无依据最高级、不把相关当因果。
5. 回答简洁（≤400 字），面向"下一步怎么做"。
输出格式：只输出一个 JSON 对象 {"answer":"...","refs":[{"n":1,"field":"方法流程"}],"evidenceIds":["cluster:xxx:size"],"uncertain":"当前材料无法判断的部分（没有则空字符串）"}`;

const PLAN_SYSTEM_PROMPT = `你是一名科研方案设计助手，为正在读文献、写开题报告的学生和科研新人设计可执行的研究方案。
硬性约束：
1. 只能使用用户给出的 JSON 数据推理，不得引入数据之外的文献、作者、期刊或数字。
2. 结论必须绑定 evidenceIds（只能从用户提供的 evidence 列表里挑现成的 ID）。
3. 用户没给的约束不要替他猜，写进 missing（待补充条件）。
4. 不能把"结合 A 和 B"直接写成创新性结论，必须说明任务差异、数据差异、评测差异或机制假设差异。
5. 失败判据必须写清楚：什么结果算假设不成立。
6. 每个 section 控制在 150 字以内，要点式，不要写长段落；不要重复同一句话。
7. 逻辑链自洽：已有工作的局限 → 核心想法 → 挑战 → 方法 → 预期结果必须逐级互锁。每个挑战要有对应方法，每个预期结果要有方法或实验支撑，贡献不超过三条且都能落到具体章节；按这四步做自洽检查，发现断链就写明断在哪一环、怎么修，写进 chainAudit。
8. 若输入带 verifiedEvidence（用户逐字段人工核对过的论文内容），优先采信它而不是你的推测；在背景/方法/基线/指标等章节引用时注明来自哪篇论文的哪个核对字段；verifiedEvidence 为空时不要假装有人工核对内容。
9. 若输入带 draftConclusions（用户在研究对话中认可的结论草稿），把它们当作设计前提融进对应章节；与统计或核对证据冲突时，以后者为准并写明冲突。

输出格式：只输出一个 JSON 对象。
{"title":"方案题目","sections":{"problem":"一句话研究问题","background":"背景与已有证据（引用数字）","novelty":"方向位置与新颖性边界","hypotheses":"可验证假设（至少一条可证伪）","datasets":"数据集与获取方式（含可获得性状态）","baselines":"基线与对照","method":"方法设计","metrics":"指标与统计方法","experiments":"三层实验：最小可行实验 / 主实验 / 扩展实验，每层写明时间、算力、成功标准与失败后的替代路线","resources":"复现与资源需求","risks":"风险与失败判据","milestones":"里程碑与时间安排","outcomes":"预期结果与替代路线","references":"代表性参考文献（只能列 context.clusters[].papers 里出现过的论文，写标题+年份+被引，不要列期刊或数据集充数）","evidenceIndex":"证据索引：列出用到的 evidence ID 与对应数字"},"chainAudit":"四步逻辑链自洽检查：局限→想法、想法→挑战、挑战→方法、方法→结果，逐环写通过或断链与修法","scores":[{"dimension":"证据充分度","score":3,"reason":"扣分原因"}],"missing":["缺少的关键约束"],"evidenceIds":["cluster:xxx:size"]}
scores 固定给五项：证据充分度、研究问题清晰度、基线可获得性、资源可行性、风险可控性，每项 1–5 分并写明原因。`;
const REVIEW_SYSTEM_PROMPT = `你是一名文献综述写作助手，帮学生和科研新人把当前检索样本整理成综述草稿。
硬性约束：
1. 只能使用用户给出的 JSON 数据：context 是方向统计，papers 是编号文献（含摘要节选）。不得引入数据之外的文献、作者、期刊或数字。
2. 引用文献时用 [n] 标注，n 必须是 papers 里出现过的编号；不得编造编号。
3. 按方向/主题综合叙述，不要逐篇罗列摘要；每个主题小节至少有一句话同时引用并比较两篇以上文献（[n] 与 [m] 的异同），禁止"A 做了 X。B 做了 Y。"式流水账。
4. 分寸校准：判断强度不得超过证据强度。多篇一致才用"表明/证实"；单篇或摘要级证据用"提示/说明"；仅机制推断用"可能/似乎"。禁止无条件的最高级（"最好的方法""首个""唯一"），禁止把相关写成因果。矛盾结果如实呈现并分析条件差异，不要抹平。
5. 材料不足（如摘要缺失）就写明"当前材料无法判断"，不要硬凑结论。
6. 每个 section 的 body 控制在 350 字以内；中文写作。
7. 写完做自我对抗检查：找出草稿里最脆弱的一个主张、一个未明说的前提、以及是否存在只引支持方文献的选择性引用，写进 selfCheck；没有发现问题就如实写未发现，不要制造自我批评。

输出格式：只输出一个 JSON 对象。
{"title":"综述题目","sections":[{"heading":"小节标题","body":"综合叙述，含 [n] 引用"}],"gaps":"研究空白与可切入点的谨慎推断","limitation":"本草稿的材料局限","selfCheck":"自我对抗检查：最脆弱主张 / 未明说前提 / 选择性引用风险"}
sections 给 4 到 7 个：引言与检索范围、按方向的主题小节（2–4 个）、方法与指标口径比较、研究空白与展望。`;

const FEASIBILITY_SYSTEM_PROMPT = `你是一名选题可行性体检助手，同时扮演顶会审稿人与资深导师，帮学生判断一个想法值不值得投入几个月。
输入 JSON：idea（待评估的想法或方向）、capability（用户自报能力）、target（目标方向统计，可能为 null）、context（当前检索样本统计）、papers（编号文献含摘要节选，用于新颖性核对）。
硬性约束：
1. 只能使用给出的 JSON 数据推理，不得引入数据之外的文献、作者、期刊或数字；绝不编造实验数字或提升百分比。
2. 引用文献用 [n]，n 必须是 papers 里出现过的编号。
3. 新颖性判断必须落在 papers 上：指出最接近的 2–3 篇并说明差异轴（作用对象/机制/输入粒度/问题设定）；标题相似不构成重复；没找到直接重叠工作时写"当前样本未检索到直接重叠工作（不代表真实新颖性）"。
4. 评分纪律：五维都从 5 分起步，只有给出依据（想法文本里的明确贡献，或站得住的机制论证）才加分；机制论证的分数 basis 必须标 mechanism 并在 evidence 里写明验证实验；无数据也无机制的维度保持 5 分、basis 为 none。不要因为没有实验数据就压低机制扎实的想法。
5. 致命缺陷最多 2 条；severity：critical=用户时间预算内无法防御，major=需 2–4 周专门工作，minor=一周内可解决。出现 critical 时 verdict.decision 必须是 reject，lifecycle/dimensions/paradigm/risks 可为空。
6. 每个文本字段不超过 150 字，要点式，中文写作。
体检步骤（次序不能换）：
第一步 第一印象：paperType 取 新问题/新方法/新设定 之一；story 用一句话讲清这个故事。
第二步 致命缺陷审计：对照 F1 相对最近工作无新颖性、F2 投稿场所错配、F3 基线太弱或太旧、F4 没有 compelling 动机、F5 能力错配、F6 主张不可验证、F7 数据或伦理卡点、F8 范围过大、F9 拿着方案找问题、F10 没考虑失败情形，只输出确实命中的。
第三步 生命周期匹配：把想法归入 应用研究(3–6个月)/基础理论(6–12个月)/交叉学科(6–9个月)/前沿探索(3–9个月)/数据密集型(6–12个月)/创新技法(12个月以上) 之一，对照 capability.months 与 weeklyHours 给 fit（green/yellow/red）。
第四步 五维评分：key 依次为 higher(效果提升)/faster(效率)/stronger(鲁棒泛化)/cheaper(数据与成本)/broader(跨领域)，score 为 1–10 整数，basis 取 data/mechanism/none，evidence 指向想法原文或 [n] 文献。
第五步 范式探测：四问——第一性原理(是否挑战领域默认假设)/房间里的大象(是否碰大家都回避的老大难)/技术周期(是否受益于近期技术变化)/Hamming 法则(解决了会不会改变领域优先级)，answer 取 yes/partial/no。
第六步 可行性风险：算力/数据/工程/时间线四项，level 取 low/medium/high，mitigation 必须基于 capability 里自报的资源。
第七步 结论：decision 取 accept(至少两个维度 ≥8 且无 critical)/revise(缺陷可修复或需收窄范围)/reject(存在 critical 或能力根本错配)；reason 写判定依据；actions 给先做的三件事。
输出格式：只输出一个 JSON 对象。
{"firstImpression":{"paperType":"新方法","story":"一句话"},"flaws":[{"code":"F1","name":"缺陷名","severity":"major","detail":"命中原因","defense":"具体防御"}],"lifecycle":{"category":"应用研究","window":"3–6 个月","fit":"yellow","reason":"与自报能力对照"},"dimensions":[{"key":"higher","score":7,"basis":"mechanism","evidence":"依据与验证实验"}],"paradigm":[{"probe":"第一性原理","answer":"partial","reason":"理由"}],"risks":[{"kind":"算力","level":"medium","mitigation":"缓解办法"}],"verdict":{"decision":"revise","reason":"判定依据","actions":["第一步","第二步","第三步"]},"limitation":"本次体检的材料局限"}
limitation 必须说明：样本覆盖有限、能力为自报未经核验、判定不构成真实投稿结果预测。`;

const PLAN_RESOURCE_RULE = `用户可能给出一组资源（数据集、代码、模型、标注）及其可获得性状态。
"公开可取"不等于标注与划分公开，"代码公开"不等于依赖与权重完整，"论文给出结果"不等于当前算力下能复现。
请分别说明"数据可获得"与"方法可复现"各自的缺口，不要把两者混为一谈。`;

interface EvidenceItem {
  id: string;
  kind: string;
  label: string;
  value: string;
  origin: string;
}

interface TermPair {
  a: string;
  b: string;
  lift: number;
  count: number;
}

interface ClusterBrief {
  name: string;
  verdict: string;
  size: number;
  sizeShare: number;
  yearRange: [number, number];
  medianYear: number;
  recentShare: number;
  fiveYearShare: number;
  citationMedian: number;
  crowding: number;
  reason: string;
  terms: string[];
  venues: { name: string; count: number }[];
  papers: { title: string; year: number; venue: string | null; citedByCount: number }[];
  pairs: TermPair[];
}

interface DirectionContext {
  query: string;
  corpus: {
    size: number;
    yearRange: [number, number];
    clusterCount: number;
    abstractCoverage: number;
    oaCoverage: number;
  };
  clusters: ClusterBrief[];
  pairs: TermPair[];
  evidence: EvidenceItem[];
}

interface PlanConstraints {
  object?: string;
  task?: string;
  datasets?: string;
  compute?: string;
  timeline?: string;
  openCode?: string;
  target?: string;
}

interface ResourceRoute {
  kind: string;
  name: string;
  status: string;
  url?: string;
  license?: string;
  accessCondition?: string;
}

const RESOURCE_STATUS_LABEL: Record<string, string> = {
  public: "公开可取",
  controlled: "需申请或审批",
  third_party_restricted: "受第三方许可限制",
  within_paper: "只在论文里描述",
  not_verified: "尚未核验",
};

const RESOURCE_KIND_LABEL: Record<string, string> = {
  dataset: "数据集",
  code: "代码",
  model: "预训练模型",
  annotation: "标注",
};

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function fail(error: string, message: string, status: number): Response {
  return json({ ok: false, error, message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readText(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function readPairs(value: unknown): TermPair[] {
  if (!Array.isArray(value)) return [];
  const pairs: TermPair[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const a = typeof item.a === "string" ? item.a : "";
    const b = typeof item.b === "string" ? item.b : "";
    if (!a || !b) continue;
    pairs.push({ a, b, lift: readNumber(item.lift, 0), count: readNumber(item.count, 0) });
  }
  return pairs.slice(0, 40);
}

function readEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  const items: EvidenceItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readText(item.id, 120);
    if (!id) continue;
    items.push({
      id,
      kind: readText(item.kind, 20),
      label: readText(item.label, 120),
      value: readText(item.value, 60),
      origin: readText(item.origin, 40),
    });
    if (items.length >= 120) break;
  }
  return items;
}

/** 只接受形状正确的分析结果，避免把任意内容拼进提示词。 */
function parseContext(value: unknown): DirectionContext | null {
  if (!isRecord(value)) return null;
  const query = readText(value.query, 120);
  if (!query) return null;
  const corpus = isRecord(value.corpus) ? value.corpus : {};
  const yearRange = Array.isArray(corpus.yearRange) ? corpus.yearRange : [0, 0];
  const clusters: ClusterBrief[] = [];
  if (Array.isArray(value.clusters)) {
    for (const item of value.clusters) {
      if (!isRecord(item)) continue;
      const name = readText(item.name, 60);
      if (!name) continue;
      const range = Array.isArray(item.yearRange) ? item.yearRange : [0, 0];
      const terms = Array.isArray(item.terms)
        ? item.terms.filter((t): t is string => typeof t === "string").slice(0, 10)
        : [];
      const venues = Array.isArray(item.venues)
        ? item.venues
            .filter(isRecord)
            .map((v) => ({ name: readText(v.name, 80), count: readNumber(v.count, 0) }))
            .slice(0, 4)
        : [];
      const papers = Array.isArray(item.papers)
        ? item.papers
            .filter(isRecord)
            .map((paper) => ({
              title: readText(paper.title, 200),
              year: readNumber(paper.year, 0),
              venue: readText(paper.venue, 120) || null,
              citedByCount: readNumber(paper.citedByCount, 0),
            }))
            .filter((paper) => paper.title)
            .slice(0, 5)
        : [];
      clusters.push({
        name,
        verdict: readText(item.verdict, 20),
        size: readNumber(item.size, 0),
        sizeShare: readNumber(item.sizeShare, 0),
        yearRange: [readNumber(range[0], 0), readNumber(range[1], 0)],
        medianYear: readNumber(item.medianYear, 0),
        recentShare: readNumber(item.recentShare, 0),
        fiveYearShare: readNumber(item.fiveYearShare, 0),
        citationMedian: readNumber(item.citationMedian, 0),
        crowding: readNumber(item.crowding, 0),
        reason: readText(item.reason, 400),
        terms,
        venues,
        papers,
        pairs: readPairs(item.pairs),
      });
    }
  }
  if (clusters.length === 0) return null;
  return {
    query,
    corpus: {
      size: readNumber(corpus.size, 0),
      yearRange: [readNumber(yearRange[0], 0), readNumber(yearRange[1], 0)],
      clusterCount: readNumber(corpus.clusterCount, clusters.length),
      abstractCoverage: readNumber(corpus.abstractCoverage, 0),
      oaCoverage: readNumber(corpus.oaCoverage, 0),
    },
    clusters: clusters.slice(0, 20),
    pairs: readPairs(value.pairs),
    evidence: readEvidence(value.evidence),
  };
}

function parseConstraints(value: unknown): PlanConstraints {
  if (!isRecord(value)) return {};
  return {
    object: readText(value.object, 200) || undefined,
    task: readText(value.task, 200) || undefined,
    datasets: readText(value.datasets, 300) || undefined,
    compute: readText(value.compute, 200) || undefined,
    timeline: readText(value.timeline, 200) || undefined,
    openCode: readText(value.openCode, 120) || undefined,
    target: readText(value.target, 200) || undefined,
  };
}

function parseResources(value: unknown): ResourceRoute[] {
  if (!Array.isArray(value)) return [];
  const routes: ResourceRoute[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = readText(item.name, 120);
    if (!name) continue;
    const status = readText(item.status, 40);
    routes.push({
      kind: readText(item.kind, 20) || "dataset",
      name,
      status: RESOURCE_STATUS_LABEL[status] ? status : "not_verified",
      url: readText(item.url, 300) || undefined,
      license: readText(item.license, 120) || undefined,
      accessCondition: readText(item.accessCondition, 200) || undefined,
    });
    if (routes.length >= 20) break;
  }
  return routes;
}

/** 模型偶尔会用 ```json 包裹或前后加话，这里取出第一个完整 JSON 对象。 */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SUGGESTION_TEXT_FIELDS = [
  "title",
  "question",
  "why",
  "entry",
  "evidence",
  "cost",
  "risk",
] as const;

const PLAN_SECTION_FIELDS = [
  "problem",
  "background",
  "novelty",
  "hypotheses",
  "datasets",
  "baselines",
  "method",
  "metrics",
  "experiments",
  "resources",
  "risks",
  "milestones",
  "outcomes",
  "references",
  "evidenceIndex",
] as const;

const SCORE_DIMENSIONS = [
  "证据充分度",
  "研究问题清晰度",
  "基线可获得性",
  "资源可行性",
  "风险可控性",
] as const;

/** 保留模型给出的证据 ID（含无效 ID），交由前端标出「未识别的引用」，而不是静默丢弃。 */
function filterEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id) continue;
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= 8) break;
  }
  return ids;
}

/** 用户已核对、随请求提交的证据字段（人工核对内容，优先级高于模型推测）。 */
function readVerifiedEvidence(value: unknown): {
  paperId: string;
  paperTitle: string;
  fields: { label: string; value: string; location?: string }[];
}[] {
  if (!Array.isArray(value)) return [];
  const out: { paperId: string; paperTitle: string; fields: { label: string; value: string; location?: string }[] }[] = [];
  for (const item of value.slice(0, 12)) {
    if (!isRecord(item)) continue;
    const paperId = readText(item.paperId, 120);
    const paperTitle = readText(item.paperTitle, 200);
    if (!paperId || !Array.isArray(item.fields)) continue;
    const fields: { label: string; value: string; location?: string }[] = [];
    for (const f of item.fields.slice(0, 10)) {
      if (!isRecord(f)) continue;
      const label = readText(f.label, 40);
      const val = readText(f.value, 600);
      if (!label || !val) continue;
      const location = readText(f.location, 80);
      fields.push({ label, value: val, ...(location ? { location } : {}) });
    }
    if (fields.length > 0) out.push({ paperId, paperTitle: paperTitle || paperId, fields });
  }
  return out;
}

function readChatMessages(value: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const item of value.slice(-12)) {
    if (!isRecord(item)) continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const content = readText(item.content, 1200);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function readChatPapers(value: unknown): { n: number; title: string; year: number; abstract: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { n: number; title: string; year: number; abstract: string }[] = [];
  for (const item of value.slice(0, 12)) {
    if (!isRecord(item)) continue;
    const n = Number(item.n);
    const title = readText(item.title, 200);
    if (!Number.isFinite(n) || !title) continue;
    out.push({
      n,
      title,
      year: Number(item.year) || 0,
      abstract: readText(item.abstract, 500),
    });
  }
  return out;
}

function parseChat(value: unknown): {
  answer: string;
  refs: { n: number; field?: string }[];
  evidenceIds: string[];
  uncertain: string;
} | null {
  if (!isRecord(value)) return null;
  const answer = readText(value.answer, 1600);
  if (!answer) return null;
  const refs: { n: number; field?: string }[] = [];
  if (Array.isArray(value.refs)) {
    for (const r of value.refs.slice(0, 8)) {
      if (!isRecord(r)) continue;
      const n = Number(r.n);
      if (!Number.isFinite(n)) continue;
      const field = readText(r.field, 40);
      refs.push({ n, ...(field ? { field } : {}) });
    }
  }
  return {
    answer,
    refs,
    evidenceIds: filterEvidenceIds(value.evidenceIds),
    uncertain: readText(value.uncertain, 400),
  };
}

function readDraftConclusions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, 8)) {
    const text = readText(item, 600);
    if (text) out.push(text);
  }
  return out;
}

function parseSuggestions(value: unknown, allowed: Set<string>) {
  if (!isRecord(value) || !Array.isArray(value.suggestions)) return [];
  const suggestions: Record<string, unknown>[] = [];
  for (const item of value.suggestions) {
    if (!isRecord(item)) continue;
    let valid = true;
    const texts: Record<string, string> = {};
    for (const field of SUGGESTION_TEXT_FIELDS) {
      const text = readText(item[field], 600);
      if (!text) valid = false;
      texts[field] = text;
    }
    if (!valid) continue;
    const feasibility = readNumber(item.feasibility, 0);
    if (feasibility < 1) continue;
    suggestions.push({
      ...texts,
      feasibility: Math.min(5, Math.max(1, Math.round(feasibility))),
      evidenceIds: filterEvidenceIds(item.evidenceIds),
    });
    if (suggestions.length >= 6) break;
  }
  return suggestions;
}

function parsePlan(value: unknown, allowed: Set<string>) {
  if (!isRecord(value)) return null;
  const sections = isRecord(value.sections) ? value.sections : null;
  if (!sections) return null;
  const parsedSections: Record<string, string> = {};
  for (const field of PLAN_SECTION_FIELDS) {
    parsedSections[field] = readText(sections[field], 2000);
  }
  const scores: { dimension: string; score: number; reason: string }[] = [];
  if (Array.isArray(value.scores)) {
    for (const item of value.scores) {
      if (!isRecord(item)) continue;
      const dimension = readText(item.dimension, 30);
      const score = readNumber(item.score, 0);
      if (!dimension || score < 1) continue;
      scores.push({
        dimension,
        score: Math.min(5, Math.max(1, Math.round(score))),
        reason: readText(item.reason, 200),
      });
    }
  }
  // 五个维度必须齐全，缺的补成 0 分并注明原因
  for (const dimension of SCORE_DIMENSIONS) {
    if (!scores.some((score) => score.dimension === dimension)) {
      scores.push({ dimension, score: 0, reason: "模型未给出该维度评分" });
    }
  }
  const missing = Array.isArray(value.missing)
    ? value.missing.map((item) => readText(item, 200)).filter(Boolean).slice(0, 8)
    : [];
  return {
    title: readText(value.title, 160) || "研究方案",
    sections: parsedSections,
    chainAudit: readText(value.chainAudit, 1200),
    scores,
    missing,
    evidenceIds: filterEvidenceIds(value.evidenceIds),
  };
}

interface ReviewPaperBrief {
  n: number;
  title: string;
  year: number;
  venue: string | null;
  abstract: string;
}

function readReviewPapers(value: unknown): ReviewPaperBrief[] {
  if (!Array.isArray(value)) return [];
  const papers: ReviewPaperBrief[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const title = readText(item.title, 200);
    const n = readNumber(item.n, 0);
    if (!title || n < 1) continue;
    papers.push({
      n,
      title,
      year: readNumber(item.year, 0),
      venue: readText(item.venue, 120) || null,
      abstract: readText(item.abstract, 700),
    });
    if (papers.length >= 28) break;
  }
  return papers;
}

function parseReview(value: unknown, maxN: number) {
  if (!isRecord(value) || !Array.isArray(value.sections)) return null;
  const sections: { heading: string; body: string }[] = [];
  for (const item of value.sections) {
    if (!isRecord(item)) continue;
    const heading = readText(item.heading, 80);
    const body = readText(item.body, 1200);
    if (!heading || !body) continue;
    sections.push({ heading, body });
    if (sections.length >= 8) break;
  }
  if (sections.length < 3) return null;
  return {
    title: readText(value.title, 160) || "文献综述草稿",
    sections,
    gaps: readText(value.gaps, 800),
    limitation: readText(value.limitation, 600),
    selfCheck: readText(value.selfCheck, 800),
    maxN,
  };
}

interface FeasibilityPaperBrief {
  n: number;
  title: string;
  year: number;
  venue: string | null;
  doi: string | null;
  abstract: string;
}

function readFeasibilityPapers(value: unknown): FeasibilityPaperBrief[] {
  if (!Array.isArray(value)) return [];
  const papers: FeasibilityPaperBrief[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const title = readText(item.title, 200);
    const n = readNumber(item.n, 0);
    if (!title || n < 1) continue;
    papers.push({
      n,
      title,
      year: readNumber(item.year, 0),
      venue: readText(item.venue, 120) || null,
      doi: readText(item.doi, 120) || null,
      abstract: readText(item.abstract, 500),
    });
    if (papers.length >= 12) break;
  }
  return papers;
}

function readCapability(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const clamp = (v: unknown, min: number, max: number, fallback: number) =>
    Math.min(max, Math.max(min, Math.round(readNumber(v, fallback))));
  return {
    weeklyHours: clamp(value.weeklyHours, 1, 80, 20),
    months: clamp(value.months, 1, 36, 6),
    coding: clamp(value.coding, 1, 5, 3),
    theory: clamp(value.theory, 1, 5, 2),
    compute: readText(value.compute, 40) || "未说明",
    data: readText(value.data, 40) || "未说明",
  };
}

const FEASIBILITY_DIMENSIONS = ["higher", "faster", "stronger", "cheaper", "broader"] as const;

function parseFeasibility(value: unknown, maxN: number) {
  if (!isRecord(value)) return null;
  const first = isRecord(value.firstImpression) ? value.firstImpression : null;
  const verdict = isRecord(value.verdict) ? value.verdict : null;
  const story = first ? readText(first.story, 200) : "";
  const decision = verdict ? readText(verdict.decision, 20) : "";
  if (!story || !verdict) return null;
  if (decision !== "accept" && decision !== "revise" && decision !== "reject") return null;

  const flaws: Record<string, string>[] = [];
  if (Array.isArray(value.flaws)) {
    for (const item of value.flaws) {
      if (!isRecord(item)) continue;
      const severity = readText(item.severity, 20);
      if (severity !== "critical" && severity !== "major" && severity !== "minor") continue;
      flaws.push({
        code: readText(item.code, 10),
        name: readText(item.name, 60),
        severity,
        detail: readText(item.detail, 400),
        defense: readText(item.defense, 400),
      });
      if (flaws.length >= 2) break;
    }
  }

  const lifecycleRaw = isRecord(value.lifecycle) ? value.lifecycle : {};
  const fit = readText(lifecycleRaw.fit, 10);
  const lifecycle = {
    category: readText(lifecycleRaw.category, 40) || "未分类",
    window: readText(lifecycleRaw.window, 40),
    fit: fit === "green" || fit === "yellow" || fit === "red" ? fit : "yellow",
    reason: readText(lifecycleRaw.reason, 400),
  };

  const dimRaw = Array.isArray(value.dimensions) ? value.dimensions.filter(isRecord) : [];
  const dimensions = FEASIBILITY_DIMENSIONS.map((key) => {
    const record = dimRaw.find((d) => readText(d.key, 20) === key);
    const basis = record ? readText(record.basis, 20) : "";
    return {
      key,
      score: Math.min(10, Math.max(1, Math.round(readNumber(record?.score, 5)))),
      basis: basis === "data" || basis === "mechanism" ? basis : "none",
      evidence: record ? readText(record.evidence, 400) : "模型未给出该维度依据",
    };
  });

  const paradigm: Record<string, string>[] = [];
  if (Array.isArray(value.paradigm)) {
    for (const item of value.paradigm) {
      if (!isRecord(item)) continue;
      const answer = readText(item.answer, 10);
      if (answer !== "yes" && answer !== "partial" && answer !== "no") continue;
      paradigm.push({
        probe: readText(item.probe, 40),
        answer,
        reason: readText(item.reason, 300),
      });
      if (paradigm.length >= 4) break;
    }
  }

  const risks: Record<string, string>[] = [];
  if (Array.isArray(value.risks)) {
    for (const item of value.risks) {
      if (!isRecord(item)) continue;
      const level = readText(item.level, 10);
      if (level !== "low" && level !== "medium" && level !== "high") continue;
      risks.push({
        kind: readText(item.kind, 30),
        level,
        mitigation: readText(item.mitigation, 300),
      });
      if (risks.length >= 4) break;
    }
  }

  const actions = Array.isArray(verdict.actions)
    ? verdict.actions.map((item) => readText(item, 200)).filter(Boolean).slice(0, 3)
    : [];

  return {
    firstImpression: { paperType: readText(first?.paperType, 30), story },
    flaws,
    lifecycle,
    dimensions,
    paradigm,
    risks,
    verdict: { decision, reason: readText(verdict.reason, 400), actions },
    limitation: readText(value.limitation, 600),
    maxN,
  };
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

function checkRateLimit(request: Request): boolean {
  const now = Date.now();
  if (instanceBudget.resetAt <= now) {
    instanceBudget = { count: 0, resetAt: now + INSTANCE_BUDGET_WINDOW_MS };
  }
  instanceBudget.count += 1;
  if (instanceBudget.count > INSTANCE_BUDGET_MAX) return false;
  const key = clientIp(request);
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
}

async function callModel(
  apiKey: string,
  systemPrompt: string,
  userPayload: unknown,
  maxTokens = 2048,
): Promise<{ content: string; truncated: boolean } | { error: string; status: number }> {
  const baseUrls = [Deno.env.get("QWEN_BASE_URL"), ...BASE_URL_CANDIDATES]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\/+$/, ""));
  const model = Deno.env.get("QWEN_MODEL") ?? DEFAULT_MODEL;

  const requestBody = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    temperature: 0.4,
    max_tokens: maxTokens,
    // 关掉思考模式：同样的提示词，带思考要 119 秒，关掉只要 7 秒
    enable_thinking: false,
  });

  let authFailed = false;
  let rateLimited = false;
  let timedOut = false;

  for (const baseUrl of baseUrls) {
    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      timedOut = true;
      break;
    }

    if (upstream.ok) {
      let body: unknown;
      try {
        body = await upstream.json();
      } catch {
        return { error: "upstream_error", status: 502 };
      }
      const content =
        isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0])
          ? (isRecord(body.choices[0].message)
              ? readText((body.choices[0].message as Record<string, unknown>).content, 20000)
              : "")
          : "";
      const finishReason =
        isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0])
          ? readText((body.choices[0] as Record<string, unknown>).finish_reason, 20)
          : "";
      upstreamAuthFailed = false;
      return { content, truncated: finishReason === "length" };
    }

    if (upstream.status === 401 || upstream.status === 403) {
      authFailed = true;
      continue;
    }
    if (upstream.status === 429) {
      rateLimited = true;
      break;
    }
    return { error: "upstream_error", status: 502 };
  }

  if (timedOut) return { error: "upstream_timeout", status: 503 };
  if (authFailed) {
    upstreamAuthFailed = true;
    return { error: "upstream_auth_failed", status: 502 };
  }
  if (rateLimited) return { error: "upstream_rate_limited", status: 503 };
  return { error: "upstream_error", status: 502 };
}

const ERROR_MESSAGE: Record<string, string> = {
  service_not_configured: "站点还没有配置模型 API key，这个功能暂时不可用。",
  upstream_auth_failed: "模型接口拒绝了服务端的 API key，请检查站点 Secret。",
  upstream_rate_limited: "模型接口当前限流，请稍后再试。",
  upstream_timeout: "模型这次响应超时，请稍后再试。",
  upstream_error: "模型接口暂时不可用，请稍后再试。",
  upstream_invalid_output: "模型这次没有给出可用格式的结果，请重试。",
  upstream_truncated: "模型这次输出超长被截断，请精简约束描述后重试。",
  rate_limited: "调用过于频繁，请过几分钟再试。",
  bad_request: "请求内容不完整或格式不对。",
};

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // 网关会把 /functions/v1/app 换成后端函数名并保留子路径，这里只取最后一段动作名
  const segments = url.pathname.split("/").filter(Boolean).filter((part) => part !== "app");
  const action = segments.length > 0 ? segments[segments.length - 1] : "directions";

  if (
    action !== "directions" &&
    action !== "plan" &&
    action !== "review" &&
    action !== "feasibility" &&
    action !== "chat" &&
    action !== "status"
  ) {
    return fail("not_found", "没有这个接口。", 404);
  }

  if (request.method === "GET" && action === "status") {
    return json(
      {
        ok: true,
        configured: Boolean(Deno.env.get("QWEN_API_KEY")),
        upstream: upstreamAuthFailed ? "auth_failed" : "ready",
      },
      200,
    );
  }

  if (request.method !== "POST") {
    return Response.json(
      {
        ok: false,
        error: "method_not_allowed",
        message: "这个接口只接受 POST。",
        upstream: upstreamAuthFailed ? "auth_failed" : "ready",
      },
      {
        status: 405,
        headers: { "Cache-Control": "no-store", Allow: "POST" },
      },
    );
  }

  if (!checkRateLimit(request)) {
    return fail("rate_limited", ERROR_MESSAGE.rate_limited, 429);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return fail("bad_request", "请求内容太大。", 413);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail("bad_request", "请求内容读不出来。", 400);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return fail("bad_request", "请求内容太大。", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("bad_request", "请求内容不是合法 JSON。", 400);
  }

  const payload = isRecord(body) ? body : null;
  const context = parseContext(payload?.context ?? body);
  if (!context) {
    return fail("bad_request", ERROR_MESSAGE.bad_request, 400);
  }

  const apiKey = Deno.env.get("QWEN_API_KEY");
  if (!apiKey) {
    return fail("service_not_configured", ERROR_MESSAGE.service_not_configured, 503);
  }

  const allowed = new Set(context.evidence.map((item) => item.id));

  if (action === "review") {
    const papers = readReviewPapers(payload?.papers);
    if (papers.length === 0) {
      return fail("bad_request", ERROR_MESSAGE.bad_request, 400);
    }
    const result = await callModel(apiKey, REVIEW_SYSTEM_PROMPT, { context, papers }, 4096);
    if ("error" in result) {
      return fail(result.error, ERROR_MESSAGE[result.error] ?? ERROR_MESSAGE.upstream_error, result.status);
    }
    const review = parseReview(extractJson(result.content), papers.length);
    if (!review) {
      return fail(
        result.truncated ? "upstream_truncated" : "upstream_invalid_output",
        ERROR_MESSAGE[result.truncated ? "upstream_truncated" : "upstream_invalid_output"],
        502,
      );
    }
    return json(
      {
        ok: true,
        model: Deno.env.get("QWEN_MODEL") ?? DEFAULT_MODEL,
        review,
        generatedAt: new Date().toISOString(),
      },
      200,
    );
  }

  if (action === "feasibility") {
    const idea = readText(payload?.idea, 1200);
    const capability = readCapability(payload?.capability);
    const papers = readFeasibilityPapers(payload?.papers);
    if (!idea || !capability || papers.length === 0) {
      return fail("bad_request", ERROR_MESSAGE.bad_request, 400);
    }
    const target = isRecord(payload?.target)
      ? {
          name: readText(payload.target.name, 60),
          verdict: readText(payload.target.verdict, 20),
          size: readNumber(payload.target.size, 0),
          sizeShare: readNumber(payload.target.sizeShare, 0),
          recentShare: readNumber(payload.target.recentShare, 0),
          medianYear: readNumber(payload.target.medianYear, 0),
          crowding: readNumber(payload.target.crowding, 0),
          reason: readText(payload.target.reason, 400),
        }
      : null;
    const result = await callModel(
      apiKey,
      FEASIBILITY_SYSTEM_PROMPT,
      { idea, capability, target, context, papers },
      6144,
    );
    if ("error" in result) {
      return fail(result.error, ERROR_MESSAGE[result.error] ?? ERROR_MESSAGE.upstream_error, result.status);
    }
    const checkup = parseFeasibility(extractJson(result.content), papers.length);
    if (!checkup) {
      return fail(
        result.truncated ? "upstream_truncated" : "upstream_invalid_output",
        ERROR_MESSAGE[result.truncated ? "upstream_truncated" : "upstream_invalid_output"],
        502,
      );
    }
    return json(
      {
        ok: true,
        model: Deno.env.get("QWEN_MODEL") ?? DEFAULT_MODEL,
        checkup,
        generatedAt: new Date().toISOString(),
      },
      200,
    );
  }

  if (action === "chat") {
    const messages = readChatMessages(payload?.messages);
    if (messages.length === 0) {
      return fail("bad_request", "请先输入一个问题。", 400);
    }
    const papers = readChatPapers(payload?.papers);
    const verifiedEvidence = readVerifiedEvidence(payload?.verifiedEvidence);
    const result = await callModel(
      apiKey,
      CHAT_SYSTEM_PROMPT,
      { context, papers, verifiedEvidence, messages },
      2048,
    );
    if ("error" in result) {
      return fail(result.error, ERROR_MESSAGE[result.error] ?? ERROR_MESSAGE.upstream_error, result.status);
    }
    const parsed = parseChat(extractJson(result.content));
    if (!parsed) {
      return fail("upstream_invalid_output", ERROR_MESSAGE.upstream_invalid_output, 502);
    }
    return json(
      { ok: true, model: Deno.env.get("QWEN_MODEL") ?? DEFAULT_MODEL, ...parsed, generatedAt: new Date().toISOString() },
      200,
    );
  }

  if (action === "plan") {
    const constraints = parseConstraints(payload?.constraints);
    const resources = parseResources(payload?.resources);
    const verifiedEvidence = readVerifiedEvidence(payload?.verifiedEvidence);
    const draftConclusions = readDraftConclusions(payload?.draftConclusions);
    const result = await callModel(
      apiKey,
      `${PLAN_SYSTEM_PROMPT}\n${PLAN_RESOURCE_RULE}`,
      {
        context,
        constraints,
        resources: resources.map((resource) => ({
          kind: RESOURCE_KIND_LABEL[resource.kind] ?? resource.kind,
          name: resource.name,
          status: RESOURCE_STATUS_LABEL[resource.status] ?? resource.status,
          url: resource.url,
          license: resource.license,
          accessCondition: resource.accessCondition,
        })),
        verifiedEvidence,
        draftConclusions,
      },
      8192,
    );
    if ("error" in result) {
      return fail(result.error, ERROR_MESSAGE[result.error] ?? ERROR_MESSAGE.upstream_error, result.status);
    }
    const plan = parsePlan(extractJson(result.content), allowed);
    if (!plan) {
      return fail(
        result.truncated ? "upstream_truncated" : "upstream_invalid_output",
        ERROR_MESSAGE[result.truncated ? "upstream_truncated" : "upstream_invalid_output"],
        502,
      );
    }
    return json(
      {
        ok: true,
        model: Deno.env.get("QWEN_MODEL") ?? DEFAULT_MODEL,
        plan,
        generatedAt: new Date().toISOString(),
      },
      200,
    );
  }

  const result = await callModel(apiKey, SYSTEM_PROMPT, context);
  if ("error" in result) {
    return fail(result.error, ERROR_MESSAGE[result.error] ?? ERROR_MESSAGE.upstream_error, result.status);
  }
  const suggestions = parseSuggestions(extractJson(result.content), allowed);
  if (suggestions.length === 0) {
    return fail("upstream_invalid_output", ERROR_MESSAGE.upstream_invalid_output, 502);
  }
  return json(
    { ok: true, model: Deno.env.get("QWEN_MODEL") ?? DEFAULT_MODEL, suggestions, generatedAt: new Date().toISOString() },
    200,
  );
}
