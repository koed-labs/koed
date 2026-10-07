import {
  linkSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  symlinkSync,
  truncateSync,
  unlinkSync
} from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signedComponentFixture } from "./component-test-fixtures.js";
import {
  verifyComponent,
  verifyExtractedComponent,
  verifyExtractedComponentWithTestSeams
} from "./component-verification.js";
import { productionComponentTrustRoots } from "./component-trust-roots.js";
import type { ComponentManifest } from "./component-contract.js";
import {
  buildComponentManifest,
  signComponentManifest
} from "../../../scripts/koed-server-package-lib.mjs";

const fixtures: Awaited<ReturnType<typeof signedComponentFixture>>[] = [];
const fixture = async () => {
  const created = await signedComponentFixture();
  fixtures.push(created);
  return created;
};
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const fixtureManifest = (bytes: Buffer): ComponentManifest => {
  const parsed: unknown = JSON.parse(bytes.toString());
  return parsed as ComponentManifest;
};

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

describe("signed component verification", () => {
  it("accepts real Ed25519 fixture signature and rejects signed component mismatch", async () => {
    const sample = await fixture();
    await expect(verifyComponent(sample.input)).resolves.toBeDefined();
    await expect(
      verifyComponent({ ...sample.input, expectedComponent: "privacy" })
    ).rejects.toThrow("component mismatch");
  });

  it("fails closed with empty production trust roots", async () => {
    const sample = await fixture();
    expect(productionComponentTrustRoots.size).toBe(0);
    await expect(
      verifyComponent({
        ...sample.input,
        trustedKeys: productionComponentTrustRoots
      })
    ).rejects.toThrow("untrusted component signing key");
  });

  it.each([
    ["version", { expectedVersion: "0.8.2" }, "product version mismatch"],
    [
      "target",
      { target: { platform: "macos", architecture: "arm64" } },
      "component target mismatch"
    ],
    [
      "Node version",
      {
        runtime: {
          kind: "node",
          version: "26.0.0",
          nodeVersion: "26.0.0",
          modulesAbi: "137",
          napiVersion: 10,
          platform: "linux",
          architecture: "x64"
        }
      },
      "runtime version is incompatible"
    ],
    [
      "Electron runtime",
      {
        runtime: {
          kind: "electron",
          version: "40.0.0",
          nodeVersion: "24.0.0",
          modulesAbi: "137",
          napiVersion: 10,
          platform: "linux",
          architecture: "x64"
        }
      },
      "runtime version is incompatible"
    ],
    [
      "runtime ABI",
      {
        runtime: {
          kind: "node",
          version: "24.13.1",
          nodeVersion: "24.13.1",
          modulesAbi: "999",
          napiVersion: 10,
          platform: "linux",
          architecture: "x64"
        }
      },
      "runtime ABI mismatch"
    ],
    [
      "N-API",
      {
        runtime: {
          kind: "node",
          version: "24.13.1",
          nodeVersion: "24.13.1",
          modulesAbi: "137",
          napiVersion: 1,
          platform: "linux",
          architecture: "x64"
        }
      },
      "runtime N-API version is incompatible"
    ]
  ] as const)("rejects incompatible %s", async (_name, override, reason) => {
    const sample = await fixture();
    await expect(
      verifyComponent({ ...sample.input, ...override })
    ).rejects.toThrow(reason);
  });

  it("accepts compatible Electron tuple and rejects mismatched Node ABI", async () => {
    const sample = await signedComponentFixture({
      runtimes: [
        {
          kind: "electron",
          runtimeRange: ">=40 <41",
          nodeRange: ">=24 <25",
          modulesAbi: "137",
          minimumNapi: 10
        }
      ]
    });
    fixtures.push(sample);
    await expect(
      verifyComponent({
        ...sample.input,
        runtime: {
          ...sample.input.runtime,
          kind: "electron",
          version: "40.1.0"
        }
      })
    ).resolves.toBeDefined();
    await expect(
      verifyComponent({
        ...sample.input,
        runtime: {
          ...sample.input.runtime,
          kind: "electron",
          version: "40.1.0",
          modulesAbi: "999"
        }
      })
    ).rejects.toThrow("runtime ABI mismatch");
  });

  it("matches complete ABI tuples across overlapping compatibility entries", async () => {
    const sample = await signedComponentFixture({
      runtimes: [
        {
          kind: "node",
          runtimeRange: ">=24 <25",
          nodeRange: ">=24 <25",
          modulesAbi: "999",
          minimumNapi: 20
        },
        {
          kind: "node",
          runtimeRange: ">=24 <25",
          nodeRange: ">=24 <25",
          modulesAbi: "137",
          minimumNapi: 10
        }
      ]
    });
    fixtures.push(sample);
    await expect(verifyComponent(sample.input)).resolves.toBeDefined();
  });

  it("rejects duplicate-key manifest JSON before signature acceptance", async () => {
    const sample = await fixture();
    const source = sample.input.manifestBytes.toString("utf8");
    const duplicated = source.replace(
      '{"archive":',
      '{"schemaVersion":1,"archive":'
    );
    await expect(
      verifyComponent({
        ...sample.input,
        manifestBytes: Buffer.from(duplicated)
      })
    ).rejects.toThrow("component manifest is not canonical");
  });

  it("rejects noncanonical metadata and signatures signed over different bytes", async () => {
    const sample = await fixture();
    await expect(
      verifyComponent({
        ...sample.input,
        manifestBytes: Buffer.from(
          JSON.stringify(
            JSON.parse(sample.input.manifestBytes.toString()),
            null,
            2
          )
        )
      })
    ).rejects.toThrow("not canonical");
    await expect(
      verifyComponent({
        ...sample.input,
        signature: {
          ...sample.input.signature,
          signature: Buffer.alloc(64).toString("base64")
        }
      })
    ).rejects.toThrow("signature is invalid");
  });

  it("rejects signed archive file hash corruption", async () => {
    const sample = await signedComponentFixture({
      files: [{ path: "entry.js", sha256: "0".repeat(64) }]
    });
    fixtures.push(sample);
    await expect(verifyComponent(sample.input)).rejects.toThrow(
      "component archive file hash mismatch: entry.js"
    );
  });

  it("rejects archive size and hash mismatches", async () => {
    const sample = await fixture();
    writeFileSync(sample.input.archivePath, "tampered");
    await expect(verifyComponent(sample.input)).rejects.toThrow(
      /archive (size|SHA-256) mismatch/
    );
  });

  it("verifies extracted required-file hashes and rejects links or corruption", async () => {
    const sample = await fixture();
    const manifest = fixtureManifest(sample.input.manifestBytes);
    mkdirSync(resolve(sample.root, "nested"));
    writeFileSync(resolve(sample.root, "nested/file.js"), "nested");
    manifest.files = [
      ...manifest.files,
      { path: "nested/file.js", sha256: digest(Buffer.from("nested")) }
    ];
    manifest.requiredFiles = [...manifest.requiredFiles, "nested/file.js"];
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).resolves.toBeUndefined();
    writeFileSync(resolve(sample.root, "entry.js"), "corrupt");
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).rejects.toThrow("component file hash mismatch");
    unlinkSync(resolve(sample.root, "entry.js"));
    symlinkSync("/etc/passwd", resolve(sample.root, "entry.js"));
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).rejects.toThrow("component files must not contain links");
  });

  it("rejects extracted hard links, extra files, and missing files", async () => {
    const sample = await fixture();
    const manifest = fixtureManifest(sample.input.manifestBytes);
    const extra = resolve(sample.root, "extra.js");
    linkSync(resolve(sample.root, "entry.js"), extra);
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).rejects.toThrow(
      "component files must not contain links or special files"
    );
    unlinkSync(extra);
    writeFileSync(extra, "extra");
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).rejects.toThrow("component file hash mismatch: extra.js");
    unlinkSync(extra);
    unlinkSync(resolve(sample.root, "entry.js"));
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).rejects.toThrow(
      "required component file is missing or incomplete: entry.js"
    );
  });

  it("rejects extracted individual and aggregate byte limits", async () => {
    const sample = await fixture();
    const manifest = fixtureManifest(sample.input.manifestBytes);
    const oversized = resolve(sample.root, "oversized.js");
    writeFileSync(oversized, "");
    truncateSync(oversized, 1024 * 1024 * 1024 + 1);
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).rejects.toThrow("component file exceeds individual file limit");
    unlinkSync(oversized);
  });

  it("rejects aggregate extracted bytes across individually valid files", async () => {
    const sample = await fixture();
    const manifest = fixtureManifest(sample.input.manifestBytes);
    writeFileSync(resolve(sample.root, "second.js"), "12345");
    manifest.files = [
      ...manifest.files,
      { path: "second.js", sha256: digest(Buffer.from("12345")) }
    ];
    await expect(
      verifyExtractedComponentWithTestSeams(sample.root, manifest, {
        limits: { maxFileBytes: 10, maxExpandedBytes: 14 }
      })
    ).rejects.toThrow("component tree exceeds expanded size limit");
  });

  it("rejects extracted file and directory entry count limits", async () => {
    const sample = await fixture();
    const manifest = fixtureManifest(sample.input.manifestBytes);
    writeFileSync(resolve(sample.root, "second.js"), "x");
    manifest.files = [
      ...manifest.files,
      { path: "second.js", sha256: digest(Buffer.from("x")) }
    ];
    await expect(
      verifyExtractedComponentWithTestSeams(sample.root, manifest, {
        limits: { maxEntries: 1 }
      })
    ).rejects.toThrow("component tree exceeds entry count limit");
    await expect(
      verifyExtractedComponentWithTestSeams(sample.root, manifest, {
        limits: { maxFiles: 1 }
      })
    ).rejects.toThrow("component tree exceeds file count limit");

    mkdirSync(resolve(sample.root, "nested"));
    await expect(
      verifyExtractedComponentWithTestSeams(sample.root, manifest, {
        limits: { maxDirectories: 0 }
      })
    ).rejects.toThrow("component tree exceeds directory count limit");
  });

  it("rejects extracted trees exceeding directory depth limit", async () => {
    const sample = await fixture();
    const manifest = fixtureManifest(sample.input.manifestBytes);
    let nested = sample.root;
    for (let index = 0; index < 129; index++) {
      nested = resolve(nested, "d");
      mkdirSync(nested);
    }
    await expect(
      verifyExtractedComponent(sample.root, manifest)
    ).rejects.toThrow("component tree exceeds directory depth limit");
  });

  it.each([
    ["traversal", "../escape", "0", "component archive path is unsafe"],
    ["absolute path", "/escape", "0", "component archive path is unsafe"],
    ["hard link", "entry.js", "1", "hard links"],
    ["symbolic link", "entry.js", "2", "symbolic links"],
    ["special entry", "entry.js", "3", "unsupported component tar entry type"]
  ])("rejects archive %s", async (_name, path, type, reason) => {
    const sample = await signedComponentFixture({}, [{ path, type }]);
    fixtures.push(sample);
    await expect(verifyComponent(sample.input)).rejects.toThrow(reason);
  });

  it("rejects file path conflicts that cannot be extracted", async () => {
    const sample = await signedComponentFixture({}, [
      { path: "entry.js" },
      { path: "entry.js/child" }
    ]);
    fixtures.push(sample);
    await expect(verifyComponent(sample.input)).rejects.toThrow(
      "component archive file path conflict: entry.js"
    );
  });

  it("rejects a persistent file replacement before no-follow open", async () => {
    const sample = await fixture();
    const file = resolve(sample.root, "entry.js");
    const moved = resolve(sample.root, "moved.js");
    let replaced = false;
    await expect(
      verifyExtractedComponentWithTestSeams(
        sample.root,
        fixtureManifest(sample.input.manifestBytes),
        {
          beforeOpenFile(path) {
            if (path !== file || replaced) return;
            replaced = true;
            renameSync(path, moved);
            writeFileSync(path, "replacement");
          }
        }
      )
    ).rejects.toThrow("component file changed during verification");
    expect(replaced).toBe(true);
  });

  it("rejects a persistent directory replacement during traversal", async () => {
    const sample = await fixture();
    const nested = resolve(sample.root, "nested");
    mkdirSync(nested);
    writeFileSync(resolve(nested, "entry.js"), "nested");
    const moved = resolve(sample.root, "moved");
    let replaced = false;
    await expect(
      verifyExtractedComponentWithTestSeams(
        sample.root,
        fixtureManifest(sample.input.manifestBytes),
        {
          beforeReadDirectory(path) {
            if (path !== nested || replaced) return;
            replaced = true;
            renameSync(path, moved);
            mkdirSync(path);
          }
        }
      )
    ).rejects.toThrow(
      "component directory ancestry changed during verification"
    );
    expect(replaced).toBe(true);
  });

  it.each([
    [
      "missing two-block terminator",
      { terminatorBlocks: 0 },
      "missing tar terminator"
    ],
    ["single zero record", { terminatorBlocks: 1 }, "missing tar terminator"],
    [
      "archive concatenation",
      { tail: Buffer.alloc(512, 1) },
      "data after tar terminator"
    ],
    ["partial block tail", { tail: Buffer.from([1]) }, "partial tar block"]
  ])("rejects %s", async (_name, options, reason) => {
    const sample = await signedComponentFixture({}, undefined, options);
    fixtures.push(sample);
    await expect(verifyComponent(sample.input)).rejects.toThrow(reason);
  });

  it("rejects duplicate archive paths", async () => {
    const sample = await signedComponentFixture({}, [
      { path: "entry.js" },
      { path: "entry.js" }
    ]);
    fixtures.push(sample);
    await expect(verifyComponent(sample.input)).rejects.toThrow(
      "duplicate component archive path"
    );
  });

  it("rejects duplicate and unsafe manifest file paths", async () => {
    const sample = await signedComponentFixture({
      files: [{ path: "../escape", sha256: "0".repeat(64) }]
    });
    fixtures.push(sample);
    await expect(verifyComponent(sample.input)).rejects.toThrow(
      "component file path is unsafe"
    );
    const duplicate = await signedComponentFixture({
      files: [
        { path: "entry.js", sha256: "0".repeat(64) },
        { path: "entry.js", sha256: "0".repeat(64) }
      ]
    });
    fixtures.push(duplicate);
    await expect(verifyComponent(duplicate.input)).rejects.toThrow(
      "component file inventory is invalid or duplicate"
    );
  });

  it("rejects malformed numeric glibc versions instead of passing NaN comparisons", async () => {
    const linux = await signedComponentFixture({
      target: {
        platform: "linux",
        architecture: "x64",
        libc: { family: "glibc", minimumVersion: "2.28.1" }
      }
    });
    fixtures.push(linux);
    for (const libcVersion of [
      "2.28.0",
      "2.28.1.0",
      "2.28.x",
      "2.28.1-evil",
      "02.28.1",
      "2.028.1"
    ]) {
      await expect(
        verifyComponent({
          ...linux.input,
          runtime: { ...linux.input.runtime, libcVersion }
        })
      ).rejects.toThrow("runtime libc version is incompatible");
    }
    await expect(
      verifyComponent({
        ...linux.input,
        runtime: { ...linux.input.runtime, libcVersion: "2.28.2" }
      })
    ).resolves.toBeDefined();
  });

  it("checks glibc minimum and unsupported target", async () => {
    const linux = await signedComponentFixture({
      target: {
        platform: "linux",
        architecture: "x64",
        libc: { family: "glibc", minimumVersion: "2.28" }
      }
    });
    fixtures.push(linux);
    await expect(
      verifyComponent({
        ...linux.input,
        runtime: { ...linux.input.runtime, libcVersion: "2.17" }
      })
    ).rejects.toThrow("runtime libc version is incompatible");
    await expect(
      verifyComponent({
        ...linux.input,
        runtime: { ...linux.input.runtime, libcVersion: "invalid" }
      })
    ).rejects.toThrow("runtime libc version is incompatible");
    const unsupported = await signedComponentFixture({
      target: { platform: "windows", architecture: "x64" } as never
    });
    fixtures.push(unsupported);
    await expect(verifyComponent(unsupported.input)).rejects.toThrow(
      "unsupported component target"
    );
  });

  it("rejects unsigned placeholders and unsupported signature algorithms", async () => {
    const sample = await fixture();
    await expect(
      verifyComponent({
        ...sample.input,
        signature: {
          ...sample.input.signature,
          algorithm: "unsigned-placeholder" as never
        }
      })
    ).rejects.toThrow("unsupported component signature");
  });

  it("rejects unknown signing keys before archive use", async () => {
    const sample = await fixture();
    await expect(
      verifyComponent({ ...sample.input, trustedKeys: new Map() })
    ).rejects.toThrow("untrusted component signing key");
  });

  it("interoperates with canonical JS package builder and signer", async () => {
    const sample = await fixture();
    const original = fixtureManifest(sample.input.manifestBytes);
    const manifest = buildComponentManifest({
      componentRoot: sample.root,
      archivePath: sample.input.archivePath,
      component: original.component,
      productVersion: original.productVersion,
      target: original.target,
      runtimes: original.runtimes,
      requiredFiles: original.requiredFiles
    });
    const pair = generateKeyPairSync("ed25519");
    const signed = signComponentManifest({
      manifest,
      keyId: "builder-test-key",
      privateKey: pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString()
    });
    await expect(
      verifyComponent({
        ...sample.input,
        manifestBytes: signed.manifestBytes,
        signature: signed.signature,
        trustedKeys: new Map([
          [
            "builder-test-key",
            pair.publicKey.export({ type: "spki", format: "pem" }).toString()
          ]
        ])
      })
    ).resolves.toEqual(manifest);
  });

  it("exposes archive digest as bound signed metadata", async () => {
    const sample = await fixture();
    const actual = digest(
      await import("node:fs").then(({ readFileSync }) =>
        readFileSync(sample.input.archivePath)
      )
    );
    expect(fixtureManifest(sample.input.manifestBytes).archive.sha256).toBe(
      actual
    );
  });
});
