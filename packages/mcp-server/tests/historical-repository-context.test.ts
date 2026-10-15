import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { normalizeGitRemoteUrl, repositoryIdentitySchema } from "@koed/shared";
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
  const directory = fs.mkdtempSync(path.join(parent, "context-"));
  directories.push(directory);
  return { directory, env: { KOED_HOME: path.join(directory, "koed") } };
};
afterEach(() => {
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

it("groups recorded folders consistently across clients without probing their current Git state", async () => {
  const { directory, env } = fixture();
  const cwd = path.join(directory, "missing-checkout");
  const first = await resolveHistoricalCaptureRepositoryIdentity({
    sourceTime: null,
    cwd,
    env
  });
  expect(repositoryIdentitySchema.parse(first)).toMatchObject({
    kind: "non_git_project",
    root: cwd,
    branch: null,
    checkoutId: null,
    reason: "non_git"
  });
  expect(first.key).toMatch(/^ng_/);
  expect(first.originatingDeviceId).not.toBe("historical_unknown_device");
  expect(
    await resolveHistoricalCaptureRepositoryIdentity({
      sourceTime: null,
      cwd: `${cwd}/./`,
      env
    })
  ).toEqual(first);
  fs.mkdirSync(cwd);
  execFileSync("git", ["-C", cwd, "init"], { stdio: "pipe" });
  execFileSync(
    "git",
    ["-C", cwd, "remote", "add", "origin", "https://example.test/current.git"],
    { stdio: "pipe" }
  );
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
  expect(otherFolder.key).not.toBe(first.key);
  const otherProfile = await resolveHistoricalCaptureRepositoryIdentity({
    sourceTime: null,
    cwd,
    env: { KOED_HOME: path.join(directory, "other-profile") }
  });
  expect(otherProfile.key).not.toBe(first.key);
  expect(otherProfile.originatingDeviceId).not.toBe(first.originatingDeviceId);
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
  "preserves Windows source folder syntax on other importing hosts: %s",
  async (cwd) => {
    const { env } = fixture();
    expect(
      await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime: null,
        cwd,
        env
      })
    ).toMatchObject({
      kind: "non_git_project",
      root: cwd === "C:\\" ? cwd : cwd.slice(0, -1),
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
