import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
const temp = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-component-store-test-"));
  roots.push(root);
  return root;
};
const fixture = async (
  overrides: Parameters<typeof signedComponentFixture>[0] = {}
) => {
  const item = await signedComponentFixture(overrides);
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

const preserveActivePointer = (home: string) => {
  const pointer = resolve(home, "runtime/components/current.json");
  mkdirSync(resolve(home, "runtime/components"), { recursive: true });
  writeFileSync(pointer, "active-generation-fixture\n", { mode: 0o600 });
  return { pointer, bytes: readFileSync(pointer) };
};

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
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
      target: { platform: "linux", architecture: "arm64" }
    });
    const stagedBase = await stageFixture(paths, base);
    const stagedPrivacy = await stageFixture(paths, privacy);
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

  it("offline source with missing metadata makes no network calls", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
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

  it("rejects cancellation before starting remote requests", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: temp() });
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
});
