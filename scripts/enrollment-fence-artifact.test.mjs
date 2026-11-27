import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
let scratch;
let runtimeRoot;

before(() => {
  mkdirSync(resolve(root, "scratch"), { recursive: true });
  scratch = mkdtempSync(resolve(root, "scratch/enrollment-fence-artifact-"));
  const output = execFileSync(
    process.execPath,
    [
      resolve(root, "scripts/build-koed-server-package.mjs"),
      "--catalogless-development",
      "--out-dir",
      resolve(scratch, "package"),
      "--json"
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const artifact = JSON.parse(output.slice(output.indexOf("{\n")));
  const extracted = resolve(scratch, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", artifact.artifact.tarPath, "-C", extracted]);
  runtimeRoot = resolve(
    extracted,
    basename(artifact.packageRoot),
    "koed-runtime"
  );
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test(
  "extracted API entry resolves shared dispatcher without activating IPC",
  { timeout: 180_000 },
  () => {
    const preload = resolve(scratch, "preload.mjs");
    writeFileSync(
      preload,
      `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/api/dist/env-config.js')) return { format: 'module', shortCircuit: true, source: 'export function loadApiEnv() {} export function resolveApiEnv() { return { host: "127.0.0.1", port: 0 }; }' };
  if (url.endsWith('/api/dist/server/build-server.js')) return { format: 'module', shortCircuit: true, source: 'export async function buildServer() { return { listen: async () => console.log("API_ENTRY_REACHED") }; } export const canReceiveGraphStreamPayload = null, graphUpdateActionForPayload = null, shouldIgnoreGraphStreamPayload = null;' };
  return nextLoad(url, context);
}});
`
    );
    const result = spawnSync(
      process.execPath,
      ["--import", preload, resolve(runtimeRoot, "api/dist/index.js")],
      { cwd: scratch, encoding: "utf8", timeout: 30_000 }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /API_ENTRY_REACHED/);
  }
);

test(
  "extracted server client exchanges IPC with extracted API dispatcher",
  { timeout: 30_000 },
  () => {
    const childScript = resolve(scratch, "dispatcher.mjs");
    const parentScript = resolve(scratch, "client.mjs");
    const apiEntry = resolve(
      runtimeRoot,
      "node_modules/@koed-labs/api/dist/server/index.js"
    );
    const serverClient = resolve(
      runtimeRoot,
      "node_modules/@koed-labs/server/dist/enrollment-fence-ipc-client.js"
    );
    writeFileSync(
      childScript,
      `import assert from 'node:assert/strict';
import { startEnrollmentFenceIpcDispatcher } from ${JSON.stringify(apiEntry)};
const instanceId = '11111111-1111-4111-8111-111111111111';
const epochId = 'a'.repeat(32) + '-' + 'b'.repeat(16);
const operationId = '22222222-2222-4222-8222-222222222222';
const expectedEpoch = { instanceId, epochId };
process.on('error', (error) => { throw error; });
startEnrollmentFenceIpcDispatcher(process, {
  instanceId,
  bind: async () => ({
    instanceId,
    closeAdmission: async () => {},
    createEpoch: () => epochId,
    register: (ids) => { assert.deepEqual(ids, expectedEpoch); return operationId; },
    fenceEpoch: (ids) => { assert.deepEqual(ids, expectedEpoch); return 'drained'; },
    fenceOperation: (ids) => { assert.deepEqual(ids, { ...expectedEpoch, operationId }); return 'pending'; }
  })
});
`
    );
    writeFileSync(
      parentScript,
      `import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EnrollmentFenceIpcClient } from ${JSON.stringify(serverClient)};
const child = fork(${JSON.stringify(childScript)}, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
child.on('error', (error) => { throw error; });
const client = new EnrollmentFenceIpcClient(child, 5000);
try {
  await client.ready();
  await client.bind();
  const epoch = await client.createEpoch();
  const operation = await client.register(epoch);
  assert.equal(await client.fenceOperation(operation), 'pending');
  assert.equal(await client.fenceEpoch(epoch), 'drained');
  assert.deepEqual(await client.close(5000), { status: 'api_barrier_drained' });
} finally {
  if (child.connected) child.disconnect();
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
`
    );
    const result = spawnSync(process.execPath, [parentScript], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 20_000
    });
    assert.equal(result.status, 0, result.stderr);
  }
);
