#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = path.join(root, "apps", "history-browser");
const target = path.join(serviceDir, "koed-history-browser");
const mode = process.argv[2];
const loadedEnv = loadEnv(
  process.env.NODE_ENV ?? "development",
  serviceDir,
  ""
);
const runtimeEnv = { ...loadedEnv, ...process.env };
const token =
  runtimeEnv.HISTORY_BROWSER_GITHUB_TOKEN ?? runtimeEnv.GITHUB_TOKEN ?? "";

const optional =
  (mode === "build" || mode === "typecheck") &&
  (runtimeEnv.CI === "true" || runtimeEnv.HISTORY_BROWSER_OPTIONAL === "1");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function pnpm(args, env = runtimeEnv) {
  run(
    "corepack",
    ["pnpm@11.1.2", "-C", "apps/history-browser/koed-history-browser", ...args],
    {
      env: {
        ...env,
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        COREPACK_ENABLE_STRICT: "0"
      }
    }
  );
}

if (!mode || !["build", "dev", "preview", "typecheck"].includes(mode)) {
  console.error(
    "Usage: node scripts/history-browser.mjs <build|dev|preview|typecheck>"
  );
  process.exit(1);
}

if (optional && !fs.existsSync(target) && !token) {
  console.log(
    "History browser source is private and no GitHub token is available; skipping optional history-browser build."
  );
  process.exit(0);
}

run(
  process.execPath,
  [path.join(root, "scripts", "sync-history-browser.mjs")],
  {
    env: runtimeEnv
  }
);

if (mode !== "preview") {
  pnpm([
    "--config.package-manager-strict=false",
    "install",
    "--ignore-scripts",
    "--frozen-lockfile=false"
  ]);
}

if (mode === "build") {
  pnpm(
    [
      "--config.package-manager-strict=false",
      "--filter",
      "@koed-labs/web",
      "build"
    ],
    {
      ...runtimeEnv,
      VITE_KOED_HISTORY_BROWSER: "1",
      VITE_KOED_API_BASE_URL:
        runtimeEnv.VITE_KOED_API_BASE_URL ??
        runtimeEnv.VITE_API_BASE_URL ??
        "http://localhost:3000"
    }
  );
} else if (mode === "dev") {
  pnpm(
    [
      "--config.package-manager-strict=false",
      "--filter",
      "@koed-labs/web",
      "dev",
      "--",
      "--host",
      "0.0.0.0"
    ],
    {
      ...runtimeEnv,
      VITE_KOED_HISTORY_BROWSER: "1",
      VITE_KOED_API_BASE_URL:
        runtimeEnv.VITE_KOED_API_BASE_URL ??
        runtimeEnv.VITE_API_BASE_URL ??
        "http://localhost:3000"
    }
  );
} else if (mode === "preview") {
  pnpm(["--filter", "@koed-labs/web", "preview", "--", "--host", "0.0.0.0"]);
} else if (mode === "typecheck") {
  pnpm([
    "--config.package-manager-strict=false",
    "--filter",
    "@koed-labs/web",
    "typecheck"
  ]);
}
