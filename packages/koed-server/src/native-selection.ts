import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { KoedServerPaths } from "./paths.js";
import { canonicalArtifactJson } from "./artifact-canonical-json.mjs";
import { renameAtomically } from "./generation-lifecycle-filesystem.js";
import { assertDirectoryChain } from "./generation-lifecycle.js";
import {
  nativeDigest,
  nativeJsonObject,
  readNativeMetadata,
  syncNativeDirectory,
  verifyNativePayload
} from "./native-payload-admission.js";
import {
  compareNativeVersions,
  validateNativeRuntimeCatalog,
  selectNativeRuntimeCatalog,
  nativeKind,
  type NativePin,
  type NativeCudaPin,
  type NativeCorePin,
  type NativeRuntimeCatalog
} from "./native-runtime-catalog.js";

export const releaseInstallCommand =
  "koed runtime install --provider release --dependency-mode bundled-local";
export const nativeStore = (paths: KoedServerPaths) =>
  resolve(paths.koedHome, "runtime/native");
export const nativePathExists = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined;
export const payloadRoot = (paths: KoedServerPaths, pin: NativePin) =>
  resolve(nativeStore(paths), nativeKind(pin), pin.recipeId);
const coreLinks = (pin: NativeCorePin) => [
  "postgres",
  `llama.cpp/${pin.target.platform === "macos" ? "metal" : "cpu"}`,
  "llama.cpp/llama-server"
];
const entryNames = ["postgres", "llama.cpp"] as const;
const document = (pin: NativeCorePin, cuda: NativeCudaPin | null) => ({
  schemaVersion: 1,
  core: pin,
  cuda
});

// A later product release can serve the same verified bytes at a new URL.
function conflictsWithPin(
  installed: NativePin,
  current: NativePin | null
): boolean {
  return (
    current?.recipeId === installed.recipeId &&
    canonicalArtifactJson({ ...installed, url: current.url }) !==
      canonicalArtifactJson(current)
  );
}

function checkLink(path: string, target: string): void {
  if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target)
    throw new Error(`Unexpected native runtime link: ${path}`);
}

// Only these exact entry links may survive an interrupted first activation.
function checkEntryPaths(paths: KoedServerPaths, requireLinks: boolean): void {
  const runtime = dirname(nativeStore(paths));
  assertDirectoryChain(paths.koedHome, runtime);
  assertDirectoryChain(paths.koedHome, paths.cacheDir);
  const store = nativeStore(paths);
  if (
    nativePathExists(store) &&
    readdirSync(store).some(
      (name) =>
        !["core", "selections", "cuda", "current"].includes(name) &&
        !/^\.stage-[A-Za-z0-9]{6}$/.test(name) &&
        !/^\.current-[a-f0-9-]{36}$/.test(name)
    )
  )
    throw new Error(
      "Unrecognized native store contents. Inspect the existing runtime or use a fresh KOED_HOME."
    );
  for (const name of ["runtime-homebrew.json", "runtime-packaged.json"]) {
    if (nativePathExists(resolve(paths.cacheDir, name)))
      throw new Error(
        "An existing native provider owns this installation. Keep using that provider or use a fresh KOED_HOME."
      );
  }
  for (const name of entryNames) {
    const path = resolve(runtime, name);
    if (!requireLinks && !nativePathExists(path)) continue;
    if (
      !lstatSync(path).isSymbolicLink() ||
      readlinkSync(path) !== `native/current/${name}`
    )
      throw new Error(
        `Unrecognized native entry ${path}. Keep using its current provider or choose a fresh KOED_HOME.`
      );
  }
}

export function currentNativeId(paths: KoedServerPaths): string | null {
  const store = nativeStore(paths),
    pointer = resolve(store, "current");
  assertDirectoryChain(paths.koedHome, store);
  if (!nativePathExists(pointer)) return null;
  const match = /^selections\/([a-f0-9]{64})$/.exec(readlinkSync(pointer));
  if (!match) throw new Error("Invalid native selection pointer.");
  return match[1]!;
}

