import { useCallback, useState } from "react";

/** 证据卡里用户可以自己填写的字段。 */
export const EVIDENCE_FIELDS = [
  { key: "researchQuestion", label: "研究问题", hint: "这篇论文实际回答了什么问题" },
  { key: "contributions", label: "核心贡献", hint: "作者自己声明的贡献点" },
  { key: "method", label: "方法流程", hint: "模型结构与训练流程的关键步骤" },
  { key: "data", label: "数据集与划分", hint: "用了哪些数据、怎么划分" },
  { key: "baselines", label: "基线", hint: "和谁对照" },
  { key: "metrics", label: "指标与统计方式", hint: "报了哪些指标、跑了几次、怎么统计" },
  { key: "results", label: "主要结果", hint: "关键数字与结论" },
  { key: "ablation", label: "消融或敏感性分析", hint: "哪些模块真的有用" },
  { key: "limitations", label: "作者声明的局限", hint: "论文自己承认的问题" },
  { key: "nextQuestions", label: "可迁移的研究问题", hint: "你能接着做的下一步" },
] as const;

export type EvidenceFieldKey = (typeof EVIDENCE_FIELDS)[number]["key"];

export interface EvidenceNote {
  paperId: string;
  /** 字段内容 */
  fields: Partial<Record<EvidenceFieldKey, string>>;
  /** 用户逐条确认过的字段 */
  verifiedFields: EvidenceFieldKey[];
  /** 用户已核对全文 */
  fullTextVerified: boolean;
  updatedAt: string;
}

export type EvidenceLevel = "metadata" | "abstract" | "full_text" | "user_verified";

const STORAGE_KEY = "topicscope.evidence.v1";

function readNotes(): Record<string, EvidenceNote> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, EvidenceNote>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeNotes(notes: Record<string, EvidenceNote>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // 隐私模式下 localStorage 不可用，标注只保留在当前会话
  }
}

export function useEvidenceStore() {
  const [notes, setNotes] = useState<Record<string, EvidenceNote>>(() => readNotes());

  const update = useCallback((paperId: string, patch: Partial<EvidenceNote>) => {
    setNotes((prev) => {
      const current = prev[paperId] ?? {
        paperId,
        fields: {},
        verifiedFields: [],
        fullTextVerified: false,
        updatedAt: new Date().toISOString(),
      };
      const next = {
        ...current,
        ...patch,
        paperId,
        updatedAt: new Date().toISOString(),
      };
      const store = { ...prev, [paperId]: next };
      writeNotes(store);
      return store;
    });
  }, []);

  const setField = useCallback(
    (paperId: string, key: EvidenceFieldKey, value: string) => {
      setNotes((prev) => {
        const current = prev[paperId] ?? {
          paperId,
          fields: {},
          verifiedFields: [],
          fullTextVerified: false,
          updatedAt: new Date().toISOString(),
        };
        const fields = { ...current.fields };
        if (value.trim()) fields[key] = value;
        else delete fields[key];
        const next: EvidenceNote = { ...current, fields, updatedAt: new Date().toISOString() };
        const store = { ...prev, [paperId]: next };
        writeNotes(store);
        return store;
      });
    },
    [],
  );

  const toggleFieldVerified = useCallback((paperId: string, key: EvidenceFieldKey) => {
    setNotes((prev) => {
      const current = prev[paperId] ?? {
        paperId,
        fields: {},
        verifiedFields: [],
        fullTextVerified: false,
        updatedAt: new Date().toISOString(),
      };
      const verifiedFields = current.verifiedFields.includes(key)
        ? current.verifiedFields.filter((item) => item !== key)
        : [...current.verifiedFields, key];
      const next: EvidenceNote = { ...current, verifiedFields, updatedAt: new Date().toISOString() };
      const store = { ...prev, [paperId]: next };
      writeNotes(store);
      return store;
    });
  }, []);

  const toggleFullText = useCallback(
    (paperId: string) => {
      setNotes((prev) => {
        const current = prev[paperId] ?? {
          paperId,
          fields: {},
          verifiedFields: [],
          fullTextVerified: false,
          updatedAt: new Date().toISOString(),
        };
        const next: EvidenceNote = {
          ...current,
          fullTextVerified: !current.fullTextVerified,
          updatedAt: new Date().toISOString(),
        };
        const store = { ...prev, [paperId]: next };
        writeNotes(store);
        return store;
      });
    },
    [],
  );

  const replaceAll = useCallback((notes: Record<string, EvidenceNote>) => {
    setNotes(notes);
    writeNotes(notes);
  }, []);

  return { notes, setField, toggleFieldVerified, toggleFullText, update, replaceAll };
}
