#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";
import { verifyFrozenCore } from "../../../scripts/native-runtime/core-artifact.mjs";

const fileSha256 = (path) => {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;)
      hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
};

// Desktop staging copies the validated native runtime verbatim into its own
// runtime, alongside the bundled server node_modules. Require every source
// entry to be present unchanged, so the AppImage cannot carry a native runtime
// that differs from the validated one.
export function assertStagedNativeRuntimeMatches({ source, staged }) {
  const mismatches = [];
  const visit = (relative) => {
    const from = lstatSync(join(source, relative));
    let to;
    try {
      to = lstatSync(join(staged, relative));
    } catch {
      mismatches.push(`missing: ${relative}`);
      return;
    }
    if (from.isSymbolicLink()) {
      if (
        !to.isSymbolicLink() ||
        readlinkSync(join(source, relative)) !==
          readlinkSync(join(staged, relative))
      )
        mismatches.push(`symlink differs: ${relative}`);
    } else if (from.isDirectory()) {
      if (!to.isDirectory()) mismatches.push(`not a directory: ${relative}`);
      else
        for (const name of readdirSync(join(source, relative)).sort())
          visit(join(relative, name));
    } else if (from.isFile()) {
      if (
        !to.isFile() ||
        (from.mode & 0o777) !== (to.mode & 0o777) ||
        from.size !== to.size ||
        fileSha256(join(source, relative)) !==
          fileSha256(join(staged, relative))
      )
        mismatches.push(`file differs: ${relative}`);
    } else mismatches.push(`unsupported entry: ${relative}`);
  };
  for (const name of readdirSync(source).sort()) visit(name);
  if (mismatches.length)
    throw new Error(
      `Staged Desktop runtime differs from validated native runtime:\n${mismatches.slice(0, 20).join("\n")}`
    );
}

export function validateLinuxRelease({
  runtimeRoot: root,
  platform = process.platform,
  arch = process.arch,
  nativeRuntimeSource = process.env.KOED_NATIVE_RUNTIME_SOURCE_DIR,
  runValidator = spawnSync,
  verifyCore = verifyFrozenCore
}) {
  const runtimeRoot = resolve(root ?? ".koed-runtime");
  const manifest = JSON.parse(
    readFileSync(resolve(runtimeRoot, "desktop-bundle-manifest.json"), "utf8")
  );
  if (
    manifest.target?.platform !== "linux" ||
    manifest.target?.architecture !== "x64"
  ) {
    throw new Error("Release requires a staged Linux x64 runtime.");
  }
  if (!nativeRuntimeSource?.trim()) {
    throw new Error(
      "Release requires KOED_NATIVE_RUNTIME_SOURCE_DIR with native assets."
    );
  }
  if (platform !== "linux" || arch !== "x64") {
    throw new Error("Release validation requires a Linux x64 host.");
  }
  const validator = resolve(
    import.meta.dirname,
    "../../../scripts/native-runtime/validate-runtime.mjs"
  );
  // Validate the native runtime source itself; Desktop's staged runtime also
  // holds bundled JS node_modules that the native content policy does not cover.
  const source = resolve(nativeRuntimeSource);
  const resources = mkdtempSync(resolve(tmpdir(), "koed-linux-release-"));
  try {
    const staged = resolve(resources, "koed-runtime");
    symlinkSync(source, staged, "dir");
    const result = runValidator(
      process.execPath,
      [validator, "--runtime-root", staged, "--platform", "linux", "--json"],
      {
        cwd: resolve(import.meta.dirname, "../../.."),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024
      }
    );
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    const report = JSON.parse(result.stdout);
    if (
      result.status !== 0 ||
      !report.ok ||
      report.packagedProvider?.skipped !== false ||
      !report.packagedProvider.ok
    ) {
      throw new Error(
        `Linux native runtime validation failed: ${result.stdout}`
      );
    }
    // Linux Desktop bundles only the frozen CPU core (ADR 0067). The CUDA
    // add-on is a separate, optional release asset and never ships inside the
    // AppImage; the frozen inventory rejects any extra native file.
    try {
      verifyCore(source);
    } catch (error) {
      throw new Error(
        `Linux Desktop requires the frozen native CPU core: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    if (
      lstatSync(join(runtimeRoot, "llama.cpp/cuda"), { throwIfNoEntry: false })
    )
      throw new Error(
        "Linux Desktop must not bundle the CUDA add-on (llama.cpp/cuda)."
      );
    assertStagedNativeRuntimeMatches({ source, staged: runtimeRoot });
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    validateLinuxRelease({ runtimeRoot: process.argv[2] });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
