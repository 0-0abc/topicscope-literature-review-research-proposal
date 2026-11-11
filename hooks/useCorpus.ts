import { useCallback, useMemo, useState } from "react";
import { analyzeTopics, type RadarResult } from "@/lib/analysis/radar";
import { buildCooccurrence, topPairs, type CooccurrenceGraph, type TermPair } from "@/lib/analysis/cooccurrence";
import { retrieve } from "@/lib/data/retrieval";
import { loadSnapshot as fetchSnapshot } from "@/lib/data/snapshot";
import type { Paper, PaperSource, SearchReport } from "@/lib/data/types";

export const API_KEY_STORAGE = "topicscope.openalex.key";

/** 这些词本身不是研究主题，只在「方法组合」展示时排除（不影响聚类与全局共现图的统计）。 */
const FILLER_TERMS = new Set([
  "anything",
  "something",
  "everything",
  "nothing",
  "anyone",
  "someone",
  "everyone",
  "whatever",
]);

export type CorpusStatus = "idle" | "loading" | "ready" | "error";

export interface CorpusState {
  status: CorpusStatus;
  papers: Paper[];
  source: PaperSource;
  query: string;
  notice: string | null;
  error: string | null;
  radar: RadarResult | null;
  graph: CooccurrenceGraph | null;
  /** 每个方向内部共现最紧密的词对 */
  clusterPairs: Map<number, TermPair[]>;
  /** 本次检索的完整记录：查询、来源、时间、覆盖率、局限 */
  report: SearchReport | null;
  /** 离线快照与在线检索的差异说明 */
  offline: boolean;
  /** 数据来源已降级（OpenAlex 不可用，改用 Crossref） */
  degraded: boolean;
}

const INITIAL: CorpusState = {
  status: "idle",
  papers: [],
  source: "snapshot",
  query: "",
  notice: null,
  error: null,
  radar: null,
  graph: null,
  clusterPairs: new Map(),
  report: null,
  offline: true,
  degraded: false,
};

export function useCorpus() {
  const [state, setState] = useState<CorpusState>(INITIAL);

  const analyze = useCallback(
    (
      papers: Paper[],
      source: PaperSource,
      query: string,
      notice: string | null,
      offline: boolean,
      degraded = false,
      report: SearchReport | null = null,
    ) => {
      const radar = analyzeTopics(papers);
      const graph = buildCooccurrence(papers);
      // 每个方向单独算一遍共现：全局图的词对跨越了所有方向，看不出某个方向内部的方法组合
      const clusterPairs = new Map<number, TermPair[]>();
      for (const cluster of radar.clusters) {
        const members = papers.filter((paper) => radar.assignment.get(paper.id) === cluster.id);
        const clusterGraph = buildCooccurrence(members, {
          terms: 16,
          minDocumentFrequency: 2,
          minEdgeWeight: 3,
          minLift: 1.15,
          maxDocumentFrequencyRatio: 0.6,
        });
        // 只保留两个词都在该方向代表词里的组合，避免把 github.com 这类噪声当成方法组合
        const terms = new Set(cluster.terms);
        const pairs = topPairs(
          clusterGraph.edges.filter(
            (edge) =>
              terms.has(edge.source) &&
              terms.has(edge.target) &&
              !FILLER_TERMS.has(edge.source) &&
              !FILLER_TERMS.has(edge.target),
          ),
          3,
          3,
        );
        clusterPairs.set(cluster.id, pairs);
      }
      setState({
        status: "ready",
        papers,
        source,
        query,
        notice,
        error: null,
        radar,
        graph,
        clusterPairs,
        report,
        offline,
        degraded,
      });
    },
    [],
  );

  const loadSnapshot = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "loading", error: null }));
    try {
      const snapshot = await fetchSnapshot();
      analyze(
        snapshot.papers,
        "snapshot",
        snapshot.report.job.rawQuestion,
        `离线快照：${snapshot.papers.length} 篇，${snapshot.report.sourceReports[0]?.filter ?? ""}。检索于 ${snapshot.report.retrievedAt.slice(0, 10)}。`,
        true,
        false,
        snapshot.report,
      );
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : "离线快照加载失败",
      }));
    }
  }, [analyze]);

  const searchOnline = useCallback(
    async (query: string, apiKey?: string, force = false) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      setState((prev) => ({ ...prev, status: "loading", error: null }));
      try {
        const result = await retrieve(trimmed, { apiKey, force });
        if (result.papers.length === 0) {
          setState((prev) => ({
            ...prev,
            status: "error",
            error: `OpenAlex 没有返回「${trimmed}」相关的结果，换个说法试试。`,
          }));
          return;
        }
        analyze(
          result.papers,
          result.source,
          trimmed,
          result.detail,
          false,
          result.degraded,
          result.report,
        );
      } catch (error) {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: error instanceof Error ? error.message : "在线检索失败",
        }));
      }
    },
    [analyze],
  );

  const byId = useMemo(() => {
    const map = new Map<string, Paper>();
    for (const paper of state.papers) map.set(paper.id, paper);
    return map;
  }, [state.papers]);

  /** 从研究档案恢复：论文与检索快照都在本地，不依赖网络。 */
  const restore = useCallback(
    (papers: Paper[], report: SearchReport | null, query: string) => {
      const source = report?.sourceReports?.[0]?.source;
      const paperSource: PaperSource =
        source === "openalex" ? "openalex" : source === "crossref" ? "crossref" : "snapshot";
      analyze(
        papers,
        paperSource,
        query,
        `已从研究档案恢复 ${papers.length} 篇论文，检索于 ${report?.retrievedAt.slice(0, 10) ?? "本地存档"}。`,
        false,
        report?.degraded ?? false,
        report,
      );
    },
    [analyze],
  );

  return { ...state, byId, loadSnapshot, searchOnline, restore };
}

export function readStoredApiKey(): string {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredApiKey(key: string): void {
  try {
    if (key) window.localStorage.setItem(API_KEY_STORAGE, key);
    else window.localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}
