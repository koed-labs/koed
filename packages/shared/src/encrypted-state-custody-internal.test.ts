import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCollaborationActionGrantCustodyForBackend,
  deleteCollaborationActionGrantCustody,
  clearCollaborationPendingTeamSends,
  deleteCollaborationPendingSend,
  readCollaborationActionGrantCustodyCommitmentHash,
  readCollaborationActionGrantCustodyStatus,
  listCollaborationPendingSends,
  DESKTOP_LOCAL_CREDENTIAL_OPERATION_FAMILIES,
  deleteDesktopLocalCredential,
  deleteLocalEdgeClientCredential,
  deleteUpstreamCredentialSecret,
  desktopLocalCredentialReferenceFor,
  readDesktopLocalCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization,
  parseUpstreamCredentialReference,
  resolveCollaborationActionGrantSecret,
  readUpstreamCredentialAuthorization,
  rotateDesktopLocalCredential,
  storeCollaborationActionGrantCustody,
  storeCollaborationPendingSend,
  storeDesktopLocalCredential,
  storeEnrollmentCredentialCustody,
  storeLocalEdgeClientCredential,
  storeUpstreamCredentialSecret,
  updateCollaborationActionGrantCustodyStatus,
  updateCollaborationPendingSendState,
  upstreamCredentialReferenceFor,
  verifyDesktopLocalCredentialAuthorization,
  verifyLocalEdgeClientCredentialAuthorization
} from "./encrypted-state-custody-internal.js";

const temps: string[] = [];

const tempHome = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-upstream-secret-"));
  temps.push(root);
  return root;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const testFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(testFilePath), "../../..");
const vitestPath = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");

const waitForFile = async (path: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child-process signal: ${path}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
};

const waitForChild = (
  child: ChildProcessWithoutNullStreams
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveChild, rejectChild) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectChild);
    child.once("close", (code) => resolveChild({ code, stdout, stderr }));
  });

const spawnConcurrencyChild = (
  koedHome: string,
  operation: string,
  input: unknown,
  signals: { ready?: string; release?: string; started?: string } = {}
): ChildProcessWithoutNullStreams =>
  spawn(
    process.execPath,
    [
      vitestPath,
      "run",
      testFilePath,
      "--testNamePattern=credential store concurrency child"
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        KOED_CREDENTIAL_STORE_CHILD_OPERATION: operation,
        KOED_CREDENTIAL_STORE_CHILD_HOME: koedHome,
        KOED_CREDENTIAL_STORE_CHILD_INPUT: JSON.stringify(input),
        KOED_CREDENTIAL_STORE_CHILD_READY: signals.ready,
        KOED_CREDENTIAL_STORE_CHILD_RELEASE: signals.release,
        KOED_CREDENTIAL_STORE_CHILD_STARTED: signals.started
      },
      stdio: "pipe"
    }
  );

