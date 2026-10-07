import type { EventEmitter } from "node:events";

const commands = new Set([
  "start_daemon",
  "status",
  "stop",
  "runtime_status",
  "runtime_install",
  "models_status",
  "models_install",
  "setup_core",
  "setup_codex",
  "doctor",
  "privacy_status",
  "quit"
]);
type HarnessInput = {
  packaged: boolean;
  argv: string[];
  channel: EventEmitter & { connected?: boolean };
  send: (message: unknown) => void;
  invoke: (command: string) => Promise<unknown>;
  stop: () => Promise<unknown>;
  quit: () => void;
};
type HarnessState = { closed: boolean; queue: Promise<void> };

// Preserve component status objects, never reusable credentials or raw secrets.
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /^(token|secret|authorization|credential|nonce|sessionToken|apiToken)$/i.test(
        key
      ) && typeof entry === "string"
        ? "[redacted]"
        : redact(entry)
    ])
  );
};
const validRequest = (value: Record<string, unknown>): boolean =>
  Object.keys(value).length === 4 &&
  value.type === "koed.desktop.smoke.request" &&
  value.version === 1 &&
  typeof value.id === "string" &&
  /^[\w-]{1,100}$/.test(value.id) &&
  typeof value.command === "string" &&
  commands.has(value.command);
const sendResponse = (
  input: HarnessInput,
  id: unknown,
  body: Record<string, unknown>
) => {
  if (input.channel.connected)
    input.send({
      type: "koed.desktop.smoke.response",
      version: 1,
      id,
      ...body
    });
};

const receive = (
  input: HarnessInput,
  state: HarnessState,
  message: unknown
) => {
  if (state.closed || !message || typeof message !== "object") return;
  const request = message as Record<string, unknown>;
  if (!validRequest(request)) {
    sendResponse(input, request.id, { error: "Invalid smoke request." });
    return;
  }
  state.queue = state.queue.then(async () => {
    if (state.closed) return;
    try {
      const result = await input.invoke(request.command as string);
      sendResponse(input, request.id, { result: redact(result) });
      if (request.command === "quit") {
        state.closed = true;
        input.quit();
      }
    } catch (error) {
      sendResponse(input, request.id, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
};

export const attachPackagedSmokeHarness = (input: HarnessInput): boolean => {
  if (
    !input.packaged ||
    !input.argv.includes("--koed-private-smoke") ||
    !input.channel.connected
  )
    return false;
  const state: HarnessState = { closed: false, queue: Promise.resolve() };
  input.channel.on("message", (message: unknown) =>
    receive(input, state, message)
  );
  input.channel.once("disconnect", () => {
    state.closed = true;
    void state.queue
      .then(() => input.stop())
      .finally(() => input.quit())
      .catch((error: unknown) =>
        console.error("Smoke disconnect cleanup failed:", error)
      );
  });
  input.send({ type: "koed.desktop.smoke.ready", version: 1 });
  return true;
};
