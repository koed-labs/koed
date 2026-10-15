import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  access
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkClaudeCodeAvailability,
  ClaudeManagedConversationSession,
  prepareManagedClaudeHome,
  retainManagedClaudeHome,
  releaseManagedClaudeHomeLease,
  reuseManagedClaudeHome
} from "../packages/mcp-server/dist/index.js";
import { managedClaudeInstructionContext } from "../apps/worker/dist/managed-claude-instruction-context.js";

// Uses the User's existing Claude sign-in, but no Koed token, live database or app.
const environment = Object.fromEntries(
  [
    "HOME",
    "PATH",
    "USER",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "KOED_CLAUDE_CODE_EXECUTABLE"
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
);
const absent = async (path) => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};

async function boundedPrompt(session, prompt) {
  let timer;
  try {
    return await Promise.race([
      session.prompt(prompt),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Claude disposable prompt exceeded its deadline")),
          180_000
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPhase(fixturePath, resume) {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const env = {
    ...environment,
    KOED_HOME: fixture.koedHome,
    KOED_CLAUDE_PROJECT_INSTRUCTIONS: "1"
  };
  const managedHome = resume
    ? reuseManagedClaudeHome(fixture.managedHome, env)
    : prepareManagedClaudeHome(env);
  if (!resume) {
    fixture.managedHome = managedHome;
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
  }
  const instructions = await managedClaudeInstructionContext({
    managedHome,
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    newSession: !resume,
    env
  });
  assert.equal(instructions?.status, "loaded");
  assert.ok(instructions.append.includes(fixture.marker));
  assert.ok(!instructions.append.includes("replacement-marker"));
  let deniedTools = 0;
  const session = new ClaudeManagedConversationSession({
    cwd: fixture.projectPath,
    managedHome,
    env: environment,
    model: fixture.model,
    ...(resume
      ? { resumeSessionId: fixture.sessionId }
      : { sessionId: fixture.sessionId }),
    instructionOnly: true,
    projectInstructionStatus: instructions.status,
    permissionMode: "default",
    settingSources: [],
    tools: ["Write"],
    canUseTool: async () => {
      deniedTools += 1;
      return { behavior: "deny", message: "Disposable Koed permission check." };
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: instructions.append
    },
    maxTurns: 4
  });
  try {
    if (!resume) {
      const first = await session.prompt(
        `Remember history token ${fixture.historyToken}. Reply with the Project marker only.`
      );
      assert.ok(
        first.text.includes(fixture.marker),
        "new session did not receive Project instructions"
      );
    }
    const followup = await session.prompt(
      "Reply with the remembered history token and the Project marker."
    );
    assert.ok(
      followup.text.includes(fixture.historyToken),
      "native history was not retained"
    );
    assert.ok(
      followup.text.includes(fixture.marker),
      "instruction snapshot was not retained"
    );
    if (!resume) {
      await session.prompt(
        "Use the Write tool now to create forbidden.txt containing permission-check. Do not use another tool."
      );
      assert.ok(
        deniedTools > 0,
        "provider did not exercise the approval callback; permission test is incomplete"
      );
      assert.ok(
        await absent(join(fixture.projectPath, "forbidden.txt")),
        "Project settings bypassed Koed permission denial"
      );
      await assert.rejects(
        session.prompt("Do not submit this skill turn.", [
          "unverified-smoke-skill"
        ]),
        { name: "ClaudeManagedConversationInstructionIsolationError" }
      );
    }
    assert.ok(
      await absent(join(fixture.projectPath, "hook-ran")),
      "Project hook executed"
    );
  } finally {
    await session.closeAndWait();
    retainManagedClaudeHome(managedHome, env);
    releaseManagedClaudeHomeLease(managedHome, env);
  }
}

async function child(fixturePath, resume) {
  await new Promise((resolve, reject) => {
    const processHandle = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--phase",
        fixturePath,
        ...(resume ? ["--resume"] : [])
      ],
      {
        env: { ...environment },
        stdio: ["ignore", "ignore", "ignore"],
        detached: process.platform !== "win32"
      }
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && processHandle.pid) {
        // This group belongs only to this disposable child and its SDK subprocess.
        try {
          process.kill(-processHandle.pid, "SIGKILL");
        } catch {
          processHandle.kill("SIGKILL");
        }
      } else {
        processHandle.kill("SIGTERM");
      }
    }, 180_000);
    processHandle.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(new Error("Claude disposable phase exceeded its deadline"));
      else if (code === 0) resolve();
      else
        reject(
          new Error(
            `Claude disposable ${resume ? "restart" : "initial"} phase failed; live acceptance did not pass`
          )
        );
    });
  });
}

