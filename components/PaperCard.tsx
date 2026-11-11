import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  EVIDENCE_FIELDS,
  type EvidenceLevel,
  type EvidenceNote,
} from "@/hooks/useEvidenceStore";
import type { ScoreBreakdown } from "@/lib/analysis/scoring";
import type { Paper } from "@/lib/data/types";
import { downloadText, formatGB7714 } from "@/lib/export";

export const EVIDENCE_LEVEL_LABEL: Record<EvidenceLevel, string> = {
  metadata: "仅元数据",
  abstract: "摘要级",
  full_text: "全文级",
  user_verified: "已人工核对",
};

export function paperEvidenceLevel(paper: Paper, note?: EvidenceNote): EvidenceLevel {
  if (note?.fullTextVerified) return "user_verified";
  if (paper.provenance.abstractAvailable) return "abstract";
  return "metadata";
}

/** 当前材料无法判断的内容：随证据等级变化，不允许模型补写。 */
const NOT_ASSESSABLE: Record<EvidenceLevel, string[]> = {
  metadata: [
    "摘要中的任务、方法与结果细节",
    "实验设置、基线与评价指标口径",
    "图表、公式与正文论证",
    "作者在正文里承认的局限",
  ],
  abstract: [
    "正文中的图表与公式编号",
    "训练超参与实现细节",
    "逐表逐图的确切数字",
    "附录中的补充实验",
  ],
  full_text: [
    "未获取到的补充材料与附录",
  ],
  user_verified: [
    "你尚未核对的补充材料与附录",
  ],
};

interface Props {
  paper: Paper | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note?: EvidenceNote;
  clusterName?: string;
  /** 六维评分拆解 */
  breakdown?: ScoreBreakdown[];
  onFieldChange: (key: (typeof EVIDENCE_FIELDS)[number]["key"], value: string) => void;
  onToggleField: (key: (typeof EVIDENCE_FIELDS)[number]["key"]) => void;
  onToggleFullText: () => void;
}

