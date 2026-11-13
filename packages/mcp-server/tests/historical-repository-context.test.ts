import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeGitRemoteUrl,
  repositoryIdentitySchema
} from "@koed-labs/shared";
import {
  pinSourceFolderObservation,
  resolveKoedServerPaths
} from "@koed-labs/server";
import {
  resolveHistoricalCaptureRepositoryIdentity,
  codexSourceTimeRepositoryIdentity,
  codexSourceTimeProjectDirectory,
  unresolvedHistoricalRepositoryIdentity
} from "../src/historical-repository-context.js";
import { extractTranscriptSessionMetadata } from "../src/codex-transcript-parser.js";

const directories: string[] = [];
const fixture = () => {
  const parent = path.resolve("scratch/historical-project-imports");
  fs.mkdirSync(parent, { recursive: true });
  vi.stubEnv("GIT_CEILING_DIRECTORIES", parent);
  const directory = fs.mkdtempSync(path.join(parent, "context-"));
  directories.push(directory);
  return { directory, env: { KOED_HOME: path.join(directory, "koed") } };
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const metadata = (git: unknown, extra = {}) => ({
  type: "session_meta",
  payload: {
    id: "original-session",
    cwd: "/source-time/checkout",
    timestamp: "2025-01-01T00:00:00Z",
    git,
    ...extra
  }
});

it("uses recorded Git metadata without inheriting a current checkout or device", () => {
  const url = "https://example.test/team/original.git";
  expect(
    codexSourceTimeRepositoryIdentity([
      metadata({ repository_url: url, branch: "main" })
    ])
  ).toMatchObject({
    kind: "portable_repository",
    key: normalizeGitRemoteUrl(url).fingerprint,
    root: null,
    checkoutId: null,
    branch: "main",
    originatingDeviceId: "historical_unknown_device"
  });
  expect(
    JSON.stringify(
      codexSourceTimeRepositoryIdentity([
        metadata({
          repository_url:
            "https://user:private-password@example.test/team/original.git"
        })
      ])
    )
  ).not.toContain("private-password");
});

it("preserves a recorded Git identity when its folder is missing or reused", async () => {
  const { directory, env } = fixture();
  const cwd = path.join(directory, "checkout");
  const sourceTime = codexSourceTimeRepositoryIdentity([
    metadata(
      { repository_url: "https://example.test/team/original.git" },
      { cwd }
    )
  ]);
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({ sourceTime, cwd, env })
  ).toEqual(sourceTime);
  fs.mkdirSync(cwd);
  execFileSync("git", ["-C", cwd, "init"], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "remote",
      "add",
      "origin",
      "https://example.test/team/reused.git"
    ],
    { stdio: "pipe" }
  );
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({ sourceTime, cwd, env })
  ).toEqual(sourceTime);
  expect(fs.existsSync(env.KOED_HOME)).toBe(false);
});

it("keeps missing source-time repository association uncertain across folder/profile changes", async () => {
  const { directory, env } = fixture();
  const cwd = path.join(directory, "missing-checkout");
  const first = await resolveHistoricalCaptureRepositoryIdentity({
    sourceTime: null,
    cwd,
    env
  });
  expect(repositoryIdentitySchema.parse(first)).toMatchObject({
    kind: "unresolved",
    root: null,
    branch: null,
    checkoutId: null,
    reason: "probe_ambiguous"
  });
  expect(first.key).toBeNull();
  expect(first.originatingDeviceId).toBe("historical_unknown_device");
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({
      sourceTime: null,
      cwd: `${cwd}/./`,
      env
    })
  ).toEqual(first);
  fs.mkdirSync(cwd);
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({
      sourceTime: null,
      cwd,
      env
    })
  ).toEqual(first);
  const otherFolder = await resolveHistoricalCaptureRepositoryIdentity({
    sourceTime: null,
    cwd: path.join(directory, "other"),
    env
  });
  expect(otherFolder).toEqual(first);
  const otherProfile = await resolveHistoricalCaptureRepositoryIdentity({
    sourceTime: null,
    cwd,
    env: { KOED_HOME: path.join(directory, "other-profile") }
  });
  expect(otherProfile).toEqual(first);
});

