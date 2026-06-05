import { useCallback, useEffect, useRef, useState } from "react";

import { loadMemoryQuestionDetail, loadMemoryQuestionShells } from "./api";
import type { MemoryQuestionRecord, ToastState } from "./types";
import type { GraphUpdatePayload } from "./useKoedMemoryGraph";

const questionDetailCacheLimit = 32;
const questionPrewarmLimit = 10;

interface QuestionDetailCacheEntry {
  accessedAt: number;
  question: MemoryQuestionRecord;
}

function pruneQuestionDetailCache(
  cache: Map<string, QuestionDetailCacheEntry>
) {
  if (cache.size <= questionDetailCacheLimit) {
    return;
  }
  const ordered = [...cache.entries()].sort(
    (left, right) => right[1].accessedAt - left[1].accessedAt
  );
  cache.clear();
  for (const [id, entry] of ordered.slice(0, questionDetailCacheLimit)) {
    cache.set(id, entry);
  }
}

export function isFinalQuestionDetail(question: MemoryQuestionRecord) {
  return (
    question.status !== "pending" &&
    (question.answerMarkdown !== undefined ||
      question.errorMessage !== undefined ||
      question.response !== undefined)
  );
}

function mergeQuestionShellWithCachedDetail(
  shell: MemoryQuestionRecord,
  cached?: MemoryQuestionRecord
) {
  if (!cached) {
    return shell;
  }
  const shellUpdatedAt = Date.parse(shell.updatedAt ?? shell.createdAt);
  const cachedUpdatedAt = Date.parse(cached.updatedAt ?? cached.createdAt);
  if (Number.isFinite(cachedUpdatedAt) && cachedUpdatedAt >= shellUpdatedAt) {
    return { ...shell, ...cached };
  }
  return shell;
}

