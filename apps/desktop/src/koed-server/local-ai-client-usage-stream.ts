import {
  localAiClientUsageChangedSchema,
  type LocalAiClientUsageChanged
} from "../ipc/local-ai-client-protocol.js";

export interface UsageStreamAuthority {
  key: string;
  localKey: string;
  apiOrigin: string;
  authorization: string;
  profileScopeHash: string;
  allowedInstances: ReadonlySet<string>;
}

const pause = (signal: AbortSignal, milliseconds: number) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export const parseUsageSseFrame = (
  frame: string
): LocalAiClientUsageChanged | null => {
  if (!frame.split("\n").some((line) => line === "event: usage")) return null;
  const data = frame
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  if (!data) return null;
  try {
    const parsed = localAiClientUsageChangedSchema.safeParse({
      kind: "completion",
      ...JSON.parse(data)
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Main-process-only stream. Each delivery rechecks the active Personal authority. */
export const subscribeLocalAiClientUsage = async (input: {
  authority: () => Promise<UsageStreamAuthority>;
  localAuthority: () => Promise<string>;
  fetch: typeof globalThis.fetch;
  onChange: (change: LocalAiClientUsageChanged) => void;
  signal: AbortSignal;
}): Promise<void> => {
  let boundKey: string | null = null;
  const invalidate = () => {
    if (!boundKey || input.signal.aborted) return;
    boundKey = null;
    input.onChange({ kind: "invalidated" });
  };
  while (!input.signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let authorityTimer: ReturnType<typeof setInterval> | undefined;
    const onAbort = () => {
      void reader?.cancel().catch(() => undefined);
    };
    try {
      let opened: UsageStreamAuthority;
      try {
        opened = await input.authority();
      } catch {
        invalidate();
        throw new Error("Usage stream authority unavailable");
      }
      if (boundKey && boundKey !== opened.key) invalidate();
      const response = await input.fetch(
        new URL(
          "/v1/memory/ai-client-instances/usage/events",
          opened.apiOrigin
        ),
        {
          method: "GET",
          redirect: "error",
          signal: input.signal,
          headers: {
            accept: "text/event-stream",
            authorization: opened.authorization,
            "x-koed-ai-client-profile-scope": opened.profileScopeHash
          }
        }
      );
      if (response.status === 401 || response.status === 403) invalidate();
      if (!response.ok || !response.body)
        throw new Error("Usage stream unavailable");
      reader = response.body.getReader();
      input.signal.addEventListener("abort", onAbort, { once: true });
      // The stream is attached before consumers re-read current snapshots.
      let attachedAuthority: UsageStreamAuthority;
      try {
        attachedAuthority = await input.authority();
      } catch {
        invalidate();
        throw new Error("Usage stream authority unavailable");
      }
      if (attachedAuthority.key !== opened.key) {
        invalidate();
        continue;
      }
      if (input.signal.aborted) break;
      boundKey = opened.key;
      input.onChange({ kind: "catch_up" });
      let checking = false;
      authorityTimer = setInterval(() => {
        if (checking || input.signal.aborted) return;
        checking = true;
        void input
          .localAuthority()
          .then((current) => {
            if (current !== opened.localKey) {
              invalidate();
              void reader?.cancel().catch(() => undefined);
            }
          })
          .catch(() => {
            invalidate();
            void reader?.cancel().catch(() => undefined);
          })
          .finally(() => {
            checking = false;
          });
      }, 1_000);
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          try {
            if ((await input.authority()).key !== opened.key) invalidate();
          } catch {
            invalidate();
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 65_536)
          throw new Error("Usage stream frame exceeded bound");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const change = parseUsageSseFrame(frame);
          if (change?.kind === "completion") {
            let current: UsageStreamAuthority;
            try {
              current = await input.authority();
            } catch {
              invalidate();
              throw new Error("Usage stream authority unavailable");
            }
            if (current.key !== opened.key) {
              invalidate();
              throw new Error("Usage stream authority changed");
            }
            if (
              !input.signal.aborted &&
              current.allowedInstances.has(change.instanceId)
            )
              input.onChange(change);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // A short retry also covers sign-out and backend/profile changes.
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      if (authorityTimer) clearInterval(authorityTimer);
      await reader?.cancel().catch(() => undefined);
    }
    await pause(input.signal, 1_500);
  }
};
