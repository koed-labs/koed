import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import {
  collectPrivacyModelStatus,
  installPrivacyModel,
  materializePrivacyModelCacheEntry,
  PRIVACY_MODEL_FILES,
  PRIVACY_MODEL_REVISION,
  resolvePrivacyModelPaths
} from "./privacy-model-runtime.js";
import {
  OFFICIAL_PRIVACY_MODEL_REVISION,
  OFFICIAL_PRIVACY_Q4_DATA_SHA256,
  OFFICIAL_PRIVACY_Q4_ONNX_SHA256,
  OFFICIAL_PRIVACY_TOKENIZER_SHA256
} from "../../../apps/privacy-service/src/provenance.js";

const roots: string[] = [];
const paths = (): KoedServerPaths => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-privacy-model-"));
  roots.push(root);
  return {
    koedHome: root,
    modelsDir: resolve(root, "models"),
    cacheDir: resolve(root, "cache")
  } as KoedServerPaths;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Privacy Filter model assets", () => {
  it("uses the immutable official revision and content-addressed KOED_HOME paths", () => {
    const serverPaths = paths();
    const modelPaths = resolvePrivacyModelPaths(serverPaths);
    expect(PRIVACY_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(PRIVACY_MODEL_REVISION).toBe(OFFICIAL_PRIVACY_MODEL_REVISION);
    expect(PRIVACY_MODEL_FILES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha256: OFFICIAL_PRIVACY_Q4_ONNX_SHA256 }),
        expect.objectContaining({ sha256: OFFICIAL_PRIVACY_Q4_DATA_SHA256 }),
        expect.objectContaining({ sha256: OFFICIAL_PRIVACY_TOKENIZER_SHA256 })
      ])
    );
    expect(modelPaths.blobsDir).toBe(
      resolve(serverPaths.modelsDir, "privacy/blobs/sha256")
    );
    expect(PRIVACY_MODEL_FILES.map((file) => file.path)).toContain(
      "onnx/model_q4.onnx_data"
    );
  });

  it("rejects a corrupt content-addressed blob", async () => {
    const serverPaths = paths();
    const modelPaths = resolvePrivacyModelPaths(serverPaths);
    const first = PRIVACY_MODEL_FILES[0]!;
    mkdirSync(modelPaths.blobsDir, { recursive: true });
    writeFileSync(resolve(modelPaths.blobsDir, first.sha256), "not the model");
    await expect(collectPrivacyModelStatus(serverPaths)).resolves.toMatchObject(
      {
        ok: false,
        state: "checksum_mismatch"
      }
    );
  });

  it("leaves an existing verified cache hard link untouched", () => {
    const serverPaths = paths();
    const blob = resolve(serverPaths.modelsDir, "blob");
    const cacheDir = resolve(serverPaths.modelsDir, "cache");
    const target = resolve(cacheDir, "model.onnx");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(blob, "verified model");
    linkSync(blob, target);
    chmodSync(cacheDir, 0o500);

    try {
      expect(() =>
        materializePrivacyModelCacheEntry(blob, target)
      ).not.toThrow();
      expect(statSync(target).ino).toBe(statSync(blob).ino);
    } finally {
      chmodSync(cacheDir, 0o700);
    }
  });

  it("does not download model assets in external dependency mode", async () => {
    const result = await installPrivacyModel(
      paths(),
      { KOED_DEPENDENCY_MODE: "external" },
      async () => {
        throw new Error("fetch must not run");
      }
    );
    expect(result).toMatchObject({ ok: false, state: "not_configured" });
  });
});