function loadSelection(
  paths: KoedServerPaths,
  id: string,
  catalog: NativeRuntimeCatalog
) {
  const root = resolve(nativeStore(paths), "selections", id);
  assertDirectoryChain(paths.koedHome, resolve(root, "llama.cpp"));
  // Previously admitted pins are local receipts. Require the private store
  // and selection receipt to remain under the installing user's control.
  for (const path of [
    nativeStore(paths),
    dirname(root),
    root,
    resolve(root, "selection.json")
  ]) {
    const stat = lstatSync(path);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw new Error("Native selection ownership or permissions changed.");
  }
  const raw = readNativeMetadata(resolve(root, "selection.json"), 16 * 1024);
  if (nativeDigest(raw) !== id)
    throw new Error("Native selection metadata changed.");
  const record = nativeJsonObject(raw);
  const core = record.core;
  if (
    typeof core === "object" &&
    core !== null &&
    "target" in core &&
    typeof core.target === "object" &&
    core.target !== null &&
    "platform" in core.target &&
    (core.target.platform === "linux" || core.target.platform === "macos") &&
    core.target.platform !== catalog.core.target.platform
  )
    throw new NativeSelectionTargetError();
  const receipt = {
    schemaVersion: 1,
    minimumCoreVersion: "0.0.0",
    core: record.core,
    cuda: record.cuda
  };
  let pin: NativeCorePin, cuda: NativeCudaPin | null;
  try {
    ({ core: pin, cuda } =
      catalog.core.target.platform === "linux"
        ? validateNativeRuntimeCatalog(receipt)
        : selectNativeRuntimeCatalog(
            { schemaVersion: 2, linux: null, macos: receipt },
            "darwin",
            "arm64"
          ));
  } catch (cause) {
    throw new Error(
      "Native selection target or receipt is incompatible with the reviewed host catalog.",
      { cause }
    );
  }
  if (
    canonicalArtifactJson(document(pin, cuda)) !== raw.toString("utf8") ||
    (cuda && conflictsWithPin(cuda, catalog.cuda)) ||
    conflictsWithPin(pin, catalog.core)
  )
    throw new Error("Native selection conflicts with the reviewed identity.");
  if (
    canonicalArtifactJson(readdirSync(root).sort()) !==
      canonicalArtifactJson(["llama.cpp", "postgres", "selection.json"]) ||
    canonicalArtifactJson(readdirSync(resolve(root, "llama.cpp")).sort()) !==
      canonicalArtifactJson(
        pin.target.platform === "macos"
          ? ["llama-server", "metal"]
          : cuda
            ? ["cpu", "cuda", "llama-server"]
            : ["cpu", "llama-server"]
      )
  )
    throw new Error("Unexpected native selection contents.");
  const payload = payloadRoot(paths, pin);
  assertDirectoryChain(paths.koedHome, payload);
  for (const name of coreLinks(pin)) {
    const path = resolve(root, name);
    checkLink(path, relative(dirname(path), resolve(payload, name)));
  }
  verifyNativePayload(payload, pin);
  if (cuda) {
    const cudaRoot = payloadRoot(paths, cuda),
      name = "llama.cpp/cuda";
    assertDirectoryChain(paths.koedHome, cudaRoot);
    checkLink(
      resolve(root, name),
      relative(resolve(root, "llama.cpp"), resolve(cudaRoot, name))
    );
    verifyNativePayload(cudaRoot, cuda);
  }
  return { id, root, pin, cuda };
}

export class NativeSelectionTargetError extends Error {
  constructor() {
    super(
      "Native selection target differs from this host. Stop Koed, preserve the existing native store, and use a fresh KOED_HOME before installing the runtime. The new KOED_HOME does not include the existing database or other data."
    );
  }
}

