import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RadarResult } from "@/lib/analysis/radar";
import {
  PREFERENCE_LABEL,
  totalScore,
  type ScoreBreakdown,
  type ScorePreference,
} from "@/lib/analysis/scoring";
import type { Paper, SearchReport, SourceName } from "@/lib/data/types";
import { downloadText, papersToCsv, papersToMarkdown } from "@/lib/export";
import { compactNumber } from "@/lib/format";
import { useScoreContext } from "@/hooks/useScoreContext";
import type { EvidenceLevel } from "@/hooks/useEvidenceStore";
import { EVIDENCE_LEVEL_LABEL } from "@/components/PaperCard";

type SortKey = "citations" | "newest" | "oldest" | "score";

interface Props {
  papers: Paper[];
  radar: RadarResult | null;
  assignment: Map<string, number>;
  clusterFilter: number | null;
  onClusterFilterChange: (id: number | null) => void;
  report: SearchReport | null;
  levelOf: (paper: Paper) => EvidenceLevel;
  onOpenCard: (paper: Paper) => void;
  /** 检索式，用于问题匹配度 */
  query: string;
  preference: ScorePreference;
  onPreferenceChange: (preference: ScorePreference) => void;
  /** 该论文已人工核对的字段数，用于 CSV 导出附加列 */
  verifiedCountOf?: (paper: Paper) => number;
}

