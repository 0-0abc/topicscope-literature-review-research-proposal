import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RadarView } from "@/components/RadarView";
import { AlignView } from "@/components/AlignView";
import { LibraryView } from "@/components/LibraryView";
import { ReviewGenerator } from "@/components/ReviewGenerator";
import { FeasibilityChecker, type CheckupSeed } from "@/components/FeasibilityChecker";
import { PlanGenerator } from "@/components/PlanGenerator";
import { ResearchChat } from "@/components/ResearchChat";
import { PaperCard, paperEvidenceLevel } from "@/components/PaperCard";
import { SessionArchive } from "@/components/SessionArchive";
import type { TopicCluster } from "@/lib/analysis/radar";
import { buildDirectionContext } from "@/lib/ai/directions";
import type { ResearchPlan } from "@/lib/ai/plan";
import type { Paper } from "@/lib/data/types";
import type { ScorePreference } from "@/lib/analysis/scoring";
import { readStoredApiKey, useCorpus, writeStoredApiKey } from "@/hooks/useCorpus";
import { useEvidenceStore } from "@/hooks/useEvidenceStore";
import { useScoreContext } from "@/hooks/useScoreContext";
import type { SavedSession } from "@/hooks/useSessionStore";

type NavGroup = "radar" | "library" | "chat" | "output" | "align";
type OutputSub = "review" | "checkup" | "plan" | "archive";

function groupOf(tab: string): NavGroup {
  if (tab === "review" || tab === "checkup" || tab === "plan" || tab === "archive") return "output";
  return tab as NavGroup;
}

