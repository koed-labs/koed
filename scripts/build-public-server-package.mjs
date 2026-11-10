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
    if (args[i] === "--") continue;
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
      "Koed helps your AI Clients capture and recall useful context while you operate your own memory services. This package installs the Koed command-line tool, which you can use to set up and run Koed’s services.",
      "",
      "Looking for the desktop client? Visit the [Koed GitHub repository](https://github.com/koed-labs/koed).",
      "",
      "## 1. Install Koed",
      "",
      "For a local Personal setup, install Node.js 24 and Homebrew first. Then install the Koed command-line tool:",
      "",
      "```sh",
      `npm install --global @koed-labs/server@${sourceManifest.version}`,
      "```",
      "",
      "## 2. Set up your services",
      "",
      "Install the Base component for your platform using the matching release URLs:",
      "",
      ...["linux-x64", "macos-arm64"].flatMap((target) => {
        const asset = `https://github.com/koed-labs/koed/releases/download/v${sourceManifest.version}/koed-base-${sourceManifest.version}-${target}.tar.gz`;
        return [
          `**${target}**`,
          "",
          "```sh",
          `koed components install --component base --archive-url ${asset} --manifest-url ${asset}.manifest.json --json`,
          "```",
          ""
        ];
      }),
      "Then install the runtime and embedding model:",
      "",
      "```sh",
      "koed runtime install --provider homebrew --dependency-mode bundled-local --json",
      "koed models install --kind embedding --json",
      "```",
      "",
      "The services and dependencies are separate from the npm package and are not downloaded automatically at startup. See the [running guide](https://github.com/koed-labs/koed/blob/main/docs/running-koed.md) for artifact requirements, other platforms, and activation if the component remains staged.",
      "",
      "## 3. Start and check Koed",
      "",
      "Start Koed and leave it running:",
      "",
      "```sh",
      "koed start",
      "```",
      "",
      "Once the API reports ready, open another terminal to set up local credentials and check readiness:",
      "",
      "```sh",
      "koed setup core --json",
      "koed doctor --json",
      "```",
      "",
      "## 4. Connect your AI Client",
      "",
      "For example, with Codex installed and signed in:",
      "",
      "```sh",
      "koed setup codex --json",
      "```",
      "",
      "Restart Codex after setup. For other AI Clients, see the [Koed README](https://github.com/koed-labs/koed#readme). Client setup and authentication are separate from service readiness.",
      "",
      "Need help? The running guide includes platform-specific instructions and troubleshooting. Koed is licensed under Apache-2.0.",
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
    repository: {
      type: "git",
      url: "https://github.com/koed-labs/koed.git"
    },
    license: sourceManifest.license,
    type: "module",
    private: false,
    bin: { koed: "bin/koed.js" },
    engines: { node: ">=24 <27" },
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
