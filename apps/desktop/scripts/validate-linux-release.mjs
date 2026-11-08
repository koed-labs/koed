#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

try {
  const runtimeRoot = resolve(process.argv[2] ?? ".koed-runtime");
  const manifest = JSON.parse(
    readFileSync(resolve(runtimeRoot, "desktop-bundle-manifest.json"), "utf8")
  );
  if (
    manifest.target?.platform !== "linux" ||
    manifest.target?.architecture !== "x64"
  ) {
    throw new Error("Release requires a staged Linux x64 runtime.");
  }
  if (!process.env.KOED_NATIVE_RUNTIME_SOURCE_DIR?.trim()) {
    throw new Error(
      "Release requires KOED_NATIVE_RUNTIME_SOURCE_DIR with native assets."
    );
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Release validation requires a Linux x64 host.");
  }
  const validator = resolve(
    import.meta.dirname,
    "../../../scripts/native-runtime/validate-runtime.mjs"
  );
  const resources = mkdtempSync(resolve(tmpdir(), "koed-linux-release-"));
  try {
    const staged = resolve(resources, "koed-runtime");
    symlinkSync(runtimeRoot, staged, "dir");
    const result = spawnSync(
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
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
