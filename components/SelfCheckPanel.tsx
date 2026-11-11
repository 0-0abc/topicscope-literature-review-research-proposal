import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { runSelfCheck } from "@/lib/metrics/selfcheck";

export function SelfCheckPanel() {
  const report = useMemo(() => runSelfCheck(), []);
  const [expanded, setExpanded] = useState(false);
  const allPassed = report.passed === report.total;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span
            className={
              allPassed
                ? "inline-block size-2 rounded-full bg-emerald-500"
                : "inline-block size-2 rounded-full bg-destructive"
            }
          />
          <span className="text-sm font-medium tabular-nums">
            自检 {report.passed}/{report.total} 通过
          </span>
          <Badge variant="outline">期望值来自独立 Python 实现</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起明细" : "查看明细"}
        </Button>
      </div>

      {expanded ? (
        <div className="max-h-80 overflow-auto border-t border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">用例</th>
                <th className="px-4 py-2 font-medium">期望值</th>
                <th className="px-4 py-2 font-medium">实际值</th>
                <th className="px-4 py-2 font-medium">结果</th>
              </tr>
            </thead>
            <tbody>
              {report.cases.map((item) => (
                <tr key={item.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-1.5">
                    <span className="text-muted-foreground">{item.group}</span>
                    <span className="ml-1.5">{item.name}</span>
                  </td>
                  <td className="px-4 py-1.5 tabular-nums text-muted-foreground">
                    {item.expected.toPrecision(10)}
                  </td>
                  <td className="px-4 py-1.5 tabular-nums">
                    {item.actual === null ? "—" : item.actual.toPrecision(10)}
                  </td>
                  <td className="px-4 py-1.5">
                    {item.passed ? (
                      <span className="text-emerald-600 dark:text-emerald-400">通过</span>
                    ) : (
                      <span className="text-destructive">未通过</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
