import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildAdvisorReport, NEXT_STEP } from "@/lib/analysis/advisorReport";
import { VERDICT_META, type RadarResult, type TopicCluster } from "@/lib/analysis/radar";
import type { SearchReport } from "@/lib/data/types";
import { downloadText } from "@/lib/export";
import { percent } from "@/lib/format";

interface Props {
  radar: RadarResult;
  report: SearchReport | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheckup?: (cluster: TopicCluster) => void;
}

export function AdvisorReportDialog({ radar, report, open, onOpenChange, onCheckup }: Props) {
  const data = useMemo(() => buildAdvisorReport(radar, report), [radar, report]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="heading-cn text-base">导师汇报 · 备选方向对比</DialogTitle>
          <DialogDescription className="text-xs">
            按公开判定规则从当前检索样本生成，未经模型改写；供与导师讨论使用，不构成领域真实密度结论。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <section className="space-y-2">
            <h3 className="heading-cn text-sm">一、备选方向对比</h3>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left">
                    <th className="px-3 py-2">方向</th>
                    <th className="px-3 py-2">判定</th>
                    <th className="px-3 py-2">样本占比</th>
                    <th className="px-3 py-2">近三年占比</th>
                    <th className="px-3 py-2">中位年份</th>
                    <th className="px-3 py-2">拥挤度</th>
                  </tr>
                </thead>
                <tbody>
                  {data.candidates.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2">{VERDICT_META[c.verdict].label}</td>
                      <td className="px-3 py-2 tabular-nums">{percent(c.sizeShare)}</td>
                      <td className="px-3 py-2 tabular-nums">{percent(c.recentShare, 0)}</td>
                      <td className="px-3 py-2 tabular-nums">{c.medianYear}</td>
                      <td className="px-3 py-2 tabular-nums">{c.crowding}/100</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.candidates.map((c, i) => (
            <section key={c.id} className="space-y-1.5 rounded-md border border-border px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="heading-cn text-sm">
                  备选 {i + 1}：{c.name}
                </h3>
                <div className="flex items-center gap-2">
                  {onCheckup ? (
                    <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => onCheckup(c)}>
                      体检这个方向
                    </Button>
                  ) : null}
                  <Badge variant={c.verdict === "emerging" ? "default" : "secondary"} className="rounded-sm">
                    {VERDICT_META[c.verdict].label}
                  </Badge>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                统计证据：样本 {c.size} 篇、占 {percent(c.sizeShare)}；近三年占比 {percent(c.recentShare, 0)}；
                被引中位数 {c.citationMedian}；摘要覆盖 {c.abstractCoverage}%。
              </p>
              <p className="text-xs leading-relaxed">{c.verdictReason}</p>
              <p className="text-xs leading-relaxed">
                <span className="text-muted-foreground">下一步建议：</span>
                {NEXT_STEP[c.verdict]}
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                边界说明：{VERDICT_META[c.verdict].cannotConclude}
              </p>
              {c.topPapers.length > 0 ? (
                <div className="space-y-0.5 pt-1">
                  <p className="text-[11px] text-muted-foreground">代表文献（需自行核对全文）：</p>
                  <ul className="space-y-0.5">
                    {c.topPapers.slice(0, 3).map((p) => (
                      <li key={p.id} className="text-[11px] leading-relaxed">
                        <span className="line-clamp-1">{p.title}</span>
                        <span className="ml-1 tabular-nums text-muted-foreground">
                          {p.year}
                          {p.venue ? ` · ${p.venue}` : ""}
                          {p.doi ? ` · DOI: ${p.doi}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ))}

          {data.avoid.length > 0 ? (
            <section className="space-y-1.5">
              <h3 className="heading-cn text-sm">暂不建议作为起点</h3>
              {data.avoid.map((c) => (
                <p key={c.id} className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">{c.name}：</span>
                  {c.verdictReason}
                </p>
              ))}
            </section>
          ) : null}

          <section className="space-y-1 rounded-md bg-muted px-4 py-3">
            <h3 className="heading-cn text-sm">材料与局限</h3>
            {report ? (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">{report.sampleFrame}</p>
                {report.limitations.map((limitation) => (
                  <p key={limitation} className="text-xs leading-relaxed text-muted-foreground">
                    {limitation}
                  </p>
                ))}
              </>
            ) : null}
            <p className="text-xs leading-relaxed text-muted-foreground">
              以上占比与拥挤度只反映当前检索样本，不等于真实领域产出比例。
            </p>
          </section>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadText(`advisor-report-${data.query.slice(0, 24) || "topicscope"}.md`, data.markdown, "text/markdown")
            }
          >
            导出 Markdown
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}