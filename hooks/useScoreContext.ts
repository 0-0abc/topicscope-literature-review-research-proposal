import { useMemo } from "react";
import type { RadarResult } from "@/lib/analysis/radar";
import {
  queryTermsOf,
  scorePaper,
  type ScoreBreakdown,
  type ScoreContext,
  type ScorePreference,
} from "@/lib/analysis/scoring";
import type { Paper } from "@/lib/data/types";

/** 文献库与证据卡共用同一套评分上下文，保证两处显示一致。 */
export function useScoreContext(
  query: string,
  radar: RadarResult | null,
  assignment: Map<string, number>,
  preference: ScorePreference,
) {
  const scoreContext = useMemo<ScoreContext>(
    () => ({
      query,
      queryTerms: queryTermsOf(query),
      clusterOf: (paper: Paper) => assignment.get(paper.id),
      clusterInfo: (id: number) => {
        const cluster = radar?.clusters.find((item) => item.id === id);
        if (!cluster) return undefined;
        return {
          terms: cluster.terms,
          recentShare: cluster.recentShare,
          crowding: cluster.crowding,
        };
      },
      preference,
      maxYear: radar?.yearRange[1] ?? new Date().getFullYear(),
    }),
    [query, assignment, radar, preference],
  );

  const breakdownOf = useMemo(
    () => (paper: Paper): ScoreBreakdown[] => scorePaper(paper, scoreContext),
    [scoreContext],
  );

  return { scoreContext, breakdownOf };
}
