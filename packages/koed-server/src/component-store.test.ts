import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import properLockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeIdentity } from "./component-contract.js";

const testRuntime = vi.hoisted(() => ({
  current: undefined as RuntimeIdentity | undefined
}));
const testKeys = vi.hoisted(() => ({ current: new Map<string, string>() }));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => {
    if (!testRuntime.current) throw new Error("fixture runtime missing");
    return testRuntime.current;
  }
}));
vi.mock("./component-trust-roots.js", () => ({
  productionComponentTrustRoots: testKeys.current
}));
import { signedComponentFixture } from "./component-test-fixtures.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  readStagedGeneration,
  stageComponent,
  stageGeneration
} from "./component-store.js";

const roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof signedComponentFixture>>[] = [];
const activePointers: Array<{ pointer: string; bytes: Buffer }> = [];
const preserveActivePointer = (home: string) => {
  const pointer = resolve(home, "runtime/components/current.json");
  mkdirSync(resolve(home, "runtime/components"), { recursive: true });
  writeFileSync(pointer, "active-generation-fixture\n", { mode: 0o600 });
  const snapshot = { pointer, bytes: readFileSync(pointer) };
  activePointers.push(snapshot);
  return snapshot;
};
const temp = () => {
  const root = mkdtempSync(
    resolve(realpathSync(tmpdir()), "koed-component-store-test-")
  );
  roots.push(root);
  preserveActivePointer(root);
  return root;
};
const fixture = async (
  overrides: Parameters<typeof signedComponentFixture>[0] = {},
  archiveEntries?: Parameters<typeof signedComponentFixture>[1],
  includeArchiveInventory = false
) => {
  const item = await signedComponentFixture(
    overrides,
    archiveEntries,
    {},
    includeArchiveInventory
  );
  fixtures.push(item);
  return item;
};
const stageFixture = async (
  paths: ReturnType<typeof resolveKoedServerPaths>,
  item: Awaited<ReturnType<typeof fixture>>
) => {
  testRuntime.current = item.input.runtime;
  testKeys.current.clear();
  for (const [key, value] of item.input.trustedKeys)
    testKeys.current.set(key, value);
  return stageComponent(
    paths,
    {
      kind: "offline",
      archivePath: item.input.archivePath,
      manifestPath: writeMetadata(item.input.manifestBytes),
      signaturePath: writeMetadata(
        Buffer.from(JSON.stringify(item.input.signature))
      )
    },
    {
      expectedComponent: item.input.expectedComponent,
      expectedVersion: item.input.expectedVersion,
      target: item.input.target,
      runtime: item.input.runtime
    }
  );
};
const writeMetadata = (contents: Buffer) => {
  const path = resolve(
    temp(),
    `metadata-${Math.random().toString(16).slice(2)}.json`
  );
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
};
const owner = { kind: "standalone" as const, installationId: "fixture-owner" };

afterEach(() => {
  const changedPointers = activePointers
    .splice(0)
    .filter(({ pointer, bytes }) => {
      try {
        return !readFileSync(pointer).equals(bytes);
      } catch {
        return true;
      }
    });
  for (const item of fixtures.splice(0)) item.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  testRuntime.current = undefined;
  testKeys.current.clear();
  expect(changedPointers).toEqual([]);
});

