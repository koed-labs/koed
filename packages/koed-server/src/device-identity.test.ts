import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlatformHostProofStore,
  deviceIdentityStatePathFor,
  inspectDeviceIdentity,
  parseDeviceIdentityState
} from "@koed/shared";
import { resolveKoedServerPaths } from "./paths.js";
import { collectKoedServerStatus } from "./status.js";
import {
  deviceIdentityLockTarget,
  ensureDeviceIdentity,
  rotateDeviceIdentity
} from "./device-identity.js";

const temporaryPaths: string[] = [];

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-device-identity-"));
  temporaryPaths.push(root);
  const koedHome = resolve(root, "home");
  const proofDirectory = resolve(root, "host-proof");
  const paths = resolveKoedServerPaths({
    KOED_HOME: koedHome,
    KOED_REPO_ROOT: root
  });
  return {
    paths,
    proofDirectory,
    proofStore: createPlatformHostProofStore({
      koedHome,
      environment: { KOED_DEVICE_PROOF_DIR: proofDirectory }
    })
  };
};

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const readState = (koedHome: string) =>
  parseDeviceIdentityState(
    JSON.parse(readFileSync(deviceIdentityStatePathFor(koedHome), "utf8"))
  )!;

const rawProofFrom = (value: string): string => {
  const parsed = JSON.parse(value) as { proof?: unknown };
  if (typeof parsed.proof !== "string") {
    throw new Error("Fixture proof is malformed.");
  }
  return parsed.proof;
};

