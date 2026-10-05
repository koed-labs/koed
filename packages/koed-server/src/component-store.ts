import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createWriteStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep
} from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import properLockfile from "proper-lockfile";
import type {
  ArtifactTarget,
  ComponentId,
  ComponentManifest,
  ComponentSignature,
  RuntimeIdentity,
  RuntimeOwner,
  VerifiedComponent,
  VerifiedGeneration
} from "./component-contract.js";
import type { KoedServerPaths } from "./paths.js";
import { extractVerifiedPackageArchive } from "./package-runtime.js";
import { discoverActualRuntimeIdentity } from "./component-runtime-identity.js";
import { productionComponentTrustRoots } from "./component-trust-roots.js";
import {
  verifyComponent,
  verifyExtractedComponent
} from "./component-verification.js";

export type ComponentSource =
  | {
      kind: "offline";
      archivePath: string;
      manifestPath: string;
      signaturePath: string;
    }
  | {
      kind: "remote";
      archiveUrl: string;
      manifestUrl: string;
      signatureUrl: string;
    };

export interface ComponentInstallContext {
  expectedComponent: ComponentId;
  expectedVersion: string;
  target: ArtifactTarget;
  runtime: RuntimeIdentity;
  signal?: AbortSignal;
  progress?: (event: {
    phase: string;
    transferredBytes: number;
    totalBytes?: number;
  }) => void;
}

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 8 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_GENERATION_RECORD_BYTES =
  2 * MAX_MANIFEST_BYTES + 2 * MAX_SIGNATURE_BYTES + 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const hash = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const aborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error("component installation cancelled");
};
const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Response cleanup is best-effort after a rejected transfer.
  }
};
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const parseSignature = (value: unknown): ComponentSignature => {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ["schemaVersion", "keyId", "algorithm", "signature"]) ||
    value.schemaVersion !== 1 ||
    typeof value.keyId !== "string" ||
    typeof value.signature !== "string" ||
    value.algorithm !== "ed25519"
  )
    throw new Error("component signature JSON is invalid");
  return {
    schemaVersion: 1,
    keyId: value.keyId,
    algorithm: "ed25519",
    signature: value.signature
  };
};
const assertInside = (base: string, path: string): void => {
  const rel = relative(resolve(base), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("component store path escaped KOED_HOME");
};
const assertDirectoryChain = (base: string, path: string): void => {
  assertInside(base, path);
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        "component store path contains a non-directory or symbolic link"
      );
  }
};
const ensureSecureDirectory = (home: string, directory: string): void => {
  assertDirectoryChain(home, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertDirectoryChain(home, directory);
};
const privateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("component store directory is not a regular directory");
  chmodSync(path, 0o700);
};
const runtimeMatches = (
  given: RuntimeIdentity,
  actual: RuntimeIdentity
): boolean => canonicalJson(given) === canonicalJson(actual);
const parseJsonFile = (
  path: string,
  maxBytes: number,
  requireCanonical = false
): unknown => {
  if (constants.O_NOFOLLOW === undefined)
    throw new Error("component metadata no-follow access is unavailable");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("component metadata is not a bounded regular file");
    const bytes = readFileSync(descriptor, "utf8");
    const value: unknown = JSON.parse(bytes);
    if (requireCanonical && canonicalJson(value) !== bytes)
      throw new Error("component metadata is not canonical JSON");
    return value;
  } finally {
    closeSync(descriptor);
  }
};
const readOfflineSource = (
  source: Extract<ComponentSource, { kind: "offline" }>
) => {
  const archivePath = resolve(source.archivePath);
  const archiveStat = lstatSync(archivePath);
  if (
    !archiveStat.isFile() ||
    archiveStat.isSymbolicLink() ||
    archiveStat.size > MAX_ARCHIVE_BYTES
  )
    throw new Error("component archive is not a bounded regular file");
  return {
    archivePath,
    manifestBytes: readBoundedFile(source.manifestPath, MAX_MANIFEST_BYTES),
    signatureBytes: readBoundedFile(source.signaturePath, MAX_SIGNATURE_BYTES)
  };
};
const readBoundedFile = (path: string, limit: number): Buffer => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error("component metadata is not a bounded regular file");
  return readFileSync(path);
};

