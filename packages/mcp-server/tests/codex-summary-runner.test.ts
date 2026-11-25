import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  CodexSummaryClientError,
  runCodexSummary
} from "../src/codex-summary-runner.js";

const outputSchema = {
  type: "object",
  properties: { captured: { type: "string" } }
};
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const disabledOtel = {
  log_user_prompt: false,
  exporter: "none",
  trace_exporter: "none",
  metrics_exporter: "none"
};

function fixture(mode = "answer", effectiveOtel: unknown = disabledOtel) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "koed-codex-summary-test-"))
  );
  paths.push(root);
  const home = join(root, "existing-profile");
  const cwd = join(root, "working");
  mkdirSync(home);
  mkdirSync(cwd);
  const appServerBinary = join(root, "fixture.mjs");
  const configRead = join(root, "config-read");
  const threadStarted = join(root, "thread-started");
  const turnStarted = join(root, "turn-started");
  writeFileSync(
    appServerBinary,
    `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
assert.equal(process.env.CODEX_HOME, ${JSON.stringify(home)});
assert.equal(process.cwd(), ${JSON.stringify(cwd)});
const assertTelemetryOverrides = () => {
  for (const option of ['otel.log_user_prompt=false','otel.exporter="none"','otel.trace_exporter="none"','otel.metrics_exporter="none"']) {
    const index = process.argv.indexOf(option);
    assert.ok(index > 0, 'missing launch override: ' + option);
    assert.equal(process.argv[index - 1], '--config');
  }
};
for (const option of ['features.hooks=false','features.plugins=false','notify=[]','history.persistence="none"']) {
  assert.ok(process.argv.includes(option), 'missing launch override: ' + option);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const requests = readline.createInterface({ input: process.stdin });
requests.on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => send({ id, result });
  if (method === 'initialize') {
    if (mode !== 'startup') reply({ codexHome: process.env.CODEX_HOME });
  } else if (method === 'account/read') {
    assert.equal(params.refreshToken, false);
    reply({ requiresOpenaiAuth: true, account: mode === 'no-account' ? null : {type:'chatgpt'} });
  } else if (method === 'config/read') {
    assert.equal(params.cwd, process.cwd());
    writeFileSync(${JSON.stringify(configRead)}, '');
    if (mode === 'stalled-config') return;
    if (mode === 'config-error') {
      send({ id, error: { code: -32602, message: 'Cannot resolve config' } });
      return;
    }
    reply({ config: {
      features: { hooks: mode === 'capture-enabled', plugin_hooks: false, plugins: false },
      history: { persistence: 'none' }, notify: [],
      mcp_servers: { koed: { command: 'fixture' } },
      ...${JSON.stringify(mode === "missing-otel" ? {} : { otel: effectiveOtel })}
    } });
  } else if (method === 'thread/start') {
    writeFileSync(${JSON.stringify(threadStarted)}, '');
    assert.notEqual(mode, 'no-account');
    assert.equal(params.ephemeral, true);
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.dynamicTools, undefined);
    assert.deepEqual(params.config.mcp_servers, { koed: { enabled: false } });
    assert.notEqual(mode, 'capture-enabled');
    reply({ thread: { id: 'summary', ephemeral: mode !== 'persistent-thread' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
  } else if (method === 'turn/start') {
    writeFileSync(${JSON.stringify(turnStarted)}, '');
    if (mode === 'require-otel-overrides') assertTelemetryOverrides();
    assert.notEqual(mode, 'persistent-thread');
    assert.equal(params.model, 'assigned-model');
    assert.equal(params.effort, 'low');
    assert.equal(params.input[0].text, 'synthetic evidence');
    assert.deepEqual(params.outputSchema, ${JSON.stringify(outputSchema)});
    assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    reply({ turn: { id: 'turn' } });
    const ids = { threadId: 'summary', turnId: 'turn' };
    send({ method: 'item/agentMessage/delta', params: { ...ids, itemId: 'msg', delta: '{"captured":"ok"}' } });
    if (mode !== 'pending') send({ method: 'turn/completed', params: { ...ids, turn: { id: 'turn', status: 'completed' } } });
  }
});
`
  );
  return {
    home,
    configRead,
    threadStarted,
    turnStarted,
    config: {
      appServerBinary,
      cwd,
      env: { ...process.env, CODEX_HOME: home },
      clientName: "koed-floating-kin",
      model: "assigned-model",
      reasoningEffort: "low",
      baseInstructions: "Summary only",
      outputSchema
    }
  };
}

