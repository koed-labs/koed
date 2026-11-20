import type { AgentCommand, AgentCommandResult } from "./control-client.js";

export async function startBackgroundAgent(input: {
  control: { resume(): Promise<void>; disable(): Promise<void> };
  command(command: AgentCommand): Promise<AgentCommandResult>;
  onError(error: Error): void;
  quit(): void;
}) {
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      input.onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  let lastResumeError: string | null = null;
  const resume = async (): Promise<void> => {
    try {
      await input.control.resume();
      lastResumeError = null;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (cause.message !== lastResumeError) input.onError(cause);
      lastResumeError = cause.message;
    }
  };
  await resume();
  const retry = setInterval(() => {
    void resume();
  }, 30_000);
  retry.unref?.();
  return {
    async start(): Promise<void> {
      await attempt(async () => {
        const result = await input.command("start");
        if (!result.ok) throw new Error(result.error ?? "Start failed");
      });
    },
    async stop(): Promise<void> {
      await attempt(async () => {
        const result = await input.command("stop");
        if (!result.ok) throw new Error(result.error ?? "Stop failed");
      });
    },
    async quit(): Promise<void> {
      await attempt(async () => {
        await input.control.disable();
        clearInterval(retry);
        input.quit();
      });
    }
  };
}
