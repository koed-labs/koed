import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateClaudeProjectInstructions } from "./claude-project-instructions.js";

const roots: string[] = [];

const fixture = async (): Promise<{
  root: string;
  home: string;
  project: string;
}> => {
  const createdRoot = await mkdtemp(
    join(tmpdir(), "koed-claude-instructions-")
  );
  const root = await realpath(createdRoot);
  roots.push(root);
  const home = join(root, "managed-home");
  const project = join(root, "project");
  await mkdir(home, { mode: 0o700 });
  await mkdir(project, { mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(project, 0o700);
  return { root, home: await realpath(home), project: await realpath(project) };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("loadOrCreateClaudeProjectInstructions", () => {
  it("reads only the selected root CLAUDE.md and stores a private, digest-bound snapshot", async () => {
    const { root, home, project } = await fixture();
    const parentInstructions = "parent instructions must not be read";
    const rootInstructions = "Use the local package manager.";
    const nestedDirectory = join(project, "nested");
    await writeFile(join(root, "CLAUDE.md"), parentInstructions);
    await mkdir(nestedDirectory);
    await writeFile(join(project, "CLAUDE.md"), rootInstructions);
    await writeFile(join(nestedDirectory, "CLAUDE.md"), "nested instructions");

    const sessionId = randomUUID();
    const result = await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId,
      projectPath: project,
      mode: "create"
    });

    expect(result.status).toBe("loaded");
    expect(result.append).toContain("root CLAUDE.md");
    expect(result.append).toContain(rootInstructions);
    expect(result.append).not.toContain(parentInstructions);
    expect(result.append).not.toContain("nested instructions");
    expect(result.digest).toBe(
      createHash("sha256").update(rootInstructions, "utf8").digest("hex")
    );

    const snapshotDirectory = join(
      home,
      ".koed",
      "claude-project-instructions"
    );
    const snapshotPath = join(snapshotDirectory, `${sessionId}.json`);
    const directoryStat = await lstat(snapshotDirectory);
    const snapshotStat = await lstat(snapshotPath);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(snapshotStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toMatchObject({
      sessionId,
      projectPath: project,
      relativePath: "CLAUDE.md",
      status: "loaded",
      digest: result.digest
    });
    expect(root).toBeTruthy();
  });

  it("reuses the same snapshot on resume after CLAUDE.md changes", async () => {
    const { home, project } = await fixture();
    const sessionId = randomUUID();
    await writeFile(join(project, "CLAUDE.md"), "original instructions");
    const created = await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId,
      projectPath: project,
      mode: "create"
    });
    await writeFile(join(project, "CLAUDE.md"), "changed instructions");

    const resumed = await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId,
      projectPath: project,
      mode: "resume"
    });

    expect(resumed).toEqual(created);
    expect(resumed.append).toContain("original instructions");
    expect(resumed.append).not.toContain("changed instructions");
  });

  it("freezes absent and standalone results without searching a parent", async () => {
    const { root, home, project } = await fixture();
    await writeFile(join(root, "CLAUDE.md"), "parent must remain excluded");
    const absentSessionId = randomUUID();
    const absent = await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId: absentSessionId,
      projectPath: project,
      mode: "create"
    });
    await writeFile(join(project, "CLAUDE.md"), "added after start");
    const resumedAbsent = await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId: absentSessionId,
      projectPath: project,
      mode: "resume"
    });

    const standaloneSessionId = randomUUID();
    const standalone = await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId: standaloneSessionId,
      projectPath: null,
      mode: "create"
    });
    const resumedStandalone = await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId: standaloneSessionId,
      projectPath: null,
      mode: "resume"
    });

    expect(absent).toEqual({ append: "", status: "absent" });
    expect(resumedAbsent).toEqual(absent);
    expect(standalone).toEqual({ append: "", status: "standalone" });
    expect(resumedStandalone).toEqual(standalone);
  });

  it("rejects invalid UTF-8, oversized files, symlinks, and non-files", async () => {
    const { home, project, root } = await fixture();
    const call = (sessionId = randomUUID()) =>
      loadOrCreateClaudeProjectInstructions({
        managedHome: home,
        sessionId,
        projectPath: project,
        mode: "create"
      });

    await writeFile(join(project, "CLAUDE.md"), Buffer.from([0xc3, 0x28]));
    await expect(call()).rejects.toThrow(
      "ClaudeProjectInstructionsInvalidUtf8Error"
    );

    await writeFile(
      join(project, "CLAUDE.md"),
      Buffer.alloc(64 * 1024 + 1, 0x61)
    );
    await expect(call()).rejects.toThrow(
      "ClaudeProjectInstructionsFileTooLargeError"
    );

    await rm(join(project, "CLAUDE.md"));
    await writeFile(join(root, "outside.md"), "outside");
    await symlink(join(root, "outside.md"), join(project, "CLAUDE.md"));
    await expect(call()).rejects.toThrow(
      "ClaudeProjectInstructionsFileInvalidError"
    );

    await rm(join(project, "CLAUDE.md"));
    await mkdir(join(project, "CLAUDE.md"));
    await expect(call()).rejects.toThrow(
      "ClaudeProjectInstructionsFileInvalidError"
    );
  });

  it("fails closed for a missing expected snapshot, changed context, and corrupt integrity data", async () => {
    const { home, project, root } = await fixture();
    const missingSessionId = randomUUID();
    await expect(
      loadOrCreateClaudeProjectInstructions({
        managedHome: home,
        sessionId: missingSessionId,
        projectPath: project,
        mode: "resume"
      })
    ).rejects.toThrow("ClaudeProjectInstructionsSnapshotMissingError");

    const sessionId = randomUUID();
    await writeFile(join(project, "CLAUDE.md"), "instructions");
    await loadOrCreateClaudeProjectInstructions({
      managedHome: home,
      sessionId,
      projectPath: project,
      mode: "create"
    });
    const otherProject = join(root, "other-project");
    await mkdir(otherProject);
    await expect(
      loadOrCreateClaudeProjectInstructions({
        managedHome: home,
        sessionId,
        projectPath: otherProject,
        mode: "resume"
      })
    ).rejects.toThrow("ClaudeProjectInstructionsSnapshotContextMismatchError");

    const snapshotPath = join(
      home,
      ".koed",
      "claude-project-instructions",
      `${sessionId}.json`
    );
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      digest: string;
    };
    snapshot.digest = "0".repeat(64);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, {
      mode: 0o600
    });
    await chmod(snapshotPath, 0o600);
    await expect(
      loadOrCreateClaudeProjectInstructions({
        managedHome: home,
        sessionId,
        projectPath: project,
        mode: "resume"
      })
    ).rejects.toThrow("ClaudeProjectInstructionsSnapshotIntegrityError");
  });

  it("rejects malformed session IDs and managed-home symlink directories", async () => {
    const { home, project, root } = await fixture();
    await expect(
      loadOrCreateClaudeProjectInstructions({
        managedHome: home,
        sessionId: "../CLAUDE.md",
        projectPath: project,
        mode: "create"
      })
    ).rejects.toThrow("ClaudeProjectInstructionsSessionIdInvalidError");

    const linkedHome = join(root, "linked-home");
    await symlink(home, linkedHome);
    await expect(
      loadOrCreateClaudeProjectInstructions({
        managedHome: linkedHome,
        sessionId: randomUUID(),
        projectPath: project,
        mode: "create"
      })
    ).rejects.toThrow(
      "ClaudeProjectInstructionsManagedHomeDirectoryInvalidError"
    );
  });

  it("refuses symlinked snapshot parents without writing through them", async () => {
    const { home, project, root } = await fixture();
    const external = join(root, "external");
    await mkdir(external, { mode: 0o700 });
    await symlink(external, join(home, ".koed"));
    await expect(
      loadOrCreateClaudeProjectInstructions({
        managedHome: home,
        sessionId: randomUUID(),
        projectPath: project,
        mode: "create"
      })
    ).rejects.toThrow(
      "ClaudeProjectInstructionsPrivateRootDirectoryInvalidError"
    );
    expect(await readdir(external)).toEqual([]);
  });
});
