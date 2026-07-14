import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
    expect(JSON.stringify(status)).not.toContain(rawProof);
    expect(JSON.stringify(status)).not.toContain("host-proof://");
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
    mkdirSync(resolve(clonedHome, "run"), { recursive: true });
    copyFileSync(
      resolve(source.paths.runDir, "device-identity-initialized.json"),
      resolve(clonedHome, "run", "device-identity-initialized.json")
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
        proof: "A".repeat(43)
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
    expect(result.deploymentId).not.toBe(before.deploymentId);
    expect(invalidated).toBe(true);
    expect(readFileSync(memoryMarker, "utf8")).toBe("preserved");
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

  it("fails closed for unsafe state or proof permissions and redacts diagnostics", async () => {
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
    chmodSync(proofFile, 0o644);
    const inspection = inspectDeviceIdentity({
      statePath: deviceIdentityStatePathFor(unsafeProof.paths.koedHome),
      proofStore: unsafeProof.proofStore
    });

    expect(inspection).toMatchObject({
      health: "unsafe_proof_permissions",
      remoteOperationsAllowed: false
    });
    expect(JSON.stringify(inspection)).not.toContain(rawProof);
    expect(JSON.stringify(healthy)).not.toContain("host-proof://");
  });
});
