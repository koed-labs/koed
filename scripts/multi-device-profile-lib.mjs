import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { splitEnvLine } from "./setup-env-lib.mjs";

const within = (parent, candidate) => {
  const child = relative(resolve(parent), resolve(candidate));
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
};

export const assertDisposableMultiDeviceRoot = (root) => {
  const resolved = resolve(root);
  if (
    !within(tmpdir(), resolved) ||
    !basename(resolved).startsWith("koed-multi-device-")
  ) {
    throw new Error(
      "Multi-device profile root must be a koed-multi-device-* directory under the OS temporary directory."
    );
  }
  return resolved;
};

const profile = (root, name, cdpPort) => {
  const profileRoot = resolve(root, name);
  return {
    name,
    koedHome: resolve(profileRoot, "koed-home"),
    codexHome: resolve(profileRoot, "codex-home"),
    codexConfigPath: resolve(profileRoot, "codex-home", "config.toml"),
    envPath: resolve(profileRoot, "koed-home", "local.env"),
    electronUserData: resolve(profileRoot, "electron-user-data"),
    cdpPort
  };
};

export const setEnvValue = (contents, key, value) => {
  let found = false;
  const lines = contents
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => {
      const entry = splitEnvLine(line);
      if (entry?.key !== key) {
        return line;
      }
      found = true;
      return `${key}=${value}`;
    });
  if (!found) {
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

export const prepareMultiDeviceProfiles = ({
  root,
  reset = false,
  cwd = process.cwd(),
  spawn = spawnSync
}) => {
  const safeRoot = assertDisposableMultiDeviceRoot(root);
  if (existsSync(safeRoot)) {
    if (!reset) {
      throw new Error(
        `Multi-device profile root already exists: ${safeRoot}. Pass --reset to replace this disposable test root.`
      );
    }
    rmSync(safeRoot, { recursive: true, force: true });
  }
  mkdirSync(safeRoot, { recursive: true, mode: 0o700 });
  const devices = [
    profile(safeRoot, "device-a", 9224),
    profile(safeRoot, "device-b", 9225)
  ];
  for (const device of devices) {
    for (const directory of [
      device.koedHome,
      device.codexHome,
      resolve(device.codexHome, "sessions"),
      device.electronUserData
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const result = spawn(
      process.execPath,
      [resolve(cwd, "scripts/setup-env.mjs")],
      {
        cwd,
        env: { ...process.env, KOED_ENV_PATH: device.envPath },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Could not prepare ${device.name}: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`
      );
    }
    if (
      !existsSync(device.envPath) ||
      readFileSync(device.envPath, "utf8").length === 0
    ) {
      throw new Error(
        `Could not prepare ${device.name}: generated environment is empty.`
      );
    }
    let environment = readFileSync(device.envPath, "utf8");
    environment = setEnvValue(environment, "WORK_QUEUE_BACKEND", "local");
    environment = setEnvValue(
      environment,
      "CODEX_CONFIG_PATH",
      device.codexConfigPath
    );
    writeFileSync(device.envPath, environment, { mode: 0o600 });
  }
  const manifest = {
    version: 1,
    root: safeRoot,
    createdAt: new Date().toISOString(),
    devices
  };
  const manifestPath = resolve(safeRoot, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600
  });
  return { manifestPath, ...manifest };
};

export const defaultMultiDeviceProfileRoot = () =>
  resolve(
    tmpdir(),
    `koed-multi-device-${process.env.USER || basename(homedir()) || "test"}`
  );
