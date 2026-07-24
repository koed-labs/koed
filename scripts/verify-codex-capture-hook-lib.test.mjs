import assert from "node:assert/strict";
import test from "node:test";
import { resolveCaptureVerificationConfig } from "./verify-codex-capture-hook-lib.mjs";

test("uses active hook config before static env defaults", () => {
  assert.deepEqual(
    resolveCaptureVerificationConfig({
      environment: {},
      rootEnv: {
        API_HOST_PORT: "3300",
        MEMORY_API_TOKEN: "static-token"
      },
      explorerEnv: {},
      hookConfig: {
        apiUrl: "http://localhost:43300/",
        apiToken: "runtime-token"
      }
    }),
    {
      apiUrl: "http://localhost:43300",
      apiToken: "runtime-token"
    }
  );
});

test("keeps explicit process overrides authoritative", () => {
  assert.deepEqual(
    resolveCaptureVerificationConfig({
      environment: {
        MEMORY_API_URL: "http://localhost:53300/",
        MEMORY_API_TOKEN: "explicit-token"
      },
      rootEnv: {},
      explorerEnv: {},
      hookConfig: {
        apiUrl: "http://localhost:43300",
        apiToken: "runtime-token"
      }
    }),
    {
      apiUrl: "http://localhost:53300",
      apiToken: "explicit-token"
    }
  );
});
