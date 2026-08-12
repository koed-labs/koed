import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRecordedCodexAuthentication } from "./codex-auth.js";

const subscriptionAuth = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-codex-auth-"));
  const filename = path.join(root, "auth.json");
  await writeFile(
    filename,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "test-only", refresh_token: "test-only" }
    }),
    { mode: 0o600 }
  );
  return filename;
};

describe("recorded Codex authentication", () => {
  it("keeps API-key authentication as the default explicit source", () => {
    expect(
      resolveRecordedCodexAuthentication(
        { OPENAI_API_KEY: "test-only-api-key" },
        "api_key"
      )
    ).toEqual({ mode: "api_key", apiKey: "test-only-api-key" });
  });

  it("accepts a private, user-owned subscription auth file", async () => {
    const authJsonPath = await subscriptionAuth();
    expect(
      resolveRecordedCodexAuthentication(
        { KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH: authJsonPath },
        "subscription"
      )
    ).toEqual({
      mode: "subscription",
      authJsonPath,
      codexHome: path.dirname(authJsonPath)
    });
  });

  it("rejects API credentials, unsafe permissions and symlinks in subscription mode", async () => {
    const authJsonPath = await subscriptionAuth();
    await writeFile(
      authJsonPath,
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "test-only-api-key",
        tokens: {}
      })
    );
    expect(() =>
      resolveRecordedCodexAuthentication(
        { KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH: authJsonPath },
        "subscription"
      )
    ).toThrow("does not contain subscription authentication");

    const privateAuth = await subscriptionAuth();
    if (process.platform !== "win32") {
      await chmod(privateAuth, 0o644);
      expect(() =>
        resolveRecordedCodexAuthentication(
          { KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH: privateAuth },
          "subscription"
        )
      ).toThrow("group or other users");
    }

    const target = await subscriptionAuth();
    const link = path.join(path.dirname(target), "linked-auth.json");
    await symlink(target, link);
    expect(() =>
      resolveRecordedCodexAuthentication(
        { KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH: link },
        "subscription"
      )
    ).toThrow("must not be a symbolic link");
  });

  it("reports missing and malformed subscription auth as prerequisite failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-codex-auth-"));
    expect(() =>
      resolveRecordedCodexAuthentication(
        {
          KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH: path.join(
            root,
            "missing.json"
          )
        },
        "subscription"
      )
    ).toThrow("could not be read");

    const authJsonPath = path.join(root, "auth.json");
    await writeFile(
      authJsonPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: []
      }),
      { mode: 0o600 }
    );
    expect(() =>
      resolveRecordedCodexAuthentication(
        { KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH: authJsonPath },
        "subscription"
      )
    ).toThrow("does not contain subscription authentication");
  });
});