async function main() {
  if (process.argv[2] === "--phase") {
    await runPhase(process.argv[3], process.argv.includes("--resume"));
    return;
  }
  const availability = await checkClaudeCodeAvailability(environment);
  if (
    !availability.available ||
    !availability.executablePath ||
    !availability.authenticated
  ) {
    console.error(
      "BLOCKED: a supported, signed-in Claude Code installation is required. No provider query ran."
    );
    process.exitCode = 2;
    return;
  }
  const model = process.env.KOED_CLAUDE_SMOKE_MODEL?.trim();
  if (!model) {
    console.error(
      "BLOCKED: set KOED_CLAUDE_SMOKE_MODEL to an available model from this Claude installation. No provider query ran."
    );
    process.exitCode = 2;
    return;
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "koed-claude-instructions-smoke-"))
  );
  try {
    const projectPath = join(root, "project");
    await mkdir(join(projectPath, ".claude"), { recursive: true, mode: 0o700 });
    const env = { ...environment, KOED_HOME: join(root, "koed") };
    const fixture = {
      projectPath,
      managedHome: null,
      koedHome: env.KOED_HOME,
      model,
      marker: `project-${randomUUID()}`,
      historyToken: `history-${randomUUID()}`,
      sessionId: randomUUID()
    };
    await writeFile(
      join(projectPath, "CLAUDE.md"),
      `The Project marker is ${fixture.marker}. Follow the User's requested reply format.\n`
    );
    await writeFile(
      join(projectPath, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Write"] },
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "touch hook-ran" }] }
          ]
        }
      })
    );
    const fixturePath = join(root, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    await child(fixturePath, false);
    await writeFile(
      join(projectPath, "CLAUDE.md"),
      "The Project marker is replacement-marker.\n"
    );
    await child(fixturePath, true);
    const independentPath = join(root, "independent");
    await mkdir(independentPath, { mode: 0o700 });
    await writeFile(
      join(root, "CLAUDE.md"),
      `The Project marker is ${fixture.marker}.\n`
    );
    const standaloneHome = prepareManagedClaudeHome(env);
    const standaloneId = randomUUID();
    let standaloneSession;
    try {
      const standalone = await managedClaudeInstructionContext({
        managedHome: standaloneHome,
        sessionId: standaloneId,
        projectPath: null,
        newSession: true,
        env: { ...env, KOED_CLAUDE_PROJECT_INSTRUCTIONS: "1" }
      });
      assert.deepEqual(standalone, { append: "", status: "standalone" });
      standaloneSession = new ClaudeManagedConversationSession({
        cwd: independentPath,
        managedHome: standaloneHome,
        env: environment,
        model,
        sessionId: standaloneId,
        instructionOnly: true,
        projectInstructionStatus: "standalone",
        permissionMode: "default",
        settingSources: [],
        tools: [],
        maxTurns: 1,
        canUseTool: async () => ({
          behavior: "deny",
          message: "Standalone check has no tools."
        }),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "Follow the User's requested reply format."
        }
      });
      const response = await boundedPrompt(
        standaloneSession,
        "If a Project marker has been provided in your instructions, return it. Otherwise reply exactly NONE. Do not use tools."
      );
      assert.equal(
        response.text.trim(),
        "NONE",
        "standalone inherited Project instructions"
      );
    } finally {
      await standaloneSession?.closeAndWait();
      releaseManagedClaudeHomeLease(standaloneHome, env);
    }
    console.log(
      `PASS: Claude ${availability.version}; root instructions, history, separate-process resume, immutable snapshot, permission denial, settings/hook isolation, selected-skill refusal and standalone instruction exclusion.`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error(
    "FAIL: disposable Claude instruction validation did not pass. Provider output and local paths are omitted."
  );
  process.exitCode = 1;
});
