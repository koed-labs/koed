import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { ZERO_VITERBI_BIASES } from "./decoder.js";
import { TOKEN_LABELS } from "./labels.js";
import { NativePrivacyRuntime } from "./native-runtime.js";
import { PrivacyRuntimeManager } from "./runtime-manager.js";
import {
  createNodeHttpServer,
  createPrivacyService,
  listenNodeHttpServer
} from "./server.js";

let fixtureRoot: string;
let fixtureWorker: URL;
const managers: PrivacyRuntimeManager[] = [];

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "koed-privacy-worker-"));
  const source = await readFile(
    new URL("./native-runtime-worker-server.ts", import.meta.url),
    "utf8"
  );
  const dispatcher = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    }
  }).outputText;
  await writeFile(
    join(fixtureRoot, "native-runtime-worker-server.mjs"),
    dispatcher
  );
  await writeFile(
    join(fixtureRoot, "fixture-constants.mjs"),
    `export const ZERO_VITERBI_BIASES = ${JSON.stringify(ZERO_VITERBI_BIASES)};\nexport const TOKEN_LABELS = ${JSON.stringify(TOKEN_LABELS)};\n`
  );
  await copyFile(
    new URL("./fixtures/blocking-native-runtime-worker.mjs", import.meta.url),
    join(fixtureRoot, "blocking-native-runtime-worker.mjs")
  );
  fixtureWorker = pathToFileURL(
    join(fixtureRoot, "blocking-native-runtime-worker.mjs")
  );
});

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

it("keeps real HTTP health responsive while auto CoreML native work blocks its worker", async () => {
  const config = resolveConfig({
    KOED_PRIVACY_TRANSFORMERS_CACHE: join(fixtureRoot, "health-cache"),
    PRIVACY_SERVICE_TOKEN: "fixture-token",
    PRIVACY_RUNTIME_CONTROL_TOKEN: "fixture-control"
  });
  const manager = await PrivacyRuntimeManager.create({
    preference: "auto",
    candidateProviders: ["cpu", "coreml"],
    minimumAutoSpeedupRatio: 0,
    acceleratorIdleUnloadSeconds: 0,
    factory: (provider) =>
      new NativePrivacyRuntime(
        {
          modelId: config.modelId,
          modelRevision: config.modelRevision,
          cacheDir: config.transformersCache,
          classifierHash: "fixture",
          provider
        },
        fixtureWorker
      )
  });
  managers.push(manager);
  const server = createNodeHttpServer(
    createPrivacyService(config, manager),
    config.maxBodyBytes
  );
  await listenNodeHttpServer(server, "127.0.0.1", 0);
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test server port");
    const health = `http://127.0.0.1:${address.port}/health`;
    await vi.waitFor(() =>
      expect(manager.status().switchState).toBe("switching")
    );
    await vi.waitFor(() =>
      expect(
        existsSync(`${config.transformersCache}.coreml-load-started`)
      ).toBe(true)
    );
    const started = performance.now();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(health, {
        signal: AbortSignal.timeout(1_000)
      });
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    await vi.waitFor(() => expect(manager.provider).toBe("coreml"), {
      timeout: 10_000
    });
    expect(manager.status().verifiedProviders).toContain("coreml");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

it("rejects pending native work and clears readiness when its worker exits", async () => {
  const runtime = new NativePrivacyRuntime(
    {
      modelId: "fixture",
      modelRevision: "fixture",
      cacheDir: "/unused-test-cache",
      classifierHash: "fixture",
      provider: "cpu"
    },
    fixtureWorker
  );
  try {
    await runtime.load();
    expect(runtime.isReady()).toBe(true);
    await runtime.unload();
    expect(runtime.isReady()).toBe(false);
    expect((await runtime.classify("after unload")).decodedText).toBe(
      "after unload"
    );
    expect(runtime.isReady()).toBe(true);
    await expect(runtime.classify("__crash_worker__")).rejects.toThrow(
      "worker exited (7)"
    );
    expect(runtime.isReady()).toBe(false);
    expect(runtime.isAlive()).toBe(false);
    await expect(runtime.classify("after crash")).rejects.toThrow(
      "worker exited (7)"
    );
  } finally {
    await runtime.dispose();
  }
});

it("terminates blocked native work without waiting for the worker dispatch queue", async () => {
  const runtime = new NativePrivacyRuntime(
    {
      modelId: "fixture",
      modelRevision: "fixture",
      cacheDir: "/unused-test-cache",
      classifierHash: "fixture",
      provider: "cpu"
    },
    fixtureWorker
  );
  await runtime.load();
  const startedMarker = join(fixtureRoot, "blocked-started");
  const blocked = runtime.classify(`__block_worker__:${startedMarker}`);
  const rejection = expect(blocked).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(existsSync(startedMarker)).toBe(true));
  const started = performance.now();
  await runtime.dispose();
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(runtime.isReady()).toBe(false);
  await rejection;
});

it.each([
  ["__invalid_response__", "invalid response"],
  ["__identity_mismatch__", "identity changed"]
])("fails closed on %s", async (input, message) => {
  const runtime = new NativePrivacyRuntime(
    {
      modelId: "fixture",
      modelRevision: "fixture",
      cacheDir: "/unused-test-cache",
      classifierHash: "fixture",
      provider: "cpu"
    },
    fixtureWorker
  );
  try {
    await runtime.load();
    await expect(runtime.classify(input)).rejects.toThrow(message);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.isAlive()).toBe(false);
  } finally {
    await runtime.dispose();
  }
});
