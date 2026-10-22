import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import {
  readLocalEdgeClientCredentialAuthorization,
  readLocalEdgeUpstreamRegistry
} from "@koed/shared";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationRendererCommandSchema
} from "@koed/shared/collaboration";
import { createCollaborationLocalTransport } from "../../src/collaboration/local-transport.js";
import { createProjectsClient } from "../../src/koed-server/projects-client.js";
import { createWorkspaceProjectClient } from "../../src/koed-server/workspace-project-client.js";
import { createWorkspaceProjectPersonalClient } from "../../src/koed-server/workspace-project-personal-client.js";
import { createWorkspaceProjectShareContextLoader } from "../../src/koed-server/workspace-project-share-context.js";
import {
  projectsCommandChannel,
  projectsRequestSchema,
  projectsResultSchema
} from "../../src/ipc/projects-protocol.js";

type Actor = {
  ownerId: string;
  name: string;
  projectId: string;
  shareReviewProjectId: string;
  koedHome: string;
  apiUrl: string;
  authorization: string;
  teamAuthorization: string;
};
type Config = {
  actors: Actor[];
  teamUrl: string;
  teamBackendId: string;
  workspaceProjectId: string;
  output: string;
  renderer: string;
  preload: string;
  marker: string;
  invitationTeamName: string;
  invitationProjectName: string;
  nodeExecutable: string;
  brokerCli: string;
};
const config: Config = JSON.parse(
  await readFile(process.env.KOED_HQ713_DESKTOP_CONFIG!, "utf8")
);
app.setPath("userData", join(config.output, "electron-profile"));
nativeTheme.themeSource = "light";
await app.whenReady();
const windows: BrowserWindow[] = [];
const identities = new Map<number, Actor>();
const failures: string[] = [];
const http = async (
  origin: string,
  authorization: string,
  path: string,
  init: RequestInit = {}
) => {
  const response = await fetch(new URL(path, origin), {
    ...init,
    redirect: "error",
    headers: { ...init.headers, authorization }
  });
  if (!response.ok)
    throw Object.assign(
      new Error(`HQ service unavailable (${response.status})`),
      { statusCode: response.status }
    );
  return (await response.json()) as Record<string, unknown>;
};
const clients = new Map<string, ReturnType<typeof createProjectsClient>>();
const shared = new Map<
  string,
  ReturnType<typeof createWorkspaceProjectClient>
>();
const brokerDiagnostics = new Map<
  string,
  { stdout: string; stderr: string; exit: string }
>();
const appendDiagnostic = (current: string, chunk: Buffer) =>
  (current + chunk.toString("utf8")).slice(-8_192);
