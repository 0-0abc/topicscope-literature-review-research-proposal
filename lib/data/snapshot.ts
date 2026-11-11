import type { Paper, SearchReport, Snapshot } from "./types";
import { withSnapshotProvenance } from "./dedup";

export const SNAPSHOT_URL = "/data/snapshot-medical-segmentation.json";

/** 离线快照按年份均衡抽样，界面里的占比不能当作真实领域产出比例。 */
export const SNAPSHOT_SAMPLE_FRAME =
  "离线快照按年份均衡抽样（每年固定配额），用于观察结构而不是反映真实论文总量；方向占比不等于真实产出比例。";

export async function loadSnapshot(
  url = SNAPSHOT_URL,
): Promise<{ papers: Paper[]; report: SearchReport }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`离线快照加载失败（${response.status}）`);
  }
  const snapshot = (await response.json()) as Snapshot;
  const papers = withSnapshotProvenance(snapshot.papers, {
    domain: snapshot.domain,
    generatedAt: snapshot.generatedAt,
    filters: snapshot.filters,
  });
  const withAbstract = papers.filter((paper) => paper.provenance.abstractAvailable).length;
  const withOa = papers.filter((paper) => paper.oaUrl).length;
  const report: SearchReport = {
    job: {
      rawQuestion: snapshot.domain,
      queryVariants: [snapshot.domain],
      constraints: {},
      sourcePlan: ["snapshot"],
    },
    sourceReports: [
      {
        source: "snapshot",
        filter: snapshot.filters,
        returned: papers.length,
        failed: false,
        abstractCoverage: Math.round((withAbstract / papers.length) * 100),
        oaCoverage: Math.round((withOa / papers.length) * 100),
      },
    ],
    totalBeforeDedup: papers.length,
    totalAfterDedup: papers.length,
    removedByDedup: 0,
    abstractCoverage: Math.round((withAbstract / papers.length) * 100),
    oaCoverage: Math.round((withOa / papers.length) * 100),
    limitations: [
      "快照只覆盖一个检索式，换方向需要在线检索。",
      SNAPSHOT_SAMPLE_FRAME,
    ],
    sampleFrame: SNAPSHOT_SAMPLE_FRAME,
    fromCache: false,
    degraded: false,
    retrievedAt: snapshot.generatedAt,
  };
  return { papers, report };
}
