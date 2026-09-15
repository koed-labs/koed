import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const validId = (id: string) => /^[A-Za-z0-9_-]{22}$/.test(id);
export const validatePersonalDeviceName = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Enter a device name.");
  const name = value.trim();
  if (
    !name ||
    name.length > 80 ||
    Array.from(name).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) {
    throw new Error("Use a device name with 1–80 printable characters.");
  }
  return name;
};

export const readPersonalDeviceNames = (
  home: string
): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(home, "config", "personal-device-names.json"), "utf8")
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid device names.");
    return Object.fromEntries(
      Object.entries(value).map(([id, name]) => {
        if (!validId(id)) throw new Error("Invalid device identifier.");
        return [id, validatePersonalDeviceName(name)];
      })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
};

export const writePersonalDeviceName = (
  home: string,
  deviceId: string,
  value: unknown,
  onlyIfMissing = false
): void => {
  if (!validId(deviceId)) throw new Error("Invalid device identifier.");
  const name = validatePersonalDeviceName(value);
  const names = readPersonalDeviceNames(home);
  if (onlyIfMissing && names[deviceId]) return;
  names[deviceId] = name;
  const directory = join(home, "config");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "personal-device-names.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(names) + "\n", {
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};
