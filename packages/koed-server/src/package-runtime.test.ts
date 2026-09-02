import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  activateServerPackage,
  cleanupServerPackages,
  collectServerPackageStatus,
  installServerPackage,
  packageExtractionLimits,
  requiredPackageRuntimeFiles,
  sha256File,
  validateServerPackageRoot,
  type KoedServerPackageManifest
} from "./package-runtime.js";

const temps: string[] = [];

const tempDir = (): string => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-package-runtime-"));
  temps.push(path);
  return path;
};

const writeFile = (path: string, content = "test\n"): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const listFiles = (root: string, dir = root): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (entry.isDirectory()) return listFiles(root, path);
    return [relativePath];
  });

const sha256Files = (root: string, files: string[]): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const writeManifest = (
  root: string,
  version: string,
  migrationTimestamp = 20260101000000
): void => {
  const files = listFiles(root).filter(
    (file) => file !== "koed-server-package-manifest.json"
  );
  writeFile(
    resolve(root, "koed-server-package-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        id: "koed-server",
        version,
        platform: process.platform === "darwin" ? "macos" : process.platform,
        architecture: process.arch,
        packageKind: "app-runtime",
        createdAt: "2026-01-01T00:00:00.000Z",
        nodeRuntime: { mode: "desktop-electron-node", minimumNodeMajor: 18 },
        koedRuntime: {
          path: "koed-runtime",
          requiredFiles: requiredPackageRuntimeFiles
        },
        database: {
          migrationSet: {
            latestMigrationTimestamp: migrationTimestamp,
            journalSha256: "b".repeat(64)
          },
          allowsRollback: false
        },
        provenance: {
          sourceRepository: "koed/koed",
          sourceCommit: "c".repeat(40),
          sourceRef: "refs/heads/test",
          buildWorkflow: "test",
          buildRunId: "1"
        },
        sha256: sha256Files(root, files),
        files: files.map((path) => ({
          path,
          sha256: sha256File(resolve(root, path))
        }))
      },
      null,
      2
    )}\n`
  );
};

const createPackageRoot = (
  parent: string,
  version: string,
  migrationTimestamp?: number
): string => {
  const root = resolve(parent, `pkg-${version}`);
  for (const file of requiredPackageRuntimeFiles) {
    writeFile(resolve(root, "koed-runtime", file), `${file}\n`);
  }
  writeFile(resolve(root, "README.txt"), "Standalone koed-server package\n");
  writeFile(resolve(root, "bin", "koed-server"), "#!/usr/bin/env sh\n");
  chmodSync(resolve(root, "bin", "koed-server"), 0o755);
  writeFile(resolve(root, "koed-runtime", "koed-server", "dist", "cli.js"));
  writeManifest(root, version, migrationTimestamp);
  return root;
};

const tarString = (
  buffer: Buffer,
  offset: number,
  length: number,
  value: string
): void => {
  buffer.write(value, offset, length, "utf8");
};

const tarOctal = (
  buffer: Buffer,
  offset: number,
  length: number,
  value: number
): void => {
  tarString(
    buffer,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, "0")}\0`
  );
};

const tarHeader = (
  path: string,
  size: number,
  type: string,
  mode = 0o644,
  linkname = ""
): Buffer => {
  const header = Buffer.alloc(512, 0);
  tarString(header, 0, 100, path);
  tarOctal(header, 100, 8, mode);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  tarString(header, 156, 1, type);
  tarString(header, 157, 100, linkname);
  tarString(header, 257, 6, "ustar");
  tarString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarOctal(header, 148, 8, checksum);
  return header;
};

const padded = (buffer: Buffer): Buffer => {
  const remainder = buffer.length % 512;
  return remainder === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(512 - remainder, 0)]);
};

const writeArchive = (packageRoot: string, outDir: string): string => {
  const packageName = packageRoot.split("/").at(-1)!;
  const blocks = [tarHeader(`${packageName}/`, 0, "5", 0o755)];
  for (const file of listFiles(packageRoot).sort()) {
    const content = readFileSync(resolve(packageRoot, file));
    blocks.push(
      tarHeader(
        `${packageName}/${file}`,
        content.length,
        "0",
        file === "bin/koed-server" ? 0o755 : 0o644
      ),
      padded(content)
    );
  }
  blocks.push(Buffer.alloc(1024, 0));
  const archive = resolve(outDir, `${packageName}.tar.gz`);
  writeFileSync(archive, gzipSync(Buffer.concat(blocks)));
  return archive;
};

