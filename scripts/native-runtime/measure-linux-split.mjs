#!/usr/bin/env node
// Investigation tooling only. These archives are measurements, not admitted
// release candidates: the core retains the original combined provenance.
import {
  cpSync,
  mkdirSync,
  readlinkSync,
  statSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  deterministicArchiveEntries,
  writeDeterministicTarGz
} from "../deterministic-tar-gzip.mjs";
import { sha256File, writeRuntimeAssetManifest } from "./manifest-lib.mjs";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});
if (values.help) {
  console.log(
    "Usage: node scripts/native-runtime/measure-linux-split.mjs --runtime-root <verified-combined-tree> --out-dir <new-directory>"
  );
} else {
  if (!values["runtime-root"] || !values["out-dir"])
    throw new Error(
      "Provide --runtime-root and a new --out-dir. Verify the source archive digest before extraction."
    );
  const source = resolve(values["runtime-root"]);
  const out = resolve(values["out-dir"]);
  const fromSource = relative(source, out);
  if (!fromSource || (!isAbsolute(fromSource) && !fromSource.startsWith("..")))
    throw new Error("The output directory must be outside the source tree.");
  mkdirSync(out); // Never overwrite prior evidence or an existing installation.
  const reports = [];
  for (const kind of ["core", "cuda"]) {
    const target = resolve(out, kind, "koed-runtime");
    mkdirSync(resolve(target, "llama.cpp"), { recursive: true });
    const entries =
      kind === "core"
        ? [
            "postgres",
            "llama.cpp/cpu",
            "llama.cpp/llama-server",
            "provenance.json"
          ]
        : ["llama.cpp/cuda"];
    for (const entry of entries)
      cpSync(resolve(source, entry), resolve(target, entry), {
        recursive: true,
        verbatimSymlinks: true
      });
    if (kind === "core")
      writeRuntimeAssetManifest({
        runtimeRoot: target,
        platform: "linux",
        architecture: "x64"
      });
    const archive = resolve(out, `measurement-${kind}.tar.gz`);
    writeDeterministicTarGz({
      sourceDir: target,
      rootName: "koed-runtime",
      tarPath: archive,
      streaming: true
    });
    const inventory = deterministicArchiveEntries(target);
    reports.push({
      kind,
      archiveBytes: statSync(archive).size,
      sha256: sha256File(archive),
      regularBytes: inventory
        .filter((entry) => entry.type === "file")
        .reduce((total, entry) => total + entry.stat.size, 0),
      links: inventory
        .filter((entry) => entry.type === "symlink")
        .map((entry) => ({
          path: entry.relativePath,
          target: readlinkSync(entry.path)
        })),
      largest: inventory
        .filter((entry) => entry.type === "file")
        .sort((a, b) => b.stat.size - a.stat.size)
        .slice(0, 12)
        .map((entry) => ({ path: entry.relativePath, bytes: entry.stat.size }))
    });
  }
  const report = { schemaVersion: 1, purpose: "measurement-only", reports };
  writeFileSync(
    resolve(out, "split-measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" }
  );
  console.log(JSON.stringify(report, null, 2));
}
