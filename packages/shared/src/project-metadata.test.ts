import { describe, expect, it } from "vitest";
import {
  deriveLocalProjectId,
  normalizeGitRemoteUrl,
  safeProjectMetadataForRemote,
  type ProjectMetadataV1
} from "./project-metadata.js";

describe("Project metadata helpers", () => {
  it("normalizes HTTPS Git remotes without credentials, query, or fragment", () => {
    const remote = normalizeGitRemoteUrl(
      "https://token:secret@github.com/koed-labs/koed.git?x=1#main",
      "origin"
    );

    expect(remote).toMatchObject({
      name: "origin",
      host: "github.com",
      namespace: "koed-labs",
      repo: "koed",
      display: "github.com/koed-labs/koed"
    });
    expect(remote.fingerprint).toMatch(/^gr_/);
    expect(JSON.stringify(remote)).not.toMatch(/token|secret|x=1|#main/);
  });

  it("normalizes SSH scp-style Git remotes", () => {
    expect(
      normalizeGitRemoteUrl("git@github.com:koed-labs/koed.git")
    ).toMatchObject({
      host: "github.com",
      namespace: "koed-labs",
      repo: "koed",
      display: "github.com/koed-labs/koed"
    });
  });

  it("uses protocol-independent remote fingerprints as matching signals", () => {
    const ssh = normalizeGitRemoteUrl("git@github.com:koed-labs/koed.git");
    const https = normalizeGitRemoteUrl("https://github.com/koed-labs/koed");
    const upstream = normalizeGitRemoteUrl("https://github.com/upstream/koed");

    expect(ssh.fingerprint).toBe(https.fingerprint);
    expect([ssh.fingerprint]).toContain(https.fingerprint);
    expect([ssh.fingerprint, upstream.fingerprint]).toContain(
      https.fingerprint
    );
  });

  it("keeps local file remotes opaque", () => {
    const remote = normalizeGitRemoteUrl(
      "file:///Users/alice/private/repo.git"
    );

    expect(remote).toMatchObject({
      host: null,
      namespace: null,
      repo: null,
      display: null
    });
    expect(JSON.stringify(remote)).not.toContain("/Users/alice/private");
  });

  it("retains full remote namespaces to avoid false matches", () => {
    const companyA = normalizeGitRemoteUrl(
      "git@gitlab.example.com:company-a/platform/koed.git"
    );
    const companyB = normalizeGitRemoteUrl(
      "git@gitlab.example.com:company-b/platform/koed.git"
    );

    expect(companyA).toMatchObject({
      namespace: "company-a/platform",
      display: "gitlab.example.com/company-a/platform/koed"
    });
    expect(companyB).toMatchObject({
      namespace: "company-b/platform",
      display: "gitlab.example.com/company-b/platform/koed"
    });
    expect(companyA.fingerprint).not.toBe(companyB.fingerprint);
  });

  it("keeps local Project ids salted and path-specific", () => {
    expect(
      deriveLocalProjectId({
        salt: "device-a",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed"
      })
    ).toBe(
      deriveLocalProjectId({
        salt: "device-a",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed/packages/api"
      })
    );
    expect(
      deriveLocalProjectId({
        salt: "device-a",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed"
      })
    ).not.toBe(
      deriveLocalProjectId({
        salt: "device-b",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed"
      })
    );
  });

  it("keeps worktrees as separate local Projects", () => {
    const mainCheckout = deriveLocalProjectId({
      salt: "device-a",
      projectRoot: "/repo/koed",
      cwd: "/repo/koed"
    });
    const linkedWorktree = deriveLocalProjectId({
      salt: "device-a",
      projectRoot: "/worktrees/koed-feature",
      cwd: "/worktrees/koed-feature"
    });

    expect(mainCheckout).not.toBe(linkedWorktree);
  });

  it("returns remote-safe metadata without raw local paths", () => {
    const localRemote = normalizeGitRemoteUrl(
      "file:///Users/jedd/private/koed.git"
    );
    const metadata: ProjectMetadataV1 = {
      schemaVersion: 1,
      discoveredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      localProjectId: "lp_local",
      displayName: "koed",
      path: {
        cwd: "/Users/jedd/agents/koed",
        projectRoot: "/Users/jedd/agents/koed",
        basename: "koed",
        localPathHash: "hmac_sha256:abc"
      },
      git: {
        rootHash: "hmac_sha256:root",
        remotes: [localRemote],
        branch: "main",
        headCommit: "abcdef",
        isWorktree: false,
        worktreeHash: null
      },
      packages: []
    };

    const serialized = JSON.stringify(safeProjectMetadataForRemote(metadata));
    expect(serialized).not.toContain("/Users/jedd/agents/koed");
    expect(serialized).not.toContain("/Users/jedd/private");
    expect(serialized).not.toContain(localRemote.fingerprint);
  });
});
