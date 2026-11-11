import type { Paper, SearchReport } from "./data/types";
import {
  PLAN_SECTIONS,
  RESOURCE_KIND_LABEL,
  RESOURCE_STATUS_LABEL,
  type ResearchPlan,
  type ResourceRoute,
} from "./ai/plan";

function escapeCsv(value: string | number | boolean | null): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function papersToCsv(papers: Paper[]): string {
  const header = [
    "title",
    "year",
    "citedByCount",
    "venue",
    "doi",
    "authors",
    "keywords",
    "url",
    "source",
    "sourceId",
    "retrievedAt",
    "dedupKey",
    "abstractAvailable",
  ];
  const rows = papers.map((paper) =>
    [
      paper.title,
      paper.year,
      paper.citedByCount,
      paper.venue,
      paper.doi,
      paper.authors.join("; "),
      paper.keywords.join("; "),
      paper.oaUrl,
      paper.provenance.source,
      paper.provenance.sourceId,
      paper.provenance.retrievedAt,
      paper.provenance.dedupKey,
      paper.provenance.abstractAvailable,
    ]
      .map(escapeCsv)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function papersToMarkdown(
  papers: Paper[],
  options: { title?: string; note?: string; clusterOf?: (paper: Paper) => string | undefined } = {},
): string {
  const lines: string[] = [];
  if (options.title) lines.push(`# ${options.title}`, "");
  if (options.note) lines.push(options.note, "");
  lines.push(`共 ${papers.length} 篇，按被引次数从高到低排列。`, "");

  for (const paper of papers) {
    const cluster = options.clusterOf?.(paper);
    lines.push(`## ${paper.title}`);
    const meta: string[] = [`${paper.year}`, `被引 ${paper.citedByCount}`];
    if (paper.venue) meta.push(paper.venue);
    if (cluster) meta.push(cluster);
    lines.push(meta.join(" · "));
    if (paper.authors.length > 0) {
      lines.push(
        paper.authors.length > 4
          ? `${paper.authors.slice(0, 4).join(", ")} 等 ${paper.authorCount} 人`
          : paper.authors.join(", "),
      );
    }
    if (paper.doi) lines.push(`DOI: ${paper.doi}`);
    if (paper.oaUrl) lines.push(`链接: ${paper.oaUrl}`);
    if (paper.keywords.length > 0) lines.push(`关键词: ${paper.keywords.join(" / ")}`);
    lines.push(
      `来源: ${paper.provenance.source}（检索于 ${paper.provenance.retrievedAt.slice(0, 10)}，` +
        `材料到${paper.provenance.abstractAvailable ? "摘要" : "元数据"}层）`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

/** 检索快照：查询、来源、时间、过滤条件、覆盖率与已知局限，导出文件必须带这些。 */
export function searchReportToMarkdown(report: SearchReport): string {
  const lines: string[] = ["# 检索快照", ""];
  lines.push(`- 查询原文: ${report.job.rawQuestion}`);
  if (report.job.queryVariants.length > 0) {
    lines.push(`- 检索式变体: ${report.job.queryVariants.join(" / ")}`);
  }
  lines.push(`- 来源计划: ${report.job.sourcePlan.join("、")}`);
  lines.push(`- 检索时间: ${report.retrievedAt}`);
  lines.push(`- 是否命中缓存: ${report.fromCache ? "是" : "否"}`);
  lines.push(`- 是否发生来源降级: ${report.degraded ? "是" : "否"}`);
  const constraints = report.job.constraints;
  const constraintText = [
    constraints.fromYear ? `起始年份 ${constraints.fromYear}` : "",
    constraints.toYear ? `结束年份 ${constraints.toYear}` : "",
    constraints.openAccessOnly ? "仅开放获取" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  lines.push(`- 过滤条件: ${constraintText || "无"}`);
  lines.push(
    `- 去重: 返回 ${report.totalBeforeDedup} 篇，去重后 ${report.totalAfterDedup} 篇，移除 ${report.removedByDedup} 篇`,
  );
  lines.push(`- 摘要覆盖率: ${report.abstractCoverage}%`);
  lines.push(`- 开放获取覆盖率: ${report.oaCoverage}%`);
  lines.push(`- 样本框: ${report.sampleFrame}`, "");

  lines.push("## 各来源结果", "");
  for (const source of report.sourceReports) {
    lines.push(
      `- ${source.source}｜检索式 ${source.filter || "（无）"}｜返回 ${source.returned} 篇｜` +
        `摘要覆盖 ${source.abstractCoverage}%｜开放获取覆盖 ${source.oaCoverage}%` +
        (source.failed ? `｜失败: ${source.error ?? "未知原因"}` : ""),
    );
  }
  lines.push("");

  if (report.limitations.length > 0) {
    lines.push("## 已知局限", "");
    for (const limitation of report.limitations) lines.push(`- ${limitation}`);
    lines.push("");
  }

  return lines.join("\n");
}

export interface PlanExportOptions {
  /** 检索快照，写进方案头部，避免方案脱离样本框 */
  report?: SearchReport | null;
  /** 用户给出的约束 */
  constraints?: Record<string, string | undefined>;
  /** 数据与代码的可获得性 */
  resources?: ResourceRoute[];
  /** 方案引用到的证据条目 */
  evidence?: { id: string; label: string; value: string; origin: string }[];
  /** 模型编造的证据 ID */
  unknownEvidence?: string[];
  generatedAt?: string;
  model?: string;
}

/** 研究方案导出：固定 15 节结构 + 评分 + 待补充条件 + 证据索引。 */
export function researchPlanToMarkdown(
  plan: ResearchPlan,
  options: PlanExportOptions = {},
): string {
  const lines: string[] = [`# 研究方案：${plan.title}`, ""];

  if (options.report) {
    lines.push(
      `> 检索：${options.report.job.rawQuestion}｜来源 ${options.report.job.sourcePlan.join("、")}｜` +
        `检索于 ${options.report.retrievedAt.slice(0, 10)}｜样本 ${options.report.totalAfterDedup} 篇`,
    );
    lines.push(`> 样本框：${options.report.sampleFrame}`, "");
  }

  const constraintEntries = Object.entries(options.constraints ?? {}).filter(
    ([, value]) => value && value.trim(),
  );
  if (constraintEntries.length > 0) {
    lines.push("## 0. 生成时使用的约束", "");
    for (const [key, value] of constraintEntries) {
      lines.push(`- ${CONSTRAINT_LABEL[key] ?? key}: ${value}`);
    }
    lines.push("");
  }

  for (const section of PLAN_SECTIONS) {
    const body = plan.sections[section.key];
    lines.push(`## ${section.number}. ${section.title}`, "");
    lines.push(body || "当前材料无法判断。", "");
  }

  if (plan.chainAudit) {
    lines.push("## 附：逻辑链自洽检查（局限→想法→挑战→方法→结果）", "", plan.chainAudit, "");
  }

  if (options.resources && options.resources.length > 0) {
    lines.push("## 附：数据与代码可获得性", "");
    lines.push("| 类型 | 名称 | 状态 | 许可 | 获取条件 |");
    lines.push("|---|---|---|---|---|");
    for (const resource of options.resources) {
      lines.push(
        `| ${RESOURCE_KIND_LABEL[resource.kind]} | ${resource.name} | ` +
          `${RESOURCE_STATUS_LABEL[resource.status]} | ${resource.license || "—"} | ` +
          `${resource.accessCondition || (resource.url || "—")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 附：方案评分", "");
  for (const score of plan.scores) {
    lines.push(`- ${score.dimension}: ${score.score}/5 — ${score.reason || "模型未给出原因"}`);
  }
  lines.push("");
  lines.push("总分只用于排序，不替代人工判断。", "");

  if (plan.missing.length > 0) {
    lines.push("## 附：待补充条件", "");
    for (const item of plan.missing) lines.push(`- ${item}`);
    lines.push("");
  }

  if (options.evidence && options.evidence.length > 0) {
    lines.push("## 附：证据条目对照", "");
    lines.push("| 证据 ID | 指标 | 数值 | 来源 |");
    lines.push("|---|---|---|---|");
    for (const item of options.evidence) {
      lines.push(`| ${item.id} | ${item.label} | ${item.value} | ${item.origin} |`);
    }
    lines.push("");
  }

  if (options.unknownEvidence && options.unknownEvidence.length > 0) {
    lines.push("## 附：未识别的证据引用", "");
    for (const id of options.unknownEvidence) lines.push(`- ${id}`);
    lines.push("");
  }

  lines.push("---", "");
  lines.push(
    `由 ${options.model ?? "大模型"} 基于 TopicScope 当前检索样本的统计结果生成` +
      (options.generatedAt ? `（${options.generatedAt.slice(0, 16).replace("T", " ")}）` : "") +
      "。方案中的判断尚未经过全文核对，请逐条核实后再使用。逻辑链自洽检查方法改编自 HKUSTDial/Supervisor-Skills（CC-BY-4.0）。",
  );

  return lines.join("\n");
}

const CONSTRAINT_LABEL: Record<string, string> = {
  object: "研究对象与任务",
  task: "任务设定",
  datasets: "可用数据集",
  compute: "算力条件",
  timeline: "目标完成时间",
  openCode: "是否要求开放代码",
  target: "预期产出",
};

/** GB/T 7714—2015 顺序编码制：作者不超过 3 人，超出加「, 等」；缺卷期页码时省略。 */
export function formatGB7714(paper: Paper, index?: number): string {
  const authors = paper.authors.slice(0, 3).map(gbAuthorName).filter(Boolean).join(", ");
  const authorText = authors
    ? paper.authors.length > 3
      ? `${authors}, 等`
      : authors
    : "佚名";
  const kind = paper.type?.toLowerCase().includes("conference") ? "[C]" : "[J]";
  const prefix = index === undefined ? "" : `[${index}] `;
  const venue = paper.venue ?? "出版地不详";
  return `${prefix}${authorText}. ${paper.title}${kind}. ${venue}, ${paper.year}${paper.doi ? `. DOI: ${paper.doi}` : ""}.`;
}

function gbAuthorName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (/[一-鿿]/.test(trimmed)) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return trimmed.toUpperCase();
  const surname = parts[parts.length - 1].toUpperCase();
  const initials = parts
    .slice(0, -1)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .filter(Boolean)
    .join(" ");
  return initials ? `${surname} ${initials}` : surname;
}

export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
