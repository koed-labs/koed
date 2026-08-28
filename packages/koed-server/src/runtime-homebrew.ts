import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import type { KoedServerPaths } from "./paths.js";

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

export type RuntimeProvider = "homebrew" | "packaged";
export type RuntimeInstallState =
  | "installed"
  | "missing"
  | "incompatible"
  | "not_supported"
  | "needs_attention";

export interface RuntimePackageStatus {
  name: "postgresql@17" | "pgvector" | "llama.cpp";
  installed: boolean;
  prefix?: string;
  missing?: string[];
}

export interface HomebrewRuntimeBinaryStatus {
  path: string;
  exists: boolean;
}

export interface HomebrewRuntimeBinaries {
  initdb: HomebrewRuntimeBinaryStatus;
  pg_ctl: HomebrewRuntimeBinaryStatus;
  psql: HomebrewRuntimeBinaryStatus;
  pg_dump: HomebrewRuntimeBinaryStatus;
  pg_restore: HomebrewRuntimeBinaryStatus;
  pg_config: HomebrewRuntimeBinaryStatus;
  llama_server: HomebrewRuntimeBinaryStatus;
}

export interface HomebrewRuntimeStatus {
  ok: boolean;
  state: RuntimeInstallState;
  provider: "homebrew";
  platform: NodeJS.Platform;
  koedHome: string;
  homebrew: {
    installed: boolean;
    prefix?: string;
    error?: string;
  };
  packages: RuntimePackageStatus[];
  binaries: HomebrewRuntimeBinaries;
  pgvector: {
    compatible: boolean;
    controlPath?: string;
    sqlPaths: string[];
    missing?: string[];
  };
  koedRuntime: {
    postgresBinDir: string;
    llamaServerBin: string;
    metadataPath: string;
    linked: boolean;
  };
  message: string;
  action?: string;
}

export interface HomebrewRuntimeInstallResult extends HomebrewRuntimeStatus {
  installedPackages: string[];
  linkedPaths: string[];
}

export interface HomebrewRuntimeDependencies {
  platform?: NodeJS.Platform;
  existsSync?: typeof existsSync;
  mkdirSync?: typeof mkdirSync;
  rmSync?: typeof rmSync;
  symlinkSync?: typeof symlinkSync;
  writeFileSync?: typeof writeFileSync;
  readFileSync?: typeof readFileSync;
  spawnSync?: SpawnSyncLike;
}

const REQUIRED_PACKAGES: RuntimePackageStatus["name"][] = [
  "postgresql@17",
  "pgvector",
  "llama.cpp"
];

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const homebrewCommandCandidates = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  exists: typeof existsSync
): string[] => {
  const configuredPrefix = trim(environment.HOMEBREW_PREFIX);
  const configuredCommand =
    configuredPrefix && isAbsolute(configuredPrefix)
      ? resolve(configuredPrefix, "bin", "brew")
      : undefined;
  const platformCommands =
    platform === "darwin"
      ? ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
      : platform === "linux"
        ? ["/home/linuxbrew/.linuxbrew/bin/brew"]
        : [];
  return [
    ...new Set([
      ...[configuredCommand, ...platformCommands].filter(
        (command): command is string => Boolean(command && exists(command))
      ),
      "brew"
    ])
  ];
};

const run = (
  command: string,
  args: string[],
  spawnSync: SpawnSyncLike
): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

const brewPrefix = (
  formula: string | null,
  command: string,
  spawnSync: SpawnSyncLike
): { ok: boolean; prefix?: string; error?: string } => {
  const args = formula ? ["--prefix", formula] : ["--prefix"];
  const result = run(command, args, spawnSync);
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `brew ${args.join(" ")} failed`
    };
  }
  return { ok: true, prefix: result.stdout.trim() };
};

