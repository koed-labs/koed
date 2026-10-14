import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeGitRemoteUrl, repositoryIdentitySchema } from "@koed/shared";
import { resolveRepositoryIdentity } from "./repository-identity.js";
import {
  discoverProjectMetadata,
  setProjectRepositoryAnchor
} from "./project-metadata.js";
import type { GitProjectProbeResult } from "./git-project-probe.js";
import type { KoedServerPaths } from "./paths.js";

const observation = (
  remotes: Array<[string, string]> = []
): GitProjectProbeResult => ({
  status: "git",
  failedCommands: [],
  root: "/checkout",
  branch: "main",
  headCommit: "abc",
  commonDir: "/checkout/.git",
  gitDir: "/checkout/.git",
  remotes: remotes.map(([name, url]) => normalizeGitRemoteUrl(url, name))
});
const resolve = (
  remotes: Array<[string, string]>,
  extra: Partial<Parameters<typeof resolveRepositoryIdentity>[0]> = {}
) => {
  const result = resolveRepositoryIdentity({
    observation: observation(remotes),
    cwd: "/checkout",
    deviceSalt: "device-one",
    checkoutId: "checkout_one",
    commonDirMarker: "common-one",
    ...extra
  });
  repositoryIdentitySchema.parse(result);
  return result;
};
const a = "https://github.com/example/a.git";
const b = "git@github.com:example/b.git";

