import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface LauncherInput {
  destination: string;
  appPath: string;
  helperPath: string;
  // Verified Desktop CLI entrypoint that shares Desktop's managed instance.
  cliPath: string;
  // The Desktop instance state directory bound into the launcher.
  koedHome: string;
  // Generic CLI targeted by exact v1 launchers, recognized only to migrate.
  legacyCliPath?: string;
  expectedVersion: string;
  currentPath: string;
}

export interface LauncherStatus {
  ownership: "absent" | "koed" | "unrelated" | "changed";
  target: "valid" | "missing" | "invalid";
  helper: "supported" | "unsupported";
  version: string | null;
  // "legacy" launchers are unchanged v1 files that installation upgrades.
  template: "current" | "legacy" | null;
  pathVisible: boolean;
  fingerprint: string | null;
}

export type HelperProbe = () => Promise<boolean>;

// A shebang lets non-shell callers (Node, Python, GUI tools) execute the file.
const marker = "#!/bin/sh\n# koed-desktop-launcher:v2";
const legacyMarker = "# koed-desktop-launcher:v1";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const launcherContents = (input: LauncherInput): string =>
  `${marker}\n# version:${input.expectedVersion}\nexport ELECTRON_RUN_AS_NODE=1\nexport KOED_HOME=${quote(input.koedHome)}\nexec ${quote(input.helperPath)} ${quote(input.cliPath)} "$@"\n`;
const legacyLauncherContents = (
  input: LauncherInput,
  legacyCliPath: string
): string =>
  `${legacyMarker}\n# version:${input.expectedVersion}\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(input.helperPath)} ${quote(legacyCliPath)} "$@"\n`;

const assertLauncherPaths = (input: LauncherInput): void => {
  for (const value of [
    input.helperPath,
    input.cliPath,
    input.koedHome,
    input.destination
  ])
    if (!isAbsolute(value) || /[\0\n\r]/u.test(value))
      throw new Error("Launcher paths must be absolute single-line paths.");
};

// Only the validated version field may differ across Desktop upgrades.
const ownedLauncher = (
  contents: string,
  input: LauncherInput
): { version: string; template: "current" | "legacy" } | null => {
  const version = /^# version:([^\n]+)$/mu.exec(contents)?.[1];
  const numeric = "(?:0|[1-9][0-9]*)";
  const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const semver = new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
    "u"
  );
  if (!version || !semver.test(version)) return null;
  const versioned = { ...input, expectedVersion: version };
  if (contents === launcherContents(versioned))
    return { version, template: "current" };
  if (
    input.legacyCliPath &&
    contents === legacyLauncherContents(versioned, input.legacyCliPath)
  )
    return { version, template: "legacy" };
  return null;
};
const ownedLauncherVersion = (
  contents: string,
  input: LauncherInput
): string | null => ownedLauncher(contents, input)?.version ?? null;

interface FileSnapshot {
  contents: string;
  dev: number;
  ino: number;
}

interface FileInspection {
  snapshot: FileSnapshot | null;
  invalid: boolean;
}

const inspectFile = (path: string): FileInspection => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { snapshot: null, invalid: true };
    return {
      snapshot: {
        contents: readFileSync(descriptor, "utf8"),
        dev: stat.dev,
        ino: stat.ino
      },
      invalid: false
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { snapshot: null, invalid: false };
    if (code === "ELOOP") return { snapshot: null, invalid: true };
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const cliTargetStatus = (path: string): "valid" | "missing" | "invalid" => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return fstatSync(descriptor).isFile() ? "valid" : "invalid";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "ELOOP") return "invalid";
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

export const inspectLauncher = async (
  input: LauncherInput & { probeHelper: HelperProbe }
): Promise<LauncherStatus> => {
  const file = inspectFile(input.destination);
  const snapshot = file.snapshot;
  const contents = snapshot?.contents ?? null;
  const owned =
    (contents?.startsWith(`${marker}\n`) ||
      contents?.startsWith(`${legacyMarker}\n`)) ??
    false;
  const exact = contents === null ? null : ownedLauncher(contents, input);
  const version = exact?.version ?? null;
  const exactLauncher = exact !== null;
  const targetStatus = cliTargetStatus(input.cliPath);
  return {
    ownership:
      contents === null
        ? file.invalid
          ? "changed"
          : "absent"
        : owned
          ? exactLauncher
            ? "koed"
            : "changed"
          : "unrelated",
    target:
      targetStatus === "missing"
        ? "missing"
        : targetStatus === "invalid" || !exactLauncher
          ? "invalid"
          : "valid",
    helper: (await input.probeHelper()) ? "supported" : "unsupported",
    version,
    template: exact?.template ?? null,
    pathVisible: input.currentPath
      .split(":")
      .includes(dirname(input.destination)),
    fingerprint: contents === null ? null : digest(contents)
  };
};

export const removeLauncher = async (
  input: LauncherInput & { probeHelper: HelperProbe }
): Promise<LauncherStatus> => {
  const beforeProbe = inspectFile(input.destination).snapshot;
  if (
    !beforeProbe ||
    ownedLauncherVersion(beforeProbe.contents, input) === null
  )
    throw new Error(
      "Launcher is not an unchanged Koed-owned file; refusing removal."
    );
  await input.probeHelper();
  const immediatelyBeforeUnlink = inspectFile(input.destination).snapshot;
  if (
    !immediatelyBeforeUnlink ||
    immediatelyBeforeUnlink.dev !== beforeProbe.dev ||
    immediatelyBeforeUnlink.ino !== beforeProbe.ino ||
    digest(immediatelyBeforeUnlink.contents) !== digest(beforeProbe.contents) ||
    ownedLauncherVersion(immediatelyBeforeUnlink.contents, input) === null
  ) {
    throw new Error("Launcher changed during removal; refusing removal.");
  }
  unlinkSync(input.destination);
  return inspectLauncher(input);
};

export const installLauncher = async (
  input: LauncherInput & { consent: boolean; probeHelper: HelperProbe }
): Promise<LauncherStatus> => {
  if (input.consent !== true)
    throw new Error("Launcher installation requires explicit consent.");
  if (!(await input.probeHelper()))
    throw new Error("Desktop Node helper is unsupported; launcher disabled.");
  if (cliTargetStatus(input.cliPath) !== "valid")
    throw new Error(
      "Koed CLI target is missing or invalid; launcher disabled."
    );
  assertLauncherPaths(input);
  const observed = await inspectLauncher(input);
  // Only an unchanged Koed-owned launcher (including exact v1) is replaced.
  const replaced =
    observed.ownership === "koed"
      ? inspectFile(input.destination).snapshot
      : null;
  if (observed.ownership !== "absent" && !replaced)
    throw new Error(
      "Launcher destination conflict; preserve existing file or choose another path."
    );
  mkdirSync(dirname(input.destination), { recursive: true, mode: 0o700 });
  const temporary = `${input.destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, launcherContents(input), {
      mode: 0o700,
      flag: "wx"
    });
    if (replaced) {
      const current = inspectFile(input.destination).snapshot;
      if (
        !current ||
        current.dev !== replaced.dev ||
        current.ino !== replaced.ino ||
        current.contents !== replaced.contents ||
        ownedLauncherVersion(current.contents, input) === null
      )
        throw new Error(
          "Launcher changed during installation; refusing replacement."
        );
      renameSync(temporary, input.destination);
    } else linkSync(temporary, input.destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Launcher destination conflict; preserve existing file or choose another path.",
        { cause: error }
      );
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  return inspectLauncher(input);
};
