import { runSelfCheck } from "../lib/metrics/selfcheck";

const report = runSelfCheck();

for (const c of report.cases) {
  if (!c.passed) {
    console.error(
      `FAIL ${c.id} ${c.name}: expected ${c.expected}, actual ${c.actual}`,
    );
  }
}

console.log(`自检 ${report.passed}/${report.total} 通过`);

if (report.passed !== report.total) {
  process.exit(1);
}
