import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type {
  ArtifactTarget,
  ComponentId,
  ComponentManifest
} from "./component-contract.js";
import type { ManifestPinCatalog } from "./component-manifest-catalog.js";
import type { ComponentVerificationInput } from "./component-verification.js";
import {
  componentManifestSigningBytes,
  canonicalComponentManifestBytes
} from "./component-verification.js";

// Fixed pre-serializer-change archive; zlib output varies across Node versions.
export const goldenComponentArchive = Buffer.from(
  "H4sIAAAAAAAAE0vNKymq1MsqZqAhMAACMxMTMA0E6LSBgaERgg0RNzcxNmUwoKWjYKC0uCSxCGglPewahCC1oiC/qEShupZroF0yCkbBKBgFo4CeAADk1SYtAAgAAA==",
  "base64"
);

const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
let fixtureManifestPinCatalog: ManifestPinCatalog | null = null;
export const getFixtureManifestPinCatalog = () => fixtureManifestPinCatalog;
export const resetFixtureManifestPinCatalog = () => {
  fixtureManifestPinCatalog = null;
};
const registerFixtureManifestPinCatalog = (catalog: ManifestPinCatalog) => {
  if (
    !fixtureManifestPinCatalog ||
    fixtureManifestPinCatalog.productVersion !== catalog.productVersion
  ) {
    fixtureManifestPinCatalog = catalog;
    return;
  }
  const entries = [...fixtureManifestPinCatalog.entries];
  for (const entry of catalog.entries) {
    const index = entries.findIndex(
      (candidate) =>
        candidate.component === entry.component &&
        JSON.stringify(candidate.target) === JSON.stringify(entry.target)
    );
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
  }
  fixtureManifestPinCatalog = { ...catalog, entries };
};
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

export interface ComponentFixture {
  input: ComponentVerificationInput;
  historicalSignature: { keyId: string; signature: string; publicKey: string };
  root: string;
  dispose(): void;
}

function createComponentFixture(
  overrides: Partial<ComponentManifest> = {},
  archiveEntries: readonly { path: string; type?: string }[] = [
    { path: "entry.js" }
  ],
  archiveOptions: {
    terminatorBlocks?: number;
    tail?: Buffer;
    bytes?: Buffer;
  } = {},
  includeArchiveInventory = false,
  entryContents: Readonly<Record<string, Buffer | string>> = {}
): ComponentFixture {
  const directory = mkdtempSync(resolve(tmpdir(), "koed-component-fixture-"));
  const root = resolve(directory, "root");
  const payload = Buffer.from("export {}\n");
  const fileContent = (path: string) => {
    const content = entryContents[path] ?? payload;
    return Buffer.isBuffer(content) ? content : Buffer.from(content);
  };
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
          .map(({ path }) => ({ path, sha256: hash(fileContent(path)) }))
      : [{ path: "entry.js", sha256: hash(payload) }],
    ...overrides
  };
  const archive =
    archiveOptions.bytes ??
    gzipSync(
      Buffer.concat([
        ...archiveEntries.map(({ path, type }) =>
          tarFile(path, fileContent(path), type)
        ),
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
  const manifestBytes = canonicalComponentManifestBytes(manifest);
  const pair = generateKeyPairSync("ed25519");
  const keyId = hash(
    pair.publicKey.export({ type: "spki", format: "der" })
  ).slice(0, 32);
  const signature = sign(
    null,
    componentManifestSigningBytes(manifestBytes),
    pair.privateKey
  ).toString("base64");
  const expectedComponent: ComponentId = overrides.component ?? "base";
  const expectedVersion = overrides.productVersion ?? "0.8.1";
  const target: ArtifactTarget = overrides.target ?? {
    platform: "linux",
    architecture: "x64"
  };
  const manifestCatalog: ManifestPinCatalog = {
    schemaVersion: 1,
    productVersion: expectedVersion,
    entries: [
      {
        component: expectedComponent,
        target,
        manifestSha256: hash(manifestBytes)
      }
    ]
  };
  registerFixtureManifestPinCatalog(manifestCatalog);
  const input: ComponentVerificationInput = {
    manifestBytes,
    manifestCatalog,
    archivePath,
    expectedComponent,
    expectedVersion,
    target,
    runtime: {
      kind: "node",
      version: "24.13.1",
      nodeVersion: "24.13.1",
      modulesAbi: "137",
      napiVersion: 10,
      platform: target.platform,
      architecture: target.architecture,
      ...(target.libc ? { libcVersion: `${target.libc.minimumVersion}.0` } : {})
    }
  };
  return {
    input,
    historicalSignature: {
      keyId,
      signature,
      publicKey: pair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString()
    },
    root,
    dispose: () => rmSync(directory, { recursive: true, force: true })
  };
}

export const componentFixture = (
  overrides: Partial<ComponentManifest> = {},
  archiveEntries: readonly { path: string; type?: string }[] = [
    { path: "entry.js" }
  ],
  archiveOptions: {
    terminatorBlocks?: number;
    tail?: Buffer;
    bytes?: Buffer;
  } = {},
  includeArchiveInventory = false,
  entryContents: Readonly<Record<string, Buffer | string>> = {}
): Promise<ComponentFixture> =>
  Promise.resolve().then(() =>
    createComponentFixture(
      overrides,
      archiveEntries,
      archiveOptions,
      includeArchiveInventory,
      entryContents
    )
  );
