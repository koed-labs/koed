import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLocalModelStatus,
  installLocalModel,
  resolveLocalModelManifest
} from "./local-models-runtime.js";
import type { KoedServerPaths } from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-local-models-"));
  temps.push(path);
  return path;
};

const paths = (root: string): KoedServerPaths => ({
  koedHome: root,
  configDir: resolve(root, "config"),
  logsDir: resolve(root, "logs"),
  runDir: resolve(root, "run"),
  dataDir: resolve(root, "data"),
  modelsDir: resolve(root, "models"),
  cacheDir: resolve(root, "cache"),
  postgresDataDir: resolve(root, "data", "postgres"),
  postgresRunDir: resolve(root, "run", "postgres"),
  postgresLogPath: resolve(root, "logs", "postgres.log"),
  runtimeStatePath: resolve(root, "run", "koed-server.json"),
  lastVerificationPath: resolve(root, "run", "last-verification.json"),
  serverConfigPath: resolve(root, "config", "server.json"),
  localPortsPath: resolve(root, "config", "local-ports.json"),
  explorerTokenPath: resolve(root, "config", "explorer-token.json"),
  repoRoot: root
});

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("local model runtime", () => {
  it("resolves default embedding model path under KOED_HOME", () => {
    const root = tempDir();

    const manifest = resolveLocalModelManifest(paths(root), "embedding", {});

    expect(manifest.key).toBe("qwen3-0.6b");
    expect(manifest.modelPath).toBe(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf")
    );
  });

  it("reports missing model with installer action", async () => {
    const root = tempDir();

    const status = await collectLocalModelStatus(paths(root), "embedding", {});

    expect(status.state).toBe("missing");
    expect(status.action).toContain(
      "koed-server models install --kind embedding"
    );
  });

  it("verifies installed model checksum", async () => {
    const root = tempDir();
    const modelPath = resolve(root, "model.gguf");
    writeFileSync(modelPath, "model-bytes");

    const status = await collectLocalModelStatus(paths(root), "embedding", {
      KOED_EMBEDDING_MODEL_PATH: modelPath,
      KOED_EMBEDDING_MODEL_SHA256: sha256("model-bytes")
    });

    expect(status.state).toBe("installed");
    expect(status.sha256).toBe(sha256("model-bytes"));
  });

  it("requires HTTPS model URLs", async () => {
    const root = tempDir();

    const result = await installLocalModel(paths(root), "embedding", {
      KOED_EMBEDDING_MODEL_URL: "http://example.test/model.gguf",
      KOED_EMBEDDING_MODEL_SHA256: sha256("actual")
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTPS URL");
  });

  it("rejects checksum mismatch after download", async () => {
    const root = tempDir();

    const result = await installLocalModel(
      paths(root),
      "embedding",
      {
        KOED_EMBEDDING_MODEL_URL: "https://example.test/model.gguf",
        KOED_EMBEDDING_MODEL_SHA256: sha256("expected")
      },
      { fetch: async () => new Response("actual") }
    );

    expect(result.ok).toBe(false);
    expect(result.state).toBe("checksum_mismatch");
  });

  it("installs model only after SHA-256 verification", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "models"));

    const result = await installLocalModel(
      paths(root),
      "embedding",
      {
        KOED_EMBEDDING_MODEL_URL: "https://example.test/model.gguf",
        KOED_EMBEDDING_MODEL_SHA256: sha256("actual")
      },
      { fetch: async () => new Response("actual") }
    );

    expect(result.ok).toBe(true);
    expect(result.state).toBe("installed");
  });
});