export function readNativeSelection(
  paths: KoedServerPaths,
  catalog: NativeRuntimeCatalog
) {
  const id = currentNativeId(paths);
  checkEntryPaths(paths, id !== null);
  if (!id) return null;
  try {
    return loadSelection(paths, id, catalog);
  } catch (cause) {
    if (cause instanceof NativeSelectionTargetError) throw cause;
    const detail = (
      cause instanceof Error ? cause.message : String(cause)
    ).replace(/\.$/, "");
    throw new Error(
      `Cannot admit the installed native selection: ${detail}. Stop Koed, preserve the damaged native store for recovery, then run ${releaseInstallCommand}.`,
      { cause }
    );
  }
}

// An installed core may lag the pinned core. It stays startable while it meets the
// reviewed minimum version and implements the same native contracts.
export function coreStartBlocker(
  pin: NativeCorePin,
  catalog: NativeRuntimeCatalog
): string | null {
  if (compareNativeVersions(pin.runtimeVersion, catalog.minimumCoreVersion) < 0)
    return `Native core ${pin.runtimeVersion} is below the required ${catalog.minimumCoreVersion}`;
  if (
    canonicalArtifactJson(pin.contracts) !==
    canonicalArtifactJson(catalog.core.contracts)
  )
    return `Native core ${pin.runtimeVersion} implements contracts ${canonicalArtifactJson(pin.contracts)}, but this Control Plane requires ${canonicalArtifactJson(catalog.core.contracts)}`;
  return null;
}

export function assertStartableCore(
  pin: NativeCorePin,
  catalog: NativeRuntimeCatalog
): void {
  const blocker = coreStartBlocker(pin, catalog);
  if (blocker)
    throw new Error(`${blocker}. Stop Koed and run ${releaseInstallCommand}.`);
}

export function composeNativeSelection(
  paths: KoedServerPaths,
  pin: NativeCorePin,
  staging: string,
  catalog: NativeRuntimeCatalog,
  cuda: NativeCudaPin | null = null
) {
  const bytes = canonicalArtifactJson(document(pin, cuda)),
    id = nativeDigest(bytes);
  const root = resolve(nativeStore(paths), "selections", id);
  assertDirectoryChain(paths.koedHome, root);
  if (!nativePathExists(root)) {
    const fresh = resolve(staging, "selection");
    mkdirSync(resolve(fresh, "llama.cpp"), { recursive: true, mode: 0o700 });
    writeFileSync(resolve(fresh, "selection.json"), bytes, {
      flag: "wx",
      mode: 0o600,
      flush: true
    });
    for (const name of coreLinks(pin)) {
      const target = relative(
        dirname(resolve(root, name)),
        resolve(payloadRoot(paths, pin), name)
      );
      symlinkSync(target, resolve(fresh, name));
    }
    if (cuda) {
      const name = "llama.cpp/cuda";
      symlinkSync(
        relative(
          resolve(root, "llama.cpp"),
          resolve(payloadRoot(paths, cuda), name)
        ),
        resolve(fresh, name)
      );
    }
    syncNativeDirectory(resolve(fresh, "llama.cpp"));
    syncNativeDirectory(fresh);
    renameSync(fresh, root);
    syncNativeDirectory(dirname(root));
  }
  return loadSelection(paths, id, catalog);
}

export function activateNativeSelection(
  paths: KoedServerPaths,
  id: string
): void {
  const store = nativeStore(paths),
    runtime = dirname(store);
  for (const name of entryNames) {
    const path = resolve(runtime, name),
      target = `native/current/${name}`;
    if (nativePathExists(path)) checkLink(path, target);
    else symlinkSync(target, path);
  }
  syncNativeDirectory(runtime);
  syncNativeDirectory(paths.koedHome);
  const tmp = resolve(store, `.current-${randomUUID()}`);
  symlinkSync(`selections/${id}`, tmp);
  try {
    renameAtomically(tmp, resolve(store, "current"));
    syncNativeDirectory(store);
  } finally {
    rmSync(tmp, { force: true });
  }
}