const writeProvenance = ({
  archive,
  packageRoot,
  outDir,
  privateKey
}: {
  archive: string;
  packageRoot: string;
  outDir: string;
  privateKey: KeyObject;
}): string => {
  const manifestPath = resolve(
    packageRoot,
    "koed-server-package-manifest.json"
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    id: string;
    version: string;
    platform: string;
    architecture: string;
    packageKind: string;
    sha256: string;
  };
  const statement = {
    schemaVersion: 1,
    subject: {
      packageKind: manifest.packageKind,
      id: manifest.id,
      version: manifest.version,
      platform: manifest.platform,
      architecture: manifest.architecture,
      archiveName: archive.split("/").at(-1),
      archiveSha256: sha256File(archive),
      manifestName: "koed-server-package-manifest.json",
      manifestSha256: sha256File(manifestPath),
      packageSha256: manifest.sha256
    },
    source: {
      repository: "koed/koed",
      commit: "c".repeat(40),
      ref: "refs/heads/test"
    },
    build: {
      workflow: "test",
      runId: "1",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    integrity: {
      archiveAlgorithm: "sha256",
      manifestAlgorithm: "sha256",
      signatureAlgorithm: "ed25519"
    }
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(statement), "utf8"),
    privateKey
  ).toString("base64");
  const provenancePath = resolve(outDir, "package.provenance.json");
  writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        statement,
        signature: {
          status: "signed",
          algorithm: "ed25519",
          value: signature
        }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(`${provenancePath}.sig`, `${signature}\n`);
  return provenancePath;
};

const writeSymlinkArchive = (outDir: string, outsideDir: string): string => {
  const packageName = "pkg-0.2.0";
  const content = Buffer.from("outside\n");
  const blocks = [
    tarHeader(`${packageName}/`, 0, "5", 0o755),
    tarHeader(`${packageName}/koed-runtime`, 0, "2", 0o777, outsideDir),
    tarHeader(
      `${packageName}/koed-runtime/api/dist/index.js`,
      content.length,
      "0"
    ),
    padded(content),
    Buffer.alloc(1024, 0)
  ];
  const archive = resolve(outDir, `${packageName}.tar.gz`);
  writeFileSync(archive, gzipSync(Buffer.concat(blocks)));
  return archive;
};