async function fetchBounded(
  urlText: string,
  destination: string,
  limit: number,
  signal: AbortSignal | undefined,
  progress?: ComponentInstallContext["progress"],
  collectBytes = true,
  attempt = 0
): Promise<Buffer | undefined> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("component source URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("component downloads require safe HTTPS URLs");
  for (let redirects = 0; ; redirects++) {
    aborted(signal);
    let response: Response;
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted)
        throw new Error("component installation cancelled", { cause: error });
      if (attempt < 2 && error instanceof TypeError) {
        await new Promise((resolveRetry) =>
          setTimeout(resolveRetry, 100 * (attempt + 1))
        );
        return fetchBounded(
          url.href,
          destination,
          limit,
          signal,
          progress,
          collectBytes,
          attempt + 1
        );
      }
      throw error;
    }
    if (response.status >= 500 && attempt < 2) {
      await cancelBody(response);
      await new Promise((resolveRetry) =>
        setTimeout(resolveRetry, 100 * (attempt + 1))
      );
      return fetchBounded(
        url.href,
        destination,
        limit,
        signal,
        progress,
        collectBytes,
        attempt + 1
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= MAX_REDIRECTS) {
        await cancelBody(response);
        throw new Error("too many component redirects");
      }
      const location = response.headers.get("location");
      if (!location) {
        await cancelBody(response);
        throw new Error("component redirect has no location");
      }
      try {
        url = new URL(location, url);
      } catch {
        await cancelBody(response);
        throw new Error("component redirect URL is invalid");
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        await cancelBody(response);
        throw new Error("component redirect requires safe HTTPS");
      }
      await cancelBody(response);
      continue;
    }
    if (!response.ok || !response.body) {
      await cancelBody(response);
      throw new Error(`component download failed with HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) {
      await cancelBody(response);
      throw new Error("component download exceeds size limit");
    }
    let transferredBytes = 0;
    const chunks: Buffer[] = [];
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferredBytes += chunk.length;
        if (transferredBytes > limit) {
          callback(new Error("component download exceeds size limit"));
          return;
        }
        progress?.({
          phase: basename(destination),
          transferredBytes,
          ...(Number.isFinite(length) && length > 0
            ? { totalBytes: length }
            : {})
        });
        if (collectBytes) chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      }
    });
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as unknown as NodeReadableStream<Uint8Array>
        ),
        limiter,
        output,
        { signal: requestSignal }
      );
    } catch (error) {
      rmSync(destination, { force: true });
      if (signal?.aborted)
        throw new Error("component installation cancelled", { cause: error });
      if (attempt < 2 && error instanceof TypeError) {
        await new Promise((resolveRetry) =>
          setTimeout(resolveRetry, 100 * (attempt + 1))
        );
        return fetchBounded(
          url.href,
          destination,
          limit,
          signal,
          progress,
          collectBytes,
          attempt + 1
        );
      }
      throw error;
    }
    return collectBytes ? Buffer.concat(chunks) : undefined;
  }
}

async function acquireLock<T>(
  home: string,
  root: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>
): Promise<T> {
  ensureSecureDirectory(home, root);
  let release: (() => Promise<void>) | undefined;
  for (let attempt = 0; !release; attempt++) {
    aborted(signal);
    assertDirectoryChain(home, root);
    try {
      release = await properLockfile.lock(root, {
        realpath: false,
        retries: 0
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 20)
        throw error;
      await new Promise<void>((resolveDelay, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        const timer = setTimeout(() => {
          cleanup();
          resolveDelay();
        }, 25);
        const cancel = () => {
          clearTimeout(timer);
          cleanup();
          reject(new Error("component installation cancelled"));
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    }
  }
  try {
    aborted(signal);
    assertDirectoryChain(home, root);
    return await fn();
  } finally {
    await release();
  }
}

function targetKey(manifest: ComponentManifest): string {
  return hash(
    canonicalJson({
      component: manifest.component,
      productVersion: manifest.productVersion,
      target: manifest.target
    })
  ).slice(0, 24);
}
function validateOwner(owner: unknown): asserts owner is RuntimeOwner {
  if (
    !isPlainRecord(owner) ||
    !exactKeys(owner, ["kind", "installationId"]) ||
    !["cli", "desktop", "standalone"].includes(String(owner.kind)) ||
    typeof owner.installationId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(owner.installationId)
  )
    throw new Error("runtime owner is invalid");
}
function writeIndex(
  home: string,
  indexPath: string,
  manifestDigest: string,
  tempRoot: string,
  signal?: AbortSignal
): void {
  const temporaryIndex = resolve(tempRoot, `index-${manifestDigest}.json`);
  writeFileSync(temporaryIndex, JSON.stringify({ manifestDigest }), {
    flag: "wx",
    mode: 0o600
  });
  aborted(signal);
  assertDirectoryChain(home, dirname(indexPath));
  renameSync(temporaryIndex, indexPath);
}
function componentRecordPath(root: string): string {
  return resolve(root, "component.json");
}
function componentPayloadPath(root: string): string {
  return resolve(root, "payload");
}
function readComponentRecord(path: string): {
  schemaVersion: 1;
  manifest: unknown;
  signature: ComponentSignature;
  manifestDigest: string;
  archivePath: string;
} {
  const value = parseJsonFile(
    path,
    MAX_MANIFEST_BYTES + MAX_SIGNATURE_BYTES + 32_768
  );
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "manifest",
      "signature",
      "manifestDigest",
      "archivePath"
    ]) ||
    value.schemaVersion !== 1 ||
    !isPlainRecord(value.manifest) ||
    typeof value.manifestDigest !== "string" ||
    typeof value.archivePath !== "string"
  )
    throw new Error("stored component record is invalid");
  const signature = parseSignature(value.signature);
  return {
    schemaVersion: 1,
    manifest: value.manifest,
    signature,
    manifestDigest: value.manifestDigest,
    archivePath: value.archivePath
  };
}
async function verifyStoredComponent(
  home: string,
  root: string,
  expected: {
    component: ComponentId;
    productVersion?: string;
    runtime: RuntimeIdentity;
    target?: ArtifactTarget;
  }
): Promise<VerifiedComponent> {
  assertDirectoryChain(home, root);
  const record = readComponentRecord(componentRecordPath(root));
  const manifestBytes = Buffer.from(canonicalJson(record.manifest));
  if (hash(manifestBytes) !== record.manifestDigest)
    throw new Error("stored component manifest digest mismatch");
  const archivePath = resolve(root, record.archivePath);
  assertInside(root, archivePath);
  const manifest = await verifyComponent({
    manifestBytes,
    signature: record.signature,
    archivePath,
    expectedComponent: expected.component,
    ...(expected.productVersion
      ? { expectedVersion: expected.productVersion }
      : {}),
    ...(expected.target ? { target: expected.target } : {}),
    runtime: expected.runtime,
    trustedKeys: productionComponentTrustRoots
  });
  if (archivePath !== resolve(root, manifest.archive.name))
    throw new Error("stored component archive path is invalid");
  const archiveStat = lstatSync(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink())
    throw new Error("stored component archive is not a regular file");
  const payload = componentPayloadPath(root);
  assertDirectoryChain(root, payload);
  await verifyExtractedComponent(payload, manifest);
  return { manifest, root: payload, manifestDigest: record.manifestDigest };
}

async function stageComponentInternal(
  paths: KoedServerPaths,
  source: ComponentSource,
  context: ComponentInstallContext,
  trustedKeys: ReadonlyMap<string, string>,
  runtime: RuntimeIdentity
): Promise<VerifiedComponent> {
  aborted(context.signal);
  const storeRoot = resolve(paths.componentsDir);
  assertInside(paths.koedHome, storeRoot);
  assertDirectoryChain(paths.koedHome, storeRoot);
  return acquireLock(paths.koedHome, storeRoot, context.signal, async () => {
    const tempRoot = mkdtempSync(resolve(storeRoot, ".stage-"));
    chmodSync(tempRoot, 0o700);
    let publishedRoot: string | undefined;
    let committed = false;
    try {
      let manifestBytes: Buffer;
      let signatureBytes: Buffer;
      if (source.kind === "offline") {
        const offline = readOfflineSource(source);
        manifestBytes = offline.manifestBytes;
        signatureBytes = offline.signatureBytes;
      } else {
        manifestBytes = (await fetchBounded(
          source.manifestUrl,
          resolve(tempRoot, "manifest.json"),
          MAX_MANIFEST_BYTES,
          context.signal,
          context.progress
        ))!;
        signatureBytes = (await fetchBounded(
          source.signatureUrl,
          resolve(tempRoot, "signature.json"),
          MAX_SIGNATURE_BYTES,
          context.signal,
          context.progress
        ))!;
      }
      const manifestEnvelope: unknown = JSON.parse(
        manifestBytes.toString("utf8")
      );
      if (
        !isPlainRecord(manifestEnvelope) ||
        !isPlainRecord(manifestEnvelope.archive) ||
        typeof manifestEnvelope.archive.name !== "string" ||
        manifestEnvelope.archive.name.length > 255 ||
        [".", ".."].includes(manifestEnvelope.archive.name) ||
        basename(manifestEnvelope.archive.name) !==
          manifestEnvelope.archive.name
      )
        throw new Error("component archive metadata is invalid");
      const archivePath = resolve(tempRoot, manifestEnvelope.archive.name);
      if (source.kind === "offline") {
        copyFileSync(resolve(source.archivePath), archivePath, 1);
        chmodSync(archivePath, 0o600);
      } else {
        await fetchBounded(
          source.archiveUrl,
          archivePath,
          MAX_ARCHIVE_BYTES,
          context.signal,
          context.progress,
          false
        );
      }
      aborted(context.signal);
      const signature = parseSignature(
        JSON.parse(signatureBytes.toString("utf8")) as unknown
      );
      const manifest = await verifyComponent({
        manifestBytes,
        signature,
        archivePath,
        expectedComponent: context.expectedComponent,
        expectedVersion: context.expectedVersion,
        target: context.target,
        runtime,
        trustedKeys
      });
      aborted(context.signal);
      const manifestDigest = hash(manifestBytes);
      const componentDir = resolve(storeRoot, manifest.component);
      assertDirectoryChain(paths.koedHome, componentDir);
      ensureSecureDirectory(paths.koedHome, componentDir);
      const indexPath = resolve(componentDir, `${targetKey(manifest)}.json`);
      const versionRoot = resolve(
        componentDir,
        manifest.productVersion,
        manifestDigest
      );
      assertDirectoryChain(paths.koedHome, versionRoot);
      assertDirectoryChain(paths.koedHome, dirname(indexPath));
      if (existsSync(indexPath)) {
        const index = parseJsonFile(indexPath, 4096);
        if (!isPlainRecord(index) || index.manifestDigest !== manifestDigest)
          throw new Error(
            "component version already installed with different digest"
          );
      }
      if (existsSync(versionRoot)) {
        const cached = await verifyStoredComponent(
          paths.koedHome,
          versionRoot,
          {
            component: manifest.component,
            productVersion: manifest.productVersion,
            target: manifest.target,
            runtime
          }
        );
        aborted(context.signal);
        if (cached.manifestDigest !== manifestDigest)
          throw new Error(
            "component version already installed with different digest"
          );
        if (!existsSync(indexPath)) {
          aborted(context.signal);
          assertDirectoryChain(paths.koedHome, dirname(indexPath));
          writeIndex(
            paths.koedHome,
            indexPath,
            manifestDigest,
            tempRoot,
            context.signal
          );
        }
        return cached;
      }
      if (existsSync(indexPath))
        throw new Error("component cache record is missing");
      ensureSecureDirectory(paths.koedHome, dirname(versionRoot));
      const stagedRoot = resolve(tempRoot, "verified");
      const completeRoot = resolve(tempRoot, "complete");
      aborted(context.signal);
      await extractVerifiedPackageArchive(archivePath, stagedRoot);
      aborted(context.signal);
      await verifyExtractedComponent(stagedRoot, manifest);
      aborted(context.signal);
      assertDirectoryChain(paths.koedHome, dirname(versionRoot));
      privateDirectory(completeRoot);
      renameSync(stagedRoot, resolve(completeRoot, "payload"));
      const storedArchive = resolve(completeRoot, manifest.archive.name);
      renameSync(archivePath, storedArchive);
      writeFileSync(
        componentRecordPath(completeRoot),
        JSON.stringify({
          schemaVersion: 1,
          manifest,
          signature,
          manifestDigest,
          archivePath: resolve(versionRoot, manifest.archive.name)
        }),
        { flag: "wx", mode: 0o600 }
      );
      aborted(context.signal);
      assertDirectoryChain(paths.koedHome, dirname(versionRoot));
      renameSync(completeRoot, versionRoot);
      publishedRoot = versionRoot;
      aborted(context.signal);
      assertDirectoryChain(paths.koedHome, dirname(indexPath));
      writeIndex(
        paths.koedHome,
        indexPath,
        manifestDigest,
        tempRoot,
        context.signal
      );
      committed = true;
      return {
        manifest,
        root: componentPayloadPath(versionRoot),
        manifestDigest
      };
    } finally {
      if (publishedRoot && !committed)
        rmSync(publishedRoot, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

export async function stageComponent(
  paths: KoedServerPaths,
  input: ComponentSource,
  context: ComponentInstallContext
): Promise<VerifiedComponent> {
  const actualRuntime = discoverActualRuntimeIdentity();
  if (!runtimeMatches(context.runtime, actualRuntime))
    throw new Error("caller runtime identity does not match actual runtime");
  return stageComponentInternal(
    paths,
    input,
    context,
    productionComponentTrustRoots,
    actualRuntime
  );
}

export async function stageGeneration(
  paths: KoedServerPaths,
  input: {
    base: VerifiedComponent;
    privacy?: VerifiedComponent;
    owner: RuntimeOwner;
  }
): Promise<VerifiedGeneration> {
  const actualRuntime = discoverActualRuntimeIdentity();
  validateOwner(input.owner);
  const { base, privacy } = input;
  assertDirectoryChain(paths.koedHome, paths.componentsDir);
  assertDirectoryChain(paths.componentsDir, dirname(base.root));
  const baseVerified = await verifyStoredComponent(
    paths.koedHome,
    dirname(base.root),
    {
      component: "base",
      runtime: actualRuntime
    }
  );
  if (
    baseVerified.manifestDigest !== base.manifestDigest ||
    resolve(baseVerified.root) !== resolve(base.root)
  )
    throw new Error("base component is not a verified store entry");
  let privacyVerified: VerifiedComponent | undefined;
  if (privacy) {
    assertDirectoryChain(paths.componentsDir, dirname(privacy.root));
    privacyVerified = await verifyStoredComponent(
      paths.koedHome,
      dirname(privacy.root),
      {
        component: "privacy",
        runtime: actualRuntime
      }
    );
    if (
      privacyVerified.manifestDigest !== privacy.manifestDigest ||
      resolve(privacyVerified.root) !== resolve(privacy.root)
    )
      throw new Error("privacy component is not a verified store entry");
  }
  if (
    privacyVerified &&
    baseVerified.manifest.productVersion !==
      privacyVerified.manifest.productVersion
  )
    throw new Error("mixed component versions");
  if (
    privacyVerified &&
    canonicalJson(baseVerified.manifest.target) !==
      canonicalJson(privacyVerified.manifest.target)
  )
    throw new Error("mixed component targets");
  const identity = {
    schemaVersion: 1,
    productVersion: baseVerified.manifest.productVersion,
    owner: input.owner,
    base: {
      manifestDigest: baseVerified.manifestDigest,
      root: relative(paths.koedHome, baseVerified.root)
    },
    ...(privacyVerified
      ? {
          privacy: {
            manifestDigest: privacyVerified.manifestDigest,
            root: relative(paths.koedHome, privacyVerified.root)
          }
        }
      : {})
  };
  const id = hash(canonicalJson(identity));
  const generationRoot = resolve(paths.generationsDir, id);
  assertDirectoryChain(paths.koedHome, generationRoot);
  assertDirectoryChain(paths.koedHome, paths.generationsDir);
  return acquireLock(
    paths.koedHome,
    paths.generationsDir,
    undefined,
    async () => {
      if (existsSync(generationRoot)) return readStagedGeneration(paths, id);
      ensureSecureDirectory(paths.koedHome, paths.generationsDir);
      const tempRoot = mkdtempSync(resolve(paths.generationsDir, ".stage-"));
      chmodSync(tempRoot, 0o700);
      try {
        const freshBase = await verifyStoredComponent(
          paths.koedHome,
          dirname(baseVerified.root),
          {
            component: "base",
            runtime: actualRuntime
          }
        );
        const freshPrivacy = privacyVerified
          ? await verifyStoredComponent(
              paths.koedHome,
              dirname(privacyVerified.root),
              {
                component: "privacy",
                runtime: actualRuntime
              }
            )
          : undefined;
        const record = {
          ...identity,
          id,
          components: {
            base: {
              manifest: freshBase.manifest,
              manifestDigest: freshBase.manifestDigest
            },
            ...(privacyVerified
              ? {
                  privacy: {
                    manifest: freshPrivacy!.manifest,
                    manifestDigest: freshPrivacy!.manifestDigest
                  }
                }
              : {})
          }
        };
        const recordBytes = Buffer.from(canonicalJson(record));
        if (recordBytes.length > MAX_GENERATION_RECORD_BYTES)
          throw new Error("generation record exceeds size limit");
        writeFileSync(resolve(tempRoot, "generation.json"), recordBytes, {
          flag: "wx",
          mode: 0o600
        });
        assertDirectoryChain(paths.koedHome, paths.generationsDir);
        assertDirectoryChain(paths.generationsDir, generationRoot);
        renameSync(tempRoot, generationRoot);
        return {
          id,
          productVersion: identity.productVersion,
          base: baseVerified,
          ...(privacyVerified ? { privacy: privacyVerified } : {}),
          owner: input.owner
        };
      } finally {
        if (existsSync(tempRoot))
          rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  );
}

export async function readStagedGeneration(
  paths: KoedServerPaths,
  id: string
): Promise<VerifiedGeneration> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("generation id is invalid");
  assertDirectoryChain(paths.koedHome, paths.generationsDir);
  const root = resolve(paths.generationsDir, id);
  assertDirectoryChain(paths.generationsDir, root);
  const record = parseJsonFile(
    resolve(root, "generation.json"),
    MAX_GENERATION_RECORD_BYTES,
    true
  );
  if (
    !isPlainRecord(record) ||
    !exactKeys(record, [
      "schemaVersion",
      "productVersion",
      "owner",
      "base",
      "components",
      "id",
      ...(Object.hasOwn(record, "privacy") ? ["privacy"] : [])
    ]) ||
    record.schemaVersion !== 1 ||
    record.id !== id ||
    typeof record.productVersion !== "string" ||
    !isPlainRecord(record.base) ||
    !exactKeys(record.base, ["manifestDigest", "root"]) ||
    !isPlainRecord(record.components) ||
    !exactKeys(record.components, [
      "base",
      ...(Object.hasOwn(record.components, "privacy") ? ["privacy"] : [])
    ]) ||
    (Object.hasOwn(record, "privacy") && !isPlainRecord(record.privacy))
  )
    throw new Error("stored generation record is invalid");
  validateOwner(record.owner);
  const runtime = discoverActualRuntimeIdentity();
  const baseRelative = record.base.root;
  if (typeof baseRelative !== "string")
    throw new Error("stored generation root is invalid");
  const baseRoot = resolve(paths.koedHome, baseRelative);
  assertInside(paths.koedHome, baseRoot);
  const base = await verifyStoredComponent(paths.koedHome, dirname(baseRoot), {
    component: "base",
    runtime
  });
  if (
    base.root !== baseRoot ||
    base.manifestDigest !== record.base.manifestDigest ||
    !isPlainRecord(record.components.base) ||
    !exactKeys(record.components.base, ["manifest", "manifestDigest"]) ||
    record.components.base.manifestDigest !== base.manifestDigest ||
    canonicalJson(record.components.base.manifest) !==
      canonicalJson(base.manifest)
  )
    throw new Error(
      "generation base reference differs from verified component"
    );
  let privacy: VerifiedComponent | undefined;
  if (Object.hasOwn(record, "privacy")) {
    const reference = record.privacy;
    if (
      !isPlainRecord(reference) ||
      !exactKeys(reference, ["manifestDigest", "root"]) ||
      typeof reference.root !== "string"
    )
      throw new Error("stored generation privacy reference is invalid");
    const privacyRoot = resolve(paths.koedHome, reference.root);
    assertInside(paths.koedHome, privacyRoot);
    privacy = await verifyStoredComponent(
      paths.koedHome,
      dirname(privacyRoot),
      {
        component: "privacy",
        runtime
      }
    );
    if (
      privacy.root !== privacyRoot ||
      privacy.manifestDigest !== reference.manifestDigest ||
      !isPlainRecord(record.components.privacy) ||
      !exactKeys(record.components.privacy, ["manifest", "manifestDigest"]) ||
      record.components.privacy.manifestDigest !== privacy.manifestDigest ||
      canonicalJson(record.components.privacy.manifest) !==
        canonicalJson(privacy.manifest) ||
      privacy.manifest.productVersion !== base.manifest.productVersion ||
      canonicalJson(privacy.manifest.target) !==
        canonicalJson(base.manifest.target)
    )
      throw new Error(
        "generation privacy reference differs from verified component"
      );
  }
  if (record.productVersion !== base.manifest.productVersion)
    throw new Error(
      "generation product version differs from verified component"
    );
  const identity = {
    schemaVersion: 1,
    productVersion: base.manifest.productVersion,
    owner: record.owner,
    base: {
      manifestDigest: base.manifestDigest,
      root: relative(paths.koedHome, base.root)
    },
    ...(privacy
      ? {
          privacy: {
            manifestDigest: privacy.manifestDigest,
            root: relative(paths.koedHome, privacy.root)
          }
        }
      : {})
  };
  if (hash(canonicalJson(identity)) !== id)
    throw new Error("generation digest mismatch");
  return {
    id,
    productVersion: base.manifest.productVersion,
    base,
    ...(privacy ? { privacy } : {}),
    owner: record.owner
  };
}
