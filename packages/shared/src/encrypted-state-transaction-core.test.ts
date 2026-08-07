import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEncryptedStateTransactionCore,
  isEncryptedStateEnvelope
} from "./encrypted-state-transaction-core.js";

interface FixtureState {
  schemaVersion: 1;
  updatedAt: string;
  upstream: Record<string, unknown>;
  localEdge: Record<string, unknown>;
  untouchedLegacyDomain: Record<string, unknown>;
}

const roots: string[] = [];

const fixtureCore = async (
  options: { beforeStoreCommit?: () => void } = {}
) => {
  const root = await mkdtemp(join(tmpdir(), "koed-encrypted-core-"));
  roots.push(root);
  const storePath = join(root, "secrets", "state.json");
  const keyPath = join(root, "config", "state.key");
  const core = createEncryptedStateTransactionCore<FixtureState>({
    storePath,
    keyPath,
    keySalt: "test-only-v1",
    createEmpty: (now) => ({
      schemaVersion: 1,
      updatedAt: now,
      upstream: {},
      localEdge: {},
      untouchedLegacyDomain: {}
    }),
    parse: (raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        (raw as FixtureState).schemaVersion !== 1
      ) {
        throw new Error("Local secret store is malformed.");
      }
      return raw as FixtureState;
    },
    deps: options
  });
  return { root, storePath, keyPath, core };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

describe("internal encrypted-state transaction core", () => {
  it("encrypts with authenticated ciphertext and fails closed after tampering", async () => {
    const { core } = await fixtureCore();
    const key = core.readOrCreateKey();
    const envelope = core.encrypt(
      key,
      "credential-secret-that-must-not-appear-on-disk",
      "2026-08-04T12:00:00.000Z",
      undefined,
      "domain:record"
    );

    expect(
      isEncryptedStateEnvelope(envelope, (value) =>
        /^\d{4}-\d{2}-\d{2}T/.test(String(value))
      )
    ).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("credential-secret");
    expect(core.decrypt(key, envelope, "domain:record")).toBe(
      "credential-secret-that-must-not-appear-on-disk"
    );
    expect(() =>
      core.decrypt(
        key,
        { ...envelope, ciphertext: Buffer.from("tampered").toString("base64") },
        "domain:record"
      )
    ).toThrow();
  });

  it("commits an explicitly declared cross-domain mutation in one replacement", async () => {
    const { core, storePath } = await fixtureCore();
    core.mutate({
      domains: ["upstream_credential", "local_edge_client_credential"],
      apply: (state) => {
        state.upstream.device = { encrypted: true };
        state.localEdge.client = { encrypted: true };
        state.updatedAt = "2026-08-04T12:00:00.000Z";
        return { result: undefined, changed: true };
      }
    });

    expect(JSON.parse(readFileSync(storePath, "utf8"))).toMatchObject({
      upstream: { device: { encrypted: true } },
      localEdge: { client: { encrypted: true } }
    });
    expect(() =>
      core.mutate({
        domains: ["upstream_credential", "upstream_credential"],
        apply: () => ({ result: undefined, changed: false })
      })
    ).toThrow("domains must be unique");
  });

  it("round-trips legacy fields without data loss or a plaintext fallback", async () => {
    const { core, storePath, root } = await fixtureCore();
    mkdirSync(join(root, "secrets"), { recursive: true });
    const legacy: FixtureState = {
      schemaVersion: 1,
      updatedAt: "2025-01-01T00:00:00.000Z",
      upstream: { existing: { ciphertext: "opaque" } },
      localEdge: {},
      untouchedLegacyDomain: { retained: ["exact", 42, { nested: true }] }
    };
    writeFileSync(storePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    core.mutate({
      domains: ["local_edge_client_credential"],
      apply: (state) => {
        state.localEdge.added = { ciphertext: "still-opaque" };
        return { result: undefined, changed: true };
      }
    });

    expect(core.read().untouchedLegacyDomain).toEqual(
      legacy.untouchedLegacyDomain
    );
    expect(readFileSync(storePath, "utf8")).not.toContain("credential-secret");
  });

  it("keeps the previous file after an interrupted commit and removes temp files", async () => {
    const initial = await fixtureCore();
    initial.core.mutate({
      domains: ["upstream_credential"],
      apply: (state) => {
        state.upstream.stable = true;
        return { result: undefined, changed: true };
      }
    });
    const before = readFileSync(initial.storePath, "utf8");
    const interrupted = createEncryptedStateTransactionCore<FixtureState>({
      storePath: initial.storePath,
      keyPath: initial.keyPath,
      keySalt: "test-only-v1",
      createEmpty: () => initial.core.read(),
      parse: (raw) => raw as FixtureState,
      deps: {
        beforeStoreCommit: () => {
          throw new Error("interrupted");
        }
      }
    });

    expect(() =>
      interrupted.mutate({
        domains: ["upstream_credential"],
        apply: (state) => {
          state.upstream.uncommitted = true;
          return { result: undefined, changed: true };
        }
      })
    ).toThrow("interrupted");
    expect(readFileSync(initial.storePath, "utf8")).toBe(before);
    expect(readdirSync(join(initial.root, "secrets"))).toEqual(["state.json"]);
  });

  it("rejects malformed state and refuses to replace a missing key", async () => {
    const { core, storePath, root } = await fixtureCore();
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(storePath, "not-json\n", "utf8");
    expect(core.readFailClosed()).toBeNull();
    expect(() => core.read()).toThrow("malformed");
    expect(() => core.readOrCreateKey()).toThrow("key is missing or invalid");
  });

  it("times out on a live lock without mutating state", async () => {
    const { storePath, keyPath } = await fixtureCore();
    mkdirSync(join(storePath, ".."), { recursive: true });
    writeFileSync(
      `${storePath}.lock`,
      `${JSON.stringify({
        version: 1,
        ownerToken: "A".repeat(43),
        pid: process.pid,
        createdAtEpochMs: Date.now()
      })}\n`,
      "utf8"
    );
    const locked = createEncryptedStateTransactionCore<FixtureState>({
      storePath,
      keyPath,
      keySalt: "test-only-v1",
      createEmpty: (now) => ({
        schemaVersion: 1,
        updatedAt: now,
        upstream: {},
        localEdge: {},
        untouchedLegacyDomain: {}
      }),
      parse: (raw) => raw as FixtureState,
      deps: { lockTimeoutMs: 0 }
    });
    expect(() =>
      locked.mutate({
        domains: ["upstream_credential"],
        apply: () => ({ result: undefined, changed: false })
      })
    ).toThrow("Timed out acquiring");
  });
});
