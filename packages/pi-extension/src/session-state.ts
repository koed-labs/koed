import { randomUUID } from "node:crypto";

const SESSION_ENTRY_TYPE = "koed-session";

export interface KoedSessionState {
  externalSessionId: string;
}

export const restoreKoedSessionState = (ctx: {
  sessionManager: {
    getEntries(): unknown[];
  };
}): KoedSessionState | null => {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      record.type === "custom" &&
      record.customType === SESSION_ENTRY_TYPE &&
      record.data &&
      typeof record.data === "object"
    ) {
      const data = record.data as Record<string, unknown>;
      if (typeof data.externalSessionId === "string") {
        return { externalSessionId: data.externalSessionId };
      }
    }
  }
  return null;
};

export const ensureKoedSessionState = (
  pi: {
    appendEntry(customType: string, data?: unknown): void;
  },
  ctx: {
    sessionManager: {
      getEntries(): unknown[];
    };
  },
  forceNew = false
): KoedSessionState => {
  if (!forceNew) {
    const existing = restoreKoedSessionState(ctx);
    if (existing) {
      return existing;
    }
  }

  const created = {
    externalSessionId: randomUUID()
  } satisfies KoedSessionState;
  pi.appendEntry(SESSION_ENTRY_TYPE, created);
  return created;
};