export function PaperCard({
  paper,
  open,
  onOpenChange,
  note,
  clusterName,
  breakdown,
  onFieldChange,
  onToggleField,
  onToggleFullText,
}: Props) {
  if (!paper) return null;

  const level = paperEvidenceLevel(paper, note);
  const fields = note?.fields ?? {};
  const verified = note?.verifiedFields ?? [];

  const exportCard = () => {
    const lines: string[] = [`# 证据卡：${paper.title}`, ""];
    lines.push(`- 证据等级: ${EVIDENCE_LEVEL_LABEL[level]}`);
    lines.push(`- 作者: ${paper.authors.join(", ") || "—"}`);
    lines.push(`- 年份/场所: ${paper.year} · ${paper.venue ?? "—"}`);
    lines.push(`- 被引: ${paper.citedByCount}`);
    if (paper.doi) lines.push(`- DOI: ${paper.doi}`);
    lines.push(`- GB/T 7714: ${formatGB7714(paper)}`);
    if (paper.oaUrl) lines.push(`- 开放获取: ${paper.oaUrl}`);
    if (clusterName) lines.push(`- 所属方向: ${clusterName}`);
    lines.push(
      `- 来源: ${paper.provenance.source}（${paper.provenance.sourceId}），检索于 ${paper.provenance.retrievedAt.slice(0, 10)}`,
    );
    lines.push(`- 去重键: ${paper.provenance.dedupKey}`, "");
    if (paper.abstract) {
      lines.push("## 摘要原文", "", paper.abstract, "");
    }
    lines.push("## 已核对字段", "");
    for (const field of EVIDENCE_FIELDS) {
      const value = fields[field.key];
      if (!value) continue;
      lines.push(
        `### ${field.label}${verified.includes(field.key) ? "（已核对）" : ""}`,
        "",
        value,
        "",
      );
    }
    lines.push("## 当前材料无法判断", "");
    for (const item of NOT_ASSESSABLE[level]) lines.push(`- ${item}`);
    lines.push("");
    downloadText(
      `topicscope-evidence-${paper.id.slice(0, 8)}.md`,
      lines.join("\n"),
      "text/markdown",
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="heading-cn pr-8 text-base leading-snug">{paper.title}</SheetTitle>
          <SheetDescription className="text-xs">
            证据卡只呈现当前材料支持的内容。空字段表示还没有材料支撑，不要当成「论文没有这项」。
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={level === "user_verified" ? "default" : "secondary"}>
              {EVIDENCE_LEVEL_LABEL[level]}
            </Badge>
            {clusterName ? <Badge variant="outline">{clusterName}</Badge> : null}
            <Badge variant="outline">来源 {paper.provenance.source}</Badge>
          </div>

          <section className="space-y-1.5 text-xs">
            <h3 className="heading-cn text-xs">文献元数据</h3>
            <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 leading-relaxed">
              <dt className="text-muted-foreground">作者</dt>
              <dd>{paper.authors.join(", ") || "—"}</dd>
              <dt className="text-muted-foreground">年份</dt>
              <dd className="tabular-nums">{paper.year}</dd>
              <dt className="text-muted-foreground">场所</dt>
              <dd>{paper.venue ?? "—"}</dd>
              <dt className="text-muted-foreground">被引</dt>
              <dd className="tabular-nums">{paper.citedByCount}</dd>
              <dt className="text-muted-foreground">DOI</dt>
              <dd>
                {paper.doi ? (
                  <a
                    href={`https://doi.org/${paper.doi}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline-offset-4 hover:underline"
                  >
                    {paper.doi}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt className="text-muted-foreground">开放获取</dt>
              <dd>
                {paper.oaUrl ? (
                  <a
                    href={paper.oaUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline-offset-4 hover:underline"
                  >
                    打开原文
                  </a>
                ) : (
                  "当前没有可用的开放获取入口"
                )}
              </dd>
              <dt className="text-muted-foreground">检索时间</dt>
              <dd>{paper.provenance.retrievedAt.slice(0, 10)}</dd>
              <dt className="text-muted-foreground">去重键</dt>
              <dd className="break-all font-mono text-[11px]">{paper.provenance.dedupKey}</dd>
            </dl>
          </section>

          <Separator />

          <section className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="heading-cn text-xs">结构化字段</h3>
              <p className="text-[11px] text-muted-foreground">
                读到原文再填，勾选表示你已经核对过这一条
              </p>
            </div>
            <div className="space-y-3">
              {EVIDENCE_FIELDS.map((field) => {
                const isVerified = verified.includes(field.key);
                return (
                  <div key={field.key} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor={`evidence-${paper.id}-${field.key}`}
                        className="text-xs font-medium"
                      >
                        {field.label}
                        {isVerified ? (
                          <span className="ml-1.5 text-[11px] text-muted-foreground">已核对</span>
                        ) : null}
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => onToggleField(field.key)}
                      >
                        {isVerified ? "取消核对" : "标记已核对"}
                      </Button>
                    </div>
                    <Textarea
                      id={`evidence-${paper.id}-${field.key}`}
                      value={fields[field.key] ?? ""}
                      placeholder={field.hint}
                      rows={2}
                      className="min-h-14 text-xs"
                      onChange={(event) => onFieldChange(field.key, event.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <Separator />

          {breakdown && breakdown.length > 0 ? (
            <section className="space-y-1.5 text-xs">
              <h3 className="heading-cn text-xs">候选评分（六维拆解）</h3>
              <div className="space-y-1">
                {breakdown.map((item) => (
                  <div key={item.dimension} className="flex items-start gap-2">
                    <span className="w-28 shrink-0 text-muted-foreground">{item.dimension}</span>
                    <span className="w-14 shrink-0 tabular-nums">
                      {item.score}/{item.max}
                    </span>
                    <span className="leading-relaxed text-muted-foreground">{item.reason}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                总分只用于排序。缺摘要只降低证据完整度，缺代码只标记「需要自行重建」，引用次数不计入方法优越性。
              </p>
            </section>
          ) : null}

          <Separator />

          <section className="space-y-1.5 text-xs">
            <h3 className="heading-cn text-xs">当前材料无法判断</h3>
            <ul className="list-disc space-y-0.5 pl-4 leading-relaxed text-muted-foreground">
              {NOT_ASSESSABLE[level].map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          {paper.abstract ? (
            <>
              <Separator />
              <section className="space-y-1.5 text-xs">
                <h3 className="heading-cn text-xs">摘要原文</h3>
                <p className="leading-relaxed text-muted-foreground">{paper.abstract}</p>
              </section>
            </>
          ) : null}

          <details className="rounded-md border border-border px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium">审稿人视角速查（读这篇时对照）</summary>
            <div className="mt-2 space-y-2 leading-relaxed text-muted-foreground">
              <div>
                <p className="font-medium text-foreground">审稿人希望看到</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>新问题：尤其是定义一个有用的新问题</li>
                  <li>新方法：解决旧问题或新问题的新颖有效的方法</li>
                  <li>好故事：写作清楚、逻辑性强</li>
                  <li>好呈现：排版与图表规范，没有低级错误</li>
                </ul>
              </div>
              <div>
                <p className="font-medium text-foreground">审稿人讨厌看到</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>老问题 + 现有方法的简单组合</li>
                  <li>新问题却用社区里早已用滥的方法</li>
                  <li>逻辑、写作、图表呈现差</li>
                  <li>实验没有强基线、设定不合适</li>
                </ul>
              </div>
              <p className="text-[11px]">
                速查改编自 HKUSTDial/Supervisor-Skills 手册《如何评价一篇论文的质量》（CC-BY-4.0）。
              </p>
            </div>
          </details>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onToggleFullText}>
              {note?.fullTextVerified ? "取消「已核对全文」" : "标记为已核对全文"}
            </Button>
            <Button variant="ghost" size="sm" onClick={exportCard}>
              导出证据卡
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            标注只保存在这台设备的浏览器里，不会随检索上传。模型不会自动升级证据等级。
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
