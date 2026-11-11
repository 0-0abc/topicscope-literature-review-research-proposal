import { useCallback, useEffect, useState } from "react";
import type { Paper, SearchReport } from "@/lib/data/types";
import type { EvidenceNote } from "@/hooks/useEvidenceStore";
import type { ResearchPlan } from "@/lib/ai/plan";
import type { FeasibilityResult, FeasibilityRef } from "@/lib/ai/feasibility";
import type { ResearchReview, ReviewRef } from "@/lib/ai/review";

/** 研究对话的一条消息（含引用徽标信息），存档后离线可回看。 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  refs?: { n: number; field?: string }[];
  evidenceIds?: string[];
  uncertain?: string;
}

export interface SavedCheckup {
  result: FeasibilityResult;
  idea: string;
  refs: FeasibilityRef[];
}

export interface SavedReview {
  review: ResearchReview;
  refs: ReviewRef[];
}

const DB_NAME = "topicscope";
const DB_VERSION = 1;
const STORE = "sessions";

/** 一次研究会话的存档：可以离线查看与导出，不依赖当时的网络。 */
export interface SavedSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** 研究问题 / 检索式 */
  query: string;
  /** 当时的检索快照 */
  report: SearchReport | null;
  /** 当时看到的论文，存档后离线也能重看 */
  papers: Paper[];
  /** 人工核对的证据标注 */
  evidenceNotes: Record<string, EvidenceNote>;
  /** 生成的研究方案（Markdown） */
  planMarkdown: string | null;
  planTitle: string | null;
  /** 结构化方案，载入时完整恢复方案面板 */
  plan?: ResearchPlan | null;
  /** 研究对话记录，载入时回填对话区 */
  chat?: ChatMessage[];
  /** 选题体检结论（含引用文献），载入时回填体检面板 */
  checkup?: SavedCheckup | null;
  /** 文献综述结论（含引用文献），载入时回填综述面板 */
  review?: SavedReview | null;
  /** 研究对话里加入方案草稿的结论 */
  draftConclusions?: string[];
  /** 用户备注 */
  note: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export function listSessions(): Promise<SavedSession[]> {
  return withStore<SavedSession[]>("readonly", (store) => store.getAll() as IDBRequest<SavedSession[]>).then(
    (list) => list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
}

export function putSession(session: SavedSession): Promise<IDBValidKey> {
  return withStore<IDBValidKey>("readwrite", (store) => store.put(session));
}

export function removeSession(id: string): Promise<undefined> {
  return withStore<undefined>("readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
}

export interface SessionDraft {
  query: string;
  report: SearchReport | null;
  papers: Paper[];
  evidenceNotes: Record<string, EvidenceNote>;
  planMarkdown: string | null;
  planTitle: string | null;
  plan?: ResearchPlan | null;
  chat?: ChatMessage[];
  checkup?: SavedCheckup | null;
  review?: SavedReview | null;
  draftConclusions?: string[];
  note: string;
}

export function useSessionStore() {
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      setSessions(await listSessions());
      setError(null);
      setStatus("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取存档失败");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (draft: SessionDraft, id?: string) => {
      const now = new Date().toISOString();
      const session: SavedSession = {
        id: id ?? `TS-${now.slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: id ? (sessions.find((item) => item.id === id)?.createdAt ?? now) : now,
        updatedAt: now,
        query: draft.query,
        report: draft.report,
        papers: draft.papers,
        evidenceNotes: draft.evidenceNotes,
        planMarkdown: draft.planMarkdown,
        planTitle: draft.planTitle,
        plan: draft.plan ?? null,
        chat: draft.chat ?? [],
        checkup: draft.checkup ?? null,
        review: draft.review ?? null,
        draftConclusions: draft.draftConclusions ?? [],
        note: draft.note,
      };
      await putSession(session);
      await refresh();
      return session;
    },
    [refresh, sessions],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeSession(id);
      await refresh();
    },
    [refresh],
  );

  const importSession = useCallback(
    async (raw: string) => {
      const parsed = JSON.parse(raw) as SavedSession;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.papers)) {
        throw new Error("这不是一个 TopicScope 存档文件。");
      }
      await putSession({ ...parsed, updatedAt: new Date().toISOString() });
      await refresh();
    },
    [refresh],
  );

  return { sessions, status, error, save, remove, importSession, refresh };
}