const resolveHomebrewCommand = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  exists: typeof existsSync,
  spawnSync: SpawnSyncLike
):
  | { ok: true; command: string; prefix: string }
  | {
      ok: false;
      error: string;
    } => {
  let error = "Homebrew is not available";
  for (const command of homebrewCommandCandidates(
    platform,
    environment,
    exists
  )) {
    const result = brewPrefix(null, command, spawnSync);
    if (result.ok && result.prefix) {
      return { ok: true, command, prefix: result.prefix };
    }
    error = result.error ?? error;
  }
  return { ok: false, error };
};

const packageStatus = (
  name: RuntimePackageStatus["name"],
  command: string,
  spawnSync: SpawnSyncLike
): RuntimePackageStatus => {
  const listed = run(command, ["list", "--versions", name], spawnSync);
  if (listed.error || listed.status !== 0 || !listed.stdout.trim()) {
    return {
      name,
      installed: false,
      missing: [
        listed.stderr.trim() || listed.error?.message || "not installed"
      ]
    };
  }
  const result = brewPrefix(name, command, spawnSync);
  return result.ok && result.prefix
    ? { name, installed: true, prefix: result.prefix }
    : { name, installed: false, missing: [result.error ?? "not installed"] };
};

const binary = (
  paths: Record<string, string>,
  key: string,
  path: string,
  exists: typeof existsSync
) => {
  paths[key] = path;
  return { path, exists: exists(path) };
};

const candidatePgvectorControlPaths = (
  postgresPrefix: string | undefined,
  pgvectorPrefix: string | undefined,
  pgSharedir: string | undefined
): string[] =>
  [
    pgSharedir ? resolve(pgSharedir, "extension", "vector.control") : undefined,
    postgresPrefix
      ? resolve(
          postgresPrefix,
          "share",
          "postgresql@17",
          "extension",
          "vector.control"
        )
      : undefined,
    postgresPrefix
      ? resolve(
          postgresPrefix,
          "share",
          "postgresql",
          "extension",
          "vector.control"
        )
      : undefined,
    pgvectorPrefix
      ? resolve(
          pgvectorPrefix,
          "share",
          "postgresql@17",
          "extension",
          "vector.control"
        )
      : undefined,
    pgvectorPrefix
      ? resolve(
          pgvectorPrefix,
          "share",
          "postgresql",
          "extension",
          "vector.control"
        )
      : undefined
  ].filter((value): value is string => Boolean(value));

const candidatePgvectorSqlPaths = (
  controlPath: string | undefined
): string[] =>
  controlPath ? [resolve(dirname(controlPath), "vector--*.sql")] : [];

const pgSharedir = (
  pgConfigBin: string,
  exists: typeof existsSync,
  spawnSync: SpawnSyncLike
): string | undefined => {
  if (!exists(pgConfigBin)) return undefined;
  const result = run(pgConfigBin, ["--sharedir"], spawnSync);
  if (result.status !== 0 || result.error) return undefined;
  return trim(result.stdout);
};

const runtimePaths = (paths: KoedServerPaths) => ({
  postgresBinDir: resolve(paths.koedHome, "runtime", "postgres", "bin"),
  llamaServerBin: resolve(
    paths.koedHome,
    "runtime",
    "llama.cpp",
    "llama-server"
  ),
  metadataPath: resolve(paths.cacheDir, "runtime-homebrew.json")
});

const emptyBinaries = (): HomebrewRuntimeBinaries => ({
  initdb: { path: "", exists: false },
  pg_ctl: { path: "", exists: false },
  psql: { path: "", exists: false },
  pg_dump: { path: "", exists: false },
  pg_restore: { path: "", exists: false },
  pg_config: { path: "", exists: false },
  llama_server: { path: "", exists: false }
});

const binaryEntries = (
  binaries: HomebrewRuntimeBinaries
): Array<[keyof HomebrewRuntimeBinaries, HomebrewRuntimeBinaryStatus]> =>
  Object.entries(binaries) as Array<
    [keyof HomebrewRuntimeBinaries, HomebrewRuntimeBinaryStatus]
  >;

