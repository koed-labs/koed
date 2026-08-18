import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupPi } from "./pi-setup.js";

const temporaryDirectories: string[] = [];
const spawnResult = (stdout = "", status = 0) =>
  ({ stdout, stderr: "", status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi setup", () => {
  it("canonicalizes Pi and invokes it with an authenticated, secret-free environment", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-setup-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const executable = resolve(root, "pi-real");
    const link = resolve(root, "pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}\n");
    writeFileSync(resolve(source, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    symlinkSync(executable, link);
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    const result = setupPi(
      {
        HOME: root,
        PATH: process.env.PATH,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_PI_EXECUTABLE: link,
        PI_CODING_AGENT_DIR: resolve(root, "pi-profile"),
        MEMORY_API_TOKEN: "must-not-leak",
        ANTHROPIC_API_KEY: "must-not-leak",
        DATABASE_URL: "postgres://must-not-leak"
      },
      ((
        command: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv }
      ) => {
        calls.push({ command, args, env: options?.env });
        if (args[0] === "--version") return spawnResult("0.84.2\n");
        if (args[0] === "--list-models") {
          return spawnResult("provider model\nopenai gpt-5.4\n");
        }
        return spawnResult("installed\n");
      }) as never
    );

    expect(result).toMatchObject({
      ok: true,
      executablePath: realpathSync(executable),
      modelCount: 1
    });
    expect(
      calls.every(({ command }) => command === realpathSync(executable))
    ).toBe(true);
    for (const { env } of calls) {
      expect(env).not.toHaveProperty("MEMORY_API_TOKEN");
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(env).not.toHaveProperty("DATABASE_URL");
      expect(env).toMatchObject({
        KOED_HOME: resolve(root, "koed"),
        PI_CODING_AGENT_DIR: resolve(root, "pi-profile")
      });
    }
  });

  it("fails closed when Pi has no authenticated models", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-models-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const executable = resolve(root, "pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}\n");
    writeFileSync(resolve(source, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    const result = setupPi(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_PI_EXECUTABLE: executable
      },
      ((_command: string, args: string[]) =>
        args[0] === "--version"
          ? spawnResult("0.84.2\n")
          : spawnResult("provider model\n")) as never
    );

    expect(result).toMatchObject({ ok: false, state: "needs_attention" });
    expect(result.error).toContain("no authenticated models");
  });
});
