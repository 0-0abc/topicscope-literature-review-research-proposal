import { VERDICT_META, type CoverageVerdict, type RadarResult, type TopicCluster } from "./radar";
import type { SearchReport } from "../data/types";
import { percent } from "../format";

/** 每种判定对应的下一步动作，规则来自判定阈值，不是模型生成；结论均为样本内口径，需独立检索验证。 */
export const NEXT_STEP: Record<CoverageVerdict, string> = {
  saturated: "样本内同类工作密集，暂不建议作为起点：除非你能拿到新数据、换任务设定或换评测口径；真实密度需独立检索验证。",
  mature: "样本内同类工作较多，适合做增量：区分度只能来自数据、任务设定或评测口径本身；领域真实密度需独立检索验证。",
  emerging: "样本内语料少但近期占比高，可作为候选窗口：先独立检索验证增长是否真实，再把主流基线复现出来，再谈改进。",
  gap: "当前检索样本未观察到，先确认是不是检索式没覆盖到：换 2–3 个说法独立检索验证，仍然为空才需要自己定义问题。",
  insufficient: "先补材料：换检索式或补全文，把摘要覆盖率提上来再判断这个方向。",
};

const OPPORTUNITY: Record<CoverageVerdict, number> = {
  emerging: 3,
  mature: 2,
  saturated: 1,
  gap: 0,
  insufficient: 0,
};

export interface AdvisorReportData {
  query: string;
  candidates: TopicCluster[];
  avoid: TopicCluster[];
  markdown: string;
}

export function buildAdvisorReport(radar: RadarResult, report: SearchReport | null): AdvisorReportData {
  const query = report?.job.rawQuestion ?? "";
  const ranked = radar.clusters
    .filter((c) => c.size > 3 && OPPORTUNITY[c.verdict] > 0)
    .sort((a, b) => OPPORTUNITY[b.verdict] - OPPORTUNITY[a.verdict] || a.crowding - b.crowding);
  const candidates = ranked.slice(0, 3);
  const avoid = radar.clusters.filter(
    (c) => c.verdict === "saturated" && !candidates.includes(c),
  );
  return { query, candidates, avoid, markdown: toMarkdown(query, radar, report, candidates, avoid) };
}

function toMarkdown(
  query: string,
  radar: RadarResult,
  report: SearchReport | null,
  candidates: TopicCluster[],
  avoid: TopicCluster[],
): string {
  const lines: string[] = ["# 选题方向对比汇报（供导师讨论稿）", ""];
  lines.push(`> 检索词：${query || "（未记录）"}｜样本 ${radar.clusters.reduce((s, c) => s + c.size, 0)} 篇｜年份 ${radar.yearRange[0]}–${radar.yearRange[1]}`);
  if (report) {
    lines.push(`> 检索于 ${report.retrievedAt.slice(0, 10)}｜来源 ${report.job.sourcePlan.join("、")}`);
    lines.push(`> 样本框：${report.sampleFrame}`);
  }
  lines.push("", "## 一、备选方向对比", "");
  lines.push("| 方向 | 判定 | 样本占比 | 样本内近三年占比 | 中位年份 | 拥挤度 |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of candidates) {
    lines.push(
      `| ${c.name} | ${VERDICT_META[c.verdict].label} | ${percent(c.sizeShare)} | ${percent(c.recentShare, 0)} | ${c.medianYear} | ${c.crowding}/100 |`,
    );
  }
  lines.push("");

  candidates.forEach((c, i) => {
    lines.push(`## 二.${i + 1} 备选 ${i + 1}：${c.name}（${VERDICT_META[c.verdict].label}）`, "");
    lines.push(`- 统计证据：样本 ${c.size} 篇、占 ${percent(c.sizeShare)}；样本内近三年占比 ${percent(c.recentShare, 0)}；被引中位数 ${c.citationMedian}；摘要覆盖 ${c.abstractCoverage}%。`);
    lines.push(`- 判定依据：${c.verdictReason}`);
    lines.push(`- 下一步建议：${NEXT_STEP[c.verdict]}`);
    lines.push(`- 边界说明：${VERDICT_META[c.verdict].cannotConclude}`);
    if (c.topPapers.length > 0) {
      lines.push("- 代表文献（按被引排序，需自行核对全文）：");
      for (const p of c.topPapers.slice(0, 3)) {
        lines.push(`  - ${p.title}（${p.year}${p.venue ? `，${p.venue}` : ""}）${p.doi ? ` DOI: ${p.doi}` : ""}`);
      }
    }
    lines.push("");
  });

  if (avoid.length > 0) {
    lines.push("## 三、暂不建议作为起点的方向", "");
    for (const c of avoid) {
      lines.push(`- ${c.name}：${c.verdictReason}`);
    }
    lines.push("");
  }

  lines.push("## 四、材料与局限", "");
  if (report) {
    lines.push(`- ${report.sampleFrame}`);
    for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  }
  lines.push("- 以上占比与拥挤度只反映当前检索样本，不等于真实领域产出比例。");
  lines.push("- 「增长窗口」等判定只表示样本内近期占比高，固定按年采样的样本不能证明真实发文增长；所有方向判断需独立检索验证。", "");
  lines.push("---", "");
  lines.push("本汇报由 TopicScope 按公开判定规则从检索样本统计生成，未经模型改写，也不构成领域真实密度结论；与导师讨论前请核对代表文献全文。");
  return lines.join("\n");
}