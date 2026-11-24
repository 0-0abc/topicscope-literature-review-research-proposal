export interface ChatReference {
  n: number;
  field?: string;
}

const REFS_PATTERN = /\s*(?:\[\s*)?refs\s*:\s*(\[(?:\s*\{[^{}]*\}\s*,?)*\]|\{[^{}]*\}(?:\s*,\s*\{[^{}]*\})*)\s*\]?/gi;
const EVIDENCE_PATTERN = /\s*\(?\s*evidenceIds\s*:\s*(\[(?:\s*"[^"]*"\s*,?)*\])\s*\)?/gi;
const EVIDENCE_TOKEN = /(^|[\s([|])(?:cluster|corpus|pair|paper):[A-Za-z0-9_.:-]+(?=$|[\s)\]|，。；])/gim;
const CITATION_LINE = /^\s*(?:\[\d+\]\s+.+?\s*·\s*(?:摘要|标题|年份|人工核对)\s*)+[\s|]*$/;

function parseArray<T>(source: string, parse: (value: unknown) => T | null): T[] {
  try {
    const value: unknown = JSON.parse(source);
    if (!Array.isArray(value)) return [];
    return value.map(parse).filter((item): item is T => item !== null);
  } catch {
    return [];
  }
}

function parseReference(value: unknown): ChatReference | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const n = Number(item.n);
  if (!Number.isInteger(n) || n < 1) return null;
  const field = typeof item.field === "string" ? item.field.trim().slice(0, 40) : "";
  return { n, ...(field ? { field } : {}) };
}

function parseReferences(source: string): ChatReference[] {
  if (!source.trim().startsWith("[")) {
    try {
      const parsed = parseReference(JSON.parse(source));
      return parsed ? [parsed] : [];
    } catch {
      return [];
    }
  }
  return parseArray(source, parseReference);
}

export function cleanChatAnswer(text: string): { text: string; refs: ChatReference[]; evidenceIds: string[] } {
  const refs: ChatReference[] = [];
  const evidenceIds: string[] = [];
  let cleaned = text.replace(REFS_PATTERN, (_match, source: string) => {
    refs.push(...parseReferences(source));
    return "";
  });
  cleaned = cleaned.replace(EVIDENCE_PATTERN, (_match, source: string) => {
    evidenceIds.push(...parseArray(source, (value) => typeof value === "string" ? value.trim().slice(0, 160) : ""));
    return "";
  });
  cleaned = cleaned
    .replace(EVIDENCE_TOKEN, "$1")
    .split(/\r?\n/)
    .filter((line) => !CITATION_LINE.test(line))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([。，；;,])\s*\1/g, "$1")
    .replace(/([，,])\s*。/g, "。")
    .replace(/,\s*\./g, ".")
    .replace(/^\s+|\s+$/g, "");
  return {
    text: cleaned,
    refs: refs.slice(0, 8),
    evidenceIds: [...new Set(evidenceIds.filter(Boolean))].slice(0, 40),
  };
}
