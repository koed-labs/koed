import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { readDesktopLocalCredentialAuthorization } from "@koed/shared";
import type { Hq713Fixture } from "./hq713-fixture.js";

const run = promisify(execFile);

/** Native companion, required by CI and opt-in for local service diagnostics.
 * It uses the real Desktop IPC and listening production APIs. */
export async function runHq713DesktopProof(fixture: Hq713Fixture) {
  const output = process.env.KOED_HQ713_DESKTOP_OUTPUT;
  assert.ok(output, "Native proof needs an owned evidence directory");
  await mkdir(output, { recursive: true });
  const desktop = fileURLToPath(new URL("../../../desktop/", import.meta.url));
  const build = join(output, "renderer");
  const marker = "Review the shared launch checklist";
  const invitationTeamName = `HQ-713 Native invitation ${crypto.randomUUID().slice(0, 8)}`;
  const invitationProjectName = "Native invitation review";
  const { projectId: shareReviewProjectId } =
    await fixture.createPersonalProject(fixture.alice, {
      name: "Native Share Project disclosure"
    });
  const { projectId: invitationSourceProjectId } =
    await fixture.createPersonalProject(fixture.alice, {
      name: invitationProjectName
    });
  const teamCreateBody = { name: invitationTeamName };
  const teamCreateGrant = await fixture.approveActionGrant(fixture.alice, {
    action: "team.create",
    body: teamCreateBody
  });
  const teamCreated = await fixture.alice.team.request<{
    team: { id: string };
    defaultWorkspace: { id: string };
  }>("POST", "/v1/teams", {
    body: teamCreateBody,
    headers: {
      "x-koed-action-grant": teamCreateGrant.secret,
      "idempotency-key": crypto.randomUUID()
    },
    expectedStatus: 200
  });
  const invitationTeamId = teamCreated.body.team.id;
  const invitationWorkspaceId = teamCreated.body.defaultWorkspace.id;
  const invitationAttemptKey = crypto.randomUUID();
  await fixture.alice.team.request(
    "GET",
    `/v1/teams/${invitationTeamId}/workspaces/${invitationWorkspaceId}/share-target?shareAttemptKey=${invitationAttemptKey}`,
    { expectedStatus: 200 }
  );
  const prepared = await fixture.alice.personalEdge.request<{
    snapshot: {
      personalProjectVersion: number;
      workItems: unknown[];
      sources: unknown[];
      decks: unknown[];
    };
  }>(
    "POST",
    `/v1/local-edge/projects/${invitationSourceProjectId}/workspace-project-prepare`,
    {
      body: {
        teamBackendId: fixture.teamBackendId,
        shareAttemptKey: invitationAttemptKey,
        targetTeamId: invitationTeamId,
        targetWorkspaceId: invitationWorkspaceId
      },
      expectedStatus: 200
    }
  );
  const invitationProject = await fixture.alice.team.request<{
    id: string;
    version: number;
  }>("POST", "/v1/workspace-projects", {
    body: {
      teamId: invitationTeamId,
      workspaceId: invitationWorkspaceId,
      name: invitationProjectName,
      key: "NATIVE",
      shareAttemptKey: invitationAttemptKey
    },
    expectedStatus: 201
  });
  const snapshot = prepared.body.snapshot;
  const copied = await fixture.alice.team.request<{
    version: number;
    copiedAt: string | null;
  }>(
    "POST",
    `/v1/workspace-projects/${invitationProject.body.id}/first-share-copy`,
    {
      body: {
        expectedVersion: invitationProject.body.version,
        personalProjectVersion: snapshot.personalProjectVersion,
        workItems: snapshot.workItems,
        sources: snapshot.sources,
        decks: snapshot.decks
      },
      expectedStatus: 200
    }
  );
  assert.ok(copied.body.copiedAt);
  await fixture.alice.personalEdge.request(
    "POST",
    `/v1/local-edge/projects/${invitationSourceProjectId}/workspace-project-confirm`,
    {
      body: {
        expectedPersonalProjectVersion: snapshot.personalProjectVersion,
        teamBackendId: fixture.teamBackendId,
        workspaceProjectId: invitationProject.body.id
      },
      expectedStatus: 200
    }
  );
  const inviteBody = {
    defaultTeamWorkspaceId: invitationWorkspaceId,
    workspaceProjectId: invitationProject.body.id,
    expectedWorkspaceProjectVersion: copied.body.version,
    defaultWorkspaceAccess: "write",
    email: fixture.bob.email,
    role: "member",
    ttlHours: 24
  };
  const inviteGrant = await fixture.approveActionGrant(fixture.alice, {
    action: "team.invite.create",
    teamId: invitationTeamId,
    body: inviteBody
  });
  const invitation = await fixture.alice.team.request<{
    invite: { id: string };
  }>("POST", `/v1/teams/${invitationTeamId}/invites`, {
    body: inviteBody,
    headers: { "x-koed-action-grant": inviteGrant.secret },
    expectedStatus: 200
  });
  assert.ok(invitation.body.invite.id);
  const pendingInvitations = await fixture.localCommand(
    fixture.bob,
    "collaboration.list_my_invitations",
    {}
  );
  const visibleInvitations = (
    pendingInvitations.data as {
      invites: Array<{ id: string; project: { id: string } | null }>;
    }
  ).invites;
  assert.ok(
    visibleInvitations.some(
      (item) =>
        item.id === invitation.body.invite.id &&
        item.project?.id === invitationProject.body.id
    ),
    "Bob must see the real pending Project invitation before Native rendering"
  );
  await fixture.alice.team.request(
    "POST",
    `/v1/workspace-projects/${fixture.ids.workspaceProjectId}/work-items`,
    {
      body: {
        kind: "todo",
        title: marker,
        goal: "Inspect the live shared Project",
        status: "todo",
        idempotencyKey: crypto.randomUUID()
      },
      expectedStatus: [200, 201]
    }
  );
  const env = { ...process.env, KOED_HQ713_DESKTOP_BUILD: build };
  const command = async (args: string[]) => {
    const result = await run("pnpm", args, {
      cwd: desktop,
      env: { ...env, NODE_ENV: "production" },
      maxBuffer: 4 * 1024 * 1024
    });
    await writeFile(
      join(output, `build-${args[1] ?? "command"}.log`),
      result.stdout + result.stderr
    );
  };
  await command([
    "exec",
    "vite",
    "build",
    "--config",
    "tests/hq713/vite.config.ts"
  ]);
  const main = join(output, "main.mjs");
  const preload = join(output, "preload.cjs");
  // The ESM test bundle includes proper-lockfile CJS, which loads Node builtins.
  await command([
    "exec",
    "esbuild",
    "tests/hq713/main.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    "--external:electron",
    `--outfile=${main}`
  ]);
  await command([
    "exec",
    "esbuild",
    "tests/hq713/preload.cts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    `--outfile=${preload}`
  ]);
  await mkdir(join(output, "electron-profile"), { recursive: true });
  const launcher = join(output, "launcher.cjs");
  await writeFile(
    launcher,
    `const { app } = require("electron");
process.on("uncaughtException", error => { console.error(error); app.exit(1); });
app.whenReady().then(() => import(${JSON.stringify(new URL(`file://${main}`).href)})).catch(error => { console.error(error); app.exit(1); });
`
  );
  const config = join(output, "native-config.json");
  await writeFile(
    config,
    JSON.stringify({
      actors: [fixture.alice, fixture.bob].map((actor) => {
        const credential = readDesktopLocalCredentialAuthorization(
          actor.koedHome
        );
        assert.ok(credential);
        return {
          ownerId: actor.id,
          name: actor.name === "alice" ? "Alice" : "Bob",
          projectId:
            actor.name === "alice"
              ? fixture.ids.alicePersonalProjectId
              : fixture.ids.bobPersonalProjectId,
          shareReviewProjectId,
          koedHome: actor.koedHome,
          apiUrl: actor.personal.baseUrl,
          authorization: credential.authorization,
          teamAuthorization: actor.deviceAuthorization
        };
      }),
      teamUrl: fixture.team.baseUrl,
      teamBackendId: fixture.teamBackendId,
      workspaceProjectId: fixture.ids.workspaceProjectId,
      output,
      renderer: join(build, "tests/hq713/renderer.html"),
      preload,
      marker,
      invitationTeamName,
      invitationProjectName,
      nodeExecutable: process.execPath,
      brokerCli: fileURLToPath(
        new URL("../../../../packages/koed-server/dist/cli.js", import.meta.url)
      )
    }),
    { mode: 0o600 }
  );
  await Promise.all(
    ["fault-request", "fault-ack"].map((name) =>
      rm(join(output, name), { force: true })
    )
  );
  let handling = false;
  let phase = "";
  let controlError: unknown;
  const activeControl: { current: Promise<void> | null } = { current: null };
  const faultPath = `/v1/workspace-projects/${fixture.ids.workspaceProjectId}/lifecycle`;
  const control = setInterval(() => {
    if (handling) return;
    handling = true;
    activeControl.current = (async () => {
      const next = await readFile(join(output, "fault-request"), "utf8").catch(
        () => ""
      );
      if (!["offline", "online"].includes(next) || next === phase) return;
      if (next === "offline") fixture.blockTeamPath("GET", faultPath);
      else fixture.resumeTeamPath("GET", faultPath);
      phase = next;
      await writeFile(join(output, "fault-ack"), phase);
    })()
      .catch((error: unknown) => {
        controlError = error;
      })
      .finally(() => {
        handling = false;
        activeControl.current = null;
      });
  }, 100);
  try {
    const require = createRequire(
      new URL("../../../desktop/package.json", import.meta.url)
    );
    const electron: string = require("electron");
    const result = await run(electron, [launcher], {
      cwd: desktop,
      env: {
        ...env,
        ELECTRON_ENABLE_LOGGING: "1",
        KOED_HQ713_DESKTOP_CONFIG: config
      },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024
    });
    await writeFile(join(output, "native.log"), result.stdout + result.stderr);
    if (controlError) throw controlError;
  } finally {
    clearInterval(control);
    await activeControl.current;
    fixture.resumeTeamPath("GET", faultPath);
    await rm(config, { force: true });
  }
}