it("runs a structured read-only turn in the same native profile without copying it", async () => {
  const { home, config } = fixture("require-otel-overrides");
  await expect(
    runCodexSummary("synthetic evidence", config, 5000)
  ).resolves.toMatchObject({
    text: '{"captured":"ok"}',
    model: "codex-app-server:assigned-model:low"
  });
  expect(readdirSync(home)).toEqual([]);
});

it("does not start a summary thread if native sign-in is unavailable", async () => {
  const { config } = fixture("no-account");
  await expect(
    runCodexSummary("synthetic evidence", config, 5000)
  ).rejects.toMatchObject({
    reason: "authentication_required"
  });
});

it.each(["capture-enabled", "persistent-thread"])(
  "does not send evidence if Codex reports %s",
  async (mode) => {
    const { config } = fixture(mode);
    await expect(
      runCodexSummary("synthetic evidence", config, 5000)
    ).rejects.toThrow(/requested .* (settings|policy)/);
  }
);

it.each([
  ["managed prompt logging", { ...disabledOtel, log_user_prompt: true }],
  [
    "managed log exporter",
    {
      ...disabledOtel,
      exporter: { "otlp-grpc": { endpoint: "http://127.0.0.1:1" } }
    }
  ],
  [
    "managed trace exporter",
    {
      ...disabledOtel,
      trace_exporter: {
        "otlp-http": { endpoint: "http://127.0.0.1:1", protocol: "binary" }
      }
    }
  ],
  [
    "managed metrics exporter",
    { ...disabledOtel, metrics_exporter: "statsig" }
  ],
  ["unreported exporter", { ...disabledOtel, trace_exporter: undefined }],
  ["malformed prompt setting", { ...disabledOtel, log_user_prompt: "false" }],
  ["missing-otel", null],
  ["config-error", null]
] as const)("does not send evidence with %s", async (mode, otel) => {
  const fixtureMode =
    mode === "missing-otel" || mode === "config-error" ? mode : "answer";
  const { config, threadStarted, turnStarted } = fixture(fixtureMode, otel);
  const result = runCodexSummary("synthetic evidence", config, 5000);
  await expect(result).rejects.toBeInstanceOf(CodexSummaryClientError);
  await expect(result).rejects.toMatchObject({
    reason: "telemetry_unverified"
  });
  expect(existsSync(threadStarted)).toBe(false);
  expect(existsSync(turnStarted)).toBe(false);
});

it("cancels a pending turn and closes the worker", async () => {
  const { config } = fixture("pending");
  const abort = new AbortController();
  await expect(
    runCodexSummary(
      "synthetic evidence",
      {
        ...config,
        signal: abort.signal,
        onProviderActivity: () => abort.abort()
      },
      5000
    )
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("times out without sending evidence if config read stalls", async () => {
  const { config, configRead, threadStarted, turnStarted } =
    fixture("stalled-config");
  await expect(
    runCodexSummary("synthetic evidence", config, 1000)
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(existsSync(configRead)).toBe(true);
  expect(existsSync(threadStarted)).toBe(false);
  expect(existsSync(turnStarted)).toBe(false);
});

it("times out a stalled worker initialization", async () => {
  const { config } = fixture("startup");
  await expect(
    runCodexSummary("synthetic evidence", config, 100)
  ).rejects.toMatchObject({ name: "TimeoutError" });
});
