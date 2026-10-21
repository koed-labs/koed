import {
  readDesktopLocalCredentialAuthorization,
  scheduledJobLocalApiUrl,
  scheduledJobRuntimeTickRequestSchema,
  scheduledJobRuntimeTickResultSchema
} from "@koed/shared";

export type ScheduledJobScheduler = { stop(): void; tick(): Promise<void> };

/** The Local AI Runtime owns the calendar clock; the Personal API owns durable claims. */
export function startScheduledJobScheduler(input: {
  apiUrl: string;
  koedHome: string;
  fetch?: typeof fetch;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): ScheduledJobScheduler {
  const url = scheduledJobLocalApiUrl(input.apiUrl);
  const send = input.fetch ?? fetch;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const credential = readDesktopLocalCredentialAuthorization(
        input.koedHome
      );
      if (
        !credential?.operationFamilies.includes("managed_execution") ||
        !credential.operationFamilies.includes("personal_collaboration_write")
      )
        return;
      const endpoint = new URL(
        "v1/scheduled-jobs/runtime/tick",
        url.href.replace(/\/+$/, "/")
      );
      const response = await send(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: credential.authorization,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(scheduledJobRuntimeTickRequestSchema.parse({})),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok)
        throw new Error(`Scheduled Job tick unavailable (${response.status})`);
      scheduledJobRuntimeTickResultSchema.parse(await response.json());
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };
  const timer = setInterval(() => {
    void tick().catch(input.onError ?? (() => undefined));
  }, input.intervalMs ?? 30_000);
  timer.unref?.();
  void tick().catch(input.onError ?? (() => undefined));
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick
  };
}
