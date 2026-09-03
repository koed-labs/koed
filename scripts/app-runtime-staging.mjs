import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const appRuntimePackages = [
  { directory: "api", package: "api", entries: ["dist/index.js"] },
  { directory: "worker", package: "worker", entries: ["dist/index.js"] },
  {
    directory: "embedding-service",
    package: "embedding-service",
    entries: ["dist/index.js"]
  },
  {
    directory: "privacy-service",
    package: "privacy-service",
    entries: ["dist/index.js"]
  },
  {
    directory: "mcp-server",
    package: "mcp-server",
    entries: [
      "dist/cli.js",
      "dist/capture-hook.js",
      "dist/local-runtime-cli.js"
    ]
  },
  {
    directory: "koed-server",
    package: "koed-server",
    entries: ["dist/cli.js"]
  }
];

const codexGuidanceSource =
  "node_modules/@koed/mcp-server/dist/prompts/codex-global-agent-guidance.md";
const codexGuidanceTarget =
  "mcp-server/dist/prompts/codex-global-agent-guidance.md";

const removeBinDirectories = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name === ".bin") {
      rmSync(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      removeBinDirectories(path);
    }
  }
};

const wrapperSource = (packageName, entry) =>
  [
    "#!/usr/bin/env node",
    'import { fileURLToPath } from "node:url";',
    `const entry = new URL(${JSON.stringify(`../../node_modules/@koed/${packageName}/${entry}`)}, import.meta.url);`,
    "process.argv[1] = fileURLToPath(entry);",
    "await import(entry.href);",
    ""
  ].join("\n");

const licensePattern = /^(?:licen[cs]e|notice|copying)(?:\.|$)/i;
const prunableDirectoryPattern =
  /^(?:\.changeset|\.circleci|\.claude|\.github|__tests__|test|tests|example|examples|docs?|benchmark|benchmarks)$/i;
const prunableFilePattern =
  /^(?:\.pnpm-.*|dockerfile(?:\..*)?|binding\.gyp|makefile|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|tsconfig(?:\..*)?\.json)$/i;

const containsLicense = (dir) =>
  readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? containsLicense(resolve(dir, entry.name))
      : licensePattern.test(entry.name)
  );

const pruneNonRuntimeFiles = (dir) => {
  const normalizedDir = dir.replaceAll("\\", "/");
  if (normalizedDir.includes("/mcp-server/dist/prompts")) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (prunableDirectoryPattern.test(entry.name)) {
        if (containsLicense(path)) pruneNonRuntimeFiles(path);
        else rmSync(path, { recursive: true, force: true });
      } else {
        pruneNonRuntimeFiles(path);
      }
    } else if (
      entry.isFile() &&
      !licensePattern.test(entry.name) &&
      (prunableFilePattern.test(entry.name) ||
        entry.name.endsWith(".d.ts") ||
        entry.name.endsWith(".map") ||
        entry.name.endsWith(".ts") ||
        entry.name.endsWith(".c") ||
        entry.name.endsWith(".cc") ||
        entry.name.endsWith(".cpp") ||
        entry.name.endsWith(".h") ||
        entry.name.endsWith(".hpp") ||
        entry.name.endsWith(".gyp") ||
        entry.name.endsWith(".gypi") ||
        entry.name.toLowerCase().endsWith(".md"))
    ) {
      rmSync(path, { force: true });
    }
  }
};

const pruneKnownBuildSources = (runtimeRoot) => {
  for (const path of [
    "node_modules/@anthropic-ai/sdk/src",
    "node_modules/msgpackr-extract/src",
    "node_modules/sharp/src"
  ]) {
    rmSync(resolve(runtimeRoot, path), { recursive: true, force: true });
  }
};

const packageDirectories = (nodeModules) => {
  const result = [];
  const visitModules = (root) => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === ".bin" ||
        entry.name === ".pnpm"
      )
        continue;
      const path = resolve(root, entry.name);
      if (entry.name.startsWith("@")) {
        for (const child of readdirSync(path, { withFileTypes: true })) {
          if (child.isDirectory()) result.push(resolve(path, child.name));
        }
      } else {
        result.push(path);
      }
    }
  };
  visitModules(nodeModules);
  for (let index = 0; index < result.length; index += 1) {
    visitModules(resolve(result[index], "node_modules"));
  }
  return result;
};

