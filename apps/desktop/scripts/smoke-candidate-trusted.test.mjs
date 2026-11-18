import assert from "node:assert/strict";
import { test } from "node:test";
import { smokeCandidate } from "./smoke-candidate-trusted.mjs";

const args = { app: "/tmp/Koed.app", home: "/tmp/isolated", version: "1.2.3" };
const fixtures = () => {
  const calls = [];
  const child = { kill: (signal) => calls.push(signal) };
  return {
    calls,
    runCli: async (executable, cli, env) => {
      calls.push({ executable, cli, env });
      return "1.2.3\n";
    },
    launch: () => ({
      child,
      ready: Promise.resolve(),
      invoke: async (cmd) => {
        calls.push(cmd);
        return { ok: true };
      }
    }),
    wait: async () => calls.push("exit")
  };
};
test("trusted smoke checks bundled CLI version and desktop lifecycle with an isolated environment", async () => {
  const f = fixtures();
  await smokeCandidate(args, f);
  assert.match(
    f.calls[0].cli,
    /app\.asar\/node_modules\/@koed-labs\/server\/dist\/cli\.js$/
  );
  assert.equal(f.calls[0].env.HOME, args.home);
  assert.equal(f.calls[0].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(f.calls[1], "quit");
  assert.equal(f.calls[2], "exit");
});
test("trusted smoke rejects wrong version and failed GUI quit", async () => {
  const f = fixtures();
  await assert.rejects(smokeCandidate({ ...args, version: "9.9.9" }, f));
  f.launch = () => ({
    child: { kill: (signal) => f.calls.push(signal) },
    ready: Promise.resolve(),
    invoke: async () => ({ ok: false })
  });
  await assert.rejects(smokeCandidate(args, f));
  assert.equal(f.calls.at(-1), "SIGKILL");
});
