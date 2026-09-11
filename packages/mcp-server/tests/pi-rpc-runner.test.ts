import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertPiVersionCompatibility,
  checkPiAvailability,
  listPiModels,
  piRpcEnvironment,
  resolvePiExecutable,
  runPiRpcTask
} from "../src/pi-rpc-runner.js";

describe("Pi RPC runtime boundaries", () => {
  it("enforces supported minimum version", () => {
    expect(() => assertPiVersionCompatibility("0.84.2")).not.toThrow();
    expect(() => assertPiVersionCompatibility("0.85.0")).not.toThrow();
    expect(() => assertPiVersionCompatibility("0.84.1")).toThrow(
      "requires Pi 0.84.2 or newer"
    );
    expect(() => assertPiVersionCompatibility("unknown")).toThrow(
      "requires Pi 0.84.2 or newer"
    );
  });

  it("canonicalizes configured executable discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-discovery-"));
    const executable = join(root, "pi-real");
    const link = join(root, "pi");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    symlinkSync(executable, link);
    expect(resolvePiExecutable({ KOED_PI_EXECUTABLE: link })).toBe(
      realpathSync(executable)
    );
    expect(() =>
      resolvePiExecutable({ KOED_PI_EXECUTABLE: "relative/pi" })
    ).toThrow("must be an absolute path");
  });

  it("resolves Windows npm shims to a verifiable Node entry point", () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-windows-"));
    const shim = join(root, "pi.cmd");
    const entry = join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js"
    );
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(shim, "@echo off\r\n");
    writeFileSync(entry, "console.log('0.84.2');\n");

    expect(
      resolvePiExecutable(
        { PATH: root, PATHEXT: ".CMD;.EXE" },
        { platform: "win32" }
      )
    ).toBe(realpathSync(entry));
  });

  it("derives effective reasoning levels from Pi RPC per model", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-models-"));
    const executable = join(root, "pi");
    writeFileSync(
      executable,
      `#!/usr/bin/env node
let selected = "";
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    let data = {};
    if (command.type === "get_available_models") data = { models: [
      { provider: "local", id: "plain", reasoning: false },
      { provider: "subscription", id: "thinking", reasoning: true }
    ] };
    if (command.type === "set_model") selected = command.modelId;
    if (command.type === "get_available_thinking_levels") data = {
      levels: selected === "plain" ? ["off"] : ["off", "low", "high"]
    };
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }) + "\\n");
  }
});
`
    );
    chmodSync(executable, 0o700);

    await expect(
      listPiModels({ KOED_PI_EXECUTABLE: executable, PATH: process.env.PATH })
    ).resolves.toEqual([
      {
        id: "local/plain",
        provider: "local",
        model: "plain",
        supportedReasoningEfforts: ["off"]
      },
      {
        id: "subscription/thinking",
        provider: "subscription",
        model: "thinking",
        supportedReasoningEfforts: ["off", "low", "high"]
      }
    ]);
  });

  it("reports unknown authentication for malformed model discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-invalid-models-"));
    const executable = join(root, "pi");
    writeFileSync(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("0.84.2\\n");
  process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  const command = JSON.parse(chunk.trim());
  process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }) + "\\n");
});
`
    );
    chmodSync(executable, 0o700);

    await expect(
      checkPiAvailability({
        KOED_PI_EXECUTABLE: executable,
        PATH: process.env.PATH
      })
    ).resolves.toMatchObject({
      available: true,
      authenticated: false,
      authenticationState: "unknown",
      models: [],
      error: "Pi RPC returned an invalid available-models response"
    });
  });

  it("reports partial model capability discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-partial-models-"));
    const executable = join(root, "pi");
    writeFileSync(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("0.84.2\\n");
  process.exit(0);
}
let selected = "";
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (command.type === "get_available_models") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { models: [{ provider: "test", id: "good" }, { provider: "test", id: "bad" }, { provider: " ", id: " " }] } }) + "\\n");
      continue;
    }
    if (command.type === "set_model") {
      selected = command.modelId;
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: selected !== "bad", error: selected === "bad" ? "unavailable" : undefined, data: {} }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { levels: ["off"] } }) + "\\n");
  }
});
`
    );
    chmodSync(executable, 0o700);

    await expect(
      checkPiAvailability({
        KOED_PI_EXECUTABLE: executable,
        PATH: process.env.PATH
      })
    ).resolves.toMatchObject({
      available: true,
      authenticated: true,
      authenticationState: "authenticated",
      models: [
        {
          id: "test/good",
          provider: "test",
          model: "good",
          supportedReasoningEfforts: ["off"]
        }
      ],
      error: "Pi capability discovery skipped 2 of 3 model candidates."
    });
  });

  it("cancels RPC worker and terminates process tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-cancel-"));
    const executable = join(root, "pi");
    const bridge = join(
      root,
      "integrations",
      "pi",
      "extensions",
      "structured-result.mjs"
    );
    mkdirSync(join(root, "integrations", "pi", "extensions"), {
      recursive: true
    });
    writeFileSync(bridge, "export default () => {};\n");
    writeFileSync(
      executable,
      "#!/bin/sh\nwhile read line; do sleep 30; done\n"
    );
    chmodSync(executable, 0o700);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      runPiRpcTask(
        "wait",
        {
          provider: "pi",
          model: "test/model",
          reasoningEffort: "off",
          cwd: root,
          env: { KOED_HOME: root, PATH: process.env.PATH },
          executablePath: executable,
          clientName: "test",
          systemPrompt: "test",
          outputSchema: { type: "object" },
          signal: controller.signal
        },
        5_000
      )
    ).rejects.toThrow("cancelled");
  });

  it("reports parsed RPC events as provider activity", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-progress-"));
    const executable = join(root, "pi");
    const bridge = join(
      root,
      "integrations",
      "pi",
      "extensions",
      "structured-result.mjs"
    );
    mkdirSync(join(root, "integrations", "pi", "extensions"), {
      recursive: true
    });
    writeFileSync(bridge, "export default () => {};\n");
    writeFileSync(
      executable,
      `#!/usr/bin/env node
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "message_update" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName: "koed_structured_result", result: { details: { value: { ok: true } } } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`
    );
    chmodSync(executable, 0o700);
    const onProgress = vi.fn();

    await expect(
      runPiRpcTask(
        "test",
        {
          provider: "pi",
          model: "test/model",
          reasoningEffort: "off",
          cwd: root,
          env: { KOED_HOME: root, PATH: process.env.PATH },
          executablePath: executable,
          clientName: "test",
          systemPrompt: "test",
          outputSchema: { type: "object" },
          onProgress
        },
        5_000
      )
    ).resolves.toMatchObject({ text: JSON.stringify({ ok: true }) });
    expect(onProgress).toHaveBeenCalledWith("Pi provider activity");
  });

  it("uses minimal environment without Koed or provider credentials", () => {
    mkdirSync("/tmp", { recursive: true });
    const result = piRpcEnvironment({
      HOME: "/home/user",
      PATH: "/bin",
      PI_CODING_AGENT_DIR: "/profile",
      KOED_API_TOKEN: "secret",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret"
    });
    expect(result).toEqual({
      HOME: "/home/user",
      PATH: "/bin",
      PI_CODING_AGENT_DIR: "/profile"
    });
  });

  it("rejects CRLF RPC framing", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-crlf-"));
    const executable = join(root, "pi");
    const bridge = join(
      root,
      "integrations",
      "pi",
      "extensions",
      "structured-result.mjs"
    );
    mkdirSync(join(root, "integrations", "pi", "extensions"), {
      recursive: true
    });
    writeFileSync(bridge, "export default () => {};\n");
    writeFileSync(
      executable,
      '#!/bin/sh\nwhile read line; do printf \'{"type":"agent_settled"}\\r\\n\'; sleep 1; done\n'
    );
    chmodSync(executable, 0o700);

    await expect(
      runPiRpcTask(
        "test",
        {
          provider: "pi",
          model: "test/model",
          reasoningEffort: "off",
          cwd: root,
          env: { KOED_HOME: root, PATH: process.env.PATH },
          executablePath: executable,
          clientName: "test",
          systemPrompt: "test",
          outputSchema: { type: "object" }
        },
        5_000
      )
    ).rejects.toThrow("strict-LF");
  });

  it("terminates RPC workers that exceed the aggregate output bound", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-output-bound-"));
    const executable = join(root, "pi");
    const bridge = join(
      root,
      "integrations",
      "pi",
      "extensions",
      "structured-result.mjs"
    );
    mkdirSync(join(root, "integrations", "pi", "extensions"), {
      recursive: true
    });
    writeFileSync(bridge, "export default () => {};\n");
    writeFileSync(
      executable,
      `#!/usr/bin/env node
process.stdin.once("data", () => {
  const payload = "x".repeat(2048);
  for (let index = 0; index < 5000; index += 1) {
    process.stdout.write(JSON.stringify({ type: "diagnostic", payload }) + "\\n");
  }
});
`
    );
    chmodSync(executable, 0o700);

    await expect(
      runPiRpcTask(
        "test",
        {
          provider: "pi",
          model: "test/model",
          reasoningEffort: "off",
          cwd: root,
          env: { KOED_HOME: root, PATH: process.env.PATH },
          executablePath: executable,
          clientName: "test",
          systemPrompt: "test",
          outputSchema: { type: "object" }
        },
        10_000
      )
    ).rejects.toThrow("aggregate output exceeded 8 MiB");
  });
});
