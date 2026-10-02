import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createPullRequestConnectionStore } from "./pull-request-connection.js";
describe("explicit GitHub account delegation", () => {
  it("does not adopt an ambient connection; isolates owner and authority; revokes generations", async () => {
    const home = await mkdtemp(join(tmpdir(), "koed-pr-connection-"));
    const a = "11111111-1111-4111-8111-111111111111",
      b = "22222222-2222-4222-8222-222222222222";
    try {
      const local = createPullRequestConnectionStore(home, "local"),
        remote = createPullRequestConnectionStore(home, "remote");
      expect((await local.read(a)).account).toBeNull();
      const connected = await local.select(a, { id: "1", login: "alice" });
      expect(connected.generation).toBe(2);
      expect((await local.read(b)).account).toBeNull();
      expect((await remote.read(a)).account).toBeNull();
      const revoked = await local.select(a, null);
      expect(revoked.generation).toBe(3);
      expect(revoked.account).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
