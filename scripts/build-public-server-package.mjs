#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createPackageReleaseIdentity } from "./package-release-identity.mjs";
import {
  bundleControlPlane,
  readControlPlaneCatalog,
  writeControlPlaneLauncher
} from "./control-plane-bundle.mjs";

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
  const catalog = readControlPlaneCatalog({
    repoRoot,
    version: sourceManifest.version
  });
  const packageRoot = resolve(options.outDir, "package");
  const vendorRoot = resolve(packageRoot, "vendor");
  const tarballDir = resolve(options.outDir, "tarballs");
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(vendorRoot, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });
  const built = await bundleControlPlane({
    repoRoot,
    vendorRoot,
    version: sourceManifest.version,
    catalog
  });
  const binRoot = resolve(packageRoot, "bin");
  mkdirSync(binRoot, { recursive: true });
  const launcher = resolve(binRoot, "koed.js");
  writeControlPlaneLauncher(launcher, "../vendor/control-plane.js");
  copyFileSync(resolve(repoRoot, "LICENSE"), resolve(packageRoot, "LICENSE"));
  writeFileSync(
    resolve(packageRoot, "README.md"),
    [
      "# @koed-labs/server",
      "",
      "Koed Self-Hosted control plane. Requires Node.js >=24 <25.",
      "",
      "Base and Privacy components are admitted by canonical manifest SHA-256 pins embedded in this control-plane version. Archive bytes are verified against the pinned manifest. Component signing keys and detached signature sidecars are not required.",
      "",
      "Install an offline Base component for the matching product version and target (Linux x64 example):",
      "",
      "```sh",
      `koed components install --component base --archive /path/to/koed-base-${sourceManifest.version}-linux-x64.tar.gz --manifest /path/to/koed-base-${sourceManifest.version}-linux-x64.tar.gz.manifest.json --json`,
      "```",
      "",
      "Use the original release archive filename. Online installation accepts --archive-url and --manifest-url over HTTPS instead of local paths.",
      ""
    ].join("\n")
  );
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
    files: [
      "bin/koed.js",
      "vendor/**/*",
      "README.md",
      "LICENSE",
      "third-party-notices.json"
    ]
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
  const releaseIdentity = createPackageReleaseIdentity({
    packageRoot,
    tarball: expectedTarball,
    version: sourceManifest.version
  });
  if (output[0].integrity !== releaseIdentity.npm.integrity)
    throw new Error("npm pack integrity differs from packed tarball bytes.");
  const releaseIdentityPath = resolve(
    tarballDir,
    "koed-labs-server-release-identity.json"
  );
  writeFileSync(
    releaseIdentityPath,
    `${JSON.stringify(releaseIdentity, null, 2)}\n`
  );
  console.log(
    JSON.stringify(
      {
        packageRoot,
        tarball: expectedTarball,
        releaseIdentity: releaseIdentityPath,
        bundledInputs: Object.keys(built.metafile.inputs).length
      },
      null,
      2
    )
  );
};

await main();