describe("clone-safe device identity", () => {
  it("creates stable opaque IDs and keeps raw proof outside KOED_HOME", async () => {
    const { paths, proofStore } = fixture();
    const first = await ensureDeviceIdentity(paths, { proofStore });
    const second = await ensureDeviceIdentity(paths, { proofStore });
    const stateText = readFileSync(
      deviceIdentityStatePathFor(paths.koedHome),
      "utf8"
    );
    const state = readState(paths.koedHome);
    const storedProof = proofStore.read(state.proof.reference).value!;
    const rawProof = rawProofFrom(storedProof);

    expect(first).toMatchObject({
      health: "healthy",
      initialized: true,
      remoteOperationsAllowed: true
    });
    expect(second).toMatchObject({
      health: "healthy",
      initialized: false,
      deploymentId: first.deploymentId,
      deviceInstanceId: first.deviceInstanceId
    });
    expect(stateText).not.toContain(rawProof);
    expect(stateText).not.toContain('"proof": "');
    expect(
      inspectDeviceIdentity({
        statePath: deviceIdentityStatePathFor(paths.koedHome),
        proofStore,
        platform: "win32"
      })
    ).toMatchObject({
      health: "healthy",
      remoteOperationsAllowed: false,
      platformProtection: "limited"
    });
  });

  it("reports redacted machine-readable identity status", async () => {
    const { paths, proofDirectory, proofStore } = fixture();
    await ensureDeviceIdentity(paths, { proofStore });
    const state = readState(paths.koedHome);
    const rawProof = rawProofFrom(
      proofStore.read(state.proof.reference).value!
    );
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: paths.koedHome,
        KOED_REPO_ROOT: paths.repoRoot,
        HOME: paths.repoRoot,
        KOED_DEVICE_PROOF_DIR: proofDirectory,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () =>
          ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ checks: [] })
          }) as Response,
        spawnSync: () =>
          ({
            stdout: "",
            stderr: "",
            status: 0,
            signal: null,
            pid: 1,
            output: []
          }) as never
      }
    );

    expect(status.deviceIdentity).toMatchObject({
      health: "healthy",
      remoteOperationsAllowed: true
    });
    expect(JSON.stringify(status.deviceIdentity)).not.toContain(rawProof);
    expect(JSON.stringify(status.deviceIdentity)).not.toContain(
      "host-proof://"
    );
    expect(JSON.stringify(status.deviceIdentity)).not.toContain(
      readState(paths.koedHome).proof.fingerprint
    );
    expect(JSON.stringify(status.deviceIdentity)).not.toContain(paths.koedHome);
  });

  it("fails closed when copied KOED_HOME lacks host proof", async () => {
    const source = fixture();
    await ensureDeviceIdentity(source.paths, { proofStore: source.proofStore });
    const destinationRoot = mkdtempSync(
      resolve(tmpdir(), "koed-device-clone-")
    );
    temporaryPaths.push(destinationRoot);
    const clonedHome = resolve(destinationRoot, "home");
    mkdirSync(resolve(clonedHome, "config"), { recursive: true, mode: 0o700 });
    chmodSync(resolve(clonedHome, "config"), 0o700);
    copyFileSync(
      deviceIdentityStatePathFor(source.paths.koedHome),
      resolve(clonedHome, "config", "device-identity.json")
    );
    const paths = resolveKoedServerPaths({
      KOED_HOME: clonedHome,
      KOED_REPO_ROOT: destinationRoot
    });
    const proofStore = createPlatformHostProofStore({
      koedHome: clonedHome,
      environment: {
        KOED_DEVICE_PROOF_DIR: resolve(destinationRoot, "host-proof")
      }
    });

    await expect(
      ensureDeviceIdentity(paths, { proofStore })
    ).resolves.toMatchObject({
      health: "missing_proof",
      remoteOperationsAllowed: false
    });
  });

  it("fails closed when same-host clone retains proof but changes canonical KOED_HOME", async () => {
    const source = fixture();
    await ensureDeviceIdentity(source.paths, { proofStore: source.proofStore });
    const destinationRoot = mkdtempSync(
      resolve(tmpdir(), "koed-device-same-host-clone-")
    );
    temporaryPaths.push(destinationRoot);
    const clonedHome = resolve(destinationRoot, "home");
    mkdirSync(resolve(clonedHome, "config"), { recursive: true, mode: 0o700 });
    copyFileSync(
      deviceIdentityStatePathFor(source.paths.koedHome),
      resolve(clonedHome, "config", "device-identity.json")
    );
    const clonedPaths = resolveKoedServerPaths({
      KOED_HOME: clonedHome,
      KOED_REPO_ROOT: destinationRoot
    });
    const sameHostProofStore = createPlatformHostProofStore({
      koedHome: clonedHome,
      environment: { KOED_DEVICE_PROOF_DIR: source.proofDirectory }
    });

    await expect(
      ensureDeviceIdentity(clonedPaths, { proofStore: sameHostProofStore })
    ).resolves.toMatchObject({
      health: "proof_mismatch",
      remoteOperationsAllowed: false
    });
  });

  it("keeps durable bootstrap journal after faults and never regenerates identity", async () => {
    for (const phase of ["tombstone", "proof", "state"] as const) {
      const { paths, proofStore } = fixture();
      const failed = await ensureDeviceIdentity(paths, {
        proofStore,
        onPhase: (currentPhase) => {
          if (currentPhase === phase) throw new Error("simulated crash");
        }
      });
      const retried = await ensureDeviceIdentity(paths, { proofStore });

      expect(failed.remoteOperationsAllowed).toBe(false);
      expect(retried).toMatchObject({
        initialized: false,
        remoteOperationsAllowed: false
      });
      expect(
        readFileSync(
          resolve(paths.configDir, "device-identity-bootstrap.json"),
          "utf8"
        )
      ).toContain('"schemaVersion":1');
    }
  });

  it("does not regenerate missing or malformed state/proof", async () => {
    const { paths, proofStore } = fixture();
    await ensureDeviceIdentity(paths, { proofStore });
    const statePath = deviceIdentityStatePathFor(paths.koedHome);
    unlinkSync(statePath);
    await expect(
      ensureDeviceIdentity(paths, { proofStore })
    ).resolves.toMatchObject({
      health: "missing_state",
      initialized: false
    });

    writeFileSync(statePath, "{broken", { mode: 0o600 });
    await expect(
      ensureDeviceIdentity(paths, { proofStore })
    ).resolves.toMatchObject({
      health: "malformed_state",
      initialized: false
    });
  });

  it("rejects malformed and mismatched host proof", async () => {
    const malformed = fixture();
    await ensureDeviceIdentity(malformed.paths, {
      proofStore: malformed.proofStore
    });
    const malformedState = readState(malformed.paths.koedHome);
    malformed.proofStore.write(malformedState.proof.reference, "{broken");
    await expect(
      ensureDeviceIdentity(malformed.paths, {
        proofStore: malformed.proofStore
      })
    ).resolves.toMatchObject({ health: "malformed_proof" });

    const mismatched = fixture();
    await ensureDeviceIdentity(mismatched.paths, {
      proofStore: mismatched.proofStore
    });
    const mismatchState = readState(mismatched.paths.koedHome);
    mismatched.proofStore.write(
      mismatchState.proof.reference,
      JSON.stringify({
        schemaVersion: 1,
        deploymentId: mismatchState.deploymentId,
        deviceInstanceId: mismatchState.deviceInstanceId,
        proof: "A".repeat(43),
        homeBinding: "A".repeat(43)
      })
    );
    await expect(
      ensureDeviceIdentity(mismatched.paths, {
        proofStore: mismatched.proofStore
      })
    ).resolves.toMatchObject({ health: "proof_mismatch" });
  });

  it("rotates identity, preserves local Memory, and invalidates local references", async () => {
    const { paths, proofStore } = fixture();
    const before = await ensureDeviceIdentity(paths, { proofStore });
    mkdirSync(paths.dataDir, { recursive: true });
    const memoryMarker = resolve(paths.dataDir, "memory-marker");
    writeFileSync(memoryMarker, "preserved");
    let invalidated = false;

    const result = await rotateDeviceIdentity(paths, {
      invalidateRemoteReferences: () => {
        invalidated = true;
      },
      dependencies: { proofStore }
    });

    expect(result).toMatchObject({
      health: "healthy",
      rotated: true,
      referencesInvalidated: true,
      remoteOperationsAllowed: true
    });
    expect(result.deviceInstanceId).not.toBe(before.deviceInstanceId);
    expect(result.deploymentId).toBe(before.deploymentId);
    expect(invalidated).toBe(true);
    expect(readFileSync(memoryMarker, "utf8")).toBe("preserved");
  });

  it("keeps rotation in repair when remote revocation remains pending", async () => {
    const { paths, proofStore } = fixture();
    const before = await ensureDeviceIdentity(paths, { proofStore });

    const result = await rotateDeviceIdentity(paths, {
      invalidateRemoteReferences: () => ({ pendingRemoteRevocation: true }),
      dependencies: { proofStore }
    });

    expect(result).toMatchObject({
      health: "repair_required",
      rotated: true,
      referencesInvalidated: false,
      remoteOperationsAllowed: false,
      pendingRemoteRevocation: true,
      deploymentId: before.deploymentId
    });
  });

  it("serializes concurrent initialization and reclaims a stale lock", async () => {
    const { paths, proofDirectory, proofStore } = fixture();
    mkdirSync(`${deviceIdentityLockTarget(paths)}.lock`, { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    utimesSync(`${deviceIdentityLockTarget(paths)}.lock`, stale, stale);

    const identities = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureDeviceIdentity(paths, { proofStore })
      )
    );

    expect(
      new Set(identities.map((identity) => identity.deviceInstanceId)).size
    ).toBe(1);
    expect(readdirSync(paths.runDir)).not.toContain("device-identity.lock");
    expect(readdirSync(proofDirectory)).toHaveLength(1);
  });

  it("fails closed for symlinked or unsafe proof ancestors and redacts diagnostics", async () => {
    const unsafeState = fixture();
    await ensureDeviceIdentity(unsafeState.paths, {
      proofStore: unsafeState.proofStore
    });
    chmodSync(deviceIdentityStatePathFor(unsafeState.paths.koedHome), 0o644);
    await expect(
      ensureDeviceIdentity(unsafeState.paths, {
        proofStore: unsafeState.proofStore
      })
    ).resolves.toMatchObject({ health: "unsafe_state_permissions" });

    const unsafeProof = fixture();
    const healthy = await ensureDeviceIdentity(unsafeProof.paths, {
      proofStore: unsafeProof.proofStore
    });
    const proofFile = resolve(
      unsafeProof.proofDirectory,
      readdirSync(unsafeProof.proofDirectory)[0]!
    );
    const rawProof = rawProofFrom(readFileSync(proofFile, "utf8"));
    const replacement = resolve(
      unsafeProof.paths.repoRoot,
      "replacement-proof"
    );
    writeFileSync(replacement, readFileSync(proofFile, "utf8"), {
      mode: 0o600
    });
    unlinkSync(proofFile);
    symlinkSync(replacement, proofFile);
    const symlinkInspection = inspectDeviceIdentity({
      statePath: deviceIdentityStatePathFor(unsafeProof.paths.koedHome),
      proofStore: unsafeProof.proofStore
    });

    expect(symlinkInspection).toMatchObject({
      health: "unsafe_proof_permissions",
      remoteOperationsAllowed: false
    });
    expect(JSON.stringify(symlinkInspection)).not.toContain(rawProof);
    expect(JSON.stringify(healthy)).not.toContain("host-proof://");

    const symlinkedHome = fixture();
    await ensureDeviceIdentity(symlinkedHome.paths, {
      proofStore: symlinkedHome.proofStore
    });
    const linkedHome = resolve(symlinkedHome.paths.repoRoot, "linked-home");
    symlinkSync(symlinkedHome.paths.koedHome, linkedHome);
    const linkedPaths = resolveKoedServerPaths({
      KOED_HOME: linkedHome,
      KOED_REPO_ROOT: symlinkedHome.paths.repoRoot
    });
    await expect(
      ensureDeviceIdentity(linkedPaths, {
        proofStore: createPlatformHostProofStore({
          koedHome: linkedHome,
          environment: { KOED_DEVICE_PROOF_DIR: symlinkedHome.proofDirectory }
        })
      })
    ).resolves.toMatchObject({ health: "unsafe_state_permissions" });

    const unsafeAncestor = fixture();
    await ensureDeviceIdentity(unsafeAncestor.paths, {
      proofStore: unsafeAncestor.proofStore
    });
    chmodSync(unsafeAncestor.paths.repoRoot, 0o755);
    await expect(
      ensureDeviceIdentity(unsafeAncestor.paths, {
        proofStore: unsafeAncestor.proofStore
      })
    ).resolves.toMatchObject({ health: "unsafe_proof_permissions" });
  });
});
