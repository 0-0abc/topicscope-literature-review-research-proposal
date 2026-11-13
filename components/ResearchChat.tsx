import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, requestJson } from "@/lib/api";
import { downloadText } from "@/lib/export";
import type { DirectionContext } from "@/lib/ai/directions";
import type { TopicCluster } from "@/lib/analysis/radar";
import type { Paper, SearchReport } from "@/lib/data/types";
import type { EvidenceNote } from "@/hooks/useEvidenceStore";
import { EVIDENCE_FIELDS } from "@/hooks/useEvidenceStore";
import type { ChatMessage } from "@/hooks/useSessionStore";
import { useFunctionProbe } from "@/hooks/useFunctionProbe";
import { AiServiceNotice } from "@/components/AiServiceNotice";

const ERROR_MESSAGES: Record<string, string> = {
  service_not_configured: "研究对话暂时不可用：服务端还没有配置模型接口的 key。",
  upstream_auth_failed: "研究对话暂时不可用：服务端 key 没有通过鉴权。",
  upstream_rate_limited: "模型接口当前限流，请稍后再试。",
  upstream_timeout: "模型这次响应超时，请稍后再试。",
  upstream_error: "模型接口暂时不可用，请稍后再试。",
  upstream_invalid_output: "模型这次没有给出可用格式的回答，请再试一次。",
  bad_request: "请先输入一个问题。",
  rate_limited: "调用过于频繁，请过几分钟再试。",
  network_error: "请求没能发出去，请检查网络后重试。",
};

interface ChatRef {
  n: number;
  field?: string;
}

/** 每次发送时实际送入模型的论文清单（标题+字段来源），按助手消息下标记录。 */
interface SentInput {
  clusterName: string | null;
  papers: { title: string; source: string }[];
}

/**
 * S2：focus 为全样本时，按提问关键词自动匹配最相关的簇。
 * 提问小写分词后与 cluster.terms 求交集（中文词用子串包含兜底），交集最多者胜出；
 * 没有任何匹配时返回 null，退回全样本被引最高 8 篇。
 */
function pickClusterForQuestion(question: string, clusters: TopicCluster[]): TopicCluster | null {
  const q = question.toLowerCase();
  const tokens = q.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  let best: TopicCluster | null = null;
  let bestScore = 0;
  for (const cluster of clusters) {
    let score = 0;
    for (const term of cluster.terms) {
      const t = term.toLowerCase();
      if (!t) continue;
      if (tokens.includes(t) || (t.length >= 2 && q.includes(t))) score += 1;
    }
    if (score > bestScore) {
      best = cluster;
      bestScore = score;
    }
  }
  return best;
}

interface Props {
  context: DirectionContext | null;
  radar: { clusters: TopicCluster[]; assignment: Map<string, number> } | null;
  papers: Paper[];
  byId: Map<string, Paper>;
  evidenceNotes: Record<string, EvidenceNote>;
  report: SearchReport | null;
  onAddDraft: (conclusion: string) => void;
  /** 对话记录由上层持有，便于存进研究档案与恢复回填 */
  messages: ChatMessage[];
  onMessagesChange: (messages: ChatMessage[]) => void;
}

