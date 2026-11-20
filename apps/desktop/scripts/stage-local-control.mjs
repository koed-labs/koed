import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function stageLocalControl({ platform, source, runtime }) {
  if (platform !== "darwin") return undefined;
  const directory = resolve(runtime, "control");
  mkdirSync(directory, { recursive: true });
  const destination = resolve(directory, "koed_background_xpc.node");
  copyFileSync(source, destination);
  return destination;
}
