import { replicatedTranscriptItems } from "./personal-device-replication-smoke-lib.mjs";
// Real two-database pairing smoke. Only disposable Koed homes are mutated.
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  createWriteStream
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import {
  createPdsApplicationSecretStore,
  readDesktopLocalCredentialAuthorization
} from "../packages/shared/dist/index.js";
import { deviceRequestCommand } from "../packages/koed-server/dist/personal-device-request.js";
import { resolveKoedServerPaths } from "../packages/koed-server/dist/paths.js";
import {
  createKoedServerManager,
  createKoedEnvironment
} from "../apps/desktop/dist-electron/koed-server/manager.js";
import { ensurePdsDesktopAuthority } from "../apps/desktop/dist-electron/pds-authority.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(repoRoot, "packages/koed-server/dist/cli.js");
const root = mkdtempSync(join(tmpdir(), "koed-request-smoke-"));
const assets = process.env.KOED_SMOKE_ASSET_HOME || join(homedir(), ".koed");
const emptyEnv = join(root, "empty.env");
writeFileSync(emptyEnv, "");
const processes = [];
let manager;
const environments = [];
const run = (environment, args) =>
  new Promise((resolveResult, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args, "--json"],
      {
        cwd: repoRoot,
        env: environment,
        timeout: 120_000,
        maxBuffer: 2_000_000
      },
      (error, stdout) => {
        let result;
        try {
          result = JSON.parse(stdout);
        } catch {
          reject(new Error(`CLI ${args.join(" ")} did not return JSON`));
          return;
        }
        if (error || result.ok === false) {
          reject(
            new Error(
              `CLI ${args.join(" ")} failed: ${result.state ?? "unknown"}`
            )
          );
          return;
        }
        resolveResult(result);
      }
    );
  });
