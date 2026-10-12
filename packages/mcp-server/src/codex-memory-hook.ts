#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  CodexMemoryDelivery,
  CodexMemoryReceiptStore,
  type CodexHookInput
} from "./codex-memory-delivery.js";
import { LocalAiRuntimeClient } from "./local-runtime-client.js";
import { resolveKoedHome } from "./local-runtime-protocol.js";

export const runCodexMemoryHook = async (
  input: CodexHookInput,
  options: {
    home: string;
    memoryTool: string;
    client?: LocalAiRuntimeClient;
    signal?: AbortSignal;
    waitMs?: number;
  }
): Promise<Record<string, unknown>> => {
  const store = new CodexMemoryReceiptStore(options.home);
  switch (input.hook_event_name) {
    case "PreToolUse":
      return store.prepare(input, options.memoryTool);
    case "PostToolUse":
      store.bind(input, options.memoryTool);
      return {};
    case "Interrupt":
      store.retire(input);
      return {};
    case "SessionEnd":
      store.retire(input, true);
      return {};
    case "Stop": {
      const client =
        options.client ??
        new LocalAiRuntimeClient({ ...process.env, KOED_HOME: options.home });
      const delivery = new CodexMemoryDelivery(
        store,
        {
          start: (i, c, key, signal) =>
            client.startMemoryAnswerTask(i, c, key, signal),
          get: (id, signal) => client.getMemoryAnswerTask(id, signal),
          cancel: (id, signal) => client.cancelMemoryAnswerTask(id, signal)
        },
        options.waitMs,
        options.memoryTool
      );
      return await delivery.stop(input, options.signal);
    }
    default:
      return {};
  }
};
const stdin = async (): Promise<string> =>
  await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      process.stdin.destroy();
      reject(new Error("Hook input timeout"));
    }, 1500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
      if (Buffer.byteLength(text) > 256_000) {
        process.stdin.destroy();
        clearTimeout(timer);
        reject(new Error("Hook input too large"));
      }
    });
    process.stdin.once("end", () => {
      clearTimeout(timer);
      resolve(text);
    });
    process.stdin.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Hook input unavailable"));
    });
  });
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  try {
    const home = argument("--koed-home") ?? resolveKoedHome();
    const memoryTool = argument("--memory-tool") ?? "mcp__koed__memory_answer";
    const waitMs = Number(argument("--wait-ms") ?? "300000");
    if (!Number.isSafeInteger(waitMs) || waitMs < 1000 || waitMs > 1_800_000)
      throw new Error("Invalid Stop observation bound");
    const input = JSON.parse(await stdin()) as CodexHookInput;
    const response = await runCodexMemoryHook(input, {
      home,
      memoryTool,
      waitMs,
      signal: AbortSignal.timeout(waitMs + 1000)
    });
    process.stdout.write(JSON.stringify(response));
  } catch {
    // A missing, expired or denied result never becomes cached answer context.
    process.stdout.write("{}");
  }
}
