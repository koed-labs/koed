import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiClientConnectionRevision,
  aiClientConnectionsPath,
  grantAiClientConnection,
  isAiClientConnected,
  readAiClientConnections,
  revokeAiClientConnection
} from "./ai-client-connections.js";

const homes: string[] = [];
const home = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "koed-connections-"));
  homes.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of homes.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const connect = (koedHome: string, id: "codex" | "claude" | "pi") =>
  grantAiClientConnection(
    koedHome,
    id,
    aiClientConnectionRevision(koedHome, id)
  );

describe("AI Client connections", () => {
  it("treats a client as not connected until setup connects it", () => {
    const koedHome = home();
    expect(readAiClientConnections(koedHome)).toBeNull();
    expect(isAiClientConnected(null, "codex")).toBe(false);
    expect(connect(koedHome, "codex")).toBe(true);
    const record = readAiClientConnections(koedHome);
    expect(isAiClientConnected(record, "codex")).toBe(true);
    expect(isAiClientConnected(record, "claude")).toBe(false);
    expect(isAiClientConnected(record, "pi")).toBe(false);
  });

  it("ignores records written by earlier status-derived connection checks", () => {
    const koedHome = home();
    mkdirSync(path.dirname(aiClientConnectionsPath(koedHome)), {
      recursive: true
    });
    writeFileSync(
      aiClientConnectionsPath(koedHome),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-01T00:00:00.000Z",
        connected: { codex: true, claude: true }
      })
    );
    expect(readAiClientConnections(koedHome)).toBeNull();
    expect(() => aiClientConnectionRevision(koedHome, "codex")).toThrow();
    expect(() => grantAiClientConnection(koedHome, "codex", 0)).toThrow();
  });

  it("never lets a setup that started before removal connect the client", () => {
    const koedHome = home();
    connect(koedHome, "claude");
    const noted = aiClientConnectionRevision(koedHome, "claude");
    revokeAiClientConnection(koedHome, "claude");
    expect(grantAiClientConnection(koedHome, "claude", noted)).toBe(false);
    expect(
      isAiClientConnected(readAiClientConnections(koedHome), "claude")
    ).toBe(false);
  });

  it("fences a setup even when removal finds the client already disconnected", () => {
    const koedHome = home();
    const noted = aiClientConnectionRevision(koedHome, "pi");
    revokeAiClientConnection(koedHome, "pi");
    expect(grantAiClientConnection(koedHome, "pi", noted)).toBe(false);
  });

  it("lets concurrent setups of a connected client both succeed", () => {
    const koedHome = home();
    const first = aiClientConnectionRevision(koedHome, "codex");
    const second = aiClientConnectionRevision(koedHome, "codex");
    expect(grantAiClientConnection(koedHome, "codex", first)).toBe(true);
    expect(grantAiClientConnection(koedHome, "codex", second)).toBe(true);
  });

  it("disconnects conditionally only when nothing changed since the check began", () => {
    const koedHome = home();
    connect(koedHome, "codex");
    const observed = aiClientConnectionRevision(koedHome, "codex");
    revokeAiClientConnection(koedHome, "codex");
    connect(koedHome, "codex");
    expect(
      revokeAiClientConnection(koedHome, "codex", { ifRevision: observed })
    ).toBe(false);
    expect(
      isAiClientConnected(readAiClientConnections(koedHome), "codex")
    ).toBe(true);
    const current = aiClientConnectionRevision(koedHome, "codex");
    expect(
      revokeAiClientConnection(koedHome, "codex", { ifRevision: current })
    ).toBe(true);
    expect(
      isAiClientConnected(readAiClientConnections(koedHome), "codex")
    ).toBe(false);
  });

  it("revokes over an unreadable record, disconnecting every client", () => {
    const koedHome = home();
    connect(koedHome, "codex");
    connect(koedHome, "claude");
    writeFileSync(aiClientConnectionsPath(koedHome), "{not json");
    expect(revokeAiClientConnection(koedHome, "pi")).toBe(true);
    const record = readAiClientConnections(koedHome);
    expect(isAiClientConnected(record, "codex")).toBe(false);
    expect(isAiClientConnected(record, "claude")).toBe(false);
    expect(record?.clients.pi?.connected).toBe(false);
  });

  it("keeps every change when separate processes write at once", async () => {
    const koedHome = home();
    const moduleUrl = new URL("./ai-client-connections.ts", import.meta.url);
    const script = path.join(koedHome, "writer.mts");
    writeFileSync(
      script,
      `import { aiClientConnectionRevision, grantAiClientConnection, revokeAiClientConnection } from ${JSON.stringify(moduleUrl.href)};
const [home, id, rounds] = process.argv.slice(2);
for (let index = 0; index < Number(rounds); index += 1) {
  revokeAiClientConnection(home, id);
  if (!grantAiClientConnection(home, id, aiClientConnectionRevision(home, id))) process.exit(2);
}
`
    );
    const rounds = 25;
    const run = (id: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [script, koedHome, id, String(rounds)],
          {
            cwd: path.dirname(fileURLToPath(moduleUrl)),
            stdio: ["ignore", "ignore", "inherit"]
          }
        );
        child.on("error", reject);
        child.on("exit", resolve);
      });
    const codes = await Promise.all(["codex", "claude", "pi"].map(run));
    expect(codes).toEqual([0, 0, 0]);
    const record = readAiClientConnections(koedHome);
    for (const id of ["codex", "claude", "pi"] as const) {
      expect(record?.clients[id]).toMatchObject({
        connected: true,
        revision: rounds * 2
      });
    }
  }, 30_000);
});
