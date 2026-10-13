// Validate a staged standalone runtime without changing normal client profiles.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const runtime = resolve(process.argv[2]);
const mcp = join(runtime, "node_modules/@koed/mcp-server");
const operator = join(runtime, "node_modules/@koed/koed-server/dist");
const load = (file) => import(pathToFileURL(file).href);
const { repairCodexIntegration } = await load(join(operator, "setup.js"));
const { installPiPackageTransaction } = await load(
  join(operator, "pi-package-transaction.mjs")
);
const root = mkdtempSync(join(tmpdir(), "koed-packaged-readiness-"));
const checks = {};
try {
  const environment = {
    KOED_HOME: join(root, "koed"),
    KOED_REPO_ROOT: root,
    KOED_JS_RUNTIME_ROOT: runtime,
    CODEX_CONFIG_PATH: join(root, "codex/config.toml"),
    MEMORY_CODEX_APP_SERVER_BINARY: process.execPath
  };
  mkdirSync(join(environment.KOED_HOME, "config"), { recursive: true });
  writeFileSync(
    join(environment.KOED_HOME, "config/local-app-credential.json"),
    JSON.stringify({ apiToken: "synthetic-fixture-token" }),
    { mode: 0o600 }
  );
  const repair = () => repairCodexIntegration({ environment });
  assert.equal(repair().ok, true);
  const fresh = readFileSync(environment.CODEX_CONFIG_PATH, "utf8");
  assert.ok(fresh.includes("codex-memory-hook.js"));
  assert.ok(fresh.includes('KOED_CODEX_STOP_DELIVERY = "1"'));
  checks.freshCodexSetup = true;
  writeFileSync(
    environment.CODEX_CONFIG_PATH,
    'model = "preserved-model"\n' +
      fresh
        .replace(
          'KOED_CODEX_STOP_DELIVERY = "1"',
          'KOED_CODEX_STOP_DELIVERY = "0"'
        )
        .replaceAll("codex-memory-hook.js", "older-memory-hook.js")
  );
  assert.equal(repair().ok, true);
  const updated = readFileSync(environment.CODEX_CONFIG_PATH, "utf8");
  assert.ok(updated.includes('model = "preserved-model"'));
  assert.ok(updated.includes('KOED_CODEX_STOP_DELIVERY = "0"'));
  assert.ok(!updated.includes("older-memory-hook.js"));
  checks.olderCodexUpdatePreservesOptOut = true;
  const target = join(root, "pi");
  const install = () =>
    installPiPackageTransaction({
      source: join(mcp, "integrations/pi"),
      target,
      install: () => true,
      installSucceeded: (result) => result === true
    });
  assert.equal(install().ok, true);
  writeFileSync(
    join(target, "extensions/koed.mjs"),
    "// representative older extension\n"
  );
  writeFileSync(join(target, "obsolete-module.mjs"), "// older asset\n");
  assert.equal(install().ok, true);
  assert.equal(existsSync(join(target, "obsolete-module.mjs")), false);
  for (const file of [
    "memory-answer-delivery-policy.mjs",
    "memory-answer-delivery-policy.d.mts",
    "pi-memory-delivery.mjs",
    "pi-memory-delivery.d.mts",
    "extensions/koed.mjs"
  ])
    assert.deepEqual(
      readFileSync(join(target, file)),
      readFileSync(join(mcp, "integrations/pi", file))
    );
  checks.freshAndUpdatedPiAssets = true;
  const { memoryAnswerInputSchema, memoryAnswerAdapterInputSchema } =
    await load(join(mcp, "dist/memory-tool-schemas.js"));
  const { splitMemoryAnswerDeliveryInput } = await load(
    join(target, "memory-answer-delivery-policy.mjs")
  );
  for (const mode of [undefined, "auto", "blocking", "non_blocking"]) {
    const input = memoryAnswerAdapterInputSchema.parse({
      query: "synthetic fixture",
      ...(mode ? { delivery_mode: mode } : {})
    });
    assert.ok(
      memoryAnswerInputSchema.safeParse(
        splitMemoryAnswerDeliveryInput(input).executionInput
      ).success
    );
  }
  checks.strictExecutionSchema = true;
  const hashes = Object.fromEntries(
    [
      "codex-global-agent-guidance.md",
      "memory-answer-tool-description.md",
      "mcp-server-instructions.md"
    ].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(mcp, "dist/prompts", file)))
        .digest("hex")
    ])
  );
  process.stdout.write(
    JSON.stringify(
      {
        checks,
        passed: true,
        hashes,
        scope:
          "Staged runtime, temporary profiles, synthetic API Token. Pi registration callback is simulated; real SDK installation/lifecycle is validated separately."
      },
      null,
      2
    ) + "\n"
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
