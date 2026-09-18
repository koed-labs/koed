import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPdsApplicationSecretStore } from "@koed/shared";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "libsecret",
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) =>
      value.toString("utf8").replace(/^encrypted:/, "")
  }
}));

import { createManagedConversationDraftStore } from "./managed-conversation-draft-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed conversation draft storage", () => {
  it("reads legacy encrypted draft files without parsing them as PDS state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-drafts-"));
    directories.push(directory);
    const path = join(directory, "managed-conversation-drafts.json");
    writeFileSync(
      path,
      `${JSON.stringify({ draft: Buffer.from("encrypted:legacy-value").toString("base64url") })}\n`,
      { mode: 0o600 }
    );

    const store = createManagedConversationDraftStore({
      userDataPath: directory
    });
    await expect(store?.get("draft")).resolves.toBe("legacy-value");
    await store?.put("draft", "next-value");
    expect(readFileSync(path, "utf8")).not.toContain("next-value");
    expect(lstatSync(path).mode & 0o077).toBe(0);
  });

  it("reopens application-managed draft state after storage becomes available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-drafts-"));
    directories.push(directory);
    const applicationStore = createPdsApplicationSecretStore({
      rootPath: directory,
      storeDirectory: ".",
      storeFilename: "managed-conversation-drafts.json",
      keyFilename: "managed-conversation-drafts.key"
    });
    applicationStore.put("draft", "application-value");

    const store = createManagedConversationDraftStore({
      userDataPath: directory
    });
    await expect(store?.get("draft")).resolves.toBe("application-value");
  });

  it("does not expose unsafe draft storage as ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-drafts-"));
    directories.push(directory);
    const path = join(directory, "managed-conversation-drafts.json");
    writeFileSync(path, "{}\n", { mode: 0o644 });

    const store = createManagedConversationDraftStore({
      userDataPath: directory
    });
    await expect(store?.get("draft")).rejects.toThrow("unsafe");
  });
});