const unusedPort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const createHome = (name) => {
  const home = join(root, name);
  mkdirSync(home, { mode: 0o700 });
  for (const resource of ["runtime", "models"]) {
    assert(
      existsSync(join(assets, resource)),
      `Missing reusable ${resource}; run local setup first.`
    );
    symlinkSync(join(assets, resource), join(home, resource));
  }
  const environment = {
    ...process.env,
    KOED_HOME: home,
    KOED_REPO_ROOT: repoRoot,
    KOED_ENV_PATH: emptyEnv,
    MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: "false",
    MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED: "false",
    MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED: "false",
    KOED_TEAM_COLLABORATION_ENABLED: "false"
  };
  for (const key of [
    "KOED_AUTO_PORTS",
    "KOED_RUNTIME_MODE",
    "KOED_DEPENDENCY_MODE",
    "MEMORY_API_TOKEN",
    "MEMORY_API_URL",
    "API_HOST_PORT",
    "POSTGRES_HOST_PORT",
    "PDS_AUTHORITY_SECRET_REF",
    "PDS_RUNTIME_SECRET_REF"
  ])
    delete environment[key];
  environments.push(environment);
  return environment;
};
const start = async (environment) => {
  const log = createWriteStream(join(environment.KOED_HOME, "smoke.log"));
  const child = spawn(process.execPath, [cliPath, "start"], {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  processes.push(child);
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null)
      throw new Error(`Supervisor exited; inspect ${root}`);
    try {
      await run(environment, ["status", "--startup"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Startup timed out; inspect ${root}`);
};
try {
  const authority = createHome("authority");
  const joining = createHome("joining");
  await ensurePdsDesktopAuthority(
    createPdsApplicationSecretStore({ rootPath: authority.KOED_HOME })
  );
  authority.PDS_AUTHORITY_SECRET_REF = "pds-authority";
  authority.PDS_RUNTIME_SECRET_REF = "pds-runtime";
  authority.PDS_DESKTOP_SECRET_STORAGE = "application_managed";
  authority.KOED_PDS_LAN_PORT = String(await unusedPort());
  console.log("Starting two isolated native Personal installations.");
  await Promise.all([start(authority), start(joining)]);
  const desktopEnvironment = createKoedEnvironment(repoRoot, authority, {
    desktopManagedLocal: true
  });
  manager = createKoedServerManager({
    repoRoot,
    cliPath,
    environment: desktopEnvironment,
    createCliInvocation: (args) => ({
      command: process.execPath,
      args: [cliPath, ...args],
      env: desktopEnvironment
    }),
    existsSync,
    execFile,
    spawn,
    openExternal: async () => {},
    personalDevicePairingStore: createPdsApplicationSecretStore({
      rootPath: authority.KOED_HOME
    })
  });
  const created = await manager.handlers.personal_sync_group_bootstrap();
  assert.equal(created.ok, true);
  assert.equal(created.recoveryKit, undefined);
  assert.equal(created.recoveryCode, undefined);
  console.log("Group created without a recovery export.");
  const paths = resolveKoedServerPaths(joining);
  const request = await deviceRequestCommand(paths, "create", "Smoke Studio");
  assert(request.link);
  const review = await manager.handlers.personal_sync_request_review({
    url: request.link
  });
  assert.equal(review.label, "Smoke Studio");
  assert.equal((await deviceRequestCommand(paths, "status")).state, "waiting");
  const accepted = await manager.handlers.personal_sync_request_accept({
    id: review.id
  });
  assert.equal(accepted.ok, true);
  for (let i = 0; i < 30; i++) {
    const status = await deviceRequestCommand(paths, "status");
    if (status.state === "connected") break;
    if (status.state === "failed")
      throw new Error("Joining reconciliation failed.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(
    (await deviceRequestCommand(paths, "status")).state,
    "connected"
  );
  const joinedStore = createPdsApplicationSecretStore({
    rootPath: joining.KOED_HOME
  });
  assert.equal(joinedStore.get("pds-authority"), null);
  assert(joinedStore.get("pds-runtime"));
  const final = await manager.handlers.personal_sync_status();
  assert.equal(
    final.groups[0].members.filter((member) => member.status === "active")
      .length,
    2
  );
  console.log(
    "PASS: explicit Electron acceptance, two active members, durable joining reconciliation, and no copied Authority key."
  );
  const api = async (environment, route, body, desktop = false) => {
    const runtime = JSON.parse(
      readFileSync(join(environment.KOED_HOME, "run/koed-server.json"), "utf8")
    );
    const local = JSON.parse(
      readFileSync(
        join(environment.KOED_HOME, "config/local-app-credential.json"),
        "utf8"
      )
    );
    const authorization = desktop
      ? readDesktopLocalCredentialAuthorization(environment.KOED_HOME)
          .authorization
      : `Bearer ${local.apiToken}`;
    const response = await fetch(new URL(route, runtime.apiUrl), {
      method: "POST",
      headers: {
        authorization,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(
        `${route} failed (${response.status}): ${result.error ?? "unknown"}`
      );
    }
    return await response.json();
  };
  const replicate = async (source, destination, label) => {
    const marker = `pair-request-smoke-${label}-${Date.now()}`;
    const session = await api(source, "/v1/sessions", {
      externalSessionId: marker,
      sourceRuntime: "codex",
      captureMethod: "transcript",
      projectId: marker
    });
    const sessionId = session.session.id;
    await api(source, "/v1/memory/conversation-items", {
      items: replicatedTranscriptItems({
        sessionId,
        marker,
        observedAt: new Date().toISOString()
      })
    });
    await api(source, "/v1/memory/conversation-items/project", { limit: 100 });
    const closed = await api(
      source,
      `/v1/personal-device-sync/groups/${created.groupId}/sessions/${sessionId}/close`,
      undefined,
      true
    );
    assert.equal(closed.closure.state, "ready");
    for (let attempt = 0; attempt < 120; attempt++) {
      const search = await api(destination, "/v1/memory/search", {
        query: marker,
        retrieval_scope: "personal",
        search_domain: "global",
        limit: 5
      });
      if (
        search.retrievalMode === "semantic_vector" &&
        JSON.stringify(search.hits).includes(marker)
      ) {
        console.log(
          `PASS: encrypted ${label} replication and semantic recall.`
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${label} replication.`);
  };
  await replicate(authority, joining, "Electron-to-headless");
  await replicate(joining, authority, "headless-to-Electron");
} finally {
  await manager?.stop().catch(() => undefined);
  await Promise.all(
    environments.map((environment) =>
      run(environment, ["stop"]).catch(() => undefined)
    )
  );
  for (const child of processes)
    if (child.exitCode === null) child.kill("SIGTERM");
  if (process.env.KOED_KEEP_SMOKE_HOME === "1")
    console.log(`Diagnostic home: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