const redactedDiagnostic = (value: string) =>
  value
    .replace(/https?:\/\/[^\s"']+/gi, "[url redacted]")
    .replace(
      /\b(?:Bearer|Koed-Device|Koed-Local-Edge)\s+\S+/gi,
      "[credential redacted]"
    )
    .replace(
      /\b(?:authorization|secret|token|credential)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      "[credential field redacted]"
    )
    .replace(/\b(?:hle|kti)_[A-Za-z0-9_-]+\b/g, "[credential redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[opaque value redacted]");
const transports = new Map<
  string,
  ReturnType<typeof createCollaborationLocalTransport>
>();
const collaborationCommand = async (actor: Actor, value: unknown) => {
  const command = collaborationRendererCommandSchema.parse(value);
  const result = await transports.get(actor.ownerId)!.request(command, {
    ownerId: actor.ownerId,
    signal: new AbortController().signal,
    emitCollaborationEvent: (event) => {
      const target = windows.find(
        (window) =>
          identities.get(window.webContents.id)?.ownerId === actor.ownerId
      );
      target?.webContents.send("hq713:collaboration-event", event);
    }
  });
  if (!result.ok)
    console.error(
      `Native collaboration ${command.command}: ${result.error.code}`
    );
  return result;
};
const shareContexts = new Map<
  string,
  ReturnType<typeof createWorkspaceProjectShareContextLoader>
>();
const personalProjects = new Map<
  string,
  ReturnType<typeof createWorkspaceProjectPersonalClient>
>();
for (const actor of config.actors) {
  transports.set(
    actor.ownerId,
    createCollaborationLocalTransport({
      openExternal: async () => {
        throw new Error(
          "Native UI read proof did not request browser enrollment"
        );
      },
      spawnBroker: (sessionToken) => {
        const diagnostic = { stdout: "", stderr: "", exit: "running" };
        brokerDiagnostics.set(actor.name, diagnostic);
        const child = fork(
          config.brokerCli,
          ["desktop", "collaboration-broker"],
          {
            execPath: config.nodeExecutable,
            execArgv: [],
            cwd: resolve(process.cwd(), "../.."),
            env: {
              ...process.env,
              KOED_HOME: actor.koedHome,
              KOED_REPO_ROOT: resolve(process.cwd(), "../.."),
              KOED_AUTO_PORTS: "0",
              MEMORY_API_URL: actor.apiUrl,
              KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"]
          }
        );
        child.stdout?.on("data", (chunk: Buffer) => {
          diagnostic.stdout = appendDiagnostic(diagnostic.stdout, chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          diagnostic.stderr = appendDiagnostic(diagnostic.stderr, chunk);
        });
        child.once("exit", (code, signal) => {
          diagnostic.exit = `code=${code ?? "null"} signal=${signal ?? "null"}`;
        });
        return child as never;
      }
    })
  );
  const authority = {
    key: actor.ownerId,
    ownerId: actor.ownerId,
    apiOrigin: actor.apiUrl,
    authorization: actor.authorization,
    canWrite: true
  };
  clients.set(
    actor.ownerId,
    createProjectsClient(
      (path, init) => http(actor.apiUrl, actor.authorization, path, init),
      async () => authority
    )
  );
  shareContexts.set(
    actor.ownerId,
    createWorkspaceProjectShareContextLoader({
      authority: async () => ({ key: actor.ownerId, ownerId: actor.ownerId }),
      registryReader: () =>
        readLocalEdgeUpstreamRegistry(
          resolve(actor.koedHome, "config", "upstream-backends.json")
        ),
      collaborationLoader: async (ownerId) => {
        assert.equal(ownerId, actor.ownerId);
        const response = await collaborationCommand(actor, {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: "collaboration.load",
          input: { forceRemoteNavigation: true }
        });
        return response.ok === true && response.command === "collaboration.load"
          ? response.data.snapshot
          : null;
      }
    })
  );
  personalProjects.set(
    actor.ownerId,
    createWorkspaceProjectPersonalClient(
      (path, init) => http(actor.apiUrl, actor.authorization, path, init),
      (backendId, family = "team_workspace_read") => {
        assert.equal(backendId, config.teamBackendId);
        const credential = readLocalEdgeClientCredentialAuthorization(
          actor.koedHome,
          backendId
        );
        assert.ok(credential);
        assert.ok(credential.operationFamilies.includes(family));
        return credential.authorization;
      }
    )
  );
  const unavailable = async (): Promise<never> => {
    throw new Error(
      "This desktop proof does not initiate sharing or source mutations"
    );
  };
  shared.set(
    actor.ownerId,
    createWorkspaceProjectClient({
      sendTeam: (path, init) =>
        http(config.teamUrl, actor.teamAuthorization, path, init),
      loadPersonalCopy: unavailable,
      markPersonalMoved: unavailable,
      loadPersonalSource: unavailable,
      loadLinkedPersonalSources: unavailable,
      onAuthoritativeInvalidation: unavailable
    })
  );
}
ipcMain.handle("hq713:profile", (event) => {
  const actor = identities.get(event.sender.id);
  assert.ok(actor);
  const registry = readLocalEdgeUpstreamRegistry(
    resolve(actor.koedHome, "config", "upstream-backends.json")
  );
  assert.equal(registry.activeBackendId, config.teamBackendId);
  const backend = registry.backends.find(
    ({ id }) => id === registry.activeBackendId
  );
  assert.ok(backend);
  assert.equal(backend.baseUrl, config.teamUrl);
  return {
    ownerId: actor.ownerId,
    name: actor.name,
    projectId: actor.projectId,
    shareReviewProjectId: actor.shareReviewProjectId,
    teamUrl: backend.baseUrl,
    teamBackendId: backend.id
  };
});
ipcMain.handle("hq713:collaboration", async (event, value: unknown) => {
  const actor = identities.get(event.sender.id);
  assert.ok(actor);
  return collaborationCommand(actor, value);
});
const closeTransports = async () => {
  await Promise.all(
    [...transports.values()].map((transport) => transport.stop())
  );
  await mkdir(config.output, { recursive: true });
  await Promise.all(
    [...brokerDiagnostics].map(([actor, diagnostic]) =>
      writeFile(
        join(config.output, `${actor.toLowerCase()}-broker.log`),
        redactedDiagnostic(
          `exit: ${diagnostic.exit}\nstdout:\n${diagnostic.stdout}\nstderr:\n${diagnostic.stderr}`
        )
      )
    )
  );
};
ipcMain.handle(projectsCommandChannel, async (event, value: unknown) => {
  const actor = identities.get(event.sender.id);
  assert.ok(actor);
  const request = projectsRequestSchema.parse(value);
  if (request.operation === "sharedShareContext") {
    return projectsResultSchema.parse({
      operation: request.operation,
      context: await shareContexts.get(actor.ownerId)!()
    });
  }
  if (request.operation === "sharedPendingShare") {
    const context = await shareContexts.get(actor.ownerId)!();
    assert.equal(context.state, "ready");
    assert.equal(context.backendId, config.teamBackendId);
    const attempt = await personalProjects
      .get(actor.ownerId)!
      .pendingShare(request.personalProjectId, config.teamBackendId);
    return projectsResultSchema.parse({
      operation: request.operation,
      attempt
    });
  }
  if (request.operation === "sharedDispatches") {
    return projectsResultSchema.parse({
      operation: request.operation,
      items: await personalProjects
        .get(actor.ownerId)!
        .listSharedDispatches(request.personalProjectId)
    });
  }
  if (request.operation === "sharedRefresh") {
    assert.equal(request.teamBackendId, config.teamBackendId);
    assert.equal(request.workspaceProjectId, config.workspaceProjectId);
    return projectsResultSchema.parse({
      operation: request.operation,
      state: await shared
        .get(actor.ownerId)!
        .refresh(request.workspaceProjectId)
    });
  }
  // Mutations are exercised through the real service integration suite; this
  // Native proof uses the existing typed personal read transport only.
  assert.ok(
    [
      "list",
      "hq",
      "workItemList",
      "sourceList",
      "activitySeen",
      "activityPage"
    ].includes(request.operation),
    `Unexpected native read: ${request.operation}`
  );
  return clients.get(actor.ownerId)!(request);
});
const waitFor = async (test: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Native HQ did not show ${label}`);
};
try {
  await mkdir(config.output, { recursive: true });
  for (const actor of config.actors) {
    const win = new BrowserWindow({
      width: 1440,
      height: 960,
      show: true,
      webPreferences: {
        preload: config.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    windows.push(win);
    identities.set(win.webContents.id, actor);
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) failures.push(`${actor.name}: ${message}`);
    });
    await win.loadFile(config.renderer);
    await waitFor(
      () =>
        win.webContents.executeJavaScript(
          `document.body.innerText.includes(${JSON.stringify(config.marker)})`
        ),
      `${actor.name}'s live shared Work Item`
    );
    const text: string = await win.webContents.executeJavaScript(
      "document.body.innerText"
    );
    assert.match(text, /Shared/);
    assert.match(text, /landing/);
    assert.doesNotMatch(
      text,
      /GPT fixture|AI Client|Ask first|Stop Conversation/
    );
    await writeFile(
      join(config.output, `${actor.name.toLowerCase()}-hq.png`),
      (await win.webContents.capturePage()).toPNG()
    );
    await writeFile(
      join(config.output, `${actor.name.toLowerCase()}-hq.txt`),
      text
    );
  }
  const alice = windows[0]!;
  await alice.webContents.executeJavaScript(
    'window.dispatchEvent(new Event("hq713:show-share"))'
  );
  await waitFor(
    () =>
      alice.webContents.executeJavaScript(
        'document.body.innerText.includes("Project name, to-dos, and Source titles and metadata")'
      ),
    "Share Project disclosure"
  );
  const shareText: string = await alice.webContents.executeJavaScript(
    "document.body.innerText"
  );
  assert.match(shareText, /Native Share Project disclosure/);
  assert.match(
    shareText,
    /Eligible captured chat summaries after your separate Native review/
  );
  assert.match(shareText, /Updates and safe Agent progress for shared to-dos/);
  assert.match(
    shareText,
    /Original files, Note text, and private Agent chats do not go to the Team/
  );
  await writeFile(
    join(config.output, "alice-share-sheet.png"),
    (await alice.webContents.capturePage()).toPNG()
  );
  await writeFile(join(config.output, "alice-share-sheet.txt"), shareText);
  await alice.webContents.executeJavaScript(
    'window.dispatchEvent(new Event("hq713:hide-extra"))'
  );
  const bobInvites = windows[1]!;
  await bobInvites.webContents.executeJavaScript(
    'window.dispatchEvent(new Event("hq713:show-invites"))'
  );
  await waitFor(
    () =>
      bobInvites.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(`Your chats in ${config.invitationProjectName} will be shared as summaries with ${config.invitationTeamName}.`)})`
      ),
    "Project invitation summary disclosure"
  );
  const inviteText: string = await bobInvites.webContents.executeJavaScript(
    "document.body.innerText"
  );
  assert.match(inviteText, /invited you to/);
  assert.match(inviteText, /Project/);
  await bobInvites.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll(".hq-now__invitation")).find((row) => row.innerText.includes(${JSON.stringify(config.invitationTeamName)}))?.scrollIntoView({ block: "center" })`
  );
  await writeFile(
    join(config.output, "bob-now-invitation.png"),
    (await bobInvites.webContents.capturePage()).toPNG()
  );
  await writeFile(join(config.output, "bob-now-invitation.txt"), inviteText);
  await bobInvites.webContents.executeJavaScript(
    'window.dispatchEvent(new Event("hq713:hide-extra"))'
  );
  // Ask the parent fixture to interrupt the actual Team route. The control
  // files carry only a fault phase; they never provide business responses.
  await writeFile(join(config.output, "fault-request"), "offline");
  await waitFor(
    async () =>
      (await readFile(join(config.output, "fault-ack"), "utf8").catch(
        () => ""
      )) === "offline",
    "Team transport fault"
  );
  const bob = windows[1]!;
  await bob.webContents.executeJavaScript(
    'window.dispatchEvent(new Event("hq713:refresh"))'
  );
  await waitFor(
    () =>
      bob.webContents.executeJavaScript(
        'document.body.innerText.includes("Team service is unavailable")'
      ),
    "read-only offline notice"
  );
  assert.equal(
    await bob.webContents.executeJavaScript(
      `document.querySelector('[aria-label="New shared to-do"]')?.disabled`
    ),
    true
  );
  assert.equal(
    await bob.webContents.executeJavaScript(
      `document.body.innerText.includes(${JSON.stringify(config.marker)})`
    ),
    true
  );
  await writeFile(
    join(config.output, "bob-hq-offline.png"),
    (await bob.webContents.capturePage()).toPNG()
  );
  await writeFile(join(config.output, "fault-request"), "online");
  await waitFor(
    async () =>
      (await readFile(join(config.output, "fault-ack"), "utf8").catch(
        () => ""
      )) === "online",
    "Team recovery"
  );
  await bob.webContents.executeJavaScript(
    'window.dispatchEvent(new Event("hq713:refresh"))'
  );
  await waitFor(
    () =>
      bob.webContents.executeJavaScript(
        `document.querySelector('[aria-label="New shared to-do"]')?.disabled === false`
      ),
    "write access after recovery"
  );
  assert.deepEqual(failures, []);
  await writeFile(
    join(config.output, "desktop-result.json"),
    JSON.stringify(
      {
        realIpc: true,
        realHttp: true,
        users: config.actors.map(({ name }) => name),
        assertions: [
          "new HQ shared Project",
          "live Work Item",
          "Shared sidebar",
          "no legacy composer",
          "cached offline Project is read only",
          "reconnect restores current write access",
          "Share Project shows Sources, to-dos, and summary disclosure",
          "Now Project invitation states chat summary sharing"
        ],
        consoleErrors: failures
      },
      null,
      2
    )
  );
  await closeTransports();
  app.exit(0);
} catch (error) {
  console.error(error);
  await Promise.allSettled(
    windows.map(async (window, index) => {
      if (window.webContents.isDestroyed()) return;
      const actor = config.actors[index];
      if (!actor) return;
      await writeFile(
        join(config.output, `${actor.name.toLowerCase()}-failure.txt`),
        String(
          await window.webContents.executeJavaScript("document.body.innerText")
        )
      );
      await writeFile(
        join(config.output, `${actor.name.toLowerCase()}-failure.png`),
        (await window.webContents.capturePage()).toPNG()
      );
    })
  );
  await closeTransports();
  app.exit(1);
}