describe("immutable component and generation store", () => {
  it("stages verified components idempotently by content digest", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const item = await fixture();
    const first = await stageFixture(paths, item);
    const second = await stageFixture(paths, item);
    expect(second).toEqual(first);
    expect(first.root).toContain(first.manifestDigest);
  });

  it("rejects same component version with a different signed manifest digest", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const original = await fixture();
    await stageFixture(paths, original);
    const compatible = {
      kind: "node" as const,
      runtimeRange: ">=24 <25",
      nodeRange: ">=24 <25",
      modulesAbi: "137",
      minimumNapi: 10
    };
    const conflicting = await fixture({ runtimes: [compatible, compatible] });
    await expect(stageFixture(paths, conflicting)).rejects.toThrow(
      "component version already installed with different digest"
    );
  });

  it("rejects mixed product versions without changing active pointer", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const active = preserveActivePointer(paths.koedHome);
    const base = await fixture({ productVersion: "0.9.0" });
    const privacy = await fixture({
      component: "privacy",
      productVersion: "0.9.1"
    });
    const stagedBase = await stageFixture(paths, base);
    const stagedPrivacy = await stageFixture(paths, privacy);
    testKeys.current.clear();
    for (const item of [base, privacy])
      for (const [key, value] of item.input.trustedKeys)
        testKeys.current.set(key, value);
    await expect(
      stageGeneration(paths, {
        base: stagedBase,
        privacy: stagedPrivacy,
        owner
      })
    ).rejects.toThrow("mixed component versions");
    expect(readFileSync(active.pointer)).toEqual(active.bytes);
  });

  it("rejects mixed component targets without changing active pointer", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const active = preserveActivePointer(paths.koedHome);
    const base = await fixture();
    const privacy = await fixture({
      component: "privacy",
      target: {
        platform: "linux",
        architecture: "x64",
        libc: { family: "glibc", minimumVersion: "1.0" }
      }
    });
    const stagedBase = await stageFixture(paths, base);
    const stagedPrivacy = await stageFixture(paths, privacy);
    testKeys.current.clear();
    for (const item of [base, privacy])
      for (const [key, value] of item.input.trustedKeys)
        testKeys.current.set(key, value);
    await expect(
      stageGeneration(paths, {
        base: stagedBase,
        privacy: stagedPrivacy,
        owner
      })
    ).rejects.toThrow("mixed component targets");
    expect(readFileSync(active.pointer)).toEqual(active.bytes);
  });

  it("rejects corrupt cached component bytes without changing active pointer", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const active = preserveActivePointer(paths.koedHome);
    const item = await fixture();
    const staged = await stageFixture(paths, item);
    writeFileSync(resolve(staged.root, "entry.js"), "tampered\n");
    await expect(stageFixture(paths, item)).rejects.toThrow();
    expect(readFileSync(active.pointer)).toEqual(active.bytes);
  });

  it("rejects a symlinked digest cache root before reusing it", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const active = preserveActivePointer(paths.koedHome);
    const item = await fixture();
    const staged = await stageFixture(paths, item);
    const digestRoot = resolve(staged.root, "..");
    const movedRoot = resolve(temp(), "moved-cache");
    renameSync(digestRoot, movedRoot);
    symlinkSync(movedRoot, digestRoot);
    await expect(stageFixture(paths, item)).rejects.toThrow();
    expect(readFileSync(active.pointer)).toEqual(active.bytes);
  });

  it("offline source with missing metadata makes no network calls", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    testRuntime.current = {
      kind: "node",
      version: "24.13.1",
      nodeVersion: "24.13.1",
      modulesAbi: "137",
      napiVersion: 10,
      platform: "linux",
      architecture: "x64"
    };
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      stageComponent(
        paths,
        {
          kind: "offline",
          archivePath: resolve(temp(), "absent.tar.gz"),
          manifestPath: resolve(temp(), "absent-manifest.json"),
          signaturePath: resolve(temp(), "absent-signature.json")
        },
        {
          expectedComponent: "base",
          expectedVersion: "0.8.1",
          target: { platform: "linux", architecture: "x64" },
          runtime: {
            kind: "node",
            version: "24.13.1",
            nodeVersion: "24.13.1",
            modulesAbi: "137",
            napiVersion: 10,
            platform: "linux",
            architecture: "x64"
          }
        }
      )
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("retries transient remote server failures", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const item = await fixture();
    testRuntime.current = item.input.runtime;
    testKeys.current.clear();
    for (const [key, value] of item.input.trustedKeys)
      testKeys.current.set(key, value);
    const urls = new Map([
      ["https://fixture.test/manifest.json", item.input.manifestBytes],
      [
        "https://fixture.test/signature.json",
        Buffer.from(JSON.stringify(item.input.signature))
      ],
      ["https://fixture.test/base.tar.gz", readFileSync(item.input.archivePath)]
    ]);
    let manifestAttempts = 0;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (
          String(input) === "https://fixture.test/manifest.json" &&
          manifestAttempts++ === 0
        )
          return new Response(null, { status: 503 });
        const bytes = urls.get(String(input));
        return bytes
          ? new Response(bytes)
          : new Response(null, { status: 404 });
      });
    const result = await stageComponent(
      paths,
      {
        kind: "remote",
        archiveUrl: "https://fixture.test/base.tar.gz",
        manifestUrl: "https://fixture.test/manifest.json",
        signatureUrl: "https://fixture.test/signature.json"
      },
      {
        expectedComponent: "base",
        expectedVersion: "0.8.1",
        target: item.input.target,
        runtime: item.input.runtime
      }
    );
    expect(result.manifestDigest).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(4);
    fetch.mockRestore();
  });

  it("rejects malformed remote archive bytes without changing active pointer", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const active = preserveActivePointer(paths.koedHome);
    const item = await fixture();
    testRuntime.current = item.input.runtime;
    testKeys.current.clear();
    for (const [key, value] of item.input.trustedKeys)
      testKeys.current.set(key, value);
    const urls = new Map([
      ["https://fixture.test/manifest.json", item.input.manifestBytes],
      [
        "https://fixture.test/signature.json",
        Buffer.from(JSON.stringify(item.input.signature))
      ],
      ["https://fixture.test/base.tar.gz", Buffer.from("corrupt archive")]
    ]);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const bytes = urls.get(String(input));
        return bytes
          ? new Response(bytes)
          : new Response(null, { status: 404 });
      });
    await expect(
      stageComponent(
        paths,
        {
          kind: "remote",
          archiveUrl: "https://fixture.test/base.tar.gz",
          manifestUrl: "https://fixture.test/manifest.json",
          signatureUrl: "https://fixture.test/signature.json"
        },
        {
          expectedComponent: "base",
          expectedVersion: "0.8.1",
          target: item.input.target,
          runtime: item.input.runtime
        }
      )
    ).rejects.toThrow();
    expect(readFileSync(active.pointer)).toEqual(active.bytes);
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockRestore();
  });

  it("rejects redirects from HTTPS to an unsafe protocol", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const item = await fixture();
    testRuntime.current = item.input.runtime;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "file:///etc/passwd" }
      })
    );
    await expect(
      stageComponent(
        paths,
        {
          kind: "remote",
          archiveUrl: "https://fixture.test/base.tar.gz",
          manifestUrl: "https://fixture.test/manifest.json",
          signatureUrl: "https://fixture.test/signature.json"
        },
        {
          expectedComponent: "base",
          expectedVersion: "0.8.1",
          target: item.input.target,
          runtime: item.input.runtime
        }
      )
    ).rejects.toThrow("component redirect requires safe HTTPS");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRestore();
  });

  it("cancels a stalled response body when caller aborts", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const controller = new AbortController();
    testRuntime.current = {
      kind: "node",
      version: "24.13.1",
      nodeVersion: "24.13.1",
      modulesAbi: "137",
      napiVersion: 10,
      platform: "linux",
      architecture: "x64"
    };
    let bodyCancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(new Uint8Array([1]));
          },
          cancel() {
            bodyCancelled = true;
          }
        })
      )
    );
    const pending = stageComponent(
      paths,
      {
        kind: "remote",
        archiveUrl: "https://fixture.test/archive",
        manifestUrl: "https://fixture.test/manifest",
        signatureUrl: "https://fixture.test/signature"
      },
      {
        expectedComponent: "base",
        expectedVersion: "0.8.1",
        target: { platform: "linux", architecture: "x64" },
        runtime: {
          kind: "node",
          version: "24.13.1",
          nodeVersion: "24.13.1",
          modulesAbi: "137",
          napiVersion: 10,
          platform: "linux",
          architecture: "x64"
        },
        signal: controller.signal
      }
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow("component installation cancelled");
    expect(bodyCancelled).toBe(true);
  });

  it("cancels rejected HTTP response bodies", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    testRuntime.current = {
      kind: "node",
      version: "24.13.1",
      nodeVersion: "24.13.1",
      modulesAbi: "137",
      napiVersion: 10,
      platform: "linux",
      architecture: "x64"
    };
    let bodyCancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            bodyCancelled = true;
          }
        }),
        { status: 404 }
      )
    );
    await expect(
      stageComponent(
        paths,
        {
          kind: "remote",
          archiveUrl: "https://fixture.test/archive",
          manifestUrl: "https://fixture.test/manifest",
          signatureUrl: "https://fixture.test/signature"
        },
        {
          expectedComponent: "base",
          expectedVersion: "0.8.1",
          target: { platform: "linux", architecture: "x64" },
          runtime: {
            kind: "node",
            version: "24.13.1",
            nodeVersion: "24.13.1",
            modulesAbi: "137",
            napiVersion: 10,
            platform: "linux",
            architecture: "x64"
          }
        }
      )
    ).rejects.toThrow("component download failed with HTTP 404");
    expect(bodyCancelled).toBe(true);
  });

  it("aborts while waiting for component-store lock", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const runtime: RuntimeIdentity = {
      kind: "node",
      version: "24.13.1",
      nodeVersion: "24.13.1",
      modulesAbi: "137",
      napiVersion: 10,
      platform: "linux",
      architecture: "x64"
    };
    testRuntime.current = runtime;
    const fetch = vi.spyOn(globalThis, "fetch");
    const release = await properLockfile.lock(paths.componentsDir, {
      realpath: false
    });
    const controller = new AbortController();
    const pending = stageComponent(
      paths,
      {
        kind: "remote",
        archiveUrl: "https://fixture.test/archive",
        manifestUrl: "https://fixture.test/manifest",
        signatureUrl: "https://fixture.test/signature"
      },
      {
        expectedComponent: "base",
        expectedVersion: "0.8.1",
        target: { platform: "linux", architecture: "x64" },
        runtime,
        signal: controller.signal
      }
    );
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow("component installation cancelled");
    expect(fetch).not.toHaveBeenCalled();
    await release();
  });

  it("rejects cancellation before starting remote requests", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    testRuntime.current = {
      kind: "node",
      version: "24.13.1",
      nodeVersion: "24.13.1",
      modulesAbi: "137",
      napiVersion: 10,
      platform: "linux",
      architecture: "x64"
    };
    const fetch = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    await expect(
      stageComponent(
        paths,
        {
          kind: "remote",
          archiveUrl: "https://example.test/component.tar.gz",
          manifestUrl: "https://example.test/manifest.json",
          signatureUrl: "https://example.test/signature.json"
        },
        {
          expectedComponent: "base",
          expectedVersion: "0.8.1",
          target: { platform: "linux", architecture: "x64" },
          runtime: {
            kind: "node",
            version: "24.13.1",
            nodeVersion: "24.13.1",
            modulesAbi: "137",
            napiVersion: 10,
            platform: "linux",
            architecture: "x64"
          },
          signal: controller.signal
        }
      )
    ).rejects.toThrow("component installation cancelled");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("rejects a caller-forged runtime identity", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const item = await fixture();
    testRuntime.current = item.input.runtime;
    await expect(
      stageComponent(
        paths,
        {
          kind: "offline",
          archivePath: item.input.archivePath,
          manifestPath: writeMetadata(item.input.manifestBytes),
          signaturePath: writeMetadata(
            Buffer.from(JSON.stringify(item.input.signature))
          )
        },
        {
          expectedComponent: "base",
          expectedVersion: "0.8.1",
          target: item.input.target,
          runtime: { ...item.input.runtime, version: "99.0.0" }
        }
      )
    ).rejects.toThrow("caller runtime identity does not match actual runtime");
  });

  it("re-reads staged generation and binds owner and exact component roots", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const item = await fixture();
    const base = await stageFixture(paths, item);
    const generation = await stageGeneration(paths, { base, owner });
    await expect(readStagedGeneration(paths, generation.id)).resolves.toEqual(
      generation
    );
    await expect(readStagedGeneration(paths, "../escape")).rejects.toThrow();
  });

  it("derives generation identity only from reverified component records", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const baseItem = await fixture();
    const privacyItem = await fixture({ component: "privacy" });
    const base = await stageFixture(paths, baseItem);
    const privacy = await stageFixture(paths, privacyItem);
    testKeys.current.clear();
    for (const item of [baseItem, privacyItem])
      for (const [key, value] of item.input.trustedKeys)
        testKeys.current.set(key, value);
    const generation = await stageGeneration(paths, {
      base: {
        ...base,
        manifest: { ...base.manifest, productVersion: "9.9.9" }
      },
      privacy: {
        ...privacy,
        manifest: { ...privacy.manifest, productVersion: "1.2.3" }
      },
      owner
    });
    expect(generation.productVersion).toBe("0.8.1");
    expect(generation.base.manifest.productVersion).toBe("0.8.1");
  });

  it("reads generation records larger than the former 1 MiB limit", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const archiveEntries = Array.from({ length: 11_000 }, (_, index) => ({
      path: index === 0 ? "entry.js" : `inventory/file-${index}.js`
    }));
    const baseItem = await fixture({}, archiveEntries, true);
    const privacyItem = await fixture(
      { component: "privacy" },
      archiveEntries,
      true
    );
    const base = await stageFixture(paths, baseItem);
    const privacy = await stageFixture(paths, privacyItem);
    testKeys.current.clear();
    for (const item of [baseItem, privacyItem])
      for (const [key, value] of item.input.trustedKeys)
        testKeys.current.set(key, value);
    const generation = await stageGeneration(paths, { base, privacy, owner });
    const recordPath = resolve(
      paths.generationsDir,
      generation.id,
      "generation.json"
    );
    expect(readFileSync(recordPath).byteLength).toBeGreaterThan(1024 * 1024);
    await expect(readStagedGeneration(paths, generation.id)).resolves.toEqual(
      generation
    );
  }, 45_000);

  it("rejects unknown generation record fields", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const base = await stageFixture(paths, await fixture());
    const generation = await stageGeneration(paths, { base, owner });
    const recordPath = resolve(
      paths.generationsDir,
      generation.id,
      "generation.json"
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    record.unbound = "extra";
    writeFileSync(recordPath, JSON.stringify(record));
    await expect(readStagedGeneration(paths, generation.id)).rejects.toThrow();
  });

  it("requires privacy reference presence to match component reference presence", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const baseItem = await fixture();
    const privacyItem = await fixture({ component: "privacy" });
    const base = await stageFixture(paths, baseItem);
    const privacy = await stageFixture(paths, privacyItem);
    testKeys.current.clear();
    for (const item of [baseItem, privacyItem])
      for (const [key, value] of item.input.trustedKeys)
        testKeys.current.set(key, value);
    const generation = await stageGeneration(paths, { base, privacy, owner });
    const recordPath = resolve(
      paths.generationsDir,
      generation.id,
      "generation.json"
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete record.privacy;
    writeFileSync(recordPath, JSON.stringify(record));
    await expect(readStagedGeneration(paths, generation.id)).rejects.toThrow();
  });

  it("rejects noncanonical generation record JSON", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
    const base = await stageFixture(paths, await fixture());
    const generation = await stageGeneration(paths, { base, owner });
    const recordPath = resolve(
      paths.generationsDir,
      generation.id,
      "generation.json"
    );
    const recordBytes = readFileSync(recordPath, "utf8");
    writeFileSync(recordPath, ` ${recordBytes}`);
    await expect(readStagedGeneration(paths, generation.id)).rejects.toThrow(
      "component metadata is not canonical JSON"
    );
  });

  it("rejects symlinked KOED_HOME ancestry before creating store directories", async () => {
    const parent = temp();
    const realHome = resolve(parent, "real-home");
    mkdirSync(realHome);
    const linkedHome = resolve(parent, "linked-home");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(realHome, linkedHome);
    const paths = resolveKoedServerPaths({ KOED_HOME: linkedHome });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      stageComponent(
        paths,
        {
          kind: "remote",
          archiveUrl: "https://fixture.test/archive",
          manifestUrl: "https://fixture.test/manifest",
          signatureUrl: "https://fixture.test/signature"
        },
        {
          expectedComponent: "base",
          expectedVersion: "0.8.1",
          target: { platform: "linux", architecture: "x64" },
          runtime: {
            kind: "node",
            version: "24.13.1",
            nodeVersion: "24.13.1",
            modulesAbi: "137",
            napiVersion: 10,
            platform: "linux",
            architecture: "x64"
          }
        }
      )
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