it.each([false, true])(
  "keeps unassociated history uncertain despite current Git at the path (upstream: %s)",
  async (upstream) => {
    const { directory, env } = fixture();
    const root = path.join(directory, "repository");
    const cwd = path.join(root, "package");
    fs.mkdirSync(cwd, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init");
    git("remote", "add", "origin", "https://example.test/team/origin.git");
    if (upstream)
      git(
        "remote",
        "add",
        "upstream",
        "https://example.test/team/upstream.git"
      );
    const identity = await resolveHistoricalCaptureRepositoryIdentity({
      sourceTime: null,
      cwd,
      env
    });
    expect(identity).toEqual(unresolvedHistoricalRepositoryIdentity());
    git("remote", "set-url", "origin", "https://example.test/replacement.git");
    expect(
      await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime: null,
        cwd,
        env
      })
    ).toEqual(identity);
  }
);

it("keeps missing historical evidence uncertain independently of current Git conflicts", async () => {
  const { directory, env } = fixture();
  const cwd = path.join(directory, "repository");
  fs.mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  git("init");
  git("remote", "add", "origin", "https://example.test/team/one.git");
  git(
    "remote",
    "set-url",
    "--add",
    "origin",
    "https://example.test/team/two.git"
  );
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({
      sourceTime: null,
      cwd,
      env
    })
  ).toMatchObject({
    kind: "unresolved",
    key: null,
    reason: "probe_ambiguous",
    branch: null
  });
});

it("does not claim a source-time local Git identity from a later checkout", async () => {
  const { directory, env } = fixture();
  const cwd = path.join(directory, "local-repository");
  fs.mkdirSync(cwd);
  execFileSync("git", ["-C", cwd, "init"], { stdio: "pipe" });
  const identity = await resolveHistoricalCaptureRepositoryIdentity({
    sourceTime: null,
    cwd,
    env
  });
  expect(identity).toMatchObject({
    kind: "unresolved",
    root: null,
    branch: null
  });
  expect(identity.key).toBeNull();
});

it("keeps missing, relative and malformed folders unresolved without a process cwd fallback", async () => {
  const { env } = fixture();
  for (const cwd of [
    undefined,
    "",
    "relative/folder",
    "C:relative",
    "\\relative",
    "/folder\0invalid",
    "/" + "a".repeat(8192)
  ]) {
    expect(
      await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime: null,
        cwd,
        env
      })
    ).toEqual(unresolvedHistoricalRepositoryIdentity());
  }
  expect(fs.existsSync(env.KOED_HOME)).toBe(false);
});

it.each(["C:\\recorded\\folder\\", "\\\\server\\share\\folder\\", "C:\\"])(
  "keeps unassociated Windows folders uncertain on other importing hosts: %s",
  async (cwd) => {
    const { env } = fixture();
    expect(
      await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime: null,
        cwd,
        env
      })
    ).toMatchObject({
      kind: "unresolved",
      root: null,
      checkoutId: null
    });
  }
);

it("uses native source folders when Git data is missing or nonportable", () => {
  for (const git of [
    undefined,
    { branch: "main" },
    { repository_url: "file:///old/checkout" }
  ]) {
    const records = [metadata(git)];
    expect(codexSourceTimeRepositoryIdentity(records)).toBeNull();
    expect(codexSourceTimeProjectDirectory(records)).toBe(
      "/source-time/checkout"
    );
    expect(
      extractTranscriptSessionMetadata(records).transcriptMetadata
        .sourceTimeProjectDirectory
    ).toBe("/source-time/checkout");
  }
});

it("does not rescue ambiguous or absent native metadata with a generic cwd", () => {
  for (const records of [
    [metadata(undefined), metadata(undefined, { cwd: "/other" })],
    [
      metadata({ repository_url: "https://example.test/team/a.git" }),
      metadata({ repository_url: "https://example.test/team/b.git" })
    ],
    [metadata(undefined, { cwd: undefined })],
    [{ type: "message", cwd: "/caller/folder" }]
  ]) {
    expect(codexSourceTimeRepositoryIdentity(records)).toBeNull();
    expect(codexSourceTimeProjectDirectory(records)).toBeNull();
    expect(
      extractTranscriptSessionMetadata(records).transcriptMetadata
        .sourceTimeProjectDirectory
    ).toBeNull();
  }
});