export function ResearchChat({ context, radar, papers, byId, evidenceNotes, report, onAddDraft, messages, onMessagesChange }: Props) {
  const available = useFunctionProbe();
  const [focus, setFocus] = useState<string>("all");
  const [includeVerified, setIncludeVerified] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentInputs, setSentInputs] = useState<Record<number, SentInput>>({});

  const autoCluster = useMemo(
    () =>
      focus === "all" && input.trim()
        ? pickClusterForQuestion(input, radar?.clusters ?? [])
        : null,
    [focus, input, radar],
  );

  const focusPapers = useMemo(() => {
    let pool: Paper[];
    if (focus !== "all") {
      pool = papers.filter((p) => radar?.assignment.get(p.id) === Number(focus));
    } else if (autoCluster) {
      const ids = new Set(autoCluster.paperIds);
      pool = papers.filter((p) => ids.has(p.id));
    } else {
      pool = papers;
    }
    return [...pool].sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0)).slice(0, 8);
  }, [papers, radar, focus, autoCluster]);

  const verified = useMemo(() => {
    if (!includeVerified) return [];
    const out: { paperId: string; paperTitle: string; fields: { label: string; value: string; location?: string }[] }[] = [];
    for (const note of Object.values(evidenceNotes)) {
      const fields = (note.verifiedFields ?? [])
        .map((key) => {
          const meta = EVIDENCE_FIELDS.find((f) => f.key === key);
          const value = note.fields?.[key];
          if (!meta || !value?.trim()) return null;
          return { label: meta.label, value: value.trim(), location: note.fieldMeta?.[key]?.location };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (fields.length) out.push({ paperId: note.paperId, paperTitle: byId.get(note.paperId)?.title ?? note.paperId, fields });
    }
    return out;
  }, [evidenceNotes, includeVerified, byId]);

  if (available !== "ready") {
    return <AiServiceNotice status={available} feature="研究对话" />;
  }

  const send = async () => {
    const question = input.trim();
    if (!question || !context || busy) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: question }];
    onMessagesChange(history);
    setInput("");
    setBusy(true);
    setError(null);
    // 冻结本次实际送入的论文与来源，回答的 refs 按这份清单回查，不受后续切换影响
    const sentPapers = focusPapers;
    const sentClusterName =
      focus === "all"
        ? autoCluster?.name ?? null
        : radar?.clusters.find((c) => String(c.id) === focus)?.name ?? null;
    const verifiedIds = new Set(verified.map((item) => item.paperId));
    try {
      const raw = await requestJson(
        "/functions/v1/app/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
            papers: sentPapers.map((p, i) => ({
              n: i + 1,
              title: p.title,
              year: p.year,
              abstract: p.abstract ?? "",
            })),
            verifiedEvidence: verified,
          }),
        },
        ERROR_MESSAGES,
      );
      const body = raw as { answer?: string; refs?: ChatRef[]; evidenceIds?: string[]; uncertain?: string };
      setSentInputs((prev) => ({
        ...prev,
        [history.length]: {
          clusterName: sentClusterName,
          papers: sentPapers.map((p) => ({
            title: p.title,
            source: verifiedIds.has(p.id) ? "摘要+人工核对" : "摘要",
          })),
        },
      }));
      onMessagesChange([
        ...history,
        {
          role: "assistant",
          content: body.answer ?? "",
          refs: body.refs ?? [],
          evidenceIds: body.evidenceIds ?? [],
          uncertain: body.uncertain ?? "",
        },
      ]);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "对话失败，请稍后再试。");
    } finally {
      setBusy(false);
    }
  };

  /** refs 回查标题：优先用发送时冻结的清单，档案回填的旧消息退回当前选择。 */
  const titleOfRef = (messageIndex: number, n: number): string | null =>
    sentInputs[messageIndex]?.papers[n - 1]?.title ?? focusPapers[n - 1]?.title ?? null;

  const exportChat = () => {
    const lines: string[] = [`# 研究对话记录`, ""];
    lines.push(`- 检索式: ${report?.job.rawQuestion ?? "（离线样本）"}`);
    lines.push(`- 导出时间: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
    lines.push(`- 消息数: ${messages.length}`, "");
    for (const [i, m] of messages.entries()) {
      lines.push(m.role === "user" ? `## 问` : `## 答`, "", m.content, "");
      if (m.role === "assistant") {
        if (m.refs?.length) {
          lines.push(
            "引用: " +
              m.refs
                .map((r) => {
                  const title = titleOfRef(i, r.n);
                  return `[${r.n}] ${title ?? `论文${r.n}`}${r.field ? ` · ${r.field}（人工核对）` : " · 摘要"}`;
                })
                .join("；"),
            "",
          );
        } else {
          lines.push("本次回答未引用具体论文字段。", "");
        }
        const sent = sentInputs[i];
        if (sent) {
          lines.push(
            `本次实际送入（${sent.papers.length} 篇${sent.clusterName ? ` · 方向：${sent.clusterName}` : ""}）:`,
            ...sent.papers.map((p) => `- ${p.title} · 来源：${p.source}`),
            "",
          );
        }
        if (m.evidenceIds?.length) lines.push(`证据 ID: ${m.evidenceIds.join("、")}`, "");
        if (m.uncertain) lines.push(`无法判断: ${m.uncertain}`, "");
      }
    }
    lines.push("---", "", "对话基于 TopicScope 当前检索样本的统计与摘要节选，未送全文；结论需人工核实。");
    downloadText(`topicscope-chat-${new Date().toISOString().slice(0, 10)}.md`, lines.join("\n"), "text/markdown");
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="heading-cn text-base">研究对话 · 围绕当前样本追问</h2>
          <Button variant="outline" size="sm" onClick={exportChat} disabled={messages.length === 0}>
            导出对话 Markdown
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          模型只看到：当前聚类统计 + 下面选中的论文标题/摘要节选 + 你勾选的已核对证据。每条回答会标出它引用了哪篇论文的哪个字段，
          未引用具体论文字段时会明确标注；认可的结论可以一键加入方案草稿。对话会随研究档案保存，载入存档时回填；开始新检索会清空当前对话。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs text-muted-foreground">
          聚焦方向（决定送哪些论文）
          <NativeSelect value={focus} onChange={(e) => setFocus(e.target.value)} className="h-9 text-xs">
            <NativeSelectOption value="all">全样本 · 按提问自动匹配方向</NativeSelectOption>
            {(radar?.clusters ?? []).map((c) => (
              <NativeSelectOption key={c.id} value={String(c.id)}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeVerified}
            onChange={(e) => setIncludeVerified(e.target.checked)}
          />
          附上我已核对的证据字段（{verified.length} 篇）
        </label>
      </div>

      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {focus === "all" && autoCluster
          ? `按提问关键词自动匹配方向「${autoCluster.name}」，本次送入 ${focusPapers.length} 篇论文（标题+摘要节选）`
          : `本次送入 ${focusPapers.length} 篇论文（标题+摘要节选）`}
        {includeVerified ? ` + ${verified.reduce((n, v) => n + v.fields.length, 0)} 个已核对字段` : "（不含人工核对内容）"}
        {report ? ` ｜ 样本 ${report.totalAfterDedup} 篇` : ""}。未送入全文。
        {focus === "all" && !autoCluster
          ? " 发送时按提问关键词自动匹配方向；无匹配则送全样本被引最高 8 篇。"
          : ""}
      </div>

      <div className="space-y-3">
        {messages.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            问一个围绕当前样本的问题，例如「mamba 方向里哪篇的显存证据最扎实？」「半监督这条线缺什么基线？」
          </p>
        ) : (
          messages.map((m, i) => {
            const sent = sentInputs[i];
            return (
              <div key={i} className={m.role === "user" ? "text-right" : ""}>
                <div
                  className={
                    m.role === "user"
                      ? "inline-block max-w-[85%] rounded-md bg-muted px-3 py-2 text-left text-xs"
                      : "space-y-2 rounded-md border border-border px-3 py-2 text-xs"
                  }
                >
                  <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                  {m.role === "assistant" ? (
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap gap-1.5">
                        {(m.refs ?? []).map((r, j) => {
                          const title = titleOfRef(i, r.n);
                          return (
                            <Badge key={j} variant="outline" className="rounded-sm text-[10px]">
                              [{r.n}] {title ? title.slice(0, 24) : `论文${r.n}`}
                              {r.field ? ` · ${r.field}（人工核对）` : " · 摘要"}
                            </Badge>
                          );
                        })}
                        {(m.evidenceIds ?? []).map((id) => (
                          <Badge key={id} variant="secondary" className="rounded-sm text-[10px]">
                            {id}
                          </Badge>
                        ))}
                      </div>
                      {(m.refs ?? []).length === 0 ? (
                        <p className="text-[11px] text-amber-700 dark:text-amber-400">
                          本次回答未引用具体论文字段
                        </p>
                      ) : null}
                      {sent ? (
                        <details className="rounded-md border border-border px-2 py-1.5 text-[11px]">
                          <summary className="cursor-pointer font-medium">
                            本次实际送入（{sent.papers.length} 篇
                            {sent.clusterName ? ` · 方向：${sent.clusterName}` : ""}）
                          </summary>
                          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                            {sent.papers.map((p, j) => (
                              <li key={j}>
                                {p.title} · 来源：{p.source}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {m.uncertain ? (
                        <p className="text-[11px] text-muted-foreground">无法判断：{m.uncertain}</p>
                      ) : null}
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => onAddDraft(m.content)}>
                        加入方案草稿
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
      ) : null}

      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="围绕当前检索样本与已核对证据追问…"
          rows={2}
          className="text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <Button size="sm" onClick={() => void send()} disabled={busy || !input.trim() || !context}>
          {busy ? "思考中…" : "发送"}
        </Button>
      </div>
    </div>
  );
}