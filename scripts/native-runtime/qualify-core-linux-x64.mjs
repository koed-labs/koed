#!/usr/bin/env node
// Explicit candidate qualification. No Koed startup, asset downloads, or CUDA.
import { execFile, spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { coreManifestName, verifyFrozenCore } from "./core-artifact.mjs";
import {
  collectPlatformBinaries,
  linuxLoaderEnvironment,
  linuxLoaderIssues
} from "./loader-validation-lib.mjs";
import { inspectNativeRuntimeContents } from "./content-policy.mjs";
import { sha256File } from "./manifest-lib.mjs";

const modelSha256 =
  "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439";
const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    "model-path": { type: "string" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});
if (values.help) {
  console.log(
    "Usage: node scripts/native-runtime/qualify-core-linux-x64.mjs --runtime-root <verified-extracted-core> --model-path <installed-Qwen3-model> --out-dir <new-evidence-directory>"
  );
} else {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.getuid?.() === 0
  )
    throw new Error(
      "CPU qualification requires an unprivileged Linux x64 user."
    );
  if (!values["runtime-root"] || !values["model-path"] || !values["out-dir"])
    throw new Error(
      "Provide --runtime-root, --model-path and a new --out-dir. No assets or models are downloaded."
    );
  const root = resolve(values["runtime-root"]);
  const manifest = verifyFrozenCore(root);
  const model = resolve(values["model-path"]);
  if (sha256File(model) !== modelSha256)
    throw new Error(
      "The installed qualification model does not match its pinned SHA-256."
    );
  const out = resolve(values["out-dir"]);
  mkdirSync(out);
  const work = mkdtempSync(resolve(out, "probe-"));
  const environment = {
    ...process.env,
    KOED_LLAMA_SERVER_BACKEND: "cpu",
    KOED_EMBEDDING_ACCELERATION: "cpu",
    LANG: "C",
    LC_ALL: "C"
  };
  delete environment.LD_LIBRARY_PATH;
  delete environment.LD_PRELOAD;
  const abort = new AbortController();
  const deadlineTimer = setTimeout(
    () =>
      abort.abort(
        new Error("CPU qualification exceeded its three-minute deadline.")
      ),
    180_000
  );
  deadlineTimer.unref();
  const interrupt = () =>
    abort.abort(new Error("CPU qualification interrupted."));
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const execute = promisify(execFile);
  const run = async (command, args, options = {}) =>
    execute(command, args, {
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      signal: abort.signal,
      ...options
    });
  const freePort = () =>
    new Promise((accept, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close((error) => (error ? reject(error) : accept(port)));
      });
    });
  const selected = resolve(work, "runtime");
  mkdirSync(resolve(selected, "native/selections/probe/llama.cpp"), {
    recursive: true
  });
  mkdirSync(resolve(selected, "native/payloads"));
  symlinkSync(root, resolve(selected, "native/payloads/core"));
  symlinkSync(
    "../../payloads/core/postgres",
    resolve(selected, "native/selections/probe/postgres")
  );
  for (const name of ["cpu", "llama-server"])
    symlinkSync(
      `../../../payloads/core/llama.cpp/${name}`,
      resolve(selected, `native/selections/probe/llama.cpp/${name}`)
    );
  symlinkSync("selections/probe", resolve(selected, "native/current"));
  symlinkSync("native/current/postgres", resolve(selected, "postgres"));
  symlinkSync("native/current/llama.cpp", resolve(selected, "llama.cpp"));
  const pg = (name) => resolve(selected, "postgres/bin", name);
  const data = resolve(work, "data"),
    socket = resolve(work, "socket");
  mkdirSync(socket);
  let postgresAttempted = false,
    embedding;
  let embeddingExited;
  const log = createWriteStream(resolve(out, "embedding.log"));
  const report = {
    ok: false,
    recipeId: manifest.recipeId,
    runtimeVersion: manifest.runtimeVersion,
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      glibc: process.report.getReport().header.glibcVersionRuntime
    },
    manifestSha256: sha256File(resolve(root, coreManifestName)),
    modelSha256,
    cudaExecuted: false
  };
  try {
    const contents = inspectNativeRuntimeContents(root);
    if (!contents.ok)
      throw new Error(`Invalid CPU content: ${JSON.stringify(contents)}`);
    const binaries = collectPlatformBinaries({
      runtimeRoot: root,
      platform: "linux"
    });
    for (const file of binaries) {
      const env = file.startsWith(resolve(root, "postgres") + "/")
        ? environment
        : linuxLoaderEnvironment({ file, runtimeRoot: root, environment });
      const result = await run("ldd", [file], { env, timeout: 5_000 });
      const issues = linuxLoaderIssues({
        file,
        runtimeRoot: root,
        output: result.stdout + result.stderr
      });
      if (issues.length) throw new Error(`${file}: ${issues.join(", ")}`);
    }
    report.loaderChecks = binaries.length;
    const llama = resolve(selected, "llama.cpp/llama-server");
    for (const policy of ["auto", "cpu"])
      await run(llama, ["--version"], {
        env: { ...environment, KOED_LLAMA_SERVER_BACKEND: policy }
      });
    report.launcherPolicies = ["auto", "cpu"];
    await run(pg("initdb"), [
      "-D",
      data,
      "--auth=trust",
      "--username=koed",
      "--no-locale"
    ]);
    const pgPort = await freePort();
    const start = () =>
      run(pg("pg_ctl"), [
        "-D",
        data,
        "-l",
        resolve(out, "postgres.log"),
        "-o",
        `-p ${pgPort} -k '${socket.replaceAll("'", "'\\''")}' -c listen_addresses=''`,
        "-w",
        "-t",
        "20",
        "start"
      ]);
    postgresAttempted = true;
    await start();
    const sql = (statement) =>
      run(pg("psql"), [
        "-h",
        socket,
        "-p",
        String(pgPort),
        "-U",
        "koed",
        "-d",
        "postgres",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement
      ]);
    await sql("CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;");
    const vector = await sql(
      "SELECT extversion FROM pg_extension WHERE extname='vector';"
    );
    if (vector.stdout.trim() !== manifest.components.pgvector.version)
      throw new Error(
        "Loaded pgvector version differs from the native contract."
      );
    await run(pg("pg_ctl"), [
      "-D",
      data,
      "-w",
      "-t",
      "20",
      "-m",
      "fast",
      "stop"
    ]);
    await start();
    const distance = await sql(
      "SELECT '[1,2,3]'::vector <=> '[1,2,3]'::vector;"
    );
    if (distance.stdout.trim() !== "0")
      throw new Error("Postgres vector probe failed after restart.");
    report.postgres = {
      initialized: true,
      restarted: true,
      pgvector: vector.stdout.trim(),
      pgcrypto: true
    };
    const port = await freePort();
    embedding = spawn(
      llama,
      [
        "--model",
        model,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--embedding",
        "--pooling",
        "last",
        "--ctx-size",
        "512",
        "--batch-size",
        "512",
        "--ubatch-size",
        "512",
        "--parallel",
        "1",
        "--threads",
        "2",
        "--n-gpu-layers",
        "0"
      ],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] }
    );
    embeddingExited = new Promise((accept) => {
      embedding.once("close", accept);
      embedding.once("error", (error) => {
        report.embeddingStartError = error.message;
      });
    });
    embedding.stdout.pipe(log, { end: false });
    embedding.stderr.pipe(log, { end: false });
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      if (
        report.embeddingStartError ||
        embedding.exitCode !== null ||
        embedding.signalCode !== null
      )
        throw new Error("CPU embedding process exited before readiness.");
      try {
        ready = (
          await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1000)])
          })
        ).ok;
      } catch {
        /* Readiness retries share a fixed deadline. */
      }
      if (ready) break;
      await delay(200, undefined, { signal: abort.signal });
    }
    if (!ready) throw new Error("CPU embedding readiness timed out.");
    const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qualification",
        input: [
          "Remember the project deadline is Friday.",
          "Postgres stores vectors for semantic recall."
        ]
      }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])
    });
    if (!response.ok)
      throw new Error(
        `CPU embedding request failed with HTTP ${response.status}.`
      );
    const vectors = (await response.json()).data?.map(
      (entry) => entry.embedding
    );
    if (
      !Array.isArray(vectors) ||
      vectors.length !== 2 ||
      vectors.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length !== 1024 ||
          !vector.every(Number.isFinite) ||
          vector.every((value) => value === 0)
      )
    )
      throw new Error(
        "CPU embeddings are empty, non-finite, or dimensionally incompatible."
      );
    report.embedding = {
      backend: "cpu",
      inputs: 2,
      dimensions: 1024,
      finite: true,
      nonzero: true
    };
    verifyFrozenCore(root);
    report.ok = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (
      embedding &&
      embedding.exitCode === null &&
      embedding.signalCode === null
    ) {
      embedding.kill("SIGTERM");
      const force = setTimeout(() => embedding.kill("SIGKILL"), 5_000);
      try {
        await embeddingExited;
      } finally {
        clearTimeout(force);
      }
    }
    log.end();
    if (postgresAttempted) {
      try {
        await run(
          pg("pg_ctl"),
          ["-D", data, "-w", "-t", "20", "-m", "immediate", "stop"],
          { signal: undefined }
        );
      } catch (error) {
        report.ok = false;
        report.cleanupError = error.message;
      }
    }
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
    clearTimeout(deadlineTimer);
    if (!report.cleanupError) rmSync(work, { recursive: true, force: true });
    writeFileSync(
      resolve(out, "qualification.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