describe("selected repository identity", () => {
  it("keeps A/B/C separate despite extra remotes and ignores remote names in matching", () => {
    const repoA = resolve([["origin", a]]);
    const repoB = resolve([
      ["origin", a],
      ["extra", b]
    ]);
    const repoC = resolve([["origin", b]]);
    expect(repoA.key).toBe(repoB.key);
    expect(repoC.key).not.toBe(repoB.key);
    expect(resolve([["custom", a]], { localSelection: "custom" }).key).toBe(
      repoA.key
    );
    expect(resolve([["custom", a]]).kind).toBe("device_local_repository");
  });
  it("normalizes equivalent SSH and HTTPS anchors and duplicate URLs", () => {
    const urls = [
      a,
      "git@github.com:example/a.git",
      "ssh://git@github.com:22/example/a.git",
      "https://token:secret@github.com/example/a.git"
    ];
    expect(
      new Set(urls.map((url) => resolve([["origin", url]]).key)).size
    ).toBe(1);
    expect(resolve(urls.map((url) => ["origin", url]))).toMatchObject({
      kind: "portable_repository",
      reason: "origin"
    });
  });
  it("groups forks only when they select the same anchor", () => {
    const parent = resolve([["origin", a]]);
    expect(
      resolve([
        ["origin", b],
        ["upstream", a]
      ]).key
    ).toBe(parent.key);
    expect(resolve([["origin", b]]).key).not.toBe(parent.key);
    expect(
      resolve(
        [
          ["origin", b],
          ["upstream", a]
        ],
        { localSelection: "origin" }
      ).key
    ).not.toBe(parent.key);
  });
  it("applies local, associated replicated, upstream, origin, then device-local selection", () => {
    const associatedSelection = {
      associationId: "accepted-association",
      selection: {
        state: "selected" as const,
        anchorFingerprint: normalizeGitRemoteUrl(b).fingerprint
      }
    };
    const remotes: Array<[string, string]> = [
      ["upstream", a],
      ["origin", b]
    ];
    expect(resolve(remotes, { associatedSelection }).reason).toBe(
      "replicated_selection"
    );
    expect(
      resolve(remotes, { associatedSelection, localSelection: "upstream" })
        .reason
    ).toBe("local_selection");
    expect(resolve(remotes).reason).toBe("upstream");
    expect(resolve([["origin", b]]).reason).toBe("origin");
    expect(resolve([]).reason).toBe("local_fallback");
    expect(resolve([], { deviceSalt: "another-device" }).key).not.toBe(
      resolve([]).key
    );
    expect(resolve([], { commonDirMarker: "new-repository" }).key).not.toBe(
      resolve([]).key
    );
  });
  it("leaves invalid selections and conflicting URLs unresolved without fallback", () => {
    expect(
      resolve([["origin", a]], { localSelection: "missing" })
    ).toMatchObject({
      kind: "unresolved",
      reason: "selection_missing",
      key: null
    });
    expect(
      resolve([
        ["origin", a],
        ["origin", b]
      ])
    ).toMatchObject({ kind: "unresolved", reason: "selection_conflict" });
    expect(
      resolve([
        ["upstream", a],
        ["upstream", b],
        ["origin", a]
      ]).kind
    ).toBe("unresolved");
    expect(
      resolve(
        [
          ["local", "/local/repo"],
          ["origin", a]
        ],
        { localSelection: "local" }
      ).reason
    ).toBe("selection_not_portable");
    expect(
      resolve([["origin", a]], {
        associatedSelection: {
          associationId: "accepted",
          selection: { state: "conflict" }
        }
      }).reason
    ).toBe("selection_conflict");
    expect(
      resolve([["origin", a]], {
        associatedSelection: {
          associationId: "accepted",
          selection: {
            state: "selected",
            anchorFingerprint: normalizeGitRemoteUrl(b).fingerprint
          }
        }
      }).reason
    ).toBe("replicated_anchor_missing");
  });
  it("keeps non-Git Projects device-local and distinguishes unavailable metadata", () => {
    const nonGit = {
      ...observation(),
      status: "non_git" as const,
      root: null,
      commonDir: null,
      gitDir: null
    };
    expect(resolve([], { observation: nonGit }).kind).toBe("non_git_project");
    expect(
      resolve([], { observation: nonGit, deviceSalt: "another" }).key
    ).not.toBe(resolve([], { observation: nonGit }).key);
    expect(
      resolve([], {
        observation: {
          ...observation(),
          status: "failed",
          failedCommands: ["remote -v"]
        }
      }).reason
    ).toBe("probe_failed");
    expect(
      resolve([], { observation: { ...observation(), status: "ambiguous" } })
        .reason
    ).toBe("probe_ambiguous");
    expect(resolve([["origin", a]], { checkoutId: null }).reason).toBe(
      "checkout_unavailable"
    );
    expect(
      resolve([["origin", a]], {
        observation: {
          ...observation([["origin", a]]),
          status: "failed",
          failedCommands: ["rev-parse HEAD"],
          headCommit: null
        }
      }).kind
    ).toBe("portable_repository");
  });

  it("persists edits and checkout provenance without inheriting them at reused paths", async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "koed-anchor-"))
    );
    try {
      const cwd = path.join(directory, "checkout");
      fs.mkdirSync(cwd);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      git("init", "--initial-branch=main");
      git("remote", "add", "origin", a);
      git("remote", "add", "custom", b);
      const paths = {
        projectMetadataPath: path.join(directory, "config", "projects.json")
      } as KoedServerPaths;
      const first = (await discoverProjectMetadata(paths, { cwd })).project!;
      const edited = (
        await setProjectRepositoryAnchor(paths, {
          localProjectId: first.localProjectId,
          expectedCheckoutId: first.repository!.checkoutId!,
          remoteName: "custom"
        })
      ).project!;
      expect(edited.repository).toMatchObject({
        reason: "local_selection",
        key: normalizeGitRemoteUrl(b).fingerprint
      });
      expect(
        (await discoverProjectMetadata(paths, { cwd })).project?.repository
      ).toEqual(edited.repository);
      const reset = await setProjectRepositoryAnchor(paths, {
        localProjectId: first.localProjectId,
        expectedCheckoutId: first.repository!.checkoutId!,
        remoteName: null
      });
      expect(reset.project?.repository?.key).toBe(first.repository?.key);
      // Retain the old directory, guaranteeing a distinct filesystem identity.
      fs.renameSync(path.join(cwd, ".git"), path.join(directory, "old-git"));
      git("init", "--initial-branch=replacement");
      git("remote", "add", "origin", a);
      const replacement = (await discoverProjectMetadata(paths, { cwd }))
        .project!;
      expect(replacement.repository?.checkoutId).not.toBe(
        first.repository?.checkoutId
      );
      expect(replacement.repository?.reason).toBe("origin");
      await expect(
        setProjectRepositoryAnchor(paths, {
          localProjectId: first.localProjectId,
          expectedCheckoutId: first.repository!.checkoutId!,
          remoteName: "origin"
        })
      ).rejects.toThrow("Checkout changed");
      const stored = JSON.parse(
        fs.readFileSync(paths.projectMetadataPath, "utf8")
      ) as { checkouts: unknown[] };
      expect(stored.checkouts).toHaveLength(2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
