import process from "node:process";
import type { RuntimeIdentity } from "./component-contract.js";

interface RuntimeProcessSource {
  versions: {
    node?: string;
    electron?: string;
    modules?: string;
    napi?: string;
  };
  platform: string;
  arch: string;
  report?: {
    getReport(): { header?: { glibcVersionRuntime?: string } };
  };
}

const isVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}$/.test(value) &&
  value.split(".").every((part) => Number.isSafeInteger(Number(part)));

export function discoverRuntimeIdentityFromProcess(
  source: RuntimeProcessSource
): RuntimeIdentity {
  const platform =
    source.platform === "darwin"
      ? "macos"
      : source.platform === "linux"
        ? "linux"
        : undefined;
  const architecture =
    source.arch === "arm64" || source.arch === "x64" ? source.arch : undefined;
  const runtimeVersion = source.versions.electron ?? source.versions.node;
  const nodeVersion = source.versions.node;
  const modulesAbi = source.versions.modules;
  const napiVersion = Number(source.versions.napi ?? "0");
  let libcVersion: string | undefined;

  if (platform === "linux") {
    try {
      libcVersion = source.report?.getReport().header?.glibcVersionRuntime;
    } catch {
      throw new Error("actual runtime identity is unsupported or incomplete");
    }
  }
  if (
    !platform ||
    !architecture ||
    !isVersion(runtimeVersion) ||
    !isVersion(nodeVersion) ||
    typeof modulesAbi !== "string" ||
    !/^\d+$/.test(modulesAbi) ||
    !Number.isSafeInteger(napiVersion) ||
    napiVersion < 0 ||
    (platform === "linux" && !isVersion(libcVersion))
  )
    throw new Error("actual runtime identity is unsupported or incomplete");

  return {
    kind: source.versions.electron === undefined ? "node" : "electron",
    version: runtimeVersion,
    nodeVersion,
    modulesAbi,
    napiVersion,
    platform,
    architecture,
    ...(libcVersion === undefined ? {} : { libcVersion })
  };
}

export function discoverActualRuntimeIdentity(): RuntimeIdentity {
  return discoverRuntimeIdentityFromProcess(process);
}
