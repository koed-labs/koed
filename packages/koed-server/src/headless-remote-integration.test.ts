import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEADLESS_REMOTE_CREDENTIAL_REF,
  checkHeadlessRemoteIntegration,
  headlessRemoteIntegrationPath,
  readHeadlessRemoteIntegration,
  removeHeadlessRemoteIntegration,
  setupHeadlessRemoteIntegration,
  writeHeadlessRemoteIntegration
} from "./headless-remote-integration.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-headless-remote-"));
  roots.push(root);
  const koedHome = resolve(root, "koed");
  const codexHome = resolve(root, "codex");
  const runtimeRoot = resolve(root, "runtime");
  const dist = resolve(runtimeRoot, "mcp-server/dist");
  mkdirSync(dist, { recursive: true });
  mkdirSync(resolve(dist, "prompts"));
  for (const file of [
    "cli.js",
    "capture-hook.js",
    "local-runtime-cli.js",
    "codex-memory-hook.js"
  ]) {
    writeFileSync(resolve(dist, file), "");
  }
  writeFileSync(
    resolve(dist, "prompts/codex-global-agent-guidance.md"),
    "# Koed Memory\nConsult Koed for memory.\n"
  );
  mkdirSync(codexHome);
  writeFileSync(
    resolve(codexHome, "config.toml"),
    'model = "existing-model"\n\n[mcp_servers.unrelated]\ncommand = "unrelated"\n'
  );
  writeFileSync(
    resolve(codexHome, "AGENTS.md"),
    "# User Instructions\nKeep my own instructions.\n"
  );
  const environment = {
    KOED_HOME: koedHome,
    CODEX_HOME: codexHome,
    KOED_JS_RUNTIME_ROOT: runtimeRoot,
    MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
    KOED_CODEX_STOP_DELIVERY: "0",
    MEMORY_API_TOKEN: "personal-secret-must-not-leak"
  };
  return {
    root,
    koedHome,
    codexHome,
    environment,
    options: {
      environment,
      harness: "codex" as const,
      consent: true,
      backendUrl: "https://memory.example.test",
      credentialRef: HEADLESS_REMOTE_CREDENTIAL_REF,
      credentialAvailable: () => true
    }
  };
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("headless remote integration", () => {
  it("requires explicit consent and honors cancellation before creating local state", async () => {
    const { options, koedHome } = fixture();
    const setupHarness = vi.fn(() => ({ ok: true }));
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          consent: false,
          setupHarness
        })
      ).state
    ).toBe("consent_required");
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          consent: undefined,
          setupHarness
        })
      ).state
    ).toBe("consent_required");
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          signal: AbortSignal.abort(),
          setupHarness
        })
      ).state
    ).toBe("cancelled");
    expect(setupHarness).not.toHaveBeenCalled();
    expect(existsSync(koedHome)).toBe(false);
  });

  it("fails closed without authenticated remote credentials and never uses a Personal API Token", async () => {
    const { options, koedHome } = fixture();
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          credentialAvailable: undefined
        })
      ).ok
    ).toBe(false);
    expect(existsSync(koedHome)).toBe(false);
  });

  it("uses the existing Codex setup with only local integration artifacts and is repeatable", async () => {
    const { options, environment, codexHome } = fixture();
    expect((await setupHeadlessRemoteIntegration(options)).ok).toBe(true);
    const configPath = resolve(codexHome, "config.toml");
    const instructionsPath = resolve(codexHome, "AGENTS.md");
    const config = readFileSync(configPath, "utf8");
    const instructions = readFileSync(instructionsPath, "utf8");
    const descriptor = readFileSync(
      headlessRemoteIntegrationPath(environment),
      "utf8"
    );
    expect(config).toContain('model = "existing-model"');
    expect(config).toContain("[mcp_servers.unrelated]");
    expect(config).toContain("[mcp_servers.koed]");
    expect(config).toContain("--koed-home");
    expect(instructions).toContain("Keep my own instructions.");
    expect(instructions).toContain("<!-- >>> koed-memory-guidance -->");
    expect(instructions).toContain("memory_answer");
    expect(config + instructions + descriptor).not.toContain(
      "personal-secret-must-not-leak"
    );
    expect(config + instructions).not.toContain(HEADLESS_REMOTE_CREDENTIAL_REF);
    expect(config + instructions).not.toContain(options.backendUrl);
    expect(readHeadlessRemoteIntegration(environment)).toEqual({
      version: 1,
      backendUrl: options.backendUrl,
      credentialRef: HEADLESS_REMOTE_CREDENTIAL_REF,
      harnesses: ["codex"],
      futureCaptureOnly: true
    });
    expect(
      statSync(headlessRemoteIntegrationPath(environment)).mode & 0o777
    ).toBe(0o600);
    expect((await setupHeadlessRemoteIntegration(options)).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(readFileSync(instructionsPath, "utf8")).toBe(instructions);
    expect(
      readFileSync(headlessRemoteIntegrationPath(environment), "utf8")
    ).toBe(descriptor);
  });

  it("waits for asynchronous harness setup and diagnostic results", async () => {
    const { options, environment } = fixture();
    const setupHarness = vi.fn(async () => {
      await Promise.resolve();
      return { ok: true };
    });
    expect(
      (await setupHeadlessRemoteIntegration({ ...options, setupHarness })).ok
    ).toBe(true);
    expect(readHeadlessRemoteIntegration(environment)?.harnesses).toEqual([
      "codex"
    ]);
    const checkHarness = vi.fn(async () => false);
    expect(
      (await checkHeadlessRemoteIntegration({ ...options, checkHarness })).state
    ).toBe("needs_attention");
  });

  it("checks only registered harnesses and credential readiness without mutation", async () => {
    const { options, environment } = fixture();
    await setupHeadlessRemoteIntegration(options);
    const before = readFileSync(
      headlessRemoteIntegrationPath(environment),
      "utf8"
    );
    const checkHarness = vi.fn(() => true);
    expect(
      (await checkHeadlessRemoteIntegration({ ...options, checkHarness })).ok
    ).toBe(true);
    expect(
      (
        await checkHeadlessRemoteIntegration({
          ...options,
          credentialAvailable: () => false,
          checkHarness
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await checkHeadlessRemoteIntegration({
          ...options,
          harness: "claude",
          checkHarness
        })
      ).ok
    ).toBe(false);
    expect(checkHarness).toHaveBeenCalledTimes(1);
    expect(
      readFileSync(headlessRemoteIntegrationPath(environment), "utf8")
    ).toBe(before);
  });

  it("retains existing registrations when adding another harness or setup fails", async () => {
    const { options, environment } = fixture();
    expect((await setupHeadlessRemoteIntegration(options)).ok).toBe(true);
    const setupHarness = vi.fn<
      (harness: string, environment: NodeJS.ProcessEnv) => { ok: boolean }
    >(() => ({ ok: false }));
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          harness: "claude",
          setupHarness
        })
      ).ok
    ).toBe(false);
    expect(readHeadlessRemoteIntegration(environment)?.harnesses).toEqual([
      "codex"
    ]);
    setupHarness.mockReturnValue({ ok: true });
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          harness: "claude",
          setupHarness
        })
      ).ok
    ).toBe(true);
    expect(readHeadlessRemoteIntegration(environment)?.harnesses).toEqual([
      "codex",
      "claude"
    ]);
    expect(setupHarness.mock.calls[0]?.[1]).not.toHaveProperty(
      "MEMORY_API_TOKEN"
    );
  });

  it("requires consent for removal and retains registration on removal failure", async () => {
    const { options, environment } = fixture();
    await setupHeadlessRemoteIntegration(options);
    const removeHarness = vi.fn(() => ({ ok: false }));
    expect(
      removeHeadlessRemoteIntegration({
        ...options,
        consent: false,
        removeHarness
      }).state
    ).toBe("consent_required");
    expect(removeHarness).not.toHaveBeenCalled();
    expect(
      removeHeadlessRemoteIntegration({ ...options, removeHarness }).ok
    ).toBe(false);
    expect(readHeadlessRemoteIntegration(environment)?.harnesses).toEqual([
      "codex"
    ]);
  });

  it("removes only the selected registered harness and keeps OAuth credentials and unrelated settings", async () => {
    const { options, environment, koedHome, codexHome } = fixture();
    await setupHeadlessRemoteIntegration(options);
    const credentialPath = resolve(koedHome, HEADLESS_REMOTE_CREDENTIAL_REF);
    writeFileSync(credentialPath, "protected-credential-payload", {
      mode: 0o600
    });
    const descriptor = readHeadlessRemoteIntegration(environment)!;
    writeHeadlessRemoteIntegration(environment, {
      ...descriptor,
      harnesses: ["codex", "claude"]
    });
    expect(removeHeadlessRemoteIntegration(options).ok).toBe(true);
    expect(readFileSync(resolve(codexHome, "config.toml"), "utf8")).toContain(
      "[mcp_servers.unrelated]"
    );
    expect(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8")).toContain(
      "Keep my own instructions."
    );
    expect(readHeadlessRemoteIntegration(environment)?.harnesses).toEqual([
      "claude"
    ]);
    expect(readFileSync(credentialPath, "utf8")).toBe(
      "protected-credential-payload"
    );
    const removeHarness = vi.fn(() => ({ ok: true }));
    expect(
      removeHeadlessRemoteIntegration({
        ...options,
        harness: "claude",
        removeHarness
      }).ok
    ).toBe(true);
    expect(readHeadlessRemoteIntegration(environment)).toBeNull();
    expect(existsSync(credentialPath)).toBe(true);
    expect(
      removeHeadlessRemoteIntegration({
        ...options,
        harness: "claude",
        removeHarness
      }).ok
    ).toBe(true);
    expect(removeHarness).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe endpoints, arbitrary credential paths, and backend replacement", async () => {
    const { options, environment } = fixture();
    const setupHarness = vi.fn(() => ({ ok: true }));
    for (const backendUrl of [
      "http://memory.example.test",
      "https://token@example.test",
      "https://memory.example.test?token=secret",
      "https://memory.example.test#secret"
    ]) {
      expect(
        (
          await setupHeadlessRemoteIntegration({
            ...options,
            backendUrl,
            setupHarness
          })
        ).ok
      ).toBe(false);
    }
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          credentialRef: "/tmp/secret",
          setupHarness
        })
      ).ok
    ).toBe(false);
    expect(setupHarness).not.toHaveBeenCalled();
    expect((await setupHeadlessRemoteIntegration(options)).ok).toBe(true);
    const before = readFileSync(
      headlessRemoteIntegrationPath(environment),
      "utf8"
    );
    expect(
      (
        await setupHeadlessRemoteIntegration({
          ...options,
          backendUrl: "https://other.example.test",
          setupHarness
        })
      ).ok
    ).toBe(false);
    expect(
      readFileSync(headlessRemoteIntegrationPath(environment), "utf8")
    ).toBe(before);
    expect(setupHarness).not.toHaveBeenCalled();
  });

  it("refuses symlinked and publicly readable managed configuration", async () => {
    const { options, environment, root, koedHome } = fixture();
    mkdirSync(resolve(koedHome, "config"), { recursive: true, mode: 0o700 });
    const external = resolve(root, "external.json");
    writeFileSync(external, "unchanged", { mode: 0o600 });
    symlinkSync(external, headlessRemoteIntegrationPath(environment));
    expect((await setupHeadlessRemoteIntegration(options)).ok).toBe(false);
    expect(removeHeadlessRemoteIntegration(options).ok).toBe(false);
    expect(readFileSync(external, "utf8")).toBe("unchanged");
    rmSync(headlessRemoteIntegrationPath(environment));
    expect((await setupHeadlessRemoteIntegration(options)).ok).toBe(true);
    chmodSync(headlessRemoteIntegrationPath(environment), 0o644);
    expect(
      (
        await checkHeadlessRemoteIntegration({
          ...options,
          checkHarness: () => true
        })
      ).ok
    ).toBe(false);
    expect(removeHeadlessRemoteIntegration(options).ok).toBe(false);
  });
});
