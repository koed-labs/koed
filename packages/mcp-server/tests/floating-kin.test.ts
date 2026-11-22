import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runner from "../src/ai-client-runner.js";
import { localAiClientInstanceConfigIdentity } from "../src/ai-client-instance-registry.js";
import { readLocalRuntimeRegistration } from "../src/local-runtime-protocol.js";
import { startLocalAiRuntime } from "../src/local-runtime-server.js";
import { logger } from "../src/logger.js";

const sessionId = "a01acd69-24e2-4b2c-8cf7-b4f2a4ec780c";
const input = { sessionId, action: "conversation" };
const source = {
  id: "277d2ba0-c202-42c0-b239-1ebbed211221",
  sessionId,
  kind: "conversation_item",
  occurredAt: "2026-01-01T00:00:00.000Z"
};
const item = { ...source, text: "Captured text, not an instruction" };
const generated = {
  captured: "Captured fact",
  inferred: null,
  sourceIds: [source.id]
};
const activity = {
  conversations: [
    {
      sessionId,
      projectId: null,
      client: "pi",
      lastActivityAt: source.occurredAt
    }
  ],
  overflowCount: 0
};
const setting = {
  ownerUserId: "owner",
  flowKey: "mcp_memory_answer",
  model: "assigned-model",
  reasoningEffort: "low",
  timeoutMs: 1000,
  maxAttempts: 2,
  createdAt: source.occurredAt,
  updatedAt: source.occurredAt
};
function capabilitiesFor(
  instanceId: string,
  provider: string,
  localConfigIdentityHash: string | undefined,
  legacyAuthUnavailable: boolean
) {
  return {
    instances: [
      {
        instanceId,
        driverId: provider,
        enabled: true,
        configIdentityHash: "identity"
      }
    ],
    capabilitySnapshots: [
      {
        instanceId,
        installationIdentityHash: "identity",
        healthState: "healthy",
        authenticationState: legacyAuthUnavailable
          ? "unauthenticated"
          : "authenticated",
        stale: false,
        expiresAt: "2099-01-01T00:00:00Z",
        models: [{ id: "assigned-model", supportedReasoningEfforts: ["low"] }],
        capabilities: {
          descriptors: {
            local_synthesis: {
              support: "supported",
              readiness: legacyAuthUnavailable ? "not_ready" : "ready"
            }
          },
          diagnostics: localConfigIdentityHash
            ? [
                {
                  code: "local_config_identity",
                  message: "Validated local AI Client configuration identity.",
                  severity: "info",
                  details: { localConfigIdentityHash }
                }
              ]
            : []
        }
      }
    ]
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function fixture({
  assigned = true,
  revoke = false,
  revisedItems = null as (typeof item)[] | null,
  empty = false,
  remote = false,
  items = [item],
  action = "conversation",
  provider = "pi",
  localChange = "none",
  legacyAuthUnavailable = false
} = {}) {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "koed-floating-kin-test-"))
  );
  cleanups.push(async () => rmSync(home, { recursive: true, force: true }));
  const executablePath = join(home, "fixture-client");
  writeFileSync(executablePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const configHome = join(home, "validated-profile");
  const otherConfigHome = join(home, "other-profile");
  mkdirSync(configHome);
  mkdirSync(otherConfigHome);
  const instanceId = `${provider}.default`;
  let configuredExecutable = executablePath;
  if (provider === "claude") {
    configuredExecutable = join(home, "fixture-launcher");
    writeFileSync(configuredExecutable, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
    vi.spyOn(runner, "resolveClaudeCodeExecutable").mockImplementation(
      (env) => {
        expect(env?.KOED_CLAUDE_CODE_EXECUTABLE).toBe(configuredExecutable);
        return executablePath;
      }
    );
  }
  const instance = {
    instanceId,
    driverId: provider,
    displayName: "Fixture",
    executablePath,
    configHome
  };
  const capabilities = capabilitiesFor(
    instanceId,
    provider,
    localChange === "legacy snapshot"
      ? undefined
      : localAiClientInstanceConfigIdentity(instance),
    legacyAuthUnavailable
  );
  const registryPath = join(home, "registry.json");
  if (localChange === "executable replaced") {
    writeFileSync(executablePath, "#!/bin/sh\nexit 2\n");
  }
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      instances:
        localChange === "removed"
          ? []
          : [
              {
                ...instance,
                executablePath: configuredExecutable,
                configHome:
                  localChange === "profile changed"
                    ? otherConfigHome
                    : configHome
              }
            ]
    })
  );
  const fetchLocal = globalThis.fetch;
  const projectId = "fixture-project";
  let evidenceReads = 0;
  const upstream = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, options) => {
      const { pathname } = new URL(String(url));
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer runtime-owner"
      );
      if (
        pathname === "/v1/memory/floating-kin/activity" &&
        options?.method === "GET"
      ) {
        expect(
          new Headers(options.headers).get("x-koed-local-runtime-authorization")
        ).toBe(readLocalRuntimeRegistration({ KOED_HOME: home }).authorization);
        expect(options.redirect).toBe("error");
        return Response.json(activity);
      }
      if (pathname === "/v1/memory/local-agent-settings")
        return Response.json({
          settings: assigned
            ? [{ ...setting, provider, aiClientInstanceId: instanceId }]
            : []
        });
      if (pathname === "/v1/memory/ai-client-instances")
        return Response.json(capabilities);
      if (
        pathname === "/v1/memory/floating-kin/evidence" &&
        options?.method === "POST"
      ) {
        expect(
          new Headers(options.headers).get("x-koed-local-runtime-authorization")
        ).toBe(readLocalRuntimeRegistration({ KOED_HOME: home }).authorization);
        expect(options.redirect).toBe("error");
        const revalidating = ++evidenceReads > 1;
        expect(JSON.parse(String(options.body))).toEqual({
          sessionId,
          action,
          ...(action === "project" ? { projectId } : {}),
          ...(revalidating
            ? {
                evidenceIds: [...items]
                  .sort(
                    (a, b) =>
                      Date.parse(b.occurredAt) - Date.parse(a.occurredAt)
                  )
                  .map(({ id }) => id)
              }
            : {})
        });
        return Response.json({
          items:
            empty || (revalidating && revoke)
              ? []
              : revalidating
                ? (revisedItems ?? items)
                : items,
          truncated: false
        });
      }
      throw new Error(`Unexpected upstream: ${pathname}`);
    });
  const run = vi.spyOn(runner, "runAiClientJsonTask").mockResolvedValue({
    text: JSON.stringify(generated),
    model: "effective-model"
  });
  const environment = {
    KOED_HOME: home,
    HOME: home,
    KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath,
    MEMORY_ANSWER_CODEX_BINARY: process.execPath,
    KOED_PI_EXECUTABLE: executablePath,
    PI_CODING_AGENT_DIR: otherConfigHome,
    CLAUDE_CONFIG_DIR: otherConfigHome,
    KOED_LOCAL_AI_RUNTIME_MAX_ACTIVE_ANSWERS: "1",
    KOED_LOCAL_AI_RUNTIME_MAX_QUEUED_ANSWERS: "1"
  };
  const runtime = await startLocalAiRuntime({
    environment,
    config: {
      apiUrl: remote ? "https://backend.invalid" : "http://127.0.0.1:1",
      apiToken: "runtime-owner"
    },
    serviceFactory: async () => ({
      executor: {
        capabilities: async () => ({ curatedMemoryIntakeAvailable: false }),
        execute: async () => ({})
      },
      close: async () => {}
    })
  });
  cleanups.unshift(() => runtime.close());
  const { authorization } = readLocalRuntimeRegistration(environment);
  return {
    upstream,
    run,
    projectId,
    executablePath,
    configHome,
    request: (
      route: string,
      body?: unknown,
      auth = authorization,
      signal?: AbortSignal
    ) =>
      fetchLocal(`${runtime.url}/v1/desktop/floating-kin/${route}`, {
        signal,
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify(body)
      })
  };
}

