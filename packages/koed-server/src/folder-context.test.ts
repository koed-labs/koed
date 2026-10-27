import {
  readAvailablePersonalFolders,
  readPersonalFolderDirectoryMarker,
  personalFolderRegistrySchema
} from "@koed/shared/personal-local-folders";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeRecordedProjectDirectory,
  personalFolderObservationSchema
} from "@koed/shared";
import {
  ensureDeviceIdentity,
  rotateDeviceIdentity
} from "./device-identity.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  observeCaptureFolder,
  pinSourceFolderObservation,
  readSourceFolderObservation,
  readCurrentSourceFolderObservation
} from "./folder-context.js";

const temporary: string[] = [];
const fixture = async () => {
  const parent = resolve(import.meta.dirname, "../../../scratch/p1-06/local");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "folders-"));
  temporary.push(root);
  const env = {
    NODE_ENV: "test",
    KOED_HOME: resolve(root, "profile"),
    KOED_REPO_ROOT: root
  };
  const paths = resolveKoedServerPaths(env);
  await ensureDeviceIdentity(paths, { environment: env });
  return { root, env, paths };
};
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("source-time exact Folder identity", () => {
  it.runIf(process.platform === "darwin")(
    "adopts an existing registration after a macOS mount-number change without replacing its identity",
    async () => {
      const { root, env, paths } = await fixture();
      const directory = resolve(root, "remounted");
      mkdirSync(directory);
      const first = (await observeCaptureFolder(paths, directory, env))!;
      const current = readPersonalFolderDirectoryMarker(directory)!;
      expect(current.marker).toMatch(/^\["volume:/);
      const registryPath = resolve(paths.configDir, "folder-contexts.json");
      const registry = personalFolderRegistrySchema.parse(
        JSON.parse(readFileSync(registryPath, "utf8"))
      );
      const numeric = JSON.parse(current.deviceMarker) as [
        string,
        string,
        string
      ];
      numeric[0] = (BigInt(numeric[0]) + 2n).toString();
      registry.directories[0]!.marker = JSON.stringify(numeric);
      writeFileSync(registryPath, JSON.stringify(registry));
      const before = readFileSync(registryPath, "utf8");
      const environment = {
        ...env,
        KOED_DEVICE_PROOF_DIR: resolve(`${paths.koedHome}-proof-root`, "proof")
      };
      expect(
        readAvailablePersonalFolders(paths.koedHome, environment)
      ).toMatchObject([{ identity: first.identity }]);
      expect(readFileSync(registryPath, "utf8")).toBe(before);
      expect(
        (await observeCaptureFolder(paths, directory, env))!.identity
      ).toEqual(first.identity);
      const updated = personalFolderRegistrySchema.parse(
        JSON.parse(readFileSync(registryPath, "utf8"))
      );
      expect(updated.directories).toHaveLength(1);
      expect(updated.directories[0]!.marker).toBe(current.marker);
      expect(
        readAvailablePersonalFolders(paths.koedHome, environment)
      ).toMatchObject([{ identity: first.identity }]);
      rmSync(directory, { recursive: true });
      mkdirSync(directory);
      expect(readAvailablePersonalFolders(paths.koedHome, environment)).toEqual(
        []
      );
      expect(
        (await observeCaptureFolder(paths, directory, env))!.identity.folderId
      ).not.toBe(first.identity.folderId);
    }
  );
  it("distinguishes exact directories, replacement incarnations, profiles and devices", async () => {
    const { root, env, paths } = await fixture();
    const directory = resolve(root, "checkout"),
      child = resolve(directory, "child");
    mkdirSync(child, { recursive: true });
    const first = await observeCaptureFolder(paths, directory, env);
    expect(first).toBeDefined();
    const normalized = await observeCaptureFolder(
      paths,
      `${directory}/child/..`,
      env
    );
    expect(normalized?.identity).toEqual(first!.identity);
    expect(normalized?.capturedPath).toBe(`${directory}/child/..`);
    expect(
      (await observeCaptureFolder(paths, child, env))?.identity.folderId
    ).not.toBe(first!.identity.folderId);
    rmSync(directory, { recursive: true });
    mkdirSync(directory);
    const replacement = await observeCaptureFolder(paths, directory, env);
    expect(replacement!.identity.directoryIncarnationId).not.toBe(
      first!.identity.directoryIncarnationId
    );
    expect(replacement!.identity.folderId).not.toBe(first!.identity.folderId);
    expect(
      (await observeCaptureFolder(resolveKoedServerPaths(env), directory, env))
        ?.identity
    ).toEqual(replacement!.identity);
    await rotateDeviceIdentity(paths, {
      dependencies: { environment: env },
      invalidateRemoteReferences: () => undefined
    });
    const rotated = await observeCaptureFolder(paths, directory, env);
    expect(rotated!.identity.originatingDeviceId).not.toBe(
      replacement!.identity.originatingDeviceId
    );
    expect(rotated!.identity.folderId).not.toBe(replacement!.identity.folderId);
    const secondEnv = { ...env, KOED_HOME: resolve(root, "second-profile") };
    const secondPaths = resolveKoedServerPaths(secondEnv);
    await ensureDeviceIdentity(secondPaths, { environment: secondEnv });
    const second = await observeCaptureFolder(
      secondPaths,
      directory,
      secondEnv
    );
    expect(second!.identity.originatingProfileId).not.toBe(
      rotated!.identity.originatingProfileId
    );
    expect(
      await observeCaptureFolder(paths, resolve(root, "missing"), env)
    ).toBeUndefined();
    expect(await observeCaptureFolder(paths, "relative", env)).toBeUndefined();
  });

  it("retains known and unresolved originals across later observations and import without filesystem repair", async () => {
    const { root, env, paths } = await fixture();
    const a = resolve(root, "a"),
      b = resolve(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const first = (await observeCaptureFolder(paths, a, env))!;
    const later = (await observeCaptureFolder(paths, b, env))!;
    const key = {
      sourceKind: "codex" as const,
      externalSessionId: "native-conversation"
    };
    pinSourceFolderObservation(paths, key, first, true);
    pinSourceFolderObservation(paths, key, later, false);
    expect(readSourceFolderObservation(paths, key)).toEqual(first);
    expect(readCurrentSourceFolderObservation(paths, key)).toEqual(later);
    const old = { ...key, externalSessionId: "uncaptured-history" };
    pinSourceFolderObservation(paths, old, first, false);
    pinSourceFolderObservation(paths, old, later, true);
    expect(readSourceFolderObservation(paths, old)).toBeUndefined();
    expect(readCurrentSourceFolderObservation(paths, old)).toEqual(later);
    rmSync(a, { recursive: true });
    rmSync(b, { recursive: true });
    expect(
      readSourceFolderObservation(resolveKoedServerPaths(env), key)
    ).toEqual(first);
    expect(
      readSourceFolderObservation(paths, { ...key, sourceKind: "claude-code" })
    ).toBeUndefined();
  });

  it("lists only live host-bound execution Folders without changing recorded identity", async () => {
    const { root, env, paths } = await fixture();
    const directory = resolve(root, "execution");
    mkdirSync(directory);
    const first = (await observeCaptureFolder(paths, directory, env))!;
    const environment = {
      ...env,
      KOED_DEVICE_PROOF_DIR: resolve(`${paths.koedHome}-proof-root`, "proof")
    };
    const registry = resolve(paths.koedHome, "config", "folder-contexts.json");
    const before = readFileSync(registry, "utf8");
    expect(
      readAvailablePersonalFolders(paths.koedHome, environment)
    ).toMatchObject([
      { identity: first.identity, normalizedPath: first.normalizedPath }
    ]);
    expect(readFileSync(registry, "utf8")).toBe(before);
    rmSync(directory, { recursive: true });
    mkdirSync(directory);
    expect(readAvailablePersonalFolders(paths.koedHome, environment)).toEqual(
      []
    );
    await observeCaptureFolder(paths, directory, env);
    expect(
      readAvailablePersonalFolders(paths.koedHome, environment)
    ).toHaveLength(1);
    await rotateDeviceIdentity(paths, {
      dependencies: { environment: env },
      invalidateRemoteReferences: () => undefined
    });
    expect(readAvailablePersonalFolders(paths.koedHome, environment)).toEqual(
      []
    );
  });

  it("normalizes recorded POSIX and Windows evidence without the importing worker's cwd", () => {
    expect(normalizeRecordedProjectDirectory("/repo/sub/../folder//")).toBe(
      "/repo/folder"
    );
    expect(
      normalizeRecordedProjectDirectory("C:\\repo\\sub\\..\\folder\\")
    ).toBe("C:\\repo\\folder");
    expect(
      normalizeRecordedProjectDirectory("\\\\host\\share\\repo\\..\\folder")
    ).toBe("\\\\host\\share\\folder");
    expect(normalizeRecordedProjectDirectory("repo/sub")).toBeNull();
    expect(normalizeRecordedProjectDirectory("C:repo")).toBeNull();
    expect(normalizeRecordedProjectDirectory("/repo\0/sub")).toBeNull();
    expect(
      personalFolderObservationSchema.safeParse({
        identity: {
          folderId: "a",
          originatingDeploymentId: "b",
          originatingDeviceId: "c",
          originatingProfileId: "d",
          directoryIncarnationId: "e"
        },
        capturedPath: "/repo/sub",
        normalizedPath: "/repo",
        observedAt: new Date().toISOString()
      }).success
    ).toBe(false);
  });
});
