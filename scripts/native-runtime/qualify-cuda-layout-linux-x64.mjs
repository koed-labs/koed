#!/usr/bin/env node
// Deferred ticket 08 check. This loads CUDA libraries but performs no inference.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { parseArgs } from "node:util";
import { coreManifestName, verifyFrozenCore } from "./core-artifact.mjs";
import {
  assertCudaCoreCompatibility,
  cudaManifestPath,
  verifyFrozenCuda
} from "./cuda-artifact.mjs";
import {
  collectPlatformBinaries,
  linuxLoaderEnvironment,
  linuxLoaderIssues
} from "./loader-validation-lib.mjs";
import { inspectNativeRuntimeContents } from "./content-policy.mjs";
import { sha256File } from "./manifest-lib.mjs";

const { values } = parseArgs({
  options: {
    "core-root": { type: "string" },
    "cuda-root": { type: "string" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});
if (values.help) {
  console.log(
    "Usage: node scripts/native-runtime/qualify-cuda-layout-linux-x64.mjs --core-root <extracted-core> --cuda-root <extracted-cuda> --out-dir <new-evidence-directory>"
  );
} else {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.getuid?.() === 0
  )
    throw new Error(
      "CUDA layout qualification requires an unprivileged Linux x64 user."
    );
  if (!values["core-root"] || !values["cuda-root"] || !values["out-dir"])
    throw new Error("Provide --core-root, --cuda-root and a new --out-dir.");
  const coreRoot = realpathSync(values["core-root"]),
    cudaRoot = realpathSync(values["cuda-root"]);
  const core = verifyFrozenCore(coreRoot),
    cuda = verifyFrozenCuda(cudaRoot);
  assertCudaCoreCompatibility(core, cuda);
  const out = resolve(
    realpathSync(dirname(resolve(values["out-dir"]))),
    basename(values["out-dir"])
  );
  // Evidence must not change either frozen inventory.
  for (const root of [coreRoot, cudaRoot]) {
    const child = relative(root, out);
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
      throw new Error("Evidence must be outside the frozen payloads.");
  }
  mkdirSync(out);
  const work = mkdtempSync(resolve(out, "layout-"));
  const report = {
    ok: false,
    scope: "layout-and-loaders",
    gpuInferenceExecuted: false,
    core: {
      recipeId: core.recipeId,
      manifestSha256: sha256File(resolve(coreRoot, coreManifestName))
    },
    cuda: {
      recipeId: cuda.recipeId,
      manifestSha256: sha256File(resolve(cudaRoot, cudaManifestPath))
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      glibc: process.report.getReport().header.glibcVersionRuntime
    },
    loaderChecks: { core: 0, cuda: 0 },
    hostDriverMissing: false
  };
  try {
    const selection = resolve(work, "native/selections/probe");
    mkdirSync(resolve(selection, "llama.cpp"), { recursive: true });
    mkdirSync(resolve(work, "native/payloads"));
    symlinkSync(coreRoot, resolve(work, "native/payloads/core"));
    symlinkSync(cudaRoot, resolve(work, "native/payloads/cuda"));
    symlinkSync("../../payloads/core/postgres", resolve(selection, "postgres"));
    for (const name of ["llama-server", "cpu", "cuda"])
      symlinkSync(
        `../../../payloads/${name === "cuda" ? "cuda" : "core"}/llama.cpp/${name}`,
        resolve(selection, "llama.cpp", name)
      );
    symlinkSync("selections/probe", resolve(work, "native/current"));
    symlinkSync("native/current/postgres", resolve(work, "postgres"));
    symlinkSync("native/current/llama.cpp", resolve(work, "llama.cpp"));
    for (const [path, root] of [
      ["postgres/bin/postgres", coreRoot],
      ["llama.cpp/llama-server", coreRoot],
      ["llama.cpp/cpu/llama-server", coreRoot],
      ["llama.cpp/cuda/llama-server", cudaRoot]
    ])
      if (
        realpathSync(resolve(work, path)) !== realpathSync(resolve(root, path))
      )
        throw new Error(
          `Composed selection resolved an unexpected payload: ${path}`
        );
    const deadline = Date.now() + 60_000;
    const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    for (const [kind, root] of [
      ["core", coreRoot],
      ["cuda", cudaRoot]
    ]) {
      const contents = inspectNativeRuntimeContents(root);
      if (!contents.ok)
        throw new Error(`Invalid ${kind} content: ${JSON.stringify(contents)}`);
      const binaries = collectPlatformBinaries({
        runtimeRoot: root,
        platform: "linux"
      });
      if (binaries.length === 0)
        throw new Error(`No ELF files found in the ${kind} candidate.`);
      for (const file of binaries) {
        if (Date.now() >= deadline)
          throw new Error(
            "CUDA layout qualification exceeded its one-minute loader deadline."
          );
        const env = file.startsWith(resolve(root, "postgres") + "/")
          ? environment
          : linuxLoaderEnvironment({ file, runtimeRoot: root, environment });
        const result = spawnSync("/usr/bin/ldd", [file], {
          env,
          encoding: "utf8",
          timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024
        });
        const output = (result.stdout ?? "") + (result.stderr ?? "");
        const issues = linuxLoaderIssues({ file, runtimeRoot: root, output });
        if (result.error || result.status !== 0 || issues.length)
          throw new Error(
            `${file}: ${result.error?.message ?? (issues.join(", ") || output)}`
          );
        if (kind === "cuda" && /libcuda\.so\.1\s+=>\s+not found/.test(output))
          report.hostDriverMissing = true;
        report.loaderChecks[kind] += 1;
      }
    }
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
    writeFileSync(
      resolve(out, "cuda-layout-qualification.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx" }
    );
  }
  console.log(JSON.stringify(report, null, 2));
}
