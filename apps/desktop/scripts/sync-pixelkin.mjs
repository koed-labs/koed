#!/usr/bin/env node
// Copies the Pixelkin engine from a local pixelkin-lab checkout into the
// renderer. Until that repository is public, this copy is how Koed gets the
// engine; vendor/SOURCE.json records the version and commit it came from.
//
//   pnpm --filter @koed-labs/desktop pixelkin:sync ../pixelkin-lab
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";

const vendor = new URL("../src/renderer/v1/pixelkin/vendor/", import.meta.url);
const [source, ...flags] = process.argv.slice(2);
if (!source) {
  console.error(
    "Usage: pnpm --filter @koed-labs/desktop pixelkin:sync <pixelkin-lab checkout> [--allow-dirty]"
  );
  process.exit(1);
}

// pnpm runs the script from apps/desktop; INIT_CWD is where it was invoked.
const root = resolve(process.env.INIT_CWD ?? process.cwd(), source);
const manifest = join(root, "package.json");
const pkg = existsSync(manifest)
  ? JSON.parse(await readFile(manifest, "utf8"))
  : null;
if (pkg?.name !== "@koed-labs/pixelkin" || !Array.isArray(pkg.files)) {
  console.error(`${root} is not a pixelkin-lab checkout.`);
  process.exit(1);
}
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain") && !flags.includes("--allow-dirty")) {
  console.error(
    `${root} has uncommitted changes; commit them or pass --allow-dirty.`
  );
  process.exit(1);
}

await rm(vendor, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
const files = {};
for (const file of pkg.files) {
  const name = basename(file);
  if (files[name]) throw new Error(`Two packaged files are named ${name}`);
  await copyFile(join(root, file), new URL(name, vendor));
  files[name] = createHash("sha256")
    .update(await readFile(new URL(name, vendor)))
    .digest("hex");
}
const record = {
  package: pkg.name,
  version: pkg.version,
  commit: git("rev-parse", "HEAD"),
  files
};
await writeFile(
  new URL("SOURCE.json", vendor),
  `${JSON.stringify(record, null, 2)}\n`
);
console.log(
  `Copied ${pkg.name}@${pkg.version} (${record.commit.slice(0, 7)}) into the renderer.`
);
