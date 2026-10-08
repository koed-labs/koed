import path from "node:path";
import {
  CodexAppServerClient,
  CodexAppServerResponseError,
  type CodexAppServerThreadInfo
} from "./codex-app-server-runner.js";

const THREAD_FAILURES = new Set([
  "codex_history_thread_unavailable",
  "codex_history_path_invalid",
  "codex_history_identity_mismatch",
  "codex_history_unexpected_hydration",
  "codex_history_page_invalid"
]);

// Failures about one thread's metadata. Any other failure means the home's
// metadata connection is unavailable.
export const isCodexHistoryThreadFailure = (error: unknown): boolean =>
  error instanceof Error && THREAD_FAILURES.has(error.message);

export interface CodexHistoryMetadataReader {
  readThread(threadId: string): Promise<CodexAppServerThreadInfo>;
  close(): Promise<void>;
}

export const createCodexHistoryMetadataReader = (input: {
  binary: string;
  codexHome: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  idleMs?: number;
  client?: CodexAppServerClient;
}): CodexHistoryMetadataReader => {
  const codexHome = path.resolve(input.codexHome);
  let client: CodexAppServerClient | undefined = input.client;
  let initialization: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let activeReads = 0;
  let closing: Promise<void> = Promise.resolve();
  const disconnect = async () => {
    const previous = client;
    client = undefined;
    initialization = undefined;
    if (previous && !input.client) await previous.closeAndWait();
  };
  const connected = async (): Promise<CodexAppServerClient> => {
    await closing;
    if (closed) throw new Error("codex_history_metadata_closed");
    if (!client || client.isClosed()) {
      if (input.client) throw new Error("codex_history_metadata_unavailable");
      client = new CodexAppServerClient(
        input.binary,
        codexHome,
        { ...input.env, CODEX_HOME: codexHome },
        undefined,
        {
          configOverrides: [
            "features.background_paginated_rollout_migration=false"
          ],
          requestTimeoutMs: input.requestTimeoutMs ?? 5_000,
          maxLineBytes: 256 * 1024,
          maxRawEvents: 128,
          maxRawEventBytes: 1024 * 1024
        }
      );
    }
    const current = client;
    initialization ??= input.client
      ? Promise.resolve()
      : current.initialize("koed-history-metadata").then((result) => {
          if (
            typeof result.codexHome !== "string" ||
            path.resolve(result.codexHome) !== codexHome
          )
            throw new Error("codex_history_home_mismatch");
        });
    await initialization;
    return current;
  };
  return {
    async readThread(threadId) {
      if (idleTimer) clearTimeout(idleTimer);
      activeReads++;
      try {
        const current = await connected();
        try {
          const thread = await current.readThread(threadId);
          if (!thread.path || !path.isAbsolute(thread.path))
            throw new Error("codex_history_path_invalid");
          // Native paging resolves and validates the lineage without hydrating
          // the complete conversation or admitting any ancestor as Koed Memory.
          await current.readThreadTurnsPage(threadId, { limit: 1 });
          return thread;
        } catch (error) {
          // The server answered for this thread; the connection stays usable.
          if (error instanceof CodexAppServerResponseError)
            // eslint-disable-next-line preserve-caught-error
            throw new Error("codex_history_thread_unavailable");
          throw error;
        }
      } catch (error) {
        if (isCodexHistoryThreadFailure(error)) throw error;
        if (activeReads === 1) {
          closing = disconnect().catch(() => undefined);
          await closing;
        }
        if (
          error instanceof Error &&
          /^codex_history_[a-z_]+$/.test(error.message)
        )
          throw error;
        // Provider errors can contain private paths; expose only a safe code.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("codex_history_metadata_unavailable");
      } finally {
        activeReads--;
        if (!closed && activeReads === 0 && !input.client) {
          idleTimer = setTimeout(() => {
            closing = disconnect().catch(() => undefined);
          }, input.idleMs ?? 30_000);
          idleTimer.unref();
        }
      }
    },
    async close() {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      await closing;
      await disconnect();
    }
  };
};