const isSupportedHomebrewPlatform = (platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "linux";

const statusFrom = ({
  paths,
  platform,
  environment,
  exists,
  spawnSync
}: {
  paths: KoedServerPaths;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  exists: typeof existsSync;
  spawnSync: SpawnSyncLike;
}): HomebrewRuntimeStatus => {
  const koedRuntime = runtimePaths(paths);
  if (!isSupportedHomebrewPlatform(platform)) {
    return {
      ok: false,
      state: "not_supported",
      provider: "homebrew",
      platform,
      koedHome: paths.koedHome,
      homebrew: { installed: false },
      packages: [],
      binaries: emptyBinaries(),
      pgvector: { compatible: false, sqlPaths: [], missing: ["macOS/Linux"] },
      koedRuntime: { ...koedRuntime, linked: false },
      message:
        "Homebrew-backed bundled-local runtime provisioning is supported on macOS, Linux, and WSL only.",
      action:
        "Use external dependency mode or a supported Homebrew/Linuxbrew environment on macOS, Linux, or WSL."
    };
  }

  const homebrew = resolveHomebrewCommand(
    platform,
    environment,
    exists,
    spawnSync
  );
  if (!homebrew.ok) {
    return {
      ok: false,
      state: "missing",
      provider: "homebrew",
      platform,
      koedHome: paths.koedHome,
      homebrew: { installed: false, error: homebrew.error },
      packages: REQUIRED_PACKAGES.map((name) => ({
        name,
        installed: false,
        missing: ["Homebrew is not available"]
      })),
      binaries: emptyBinaries(),
      pgvector: { compatible: false, sqlPaths: [], missing: ["Homebrew"] },
      koedRuntime: { ...koedRuntime, linked: false },
      message:
        "Homebrew is required for Homebrew-backed bundled-local runtime provisioning.",
      action:
        "Install Homebrew or Linuxbrew on macOS, Linux, or WSL, then run koed-server runtime install --provider homebrew --dependency-mode bundled-local --json."
    };
  }
  const command = homebrew.command;
  const packages = REQUIRED_PACKAGES.map((name) =>
    packageStatus(name, command, spawnSync)
  );
  const postgres = packages.find((pkg) => pkg.name === "postgresql@17");
  const pgvectorPackage = packages.find((pkg) => pkg.name === "pgvector");
  const llama = packages.find((pkg) => pkg.name === "llama.cpp");
  const binaryPaths: Record<string, string> = {};
  const postgresBin = (name: string) =>
    postgres?.prefix ? resolve(postgres.prefix, "bin", name) : "";
  const llamaBin = (name: string) =>
    llama?.prefix ? resolve(llama.prefix, "bin", name) : "";
  const binaries: HomebrewRuntimeBinaries = {
    initdb: binary(binaryPaths, "initdb", postgresBin("initdb"), exists),
    pg_ctl: binary(binaryPaths, "pg_ctl", postgresBin("pg_ctl"), exists),
    psql: binary(binaryPaths, "psql", postgresBin("psql"), exists),
    pg_dump: binary(binaryPaths, "pg_dump", postgresBin("pg_dump"), exists),
    pg_restore: binary(
      binaryPaths,
      "pg_restore",
      postgresBin("pg_restore"),
      exists
    ),
    pg_config: binary(
      binaryPaths,
      "pg_config",
      postgresBin("pg_config"),
      exists
    ),
    llama_server: binary(
      binaryPaths,
      "llama_server",
      llamaBin("llama-server"),
      exists
    )
  };
  const sharedir = pgSharedir(binaries.pg_config.path, exists, spawnSync);
  const controlPath = candidatePgvectorControlPaths(
    postgres?.prefix,
    pgvectorPackage?.prefix,
    sharedir
  ).find((candidate) => exists(candidate));
  const missing = [
    ...packages.flatMap((pkg) => (pkg.installed ? [] : [pkg.name])),
    ...binaryEntries(binaries).flatMap(([name, info]) =>
      info.exists ? [] : [name]
    ),
    ...(controlPath ? [] : ["pgvector extension files"])
  ];
  const linked =
    exists(resolve(koedRuntime.postgresBinDir, "initdb")) &&
    exists(resolve(koedRuntime.postgresBinDir, "pg_ctl")) &&
    exists(resolve(koedRuntime.postgresBinDir, "psql")) &&
    exists(resolve(koedRuntime.postgresBinDir, "pg_dump")) &&
    exists(resolve(koedRuntime.postgresBinDir, "pg_restore")) &&
    exists(koedRuntime.llamaServerBin);
  const ok = missing.length === 0 && linked;
  return {
    ok,
    state: ok ? "installed" : missing.length === 0 ? "missing" : "missing",
    provider: "homebrew",
    platform,
    koedHome: paths.koedHome,
    homebrew: { installed: true, prefix: homebrew.prefix },
    packages,
    binaries,
    pgvector: {
      compatible: Boolean(controlPath),
      controlPath,
      sqlPaths: candidatePgvectorSqlPaths(controlPath),
      ...(controlPath ? {} : { missing: ["vector.control"] })
    },
    koedRuntime: { ...koedRuntime, linked },
    message: ok
      ? "Homebrew-backed bundled-local runtime is installed under KOED_HOME."
      : "Homebrew-backed bundled-local runtime is missing required assets or KOED_HOME links.",
    action: ok
      ? undefined
      : "Run koed-server runtime install --provider homebrew --dependency-mode bundled-local --json."
  };
};

export const collectHomebrewRuntimeStatus = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: HomebrewRuntimeDependencies = {}
): HomebrewRuntimeStatus => {
  return statusFrom({
    paths,
    platform: dependencies.platform ?? process.platform,
    environment,
    exists: dependencies.existsSync ?? existsSync,
    spawnSync: dependencies.spawnSync ?? (nodeSpawnSync as SpawnSyncLike)
  });
};

