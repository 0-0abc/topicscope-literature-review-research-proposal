/**
 * 最小自动化回归（评审关键流程）：
 *   1. 检索去重          lib/data/dedup.ts        dedupPapers / withSnapshotProvenance
 *   2. 证据引用解析      lib/ai/directions.ts     parseSuggestions / resolveEvidence / isGrounded
 *   3. AI 方案输出校验   lib/ai/plan.ts           parsePlan / resolvePlanEvidence
 *   4. AI 综述质量门禁   lib/ai/review.ts         parseReview / reviewQualityGates
 *   5. 存档恢复合并      hooks/useEvidenceStore.ts mergeEvidenceNotes（纯函数，不调用 hook）
 *   6. handler 服务端检索 functions/handler.ts     status / search（OpenAlex 两批 + S2 合并、
 *                                                   429 退避重试、12h 共享缓存、Crossref 降级）
 *
 * 运行：node scripts/regression.mjs
 * 用 esbuild build API（write:false, bundle:true, platform:'node', format:'esm'，
 * alias 把 @ 映射到项目根）把上述模块打包成临时 ESM 后 import 断言。
 * 第 6 组单独打包自包含的 functions/handler.ts（platform:'neutral' + banner 注入 globalThis.Deno），
 * 并覆写 globalThis.fetch 按 hostname 分发上游 mock，全程不触网、不改任何源文件。
 * 不写 dist、不跑 vite build；临时目录用完即删。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 被测入口：名字 -> 相对项目根的源文件 */
const ENTRIES = [
  ["dedup", "lib/data/dedup.ts"],
  ["directions", "lib/ai/directions.ts"],
  ["plan", "lib/ai/plan.ts"],
  ["review", "lib/ai/review.ts"],
  ["evidence", "hooks/useEvidenceStore.ts"],
];

// ---------------------------------------------------------------------------
// 断言计数与分组（任何一组失败 => exit 1）
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  passed += 1;
}
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
}
function group(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push({ name, error });
  }
}

