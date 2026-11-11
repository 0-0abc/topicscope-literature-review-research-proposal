import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeTopics } from "../lib/analysis/radar";
import { buildCooccurrence } from "../lib/analysis/cooccurrence";
import { withSnapshotProvenance } from "../lib/data/dedup";
import type { Snapshot } from "../lib/data/types";

const snapshot = JSON.parse(
  readFileSync(resolve(process.cwd(), "public/data/snapshot-medical-segmentation.json"), "utf8"),
) as Snapshot;

const papers = withSnapshotProvenance(snapshot.papers, {
  domain: snapshot.domain,
  generatedAt: snapshot.generatedAt,
  filters: snapshot.filters,
});

let start = performance.now();
const radar = analyzeTopics(papers);
const radarMs = performance.now() - start;

start = performance.now();
const graph = buildCooccurrence(papers);
const graphMs = performance.now() - start;

console.log(`论文 ${papers.length} 篇，聚类 ${radar.clusterCount} 个，用时 ${radarMs.toFixed(1)}ms`);
console.log(`共现图 ${graph.nodes.length} 节点 / ${graph.edges.length} 边，用时 ${graphMs.toFixed(1)}ms\n`);

for (const cluster of radar.clusters) {
  console.log(
    `#${cluster.id} ${cluster.name}  [${cluster.verdict}] n=${cluster.size} (${(cluster.sizeShare * 100).toFixed(1)}%) ` +
      `年份 ${cluster.yearRange[0]}-${cluster.yearRange[1]} 中位${cluster.medianYear} 近三年${(cluster.recentShare * 100).toFixed(0)}% ` +
      `拥挤度${cluster.crowding} 被引中位${cluster.citationMedian} 摘要覆盖${cluster.abstractCoverage}%`,
  );
  console.log(`   词: ${cluster.terms.join(", ")}`);
  console.log(`   场所: ${cluster.topVenues.map((v) => `${v.name}(${v.count})`).join(", ")}`);
  console.log(`   判定: ${cluster.verdictReason}`);
}

console.log("\n共现边 Top 20:");
for (const edge of graph.edges.slice(0, 20)) {
  console.log(`  ${edge.source} — ${edge.target}: 共现 ${edge.weight}，强度 ${edge.lift.toFixed(2)}`);
}
