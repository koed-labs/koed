import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