function parseQuestionUpdatedAt(
  question: Pick<MemoryQuestionRecord, "createdAt" | "updatedAt">
) {
  const timestamp = Date.parse(question.updatedAt ?? question.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function questionTimestamp(question: MemoryQuestionRecord) {
  return parseQuestionUpdatedAt(question);
}

function questionIsAtLeastAsNew(
  incoming: MemoryQuestionRecord,
  existing: MemoryQuestionRecord
) {
  return questionTimestamp(incoming) >= questionTimestamp(existing);
}

function questionIdsFromStreamPayload(payload: GraphUpdatePayload) {
  const ids = new Set<string>();
  if (Array.isArray(payload.questionIds)) {
    for (const id of payload.questionIds) {
      if (typeof id === "string" && id) {
        ids.add(id);
      }
    }
  }
  if (typeof payload.id === "string" && payload.id) {
    ids.add(payload.id);
  }
  return [...ids];
}

export function useKoedMemoryQuestions({
  apiToken,
  setToast
}: {
  apiToken: string;
  setToast: (toast: ToastState | null) => void;
}) {
  const [questions, setQuestions] = useState<MemoryQuestionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const apiTokenRef = useRef(apiToken.trim());
  const detailCacheRef = useRef(new Map<string, QuestionDetailCacheEntry>());
  const requestGenerationRef = useRef(0);

  const requestIsCurrent = useCallback(
    (token: string, generation: number) =>
      apiTokenRef.current === token &&
      requestGenerationRef.current === generation,
    []
  );

  const upsertQuestion = useCallback((question: MemoryQuestionRecord) => {
    const cached = detailCacheRef.current.get(question.id)?.question;
    const questionForCache =
      cached && !questionIsAtLeastAsNew(question, cached)
        ? cached
        : { ...cached, ...question };
    detailCacheRef.current.set(question.id, {
      accessedAt: Date.now(),
      question: questionForCache
    });
    pruneQuestionDetailCache(detailCacheRef.current);
    setQuestions((current) => {
      const existingIndex = current.findIndex(
        (candidate) => candidate.id === question.id
      );
      if (existingIndex < 0) {
        return [questionForCache, ...current];
      }
      const existing = current[existingIndex];
      if (!existing || !questionIsAtLeastAsNew(question, existing)) {
        return current;
      }
      const next = [...current];
      next[existingIndex] = { ...existing, ...question };
      return next;
    });
  }, []);

  const removeQuestion = useCallback((questionId: string) => {
    detailCacheRef.current.delete(questionId);
    setQuestions((current) =>
      current.filter((question) => question.id !== questionId)
    );
  }, []);

  const loadQuestions = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!apiToken.trim()) {
        setQuestions([]);
        detailCacheRef.current.clear();
        return;
      }
      const token = apiToken.trim();
      const generation = requestGenerationRef.current;
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        const shells = await loadMemoryQuestionShells(token);
        if (!requestIsCurrent(token, generation)) {
          return;
        }
        setQuestions(
          shells.map((shell) => {
            const cached = detailCacheRef.current.get(shell.id)?.question;
            const merged = mergeQuestionShellWithCachedDetail(shell, cached);
            if (
              cached &&
              merged === shell &&
              questionTimestamp(cached) < questionTimestamp(shell)
            ) {
              detailCacheRef.current.delete(shell.id);
            }
            return merged;
          })
        );
      } catch (error) {
        if (!requestIsCurrent(token, generation)) {
          return;
        }
        setQuestions([]);
        detailCacheRef.current.clear();
        if (!options?.silent) {
          setToast({
            tone: "destructive",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } finally {
        if (!options?.silent && requestIsCurrent(token, generation)) {
          setLoading(false);
        }
      }
    },
    [apiToken, requestIsCurrent, setToast]
  );

  const loadQuestionDetail = useCallback(
    async (questionId: string, options?: { minUpdatedAt?: string }) => {
      const cached = detailCacheRef.current.get(questionId);
      const minUpdatedAt = options?.minUpdatedAt
        ? Date.parse(options.minUpdatedAt)
        : 0;
      if (
        cached &&
        isFinalQuestionDetail(cached.question) &&
        questionTimestamp(cached.question) >=
          (Number.isFinite(minUpdatedAt) ? minUpdatedAt : 0)
      ) {
        cached.accessedAt = Date.now();
        return cached.question;
      }
      const token = apiToken.trim();
      const generation = requestGenerationRef.current;
      const question = await loadMemoryQuestionDetail(questionId, token);
      if (!requestIsCurrent(token, generation)) {
        return question;
      }
      upsertQuestion(question);
      return question;
    },
    [apiToken, requestIsCurrent, upsertQuestion]
  );

  const prewarmQuestions = useCallback(
    (questionIds: string[]) => {
      const candidates = questionIds
        .filter((id) => !detailCacheRef.current.has(id))
        .slice(0, questionPrewarmLimit);
      for (const questionId of candidates) {
        void loadQuestionDetail(questionId).catch(() => undefined);
      }
    },
    [loadQuestionDetail]
  );

  const refreshQuestionFromStream = useCallback(
    (payload: GraphUpdatePayload) => {
      if (payload.table !== "memory_questions" || !apiToken.trim()) {
        return;
      }
      const token = apiToken.trim();
      const generation = requestGenerationRef.current;
      const questionIds = questionIdsFromStreamPayload(payload);
      if (questionIds.length === 0) {
        void loadQuestions({ silent: true });
        return;
      }
      if (
        payload.operation === "DELETE" &&
        payload.coalesced !== true &&
        questionIds.length === 1
      ) {
        for (const questionId of questionIds) {
          removeQuestion(questionId);
        }
        return;
      }
      if (payload.operation === "DELETE") {
        void loadQuestions({ silent: true });
        return;
      }
      void Promise.all(
        questionIds.map((questionId) =>
          loadMemoryQuestionDetail(questionId, token)
            .then((question) => {
              if (requestIsCurrent(token, generation)) {
                upsertQuestion(question);
              }
            })
            .catch(() => null)
        )
      ).then((results) => {
        if (
          requestIsCurrent(token, generation) &&
          results.some((result) => result === null)
        ) {
          void loadQuestions({ silent: true });
        }
      });
    },
    [apiToken, loadQuestions, removeQuestion, requestIsCurrent, upsertQuestion]
  );

  useEffect(() => {
    apiTokenRef.current = apiToken.trim();
    requestGenerationRef.current += 1;
    detailCacheRef.current.clear();
    setQuestions([]);
  }, [apiToken]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  return {
    loading,
    loadQuestionDetail,
    loadQuestions,
    prewarmQuestions,
    questions,
    refreshQuestionFromStream,
    removeQuestion,
    upsertQuestion
  };
}
