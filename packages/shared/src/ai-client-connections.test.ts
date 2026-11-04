import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAiClientConnected,
  readAiClientConnections,
  recordAiClientConnections
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

describe("AI Client connections", () => {
  it("treats a client as not connected until it has been recorded", () => {
    const koedHome = home();
    expect(readAiClientConnections(koedHome)).toBeNull();
    expect(isAiClientConnected(null, "codex")).toBe(false);
    recordAiClientConnections(koedHome, { codex: true, claude: false });
    const record = readAiClientConnections(koedHome);
    expect(isAiClientConnected(record, "codex")).toBe(true);
    expect(isAiClientConnected(record, "claude")).toBe(false);
    expect(isAiClientConnected(record, "pi")).toBe(false);
  });

  it("keeps the previous value when a check could not tell", () => {
    const koedHome = home();
    recordAiClientConnections(koedHome, { claude: true });
    recordAiClientConnections(koedHome, { claude: undefined, pi: true });
    expect(readAiClientConnections(koedHome)?.connected).toEqual({
      claude: true,
      pi: true
    });
  });

  it("leaves the record untouched when nothing changed", () => {
    const koedHome = home();
    const first = recordAiClientConnections(
      koedHome,
      { codex: true },
      new Date("2026-11-04T09:00:00Z")
    );
    const second = recordAiClientConnections(
      koedHome,
      { codex: true },
      new Date("2026-11-04T10:00:00Z")
    );
    expect(second.updatedAt).toBe(first.updatedAt);
  });
});
