import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

export interface SupervisorIdentity {
  pid: number;
  startedAt: string;
}

export const supervisorExitRequestPath = (paths: KoedServerPaths): string =>
  resolve(paths.runDir, "koed-server.stop.json");

export const requestSupervisorExit = (
  paths: KoedServerPaths,
  identity: SupervisorIdentity
): void => {
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    supervisorExitRequestPath(paths),
    `${JSON.stringify(identity, null, 2)}\n`,
    { mode: 0o600 }
  );
};

const readExitRequest = (path: string): SupervisorIdentity | null => {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<SupervisorIdentity>;
    return Number.isInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.startedAt === "string"
      ? { pid: Number(value.pid), startedAt: value.startedAt }
      : null;
  } catch {
    return null;
  }
};

export const monitorSupervisorExitRequest = (
  paths: KoedServerPaths,
  identity: SupervisorIdentity,
  options: {
    intervalMs?: number;
    onExit?: () => void;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  } = {}
): (() => void) => {
  const path = supervisorExitRequestPath(paths);
  let handled = false;
  const check = () => {
    if (handled) return;
    const request = readExitRequest(path);
    if (
      request?.pid !== identity.pid ||
      request.startedAt !== identity.startedAt
    ) {
      return;
    }
    handled = true;
    rmSync(path, { force: true });
    (options.onExit ?? (() => process.exit(0)))();
  };
  const timer = (options.setInterval ?? setInterval)(
    check,
    options.intervalMs ?? 100
  );
  timer.unref?.();
  check();
  return () => (options.clearInterval ?? clearInterval)(timer);
};
