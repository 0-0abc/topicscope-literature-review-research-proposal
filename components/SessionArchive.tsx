import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { downloadText } from "@/lib/export";
import { searchReportToMarkdown } from "@/lib/export";
import type { Paper, SearchReport } from "@/lib/data/types";
import type { EvidenceNote } from "@/hooks/useEvidenceStore";
import type { ResearchPlan } from "@/lib/ai/plan";
import { useSessionStore, type SavedSession, type ChatMessage, type SavedCheckup, type SavedReview } from "@/hooks/useSessionStore";

export type RestoreMode = "replace" | "merge";

interface Props {
  query: string;
  papers: Paper[];
  report: SearchReport | null;
  evidenceNotes: Record<string, EvidenceNote>;
  planMarkdown: string | null;
  planTitle: string | null;
  plan: ResearchPlan | null;
  chat: ChatMessage[];
  checkup: SavedCheckup | null;
  review: SavedReview | null;
  draftConclusions: string[];
  onRestore: (session: SavedSession, mode: RestoreMode) => void;
}

export function SessionArchive({
  query,
  papers,
  report,
  evidenceNotes,
  planMarkdown,
  planTitle,
  plan,
  chat,
  checkup,
  review,
  draftConclusions,
  onRestore,
}: Props) {
  const store = useSessionStore();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleSave = async () => {
    try {
      const session = await store.save({
        query,
        report,
        papers,
        evidenceNotes,
        planMarkdown,
        planTitle,
        plan,
        chat,
        checkup,
        review,
        draftConclusions,
        note,
      });
      setMessage(`已保存 ${session.id}`);
      setNote("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败");
    }
  };

  const exportMarkdown = (session: SavedSession) => {
    const lines: string[] = [`# 研究会话 ${session.id}`, ""];
    lines.push(`- 研究问题: ${session.query || "（未填写）"}`);
    lines.push(`- 保存时间: ${session.updatedAt.slice(0, 16).replace("T", " ")}`);
    lines.push(`- 论文数: ${session.papers.length}`);
    if (session.note) lines.push(`- 备注: ${session.note}`);
    lines.push("");
    if (session.report) {
      lines.push(searchReportToMarkdown(session.report), "");
    }
    const verified = Object.values(session.evidenceNotes ?? {});
    if (verified.length > 0) {
      lines.push("## 已核对的证据", "");
      for (const entry of verified) {
        const fields = Object.entries(entry.fields ?? {})
          .filter(([, value]) => value)
          .map(([key, value]) => `- ${key}: ${value}`)
          .join("\n");
        if (fields) {
          lines.push(`### ${entry.paperId}`, fields, "");
        }
      }
    }
    if (session.planMarkdown) {
      lines.push("## 研究方案", "", session.planMarkdown, "");
    }
    if (session.draftConclusions && session.draftConclusions.length > 0) {
      lines.push("## 方案草稿结论（研究对话认可）", "");
      for (const item of session.draftConclusions) lines.push(`- ${item}`);
      lines.push("");
    }
    if (session.checkup) {
      const c = session.checkup.result;
      lines.push("## 选题体检", "", `- 想法: ${session.checkup.idea}`);
      lines.push(`- 结论: ${c.verdict.decision} — ${c.verdict.reason}`);
      if (c.flaws.length > 0) {
        lines.push("- 缺陷:");
        for (const f of c.flaws) lines.push(`  - [${f.severity}] ${f.name}`);
      }
      lines.push("");
    }
    if (session.review) {
      const r = session.review.review;
      lines.push("## 文献综述", "", `- 标题: ${r.title}`, `- 研究缺口: ${r.gaps}`, `- 局限: ${r.limitation}`, "");
    }
    if (session.chat && session.chat.length > 0) {
      lines.push("## 研究对话", "");
      for (const m of session.chat) {
        lines.push(m.role === "user" ? `**问**: ${m.content}` : `**答**: ${m.content}`);
        if (m.role === "assistant" && m.evidenceIds?.length) {
          lines.push(`  - 证据 ID: ${m.evidenceIds.join("、")}`);
        }
        lines.push("");
      }
    }
    downloadText(`${session.id}.md`, lines.join("\n"), "text/markdown");
  };

  const exportJson = (session: SavedSession) => {
    downloadText(`${session.id}.json`, JSON.stringify(session, null, 2), "application/json");
  };

  const importJson = async (file: File) => {
    try {
      const text = await file.text();
      await store.importSession(text);
      setMessage("存档已导入");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入失败");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="gap-3 rounded-md border-border py-4 shadow-none">
        <CardContent className="space-y-3 px-4">
          <div className="space-y-1">
            <h2 className="heading-cn text-sm">保存当前研究会话</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              存档会带上当前检索快照、{papers.length} 篇论文、你已经核对过的证据标注、研究方案，以及研究对话、选题体检、文献综述与方案草稿结论。
              存档保存在这台设备的浏览器里（IndexedDB）。当前会话内可查看与导出；静态资源与快照已被 Service Worker 缓存，断网刷新/重开仍可加载。
            </p>
          </div>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="备注：这次会话想解决什么问题、卡在哪里"
            rows={2}
            className="text-xs"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void handleSave()} disabled={papers.length === 0}>
              保存会话
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              导入 JSON 存档
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importJson(file);
                event.target.value = "";
              }}
            />
            <span className="text-[11px] text-muted-foreground">
              {papers.length === 0 ? "还没有检索结果，先在顶部检索或载入离线示例。" : `当前：${papers.length} 篇论文`}
            </span>
          </div>
          {message ? <p className="text-[11px] text-muted-foreground">{message}</p> : null}
        </CardContent>
      </Card>

      <Separator />

      <section className="space-y-3">
        <h2 className="heading-cn text-sm">已保存的会话（{store.sessions.length}）</h2>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          载入会恢复检索快照、论文、证据标注与研究方案。「替换标注」用存档覆盖当前证据标注；
          「合并载入」保留当前标注、同篇同字段冲突时以当前为准，其余并入，避免误丢正在做的核对。
        </p>
        {store.sessions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            还没有存档。保存一次，之后可以随时回到这个研究现场。
          </p>
        ) : (
          <div className="space-y-2">
            {store.sessions.map((session) => (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{session.id}</span>
                    <Badge variant="outline">{session.papers.length} 篇</Badge>
                    {session.planMarkdown ? <Badge variant="secondary">含研究方案</Badge> : null}
                    {session.checkup ? <Badge variant="secondary">含体检</Badge> : null}
                    {session.review ? <Badge variant="secondary">含综述</Badge> : null}
                    {session.chat && session.chat.length > 0 ? (
                      <Badge variant="secondary">{session.chat.length} 条对话</Badge>
                    ) : null}
                    {Object.keys(session.evidenceNotes ?? {}).length > 0 ? (
                      <Badge variant="secondary">
                        {Object.keys(session.evidenceNotes).length} 条证据标注
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {session.query || "（未填写研究问题）"}
                  </p>
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    保存于 {session.updatedAt.slice(0, 16).replace("T", " ")}
                    {session.note ? ` · ${session.note}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => onRestore(session, "replace")}>
                    载入（替换标注）
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onRestore(session, "merge")}>
                    合并载入
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => exportMarkdown(session)}>
                    导出 Markdown
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => exportJson(session)}>
                    导出 JSON
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void store.remove(session.id)}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
