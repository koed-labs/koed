import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { normalizeGitRemoteUrl } from "@koed/shared";
import {
  resolveHistoricalCaptureRepositoryIdentity,
  codexSourceTimeRepositoryIdentity,
  unresolvedHistoricalRepositoryIdentity
} from "../src/historical-repository-context.js";
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
it("uses recorded origin metadata without inheriting a current checkout or device", () => {
  const url = "https://example.test/team/original.git";
  const result = codexSourceTimeRepositoryIdentity([
    metadata({ repository_url: url, branch: "main" })
  ]);
  expect(result).toMatchObject({
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
it("leaves path-only, missing, nonportable and ambiguous provenance unresolved", () => {
  for (const records of [
    [metadata({ branch: "main" })],
    [metadata({ repository_url: "file:///old/checkout" })],
    [
      metadata(
        { repository_url: "https://example.test/team/original.git" },
        { cwd: undefined }
      )
    ],
    [
      metadata(
        { repository_url: "https://example.test/team/original.git" },
        { timestamp: "unknown" }
      )
    ],
    [
      metadata({ repository_url: "https://example.test/team/original.git" }),
      metadata({ repository_url: "https://example.test/team/reused.git" })
    ]
  ])
    expect(codexSourceTimeRepositoryIdentity(records)).toBeNull();
  expect(unresolvedHistoricalRepositoryIdentity()).toMatchObject({
    kind: "unresolved",
    key: null,
    root: null,
    branch: null,
    checkoutId: null
  });
});
it("keeps incomparable branch observations out of source-time preference", () => {
  const url = "https://example.test/team/original.git";
  expect(
    codexSourceTimeRepositoryIdentity([
      metadata({ repository_url: url, branch: "main" }),
      metadata({ repository_url: url, branch: "other" })
    ])
  ).toMatchObject({ kind: "portable_repository", branch: null });
});

it("admits a recorded matching source anchor but rejects a reused or missing checkout", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-historical-context-")
  );
  try {
    const cwd = path.join(directory, "repository");
    fs.mkdirSync(cwd);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    git("init");
    git("remote", "add", "origin", "https://example.test/team/original.git");
    const sourceTime = codexSourceTimeRepositoryIdentity([
      metadata(
        {
          repository_url: "https://example.test/team/original.git",
          branch: "source-branch"
        },
        { cwd }
      )
    ]);
    const input = {
      cwd,
      sourceTime,
      env: { KOED_HOME: path.join(directory, "koed") }
    };
    expect(await resolveHistoricalCaptureRepositoryIdentity(input)).toEqual(
      sourceTime
    );
    expect(
      await resolveHistoricalCaptureRepositoryIdentity({
        ...input,
        sourceTime: null
      })
    ).toMatchObject({ kind: "unresolved", key: null });
    git("remote", "set-url", "origin", "https://example.test/team/reused.git");
    expect(
      await resolveHistoricalCaptureRepositoryIdentity(input)
    ).toMatchObject({ kind: "unresolved", key: null });
    fs.rmSync(cwd, { recursive: true });
    expect(
      await resolveHistoricalCaptureRepositoryIdentity(input)
    ).toMatchObject({ kind: "unresolved", key: null });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
