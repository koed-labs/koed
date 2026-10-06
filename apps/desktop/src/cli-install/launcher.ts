import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
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

export const inspectLauncher = async (
  input: LauncherInput & { probeHelper: HelperProbe }
): Promise<LauncherStatus> => {
  let contents: string | null = null;
  try {
    const stat = lstatSync(input.destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        ownership: "changed",
        target: "invalid",
        helper: (await input.probeHelper()) ? "supported" : "unsupported",
        version: null,
        pathVisible: input.currentPath
          .split(":")
          .includes(dirname(input.destination)),
        fingerprint: null
      };
    }
    contents = readFileSync(input.destination, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const owned = contents?.startsWith(`${marker}\n`) ?? false;
  const targetValid = owned && contents === launcherContents(input);
  return {
    ownership:
      contents === null
        ? "absent"
        : owned
          ? targetValid
            ? "koed"
            : "changed"
          : "unrelated",
    target: contents === null ? "missing" : targetValid ? "valid" : "invalid",
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
  const observed = await inspectLauncher(input);
  if (observed.ownership !== "koed") {
    throw new Error(
      "Launcher is not an unchanged Koed-owned file; refusing removal."
    );
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
