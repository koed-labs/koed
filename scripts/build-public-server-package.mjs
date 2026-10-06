#!/usr/bin/env node
import { build } from "esbuild";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/koed-server/package.json"), "utf8")
);
const parseArgs = (args) => {
  const out = { outDir: resolve(repoRoot, "dist/public-server-package") };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out-dir") out.outDir = resolve(args[++i]);
    else if (args[i] === "--help" || args[i] === "-h") out.help = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return out;
};

const packageRootFromInput = (input) => {
  const index = input.lastIndexOf("/node_modules/");
  if (index < 0) return null;
  const packageNodeModulesRoot = input.slice(
    0,
    index + "/node_modules/".length
  );
  let rest = input.slice(index + "/node_modules/".length);
  const first = rest.split("/")[0];
  if (first.startsWith("@")) rest = rest.slice(first.length + 1);
  const packageName = first.startsWith("@")
    ? `${first}/${rest.split("/")[0]}`
    : first;
  const root = resolve(packageNodeModulesRoot, packageName);
  return existsSync(resolve(root, "package.json")) ? root : null;
};

const buildNotices = (metafile, destination) => {
  const roots = new Set(
    Object.keys(metafile.inputs)
      .map((input) => packageRootFromInput(resolve(repoRoot, input)))
      .filter(Boolean)
  );
  const notices = [];
  for (const root of [...roots].sort()) {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8")
    );
    const licenseFile = readdirSync(root).find((name) =>
      /^(?:LICENSE|LICENCE|COPYING)(?:\.|$)/i.test(name)
    );
    notices.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "UNSPECIFIED",
      ...(licenseFile
        ? { licenseText: readFileSync(resolve(root, licenseFile), "utf8") }
        : {})
    });
  }
  if (notices.some((notice) => notice.license === "UNSPECIFIED"))
    throw new Error("Bundled dependency is missing license metadata.");
  writeFileSync(destination, `${JSON.stringify(notices, null, 2)}\n`);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/build-public-server-package.mjs [--out-dir <directory>]"
    );
    return;
  }
  const packageRoot = resolve(options.outDir, "package");
  const vendorRoot = resolve(packageRoot, "vendor");
  const tarballDir = resolve(options.outDir, "tarballs");
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(vendorRoot, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });
  const built = await build({
    absWorkingDir: repoRoot,
    entryPoints: ["packages/koed-server/dist/cli.js"],
    outdir: vendorRoot,
    entryNames: "control-plane",
    chunkNames: "chunk-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "bundle",
    metafile: true,
    sourcemap: false,
    legalComments: "none"
  });
  const unresolvedImports = Object.values(built.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter(
      (item) =>
        item.external &&
        !item.path.startsWith("node:") &&
        !builtinModules.includes(item.path)
    );
  if (unresolvedImports.length > 0)
    throw new Error(
      `Control-plane bundle has unresolved external imports: ${unresolvedImports.map((item) => item.path).join(", ")}`
    );
  const binRoot = resolve(packageRoot, "bin");
  mkdirSync(binRoot, { recursive: true });
  const launcher = resolve(binRoot, "koed.js");
  writeFileSync(
    launcher,
    [
      "#!/usr/bin/env node",
      'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error(`@koed-labs/server requires Node.js >=24 <25; found ${process.versions.node}.`); process.exit(1); }',
      'const { runKoedServerCli, shouldExitPackagedSupervisor } = await import("../vendor/control-plane.js");',
      "const args = process.argv.slice(2);",
      "const exitCode = await runKoedServerCli(args);",
      "if (shouldExitPackagedSupervisor(args)) process.exit(exitCode);",
      "process.exitCode = exitCode;",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  chmodSync(launcher, 0o755);
  copyFileSync(resolve(repoRoot, "LICENSE"), resolve(packageRoot, "LICENSE"));
  buildNotices(
    built.metafile,
    resolve(packageRoot, "third-party-notices.json")
  );

  const manifest = {
    name: "@koed-labs/server",
    version: sourceManifest.version,
    description: "Koed Self-Hosted control plane",
    license: sourceManifest.license,
    type: "module",
    private: false,
    bin: { koed: "bin/koed.js" },
    engines: { node: ">=24 <25" },
    publishConfig: { access: "public" },
    files: ["bin/koed.js", "vendor/**/*", "LICENSE", "third-party-notices.json"]
  };
  writeFileSync(
    resolve(packageRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const packed = spawnSync(
    "npm",
    ["pack", packageRoot, "--json", "--pack-destination", tarballDir],
    {
      cwd: options.outDir,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true" }
    }
  );
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const output = JSON.parse(packed.stdout);
  const tarball = resolve(tarballDir, output[0].filename);
  const expectedTarball = resolve(tarballDir, "koed-labs-server.tgz");
  if (tarball !== expectedTarball) {
    const { renameSync } = await import("node:fs");
    renameSync(tarball, expectedTarball);
  }
  console.log(
    JSON.stringify(
      {
        packageRoot,
        tarball: expectedTarball,
        bundledInputs: Object.keys(built.metafile.inputs).length
      },
      null,
      2
    )
  );
};

await main();