// ---------------------------------------------------------------------------
// 打包：内存产物 -> 临时 .mjs -> 动态 import（react 会被一并打包，不调用 hook）
// ---------------------------------------------------------------------------
async function loadModules() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ENTRIES.map(([name, file]) => ({ in: path.join(root, file), out: name })),
    outdir: "regression-out", // write:false，仅用于计算产物路径，不落盘到项目
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node18",
    alias: { "@": root },
    logLevel: "silent",
  });

  const tmp = await mkdtemp(path.join(tmpdir(), "qorder-regression-"));
  const mods = {};
  try {
    for (const file of result.outputFiles) {
      const name = path.basename(file.path, ".js");
      const dest = path.join(tmp, `${name}.mjs`);
      await writeFile(dest, file.contents);
      mods[name] = await import(pathToFileURL(dest).href);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  for (const [name] of ENTRIES) {
    if (!mods[name]) throw new Error(`打包产物缺少模块: ${name}`);
  }
  return mods;
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------
function makePaper(overrides = {}) {
  const { provenance, ...rest } = overrides;
  return {
    id: "https://openalex.org/W1",
    doi: null,
    title: "A Study of Testing",
    year: 2021,
    citedByCount: 3,
    type: "article",
    topics: [],
    keywords: [],
    venue: "Journal of Tests",
    abstract: null,
    authors: ["Ada Lovelace"],
    authorCount: 1,
    oaUrl: null,
    ...rest,
    provenance: {
      source: "openalex",
      sourceId: "W1",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      dedupKey: "id:openalex:W1",
      abstractAvailable: false,
      oaUrl: null,
      ...provenance,
    },
  };
}

function makeNote(paperId, over = {}) {
  return {
    paperId,
    fields: {},
    verifiedFields: [],
    fieldMeta: {},
    fullTextVerified: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const SUGGESTION = {
  title: " 方向A ",
  question: "要解决什么问题",
  why: "为什么现在做",
  entry: "切入方式",
  evidence: "需要的数据与基线",
  cost: "算力与时间",
  risk: "最大不确定性",
  feasibility: 4.6,
  evidenceIds: ["corpus:size", "", 42, "cluster:a:size"],
};

const SUGGESTION_BASE = {
  title: "t", question: "q", why: "w", entry: "e",
  evidence: "ev", cost: "c", risk: "r", feasibility: 3,
};

// ---------------------------------------------------------------------------
// 1. 检索去重 lib/data/dedup.ts
// ---------------------------------------------------------------------------
function testDedup({ dedupPapers, withSnapshotProvenance }) {
  group("dedup: 空输入", () => {
    eq(dedupPapers([]), { papers: [], removed: 0 });
  });

  group("dedup: 重复 DOI 保留先出现的一篇", () => {
    const first = makePaper({
      title: "Alpha Paper",
      provenance: { source: "openalex", sourceId: "W100", dedupKey: "doi:10.1234/alpha" },
    });
    const second = makePaper({
      title: "Beta Paper（题名不同但 DOI 相同）",
      year: 2022,
      provenance: { source: "crossref", sourceId: "cr-9", dedupKey: "doi:10.1234/alpha" },
    });
    const result = dedupPapers([first, second]);
    eq(result.papers.length, 1);
    eq(result.removed, 1);
    ok(result.papers[0] === first, "应保留先出现的论文（first-wins）");
  });

  group("dedup: 题名+年份重复（大小写/标点差异，DOI 不同）", () => {
    const first = makePaper({
      title: "Graph Neural Networks for Molecules",
      year: 2020,
      provenance: { source: "openalex", sourceId: "W200", dedupKey: "id:openalex:W200" },
    });
    const second = makePaper({
      title: "graph neural networks for molecules!",
      year: 2020,
      provenance: { source: "crossref", sourceId: "cr-1", dedupKey: "doi:10.9999/other" },
    });
    const result = dedupPapers([first, second]);
    eq(result.papers.length, 1);
    eq(result.removed, 1);
    ok(result.papers[0] === first, "归一化题名相同即视为同一篇，保留先出现者");
  });

  group("dedup: 同来源唯一 ID 重复", () => {
    const first = makePaper({
      title: "Unique Title One",
      provenance: { source: "openalex", sourceId: "W300", dedupKey: "id:openalex:W300" },
    });
    const second = makePaper({
      title: "Unique Title Two",
      provenance: { source: "openalex", sourceId: "W300", dedupKey: "doi:10.5555/different" },
    });
    const result = dedupPapers([first, second]);
    eq(result.papers.length, 1);
    eq(result.removed, 1);
    ok(result.papers[0] === first);
  });

  group("dedup: 互不重复的论文全部保留且顺序不变", () => {
    const papers = [1, 2, 3].map((i) =>
      makePaper({
        title: `Distinct Title ${i}`,
        provenance: { sourceId: `W${400 + i}`, dedupKey: `id:openalex:W${400 + i}` },
      }),
    );
    const result = dedupPapers(papers);
    eq(result.removed, 0);
    eq(result.papers, papers);
  });

  group("dedup: 空题名不参与兜底匹配", () => {
    const papers = [601, 602].map((i) =>
      makePaper({
        title: "!!!",
        provenance: { sourceId: `W${i}`, dedupKey: `id:openalex:W${i}` },
      }),
    );
    const result = dedupPapers(papers);
    eq(result.papers.length, 2, "归一化题名为空时不应互相误判为重复");
    eq(result.removed, 0);
  });

  group("dedup: DOI/来源ID/题名 混合场景", () => {
    const a = makePaper({
      title: "Deep Learning for Graphs",
      provenance: { source: "openalex", sourceId: "W500", dedupKey: "doi:10.1/x" },
    });
    const b = makePaper({
      title: "Another Title",
      provenance: { source: "crossref", sourceId: "cr-5", dedupKey: "doi:10.1/x" },
    });
    const c = makePaper({
      title: "deep learning for graphs!",
      provenance: { source: "crossref", sourceId: "cr-6", dedupKey: "id:crossref:cr-6" },
    });
    const d = makePaper({
      title: "Totally Different",
      provenance: { source: "openalex", sourceId: "W501", dedupKey: "id:openalex:W501" },
    });
    const e = makePaper({
      title: "Yet Another Different",
      provenance: { source: "openalex", sourceId: "W501", dedupKey: "doi:10.7777/e" },
    });
    const result = dedupPapers([a, b, c, d, e]);
    eq(result.papers, [a, d]);
    eq(result.removed, 3);
  });

  group("dedup: withSnapshotProvenance 补齐去重键", () => {
    const meta = { domain: "测试域", generatedAt: "2026-02-02T00:00:00.000Z", filters: "year:2020-2026" };
    const out = withSnapshotProvenance(
      [
        makePaper({ id: "https://openalex.org/W42", doi: "https://doi.org/10.1234/ABC.", abstract: "有摘要" }),
        makePaper({ id: "https://openalex.org/W43", doi: null, abstract: null }),
      ],
      meta,
    );
    eq(out[0].doi, "10.1234/abc", "DOI 应规范化为小写裸 DOI");
    eq(out[0].provenance.dedupKey, "doi:10.1234/abc");
    eq(out[0].provenance.source, "snapshot");
    eq(out[0].provenance.retrievedAt, meta.generatedAt);
    eq(out[0].provenance.query, "测试域");
    eq(out[0].provenance.abstractAvailable, true);
    eq(out[1].provenance.sourceId, "W43", "应剥掉 openalex.org 前缀");
    eq(out[1].provenance.dedupKey, "id:snapshot:W43");
    eq(out[1].provenance.abstractAvailable, false);
  });

  group("dedup: 快照补齐后跨形态 DOI 可去重", () => {
    const meta = { domain: "d", generatedAt: "2026-02-02T00:00:00.000Z", filters: "f" };
    const snap = withSnapshotProvenance(
      [
        makePaper({ id: "https://openalex.org/W700", doi: "https://doi.org/10.1234/ABC." }),
        makePaper({ id: "https://openalex.org/W701", doi: "doi:10.1234/abc" }),
      ],
      meta,
    );
    eq(snap[0].provenance.dedupKey, snap[1].provenance.dedupKey);
    const result = dedupPapers(snap);
    eq(result.papers.length, 1);
    eq(result.removed, 1);
  });
}

// ---------------------------------------------------------------------------
// 2. 证据引用解析 lib/ai/directions.ts
// ---------------------------------------------------------------------------
function testDirections({ parseSuggestions, resolveEvidence, isGrounded, buildDirectionContext }) {
  group("directions: parseSuggestions 非法输入返回空数组", () => {
    eq(parseSuggestions(null), []);
    eq(parseSuggestions("文本"), []);
    eq(parseSuggestions({}), []);
    eq(parseSuggestions({ suggestions: "不是数组" }), []);
  });

  group("directions: parseSuggestions 过滤缺字段/非法评分/非对象条目", () => {
    const parsed = parseSuggestions({
      suggestions: [
        SUGGESTION,
        null,
        "x",
        { ...SUGGESTION, why: "   " },
        { ...SUGGESTION, feasibility: "高" },
      ],
    });
    eq(parsed.length, 1);
    eq(parsed[0].title, "方向A", "文本字段应 trim");
    eq(parsed[0].feasibility, 5, "4.6 四舍五入并夹到 1–5");
    eq(parsed[0].evidenceIds, ["corpus:size", "cluster:a:size"], "非字符串/空 ID 应被过滤");
  });

  group("directions: parseSuggestions feasibility 夹取与缺省", () => {
    const parsed = parseSuggestions({
      suggestions: [
        { ...SUGGESTION, feasibility: 0.2 },
        { ...SUGGESTION, feasibility: 9 },
        { ...SUGGESTION, feasibility: 3.4 },
      ],
    });
    eq(parsed.map((s) => s.feasibility), [1, 5, 3]);
    const { feasibility, ...noFeasibility } = SUGGESTION;
    eq(parseSuggestions({ suggestions: [noFeasibility] }), [], "缺 feasibility 的条目应被丢弃");
  });

  group("directions: parseSuggestions evidenceIds 上限 8 条", () => {
    const parsed = parseSuggestions({
      suggestions: [
        { ...SUGGESTION, evidenceIds: Array.from({ length: 12 }, (_, i) => `id:${i}`) },
        { ...SUGGESTION, evidenceIds: "corpus:size" },
      ],
    });
    eq(parsed[0].evidenceIds.length, 8);
    eq(parsed[0].evidenceIds[0], "id:0");
    eq(parsed[1].evidenceIds, [], "非数组 evidenceIds 应为空");
  });

  const evidence = [
    { id: "corpus:size", kind: "corpus", label: "样本规模", value: "120 篇", origin: "检索快照" },
    { id: "cluster:graph-learning:size", kind: "cluster", label: "方向规模", value: "30 篇", origin: "方向雷达" },
  ];
  const context = { query: "q", corpus: {}, clusters: [], pairs: [], evidence };

  group("directions: resolveEvidence 已知/未知 ID 分流", () => {
    const resolved = resolveEvidence(
      ["cluster:graph-learning:size", "corpus:size", "cluster:编造的:size"],
      context,
    );
    eq(resolved.items.map((i) => i.id), ["cluster:graph-learning:size", "corpus:size"]);
    eq(resolved.unknown, ["cluster:编造的:size"], "模型编造的引用必须被标出");
    eq(resolveEvidence([], context), { items: [], unknown: [] });
  });

  group("directions: isGrounded 匹配/不匹配/空引用", () => {
    ok(isGrounded({ ...SUGGESTION_BASE, evidenceIds: ["corpus:size"] }, context), "全部已知 => true");
    ok(
      !isGrounded({ ...SUGGESTION_BASE, evidenceIds: ["corpus:size", "fake:id"] }, context),
      "含未知 ID => false",
    );
    ok(!isGrounded({ ...SUGGESTION_BASE, evidenceIds: [] }, context), "零引用 => false");
  });

  group("directions: buildDirectionContext 生成的证据 ID 可回查", () => {
    const radar = {
      yearRange: [2018, 2026],
      clusterCount: 1,
      clusters: [
        {
          id: 0,
          name: "Graph Learning",
          verdict: "emerging",
          verdictReason: "增长",
          size: 30,
          sizeShare: 0.25,
          yearRange: [2019, 2026],
          medianYear: 2023,
          recentShare: 0.4,
          fiveYearShare: 0.8,
          citationMedian: 12,
          crowding: 55,
          terms: ["graph", "learning"],
          topVenues: [{ name: "NeurIPS", count: 5 }],
          topPapers: [{ title: "P1", year: 2024, venue: "NeurIPS", citedByCount: 20 }],
          paperIds: ["W1"],
        },
      ],
    };
    const graph = { edges: [{ source: "graph", target: "learning", lift: 3, weight: 7 }] };
    const clusterPairs = new Map([[0, [{ a: "graph", b: "learning", lift: 3, count: 7 }]]]);
    const ctx = buildDirectionContext("图学习", radar, graph, clusterPairs, {
      abstractCoverage: 60,
      oaCoverage: 40,
    });
    eq(ctx.corpus.size, 30);
    const ids = ctx.evidence.map((i) => i.id);
    ok(ids.includes("corpus:size"));
    ok(ids.includes("cluster:graph-learning:size"), "方向名应 slug 化进证据 ID");
    ok(ids.includes("cluster:graph-learning:crowding"));
    ok(ids.includes("pair:graph-learning:lift"));
    eq(ctx.clusters[0].pairs.length, 1);
    const resolved = resolveEvidence(["cluster:graph-learning:size", "cluster:does-not-exist:size"], ctx);
    eq(resolved.items.length, 1);
    eq(resolved.unknown, ["cluster:does-not-exist:size"]);
    ok(isGrounded({ ...SUGGESTION_BASE, evidenceIds: ["cluster:graph-learning:size"] }, ctx));
    ok(!isGrounded({ ...SUGGESTION_BASE, evidenceIds: ["cluster:does-not-exist:size"] }, ctx));
  });
}

// ---------------------------------------------------------------------------
// 3. AI 方案输出校验 lib/ai/plan.ts
// ---------------------------------------------------------------------------
function testPlan({ parsePlan, resolvePlanEvidence, PLAN_SECTIONS, SCORE_DIMENSIONS }) {
  group("plan: parsePlan 非法输入返回 null", () => {
    eq(parsePlan(null), null);
    eq(parsePlan("x"), null);
    eq(parsePlan(42), null);
    eq(parsePlan([]), null);
    eq(parsePlan({}), null, "缺 sections => null");
    eq(parsePlan({ sections: "不是对象" }), null);
  });

  group("plan: parsePlan 合法输入规范化", () => {
    const plan = parsePlan({
      title: "  方案标题  ",
      sections: { problem: " 问题 ", references: " [1] " },
      chainAudit: " 链 ",
      scores: [
        { dimension: "证据充分度", score: 4.6, reason: " 理由 " },
        { dimension: "", score: 3 },
        { dimension: "资源可行性", score: "NaN" },
        null,
      ],
      missing: [" 算力 ", "", "  "],
      evidenceIds: ["corpus:size", 42, "", "cluster:a:size"],
    });
    ok(plan);
    eq(plan.title, "方案标题");
    eq(plan.sections.problem, "问题");
    eq(plan.sections.references, "[1]");
    eq(plan.sections.method, "", "缺失小节应补空串");
    eq(Object.keys(plan.sections).length, PLAN_SECTIONS.length, "15 个小节键必须齐全");
    eq(plan.chainAudit, "链");
    eq(plan.scores.length, SCORE_DIMENSIONS.length, "五个评分维度必须齐全");
    const byDim = Object.fromEntries(plan.scores.map((s) => [s.dimension, s]));
    eq(byDim["证据充分度"].score, 5, "4.6 => 5");
    eq(byDim["证据充分度"].reason, "理由");
    eq(byDim["资源可行性"].score, 0, "非法评分条目应被丢弃并补 0");
    eq(byDim["资源可行性"].reason, "模型未给出该维度评分");
    eq(plan.missing, ["算力"]);
    eq(plan.evidenceIds, ["corpus:size", "cluster:a:size"]);
  });

  group("plan: parsePlan 缺省值与夹取", () => {
    const bare = parsePlan({ sections: {} });
    ok(bare);
    eq(bare.title, "研究方案");
    eq(bare.missing, []);
    eq(bare.evidenceIds, []);
    eq(bare.scores.length, SCORE_DIMENSIONS.length);
    ok(bare.scores.every((s) => s.score === 0));
    const clamped = parsePlan({
      sections: {},
      scores: [
        { dimension: "风险可控性", score: -3 },
        { dimension: "基线可获得性", score: 99 },
      ],
      missing: Array.from({ length: 12 }, (_, i) => `m${i}`),
      evidenceIds: Array.from({ length: 15 }, (_, i) => `id:${i}`),
    });
    const byDim = Object.fromEntries(clamped.scores.map((s) => [s.dimension, s.score]));
    eq(byDim["风险可控性"], 0);
    eq(byDim["基线可获得性"], 5);
    eq(clamped.missing.length, 10, "missing 上限 10");
    eq(clamped.evidenceIds.length, 12, "evidenceIds 上限 12");
  });

  group("plan: resolvePlanEvidence 未知 ID 进 unknown", () => {
    const evidence = [
      { id: "corpus:size", kind: "corpus", label: "l", value: "v", origin: "o" },
      { id: "pair:a-b:lift", kind: "pair", label: "l", value: "2", origin: "o" },
    ];
    const resolved = resolvePlanEvidence(["pair:a-b:lift", "corpus:size", "made:up"], evidence);
    eq(resolved.items.map((i) => i.id), ["pair:a-b:lift", "corpus:size"]);
    eq(resolved.unknown, ["made:up"]);
    eq(resolvePlanEvidence([], evidence), { items: [], unknown: [] });
  });
}

// ---------------------------------------------------------------------------
// 4. AI 综述输出校验与质量门禁 lib/ai/review.ts
// ---------------------------------------------------------------------------
function testReview({ parseReview, reviewQualityGates }) {
  group("review: parseReview 非法输入返回 null", () => {
    eq(parseReview(null), null);
    eq(parseReview("x"), null);
    eq(parseReview({}), null);
    eq(parseReview({ sections: [] }), null);
    eq(parseReview({ sections: [null, "x", { heading: "h" }, { body: "b" }] }), null);
  });

  group("review: parseReview 合法输入与缺省值", () => {
    const minimal = parseReview({ sections: [{ heading: "现状", body: "正文 [1]" }] });
    ok(minimal);
    eq(minimal.title, "文献综述草稿");
    eq(minimal.maxN, 0);
    eq(minimal.gaps, "");
    eq(minimal.limitation, "");
    eq(minimal.selfCheck, "");
    eq(minimal.sections, [{ heading: "现状", body: "正文 [1]" }]);
    const full = parseReview({
      title: "T",
      sections: [{ heading: "h", body: "b" }, null, { heading: "x", body: 42 }],
      gaps: "g",
      limitation: "l",
      selfCheck: "s",
      maxN: 5,
    });
    eq(full.sections.length, 1, "非法小节应被跳过");
    eq(full.title, "T");
    eq(full.maxN, 5);
  });

  group("review: 门禁 无效引用/无引用段落/过度断言 => insufficient/suspected", () => {
    const dirty = {
      title: "脏综述",
      maxN: 2,
      gaps: "",
      limitation: "",
      selfCheck: "",
      sections: [
        { heading: "A", body: "该方法证明了其唯一优势，是首个此类工作 [9]。" },
        { heading: "B", body: "这一段没有任何文献支撑。" },
      ],
    };
    const gates = reviewQualityGates(dirty);
    eq(gates.map((g) => g.name), ["引用门禁", "交织门禁", "分寸门禁"]);
    const [citation, weaving, calibration] = gates;
    eq(citation.verdict, "insufficient", "[9] 超出 maxN=2");
    eq(weaving.verdict, "suspected", "没有小节同时比较两篇以上文献");
    eq(calibration.verdict, "suspected", "证明/唯一/首个 属于强断言词");
    ok(calibration.detail.includes("证明"));
  });

  group("review: 门禁 [0] 也是无效编号", () => {
    const review = {
      title: "t", maxN: 1, gaps: "", limitation: "", selfCheck: "",
      sections: [{ heading: "A", body: "引用 [0] 与 [1]。" }],
    };
    eq(reviewQualityGates(review)[0].verdict, "insufficient");
  });

  group("review: 门禁 编号合法但有小节无引用 => suspected", () => {
    const review = {
      title: "t", maxN: 2, gaps: "", limitation: "", selfCheck: "",
      sections: [
        { heading: "A", body: "比较 [1] 与 [2] 的结果。" },
        { heading: "B", body: "无引用段落。" },
      ],
    };
    const gates = reviewQualityGates(review);
    eq(gates[0].verdict, "suspected");
    eq(gates[1].verdict, "clear", "A 小节含两篇对比，交织门禁通过");
    eq(gates[2].verdict, "clear");
  });

  group("review: 门禁 gaps 参与引用与断言检查", () => {
    const review = {
      title: "t", maxN: 1, gaps: "彻底解决所有问题 [3]", limitation: "", selfCheck: "",
      sections: [{ heading: "A", body: "正文 [1]。" }],
    };
    const gates = reviewQualityGates(review);
    eq(gates[0].verdict, "insufficient", "gaps 里的 [3] 超出 maxN");
    eq(gates[2].verdict, "suspected", "gaps 里的强断言词也应被检出");
  });

  group("review: 门禁 干净输入 => 全部 clear", () => {
    const clean = {
      title: "干净综述",
      maxN: 3,
      gaps: "仍有空白 [1]。",
      limitation: "",
      selfCheck: "",
      sections: [
        { heading: "对比", body: "方法一 [1] 与方法二 [2] 在准确率上各有优劣，样本规模不同 [3]。" },
        { heading: "脉络", body: "早期工作 [1] 为后续 [2] 提供了基础。" },
      ],
    };
    eq(reviewQualityGates(clean).map((g) => g.verdict), ["clear", "clear", "clear"]);
  });

  group("review: parseReview -> reviewQualityGates 串联", () => {
    const parsed = parseReview({
      sections: [{ heading: "A", body: "这一结论证明了 [5] 的正确性。" }],
      maxN: 2,
    });
    ok(parsed);
    const gates = reviewQualityGates(parsed);
    eq(gates[0].verdict, "insufficient");
    eq(gates[2].verdict, "suspected");
  });
}

// ---------------------------------------------------------------------------
// 5. 存档恢复合并 hooks/useEvidenceStore.ts -> mergeEvidenceNotes（纯函数）
// ---------------------------------------------------------------------------
function testEvidenceMerge({ mergeEvidenceNotes, EVIDENCE_FIELDS, useEvidenceStore }) {
  group("evidence: 模块加载成功且不调用 hook", () => {
    eq(EVIDENCE_FIELDS.length, 10);
    eq(typeof useEvidenceStore, "function");
    eq(typeof mergeEvidenceNotes, "function");
  });

  group("evidence: 空 incoming / 空 keep 边界", () => {
    eq(mergeEvidenceNotes({}, {}), {});
    const keepOnly = { p1: makeNote("p1", { fields: { method: "m" } }) };
    const mergedKeep = mergeEvidenceNotes(keepOnly, {});
    eq(mergedKeep, keepOnly);
    ok(mergedKeep.p1 === keepOnly.p1, "incoming 缺该篇时直接保留 keep 侧对象");
    const incomingOnly = { p2: makeNote("p2") };
    eq(mergeEvidenceNotes({}, incomingOnly), incomingOnly);
  });

  const keep = {
    p1: makeNote("p1", {
      fields: { method: "keep方法", results: "keep结果" },
      verifiedFields: ["method", "results"],
      fieldMeta: { method: { verifiedAt: "2026-01-01T00:00:00.000Z", location: "第3节" } },
      fullTextVerified: false,
    }),
    p2: makeNote("p2", { fields: { data: "keep数据" } }),
  };
  const incoming = {
    p1: makeNote("p1", {
      fields: { method: "incoming方法", data: "incoming数据" },
      verifiedFields: ["method", "data"],
      fieldMeta: {
        method: { verifiedAt: "2025-12-01T00:00:00.000Z", location: "图2" },
        data: { verifiedAt: "2025-12-01T00:00:00.000Z" },
      },
      fullTextVerified: true,
    }),
    p3: makeNote("p3", { fields: { metrics: "incoming指标" } }),
  };

  group("evidence: 同篇同字段冲突保留 keep 侧，其余并入", () => {
    const t0 = new Date().toISOString();
    const merged = mergeEvidenceNotes(keep, incoming);
    eq(Object.keys(merged).sort(), ["p1", "p2", "p3"]);
    eq(merged.p1.fields, { method: "keep方法", results: "keep结果", data: "incoming数据" });
    eq(merged.p1.fieldMeta.method.location, "第3节", "fieldMeta 冲突同样保留 keep 侧");
    eq(merged.p1.fieldMeta.data, { verifiedAt: "2025-12-01T00:00:00.000Z" });
    eq(merged.p1.paperId, "p1");
    eq(merged.p2.fields, { data: "keep数据" }, "keep 独有篇目应保留");
    eq(merged.p3.fields, { metrics: "incoming指标" }, "incoming 独有篇目应并入");
    ok(merged.p1.updatedAt >= t0, "合并后 updatedAt 应刷新");
  });

  group("evidence: verifiedFields 取并集且去重", () => {
    const merged = mergeEvidenceNotes(keep, incoming);
    eq(merged.p1.verifiedFields, ["method", "data", "results"]);
    const deduped = mergeEvidenceNotes(
      { p: makeNote("p", { verifiedFields: ["method"] }) },
      { p: makeNote("p", { verifiedFields: ["method", "data"] }) },
    );
    eq(deduped.p.verifiedFields, ["method", "data"]);
  });

  group("evidence: fullTextVerified 取 OR", () => {
    const merged = mergeEvidenceNotes(keep, incoming);
    eq(merged.p1.fullTextVerified, true, "incoming 已核对全文 => true");
    const other = mergeEvidenceNotes(
      { p: makeNote("p", { fullTextVerified: true }) },
      { p: makeNote("p", { fullTextVerified: false }) },
    );
    eq(other.p.fullTextVerified, true, "keep 已核对全文 => true");
  });

  group("evidence: 合并不修改输入（存档恢复安全）", () => {
    const keepSnapshot = JSON.parse(JSON.stringify(keep));
    const incomingSnapshot = JSON.parse(JSON.stringify(incoming));
    mergeEvidenceNotes(keep, incoming);
    eq(keep, keepSnapshot);
    eq(incoming, incomingSnapshot);
  });
}

// ---------------------------------------------------------------------------
// 6. handler 服务端检索 functions/handler.ts（自包含 Deno 风格函数，不 import lib）
//    esbuild bundle（platform:'neutral'）+ banner 注入 globalThis.Deno，
//    覆写 globalThis.fetch 按 hostname 分发 OpenAlex / Semantic Scholar / Crossref mock。
//    每个 case 用不同 query，避免 12h 共享缓存串扰；S2 持续 429 会真实退避等待 2 秒。
// ---------------------------------------------------------------------------

/** 异步分组：与同步 group 共用 passed / failures 计数 */
async function groupAsync(name, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push({ name, error });
  }
}

const DENO_BANNER =
  `globalThis.Deno = { env: { get: (k) => ({ QWEN_API_KEY: "t", OA_API_KEY: "t" }[k]) }, serve: () => {} };`;

/** 打包自包含 handler：内存产物 -> 临时 .mjs -> 动态 import（不落盘到项目） */
async function loadHandler() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "functions/handler.ts")],
    outfile: "handler-regression.mjs", // write:false，仅用于计算产物路径
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    banner: { js: DENO_BANNER },
    logLevel: "silent",
  });
  const tmp = await mkdtemp(path.join(tmpdir(), "qorder-handler-regression-"));
  try {
    const dest = path.join(tmp, "handler.mjs");
    await writeFile(dest, result.outputFiles[0].contents);
    const mod = await import(pathToFileURL(dest).href);
    if (typeof mod.handler !== "function") throw new Error("handler 打包产物缺少 handler 导出");
    return mod.handler;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// --- 上游 mock 夹具（字段照 handler 的 OpenAlexWork / S2Work / CrossrefItem 接口） ---
function oaWork({ n, title, doi, withAbstract, withOa }) {
  const pdf = withOa ? `https://example.com/oa/${n}.pdf` : null;
  return {
    id: `https://openalex.org/W${n}`,
    doi,
    title,
    publication_year: 2023,
    cited_by_count: 100 - n,
    type: "article",
    topics: [{ display_name: "Machine Learning" }],
    keywords: [{ display_name: "graph" }],
    primary_location: {
      source: { display_name: "Journal A" },
      landing_page_url: `https://example.com/land/${n}`,
    },
    abstract_inverted_index: withAbstract
      ? Object.fromEntries(["segmentation", "model", "results"].map((w, j) => [w, [j]]))
      : null,
    authorships: [{ author: { display_name: "Alice" } }],
    open_access: { oa_url: pdf },
    best_oa_location: { landing_page_url: null, pdf_url: pdf },
  };
}

function s2Work({ id, title, doi, abstract, pdf }) {
  return {
    paperId: id,
    title,
    abstract,
    year: 2024,
    citationCount: 50,
    venue: "Venue S2",
    externalIds: doi ? { DOI: doi } : null,
    openAccessPdf: pdf ? { url: pdf } : null,
    fieldsOfStudy: ["Computer Science"],
    authors: [{ name: "Bob" }],
  };
}

function crItem({ doi, title, withAbstract, withPdf }) {
  return {
    DOI: doi,
    title: [title],
    issued: { "date-parts": [[2022]] },
    "is-referenced-by-count": 7,
    "container-title": ["Journal C"],
    abstract: withAbstract
      ? "<jats:p>Crossref 降级返回的摘要正文，长度超过四十字符以便被服务端接受为有效摘要文本。</jats:p>"
      : undefined,
    link: withPdf ? [{ URL: `https://crossref.org/${doi}.pdf`, "content-type": "application/pdf" }] : [],
    URL: `https://crossref.org/${doi}`,
    author: [{ given: "Ada", family: "Lovelace" }],
    type: "journal-article",
  };
}

const GNN_TITLE = "Graph Neural Networks for Molecules";
const FILL_TITLE = "Federated Learning at Scale";
const S2_NEW_TITLE = "Retrieval Augmented Generation Survey";
const S2_FILL_PDF = "https://s2.org/fill.pdf";

/** 高被引批：3 篇（W2 缺摘要且无 OA，W1/W3 有摘要） */
const OA_CLASSIC = [
  oaWork({ n: 1, title: GNN_TITLE, doi: "https://doi.org/10.1000/gnn", withAbstract: true, withOa: false }),
  oaWork({ n: 2, title: FILL_TITLE, doi: null, withAbstract: false, withOa: false }),
  oaWork({ n: 3, title: "Diffusion Models Survey", doi: "https://doi.org/10.1000/diff", withAbstract: true, withOa: true }),
];
/** 最新批：W3 与高被引批同 id（handler 内部按 id 合并）+ W4 与 W1 标题重复（serverDedup 移除） */
const OA_RECENT = [
  OA_CLASSIC[2],
  oaWork({ n: 4, title: GNN_TITLE, doi: null, withAbstract: false, withOa: false }),
];
/** S2：1 篇同 DOI/标题重复 + 1 篇补摘要补 OA + 1 篇全新 */
const S2_PAPERS = [
  s2Work({ id: "s2-dup", title: "graph neural networks for molecules!", doi: "10.1000/GNN", abstract: "S2 重复篇摘要", pdf: null }),
  s2Work({ id: "s2-fill", title: FILL_TITLE, doi: null, abstract: "S2 补齐的联邦学习摘要", pdf: S2_FILL_PDF }),
  s2Work({ id: "s2-new", title: S2_NEW_TITLE, doi: null, abstract: "S2 新增论文摘要", pdf: "https://s2.org/new.pdf" }),
];
/** Crossref：2 篇有效 + 1 篇同 DOI 重复（去重移除 1 篇） */
const CROSSREF_ITEMS = [
  crItem({ doi: "10.2000/cr1", title: "Crossref Fallback Paper One", withAbstract: true, withPdf: true }),
  crItem({ doi: "10.2000/cr2", title: "Crossref Fallback Paper Two", withAbstract: false, withPdf: false }),
  crItem({ doi: "10.2000/cr1", title: "Crossref Fallback Paper One Duplicate", withAbstract: true, withPdf: true }),
];

const UPSTREAM_HOSTS = ["api.openalex.org", "api.semanticscholar.org", "api.crossref.org"];

/** 覆写 globalThis.fetch：按 hostname 分发，scenario 可切换 S2 429 / OpenAlex 500 或抛错 */
function installUpstreamMock() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const scenario = { openalex: "ok", s2: "ok" };
  globalThis.fetch = async (input) => {
    const href = String(input);
    calls.push(href);
    const url = new URL(href);
    if (url.hostname === "api.openalex.org") {
      if (scenario.openalex === "throw") throw new Error("mock: OpenAlex 网络不可达");
      if (scenario.openalex === "500") return new Response("upstream boom", { status: 500 });
      const sort = url.searchParams.get("sort") ?? "";
      const works = sort.startsWith("publication_date") ? OA_RECENT : OA_CLASSIC;
      return Response.json({ results: works, meta: { count: works.length } });
    }
    if (url.hostname === "api.semanticscholar.org") {
      if (scenario.s2 === "429") return new Response("rate limited", { status: 429 });
      return Response.json({ data: S2_PAPERS, total: S2_PAPERS.length });
    }
    if (url.hostname === "api.crossref.org") {
      return Response.json({ message: { items: CROSSREF_ITEMS, "total-results": CROSSREF_ITEMS.length } });
    }
    throw new Error(`回归 mock 未覆盖的上游请求: ${href}`);
  };
  return {
    calls,
    scenario,
    countCalls(host) {
      return calls.filter((href) => new URL(href).hostname === host).length;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/** 与 handler 一致的标题归一化，用于断言「重复标题只留一篇」 */
function normTitle(value) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "").trim();
}

async function testHandlerServer() {
  let handler;
  try {
    handler = await loadHandler();
  } catch (error) {
    failures.push({ name: "handler: 打包并加载自包含服务端", error });
    return;
  }

  const mock = installUpstreamMock();
  const originalDeno = globalThis.Deno;
  const search = async (q, extra = "") => {
    const res = await handler(
      new Request(`https://site.test/functions/v1/app/search?q=${encodeURIComponent(q)}${extra}`),
    );
    return { status: res.status, body: await res.json() };
  };
  // 每个 case 独立 query，避免共享缓存串扰
  const Q_MERGE = "regression merge graph learning";
  const Q_429 = "regression s2 rate limited";
  const Q_FRESH = "regression cache probe";
  const Q_CR_500 = "regression crossref http500";
  const Q_CR_THROW = "regression crossref network";
  let mergeCount = 0;

  try {
    await groupAsync("handler: status 报告服务端 key 配置", async () => {
      const res = await handler(new Request("https://site.test/functions/v1/app/status"));
      const body = await res.json();
      eq(res.status, 200);
      eq(body.ok, true);
      eq(body.configured, true, "注入 QWEN_API_KEY => configured");
      eq(body.oaConfigured, true, "注入 OA_API_KEY => oaConfigured");
      eq(body.upstream, "ready");
    });

    await groupAsync("handler: 缺检索词 400 / 未知动作 404", async () => {
      const missing = await handler(new Request("https://site.test/functions/v1/app/search"));
      eq(missing.status, 400);
      eq((await missing.json()).error, "bad_request");
      const unknown = await handler(new Request("https://site.test/functions/v1/app/nope"));
      eq(unknown.status, 404);
    });

    await groupAsync("handler: S2 成功 => 新增一篇/补齐摘要与 OA/重复标题只留一篇", async () => {
      mock.scenario.openalex = "ok";
      mock.scenario.s2 = "ok";
      const { status, body } = await search(Q_MERGE);
      eq(status, 200);
      eq(body.ok, true);
      eq(body.cached, false);
      eq(body.degraded, false);
      eq(body.source, "openalex");
      const papers = body.papers;
      mergeCount = papers.length;
      eq(papers.length, 4, "OpenAlex 两批按 id 合并 4 篇 + S2 新增 1 篇 - 标题重复 1 篇");
      const fromS2 = papers.filter((p) => p.provenance.source === "semanticscholar");
      eq(fromS2.length, 1, "S2 独有的那篇应作为新增合并进来");
      eq(fromS2[0].title, S2_NEW_TITLE);
      eq(fromS2[0].provenance.sourceId, "s2-new");
      eq(fromS2[0].oaStatus, "verified");
      const filled = papers.find((p) => p.title === FILL_TITLE);
      ok(filled, "主源缺摘要的论文应仍在结果里");
      ok(filled.abstract.includes("S2 补齐"), "S2 应为缺摘要的主源论文补齐摘要");
      eq(filled.provenance.abstractAvailable, true);
      eq(filled.provenance.source, "openalex", "补齐摘要不改变主源归属");
      eq(filled.oaUrl, S2_FILL_PDF, "S2 应补齐开放全文链接");
      eq(filled.oaStatus, "verified");
      const sameTitle = papers.filter((p) => normTitle(p.title) === normTitle(GNN_TITLE));
      eq(sameTitle.length, 1, "同 DOI/归一化标题的重复只保留一篇");
      eq(sameTitle[0].provenance.source, "openalex", "重复时保留主源那篇");
      const reports = body.report.sourceReports;
      eq(reports.map((r) => r.source), ["openalex", "semanticscholar"]);
      ok(reports.every((r) => r.failed === false), "两源都成功时 failed 均为 false");
      eq(reports[0].returned, 4);
      eq(reports[1].returned, 3);
      const limitations = body.report.limitations.join("\n");
      ok(limitations.includes("新增 1 篇"), "limitations 应说明 S2 新增篇数");
      ok(limitations.includes("补齐"), "limitations 应说明补齐摘要/开放全文");
      ok(limitations.includes("去重移除 1 篇"), "limitations 应说明多源去重");
      eq(body.report.totalBeforeDedup, 5);
      eq(body.report.totalAfterDedup, 4);
      eq(body.report.removedByDedup, 1);
      eq(mock.countCalls("api.openalex.org"), 2, "OpenAlex 高被引 + 最新两批各一次");
      eq(mock.countCalls("api.semanticscholar.org"), 1);
    });

    await groupAsync("handler: S2 持续 429 => 退避重试一次后仅主源", async () => {
      mock.scenario.openalex = "ok";
      mock.scenario.s2 = "429";
      const s2Before = mock.countCalls("api.semanticscholar.org");
      const startedAt = Date.now();
      const { status, body } = await search(Q_429);
      const elapsed = Date.now() - startedAt;
      eq(status, 200);
      eq(body.ok, true, "第二源失败不应让整个检索失败");
      eq(body.cached, false);
      eq(body.degraded, false, "仅第二源失败不算降级（主源仍可用）");
      const s2Calls = mock.countCalls("api.semanticscholar.org") - s2Before;
      ok(s2Calls >= 2, `429 应发生重试（实际 ${s2Calls} 次 S2 调用）`);
      eq(s2Calls, 2, "只退避重试一次，不无限重试");
      ok(elapsed >= 1900, `退避应等待约 2 秒（实际 ${elapsed}ms）`);
      const s2Report = body.report.sourceReports.find((r) => r.source === "semanticscholar");
      ok(s2Report, "失败的第二源也要出现在 sourceReports 里");
      eq(s2Report.failed, true);
      eq(s2Report.returned, 0);
      ok(s2Report.error.includes("只来自 OpenAlex"), "应说明本次结果仅来自主源");
      ok(body.papers.length > 0);
      eq(body.papers.length, 3, "OpenAlex 4 篇去重后 3 篇");
      ok(body.papers.every((p) => p.provenance.source === "openalex"), "429 时结果全部来自主源");
      ok(!body.detail.includes("Semantic Scholar 补充合并"));
    });

    await groupAsync("handler: 相同 query 二次调用命中 12h 共享缓存", async () => {
      mock.scenario.s2 = "ok";
      const callsBefore = mock.calls.length;
      const { status, body } = await search(Q_MERGE);
      eq(status, 200);
      eq(body.ok, true);
      eq(body.cached, true);
      eq(body.report.fromCache, true);
      eq(body.papers.length, mergeCount, "缓存返回篇数与首次一致");
      eq(mock.calls.length, callsBefore, "命中缓存不应再打上游");
    });

    await groupAsync("handler: 不同 query 不串缓存 / refresh=1 强制回源", async () => {
      const fresh = await search(Q_FRESH);
      eq(fresh.status, 200);
      eq(fresh.body.cached, false, "不同 query 必须是新检索");
      eq(fresh.body.report.fromCache, false);
      ok(fresh.body.papers.length > 0);
      const forced = await search(Q_MERGE, "&refresh=1");
      eq(forced.body.cached, false, "refresh=1 应绕过缓存");
      eq(forced.body.papers.length, mergeCount);
    });

    for (const [mode, query] of [["500", Q_CR_500], ["throw", Q_CR_THROW]]) {
      await groupAsync(`handler: OpenAlex ${mode} => 降级 Crossref`, async () => {
        mock.scenario.openalex = mode;
        mock.scenario.s2 = "ok";
        const oaBefore = mock.countCalls("api.openalex.org");
        const s2Before = mock.countCalls("api.semanticscholar.org");
        const { status, body } = await search(query);
        eq(status, 200);
        eq(body.ok, true);
        eq(body.cached, false);
        eq(body.degraded, true, "主源不可用应标记 degraded");
        eq(body.report.degraded, true);
        eq(body.source, "crossref");
        const reports = body.report.sourceReports;
        const sources = reports.map((r) => r.source);
        ok(sources.includes("crossref"), "降级后 sourceReports 应含 crossref");
        ok(sources.includes("openalex"), "失败的主源也要留痕");
        const oaReport = reports.find((r) => r.source === "openalex");
        eq(oaReport.failed, true);
        eq(oaReport.returned, 0);
        const crReport = reports.find((r) => r.source === "crossref");
        eq(crReport.failed, false);
        eq(crReport.returned, 2);
        eq(body.papers.length, 2, "Crossref 3 条按 DOI 去重后 2 篇");
        ok(body.papers.every((p) => p.provenance.source === "crossref"));
        eq(body.report.removedByDedup, 1);
        ok(body.report.limitations.join("").includes("降级到 Crossref"));
        ok(body.detail.includes("Crossref"));
        eq(mock.countCalls("api.openalex.org") - oaBefore, 2, "两批主源请求都失败后才降级");
        eq(mock.countCalls("api.semanticscholar.org") - s2Before, 0, "降级路径不再打第二源");
      });
    }

    await groupAsync("handler: 全程只打 mock 覆盖的上游（无真实网络）", () => {
      ok(mock.calls.length > 0);
      const hosts = [...new Set(mock.calls.map((href) => new URL(href).hostname))];
      ok(hosts.every((h) => UPSTREAM_HOSTS.includes(h)), `出现了未预期的上游: ${hosts.join(",")}`);
    });
  } finally {
    mock.restore();
    if (originalDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = originalDeno;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const mods = await loadModules();

testDedup(mods.dedup);
testDirections(mods.directions);
testPlan(mods.plan);
testReview(mods.review);
testEvidenceMerge(mods.evidence);
await testHandlerServer();

if (failures.length > 0) {
  for (const { name, error } of failures) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
  console.error(`regression: FAILED（${failures.length} 组失败，失败前已通过 ${passed} 条断言）`);
  process.exit(1);
}
console.log(`regression: ${passed} passed`);
process.exit(0);