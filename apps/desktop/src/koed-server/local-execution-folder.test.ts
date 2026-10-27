import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjectMetadata,
  ensureDeviceIdentity,
  resolveKoedServerPaths
} from "@koed-labs/server";
import { readAvailablePersonalFolders } from "@koed/shared/personal-local-folders";
import { prepareLocalExecutionFolder } from "./local-execution-folder.js";

const roots: string[] = [];
const git = (path: string, ...args: string[]) =>
  execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
const fixture = async () => {
  const parent = resolve(
    import.meta.dirname,
    "../../../../scratch/dev-vm-folder-fix/tests"
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "first-launch-"));
  roots.push(root);
  const environment = {
    NODE_ENV: "test",
    KOED_HOME: resolve(root, "profile"),
    KOED_DEVICE_PROOF_DIR: resolve(root, "profile-proof-root", "proof"),
    KOED_REPO_ROOT: root
  };
  const paths = resolveKoedServerPaths(environment);
  await ensureDeviceIdentity(paths, { environment });
  const directory = resolve(root, "checkout");
  mkdirSync(directory);
  git(directory, "init", "-q");
  git(
    directory,
    "remote",
    "add",
    "origin",
    "https://github.com/koed-labs/first-launch.git"
  );
  const metadata = (await discoverProjectMetadata(paths, { cwd: directory }))
    .project!;
  expect(metadata.repository?.kind).toBe("portable_repository");
  return { paths, environment, directory, metadata };
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("first-launch native Folder preparation", () => {
  it("registers an empty native checkout once and rejects a later replacement", async () => {
    const { paths, environment, directory, metadata } = await fixture();
    expect(readAvailablePersonalFolders(paths.koedHome, environment)).toEqual(
      []
    );
    const first = await prepareLocalExecutionFolder(
      paths,
      metadata.localProjectId,
      environment
    );
    expect(
      readAvailablePersonalFolders(paths.koedHome, environment)
    ).toMatchObject([{ identity: first.identity, normalizedPath: directory }]);
    expect(
      (
        await prepareLocalExecutionFolder(
          paths,
          metadata.localProjectId,
          environment
        )
      ).identity
    ).toEqual(first.identity);
    // Retain the original inode so a fast filesystem cannot recycle its identity.
    renameSync(directory, `${directory}-previous`);
    mkdirSync(directory);
    git(directory, "init", "-q");
    git(
      directory,
      "remote",
      "add",
      "origin",
      "https://github.com/koed-labs/first-launch.git"
    );
    await expect(
      prepareLocalExecutionFolder(paths, metadata.localProjectId, environment)
    ).rejects.toThrow("Inspect the directory");
    expect(readAvailablePersonalFolders(paths.koedHome, environment)).toEqual(
      []
    );
  });
  it("rejects changed Git context and unknown native identities without creating a Folder", async () => {
    const { paths, environment, directory, metadata } = await fixture();
    git(
      directory,
      "remote",
      "set-url",
      "origin",
      "https://github.com/koed-labs/different.git"
    );
    await expect(
      prepareLocalExecutionFolder(paths, metadata.localProjectId, environment)
    ).rejects.toThrow("checkout changed");
    await expect(
      prepareLocalExecutionFolder(paths, directory, environment)
    ).rejects.toThrow("registered native Git checkout");
    expect(existsSync(resolve(paths.configDir, "folder-contexts.json"))).toBe(
      false
    );
  });
  it("requires the current native host proof before discovery or registration", async () => {
    const { paths, environment, metadata } = await fixture();
    await expect(
      prepareLocalExecutionFolder(paths, metadata.localProjectId, {
        ...environment,
        KOED_DEVICE_PROOF_DIR: resolve(paths.koedHome, "missing-proof")
      })
    ).rejects.toThrow("device identity");
    expect(existsSync(resolve(paths.configDir, "folder-contexts.json"))).toBe(
      false
    );
  });
});
