import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { CooccurrenceGraph } from "@/components/CooccurrenceGraph";
import { DirectionAdvisor } from "@/components/DirectionAdvisor";
import { AdvisorReportDialog } from "@/components/AdvisorReportDialog";
import { NEXT_STEP } from "@/lib/analysis/advisorReport";
import { VERDICT_META, type RadarResult, type TopicCluster } from "@/lib/analysis/radar";
import type { TermPair } from "@/lib/analysis/cooccurrence";
import type { DirectionContext } from "@/lib/ai/directions";
import type { SearchReport } from "@/lib/data/types";
import { percent } from "@/lib/format";

interface Props {
  radar: RadarResult | null;
  graph: Parameters<typeof CooccurrenceGraph>[0]["graph"];
  clusterPairs: Map<number, TermPair[]>;
  directionContext: DirectionContext | null;
  report: SearchReport | null;
  onInspectCluster: (cluster: TopicCluster) => void;
  onCheckup: (idea: string, clusterId: number | null) => void;
}

export function RadarView({
  radar,
  graph,
  clusterPairs,
  directionContext,
  report,
  onInspectCluster,
  onCheckup,
}: Props) {
  const [reportOpen, setReportOpen] = useState(false);
  if (!radar || radar.clusters.length === 0) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        检索一个方向，或载入离线示例，即可看到覆盖情况。
      </div>
    );
  }

  const verdictCounts = radar.clusters.reduce<Record<string, number>>((acc, cluster) => {
    acc[cluster.verdict] = (acc[cluster.verdict] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-4">
        <Stat label="语料规模" value={`${radar.clusters.reduce((sum, c) => sum + c.size, 0)} 篇`} />
        <Stat label="年份跨度" value={`${radar.yearRange[0]}–${radar.yearRange[1]}`} />
        <Stat label="聚类数" value={`${radar.clusterCount} 个`} />
        <Stat
          label="判定分布"
          value={Object.entries(verdictCounts)
            .map(([key, count]) => `${VERDICT_META[key as keyof typeof VERDICT_META].label} ${count}`)
            .join(" · ")}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
          <div className="flex items-baseline gap-3">
            <span className="section-kicker">01</span>
            <h2 className="heading-cn text-base">
              方向聚类与覆盖判定
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <p className="hidden max-w-xl text-right text-[11px] leading-relaxed text-muted-foreground lg:block">
              判定规则：论文数 ≤ 3 视为当前检索未观察到；占比 &lt; 10% 且近三年占比 ≥ 60% 视为增长窗口；占比 ≥ 12% 且中位年份早于区间末尾 4 年以上、近期新增 ≤ 35% 视为高密度成熟方向。
            </p>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setReportOpen(true)}>
              导师汇报
            </Button>
          </div>
        </div>
        {report ? (
          <figure className="figure-panel px-3 py-2.5">
            <figcaption className="label-caps mb-1">样本框与已知局限</figcaption>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {report.sampleFrame}
              {report.limitations.length > 0 ? ` 已知局限：${report.limitations.join(" ")}` : ""}
            </p>
          </figure>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {radar.clusters.map((cluster) => (
            <ClusterCard
              key={cluster.id}
              cluster={cluster}
              pairs={clusterPairs.get(cluster.id) ?? []}
              onInspect={() => onInspectCluster(cluster)}
            />
          ))}
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div className="flex items-baseline gap-3 border-b border-border pb-2">
          <span className="section-kicker">02</span>
          <h2 className="heading-cn text-base">研究方向建议</h2>
        </div>
        <DirectionAdvisor context={directionContext} onCheckupIdea={(idea) => onCheckup(idea, null)} />
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline gap-3 border-b border-border pb-2">
          <span className="section-kicker">03</span>
          <h2 className="heading-cn text-base">关键词共现网络</h2>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          连线的「共现强度」= 实际同时出现的次数 ÷ 独立假设下的期望次数。大于 1 说明这两个词出现得比随机更紧密，
          常意味着它们构成了一个稳定的方法组合。只保留强度大于 1.15 的词对。
        </p>
        <CooccurrenceGraph graph={graph} />
      </section>

      <AdvisorReportDialog
        radar={radar}
        report={report}
        open={reportOpen}
        onOpenChange={setReportOpen}
        onCheckup={(cluster) => {
          setReportOpen(false);
          onCheckup("", cluster.id);
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-4 py-3">
      <div className="label-caps">{label}</div>
      <div className="mt-1 font-display text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

function ClusterCard({
  cluster,
  pairs,
  onInspect,
}: {
  cluster: TopicCluster;
  pairs: TermPair[];
  onInspect: () => void;
}) {
  const meta = VERDICT_META[cluster.verdict];
  // 默认收起长内容：先看结论和数字，细节点开再看
  const [expanded, setExpanded] = useState(false);
  return (
    <Card className="gap-3 rounded-md border-border py-4 shadow-none">
      <CardHeader className="gap-2 px-4">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="heading-cn text-base leading-tight">
            {cluster.name}
          </CardTitle>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Badge
              variant={cluster.verdict === "emerging" ? "default" : "secondary"}
              className="rounded-sm"
            >
              {meta.label}
            </Badge>
            {cluster.evidenceWeak ? (
              <Badge variant="outline" className="rounded-sm">
                {VERDICT_META.insufficient.label}
              </Badge>
            ) : null}
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{meta.summary}</p>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <Metric label="样本论文数" value={`${cluster.size}（占当前检索样本 ${percent(cluster.sizeShare)}）`} />
          <Metric label="年份跨度" value={`${cluster.yearRange[0]}–${cluster.yearRange[1]}`} />
          <Metric label="近三年占比" value={percent(cluster.recentShare, 0)} />
          <Metric label="被引中位数" value={String(cluster.citationMedian)} />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <Metric label="近五年占比" value={percent(cluster.fiveYearShare, 0)} />
          <Metric label="中位发表年份" value={String(cluster.medianYear)} />
          <Metric label="摘要覆盖率" value={`${cluster.abstractCoverage}%`} />
          <Metric label="开放获取覆盖率" value={`${cluster.oaCoverage}%`} />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>拥挤度</span>
            <span className="tabular-nums">{cluster.crowding} / 100</span>
          </div>
          <Progress value={cluster.crowding} />
        </div>

        <YearTrend counts={cluster.yearCounts} />

        <div className="flex flex-wrap gap-1.5">
          {cluster.terms.slice(0, 6).map((term) => (
            <span
              key={term}
              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              {term}
            </span>
          ))}
        </div>

        <p className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {cluster.verdictReason}
        </p>

        <p
          className={`text-[11px] leading-relaxed text-muted-foreground ${
            expanded ? "" : "line-clamp-1"
          }`}
          title={expanded ? undefined : VERDICT_META[cluster.verdict].cannotConclude}
        >
          不能推出什么：{VERDICT_META[cluster.verdict].cannotConclude}
        </p>

        {expanded ? (
          <>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              材料范围：{cluster.coverageNote}
            </p>

            <p className="text-xs leading-relaxed">
              <span className="text-muted-foreground">下一步：</span>
              {NEXT_STEP[cluster.verdict]}
            </p>

            {pairs.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  该方向内部的方法组合（按提升度排序，提升度 = 共现次数 ÷ 随机期望）：
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {pairs.map((pair) => (
                    <span
                      key={`${pair.a}-${pair.b}`}
                      className="rounded border border-border px-1.5 py-0.5 text-[11px]"
                    >
                      {pair.a} — {pair.b}
                      <span className="ml-1 tabular-nums text-muted-foreground">
                        {pair.lift.toFixed(2)} · {pair.count} 篇
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {cluster.topVenues.length > 0 ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                主要发表场所：
                {cluster.topVenues.map((venue) => `${venue.name}（${venue.count}）`).join("、")}
              </p>
            ) : null}

            {cluster.topPapers.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">代表论文（按被引排序）：</p>
                <ul className="space-y-0.5">
                  {cluster.topPapers.map((paper) => (
                    <li key={paper.id} className="text-[11px] leading-relaxed">
                      <span className="line-clamp-1">{paper.title}</span>
                      <span className="ml-1 tabular-nums text-muted-foreground">
                        {paper.year} · 被引 {paper.citedByCount}
                        {paper.venue ? ` · ${paper.venue}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起详情" : "展开详情"}
          </Button>
          <Button variant="outline" size="sm" onClick={onInspect}>
            查看该方向的 {cluster.size} 篇文献
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label-caps">{label}</div>
      <div className="tabular-nums">{value}</div>
    </div>
  );
}

function YearTrend({ counts }: { counts: { year: number; count: number }[] }) {
  if (counts.length === 0) return null;
  const max = Math.max(...counts.map((c) => c.count), 1);
  const recentStart = counts[counts.length - 1].year - 2;
  const W = 260;
  const H = 58;
  const pad = 2;
  const bw = (W - pad * 2) / counts.length;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>按年发文量（当前样本）</span>
        <span>深色 = 近三年</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`按年发文量：${counts.map((c) => `${c.year} 年 ${c.count} 篇`).join("，")}`}
      >
        {counts.map((c, i) => {
          const h = Math.max(2, (c.count / max) * (H - 16));
          return (
            <rect
              key={c.year}
              x={pad + i * bw + 1}
              y={H - 13 - h}
              width={Math.max(1, bw - 2)}
              height={h}
              className={c.year >= recentStart ? "fill-foreground" : "fill-muted-foreground/25"}
            >
              <title>{`${c.year} 年：${c.count} 篇`}</title>
            </rect>
          );
        })}
        <text x={pad} y={H - 3} className="fill-muted-foreground text-[8px] tabular-nums">
          {counts[0].year}
        </text>
        <text x={W - pad} y={H - 3} textAnchor="end" className="fill-muted-foreground text-[8px] tabular-nums">
          {counts[counts.length - 1].year}
        </text>
      </svg>
    </div>
  );
}
