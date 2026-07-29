import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

type DesktopOnboardingState = {
  complete: true;
  completedAt: string;
  schemaVersion: 1;
};

export const desktopOnboardingStatePath = (koedHome: string): string =>
  resolve(koedHome, "config", "desktop-onboarding.json");

export const readDesktopOnboardingComplete = (path: string): boolean => {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<DesktopOnboardingState> | null;
    return (
      value?.schemaVersion === 1 &&
      value.complete === true &&
      typeof value.completedAt === "string" &&
      Number.isFinite(Date.parse(value.completedAt))
    );
  } catch {
    return false;
  }
};

export const writeDesktopOnboardingComplete = (
  path: string,
  completedAt = new Date()
): void => {
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          complete: true,
          completedAt: completedAt.toISOString(),
          schemaVersion: 1
        } satisfies DesktopOnboardingState,
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};
