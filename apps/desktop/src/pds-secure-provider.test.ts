import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPdsDesktopSecretStore } from "./pds-secure-provider.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PDS Desktop application secret provider", () => {
  it("uses the shared application-managed store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-"));
    directories.push(directory);
    const store = createPdsDesktopSecretStore({ userDataPath: directory });
    await store.put("pds-runtime", "secret-value");
    const persisted = readFileSync(
      join(directory, "secrets", "pds-secrets.json"),
      "utf8"
    );
    expect(persisted).not.toContain("secret-value");
    expect(
      lstatSync(join(directory, "secrets", "pds-secrets.json")).mode & 0o077
    ).toBe(0);
    expect(await store.get("pds-runtime")).toBe("secret-value");
    await store.delete("pds-runtime");
    expect(await store.get("pds-runtime")).toBeNull();
  });

  it("uses configured operator-managed provider for Desktop Authority state", async () => {
    const store = createPdsDesktopSecretStore({
      userDataPath: tmpdir(),
      environment: {
        PDS_SECRET_PROVIDER: "headless",
        PDS_SECRET_PROVIDER_COMMAND: process.execPath,
        PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON: JSON.stringify([
          "-e",
          "process.stdout.write('operator-value')"
        ])
      }
    });
    expect(store?.providerKind).toBe("operator_managed");
    await expect(store?.get("pds-authority")).resolves.toBe("operator-value");
  });

  it("supports a maximum-length custom application file name", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-drafts-"));
    directories.push(directory);
    const store = createPdsDesktopSecretStore({
      userDataPath: directory,
      storeFilename: `${"d".repeat(115)}.json`
    });
    await store.put("draft", "draft-value");
    expect(
      readFileSync(join(directory, `${"d".repeat(115)}.json`), "utf8")
    ).not.toContain("draft-value");
  });
});
