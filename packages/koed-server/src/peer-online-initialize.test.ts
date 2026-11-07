import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializePeerOnline,
  loadPeerOnline
} from "./peer-online-initialize.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "koed-peer-init-"));
  roots.push(root);
  let anchor: import("@koed/shared").PeerMembershipAnchor | null = null;
  let genesis = "";
  const anchorStore = {
    async read() {
      return anchor;
    },
    async create(value: NonNullable<typeof anchor>) {
      if (anchor) return false;
      anchor = value;
      return true;
    }
  };
  const membership = {
    async initialize(_anchor: NonNullable<typeof anchor>, json: string) {
      genesis = json;
      return { status: "accepted" as const };
    },
    async load(value: NonNullable<typeof anchor>) {
      const { initializePeerMembership, inspectPeerMembership } =
        await import("@koed/shared");
      const result = initializePeerMembership(value, genesis);
      if (result.status !== "accepted") throw new Error("missing membership");
      return inspectPeerMembership(result.state);
    }
  };
  return { root, anchorStore, membership };
}
describe("peer online initialization", () => {
  it("creates real custody and reloads the same authenticated identity", async () => {
    const options = fixture();
    const first = await initializePeerOnline({
      ...options,
      authorizeFreshInstallation: async () => true
    });
    const member = first.membership.members.find(
      (candidate) =>
        candidate.deviceId === first.identity.publicIdentity.deviceId
    );
    expect(member).toBeDefined();
    const encryptionSpki = Buffer.from(
      first.identity.publicIdentity.encryptionPublicKey,
      "base64"
    );
    expect(member).toMatchObject({
      encryptionSpki: encryptionSpki.toString("base64url"),
      encryptionSpkiSha256: createHash("sha256")
        .update(encryptionSpki)
        .digest("base64url")
    });
    const second = await loadPeerOnline(options);
    expect(second.identity.publicIdentity).toEqual(
      first.identity.publicIdentity
    );
    expect(second.certificate.spkiPin).toBe(first.certificate.spkiPin);
    expect(second.anchor).toEqual(first.anchor);
  });
  it("rejects unauthorized creation without changing user data", async () => {
    const options = fixture();
    const file = join(options.root, "user-data");
    writeFileSync(file, "keep");
    await expect(
      initializePeerOnline({
        ...options,
        authorizeFreshInstallation: async () => false
      })
    ).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("keep");
  });
  it("rejects a replaced independent anchor without changing custody", async () => {
    const options = fixture();
    const first = await initializePeerOnline({
      ...options,
      authorizeFreshInstallation: async () => true
    });
    const substituted = {
      ...options,
      anchorStore: {
        ...options.anchorStore,
        read: async () => ({ ...first.anchor, genesisHash: "A".repeat(43) })
      }
    };
    await expect(loadPeerOnline(substituted)).rejects.toThrow();
    expect((await loadPeerOnline(options)).identity.publicIdentity).toEqual(
      first.identity.publicIdentity
    );
  });
  it("fails closed after membership publication failure", async () => {
    const options = fixture();
    const failing = {
      ...options,
      membership: {
        ...options.membership,
        initialize: async () => {
          throw new Error("database unavailable");
        }
      }
    };
    await expect(
      initializePeerOnline({
        ...failing,
        authorizeFreshInstallation: async () => true
      })
    ).rejects.toThrow("database unavailable");
    await expect(loadPeerOnline(options)).rejects.toThrow();
    await expect(
      initializePeerOnline({
        ...options,
        authorizeFreshInstallation: async () => true
      })
    ).rejects.toThrow();
  });
});
