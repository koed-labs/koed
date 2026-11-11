import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiClientConnectionRevision,
  aiClientConnectionsPath,
  grantAiClientConnection,
  isAiClientConnected,
  readAiClientConnections
} from "@koed-labs/shared/ai-client-connections";
import { runIntegrationCommand } from "./cli-integration-operations.js";
import { resolveKoedServerPaths } from "./paths.js";

const stream = { write: () => true } as never;
const homes: string[] = [];
const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), "koed-cli-connection-"));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const connect = (home: string, id: "codex" | "claude" | "pi") =>
  grantAiClientConnection(home, id, aiClientConnectionRevision(home, id));
const connected = (home: string, id: "codex" | "claude" | "pi") =>
  isAiClientConnected(readAiClientConnections(home), id);

const verifiedStatus = (home: string, configuredKoedHome = home) =>
  ({
    koedHome: home,
    codex: {
      configured: true,
      details: { configuredKoedHome, mcpAdapter: "/adapter" }
    },
    claudeCode: { configured: true },
    pi: { configured: true }
  }) as never;

const base = (home: string) => ({
  stdout: stream,
  stderr: stream,
  resolvePaths: () => resolveKoedServerPaths({ KOED_HOME: home })
});

describe("CLI AI Client connections", () => {
  it.each(["codex", "claude", "pi"] as const)(
    "disconnects %s before its integration is removed",
    async (client) => {
      const home = newHome();
      for (const id of ["codex", "claude", "pi"] as const) connect(home, id);
      let connectedDuringRemoval: boolean | undefined;
      const remove = () => {
        connectedDuringRemoval = connected(home, client);
        return { ok: true, koedHome: home } as never;
      };
      const code = await runIntegrationCommand(
        "remove",
        { client, json: true },
        {
          ...base(home),
          removeCodex: remove,
          removeClaude: remove,
          removePi: remove
        }
      );
      expect(code).toBe(0);
      expect(connectedDuringRemoval).toBe(false);
      for (const id of ["codex", "claude", "pi"] as const)
        expect(connected(home, id)).toBe(id !== client);
    }
  );

  it("stays disconnected when removal fails", async () => {
    const home = newHome();
    connect(home, "codex");
    const code = await runIntegrationCommand(
      "remove",
      { client: "codex", json: true },
      {
        ...base(home),
        removeCodex: () => ({ ok: false, koedHome: home }) as never
      }
    );
    expect(code).toBe(1);
    expect(connected(home, "codex")).toBe(false);
  });

  it.each(["codex", "claude", "pi"] as const)(
    "never connects %s when removal lands while setup runs",
    async (client) => {
      const home = newHome();
      const setup = async () => {
        // Another process removes the client while this setup is running.
        expect(
          await runIntegrationCommand(
            "remove",
            { client, json: true },
            {
              ...base(home),
              removeCodex: () => ({ ok: true, koedHome: home }) as never,
              removeClaude: () => ({ ok: true, koedHome: home }) as never,
              removePi: () => ({ ok: true, koedHome: home }) as never
            }
          )
        ).toBe(0);
        return { ok: true, koedHome: home } as never;
      };
      const code = await runIntegrationCommand(
        "setup",
        { client, json: true },
        {
          ...base(home),
          setupCodex: setup,
          setupClaude: setup,
          setupPi: setup,
          collectStatus: async () => verifiedStatus(home)
        }
      );
      expect(code).toBe(1);
      expect(connected(home, client)).toBe(false);
    }
  );

  it("does not connect Codex configured for another KOED_HOME", async () => {
    const home = newHome();
    const code = await runIntegrationCommand(
      "setup",
      { client: "codex", json: true },
      {
        ...base(home),
        setupCodex: async () => ({ ok: true, koedHome: home }) as never,
        collectStatus: async () => verifiedStatus(home, "/other")
      }
    );
    expect(code).toBe(1);
    expect(connected(home, "codex")).toBe(false);
  });

  it("does not connect a setup that reports another KOED_HOME", async () => {
    const home = newHome();
    const code = await runIntegrationCommand(
      "setup",
      { client: "pi", json: true },
      {
        ...base(home),
        setupPi: async () => ({ ok: true, koedHome: newHome() }) as never,
        collectStatus: async () => verifiedStatus(home)
      }
    );
    expect(code).toBe(1);
    expect(connected(home, "pi")).toBe(false);
  });

  it.each([true, false])(
    "connects setup only after positive verification (configured=%s)",
    async (configured) => {
      const home = newHome();
      connect(home, "pi");
      let verificationMayRevoke = true;
      const code = await runIntegrationCommand(
        "setup",
        { client: "codex", json: true },
        {
          ...base(home),
          setupCodex: async () => ({ ok: true, koedHome: home }) as never,
          collectStatus: async (_environment, dependencies) => {
            verificationMayRevoke =
              dependencies?.revokeAiClientConnection?.(home, "pi") !== false;
            return {
              koedHome: home,
              codex: {
                configured,
                details: { configuredKoedHome: home, mcpAdapter: "/adapter" }
              }
            } as never;
          }
        }
      );
      expect(code).toBe(configured ? 0 : 1);
      expect(verificationMayRevoke).toBe(false);
      expect(connected(home, "codex")).toBe(configured);
      expect(connected(home, "pi")).toBe(true);
    }
  );

  it("requires reconnecting clients recorded by earlier status checks", async () => {
    const home = newHome();
    mkdirSync(dirname(aiClientConnectionsPath(home)), { recursive: true });
    writeFileSync(
      aiClientConnectionsPath(home),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-01T00:00:00.000Z",
        connected: { codex: true, claude: true }
      })
    );
    expect(connected(home, "claude")).toBe(false);
    const code = await runIntegrationCommand(
      "setup",
      { client: "codex", json: true },
      {
        ...base(home),
        setupCodex: async () => ({ ok: true, koedHome: home }) as never,
        collectStatus: async () => verifiedStatus(home)
      }
    );
    expect(code).toBe(0);
    expect(connected(home, "codex")).toBe(true);
    expect(connected(home, "claude")).toBe(false);
  });
});
