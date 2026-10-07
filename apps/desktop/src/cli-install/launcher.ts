import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export interface LauncherInput {
  destination: string;
  appPath: string;
  helperPath: string;
  cliPath: string;
  expectedVersion: string;
  currentPath: string;
}

export interface LauncherStatus {
  ownership: "absent" | "koed" | "unrelated" | "changed";
  target: "valid" | "missing" | "invalid";
  helper: "supported" | "unsupported";
  version: string | null;
  pathVisible: boolean;
  fingerprint: string | null;
}

export type HelperProbe = () => Promise<boolean>;

const marker = "# koed-desktop-launcher:v1";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const launcherContents = (input: LauncherInput): string =>
  `${marker}\n# version:${input.expectedVersion}\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(input.helperPath)} ${quote(input.cliPath)} "$@"\n`;

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
  const owned = contents?.startsWith(`${marker}\n`) ?? false;
  const exactLauncher = owned && contents === launcherContents(input);
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
    version: owned
      ? (/^# version:(.+)$/mu.exec(contents ?? "")?.[1] ?? null)
      : null,
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
  if (!beforeProbe || beforeProbe.contents !== launcherContents(input))
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
    immediatelyBeforeUnlink.contents !== launcherContents(input)
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
  const observed = await inspectLauncher(input);
  if (observed.ownership !== "absent")
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
    linkSync(temporary, input.destination);
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