const writeRawArchive = (
  outDir: string,
  blocks: Buffer[],
  name: string
): string => {
  const archive = resolve(outDir, name);
  writeFileSync(archive, gzipSync(Buffer.concat(blocks)));
  return archive;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("standalone koed-server package runtime", () => {
  it("reports missing status before a package is installed", () => {
    const home = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });

    const status = collectServerPackageStatus(paths);

    expect(status).toMatchObject({ ok: false, state: "missing" });
  });

  it("validates a package root and rejects incompatible platforms", () => {
    const root = createPackageRoot(tempDir(), "0.2.0");

    expect(validateServerPackageRoot(root)).toMatchObject({
      ok: true,
      version: "0.2.0"
    });

    const manifestPath = resolve(root, "koed-server-package-manifest.json");
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as KoedServerPackageManifest;
    manifest.platform = "not-this-platform";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const invalid = validateServerPackageRoot(root);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join("\n")).toMatch(/incompatible/);
  });

  it("rejects retired schema 1 manifests with upgrade guidance", () => {
    const root = createPackageRoot(tempDir(), "0.2.0");
    const manifestPath = resolve(root, "koed-server-package-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.schemaVersion = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const result = validateServerPackageRoot(root);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/upgrade koed-server/);
  });

  it("rejects retired Explorer artifacts", () => {
    const root = createPackageRoot(tempDir(), "0.2.0");
    writeFile(resolve(root, "koed-runtime/explorer-dist/index.html"));
    writeFile(resolve(root, "koed-server/dist/explorer-static-server.js"));
    writeManifest(root, "0.2.0");

    const result = validateServerPackageRoot(root);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/explorer-dist/);
    expect(result.errors.join("\n")).toMatch(/explorer-static-server/);
  });

  it("installs and activates a verified package archive", async () => {
    const home = tempDir();
    const sourceParent = tempDir();
    const outDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const packageRoot = createPackageRoot(sourceParent, "0.2.0");
    const archive = writeArchive(packageRoot, outDir);

    const result = await installServerPackage(paths, {
      source: archive,
      sha256: sha256File(archive),
      activate: true
    });

    expect(result).toMatchObject({
      ok: true,
      state: "activated",
      currentVersion: "0.2.0"
    });
    const status = collectServerPackageStatus(paths);
    expect(status).toMatchObject({
      ok: true,
      state: "installed",
      currentVersion: "0.2.0"
    });
    expect(status.installed[0]?.manifest?.version).toBe("0.2.0");
    expect(status.installed[0]?.manifest?.fileCount).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain('"files"');
  });

  it("verifies signed provenance when a trusted public key is configured", async () => {
    const home = tempDir();
    const sourceParent = tempDir();
    const outDir = tempDir();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const packageRoot = createPackageRoot(sourceParent, "0.2.0");
    const archive = writeArchive(packageRoot, outDir);
    const provenanceFile = writeProvenance({
      archive,
      packageRoot,
      outDir,
      privateKey
    });

    const result = await installServerPackage(paths, {
      source: archive,
      sha256: sha256File(archive),
      provenanceFile,
      trustedPublicKey: publicKey.export({
        type: "spki",
        format: "pem"
      }) as string,
      trustPolicy: "require-signature"
    });

    expect(result.provenance).toMatchObject({
      status: "verified",
      policy: "require-signature"
    });
  });

  it("keeps adjacent provenance usable after caching a local archive", async () => {
    const home = tempDir();
    const sourceParent = tempDir();
    const outDir = tempDir();
    const { privateKey } = generateKeyPairSync("ed25519");
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const packageRoot = createPackageRoot(sourceParent, "0.2.0");
    const archive = writeArchive(packageRoot, outDir);
    const provenanceFile = writeProvenance({
      archive,
      packageRoot,
      outDir,
      privateKey
    });
    const adjacentProvenanceFile = archive.replace(
      /\.tar\.gz$/,
      ".provenance.json"
    );
    writeFileSync(adjacentProvenanceFile, readFileSync(provenanceFile));
    writeFileSync(
      `${adjacentProvenanceFile}.sig`,
      readFileSync(`${provenanceFile}.sig`)
    );

    const result = await installServerPackage(paths, {
      source: archive,
      sha256: sha256File(archive),
      trustPolicy: "require-provenance"
    });

    expect(result.provenance).toMatchObject({
      policy: "require-provenance",
      source: resolve(
        home,
        "cache",
        "koed-server-packages",
        "pkg-0.2.0.provenance.json"
      )
    });
  });

  it("rejects missing provenance when policy requires it", async () => {
    const home = tempDir();
    const sourceParent = tempDir();
    const outDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const packageRoot = createPackageRoot(sourceParent, "0.2.0");
    const archive = writeArchive(packageRoot, outDir);

    await expect(
      installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive),
        trustPolicy: "require-provenance"
      })
    ).rejects.toThrow("Package provenance metadata is required");
  });

  it("rejects archive checksum mismatches before extraction", async () => {
    const home = tempDir();
    const sourceParent = tempDir();
    const outDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const packageRoot = createPackageRoot(sourceParent, "0.2.0");
    const archive = writeArchive(packageRoot, outDir);

    await expect(
      installServerPackage(paths, {
        source: archive,
        sha256: "a".repeat(64)
      })
    ).rejects.toThrow("Package archive SHA-256 mismatch");
  });

  it("rejects manifest versions that would escape the versions directory", async () => {
    const home = tempDir();
    const sourceParent = tempDir();
    const outDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const packageRoot = createPackageRoot(sourceParent, "0.2.0");
    const manifestPath = resolve(
      packageRoot,
      "koed-server-package-manifest.json"
    );
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as KoedServerPackageManifest;
    manifest.version = "../../victim";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const victimFile = resolve(home, "runtime", "victim", "keep.txt");
    writeFile(victimFile, "do not remove\n");
    const archive = writeArchive(packageRoot, outDir);

    await expect(
      installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive)
      })
    ).rejects.toThrow("Package version");
    expect(existsSync(victimFile)).toBe(true);
  });

  it("rejects package archives containing symlinks before following them", async () => {
    const home = tempDir();
    const outDir = tempDir();
    const outsideDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const archive = writeSymlinkArchive(outDir, outsideDir);

    await expect(
      installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive)
      })
    ).rejects.toThrow("must not contain symbolic links");
    expect(existsSync(resolve(outsideDir, "api", "dist", "index.js"))).toBe(
      false
    );
  });

  it.each([
    ["hard links", "1"],
    ["devices", "3"],
    ["FIFOs", "6"]
  ])("rejects package archives containing %s", async (_label, type) => {
    const home = tempDir();
    const outDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const archive = writeRawArchive(
      outDir,
      [tarHeader("pkg-0.2.0/unsafe", 0, type), Buffer.alloc(1024)],
      `${type}.tar.gz`
    );
    await expect(
      installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive)
      })
    ).rejects.toThrow(/hard links|unsupported tar entry type/);
    expect(
      readdirSync(resolve(home, "runtime", "koed-server"))
    ).not.toContainEqual(expect.stringMatching(/^\.install-/));
  });

  it("rejects duplicate normalized paths and removes the partial extraction", async () => {
    const home = tempDir();
    const outDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const content = Buffer.from("duplicate");
    const archive = writeRawArchive(
      outDir,
      [
        tarHeader("pkg-0.2.0/file", content.length, "0"),
        padded(content),
        tarHeader("pkg-0.2.0/./file", content.length, "0"),
        padded(content),
        Buffer.alloc(1024)
      ],
      "duplicate.tar.gz"
    );
    await expect(
      installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive)
      })
    ).rejects.toThrow("Duplicate package archive path");
    expect(
      readdirSync(resolve(home, "runtime", "koed-server"))
    ).not.toContainEqual(expect.stringMatching(/^\.install-/));
  });

  it("rejects traversal, malformed, oversized, and truncated archives", async () => {
    const cases: Array<[string, Buffer[], RegExp]> = [
      [
        "traversal.tar.gz",
        [tarHeader("../outside", 0, "0"), Buffer.alloc(1024)],
        /escapes/
      ],
      [
        "oversized.tar.gz",
        [
          tarHeader("pkg-0.2.0/huge", 2 * 1024 * 1024 * 1024 + 1, "0"),
          Buffer.alloc(1024)
        ],
        /individual file limit/
      ],
      [
        "truncated.tar.gz",
        [tarHeader("pkg-0.2.0/file", 20, "0"), Buffer.from("short")],
        /truncated/
      ]
    ];
    const malformed = tarHeader("pkg-0.2.0/file", 0, "0");
    malformed.writeUInt8(malformed.readUInt8(0) ^ 1, 0);
    cases.push([
      "malformed.tar.gz",
      [malformed, Buffer.alloc(1024)],
      /checksum/
    ]);
    for (const [name, blocks, error] of cases) {
      const home = tempDir();
      const outDir = tempDir();
      const paths = resolveKoedServerPaths({
        KOED_HOME: home,
        KOED_REPO_ROOT: home
      });
      const archive = writeRawArchive(outDir, blocks, name);
      await expect(
        installServerPackage(paths, {
          source: archive,
          sha256: sha256File(archive)
        })
      ).rejects.toThrow(error);
    }
  });

  it("stops highly compressed archives at the expanded-byte limit", async () => {
    const home = tempDir();
    const outDir = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const content = Buffer.alloc(2048, 0);
    const archive = writeRawArchive(
      outDir,
      [
        tarHeader("pkg-0.2.0/repeated", content.length, "0"),
        padded(content),
        Buffer.alloc(1024)
      ],
      "decompression-bomb.tar.gz"
    );
    const mutableExtractionLimits = packageExtractionLimits as {
      expandedBytes: number;
    };
    const previousLimit = mutableExtractionLimits.expandedBytes;
    mutableExtractionLimits.expandedBytes = 1024;
    try {
      await expect(
        installServerPackage(paths, {
          source: archive,
          sha256: sha256File(archive)
        })
      ).rejects.toThrow("expanded byte limit");
    } finally {
      mutableExtractionLimits.expandedBytes = previousLimit;
    }
    expect(
      readdirSync(resolve(home, "runtime", "koed-server"))
    ).not.toContainEqual(expect.stringMatching(/^\.install-/));
  });

  it("activates installed versions and cleans inactive versions and cache", async () => {
    const home = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
      const packageRoot = createPackageRoot(tempDir(), version);
      const archive = writeArchive(packageRoot, tempDir());
      await installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive)
      });
    }

    const activated = activateServerPackage(paths, "0.3.0");
    const cleaned = cleanupServerPackages(paths, 1);

    expect(activated).toMatchObject({ ok: true, activatedVersion: "0.3.0" });
    expect(cleaned.removedVersions).toEqual(["0.1.0"]);
    expect(
      collectServerPackageStatus(paths).installed.map((entry) => entry.version)
    ).toEqual(["0.2.0", "0.3.0"]);
  });

  it("blocks downgrades unless explicitly allowed", async () => {
    const home = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    for (const version of ["0.2.0", "0.3.0"]) {
      const packageRoot = createPackageRoot(tempDir(), version);
      const archive = writeArchive(packageRoot, tempDir());
      await installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive),
        activate: version === "0.3.0"
      });
    }

    expect(() => activateServerPackage(paths, "0.2.0")).toThrow(
      /requires --allow-downgrade/
    );
  });

  it("blocks rollback to an older migration set even with downgrade confirmation", async () => {
    const home = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });
    const oldPackage = createPackageRoot(tempDir(), "0.2.0", 20260101000000);
    const newPackage = createPackageRoot(tempDir(), "0.3.0", 20260201000000);
    for (const [packageRoot, activate] of [
      [oldPackage, false],
      [newPackage, true]
    ] as const) {
      const archive = writeArchive(packageRoot, tempDir());
      await installServerPackage(paths, {
        source: archive,
        sha256: sha256File(archive),
        activate
      });
    }

    expect(() =>
      activateServerPackage(paths, "0.2.0", { allowDowngrade: true })
    ).toThrow(/migration set/);
  });
});