it("keeps conflicting branch observations out of source-time preference", () => {
  const url = "https://example.test/team/original.git";
  expect(
    codexSourceTimeRepositoryIdentity([
      metadata({ repository_url: url, branch: "main" }),
      metadata({ repository_url: url, branch: "other" })
    ])
  ).toMatchObject({ kind: "portable_repository", branch: null });
});

it("preserves startup-time selected anchors and conflicts over native origin and later pins", async () => {
  const { env } = fixture();
  const paths = resolveKoedServerPaths(env);
  const sourceTime = codexSourceTimeRepositoryIdentity([
    metadata({ repository_url: "https://example.test/team/origin.git" })
  ])!;
  const source = {
    sourceKind: "codex" as const,
    externalSessionId: "selected"
  };
  const selected = repositoryIdentitySchema.parse({
    ...sourceTime,
    key: "gr_explicit_upstream",
    selectedRemote: "upstream",
    reason: "local_selection" as const
  });
  for (const original of [
    selected,
    repositoryIdentitySchema.parse({
      ...unresolvedHistoricalRepositoryIdentity(),
      reason: "selection_conflict" as const
    })
  ]) {
    const key = { ...source, externalSessionId: original.reason };
    pinSourceFolderObservation(paths, key, undefined, true, original);
    pinSourceFolderObservation(paths, key, undefined, true, sourceTime);
    expect(
      await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime,
        env,
        cwd: "/reused",
        source: key
      })
    ).toEqual(original);
    expect(
      await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime: null,
        env,
        cwd: "/missing",
        source: key
      })
    ).toEqual(original);
  }
});

it("keeps resumed and legacy source pins uncertain without backfilling today's selection", async () => {
  const { env } = fixture();
  const paths = resolveKoedServerPaths(env);
  const sourceTime = codexSourceTimeRepositoryIdentity([
    metadata({ repository_url: "https://example.test/team/origin.git" })
  ])!;
  const source = { sourceKind: "codex" as const, externalSessionId: "resumed" };
  pinSourceFolderObservation(paths, source, undefined, false);
  pinSourceFolderObservation(paths, source, undefined, true, sourceTime);
  const resolve = (recorded = false) =>
    resolveHistoricalCaptureRepositoryIdentity({
      sourceTime: recorded ? sourceTime : null,
      env,
      cwd: "/missing",
      source
    });
  expect(await resolve()).toEqual(unresolvedHistoricalRepositoryIdentity());
  const recordDirectory = path.join(paths.dataDir, "source-folder-contexts");
  const target = path.join(
    recordDirectory,
    fs.readdirSync(recordDirectory)[0]!
  );
  const old = JSON.parse(fs.readFileSync(target, "utf8")) as Record<
    string,
    unknown
  >;
  delete old.originalRepository;
  fs.writeFileSync(target, JSON.stringify(old));
  pinSourceFolderObservation(paths, source, undefined, true, sourceTime);
  expect(await resolve()).toEqual(unresolvedHistoricalRepositoryIdentity());
  expect(await resolve(true)).toEqual(sourceTime);
});

it("uses reliable native source Git when a startup probe could not observe the checkout", async () => {
  const { env } = fixture();
  const source = {
    sourceKind: "codex" as const,
    externalSessionId: "probe-failed"
  };
  const sourceTime = codexSourceTimeRepositoryIdentity([
    metadata({ repository_url: "https://example.test/team/original.git" })
  ])!;
  const failed = repositoryIdentitySchema.parse({
    ...unresolvedHistoricalRepositoryIdentity(),
    reason: "probe_failed" as const
  });
  pinSourceFolderObservation(
    resolveKoedServerPaths(env),
    source,
    undefined,
    true,
    failed
  );
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({
      sourceTime,
      env,
      cwd: "/missing",
      source
    })
  ).toEqual(sourceTime);
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({
      sourceTime: null,
      env,
      cwd: "/missing",
      source
    })
  ).toEqual(failed);
});
