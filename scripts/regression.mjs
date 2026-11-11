/**
 * 最小自动化回归（评审关键流程）：
 *   1. 检索去重          lib/data/dedup.ts        dedupPapers / withSnapshotProvenance
 *   2. 证据引用解析      lib/ai/directions.ts     parseSuggestions / resolveEvidence / isGrounded
 *   3. AI 方案输出校验   lib/ai/plan.ts           parsePlan / resolvePlanEvidence
 *   4. AI 综述质量门禁   lib/ai/review.ts         parseReview / reviewQualityGates
 *   5. 存档恢复合并      hooks/useEvidenceStore.ts mergeEvidenceNotes（纯函数，不调用 hook）
 *
 * 运行：node scripts/regression.mjs
 * 用 esbuild build API（write:false, bundle:true, platform:'node', format:'esm'，
 * alias 把 @ 映射到项目根）把上述模块打包成临时 ESM 后 import 断言。
 * 不写 dist、不跑 vite build、不改任何源文件；临时目录用完即删。
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
// 主流程
// ---------------------------------------------------------------------------
const mods = await loadModules();

testDedup(mods.dedup);
testDirections(mods.directions);
testPlan(mods.plan);
testReview(mods.review);
testEvidenceMerge(mods.evidence);

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