import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { HqOnboardingDriver } from "../ipc/hq-onboarding-protocol.js";

type State = {
  schemaVersion: 2;
  profileKey: string;
  selected: HqOnboardingDriver[];
  memoryEntered: boolean;
};
const drivers: readonly HqOnboardingDriver[] = ["codex", "claude", "pi"];

export const hqOnboardingStatePath = (koedHome: string): string =>
  resolve(koedHome, "config", "hq-onboarding.json");

export const readHqOnboardingState = (path: string): State | null => {
  try {
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error(
        "HQ onboarding config directory must be a regular directory."
      );
    }
    const stats = lstatSync(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (typeof process.getuid === "function" &&
        stats.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    ) {
      throw new Error("HQ onboarding state must be a private regular file.");
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("HQ onboarding state is malformed.");
    }
    const value = parsed as Record<string, unknown>;
    if (
      value.schemaVersion !== 2 ||
      typeof value.profileKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.profileKey
      ) ||
      !Array.isArray(value.selected) ||
      !value.selected.every(
        (driver) =>
          typeof driver === "string" &&
          drivers.includes(driver as HqOnboardingDriver)
      ) ||
      typeof value.memoryEntered !== "boolean" ||
      Object.keys(value).some(
        (key) =>
          ![
            "schemaVersion",
            "profileKey",
            "selected",
            "memoryEntered"
          ].includes(key)
      )
    )
      throw new Error("HQ onboarding state is malformed.");
    return {
      schemaVersion: 2,
      profileKey: value.profileKey,
      selected: [...new Set(value.selected as HqOnboardingDriver[])],
      memoryEntered: value.memoryEntered
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
};

export const writeHqOnboardingState = (path: string, state: State): void => {
  const existing = readHqOnboardingState(path);
  if (existing && existing.profileKey !== state.profileKey) {
    throw new Error("HQ onboarding profile key cannot be changed.");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(
      "HQ onboarding config directory must be a regular directory."
    );
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

export const ensureHqOnboardingState = (path: string): State => {
  const current = readHqOnboardingState(path);
  if (current) return current;
  const created: State = {
    schemaVersion: 2,
    profileKey: randomUUID(),
    selected: [],
    memoryEntered: false
  };
  writeHqOnboardingState(path, created);
  return created;
};
