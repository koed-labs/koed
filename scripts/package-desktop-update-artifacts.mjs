import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, renameSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const desktopRoot = resolve(repositoryRoot, "apps/desktop");

export function buildElectronBuilderCommand(configPath) {
  if (!configPath) throw new Error("electron-builder config path is required");
  return [
    "exec",
    "electron-builder",
    "--config",
    configPath,
    "--mac",
    "dir",
    "dmg",
    "zip"
  ];
}

export function packageDesktopUpdateArtifacts({
  configPath,
  env = process.env
} = {}) {
  const absoluteConfig = resolve(
    repositoryRoot,
    configPath ?? "apps/desktop/electron-builder.yml"
  );
  if (!existsSync(absoluteConfig))
    throw new Error(`Missing electron-builder config: ${absoluteConfig}`);
  execFileSync(
    "pnpm",
    ["--filter", "@koed/desktop", "package:workspace:build"],
    { cwd: repositoryRoot, stdio: "inherit", env }
  );
  execFileSync("pnpm", ["--filter", "@koed/desktop", "package:runtime"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env
  });
  for (const target of ["release/mac", "release/mac-arm64"])
    rmSync(resolve(desktopRoot, target), { recursive: true, force: true });
  const releaseRoot = resolve(desktopRoot, "release");
  if (existsSync(releaseRoot)) {
    for (const entry of readdirSync(releaseRoot, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^(?:Koed-.+\.(?:dmg|zip)(?:\.blockmap)?|latest-mac\.yml)$/.test(
          entry.name
        )
      ) {
        rmSync(resolve(releaseRoot, entry.name), { force: true });
      }
    }
  }
  const configForProject = basename(absoluteConfig);
  execFileSync("pnpm", buildElectronBuilderCommand(configForProject), {
    cwd: desktopRoot,
    stdio: "inherit",
    env: {
      ...env,
      KOED_ADHOC_SIGN_MACOS_APP: "true",
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
    }
  });
  const generatedDir = resolve(desktopRoot, "release/mac-arm64");
  if (!existsSync(generatedDir))
    throw new Error(`electron-builder did not create ${generatedDir}`);
  renameSync(generatedDir, resolve(desktopRoot, "release/mac"));
  return {
    config: absoluteConfig,
    command: buildElectronBuilderCommand(configForProject),
    output: resolve(desktopRoot, "release")
  };
}

if (process.argv[1]?.endsWith("package-desktop-update-artifacts.mjs")) {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false }
    },
    strict: true
  });
  try {
    const result = packageDesktopUpdateArtifacts({ configPath: values.config });
    process.stdout.write(
      `${values.json ? JSON.stringify({ ok: true, ...result }) : `Packaged Desktop artifacts with ${result.config}`}\n`
    );
  } catch (error) {
    process.stderr.write(
      `Desktop artifact packaging failed: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}
