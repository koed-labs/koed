import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const inspectSymbols = (path, platform, run, addon) => {
  const result = run(
    "nm",
    [...(platform === "linux" ? ["-D"] : []), "-g", path],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    }
  );
  if (result.error)
    throw new Error(
      `Native addon scanner failed for ${path}: ${result.error.message}`
    );
  if (result.status !== 0 || typeof result.stdout !== "string")
    throw new Error(
      `Native addon scanner failed for ${path}: ${result.stderr || `exit ${result.status}`}`
    );
  let registration = false;
  for (const line of result.stdout.split("\n").filter((line) => line.trim())) {
    const match = line.match(/^\s*(?:[0-9a-fA-F]+\s+)?([A-Za-z?])\s+(\S+)\s*$/);
    if (!match)
      throw new Error(
        `Native addon scanner returned malformed output for ${path}: ${line}`
      );
    const [, type, raw] = match;
    const symbol = (
      platform === "macos" && raw.startsWith("_") ? raw.slice(1) : raw
    ).split("@")[0];
    const undefinedSymbol = type === "U" || type === "w" || type === "v";
    if (
      /^node_register_module_v\d+$|^node_module_register$/.test(symbol) ||
      (undefinedSymbol &&
        /^_Z(?:N|NK|TV|TI|TS)(?:N)?(?:2v8|4node)\d/.test(symbol))
    )
      throw new Error(`Native addon ${path} uses Node/V8 ABI symbol ${symbol}`);
    if (
      (symbol === "napi_register_module_v1" && /^[TW]$/.test(type)) ||
      (symbol === "napi_module_register" && undefinedSymbol)
    )
      registration = true;
  }
  if (addon && !registration)
    throw new Error(`Native addon ${path} lacks N-API registration evidence`);
};

export const scanNativeAddons = (root, platform, run = spawnSync) => {
  if (!["macos", "linux"].includes(platform))
    throw new Error(`Unsupported native addon target: ${platform}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink())
        throw new Error(`Native addon scan encountered symlink: ${path}`);
      else if (
        entry.isFile() &&
        /(?:\.node|\.dylib|\.so(?:\.\d+)*)$/.test(entry.name)
      )
        files.push(path);
    }
  };
  visit(root);
  files.sort();
  const result = { addons: [], libraries: [] };
  for (const path of files) {
    const addon = path.endsWith(".node");
    inspectSymbols(path, platform, run, addon);
    result[addon ? "addons" : "libraries"].push(
      relative(root, path).replaceAll("\\", "/")
    );
  }
  return result;
};
