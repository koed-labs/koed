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
import { describe, expect, it } from "vitest";
import {
  assertPiVersionCompatibility,
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
});