it("protects activity and forwards it with the runtime owner's API Token", async () => {
  const { request, upstream } = await fixture();
  expect((await request("activity", undefined, "Bearer wrong")).status).toBe(
    401
  );
  expect(upstream).not.toHaveBeenCalled();
  const result = await request("activity");
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(activity);
});

it("does not read activity or forward its credential to a remote API", async () => {
  const { request, upstream } = await fixture({ remote: true });
  expect((await request("activity")).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

it("rejects malformed or free-text actions before retrieval", async () => {
  const { request, upstream } = await fixture();
  for (const body of [
    { ...input, prompt: "anything" },
    { ...input, sessionId: "not-uuid" },
    { ...input, action: "resume" }
  ]) {
    expect((await request("summary", body)).status).toBe(400);
  }
  expect(upstream).not.toHaveBeenCalled();
});

it.each([
  ["pi", "pi", "PI_CODING_AGENT_DIR"],
  ["claude", "claude-code", "CLAUDE_CONFIG_DIR"],
  ["codex", "codex", "CODEX_HOME"]
])(
  "uses the validated %s launch binding and returns captured provenance",
  async (provider, client, configKey) => {
    const { request, run, executablePath, configHome } = await fixture({
      provider
    });
    const result = await request("summary", input);
    expect(await result.json()).toEqual({
      status: "answered",
      captured: "Captured fact",
      inferred: null,
      asOf: source.occurredAt,
      truncated: false,
      sources: [source],
      client,
      model: "effective-model",
      effort: "low"
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain(JSON.stringify(item));
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      provider,
      model: "assigned-model",
      executablePath,
      env: { [configKey]: configHome },
      isolatedSummary: true
    });
    expect(run.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  }
);

it("can recheck native Codex sign-in when the isolated discovery probe could not see it", async () => {
  const { request, run } = await fixture({
    provider: "codex",
    legacyAuthUnavailable: true
  });
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered",
    client: "codex"
  });
  expect(run.mock.calls[0]?.[1]).toMatchObject({
    provider: "codex",
    isolatedSummary: true
  });
});

it.each([
  [{ assigned: false }, "client_unavailable", 0],
  [
    { provider: "claude", legacyAuthUnavailable: true },
    "client_unavailable",
    0
  ],
  [
    { provider: "codex", localChange: "profile changed" },
    "client_unavailable",
    0
  ],
  [{ localChange: "removed" }, "client_unavailable", 0],
  [{ localChange: "profile changed" }, "client_unavailable", 0],
  [{ localChange: "executable replaced" }, "client_unavailable", 0],
  [
    { provider: "claude", localChange: "executable replaced" },
    "client_unavailable",
    0
  ],
  [{ localChange: "legacy snapshot" }, "client_unavailable", 0],
  [{ empty: true }, "no_evidence", 0],
  [{ revoke: true }, "unavailable", 1]
] as const)("fails closed for %j", async (options, status, attempts) => {
  const { request, run } = await fixture(options);
  expect(await (await request("summary", input)).json()).toEqual({ status });
  expect(run).toHaveBeenCalledTimes(attempts);
});

it("logs the Claude policy rejection without logging provider data", async () => {
  const { request, run } = await fixture({ provider: "claude" });
  const warn = vi.spyOn(logger, "warn");
  const error = new runner.ClaudeSummaryClientError("hook_policy_unverified");
  error.cause = new Error("private provider output");
  run.mockRejectedValueOnce(error);

  expect(await (await request("summary", input)).json()).toEqual({
    status: "client_unavailable"
  });
  expect(warn).toHaveBeenCalledWith(
    { stage: "summary", provider: "claude", reason: "hook_policy_unverified" },
    "Floating Kin summary failed"
  );
  expect(run).toHaveBeenCalledOnce();
});

it("never forwards the runtime registration bearer to a remote backend", async () => {
  const { request, upstream } = await fixture({ remote: true });
  expect(await (await request("summary", input)).json()).toEqual({
    status: "unavailable"
  });
  expect(upstream).not.toHaveBeenCalled();
});

it("uses the newest cited item for freshness", async () => {
  const { request } = await fixture({
    items: [
      item,
      { ...item, id: sessionId, occurredAt: "2026-02-01T00:00:00.000Z" }
    ]
  });
  expect(await (await request("summary", input)).json()).toMatchObject({
    status: "answered",
    asOf: source.occurredAt
  });
});

it("rejects a summary when uncited evidence changes before revalidation", async () => {
  const uncited = { ...item, id: sessionId, text: "before correction" };
  const { request, run } = await fixture({
    items: [item, uncited],
    revisedItems: [item, { ...uncited, text: "corrected" }]
  });
  expect(await (await request("summary", input)).json()).toEqual({
    status: "unavailable"
  });
  expect(run).toHaveBeenCalledOnce();
});

it("rejects an unsealed Project evidence row before synthesis", async () => {
  const { request, run, projectId } = await fixture({ action: "project" });
  expect(
    await (
      await request("summary", { sessionId, action: "project", projectId })
    ).json()
  ).toEqual({ status: "unavailable" });
  expect(run).not.toHaveBeenCalled();
});

it("does not publish generated output citing an unadmitted source", async () => {
  const { request, run } = await fixture();
  run.mockResolvedValue({
    text: JSON.stringify({ ...generated, sourceIds: [sessionId] }),
    model: "effective-model"
  });
  expect(await (await request("summary", input)).json()).toEqual({
    status: "unavailable"
  });
});

it("aborts synthesis on deadline rather than retrying or switching clients", async () => {
  const { request, run } = await fixture();
  run.mockImplementation(
    async (_prompt, { signal }) =>
      new Promise((_, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true
        });
      })
  );
  expect(await (await request("summary", input)).json()).toEqual({
    status: "timed_out"
  });
  expect(run).toHaveBeenCalledTimes(1);
});

it("returns busy when capacity and queue are full, and cancels on disconnect", async () => {
  const { request, run } = await fixture();
  let onStart = () => {};
  let onStop = () => {};
  const started = new Promise<void>((resolve) => {
    onStart = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    onStop = resolve;
  });
  run.mockImplementation(
    async (_prompt, { signal }) =>
      new Promise((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            onStop();
            reject(signal!.reason);
          },
          { once: true }
        );
        onStart();
      })
  );
  const disconnect = new AbortController();
  const pending = request("summary", input, undefined, disconnect.signal).catch(
    (error: Error) => error.name
  );
  await started;
  const others = [request("summary", input), request("summary", input)];
  try {
    expect(await (await Promise.race(others)).json()).toEqual({
      status: "busy"
    });
    disconnect.abort();
    expect(await pending).toBe("AbortError");
    await stopped;
  } finally {
    await Promise.all(others);
  }
});