describe("upstream credential secret store", () => {
  it("stages enrollment credential custody in one atomic encrypted replacement", () => {
    const koedHome = tempHome();
    const result = storeEnrollmentCredentialCustody(koedHome, {
      upstream: {
        backendId: "team-vps",
        credentialKeyId: "device-key",
        secret: "upstream-secret"
      },
      localEdgeClient: {
        backendId: "team-vps",
        secret: "local-edge-secret",
        operationFamilies: ["team_workspace_read"]
      }
    });

    expect(result.upstreamReference).toBe(
      upstreamCredentialReferenceFor({
        backendId: "team-vps",
        credentialKeyId: "device-key"
      })
    );
    expect(
      readUpstreamCredentialAuthorization(koedHome, result.upstreamReference)
    ).toBe("Koed-Device device-key:upstream-secret");
    expect(
      readLocalEdgeClientCredentialAuthorization(koedHome, "team-vps")
    ).toMatchObject({
      backendId: "team-vps",
      operationFamilies: ["team_workspace_read"]
    });
    const persisted = readFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "utf8"
    );
    expect(persisted).not.toContain("upstream-secret");
    expect(persisted).not.toContain("local-edge-secret");
  });

  it("leaves neither enrollment credential staged when the atomic commit is interrupted", () => {
    const koedHome = tempHome();
    expect(() =>
      storeEnrollmentCredentialCustody(
        koedHome,
        {
          upstream: {
            backendId: "team-vps",
            credentialKeyId: "device-key",
            secret: "upstream-secret"
          },
          localEdgeClient: {
            backendId: "team-vps",
            secret: "local-edge-secret",
            operationFamilies: ["team_workspace_read"]
          }
        },
        {
          beforeStoreCommit: () => {
            throw new Error("interrupted");
          }
        }
      )
    ).toThrow("interrupted");
    expect(
      readUpstreamCredentialAuthorization(
        koedHome,
        upstreamCredentialReferenceFor({
          backendId: "team-vps",
          credentialKeyId: "device-key"
        })
      )
    ).toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(koedHome, "team-vps")
    ).toBeNull();
  });

  it("persists collaboration retry bodies encrypted with immutable send identity", () => {
    const koedHome = tempHome();
    const teamSend = {
      ownerId: "renderer:alice",
      backendId: "team-vps",
      remotePrincipalId: "44444444-4444-4444-8444-444444444444",
      deviceCredentialId: "55555555-5555-4555-8555-555555555555",
      thread: {
        scope: "team" as const,
        threadId: "11111111-1111-4111-8111-111111111111",
        teamId: "22222222-2222-4222-8222-222222222222"
      },
      clientMessageId: "33333333-3333-4333-8333-333333333333",
      body: "Sensitive retry body"
    };
    const stored = storeCollaborationPendingSend(koedHome, teamSend);

    expect(stored).toMatchObject({
      ...teamSend,
      attemptCount: 0,
      state: "pending",
      nextAttemptAt: null
    });
    const storeText = readFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "utf8"
    );
    expect(storeText).not.toContain(teamSend.body);
    expect(storeText).not.toContain("body");

    expect(
      updateCollaborationPendingSendState(koedHome, {
        key: stored.key,
        attemptCount: 5,
        state: "manual_retry",
        nextAttemptAt: null
      })
    ).toMatchObject({ attemptCount: 5, state: "manual_retry" });
    expect(listCollaborationPendingSends(koedHome)).toEqual([
      expect.objectContaining({ key: stored.key, body: teamSend.body })
    ]);
    expect(() =>
      storeCollaborationPendingSend(koedHome, {
        ...teamSend,
        body: "Reused identity with different content"
      })
    ).toThrow("identity was reused");
    expect(clearCollaborationPendingTeamSends(koedHome, "other")).toBe(0);
    expect(clearCollaborationPendingTeamSends(koedHome, "team-vps")).toBe(1);
    expect(deleteCollaborationPendingSend(koedHome, stored.key)).toBe(false);
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
  });

  it("accepts complete remote Personal custody and rejects partial bindings", () => {
    const koedHome = tempHome();
    const remotePersonalSend = {
      ownerId: "renderer:alice",
      backendId: "personal-vps",
      remotePrincipalId: "44444444-4444-4444-8444-444444444444",
      deviceCredentialId: "55555555-5555-4555-8555-555555555555",
      thread: {
        scope: "personal" as const,
        threadId: "11111111-1111-4111-8111-111111111111"
      },
      clientMessageId: "33333333-3333-4333-8333-333333333333",
      body: "Remote Personal retry body"
    };

    expect(
      storeCollaborationPendingSend(koedHome, remotePersonalSend)
    ).toMatchObject(remotePersonalSend);
    expect(() =>
      storeCollaborationPendingSend(koedHome, {
        ...remotePersonalSend,
        clientMessageId: "66666666-6666-4666-8666-666666666666",
        deviceCredentialId: null
      })
    ).toThrow("binding is invalid");
  });

  it("stores only an encrypted local secret behind a stable reference", () => {
    const koedHome = tempHome();

    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_1",
      secret: "plain-device-secret"
    });

    expect(reference).toBe(
      upstreamCredentialReferenceFor({
        backendId: "team-vps",
        credentialKeyId: "koed_device_1"
      })
    );
    expect(parseUpstreamCredentialReference(reference)).toEqual({
      backendId: "team-vps",
      credentialKeyId: "koed_device_1"
    });
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBe(
      "Koed-Device koed_device_1:plain-device-secret"
    );

    const storeText = readFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "utf8"
    );
    expect(storeText).not.toContain("plain-device-secret");
    expect(storeText).toContain(reference);
    expect(
      statSync(resolve(koedHome, "secrets", "upstream-credentials.json")).mode &
        0o777
    ).toBe(0o600);
    expect(
      statSync(resolve(koedHome, "config", "local-secret-store.key")).mode &
        0o777
    ).toBe(0o600);
  });

  it("deletes stored secrets without accepting malformed references", () => {
    const koedHome = tempHome();
    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_2",
      secret: "device-secret"
    });

    expect(deleteUpstreamCredentialSecret(koedHome, "bearer-secret")).toBe(
      false
    );
    expect(deleteUpstreamCredentialSecret(koedHome, reference)).toBe(true);
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBeNull();
    expect(deleteUpstreamCredentialSecret(koedHome, reference)).toBe(false);
  });

  it("stores a distinct scoped local-edge client credential", () => {
    const koedHome = tempHome();
    storeLocalEdgeClientCredential(koedHome, {
      backendId: "team-vps",
      secret: "local-client-secret",
      operationFamilies: ["team_workspace_read"]
    });

    const stored = readLocalEdgeClientCredentialAuthorization(
      koedHome,
      "team-vps"
    );
    expect(stored).toMatchObject({
      backendId: "team-vps",
      operationFamilies: ["team_workspace_read"]
    });
    expect(stored?.authorization).toContain("Koed-Device koed_local_");
    expect(stored?.authorization).toContain(":local-client-secret");
    expect(
      verifyLocalEdgeClientCredentialAuthorization(
        koedHome,
        stored?.authorization,
        {
          backendId: "team-vps",
          operationFamily: "team_workspace_read"
        }
      )
    ).toMatchObject({ backendId: "team-vps" });
    expect(
      verifyLocalEdgeClientCredentialAuthorization(
        koedHome,
        stored?.authorization,
        { backendId: "team-vps", operationFamily: "admin" }
      )
    ).toBeNull();
    expect(deleteLocalEdgeClientCredential(koedHome, "team-vps")).toBe(true);
    expect(
      readLocalEdgeClientCredentialAuthorization(koedHome, "team-vps")
    ).toBeNull();
  });

  it("rejects ambiguous header values and fails closed on damaged storage", () => {
    const koedHome = tempHome();
    expect(() =>
      storeUpstreamCredentialSecret(koedHome, {
        backendId: "team-vps",
        credentialKeyId: "credential:key",
        secret: "secret"
      })
    ).toThrow("credentialKeyId is not valid");
    expect(() =>
      storeUpstreamCredentialSecret(koedHome, {
        backendId: "team-vps",
        credentialKeyId: "credential-key",
        secret: "secret\r\nInjected: true"
      })
    ).toThrow("Upstream credential secret is not valid");
    storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "credential-key",
      secret: "safe-secret"
    });
    const reference = upstreamCredentialReferenceFor({
      backendId: "team-vps",
      credentialKeyId: "credential-key"
    });
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBe(
      "Koed-Device credential-key:safe-secret"
    );

    storeLocalEdgeClientCredential(koedHome, {
      backendId: "team-vps",
      secret: "local-client-secret",
      operationFamilies: ["team_workspace_read"]
    });
    unlinkSync(resolve(koedHome, "config", "local-secret-store.key"));
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(koedHome, "team-vps")
    ).toBeNull();
    expect(() =>
      storeUpstreamCredentialSecret(koedHome, {
        backendId: "team-vps",
        credentialKeyId: "replacement-key",
        secret: "replacement-secret"
      })
    ).toThrow("missing or invalid");

    writeFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "not-json",
      "utf8"
    );
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBeNull();
  });
});