export default function App() {
  const corpus = useCorpus();
  const evidence = useEvidenceStore();
  const [group, setGroup] = useState<NavGroup>("radar");
  const [outputSub, setOutputSub] = useState<OutputSub>("plan");
  const [planDraft, setPlanDraft] = useState<string[]>([]);
  const [query, setQuery] = useState("medical image segmentation");
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [clusterFilter, setClusterFilter] = useState<number | null>(null);
  const [cardPaper, setCardPaper] = useState<Paper | null>(null);
  const [preference, setPreference] = useState<ScorePreference>("balanced");
  const [latestPlan, setLatestPlan] = useState<{
    plan: ResearchPlan;
    markdown: string;
  } | null>(null);
  const [checkupSeed, setCheckupSeed] = useState<CheckupSeed | null>(null);
  const [planRestoreToken, setPlanRestoreToken] = useState(0);

  const goTo = (t: string) => {
    const g = groupOf(t);
    setGroup(g);
    if (g === "output") setOutputSub(t as OutputSub);
  };

  const startCheckup = (idea: string, clusterId: number | null) => {
    setCheckupSeed({ idea, clusterId });
    goTo("checkup");
  };

  const { breakdownOf } = useScoreContext(
    corpus.query,
    corpus.radar,
    corpus.radar?.assignment ?? new Map(),
    preference,
  );

  const directionContext = useMemo(
    () =>
      corpus.radar
        ? buildDirectionContext(corpus.query, corpus.radar, corpus.graph, corpus.clusterPairs, {
            abstractCoverage: corpus.report?.abstractCoverage ?? 0,
            oaCoverage: corpus.report?.oaCoverage ?? 0,
          })
        : null,
    [corpus.radar, corpus.graph, corpus.clusterPairs, corpus.query, corpus.report],
  );

  useEffect(() => {
    setApiKey(readStoredApiKey());
    void corpus.loadSnapshot();
    // 首次进入自动载入离线示例，之后不再自动触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = () => {
    void corpus.searchOnline(query, apiKey || undefined);
    setClusterFilter(null);
    goTo("radar");
  };

  const handleRefresh = () => {
    void corpus.searchOnline(query, apiKey || undefined, true);
    setClusterFilter(null);
    goTo("radar");
  };

  const handleSnapshot = () => {
    void corpus.loadSnapshot();
    setClusterFilter(null);
    goTo("radar");
  };

  const inspectCluster = (cluster: TopicCluster) => {
    setClusterFilter(cluster.id);
    goTo("library");
  };

  const restoreSession = (session: SavedSession, mode: "replace" | "merge") => {
    corpus.restore(session.papers, session.report, session.query);
    if (mode === "merge") evidence.mergeAll(session.evidenceNotes ?? {});
    else evidence.replaceAll(session.evidenceNotes ?? {});
    setLatestPlan(session.plan ? { plan: session.plan, markdown: session.planMarkdown ?? "" } : null);
    setPlanRestoreToken((token) => token + 1);
    setQuery(session.query);
    goTo("radar");
  };

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-lg font-semibold tracking-tight">TopicScope</span>
            <span className="hidden h-3 w-px bg-border sm:block" />
            <span className="label-caps">选题雷达 · 指标口径对齐器</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSearch();
              }}
              placeholder="输入研究方向，例如 medical image segmentation"
              aria-label="研究方向"
              className="h-9 min-w-0 flex-1 lg:w-80 lg:flex-none"
            />
            <Button size="sm" onClick={handleSearch} disabled={corpus.status === "loading"}>
              {corpus.status === "loading" ? "检索中…" : "在线检索"}
            </Button>
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={corpus.status === "loading"}>
              重新检索
            </Button>
            <Button size="sm" variant="outline" onClick={handleSnapshot}>
              离线示例
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSettings((value) => !value)}>
              设置
            </Button>
          </div>
        </div>

        {showSettings ? (
          <div className="border-t border-border bg-muted/40">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-end">
              <label className="flex-1 space-y-1.5 text-xs text-muted-foreground">
                OpenAlex API key（可选，只保存在这台设备的浏览器里）
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    writeStoredApiKey(event.target.value);
                  }}
                  placeholder="留空也能检索，只是配额更小"
                  className="h-9 font-mono text-xs"
                />
              </label>
              <p className="text-[11px] leading-relaxed text-muted-foreground sm:max-w-md">
                key 不会被写进站点代码或打包产物，只在你点击「在线检索」时随请求发往 OpenAlex。
                没有 key 也能用：免费额度按 IP 计（1000 额度/天，一次检索 2 次请求），同一网络下多人共用容易用尽；
                填了自己的 key 后额度提升 10 倍。额度用尽时会自动改用 Crossref 备选源，同一检索词 12 小时内走本地缓存、不再消耗额度。
              </p>
            </div>
          </div>
        ) : null}
      </header>

      {corpus.notice ? (
        <div className="border-b border-border bg-muted/40">
          <div className="mx-auto max-w-6xl px-5 py-2 text-[11px] text-muted-foreground">
            {corpus.notice}
          </div>
        </div>
      ) : null}

      {corpus.degraded ? (
        <div className="border-b border-border bg-muted/60">
          <div className="mx-auto max-w-6xl px-5 py-2 text-[11px] text-muted-foreground">
            当前结果来自 Crossref 备选源（OpenAlex 额度受限），没有主题标签，方向判定与共现图会偏粗，仅供参考。
          </div>
        </div>
      ) : null}

      {corpus.error ? (
        <div className="border-b border-border bg-destructive/5">
          <div className="mx-auto max-w-6xl px-4 py-2 text-xs text-destructive">
            {corpus.error}
          </div>
        </div>
      ) : null}

      <main className="mx-auto max-w-6xl px-5 py-7">
        <Tabs value={group} onValueChange={(value) => setGroup(value as NavGroup)}>
          <TabsList
            variant="line"
            className="w-full justify-start gap-6 overflow-x-auto whitespace-nowrap border-b border-border pb-0 sm:gap-8"
          >
            <TabsTrigger
              value="radar"
              onClick={() => setGroup("radar")}
              className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
            >
              检索与雷达
            </TabsTrigger>
            <TabsTrigger
              value="library"
              onClick={() => setGroup("library")}
              className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
            >
              论文与证据
              {corpus.papers.length > 0 ? (
                <Badge variant="outline" className="ml-1.5 rounded-full px-1.5 py-0 text-[10px]">
                  {corpus.papers.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger
              value="chat"
              onClick={() => setGroup("chat")}
              className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
            >
              研究对话
              {planDraft.length > 0 ? (
                <Badge variant="secondary" className="ml-1.5 rounded-full px-1.5 py-0 text-[10px]">
                  {planDraft.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger
              value="output"
              className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
            >
              方案与档案
            </TabsTrigger>
            <TabsTrigger
              value="align"
              onClick={() => setGroup("align")}
              className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
            >
              指标口径对齐
            </TabsTrigger>
          </TabsList>

          <TabsContent value="radar" className="mt-5">
            <RadarView
              radar={corpus.radar}
              graph={corpus.graph}
              clusterPairs={corpus.clusterPairs}
              directionContext={directionContext}
              report={corpus.report}
              onInspectCluster={inspectCluster}
              onCheckup={startCheckup}
            />
          </TabsContent>

          <TabsContent value="library" className="mt-5">
            <LibraryView
              papers={corpus.papers}
              radar={corpus.radar}
              assignment={corpus.radar?.assignment ?? new Map()}
              clusterFilter={clusterFilter}
              onClusterFilterChange={setClusterFilter}
              report={corpus.report}
              levelOf={(paper) => paperEvidenceLevel(paper, evidence.notes[paper.id])}
              onOpenCard={setCardPaper}
              query={corpus.query}
              preference={preference}
              onPreferenceChange={setPreference}
            />
          </TabsContent>

          <TabsContent value="chat" className="mt-5">
            <ResearchChat
              key={corpus.query}
              context={directionContext}
              radar={corpus.radar}
              papers={corpus.papers}
              byId={corpus.byId}
              evidenceNotes={evidence.notes}
              report={corpus.report}
              onAddDraft={(conclusion) =>
                setPlanDraft((prev) =>
                  prev.includes(conclusion) ? prev : [...prev, conclusion].slice(-8),
                )
              }
            />
          </TabsContent>

          <TabsContent value="output" className="mt-5">
            <Tabs value={outputSub} onValueChange={(value) => setOutputSub(value as OutputSub)}>
              <TabsList
                variant="line"
                className="justify-start gap-5 overflow-x-auto whitespace-nowrap border-b border-border pb-0"
              >
                <TabsTrigger
                  value="review"
                  className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
                >
                  文献综述
                </TabsTrigger>
                <TabsTrigger
                  value="checkup"
                  className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
                >
                  选题体检
                </TabsTrigger>
                <TabsTrigger
                  value="plan"
                  className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
                >
                  研究方案
                </TabsTrigger>
                <TabsTrigger
                  value="archive"
                  className="rounded-none px-0 pb-2 text-[13px] data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
                >
                  研究档案
                </TabsTrigger>
              </TabsList>

              <TabsContent value="review" className="mt-4">
                <ReviewGenerator
                  context={directionContext}
                  radar={corpus.radar}
                  byId={corpus.byId}
                  report={corpus.report}
                />
              </TabsContent>

              <TabsContent value="checkup" className="mt-4">
                <FeasibilityChecker
                  context={directionContext}
                  radar={corpus.radar}
                  byId={corpus.byId}
                  report={corpus.report}
                  seed={checkupSeed}
                />
              </TabsContent>

              <TabsContent value="plan" className="mt-4">
                <PlanGenerator
                  key={planRestoreToken}
                  context={directionContext}
                  report={corpus.report}
                  evidenceNotes={evidence.notes}
                  papers={corpus.papers}
                  draftConclusions={planDraft}
                  restoredPlan={latestPlan}
                  onPlanChange={(plan, markdown) =>
                    setLatestPlan(plan ? { plan, markdown } : null)
                  }
                />
              </TabsContent>

              <TabsContent value="archive" className="mt-4">
                <SessionArchive
                  query={corpus.query}
                  papers={corpus.papers}
                  report={corpus.report}
                  evidenceNotes={evidence.notes}
                  planMarkdown={latestPlan?.markdown ?? null}
                  planTitle={latestPlan?.plan.title ?? null}
                  plan={latestPlan?.plan ?? null}
                  onRestore={restoreSession}
                />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="align" className="mt-5">
            <AlignView />
          </TabsContent>
        </Tabs>
      </main>

      <PaperCard
        paper={cardPaper}
        open={cardPaper !== null}
        onOpenChange={(open) => {
          if (!open) setCardPaper(null);
        }}
        note={cardPaper ? evidence.notes[cardPaper.id] : undefined}
        clusterName={
          cardPaper === null
            ? undefined
            : (() => {
                const id = corpus.radar?.assignment.get(cardPaper.id);
                if (id === undefined) return undefined;
                return corpus.radar?.clusters.find((cluster) => cluster.id === id)?.name;
              })()
        }
        breakdown={cardPaper ? breakdownOf(cardPaper) : undefined}
        onFieldChange={(key, value) => {
          if (cardPaper) evidence.setField(cardPaper.id, key, value);
        }}
        onToggleField={(key) => {
          if (cardPaper) evidence.toggleFieldVerified(cardPaper.id, key);
        }}
        onToggleFullText={() => {
          if (cardPaper) evidence.toggleFullText(cardPaper.id);
        }}
      />

      <Separator />

      <footer className="mx-auto max-w-6xl px-5 py-8">
        <div className="border-t border-border pt-4">
          <p className="label-caps mb-2">数据与方法说明</p>
          <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
            书目数据来自 OpenAlex 开放接口，标题与摘要版权归原作者所有。聚类、覆盖判定、指标换算与六维评分由
            TF-IDF + 球面 k-means 等在你的浏览器本地计算，不上传。但「在线检索」会把检索词发往 OpenAlex /
            Crossref；「AI 方向建议 / 综述 / 体检 / 方案 / 对话」会把你选择的统计数字、论文标题与摘要节选、
            以及你勾选的已核对证据内容发送到站点自带的模型服务。研究档案与证据标注只保存在本机浏览器。
            指标口径的换算规则经过独立实现交叉验证。
          </p>
        </div>
      </footer>
    </div>
  );
}
