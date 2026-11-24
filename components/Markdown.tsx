import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// 模型输出不可信：只放行这些协议，其余链接原样当纯文本，杜绝 javascript: 等注入。
const SAFE_URL = /^(?:https?:|mailto:|doi:)/i;

const FENCE = /^\s*```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const OL = /^\s*\d+\.\s+/;
const UL = /^\s*[-*]\s+/;
const QUOTE = /^\s*>\s?/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isBlockStart(line: string, next = ""): boolean {
  return FENCE.test(line) || HEADING.test(line) || OL.test(line) || UL.test(line) || QUOTE.test(line) ||
    (line.includes("|") && TABLE_DIVIDER.test(next));
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // 每次调用新建带 g 的正则：递归解析 bold/italic 时不会互相踩 lastIndex。
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${n++}`;
    if (match[1] !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 font-mono text-[0.85em]">
          {match[1]}
        </code>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(match[2], key)}
        </strong>,
      );
    } else if (match[3] !== undefined) {
      nodes.push(<em key={key}>{renderInline(match[3], key)}</em>);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      if (SAFE_URL.test(match[5])) {
        nodes.push(
          <a
            key={key}
            href={match[5]}
            target="_blank"
            rel="noreferrer noopener"
            className="underline-offset-4 hover:underline"
          >
            {renderInline(match[4], key)}
          </a>,
        );
      } else {
        nodes.push(match[0]);
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(
        <pre
          key={k++}
          className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-[0.85em] leading-relaxed"
        >
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const key = `h${k++}`;
      const cls = level === 1 ? "text-base font-semibold" : "text-sm font-semibold";
      const content = renderInline(heading[2].trim(), key);
      out.push(
        level === 1 ? (
          <h1 key={key} className={cls}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={key} className={cls}>{content}</h2>
        ) : (
          <h3 key={key} className={cls}>{content}</h3>
        ),
      );
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quote.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      out.push(
        <blockquote key={k++} className="border-l-2 border-border pl-3 text-muted-foreground">
          {quote.map((item, j) => <p key={j}>{renderInline(item, `q${k}-${j}`)}</p>)}
        </blockquote>,
      );
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      out.push(
        <div key={k++} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead><tr>{headers.map((cell, j) => <th key={j} className="border border-border px-2 py-1 font-semibold">{renderInline(cell, `th${k}-${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, j) => <tr key={j}>{headers.map((_, c) => <td key={c} className="border border-border px-2 py-1 align-top">{renderInline(row[c] ?? "", `td${k}-${j}-${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL.test(lines[i])) {
        items.push(lines[i].replace(OL, ""));
        i++;
      }
      const key = `ol${k++}`;
      out.push(
        <ol key={key} className="list-decimal space-y-1 pl-5">
          {items.map((item, j) => (
            <li key={j} className="leading-relaxed">{renderInline(item, `${key}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i])) {
        items.push(lines[i].replace(UL, ""));
        i++;
      }
      const key = `ul${k++}`;
      out.push(
        <ul key={key} className="list-disc space-y-1 pl-5">
          {items.map((item, j) => (
            <li key={j} className="leading-relaxed">{renderInline(item, `${key}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    const key = `p${k++}`;
    const content: ReactNode[] = [];
    para.forEach((ln, j) => {
      if (j > 0) content.push(<br key={`${key}-br${j}`} />);
      content.push(...renderInline(ln, `${key}-l${j}`));
    });
    out.push(<p key={key} className="leading-relaxed">{content}</p>);
  }
  return out;
}

/** 把模型返回的 Markdown 渲染成 React 元素（不使用 innerHTML，天然防 XSS）。 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn("space-y-2", className)}>{renderBlocks(text)}</div>;
}