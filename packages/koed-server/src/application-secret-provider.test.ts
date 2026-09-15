import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledPdsSecretProviderEnvironment,
  runApplicationSecretProvider
} from "./application-secret-provider.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("application PDS secret provider", () => {
  it("uses one filesystem store for put, get, and delete", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pds-provider-"));
    roots.push(root);
    const environment = { KOED_HOME: root };

    await expect(
      runApplicationSecretProvider("put", "pds-runtime", "secret", environment)
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      runApplicationSecretProvider("get", "pds-runtime", undefined, environment)
    ).resolves.toEqual({ ok: true, value: "secret" });
    await expect(
      runApplicationSecretProvider(
        "delete",
        "pds-runtime",
        undefined,
        environment
      )
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      runApplicationSecretProvider("get", "pds-runtime", undefined, environment)
    ).resolves.toEqual({ ok: true, value: null });
  });

  it("configures the bundled provider without OS credential-store dependencies", () => {
    const environment = bundledPdsSecretProviderEnvironment({
      KOED_HOME: "/tmp/koed"
    });
    expect(environment.PDS_SECRET_PROVIDER).toBe("headless");
    expect(environment.PDS_SECRET_PROVIDER_COMMAND).toBe(process.execPath);
    expect(environment.PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON).toContain(
      "secret-provider"
    );
  });
});