const writeThirdPartyInventory = (runtimeRoot) => {
  const inventory = packageDirectories(resolve(runtimeRoot, "node_modules"))
    .flatMap((directory) => {
      const manifestPath = resolve(directory, "package.json");
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        typeof manifest.name !== "string" ||
        typeof manifest.version !== "string"
      )
        return [];
      const licenses = readdirSync(directory)
        .filter((name) => licensePattern.test(name))
        .sort();
      return [
        {
          name: manifest.name,
          version: manifest.version,
          license: manifest.license ?? null,
          files: licenses
        }
      ];
    })
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
    );
  writeFileSync(
    resolve(runtimeRoot, "third-party-notices.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: inventory })}\n`
  );
};

export const finalizeStagedAppRuntime = (runtimeRoot) => {
  removeBinDirectories(resolve(runtimeRoot, "node_modules"));
  rmSync(resolve(runtimeRoot, "node_modules", ".pnpm"), {
    recursive: true,
    force: true
  });
  rmSync(resolve(runtimeRoot, "node_modules", ".modules.yaml"), {
    force: true
  });
  rmSync(resolve(runtimeRoot, "package.json"), { force: true });
  for (const service of appRuntimePackages) {
    for (const entry of service.entries) {
      const target = resolve(runtimeRoot, service.directory, entry);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, wrapperSource(service.package, entry));
      chmodSync(target, 0o755);
    }
  }

  const requiredSharedFiles = [
    "node_modules/@koed/api/dist/browser-approval/index.html",
    "node_modules/@koed/db/dist/index.js",
    "node_modules/@koed/db/dist/connection.js",
    "node_modules/@koed/db/dist/user-api-token-repository.js",
    "node_modules/@koed/db/drizzle/meta/_journal.json",
    "node_modules/@koed/mcp-server/dist/prompts/mcp-server-instructions.md",
    codexGuidanceSource
  ];
  const missing = requiredSharedFiles.filter(
    (entry) => !existsSync(resolve(runtimeRoot, entry))
  );
  if (missing.length > 0) {
    throw new Error(
      `Shared app-runtime staging is missing: ${missing.join(", ")}`
    );
  }
  const guidanceTarget = resolve(runtimeRoot, codexGuidanceTarget);
  mkdirSync(resolve(guidanceTarget, ".."), { recursive: true });
  writeFileSync(
    guidanceTarget,
    readFileSync(resolve(runtimeRoot, codexGuidanceSource))
  );

  const invalid = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) invalid.push(path);
      else if (stat.isDirectory()) visit(path);
      else if (!stat.isFile()) invalid.push(path);
    }
  };
  visit(runtimeRoot);
  if (invalid.length > 0) {
    throw new Error(
      `Shared app-runtime staging contains unsupported entries:\n${invalid.slice(0, 20).join("\n")}`
    );
  }
  return {
    runtimeRoot,
    required: [
      ...appRuntimePackages.flatMap((service) =>
        service.entries.map((entry) => `${service.directory}/${entry}`)
      ),
      ...requiredSharedFiles,
      codexGuidanceTarget
    ]
  };
};

export const pruneSharedAppRuntimeMetadata = (runtimeRoot) => {
  writeThirdPartyInventory(runtimeRoot);
  pruneKnownBuildSources(runtimeRoot);
  pruneNonRuntimeFiles(runtimeRoot);
};

export const stageSharedAppRuntime = ({ repoRoot, runtimeRoot }) => {
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(resolve(runtimeRoot, ".."), { recursive: true });
  const result = spawnSync(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      "--config.inject-workspace-packages=true",
      "--filter",
      "@koed/app-runtime-stage",
      "deploy",
      "--frozen-lockfile",
      "--prod",
      runtimeRoot
    ],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Shared app-runtime deployment failed with ${result.status ?? 1}`
    );
  }
  return finalizeStagedAppRuntime(runtimeRoot);
};
