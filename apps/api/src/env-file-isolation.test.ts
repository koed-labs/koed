import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadApiEnv } from "./env-config.js";
import { loadWorkerEnv } from "../../worker/src/env-config.js";
import { loadEmbeddingServiceEnv } from "../../embedding-service/src/env-config.js";

const scratch = fileURLToPath(new URL("../../../scratch", import.meta.url));
const loaders = [
  ["API", loadApiEnv],
  ["Worker", loadWorkerEnv],
  [
    "Embedding Service",
    (environment: NodeJS.ProcessEnv) =>
      loadEmbeddingServiceEnv(undefined, environment)
  ]
] as const;

describe.each(loaders)("%s explicit environment isolation", (_name, load) => {
  it("loads only the selected file and preserves process-level overrides", () => {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(resolve(scratch, "env-isolation-"));
    const path = resolve(directory, "fixture.env");
    writeFileSync(
      path,
      [
        "DATABASE_URL=fixture-file",
        "EMBEDDING_SERVICE_TOKEN=fixture-token",
        "PRIVACY_RUNTIME_CONTROL_TOKEN=fixture-privacy-control-token",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    const environment: NodeJS.ProcessEnv = {
      KOED_ENV_PATH: path,
      DATABASE_URL: "fixture-process"
    };
    try {
      load(environment);
      expect(environment).toEqual({
        KOED_ENV_PATH: path,
        DATABASE_URL: "fixture-process",
        EMBEDDING_SERVICE_TOKEN: "fixture-token"
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails on a missing explicit file without loading app defaults", () => {
    const environment: NodeJS.ProcessEnv = {
      KOED_ENV_PATH: resolve(scratch, "missing-explicit-env", "fixture.env")
    };
    expect(() => load(environment)).toThrow(
      "Explicit KOED_ENV_PATH could not be read"
    );
    expect(Object.keys(environment)).toEqual(["KOED_ENV_PATH"]);
  });
});