export function LibraryView({
  papers,
  radar,
  assignment,
  clusterFilter,
  onClusterFilterChange,
  report,
  levelOf,
  onOpenCard,
  query,
  preference,
  onPreferenceChange,
  verifiedCountOf,
}: Props) {
  const [keyword, setKeyword] = useState("");
  const [minCitations, setMinCitations] = useState(0);
  const [sort, setSort] = useState<SortKey>("citations");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [yearFrom, setYearFrom] = useState<number | null>(null);
  const [yearTo, setYearTo] = useState<number | null>(null);
  const [oaFilter, setOaFilter] = useState<"all" | NonNullable<Paper["oaStatus"]>>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | SourceName>("all");
  const [evidenceFilter, setEvidenceFilter] = useState<"all" | EvidenceLevel>("all");
  const [visibleCount, setVisibleCount] = useState(200);

  const { breakdownOf } = useScoreContext(query, radar, assignment, preference);

  const breakdowns = useMemo(() => {
    const map = new Map<string, ScoreBreakdown[]>();
    for (const paper of papers) map.set(paper.id, breakdownOf(paper));
    return map;
  }, [papers, breakdownOf]);

  const clusterName = useMemo(() => {
    const map = new Map<number, string>();
    for (const cluster of radar?.clusters ?? []) map.set(cluster.id, cluster.name);
    return map;
  }, [radar]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    const list = papers.filter((paper) => {
      if (clusterFilter !== null && assignment.get(paper.id) !== clusterFilter) return false;
      if (paper.citedByCount < minCitations) return false;
      if (yearFrom !== null && paper.year < yearFrom) return false;
      if (yearTo !== null && paper.year > yearTo) return false;
      if (oaFilter !== "all" && (paper.oaStatus ?? "none") !== oaFilter) return false;
      if (sourceFilter !== "all" && paper.provenance.source !== sourceFilter) return false;
      if (evidenceFilter !== "all" && levelOf(paper) !== evidenceFilter) return false;
      if (!query) return true;
      const haystack = [
        paper.title,
        paper.venue ?? "",
        paper.keywords.join(" "),
        paper.topics.join(" "),
        paper.authors.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    return list.sort((a, b) => {
      if (sort === "citations") return b.citedByCount - a.citedByCount;
      if (sort === "newest") return b.year - a.year || b.citedByCount - a.citedByCount;
      if (sort === "oldest") return a.year - b.year || b.citedByCount - a.citedByCount;
      const scoreA = totalScore(breakdowns.get(a.id) ?? []);
      const scoreB = totalScore(breakdowns.get(b.id) ?? []);
      return scoreB - scoreA || b.citedByCount - a.citedByCount;
    });
  }, [
    papers,
    keyword,
    minCitations,
    sort,
    clusterFilter,
    assignment,
    breakdowns,
    yearFrom,
    yearTo,
    oaFilter,
    sourceFilter,
    evidenceFilter,
    levelOf,
  ]);

  // 任何筛选/排序/方向变化时回到第一页
  useEffect(() => {
    setVisibleCount(200);
  }, [
    papers,
    keyword,
    minCitations,
    sort,
    clusterFilter,
    yearFrom,
    yearTo,
    oaFilter,
    sourceFilter,
    evidenceFilter,
  ]);

  const visible = filtered.slice(0, visibleCount);
  const allSelected = visible.length > 0 && visible.every((paper) => selected.has(paper.id));

  const exportPapers = (list: Paper[], format: "markdown" | "csv") => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      downloadText(
        `topicscope-${list.length}-${stamp}.csv`,
        papersToCsv(list, (paper) => ({
          oaStatus: paper.oaStatus ?? "none",
          verifiedFields: String(verifiedCountOf?.(paper) ?? 0),
          query: report?.job.rawQuestion ?? query,
          sampleFrame: report?.sampleFrame ?? "",
        })),
        "text/csv",
      );
      return;
    }
    const title = clusterFilter !== null ? `${clusterName.get(clusterFilter)} · 文献清单` : "文献清单";
    const note = `共 ${list.length} 篇，按被引次数排序；检索式、来源、去重与局限见上方检索快照。`;
    downloadText(
      `topicscope-${list.length}-${stamp}.md`,
      papersToMarkdown(list, {
        title,
        note,
        report,
        clusterOf: (paper) => {
          const id = assignment.get(paper.id);
          return id === undefined ? undefined : clusterName.get(id);
        },
      }),
      "text/markdown",
    );
  };

  if (papers.length === 0) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        还没有文献。先在顶部检索一个方向。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="gap-3 rounded-md border-border py-3 shadow-none">
        <CardContent className="space-y-3 px-4">
          <p className="label-caps">检索结果筛选</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1.5 text-xs text-muted-foreground lg:col-span-2">
              关键词 / 标题 / 期刊
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="例如 transformer、IEEE、分割"
                className="h-9"
              />
            </label>

            <label className="space-y-1.5 text-xs text-muted-foreground">
              所属方向
              <NativeSelect
                value={clusterFilter === null ? "all" : String(clusterFilter)}
                onChange={(event) =>
                  onClusterFilterChange(
                    event.target.value === "all" ? null : Number(event.target.value),
                  )
                }
                className="w-full"
              >
                <NativeSelectOption value="all">全部方向</NativeSelectOption>
                {(radar?.clusters ?? []).map((cluster) => (
                  <NativeSelectOption key={cluster.id} value={String(cluster.id)}>
                    {cluster.name}（{cluster.size}）
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>

            <label className="space-y-1.5 text-xs text-muted-foreground">
              排序
              <NativeSelect
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                className="w-full"
              >
                <NativeSelectOption value="citations">被引次数从高到低</NativeSelectOption>
                <NativeSelectOption value="newest">年份从新到旧</NativeSelectOption>
                <NativeSelectOption value="oldest">年份从旧到新</NativeSelectOption>
                <NativeSelectOption value="score">综合评分从高到低</NativeSelectOption>
              </NativeSelect>
            </label>

            <label className="space-y-1.5 text-xs text-muted-foreground">
              评分偏好
              <NativeSelect
                value={preference}
                onChange={(event) => onPreferenceChange(event.target.value as ScorePreference)}
                className="w-full"
              >
                {(Object.keys(PREFERENCE_LABEL) as ScorePreference[]).map((key) => (
                  <NativeSelectOption key={key} value={key}>
                    {PREFERENCE_LABEL[key]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>

            <div className="space-y-1.5 text-xs text-muted-foreground">
              年份区间
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  aria-label="起始年份"
                  placeholder="起"
                  value={yearFrom ?? ""}
                  onChange={(event) => {
                    const parsed = Number(event.target.value);
                    setYearFrom(event.target.value === "" || Number.isNaN(parsed) ? null : parsed);
                  }}
                  className="h-9 w-full tabular-nums"
                />
                <span aria-hidden="true" className="shrink-0">
                  –
                </span>
                <Input
                  type="number"
                  aria-label="结束年份"
                  placeholder="止"
                  value={yearTo ?? ""}
                  onChange={(event) => {
                    const parsed = Number(event.target.value);
                    setYearTo(event.target.value === "" || Number.isNaN(parsed) ? null : parsed);
                  }}
                  className="h-9 w-full tabular-nums"
                />
              </div>
            </div>

            <label className="space-y-1.5 text-xs text-muted-foreground">
              开放获取
              <NativeSelect
                value={oaFilter}
                onChange={(event) =>
                  setOaFilter(event.target.value as "all" | NonNullable<Paper["oaStatus"]>)
                }
                className="w-full"
              >
                <NativeSelectOption value="all">全部</NativeSelectOption>
                <NativeSelectOption value="verified">已验证 OA</NativeSelectOption>
                <NativeSelectOption value="publisher_only">仅出版商页</NativeSelectOption>
                <NativeSelectOption value="none">无 OA 入口</NativeSelectOption>
              </NativeSelect>
            </label>

            <label className="space-y-1.5 text-xs text-muted-foreground">
              来源
              <NativeSelect
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value as "all" | SourceName)}
                className="w-full"
              >
                <NativeSelectOption value="all">全部</NativeSelectOption>
                <NativeSelectOption value="openalex">openalex</NativeSelectOption>
                <NativeSelectOption value="semanticscholar">semanticscholar</NativeSelectOption>
                <NativeSelectOption value="crossref">crossref</NativeSelectOption>
                <NativeSelectOption value="snapshot">snapshot</NativeSelectOption>
              </NativeSelect>
            </label>

            <label className="space-y-1.5 text-xs text-muted-foreground">
              证据等级
              <NativeSelect
                value={evidenceFilter}
                onChange={(event) => setEvidenceFilter(event.target.value as "all" | EvidenceLevel)}
                className="w-full"
              >
                <NativeSelectOption value="all">全部</NativeSelectOption>
                {(Object.keys(EVIDENCE_LEVEL_LABEL) as EvidenceLevel[]).map((level) => (
                  <NativeSelectOption key={level} value={level}>
                    {EVIDENCE_LEVEL_LABEL[level]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                最低被引
                <Input
                  type="number"
                  min={0}
                  step={10}
                  value={minCitations}
                  onChange={(event) =>
                    setMinCitations(Math.max(0, Number(event.target.value) || 0))
                  }
                  className="h-8 w-24 tabular-nums"
                />
              </label>
              <span className="text-xs text-muted-foreground">
                命中 {filtered.length} 篇{filtered.length > visible.length ? `，表格显示前 ${visible.length} 篇` : ""}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = new Set(selected);
                  if (allSelected) visible.forEach((paper) => next.delete(paper.id));
                  else visible.forEach((paper) => next.add(paper.id));
                  setSelected(next);
                }}
              >
                {allSelected ? "取消全选" : "全选当前结果"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => exportPapers(filtered.filter((paper) => selected.has(paper.id)), "markdown")}
              >
                导出 Markdown（{selected.size}）
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => exportPapers(filtered.filter((paper) => selected.has(paper.id)), "csv")}
              >
                导出 CSV（{selected.size}）
              </Button>
              <Button variant="ghost" size="sm" onClick={() => exportPapers(filtered, "markdown")}>
                导出全部结果（Markdown · {filtered.length} 篇）
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <p className="label-caps">
          文献清单 · 命中 {filtered.length} 篇
          {filtered.length > visible.length ? `，表格显示前 ${visible.length} 篇` : ""}
        </p>
        <div className="overflow-x-auto rounded-md border border-border">
          <Table className="min-w-[1120px] table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={allSelected}
                  onChange={() => {
                    const next = new Set(selected);
                    if (allSelected) visible.forEach((paper) => next.delete(paper.id));
                    else visible.forEach((paper) => next.add(paper.id));
                    setSelected(next);
                  }}
                />
              </TableHead>
              <TableHead className="w-[26%]">标题</TableHead>
              <TableHead className="w-14">年份</TableHead>
              <TableHead className="w-16">被引</TableHead>
              <TableHead className="w-44">发表场所</TableHead>
              <TableHead className="w-32">方向</TableHead>
              <TableHead className="w-24">来源</TableHead>
              <TableHead className="w-24">证据等级</TableHead>
              <TableHead className="w-24">综合评分</TableHead>
              <TableHead className="w-20">证据卡</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((paper) => (
              <TableRow key={paper.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${paper.title}`}
                    checked={selected.has(paper.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(paper.id)) next.delete(paper.id);
                      else next.add(paper.id);
                      setSelected(next);
                    }}
                  />
                </TableCell>
                <TableCell className="align-top">
                  <div className="font-medium leading-snug break-words line-clamp-3">
                    {paper.doi ? (
                      <a
                        href={`https://doi.org/${paper.doi}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline-offset-4 hover:underline"
                      >
                        {paper.title}
                      </a>
                    ) : (
                      paper.title
                    )}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground">
                    {paper.authors.slice(0, 3).join(", ")}
                    {paper.authorCount > 3 ? ` 等 ${paper.authorCount} 人` : ""}
                  </div>
                  {paper.oaUrl ? (
                    <a
                      href={paper.oaUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 inline-block text-[11px] text-muted-foreground underline-offset-4 hover:underline"
                    >
                      开放获取链接
                    </a>
                  ) : null}
                </TableCell>
                <TableCell className="align-top tabular-nums">{paper.year}</TableCell>
                <TableCell className="align-top tabular-nums">
                  {compactNumber(paper.citedByCount)}
                </TableCell>
                <TableCell className="align-top">
                  <div className="truncate text-xs text-muted-foreground" title={paper.venue ?? undefined}>
                    {paper.venue ?? "—"}
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  {(() => {
                    const id = assignment.get(paper.id);
                    if (id === undefined) return <span className="text-xs text-muted-foreground">—</span>;
                    return (
                      <Badge variant="outline" className="block max-w-full truncate">
                        {clusterName.get(id) ?? `方向 ${id}`}
                      </Badge>
                    );
                  })()}
                </TableCell>
                <TableCell className="align-top text-[11px] text-muted-foreground">
                  <div>{paper.provenance.source}</div>
                  <div className="tabular-nums">{paper.provenance.retrievedAt.slice(0, 10)}</div>
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant={levelOf(paper) === "user_verified" ? "default" : "outline"}>
                    {EVIDENCE_LEVEL_LABEL[levelOf(paper)]}
                  </Badge>
                </TableCell>
                <TableCell className="align-top">
                  {(() => {
                    const breakdown = breakdowns.get(paper.id) ?? [];
                    const total = totalScore(breakdown);
                    const tip = breakdown
                      .map((item) => `${item.dimension} ${item.score}/${item.max}：${item.reason}`)
                      .join("\n");
                    return (
                      <span title={tip} className="text-xs tabular-nums">
                        {total}
                        <span className="ml-0.5 text-[11px] text-muted-foreground">/100</span>
                      </span>
                    );
                  })()}
                </TableCell>
                <TableCell className="align-top">
                  <Button variant="outline" size="sm" onClick={() => onOpenCard(paper)}>
                    打开
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        {filtered.length > visibleCount ? (
          <div className="flex justify-center pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVisibleCount((count) => count + 200)}
            >
              显示更多（还有 {filtered.length - visibleCount} 篇）
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
