import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KoedServerPaths } from "./paths.js";

const files = vi.hoisted(() => [
  { path: "onnx/model.onnx", body: "synthetic pinned graph" },
  { path: "onnx/model.onnx_data", body: "synthetic pinned weights" }
]);

vi.mock("@koed/shared", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const { createHash } = await import("node:crypto");
  return {
    ...actual,
    PINNED_PRIVACY_MODEL_FILES: files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.body).digest("hex"),
      size: Buffer.byteLength(file.body)
    }))
  };
});

import {
  installPrivacyModel,
  resolvePrivacyModelPaths
} from "./privacy-model-runtime.js";

const roots: string[] = [];
const paths = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-privacy-download-"));
  roots.push(root);
  return { modelsDir: resolve(root, "models") } as KoedServerPaths;
};
const respond = (url: Parameters<typeof fetch>[0]) => {
  const file = files.find((entry) =>
    new URL(String(url)).pathname.endsWith(`/${entry.path}`)
  );
  if (!file) throw new Error("Unexpected model asset");
  return new Response(file.body);
};
const assertInstalled = (serverPaths: KoedServerPaths) => {
  const { blobsDir, cacheDir } = resolvePrivacyModelPaths(serverPaths);
  expect(readdirSync(blobsDir)).toHaveLength(files.length);
  for (const file of files) {
    const hash = createHash("sha256").update(file.body).digest("hex");
    expect(readFileSync(resolve(blobsDir, hash), "utf8")).toBe(file.body);
  }
  expect(existsSync(cacheDir)).toBe(true);
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("pinned Privacy Filter downloads", () => {
  it("cancels an active model body and retries with no partial publication", async () => {
    const serverPaths = paths();
    const controller = new AbortController();
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("partial"));
            }
          })
        )
    );
    const pending = installPrivacyModel(serverPaths, {}, fetcher, {
      signal: controller.signal,
      progress: () => controller.abort()
    });
    await expect(pending).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(readdirSync(resolvePrivacyModelPaths(serverPaths).blobsDir)).toEqual(
      []
    );
    expect(
      await installPrivacyModel(serverPaths, {}, async (url) => respond(url))
    ).toMatchObject({ ok: true });
    assertInstalled(serverPaths);
  });

  it("relaunch reuses a completed blob and ignores an abandoned partial transfer", async () => {
    const serverPaths = paths();
    let count = 0;
    await installPrivacyModel(serverPaths, {}, async (url) =>
      ++count === 1
        ? respond(url)
        : new Response("unavailable", { status: 404 })
    );
    const { blobsDir } = resolvePrivacyModelPaths(serverPaths);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      resolve(blobsDir, `${"a".repeat(64)}.999999.dead.download`),
      "partial"
    );
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) =>
      respond(url)
    );
    expect(await installPrivacyModel(serverPaths, {}, fetcher)).toMatchObject({
      ok: true
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(files[1]!.path);
    expect(
      readdirSync(blobsDir).filter((name) => !name.endsWith(".download"))
    ).toHaveLength(files.length);
  });

  it("retries an interrupted response body and publishes only verified complete files", async () => {
    const serverPaths = paths();
    let first = true;
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      if (first) {
        first = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(new TypeError("terminated"));
            }
          })
        );
      }
      return respond(url);
    });
    expect(await installPrivacyModel(serverPaths, {}, fetcher)).toMatchObject({
      ok: true
    });
    expect(fetcher).toHaveBeenCalledTimes(files.length + 1);
    assertInstalled(serverPaths);
  });

  it.each([408, 429, 503])(
    "retries transient HTTP %s without reusing response bodies",
    async (status) => {
      const serverPaths = paths();
      let attempts = 0;
      const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) =>
        ++attempts <= 2 ? new Response("unavailable", { status }) : respond(url)
      );
      expect(await installPrivacyModel(serverPaths, {}, fetcher)).toMatchObject(
        {
          ok: true
        }
      );
      expect(fetcher).toHaveBeenCalledTimes(files.length + 2);
      assertInstalled(serverPaths);
    }
  );

  it("does not retry earlier than a Retry-After beyond its local wait budget", async () => {
    const serverPaths = paths();
    const fetcher = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "120" }
        })
    );
    expect(await installPrivacyModel(serverPaths, {}, fetcher)).toMatchObject({
      ok: false,
      state: "missing"
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(readdirSync(resolvePrivacyModelPaths(serverPaths).blobsDir)).toEqual(
      []
    );
  });

  it("cleans an interrupted body even when every bounded attempt fails", async () => {
    const serverPaths = paths();
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(new TypeError("terminated"));
            }
          })
        )
    );
    await expect(installPrivacyModel(serverPaths, {}, fetcher)).rejects.toThrow(
      "transfer failed after 3 attempts"
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(readdirSync(resolvePrivacyModelPaths(serverPaths).blobsDir)).toEqual(
      []
    );
  });

  it("bounds connection retries and removes unfinished files", async () => {
    const serverPaths = paths();
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(installPrivacyModel(serverPaths, {}, fetcher)).rejects.toThrow(
      "onnx/model.onnx: transfer failed after 3 attempts"
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(readdirSync(resolvePrivacyModelPaths(serverPaths).blobsDir)).toEqual(
      []
    );
    expect(existsSync(resolvePrivacyModelPaths(serverPaths).cacheDir)).toBe(
      false
    );
  });

  it("fails closed on complete but corrupt content without publishing or retrying it", async () => {
    const serverPaths = paths();
    const fetcher = vi.fn(async () => new Response("corrupt"));
    expect(await installPrivacyModel(serverPaths, {}, fetcher)).toMatchObject({
      ok: false,
      state: "checksum_mismatch"
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(readdirSync(resolvePrivacyModelPaths(serverPaths).blobsDir)).toEqual(
      []
    );
  });

  it("fails promptly for permanent HTTP errors and cleans temporary state", async () => {
    const serverPaths = paths();
    const fetcher = vi.fn(
      async () => new Response("not found", { status: 404 })
    );
    expect(await installPrivacyModel(serverPaths, {}, fetcher)).toMatchObject({
      ok: false,
      state: "missing"
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(readdirSync(resolvePrivacyModelPaths(serverPaths).blobsDir)).toEqual(
      []
    );
  });

  it("reuses verified installed assets without network access", async () => {
    const serverPaths = paths();
    await installPrivacyModel(serverPaths, {}, async (url) => respond(url));
    const fetcher = vi.fn();
    expect(await installPrivacyModel(serverPaths, {}, fetcher)).toMatchObject({
      ok: true
    });
    expect(fetcher).not.toHaveBeenCalled();
    assertInstalled(serverPaths);
  });
});
