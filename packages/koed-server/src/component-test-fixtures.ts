import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { ComponentManifest } from "./component-contract.js";
import type { ComponentVerificationInput } from "./component-verification.js";
import { canonicalComponentManifestBytes } from "./component-verification.js";

const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const writeString = (
  buffer: Buffer,
  offset: number,
  size: number,
  value: string
) => buffer.write(value, offset, size, "utf8");
const writeOctal = (
  buffer: Buffer,
  offset: number,
  size: number,
  value: number
) =>
  writeString(
    buffer,
    offset,
    size,
    `${value.toString(8).padStart(size - 1, "0")}\0`
  );

const tarFile = (path: string, content: Buffer, type = "0") => {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeOctal(
    header,
    148,
    8,
    header.reduce((total, byte) => total + byte, 0)
  );
  return Buffer.concat([
    header,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512)
  ]);
};

function createSignedComponentFixture(
  overrides: Partial<ComponentManifest> = {},
  archiveEntries: readonly { path: string; type?: string }[] = [
    { path: "entry.js" }
  ],
  archiveOptions: {
    terminatorBlocks?: number;
    tail?: Buffer;
  } = {},
  includeArchiveInventory = false
): {
  input: ComponentVerificationInput;
  root: string;
  dispose(): void;
} {
  const directory = mkdtempSync(resolve(tmpdir(), "koed-component-fixture-"));
  const root = resolve(directory, "root");
  const payload = Buffer.from("export {}\n");
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "entry.js"), payload);
  const manifest: ComponentManifest = {
    schemaVersion: 1,
    productVersion: "0.8.1",
    component: "base",
    target: { platform: "linux", architecture: "x64" },
    runtimes: [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: "137",
        minimumNapi: 10
      }
    ],
    archive: { name: "base.tar.gz", bytes: 0, sha256: "0".repeat(64) },
    requiredFiles: ["entry.js"],
    files: includeArchiveInventory
      ? archiveEntries
          .filter(({ type }) => type === undefined || type === "0")
          .map(({ path }) => ({ path, sha256: hash(payload) }))
      : [{ path: "entry.js", sha256: hash(payload) }],
    ...overrides
  };
  const archive = gzipSync(
    Buffer.concat([
      ...archiveEntries.map(({ path, type }) => tarFile(path, payload, type)),
      Buffer.alloc(512 * (archiveOptions.terminatorBlocks ?? 2)),
      archiveOptions.tail ?? Buffer.alloc(0)
    ])
  );
  manifest.archive = {
    name: "base.tar.gz",
    bytes: archive.length,
    sha256: hash(archive)
  };
  const archivePath = resolve(directory, manifest.archive.name);
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, archive);
  const pair = generateKeyPairSync("ed25519");
  const keyId = hash(
    pair.publicKey.export({ type: "spki", format: "der" })
  ).slice(0, 32);
  const manifestBytes = canonicalComponentManifestBytes(manifest);
  const signature = sign(
    null,
    Buffer.concat([Buffer.from("koed-component-manifest-v1\n"), manifestBytes]),
    pair.privateKey
  ).toString("base64");
  const input: ComponentVerificationInput = {
    manifestBytes,
    signature: { schemaVersion: 1, keyId, algorithm: "ed25519", signature },
    archivePath,
    expectedComponent: manifest.component,
    expectedVersion: manifest.productVersion,
    target: manifest.target,
    runtime: {
      kind: "node",
      version: "24.13.1",
      nodeVersion: "24.13.1",
      modulesAbi: "137",
      napiVersion: 10,
      platform: manifest.target.platform,
      architecture: manifest.target.architecture,
      ...(manifest.target.libc
        ? { libcVersion: `${manifest.target.libc.minimumVersion}.0` }
        : {})
    },
    trustedKeys: new Map([
      [keyId, pair.publicKey.export({ type: "spki", format: "pem" }).toString()]
    ])
  };
  return {
    input,
    root,
    dispose: () => rmSync(directory, { recursive: true, force: true })
  };
}

export const signedComponentFixture = (
  overrides: Partial<ComponentManifest> = {},
  archiveEntries: readonly { path: string; type?: string }[] = [
    { path: "entry.js" }
  ],
  archiveOptions: { terminatorBlocks?: number; tail?: Buffer } = {},
  includeArchiveInventory = false
): Promise<{
  input: ComponentVerificationInput;
  root: string;
  dispose(): void;
}> =>
  Promise.resolve().then(() =>
    createSignedComponentFixture(
      overrides,
      archiveEntries,
      archiveOptions,
      includeArchiveInventory
    )
  );
