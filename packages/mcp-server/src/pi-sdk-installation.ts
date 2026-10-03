import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const piPackageName = "@earendil-works/pi-coding-agent";
const maxWrapperBytes = 16 * 1_024;
const allowedWrapperEnvironment = new Set([
  "PI_OFFLINE",
  "PI_TELEMETRY",
  "PI_SKIP_VERSION_CHECK",
  "PI_SHARE_VIEWER_URL"
]);

export type PiSdkInstallation = {
  sdkEntryPath: string;
  execPath: string;
  execArgv: string[];
  environment: NodeJS.ProcessEnv;
};

const normalizeStaticPath = (value: string): string | null => {
  const unquoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  if (unquoted.startsWith("~/"))
    return path.resolve(os.homedir(), unquoted.slice(2));
  return path.isAbsolute(unquoted) ? path.resolve(unquoted) : null;
};

const packageInfo = (packageRoot: string): { sdkEntryPath: string } | null => {
  try {
    const root = fs.realpathSync(packageRoot);
    const manifestPath = path.join(root, "package.json");
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
      exports?: { "."?: { import?: unknown } };
    };
    const importPath = manifest.exports?.["."]?.import;
    if (
      manifest.name !== piPackageName ||
      typeof importPath !== "string" ||
      !importPath.startsWith("./")
    )
      return null;
    const sdkEntryPath = fs.realpathSync(path.resolve(root, importPath));
    const relative = path.relative(root, sdkEntryPath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return null;
    return { sdkEntryPath };
  } catch {
    return null;
  }
};

const findPackageForFile = (
  filename: string
): ReturnType<typeof packageInfo> => {
  let candidate = path.dirname(filename);
  for (let depth = 0; depth < 10; depth += 1) {
    const info = packageInfo(candidate);
    if (info) return info;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
};

const shellWrapperSettings = (
  wrapperPath: string,
  environment: NodeJS.ProcessEnv
): PiSdkInstallation | null => {
  try {
    const metadata = fs.statSync(wrapperPath);
    if (!metadata.isFile() || metadata.size > maxWrapperBytes) return null;
    const source = fs.readFileSync(wrapperPath, "utf8");
    if (
      !source.startsWith("#!/bin/sh\n") &&
      !source.startsWith("#!/usr/bin/env sh\n")
    )
      return null;
    const lines = source.split(/\r?\n/u);
    const execLineIndex = lines.findIndex((line) => {
      const words = line.trim().split(/\s+/u);
      return (
        words[0] === "exec" && path.basename(words[1] ?? "") === "sandbox-exec"
      );
    });
    if (execLineIndex < 0) return null;
    const execWords = lines[execLineIndex]!.trim().split(/\s+/u);
    if (
      execWords.length !== 5 ||
      execWords[2] !== "-f" ||
      execWords[4] !== "\\"
    )
      return null;
    const profilePath = normalizeStaticPath(execWords[3]!);
    const nonEmptyLines = lines
      .slice(execLineIndex + 1)
      .filter((line) => line.trim().length > 0);
    if (!profilePath || nonEmptyLines.length !== 2) return null;
    const runtimeWords = nonEmptyLines[0]!.trim().split(/\s+/u);
    const entryWords = nonEmptyLines[1]!.trim().split(/\s+/u);
    if (
      runtimeWords.length !== 2 ||
      runtimeWords[1] !== "\\" ||
      entryWords.length !== 2 ||
      entryWords[1] !== '"$@"'
    )
      return null;
    const runtimeToken = runtimeWords[0];
    const entryToken = entryWords[0];
    if (!runtimeToken || !entryToken) return null;
    const runtimePath = normalizeStaticPath(runtimeToken);
    const entryPath = normalizeStaticPath(entryToken);
    if (!runtimePath || !entryPath || path.basename(runtimePath) !== "node")
      return null;
    const packageMatch = entryPath.match(
      /^(.*\/node_modules\/@earendil-works\/pi-coding-agent)\/dist\/cli\.js$/u
    );
    if (!packageMatch) return null;
    const info = packageInfo(packageMatch[1]!);
    if (!info) return null;
    const wrapperArgs = lines.flatMap((line) => {
      if (!/^\s*export\s+/u.test(line)) return [];
      const match = line.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=(.*?)\s*$/u);
      if (!match) return [];
      const variableName = match[1]!;
      const value = match[2]!;
      if (value.includes("$") || value.includes("`")) return [];
      const quoteWrapped =
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")));
      return [
        [variableName, quoteWrapped ? value.slice(1, -1) : value] as const
      ];
    });
    const exportLines = lines.filter((line) => /^\s*export\s+/u.test(line));
    const runtimeStat = fs.statSync(runtimePath);
    const sandboxStat = fs.statSync(execWords[1]!);
    const profileStat = fs.statSync(profilePath);
    const allowedPrefix = lines
      .slice(1, execLineIndex)
      .filter((line) => line.trim().length > 0);
    if (
      !runtimeStat.isFile() ||
      !sandboxStat.isFile() ||
      !profileStat.isFile() ||
      path.basename(execWords[1]!) !== "sandbox-exec" ||
      allowedPrefix.some(
        (line) => !/^\s*export\s+[A-Z_][A-Z0-9_]*=/u.test(line)
      ) ||
      wrapperArgs.length !== exportLines.length ||
      wrapperArgs.some(([name]) => !allowedWrapperEnvironment.has(name)) ||
      (fs.statSync(wrapperPath).mode & 0o111) === 0
    )
      return null;
    const wrappedEnvironment = { ...environment };
    for (const [name, value] of wrapperArgs) wrappedEnvironment[name] = value;
    return {
      sdkEntryPath: info.sdkEntryPath,
      execPath: fs.realpathSync(execWords[1]!),
      execArgv: [
        "-f",
        fs.realpathSync(profilePath),
        fs.realpathSync(runtimePath)
      ],
      environment: wrappedEnvironment
    };
  } catch {
    return null;
  }
};

export const resolvePiSdkInstallation = (input: {
  executablePath: string;
  environment: NodeJS.ProcessEnv;
}): PiSdkInstallation => {
  let canonicalExecutable: string;
  try {
    canonicalExecutable = fs.realpathSync(input.executablePath);
  } catch {
    throw new Error("AiClientExecutableUnavailable");
  }
  try {
    const firstLine = fs
      .readFileSync(canonicalExecutable, "utf8")
      .slice(0, 128)
      .split(/\r?\n/u, 1)[0]!
      .toLowerCase();
    if (firstLine.startsWith("#!")) {
      const wrapped = shellWrapperSettings(
        canonicalExecutable,
        input.environment
      );
      if (wrapped) return wrapped;
      if (!firstLine.includes("node")) throw new Error("AiClientPiUnavailable");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "AiClientPiUnavailable")
      throw error;
    throw new Error("AiClientPiUnavailable", { cause: error });
  }
  const direct = findPackageForFile(canonicalExecutable);
  if (direct)
    return {
      ...direct,
      execPath: process.execPath,
      execArgv: [],
      environment: input.environment
    };
  throw new Error("AiClientPiUnavailable");
};
