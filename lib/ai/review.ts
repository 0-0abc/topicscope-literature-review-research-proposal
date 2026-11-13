import type { RadarResult } from "../analysis/radar";
import type { Paper, SearchReport } from "../data/types";
import { filterOnTopic } from "../data/relevance";
import { formatGB7714 } from "../export";
import type { DirectionContext } from "./directions";

export interface ReviewSection {
  heading: string;
  body: string;
}

export interface ResearchReview {
  title: string;
  sections: ReviewSection[];
  gaps: string;
  limitation: string;
  /** 自我对抗检查：最脆弱主张 / 未明说前提 / 选择性引用风险 */
  selfCheck: string;
  maxN: number;
}

export interface ReviewRef {
  n: number;
  paper: Paper;
  /** 来源异常提示：venue 为会议录/proceedings，或无 DOI 且无作者 */
  anomaly?: string;
}

/** 编号文献的来源异常检查（S6）：只标注风险，不剔除文献，核对责任交给用户。 */
function detectRefAnomaly(paper: Paper): string | undefined {
  const notes: string[] = [];
  const venue = paper.venue ?? "";
  if (/proceedings/i.test(venue) || venue.includes("会议录")) {
    notes.push("venue 为会议录/proceedings，需核对是否正式发表");
  }
  if (!paper.doi && (paper.authors ?? []).length === 0) {
    notes.push("无 DOI 且无作者，来源需人工核对");
  }
  return notes.length > 0 ? notes.join("；") : undefined;
}

export function buildReviewPayload(
  context: DirectionContext,
  radar: RadarResult,
  byId: Map<string, Paper>,
  report?: SearchReport | null,
): { payload: { context: DirectionContext; papers: unknown[] }; refs: ReviewRef[] } {
  // 与导师汇报共用同一套 relevance gate（M5）：编号文献必须在检索词主题内
  const query = context.query || report?.job.rawQuestion || "";
  const refs: ReviewRef[] = [];
  for (const cluster of radar.clusters.slice(0, 6)) {
    const members = filterOnTopic(
      cluster.paperIds
        .map((id) => byId.get(id))
        .filter((paper): paper is Paper => Boolean(paper)),
      query,
    )
      .sort((a, b) => b.citedByCount - a.citedByCount)
      .slice(0, 4);
    for (const paper of members) {
      refs.push({ n: refs.length + 1, paper, anomaly: detectRefAnomaly(paper) });
    }
  }
  const papers = refs.map(({ n, paper }) => ({
    n,
    title: paper.title,
    year: paper.year,
    venue: paper.venue,
    abstract: (paper.abstract ?? "").slice(0, 700),
  }));
  return { payload: { context, papers }, refs };
}

export function parseReview(value: unknown): ResearchReview | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.sections)) return null;
  const sections: ReviewSection[] = [];
  for (const item of body.sections) {
    if (!item || typeof item !== "object") continue;
    const section = item as Record<string, unknown>;
    if (typeof section.heading !== "string" || typeof section.body !== "string") continue;
    sections.push({ heading: section.heading, body: section.body });
  }
  if (sections.length === 0) return null;
  return {
    title: typeof body.title === "string" ? body.title : "文献综述草稿",
    sections,
    gaps: typeof body.gaps === "string" ? body.gaps : "",
    limitation: typeof body.limitation === "string" ? body.limitation : "",
    selfCheck: typeof body.selfCheck === "string" ? body.selfCheck : "",
    maxN: typeof body.maxN === "number" ? body.maxN : 0,
  };
}

export type GateVerdict = "clear" | "suspected" | "insufficient";

export interface QualityGate {
  name: string;
  verdict: GateVerdict;
  detail: string;
}

export const GATE_VERDICT_LABEL: Record<GateVerdict, string> = {
  clear: "通过",
  suspected: "存疑",
  insufficient: "不足",
};

const OVERCLAIM_PATTERN = /证明|首个|首次|唯一|最优|最好的方法|彻底解决/g;

/**
 * 本地质量门禁（改编自 deep-research 的六道内部检查，前端可核对的部分）：
 * 引用真实性、主题交织、分寸校准。结果只提示风险，不替代人工核对。
 */
