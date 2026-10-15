import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  realpath
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  managedClaudeInstructionHomeVersion,
  prepareManagedClaudeHome,
  releaseManagedClaudeHomeLease,
  retainManagedClaudeHome,
  reuseManagedClaudeHome
} from "@koed/mcp-server";
import {
  assertManagedClaudeInstructionTransferSupported,
  managedClaudeInstructionContext
} from "./managed-claude-instruction-context.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "koed-instruction-context-"))
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, "project");
  const sourceHome = join(root, "claude");
  await mkdir(projectPath);
  await mkdir(sourceHome);
  const env = {
    HOME: root,
    KOED_HOME: join(root, "koed"),
    CLAUDE_CONFIG_DIR: sourceHome,
    KOED_CLAUDE_PROJECT_INSTRUCTIONS: "1"
  };
  const managedHome = prepareManagedClaudeHome(env);
  cleanups.push(async () => releaseManagedClaudeHomeLease(managedHome, env));
  return { root, projectPath, env, managedHome, sessionId: randomUUID() };
};

it("leaves rollout-disabled and existing legacy homes unchanged", async () => {
  const f = await fixture();
  await writeFile(join(f.projectPath, "CLAUDE.md"), Buffer.from([0xff]));
  expect(
    await managedClaudeInstructionContext({
      ...f,
      newSession: true,
      env: { ...f.env, KOED_CLAUDE_PROJECT_INSTRUCTIONS: "0" }
    })
  ).toBeUndefined();
  expect(await managedClaudeInstructionContext(f)).toBeUndefined();
  expect(
    managedClaudeInstructionHomeVersion(f.managedHome, f.env)
  ).toBeUndefined();
});

it("restores the frozen snapshot after lease reuse even when rollout is disabled", async () => {
  const f = await fixture();
  await writeFile(join(f.projectPath, "CLAUDE.md"), "Use the original marker.");
  const original = await managedClaudeInstructionContext({
    ...f,
    newSession: true
  });
  expect(original?.append).toContain("original marker");
  expect(managedClaudeInstructionHomeVersion(f.managedHome, f.env)).toBe(1);
  retainManagedClaudeHome(f.managedHome, f.env);
  releaseManagedClaudeHomeLease(f.managedHome, f.env);
  reuseManagedClaudeHome(f.managedHome, f.env);
  await writeFile(join(f.projectPath, "CLAUDE.md"), "Use a different marker.");
  expect(
    await managedClaudeInstructionContext({
      ...f,
      env: { ...f.env, KOED_CLAUDE_PROJECT_INSTRUCTIONS: "0" }
    })
  ).toEqual(original);
});

it("does not misclassify an entirely missing snapshot directory as a legacy session", async () => {
  const f = await fixture();
  await managedClaudeInstructionContext({ ...f, newSession: true });
  await rm(join(f.managedHome, ".koed", "claude-project-instructions"), {
    recursive: true
  });
  await expect(managedClaudeInstructionContext(f)).rejects.toThrow(
    "ManagedConversationProjectInstructionsSnapshotError"
  );
});

it("reports invalid root text before submission and cannot resume a partial snapshot", async () => {
  const f = await fixture();
  await writeFile(join(f.projectPath, "CLAUDE.md"), Buffer.from([0xff]));
  await expect(
    managedClaudeInstructionContext({ ...f, newSession: true })
  ).rejects.toThrow("ManagedConversationProjectInstructionsReadError");
  await expect(managedClaudeInstructionContext(f)).rejects.toThrow(
    "ManagedConversationProjectInstructionsSnapshotError"
  );
});

it("keeps standalone snapshots free of parent and Project instruction text", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "CLAUDE.md"), "Do not inherit this.");
  await writeFile(join(f.projectPath, "CLAUDE.md"), "Do not load this either.");
  const snapshot = await managedClaudeInstructionContext({
    ...f,
    projectPath: null,
    newSession: true
  });
  expect(snapshot).toEqual({ append: "", status: "standalone" });
  const bytes = await readFile(
    join(
      f.managedHome,
      ".koed",
      "claude-project-instructions",
      `${f.sessionId}.json`
    ),
    "utf8"
  );
  expect(bytes).not.toContain("Do not");
});

it("binds each snapshot to the exact native session and Project", async () => {
  const f = await fixture();
  await managedClaudeInstructionContext({ ...f, newSession: true });
  await expect(
    managedClaudeInstructionContext({ ...f, sessionId: randomUUID() })
  ).rejects.toThrow("ManagedConversationProjectInstructionsSnapshotError");
  const otherProject = join(f.root, "other");
  await mkdir(otherProject);
  await expect(
    managedClaudeInstructionContext({ ...f, projectPath: otherProject })
  ).rejects.toThrow("ManagedConversationProjectInstructionsSnapshotError");
});

it("rejects transcript-only transfer of marked sessions without changing their snapshot", async () => {
  const f = await fixture();
  expect(() =>
    assertManagedClaudeInstructionTransferSupported(f)
  ).not.toThrow();
  const before = await managedClaudeInstructionContext({
    ...f,
    newSession: true
  });
  expect(() => assertManagedClaudeInstructionTransferSupported(f)).toThrow(
    "ManagedConversationProjectInstructionsTransferError"
  );
  expect(await managedClaudeInstructionContext(f)).toEqual(before);
});
