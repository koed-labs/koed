import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  sharingHelpInstructions,
  sharingHelpPoints,
  SHARING_HELP_VERSION
} from "./sharing-help.js";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
describe("versioned sharing help", () => {
  it("mirrors every P1–P5 promise verbatim in committed docs and Chief instructions with existing acceptance IDs", () => {
    expect(SHARING_HELP_VERSION).toBe(1);
    expect(sharingHelpPoints.map((x) => x.id)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5"
    ]);
    const docs = read("../../../docs/how-koed-works.md");
    const contract = read(
      "../../../apps/desktop/scripts/hq-acceptance-contract.mjs"
    );
    const ids = new Set(
      [...contract.matchAll(/\bid:\s*"([^"]+)"/g)].map((x) => x[1])
    );
    for (const point of sharingHelpPoints) {
      expect(docs).toContain(point.text);
      expect(sharingHelpInstructions).toContain(point.text);
      expect(point.keptTrueBy.length).toBeGreaterThan(0);
      for (const id of point.keptTrueBy)
        expect(
          ids.has(id),
          `${point.id} has missing acceptance proof ${id}`
        ).toBe(true);
    }
    expect(sharingHelpInstructions).toContain("sharing_overview");
    expect(sharingHelpInstructions).toContain("sharing_remove");
    expect(sharingHelpInstructions).toContain("koed_sharing_open");
  });
  it("injects the same source into Codex Claude and Pi instructions while the page uses its five points", () => {
    const service = read(
      "../../../apps/worker/src/managed-conversation-service.ts"
    );
    expect(service.match(/\$\{sharingHelpInstructions\}/g)).toHaveLength(2);
    const pi = read("../../mcp-server/integrations/pi/extensions/koed.mjs");
    expect(pi).toContain("before_agent_start");
    expect(pi).toContain("${sharingHelpInstructions}");
    const page = read(
      "../../../apps/desktop/src/renderer/hq/sharing/HqSharing.tsx"
    );
    expect(page).toContain("sharingHelpPoints.map");
  });
});