export function reviewQualityGates(review: ResearchReview): QualityGate[] {
  const bodies = review.sections.map((s) => s.body);
  const allText = [...bodies, review.gaps].join("\n");
  const citations = [...allText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const invalid = citations.filter((n) => n < 1 || n > review.maxN);
  const sectionsWithoutCitation = review.sections.filter(
    (s) => !/\[\d+\]/.test(s.body),
  ).length;
  const citationGate: QualityGate =
    invalid.length > 0
      ? {
          name: "引用门禁",
          verdict: "insufficient",
          detail: `出现 ${invalid.length} 处编号之外的引用（已标 [?]），对应判断不可采信。`,
        }
      : sectionsWithoutCitation > 0
        ? {
            name: "引用门禁",
            verdict: "suspected",
            detail: `${sectionsWithoutCitation} 个小节没有文献支撑，相关表述请自行核对。`,
          }
        : {
            name: "引用门禁",
            verdict: "clear",
            detail: `全部 ${citations.length} 处引用都在编号文献范围内，每个小节都有文献支撑。`,
          };

  const woven = review.sections.filter((s) => {
    const ns = new Set([...s.body.matchAll(/\[(\d+)\]/g)].map((m) => m[1]));
    return ns.size >= 2;
  }).length;
  const weavingGate: QualityGate =
    woven === 0
      ? {
          name: "交织门禁",
          verdict: "suspected",
          detail: "没有小节同时比较两篇以上文献，可能仍是逐篇罗列，建议人工重写对比句。",
        }
      : {
          name: "交织门禁",
          verdict: "clear",
          detail: `${woven}/${review.sections.length} 个小节含跨文献对比。`,
        };

  const overclaims = allText.match(OVERCLAIM_PATTERN) ?? [];
  const calibrationGate: QualityGate =
    overclaims.length > 0
      ? {
          name: "分寸门禁",
          verdict: "suspected",
          detail: `检测到 ${overclaims.length} 处强断言词（${[...new Set(overclaims)].join("、")}），判断强度可能超过摘要级证据，请逐句复核。`,
        }
      : {
          name: "分寸门禁",
          verdict: "clear",
          detail: "未检测到无条件最高级或强断言词；仍需人工确认措辞与证据强度匹配。",
        };

  return [citationGate, weavingGate, calibrationGate];
}

export function reviewToMarkdown(
  review: ResearchReview,
  refs: ReviewRef[],
  report: SearchReport | null,
  model?: string | null,
): string {
  const lines: string[] = [`# ${review.title}（综述草稿）`, ""];
  if (report) {
    lines.push(
      `> 检索：${report.job.rawQuestion}｜样本 ${report.totalAfterDedup} 篇｜检索于 ${report.retrievedAt.slice(0, 10)}`,
    );
    lines.push(`> 样本框：${report.sampleFrame}`, "");
  }
  for (const section of review.sections) {
    lines.push(`## ${section.heading}`, "", section.body, "");
  }
  if (review.gaps) lines.push("## 研究空白与可切入点", "", review.gaps, "");
  if (review.selfCheck) lines.push("## 自我对抗检查", "", review.selfCheck, "");
  if (review.limitation) lines.push("## 材料局限", "", review.limitation, "");
  const gates = reviewQualityGates(review);
  lines.push("## 质量门禁（本地核对）", "");
  for (const gate of gates) {
    lines.push(`- ${gate.name}：${GATE_VERDICT_LABEL[gate.verdict]} — ${gate.detail}`);
  }
  lines.push("");
  // S6 引用门禁：参考文献表只列正文实际引用过的编号，未引用的单独列为候选
  const citedText = [
    ...review.sections.map((s) => s.body),
    review.gaps,
    review.selfCheck,
    review.limitation,
  ].join("\n");
  const citedNs = new Set([...citedText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const citedRefs = refs.filter((ref) => citedNs.has(ref.n));
  const uncitedRefs = refs.filter((ref) => !citedNs.has(ref.n));
  lines.push("## 参考文献（GB/T 7714，仅正文实际引用）", "");
  for (const { n, paper, anomaly } of citedRefs) {
    lines.push(formatGB7714(paper, n) + (anomaly ? `（提示：${anomaly}）` : ""));
  }
  if (uncitedRefs.length > 0) {
    lines.push("", "## 候选但未引用", "");
    for (const { n, paper, anomaly } of uncitedRefs) {
      lines.push(formatGB7714(paper, n) + (anomaly ? `（提示：${anomaly}）` : ""));
    }
    lines.push("", "以上编号文献进入候选但正文未引用，不计入参考文献表；如需引用请先核对全文。");
  }
  lines.push("", "---", "");
  lines.push(
    `由 ${model ?? "大模型"} 基于 TopicScope 当前检索样本生成。草稿中的 [n] 对应候选编号文献，参考文献表只列正文实际引用的条目；综合判断未经全文核对，提交或引用前请逐条核实。写作纪律改编自 HKUSTDial/Supervisor-Skills（CC-BY-4.0）。`,
  );
  return lines.join("\n");
}