import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  normalizeGitRemoteUrl,
  type AssociatedRepositorySelection
} from "@koed/shared";
import {
  discoverProjectMetadata,
  setProjectAssociationLookup,
  setProjectRepositoryAnchor,
  refreshProjectAssociations,
  listProjectMetadata
} from "./project-metadata.js";
import { resolveKoedServerPaths } from "./paths.js";

it("applies only accepted current selections and preserves local precedence, deletion, and checkout incarnation", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(scratch, "associated-discovery-"))
  );
  try {
    const cwd = path.join(directory, "checkout");
    fs.mkdirSync(cwd);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    const origin = "https://example.test/team/origin.git";
    const comparison = "https://example.test/team/comparison.git";
    git("init", "--initial-branch=main");
    git("remote", "add", "origin", origin);
    git("remote", "add", "comparison", comparison);
    const paths = resolveKoedServerPaths({
      KOED_HOME: path.join(directory, "profile")
    });
    let shared: AssociatedRepositorySelection | undefined = {
      associationId: "accepted",
      selection: {
        state: "selected",
        anchorFingerprint: normalizeGitRemoteUrl(comparison).fingerprint
      }
    };
    const lookup = vi.fn(async () => shared);
    const deps = { lookupAssociatedSelection: lookup };
    const discover = async () =>
      (await discoverProjectMetadata(paths, { cwd }, deps)).project!;
    const initial = await discover();
    expect(initial.repository?.key).toBe(
      normalizeGitRemoteUrl(origin).fingerprint
    );
    expect(lookup).not.toHaveBeenCalled(); // A comparison remote alone cannot establish association.
    const marker = {
      localProjectId: initial.localProjectId,
      expectedCheckoutId: initial.repository!.checkoutId!
    };
    await setProjectAssociationLookup(
      paths,
      { ...marker, enabled: true },
      deps
    );
    expect((await discover()).repository).toMatchObject({
      key: normalizeGitRemoteUrl(comparison).fingerprint,
      reason: "replicated_selection"
    });
    git("remote", "rename", "comparison", "renamed");
    git("remote", "add", "duplicate", comparison);
    expect((await discover()).repository?.key).toBe(
      normalizeGitRemoteUrl(comparison).fingerprint
    );
    await setProjectRepositoryAnchor(
      paths,
      { ...marker, remoteName: "origin" },
      deps
    );
    shared = { associationId: "accepted", selection: { state: "conflict" } };
    lookup.mockRejectedValueOnce(new Error("offline"));
    expect((await discover()).repository).toMatchObject({
      reason: "local_selection",
      key: normalizeGitRemoteUrl(origin).fingerprint
    });
    lookup.mockReset().mockImplementation(async () => shared);
    await setProjectRepositoryAnchor(
      paths,
      { ...marker, remoteName: null },
      deps
    );
    expect((await discover()).repository).toMatchObject({
      kind: "unresolved",
      reason: "selection_conflict"
    });
    shared = undefined; // Retained shared deletion resumes normal detection.
    await refreshProjectAssociations(paths, deps);
    expect(
      listProjectMetadata(paths).projects?.find(
        (entry) => entry.localProjectId === initial.localProjectId
      )?.repository
    ).toMatchObject({
      reason: "origin",
      key: normalizeGitRemoteUrl(origin).fingerprint
    });
    lookup.mockRejectedValueOnce(new Error("lookup unavailable"));
    await expect(discover()).rejects.toThrow("lookup unavailable");
    shared = {
      associationId: "accepted",
      selection: {
        state: "selected",
        anchorFingerprint: normalizeGitRemoteUrl(comparison).fingerprint
      }
    };
    git("remote", "remove", "duplicate");
    git("remote", "remove", "renamed");
    expect((await discover()).repository).toMatchObject({
      kind: "unresolved",
      reason: "replicated_anchor_missing"
    });
    fs.renameSync(path.join(cwd, ".git"), path.join(directory, "old-git"));
    git("init", "--initial-branch=replacement");
    git("remote", "add", "origin", origin);
    lookup.mockClear();
    const replacement = await discover();
    expect(replacement.repository?.checkoutId).not.toBe(
      marker.expectedCheckoutId
    );
    expect(replacement.repository?.reason).toBe("origin");
    expect(lookup).not.toHaveBeenCalled();
    await expect(
      setProjectAssociationLookup(paths, { ...marker, enabled: true }, deps)
    ).rejects.toThrow("Checkout changed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
