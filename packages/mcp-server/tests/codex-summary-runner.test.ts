import {
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
import { runCodexSummary } from "../src/codex-summary-runner.js";

const outputSchema = {
  type: "object",
  properties: { captured: { type: "string" } }
};
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture(mode = "answer") {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "koed-codex-summary-test-"))
  );
  paths.push(root);
  const home = join(root, "existing-profile");
  const cwd = join(root, "working");
  mkdirSync(home);
  mkdirSync(cwd);
  const appServerBinary = join(root, "fixture.mjs");
  writeFileSync(
    appServerBinary,
    `
import assert from 'node:assert/strict';
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
assert.equal(process.env.CODEX_HOME, ${JSON.stringify(home)});
assert.equal(process.cwd(), ${JSON.stringify(cwd)});
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
    reply({ config: {
      features: { hooks: mode === 'capture-enabled', plugin_hooks: false, plugins: false },
      history: { persistence: 'none' }, notify: [],
      mcp_servers: { koed: { command: 'fixture' } }
    } });
  } else if (method === 'thread/start') {
    assert.notEqual(mode, 'no-account');
    assert.equal(params.ephemeral, true);
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.dynamicTools, undefined);
    assert.deepEqual(params.config.mcp_servers, { koed: { enabled: false } });
    assert.notEqual(mode, 'capture-enabled');
    reply({ thread: { id: 'summary', ephemeral: mode !== 'persistent-thread' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
  } else if (method === 'turn/start') {
    assert.notEqual(mode, 'persistent-thread');
    assert.equal(params.model, 'assigned-model');
    assert.equal(params.effort, 'low');
    assert.equal(params.input[0].text, 'synthetic evidence');
    assert.deepEqual(params.outputSchema, ${JSON.stringify(outputSchema)});
    assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    reply({ turn: { id: 'turn' } });
    const ids = { threadId: 'summary', turnId: 'turn' };
    send({ method: 'item/agentMessage/delta', params: { ...ids, itemId: 'msg', delta: '{"captured":"ok"}' } });
    if (mode === 'answer') send({ method: 'turn/completed', params: { ...ids, turn: { id: 'turn', status: 'completed' } } });
  }
});
`
  );
  return {
    home,
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
  const { home, config } = fixture();
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

it("times out a stalled worker initialization", async () => {
  const { config } = fixture("startup");
  await expect(
    runCodexSummary("synthetic evidence", config, 100)
  ).rejects.toMatchObject({ name: "TimeoutError" });
});