const linkRuntimePath = (
  source: string,
  target: string,
  koedHome: string,
  deps: Required<
    Pick<HomebrewRuntimeDependencies, "mkdirSync" | "rmSync" | "symlinkSync">
  >
): void => {
  const resolvedTarget = resolve(target);
  const resolvedKoedHome = resolve(koedHome);
  if (
    resolvedTarget !== resolvedKoedHome &&
    !resolvedTarget.startsWith(`${resolvedKoedHome}/`)
  ) {
    throw new Error(
      `Refusing to link runtime asset outside KOED_HOME: ${target}`
    );
  }
  deps.mkdirSync(dirname(resolvedTarget), { recursive: true, mode: 0o700 });
  deps.rmSync(resolvedTarget, { force: true });
  deps.symlinkSync(source, resolvedTarget);
};

export const installHomebrewRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: HomebrewRuntimeDependencies = {}
): HomebrewRuntimeInstallResult => {
  const deps = {
    platform: dependencies.platform ?? process.platform,
    existsSync: dependencies.existsSync ?? existsSync,
    mkdirSync: dependencies.mkdirSync ?? mkdirSync,
    rmSync: dependencies.rmSync ?? rmSync,
    symlinkSync: dependencies.symlinkSync ?? symlinkSync,
    writeFileSync: dependencies.writeFileSync ?? writeFileSync,
    readFileSync: dependencies.readFileSync ?? readFileSync,
    spawnSync: dependencies.spawnSync ?? (nodeSpawnSync as SpawnSyncLike)
  };
  const before = collectHomebrewRuntimeStatus(paths, environment, deps);
  if (before.state === "not_supported") {
    return { ...before, installedPackages: [], linkedPaths: [] };
  }
  if (!before.homebrew.installed) {
    return {
      ...before,
      state: "needs_attention",
      message:
        "Homebrew is required before installing bundled-local runtime assets.",
      action:
        "Install Homebrew or Linuxbrew on macOS, Linux, or WSL, then rerun koed-server runtime install --provider homebrew --dependency-mode bundled-local --json.",
      installedPackages: [],
      linkedPaths: []
    };
  }

  const missingPackages = before.packages
    .filter((pkg) => !pkg.installed)
    .map((pkg) => pkg.name);
  if (missingPackages.length > 0) {
    const homebrew = resolveHomebrewCommand(
      deps.platform,
      environment,
      deps.existsSync,
      deps.spawnSync
    );
    if (!homebrew.ok) {
      return {
        ...before,
        state: "needs_attention",
        message: "Homebrew became unavailable before package installation.",
        action: homebrew.error,
        installedPackages: [],
        linkedPaths: []
      };
    }
    const result = run(
      homebrew.command,
      ["install", ...missingPackages],
      deps.spawnSync
    );
    if (result.error || result.status !== 0) {
      return {
        ...before,
        state: "needs_attention",
        message: "Homebrew package installation failed.",
        action:
          result.stderr.trim() ||
          result.error?.message ||
          "Inspect Homebrew output and retry.",
        installedPackages: [],
        linkedPaths: []
      };
    }
  }

  const afterInstall = collectHomebrewRuntimeStatus(paths, environment, deps);
  const missingAfterInstall = [
    ...afterInstall.packages.flatMap((pkg) =>
      pkg.installed ? [] : [pkg.name]
    ),
    ...binaryEntries(afterInstall.binaries).flatMap(([name, info]) =>
      info.exists ? [] : [name]
    ),
    ...(afterInstall.pgvector.compatible ? [] : ["pgvector"])
  ];
  if (missingAfterInstall.length > 0) {
    return {
      ...afterInstall,
      state: "needs_attention",
      message: `Homebrew runtime assets are still missing: ${missingAfterInstall.join(", ")}.`,
      installedPackages: missingPackages,
      linkedPaths: []
    };
  }

  const linkedPaths = [
    [
      afterInstall.binaries.initdb.path,
      resolve(afterInstall.koedRuntime.postgresBinDir, "initdb")
    ],
    [
      afterInstall.binaries.pg_ctl.path,
      resolve(afterInstall.koedRuntime.postgresBinDir, "pg_ctl")
    ],
    [
      afterInstall.binaries.psql.path,
      resolve(afterInstall.koedRuntime.postgresBinDir, "psql")
    ],
    [
      afterInstall.binaries.pg_dump.path,
      resolve(afterInstall.koedRuntime.postgresBinDir, "pg_dump")
    ],
    [
      afterInstall.binaries.pg_restore.path,
      resolve(afterInstall.koedRuntime.postgresBinDir, "pg_restore")
    ],
    [
      afterInstall.binaries.pg_config.path,
      resolve(afterInstall.koedRuntime.postgresBinDir, "pg_config")
    ],
    [
      afterInstall.binaries.llama_server.path,
      afterInstall.koedRuntime.llamaServerBin
    ]
  ] satisfies Array<[string, string]>;
  for (const [source, target] of linkedPaths) {
    linkRuntimePath(source, target, paths.koedHome, deps);
  }
  deps.mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
  deps.writeFileSync(
    afterInstall.koedRuntime.metadataPath,
    `${JSON.stringify(
      {
        provider: "homebrew",
        installedAt: new Date().toISOString(),
        packages: afterInstall.packages,
        binaries: afterInstall.binaries,
        pgvector: afterInstall.pgvector
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const finalStatus = collectHomebrewRuntimeStatus(paths, environment, deps);
  return {
    ...finalStatus,
    installedPackages: missingPackages,
    linkedPaths: linkedPaths.map(([, target]) => target)
  };
};