describe("credential store atomic mutation locking", () => {
  const pendingSend = {
    ownerId: "renderer:lock-test",
    backendId: "team-vps",
    remotePrincipalId: "44444444-4444-4444-8444-444444444444",
    deviceCredentialId: "55555555-5555-4555-8555-555555555555",
    thread: {
      scope: "team" as const,
      threadId: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222"
    },
    clientMessageId: "33333333-3333-4333-8333-333333333333",
    body: "Lock-protected retry body"
  };

  it("uses a unique durable temp file for every key and store replacement", () => {
    const koedHome = tempHome();
    const renamedSources: string[] = [];
    const trackedRename: typeof renameSync = (oldPath, newPath) => {
      renamedSources.push(String(oldPath));
      renameSync(oldPath, newPath);
    };

    storeUpstreamCredentialSecret(
      koedHome,
      {
        backendId: "team-vps",
        credentialKeyId: "koed_device_atomic",
        secret: "atomic-secret"
      },
      { renameSync: trackedRename }
    );
    storeCollaborationPendingSend(
      koedHome,
      pendingSend,
      {},
      {
        renameSync: trackedRename
      }
    );

    expect(renamedSources.length).toBe(3);
    expect(new Set(renamedSources).size).toBe(renamedSources.length);
    expect(renamedSources.every((path) => path.endsWith(".tmp"))).toBe(true);
    expect(renamedSources).not.toContain(
      resolve(koedHome, "secrets", "upstream-credentials.json.tmp")
    );
    expect(
      readdirSync(resolve(koedHome, "secrets")).filter((name) =>
        name.endsWith(".tmp")
      )
    ).toEqual([]);
  });

  it("recovers an aged lock but bounds waiting on a fresh malformed lock", () => {
    const koedHome = tempHome();
    storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_lock",
      secret: "lock-secret"
    });
    const lockPath = resolve(
      koedHome,
      "secrets",
      "upstream-credentials.json.lock"
    );
    const staleAt = Date.now() - 5_000;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        ownerToken: Buffer.alloc(32, 0x41).toString("base64url"),
        pid: 999_999,
        createdAtEpochMs: staleAt
      })}\n`,
      { mode: 0o600 }
    );
    utimesSync(lockPath, new Date(staleAt), new Date(staleAt));

    expect(
      storeCollaborationPendingSend(
        koedHome,
        pendingSend,
        {},
        {
          staleLockMs: 1_000
        }
      ).body
    ).toBe(pendingSend.body);
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, "malformed-lock", { mode: 0o600 });
    let lockNow = Date.now();
    const storeBefore = readFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "utf8"
    );
    expect(() =>
      updateCollaborationPendingSendState(
        koedHome,
        {
          key: listCollaborationPendingSends(koedHome)[0]!.key,
          attemptCount: 1,
          state: "pending",
          nextAttemptAt: null
        },
        {
          lockTimeoutMs: 200,
          staleLockMs: 1_000,
          lockNowMs: () => (lockNow += 100),
          sleepSync: () => undefined
        }
      )
    ).toThrow("Timed out acquiring");
    expect(
      readFileSync(
        resolve(koedHome, "secrets", "upstream-credentials.json"),
        "utf8"
      )
    ).toBe(storeBefore);
    unlinkSync(lockPath);
  });

  it("releases a lock only while its random ownership token still matches", () => {
    const koedHome = tempHome();
    const lockPath = resolve(
      koedHome,
      "secrets",
      "upstream-credentials.json.lock"
    );
    const replacementToken = Buffer.alloc(32, 0x42).toString("base64url");

    storeUpstreamCredentialSecret(
      koedHome,
      {
        backendId: "team-vps",
        credentialKeyId: "koed_device_owner",
        secret: "owner-secret"
      },
      {
        beforeStoreCommit: () => {
          writeFileSync(
            lockPath,
            `${JSON.stringify({
              version: 1,
              ownerToken: replacementToken,
              pid: process.pid + 1,
              createdAtEpochMs: Date.now()
            })}\n`,
            "utf8"
          );
        }
      }
    );

    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      ownerToken: replacementToken
    });
    unlinkSync(lockPath);
  });

  it("fails closed without rewriting a structurally malformed encrypted store", () => {
    const koedHome = tempHome();
    storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_malformed",
      secret: "malformed-secret"
    });
    const storePath = resolve(koedHome, "secrets", "upstream-credentials.json");
    const malformed = JSON.parse(readFileSync(storePath, "utf8")) as {
      secrets: Record<string, { iv: string }>;
    };
    const [reference] = Object.keys(malformed.secrets);
    malformed.secrets[reference!]!.iv = "not-base64";
    const malformedText = `${JSON.stringify(malformed, null, 2)}\n`;
    writeFileSync(storePath, malformedText, "utf8");

    expect(() => storeCollaborationPendingSend(koedHome, pendingSend)).toThrow(
      "Local secret store is malformed"
    );
    expect(readFileSync(storePath, "utf8")).toBe(malformedText);
  });
});

describe("desktop local credential store", () => {
  const ownerUserId = "11111111-1111-4111-8111-111111111111";
  const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";

  it("keeps generated credential custody encrypted and reuses it after restart", () => {
    const koedHome = tempHome();
    const stored = storeDesktopLocalCredential(koedHome, {
      ownerUserId,
      operationFamilies: [...DESKTOP_LOCAL_CREDENTIAL_OPERATION_FAMILIES]
    });
    const secret = stored.authorization.split(":")[1];

    expect(stored).toMatchObject({
      version: 1,
      reference: desktopLocalCredentialReferenceFor(),
      ownerUserId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    expect(stored.credentialKeyId).toMatch(/^koed_desktop_[a-f0-9]{40}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readDesktopLocalCredentialAuthorization(koedHome)).toEqual(stored);

    const storePath = resolve(koedHome, "secrets", "upstream-credentials.json");
    const storeText = readFileSync(storePath, "utf8");
    expect(stored.reference).not.toContain(secret);
    expect(storeText).not.toContain(secret);
    expect(storeText).not.toContain(stored.authorization);
    expect(storeText).toContain(stored.reference);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(
      statSync(resolve(koedHome, "config", "local-secret-store.key")).mode &
        0o777
    ).toBe(0o600);
  });

  it("verifies the exact key, secret, owner binding, and personal operation family", () => {
    const koedHome = tempHome();
    const stored = storeDesktopLocalCredential(koedHome, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_read"]
    });
    const [schemeAndKey, secret] = stored.authorization.split(":");
    const wrongKey = `${schemeAndKey?.slice(0, -1)}${
      schemeAndKey?.endsWith("0") ? "1" : "0"
    }`;
    const wrongSecret = `${secret?.slice(0, -1)}${
      secret?.endsWith("A") ? "B" : "A"
    }`;

    expect(
      verifyDesktopLocalCredentialAuthorization(
        koedHome,
        stored.authorization,
        { ownerUserId, operationFamily: "personal_collaboration_read" }
      )
    ).toEqual(stored);
    expect(
      verifyDesktopLocalCredentialAuthorization(
        koedHome,
        `${wrongKey}:${secret}`,
        { ownerUserId, operationFamily: "personal_collaboration_read" }
      )
    ).toBeNull();
    expect(
      verifyDesktopLocalCredentialAuthorization(
        koedHome,
        `${schemeAndKey}:${wrongSecret}`,
        { ownerUserId, operationFamily: "personal_collaboration_read" }
      )
    ).toBeNull();
    expect(
      verifyDesktopLocalCredentialAuthorization(
        koedHome,
        stored.authorization,
        {
          ownerUserId: otherOwnerUserId,
          operationFamily: "personal_collaboration_read"
        }
      )
    ).toBeNull();
    expect(
      verifyDesktopLocalCredentialAuthorization(
        koedHome,
        stored.authorization,
        { ownerUserId, operationFamily: "personal_collaboration_write" }
      )
    ).toBeNull();
  });

  it("fails closed on ciphertext tampering, corruption, and lost key custody", () => {
    const tamperedHome = tempHome();
    const stored = storeDesktopLocalCredential(tamperedHome, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_read"]
    });
    const storePath = resolve(
      tamperedHome,
      "secrets",
      "upstream-credentials.json"
    );
    const store = JSON.parse(readFileSync(storePath, "utf8")) as {
      secrets: Record<string, { ciphertext: string }>;
    };
    const envelope = store.secrets[desktopLocalCredentialReferenceFor()];
    expect(envelope).toBeDefined();
    envelope!.ciphertext = `${envelope!.ciphertext.startsWith("A") ? "B" : "A"}${envelope!.ciphertext.slice(1)}`;
    writeFileSync(storePath, `${JSON.stringify(store)}\n`, "utf8");

    expect(readDesktopLocalCredentialAuthorization(tamperedHome)).toBeNull();
    expect(
      verifyDesktopLocalCredentialAuthorization(
        tamperedHome,
        stored.authorization,
        { ownerUserId, operationFamily: "personal_collaboration_read" }
      )
    ).toBeNull();

    writeFileSync(storePath, "not-json", "utf8");
    expect(readDesktopLocalCredentialAuthorization(tamperedHome)).toBeNull();

    const lostKeyHome = tempHome();
    storeDesktopLocalCredential(lostKeyHome, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_write"]
    });
    unlinkSync(resolve(lostKeyHome, "config", "local-secret-store.key"));
    expect(readDesktopLocalCredentialAuthorization(lostKeyHome)).toBeNull();
  });

  it("rotates credential material, invalidates the old authorization, and deletes it", () => {
    const koedHome = tempHome();
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
    const stored = storeDesktopLocalCredential(
      koedHome,
      {
        ownerUserId,
        operationFamilies: ["personal_collaboration_write"]
      },
      { now }
    );
    const rotated = rotateDesktopLocalCredential(koedHome, { now });

    expect(rotated).not.toBeNull();
    expect(rotated?.credentialKeyId).not.toBe(stored.credentialKeyId);
    expect(rotated?.authorization).not.toBe(stored.authorization);
    expect(rotated).toMatchObject({
      ownerUserId,
      operationFamilies: ["personal_collaboration_write"],
      createdAt: stored.createdAt
    });
    expect(rotated!.updatedAt > stored.updatedAt).toBe(true);
    expect(
      verifyDesktopLocalCredentialAuthorization(
        koedHome,
        stored.authorization,
        { ownerUserId, operationFamily: "personal_collaboration_write" },
        { now }
      )
    ).toBeNull();
    expect(
      verifyDesktopLocalCredentialAuthorization(
        koedHome,
        rotated?.authorization,
        { ownerUserId, operationFamily: "personal_collaboration_write" },
        { now }
      )
    ).toEqual(rotated);

    expect(deleteDesktopLocalCredential(koedHome, { now })).toBe(true);
    expect(
      readDesktopLocalCredentialAuthorization(koedHome, { now })
    ).toBeNull();
    expect(deleteDesktopLocalCredential(koedHome, { now })).toBe(false);
    expect(rotateDesktopLocalCredential(koedHome, { now })).toBeNull();
  });

  it("rejects invalid owners and every non-personal or ambiguous operation family", () => {
    const invalidFamilies = [
      [],
      ["team_chat_read"],
      ["team_workspace_write"],
      ["remote_collaboration_read"],
      ["admin"],
      ["personal_collaboration_read", "team_chat_write"],
      [" personal_collaboration_read"],
      ["personal_collaboration_read\n"]
    ];

    for (const operationFamilies of invalidFamilies) {
      expect(() =>
        storeDesktopLocalCredential(tempHome(), {
          ownerUserId,
          operationFamilies
        })
      ).toThrow("operationFamilies are not valid");
    }
    expect(() =>
      storeDesktopLocalCredential(tempHome(), {
        ownerUserId: "not-a-uuid",
        operationFamilies: ["personal_collaboration_read"]
      })
    ).toThrow("ownerUserId is not a valid UUID");
  });
});

describe("collaboration Action Grant custody", () => {
  const backendId = "team-vps";
  const deploymentBaseUrl = "https://team.example.test/koed";
  const principalUserId = "33333333-3333-4333-8333-333333333333";
  const wrongPrincipalUserId = "99999999-9999-4999-8999-999999999999";
  const deviceCredentialId = "44444444-4444-4444-8444-444444444444";
  const teamId = "55555555-5555-4555-8555-555555555555";
  const workspaceId = "66666666-6666-4666-8666-666666666666";
  const referenceId = "77777777-7777-4777-8777-777777777777";
  const idempotencyKey = "88888888-8888-4888-8888-888888888888";
  const createdAt = "2026-07-17T02:00:00.000Z";
  const expiresAt = "2026-07-17T02:05:00.000Z";
  const actionPath = `/v1/teams/${teamId}/workspaces`;
  const actionBody = { name: "Research", description: "Shared research" };
  const secretSentinel = `hrg_${Buffer.alloc(32, 0x41).toString("base64url")}`;

  const fixedDeps = (nowIso = createdAt) => ({
    now: () => new Date(nowIso),
    randomBytes: (size: number) => Buffer.alloc(size, 0x41)
  });

  const storeGrant = (
    koedHome: string,
    overrides: Partial<
      Parameters<typeof storeCollaborationActionGrantCustody>[1]
    > = {}
  ) =>
    storeCollaborationActionGrantCustody(
      koedHome,
      {
        referenceId,
        backendId,
        deploymentBaseUrl,
        deviceCredentialId,
        principalUserId,
        operationFamily: "admin",
        action: "team.workspace.create",
        teamId,
        targetId: null,
        method: "POST",
        path: actionPath,
        body: actionBody,
        idempotencyKey,
        expiresAt,
        ...overrides
      },
      fixedDeps()
    );

  const access = {
    referenceId,
    backendId,
    deploymentBaseUrl,
    deviceCredentialId,
    principalUserId
  } as const;
  const reviewedAccess = {
    ...access,
    approvalTier: "step_up" as const,
    review: {
      version: 1 as const,
      title: "Approve this action?",
      description: "Review the exact action binding.",
      consequence: "The bound action may execute.",
      confirmLabel: "Approve",
      details: []
    }
  };

  const resolveInput = {
    ...access,
    operationFamily: "admin" as const,
    action: "team.workspace.create",
    teamId,
    targetId: null,
    method: "POST" as const,
    path: actionPath,
    body: actionBody,
    idempotencyKey
  };

  it("stores only encrypted Action Grant secret custody and reuses it after restart", () => {
    const koedHome = tempHome();
    const stored = storeGrant(koedHome);
    const persisted = JSON.parse(
      readFileSync(
        resolve(koedHome, "secrets", "upstream-credentials.json"),
        "utf8"
      )
    ) as { actionGrants: Record<string, unknown> };

    expect(stored.secret).toBe(secretSentinel);
    expect(stored.commitmentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.actionGrants[referenceId]).toMatchObject({
      lifecycle: "unclassified",
      approvalTier: null,
      review: null,
      state: "pending",
      approvalState: null
    });
    expect(
      updateCollaborationActionGrantCustodyStatus(
        koedHome,
        {
          ...reviewedAccess,
          approvalTier: "native_review",
          state: "review_required",
          activationUrl: null
        },
        fixedDeps("2026-07-17T02:00:20.000Z")
      )
    ).toMatchObject({ state: "review_required" });
    const reviewRequiredStore = JSON.parse(
      readFileSync(
        resolve(koedHome, "secrets", "upstream-credentials.json"),
        "utf8"
      )
    ) as { actionGrants: Record<string, unknown> };
    expect(reviewRequiredStore.actionGrants[referenceId]).toMatchObject({
      state: "pending",
      approvalState: "review_required"
    });
    expect(
      updateCollaborationActionGrantCustodyStatus(
        koedHome,
        {
          ...reviewedAccess,
          state: "pending",
          activationUrl: `${deploymentBaseUrl}/approve/action-grants/${referenceId}`
        },
        fixedDeps("2026-07-17T02:00:30.000Z")
      )
    ).toMatchObject({
      state: "pending",
      actionGrant: { id: referenceId }
    });
    expect(
      updateCollaborationActionGrantCustodyStatus(
        koedHome,
        { ...reviewedAccess, state: "approved" },
        fixedDeps("2026-07-17T02:01:00.000Z")
      )
    ).toMatchObject({
      state: "approved",
      activationUrl: null
    });

    const storeText = readFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "utf8"
    );
    expect(storeText).not.toContain(secretSentinel);
    expect(storeText).not.toContain('"actionGrant":"');
    expect(storeText).toContain(referenceId);
    expect(
      readCollaborationActionGrantCustodyStatus(
        koedHome,
        access,
        fixedDeps("2026-07-17T02:01:30.000Z")
      )
    ).toMatchObject({
      state: "approved",
      actionGrant: { id: referenceId }
    });
    expect(
      resolveCollaborationActionGrantSecret(
        koedHome,
        resolveInput,
        fixedDeps("2026-07-17T02:02:00.000Z")
      )
    ).toBe(secretSentinel);
  });

  it("upgrades Action Grant records written before the compatibility fields", () => {
    const koedHome = tempHome();
    const stored = storeGrant(koedHome);
    const storePath = resolve(koedHome, "secrets", "upstream-credentials.json");
    const persisted = JSON.parse(readFileSync(storePath, "utf8")) as {
      actionGrants: Record<string, Record<string, unknown>>;
    };
    persisted.actionGrants[referenceId]!.state = null;
    delete persisted.actionGrants[referenceId]!.approvalState;
    writeFileSync(storePath, `${JSON.stringify(persisted)}\n`, "utf8");

    expect(
      readCollaborationActionGrantCustodyCommitmentHash(
        koedHome,
        access,
        fixedDeps("2026-07-17T02:00:10.000Z")
      )
    ).toBe(stored.commitmentHash);
    expect(
      updateCollaborationActionGrantCustodyStatus(
        koedHome,
        {
          ...reviewedAccess,
          state: "pending",
          activationUrl: `${deploymentBaseUrl}/approve/action-grants/${referenceId}`
        },
        fixedDeps("2026-07-17T02:00:20.000Z")
      )
    ).toMatchObject({ state: "pending" });
    const upgraded = JSON.parse(readFileSync(storePath, "utf8")) as {
      actionGrants: Record<string, Record<string, unknown>>;
    };
    expect(upgraded.actionGrants[referenceId]).toMatchObject({
      state: "pending",
      approvalState: "pending"
    });
  });

  it("fails closed on ciphertext or metadata tampering", () => {
    const koedHome = tempHome();
    storeGrant(koedHome);
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      { ...reviewedAccess, state: "approved" },
      fixedDeps("2026-07-17T02:01:00.000Z")
    );

    const storePath = resolve(koedHome, "secrets", "upstream-credentials.json");
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as {
      actionGrants: Record<
        string,
        { metadata: { path: string }; envelope: { ciphertext: string } }
      >;
    };
    parsed.actionGrants[referenceId]!.metadata.path = "/v1/tampered";
    parsed.actionGrants[referenceId]!.envelope.ciphertext =
      `A${parsed.actionGrants[referenceId]!.envelope.ciphertext.slice(1)}`;
    writeFileSync(storePath, `${JSON.stringify(parsed)}\n`, "utf8");

    expect(
      resolveCollaborationActionGrantSecret(
        koedHome,
        resolveInput,
        fixedDeps("2026-07-17T02:02:00.000Z")
      )
    ).toBeNull();
    expect(
      readCollaborationActionGrantCustodyStatus(
        koedHome,
        access,
        fixedDeps("2026-07-17T02:02:30.000Z")
      )
    ).toBeNull();
  });

  it("expires and deletes stale custody instead of returning a secret after restart", () => {
    const koedHome = tempHome();
    storeGrant(koedHome);
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      { ...reviewedAccess, state: "approved" },
      fixedDeps("2026-07-17T02:01:00.000Z")
    );

    expect(
      readCollaborationActionGrantCustodyCommitmentHash(
        koedHome,
        access,
        fixedDeps("2026-07-17T02:06:00.000Z")
      )
    ).toBeNull();
    expect(
      resolveCollaborationActionGrantSecret(
        koedHome,
        resolveInput,
        fixedDeps("2026-07-17T02:06:00.000Z")
      )
    ).toBeNull();
    expect(deleteCollaborationActionGrantCustody(koedHome, referenceId)).toBe(
      false
    );
  });

  it("prunes expired custody when storing the next Action Grant", () => {
    const koedHome = tempHome();
    storeGrant(koedHome);
    const nextReferenceId = "99999999-9999-4999-8999-999999999999";

    storeCollaborationActionGrantCustody(
      koedHome,
      {
        referenceId: nextReferenceId,
        backendId,
        deploymentBaseUrl,
        deviceCredentialId,
        principalUserId,
        operationFamily: "admin",
        action: "team.workspace.create",
        teamId,
        targetId: null,
        method: "POST",
        path: actionPath,
        body: { name: "Next Workspace", description: null },
        idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expiresAt: "2026-07-17T02:10:00.000Z"
      },
      {
        now: () => new Date("2026-07-17T02:06:00.000Z"),
        randomBytes: (size) => Buffer.alloc(size, 0x42)
      }
    );

    const store = JSON.parse(
      readFileSync(
        resolve(koedHome, "secrets", "upstream-credentials.json"),
        "utf8"
      )
    ) as { actionGrants: Record<string, unknown> };
    expect(Object.keys(store.actionGrants)).toEqual([nextReferenceId]);
  });

  it("clears only Action Grant custody for the selected backend", () => {
    const koedHome = tempHome();
    const otherReferenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    storeGrant(koedHome);
    storeGrant(koedHome, {
      referenceId: otherReferenceId,
      backendId: "other-vps",
      deploymentBaseUrl: "https://other.example.test/koed",
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    });

    expect(
      clearCollaborationActionGrantCustodyForBackend(koedHome, backendId)
    ).toBe(1);
    expect(
      readCollaborationActionGrantCustodyStatus(koedHome, access, fixedDeps())
    ).toBeNull();
    expect(
      readCollaborationActionGrantCustodyCommitmentHash(
        koedHome,
        {
          ...access,
          referenceId: otherReferenceId,
          backendId: "other-vps",
          deploymentBaseUrl: "https://other.example.test/koed"
        },
        fixedDeps()
      )
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on malformed Action Grant custody without rewriting unrelated encrypted state", () => {
    const koedHome = tempHome();
    const otherReferenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ambiguousReferenceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const primitiveReferenceId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const credential = storeUpstreamCredentialSecret(koedHome, {
      backendId,
      credentialKeyId: "koed_device_preserved",
      secret: "preserved-device-secret"
    });
    const pendingSend = storeCollaborationPendingSend(koedHome, {
      ownerId: "renderer:alice",
      backendId,
      remotePrincipalId: principalUserId,
      deviceCredentialId,
      thread: {
        scope: "team",
        threadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        teamId
      },
      clientMessageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      body: "Preserve this pending send"
    });
    storeGrant(koedHome);
    storeGrant(koedHome, {
      referenceId: otherReferenceId,
      backendId: "other-vps",
      deploymentBaseUrl: "https://other.example.test/koed",
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    });

    const storePath = resolve(koedHome, "secrets", "upstream-credentials.json");
    const before = JSON.parse(readFileSync(storePath, "utf8")) as {
      secrets: Record<string, unknown>;
      actionGrants: Record<string, unknown>;
      pendingCollaborationSends: Record<string, unknown>;
    };
    (before.actionGrants[referenceId] as Record<string, unknown>).state =
      "malformed";
    before.actionGrants[ambiguousReferenceId] = {
      schemaVersion: 1,
      referenceId: ambiguousReferenceId,
      metadata: { backendId: "not a valid backend" }
    };
    before.actionGrants[primitiveReferenceId] = "malformed";
    const malformedText = `${JSON.stringify(before, null, 2)}\n`;
    writeFileSync(storePath, malformedText, "utf8");

    expect(() =>
      clearCollaborationActionGrantCustodyForBackend(koedHome, backendId)
    ).toThrow("Local secret store is malformed");
    expect(readFileSync(storePath, "utf8")).toBe(malformedText);
    expect(
      readUpstreamCredentialAuthorization(koedHome, credential.reference)
    ).toBeNull();
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
    expect(pendingSend.key).toMatch(/^collaboration-send:/);
  });

  it("is empty-store safe, idempotent, and rejects invalid backend IDs", () => {
    const koedHome = tempHome();
    expect(
      clearCollaborationActionGrantCustodyForBackend(koedHome, backendId)
    ).toBe(0);
    expect(() =>
      clearCollaborationActionGrantCustodyForBackend(
        koedHome,
        "invalid/backend"
      )
    ).toThrow("backendId is not valid");

    storeGrant(koedHome);
    expect(
      clearCollaborationActionGrantCustodyForBackend(koedHome, backendId)
    ).toBe(1);
    expect(
      clearCollaborationActionGrantCustodyForBackend(koedHome, backendId)
    ).toBe(0);
  });

  it("fails closed without replacing a malformed store", () => {
    const koedHome = tempHome();
    const storePath = resolve(koedHome, "secrets", "upstream-credentials.json");
    storeGrant(koedHome);
    writeFileSync(storePath, "not-json", "utf8");

    expect(() =>
      clearCollaborationActionGrantCustodyForBackend(koedHome, backendId)
    ).toThrow();
    expect(readFileSync(storePath, "utf8")).toBe("not-json");
  });

  it("deletes custody on backend, device, or principal mismatch", () => {
    for (const mismatch of [
      { principalUserId: wrongPrincipalUserId },
      { backendId: "wrong-backend" },
      {
        deviceCredentialId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }
    ] as const) {
      const koedHome = tempHome();
      storeGrant(koedHome);
      updateCollaborationActionGrantCustodyStatus(
        koedHome,
        { ...reviewedAccess, state: "approved" },
        fixedDeps("2026-07-17T02:01:00.000Z")
      );

      expect(
        resolveCollaborationActionGrantSecret(
          koedHome,
          { ...resolveInput, ...mismatch },
          fixedDeps("2026-07-17T02:02:00.000Z")
        )
      ).toBeNull();
      expect(
        resolveCollaborationActionGrantSecret(
          koedHome,
          resolveInput,
          fixedDeps("2026-07-17T02:02:30.000Z")
        )
      ).toBeNull();
    }
  });

  it("supports share_grant_management custody with exact PUT request binding", () => {
    const koedHome = tempHome();
    const sharedMemoryPath = `/v1/shared-memory/share-grants/${workspaceId}/representation`;
    const sharedMemoryBody = {
      mutationId: idempotencyKey,
      consentId: teamId,
      expectedGrantVersion: 3,
      authority: {
        action: "workspace.memory.share_owned",
        source: "device_action_grant",
        referenceId
      }
    };
    storeGrant(koedHome, {
      operationFamily: "share_grant_management",
      action: `shared_memory.change_representation.${workspaceId}.lcm_leaves`,
      teamId,
      targetId: workspaceId,
      method: "PUT",
      path: sharedMemoryPath,
      body: sharedMemoryBody
    });
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      { ...reviewedAccess, state: "approved" },
      fixedDeps("2026-07-17T02:01:00.000Z")
    );

    expect(
      resolveCollaborationActionGrantSecret(
        koedHome,
        {
          ...access,
          operationFamily: "share_grant_management",
          action: `shared_memory.change_representation.${workspaceId}.lcm_leaves`,
          teamId,
          targetId: workspaceId,
          method: "PUT",
          path: sharedMemoryPath,
          body: sharedMemoryBody,
          idempotencyKey
        },
        fixedDeps("2026-07-17T02:02:00.000Z")
      )
    ).toBe(secretSentinel);
  });
});

describe("credential store cross-process serialization", () => {
  const actionGrantInput = {
    referenceId: "77777777-7777-4777-8777-777777777777",
    backendId: "team-vps",
    deploymentBaseUrl: "https://team.example.test/koed",
    deviceCredentialId: "44444444-4444-4444-8444-444444444444",
    principalUserId: "33333333-3333-4333-8333-333333333333",
    operationFamily: "admin" as const,
    action: "team.workspace.create",
    teamId: "55555555-5555-4555-8555-555555555555",
    targetId: null,
    method: "POST" as const,
    path: "/v1/teams/55555555-5555-4555-8555-555555555555/workspaces",
    body: { name: "Concurrent Workspace" },
    idempotencyKey: "88888888-8888-4888-8888-888888888888",
    expiresAt: "2030-01-01T00:00:00.000Z"
  };
  const actionGrantAccess = {
    referenceId: actionGrantInput.referenceId,
    backendId: actionGrantInput.backendId,
    deploymentBaseUrl: actionGrantInput.deploymentBaseUrl,
    deviceCredentialId: actionGrantInput.deviceCredentialId,
    principalUserId: actionGrantInput.principalUserId
  };
  const pendingSend = {
    ownerId: "renderer:child-process",
    backendId: "team-vps",
    remotePrincipalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    deviceCredentialId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    thread: {
      scope: "team" as const,
      threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    },
    clientMessageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    body: "Child-process retry body"
  };

  it("prevents pending sends from resurrecting credentials and preserves terminal Action Grant transitions", async () => {
    const koedHome = tempHome();
    const credential = storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_concurrent",
      secret: "concurrent-secret"
    });

    const runContendedPair = async (
      prefix: string,
      heldOperation: string,
      heldInput: unknown,
      waitingOperation: string,
      waitingInput: unknown
    ): Promise<void> => {
      const ready = resolve(koedHome, `${prefix}.ready`);
      const release = resolve(koedHome, `${prefix}.release`);
      const started = resolve(koedHome, `${prefix}.started`);
      const heldChild = spawnConcurrencyChild(
        koedHome,
        heldOperation,
        heldInput,
        { ready, release }
      );
      const heldResult = waitForChild(heldChild);
      let waitingResult: ReturnType<typeof waitForChild>;
      let waitingWasBlocked: boolean;
      try {
        await waitForFile(ready);
        const waitingChild = spawnConcurrencyChild(
          koedHome,
          waitingOperation,
          waitingInput,
          { started }
        );
        waitingResult = waitForChild(waitingChild);
        await waitForFile(started);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        waitingWasBlocked = waitingChild.exitCode === null;
      } finally {
        writeFileSync(release, "release", "utf8");
      }
      const [heldOutcome, waitingOutcome] = await Promise.all([
        heldResult,
        waitingResult
      ]);
      expect(waitingWasBlocked).toBe(true);
      expect(
        heldOutcome.code,
        `${heldOutcome.stdout}\n${heldOutcome.stderr}`
      ).toBe(0);
      expect(
        waitingOutcome.code,
        `${waitingOutcome.stdout}\n${waitingOutcome.stderr}`
      ).toBe(0);
    };

    await runContendedPair(
      "pending-delete",
      "store-pending-held",
      pendingSend,
      "delete-credential",
      credential.reference
    );
    expect(
      readUpstreamCredentialAuthorization(koedHome, credential.reference)
    ).toBeNull();
    expect(listCollaborationPendingSends(koedHome)).toEqual([
      expect.objectContaining({ body: pendingSend.body })
    ]);

    storeCollaborationActionGrantCustody(koedHome, actionGrantInput);
    await runContendedPair(
      "action-transition",
      "approve-grant-held",
      {
        ...actionGrantAccess,
        state: "approved",
        approvalTier: "direct",
        review: null
      },
      "consume-grant",
      { ...actionGrantAccess, state: "consumed" }
    );
    expect(
      readCollaborationActionGrantCustodyStatus(koedHome, actionGrantAccess)
    ).toBeNull();
    const stored = JSON.parse(
      readFileSync(
        resolve(koedHome, "secrets", "upstream-credentials.json"),
        "utf8"
      )
    ) as { actionGrants: Record<string, unknown> };
    expect(stored.actionGrants[actionGrantInput.referenceId]).toBeUndefined();
  }, 30_000);
});

it("credential store concurrency child", () => {
  const operation = process.env.KOED_CREDENTIAL_STORE_CHILD_OPERATION;
  if (!operation) return;
  const koedHome = process.env.KOED_CREDENTIAL_STORE_CHILD_HOME!;
  const input = JSON.parse(
    process.env.KOED_CREDENTIAL_STORE_CHILD_INPUT ?? "null"
  ) as unknown;
  const started = process.env.KOED_CREDENTIAL_STORE_CHILD_STARTED;
  if (started) writeFileSync(started, "started", "utf8");

  const holdCommit = (): void => {
    const ready = process.env.KOED_CREDENTIAL_STORE_CHILD_READY!;
    const release = process.env.KOED_CREDENTIAL_STORE_CHILD_RELEASE!;
    writeFileSync(ready, "ready", "utf8");
    const deadline = Date.now() + 15_000;
    while (!existsSync(release)) {
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting to release held store commit.");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };

  switch (operation) {
    case "store-pending-held":
      storeCollaborationPendingSend(
        koedHome,
        input as Parameters<typeof storeCollaborationPendingSend>[1],
        {},
        { beforeStoreCommit: holdCommit }
      );
      break;
    case "delete-credential":
      expect(deleteUpstreamCredentialSecret(koedHome, input as string)).toBe(
        true
      );
      break;
    case "approve-grant-held":
      expect(
        updateCollaborationActionGrantCustodyStatus(
          koedHome,
          input as Parameters<
            typeof updateCollaborationActionGrantCustodyStatus
          >[1],
          { beforeStoreCommit: holdCommit }
        )
      ).toMatchObject({ state: "approved" });
      break;
    case "consume-grant":
      expect(
        updateCollaborationActionGrantCustodyStatus(
          koedHome,
          input as Parameters<
            typeof updateCollaborationActionGrantCustodyStatus
          >[1]
        )
      ).toMatchObject({ state: "consumed" });
      break;
    default:
      throw new Error(`Unknown child operation: ${operation}`);
  }
});
