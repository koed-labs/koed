import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { resolveAccountConfig } from "@koed-labs/shared/account";
import {
  desktopAccountBuildConfig,
  prepareDesktopAccountConfig
} from "./prepare-account-config.mjs";
import { verifyPackagedAccountConfig } from "./verify-packaged-account-config.mjs";

const scratch = resolve(import.meta.dirname, "../../../scratch");
const production = {
  KOED_ACCOUNT_ENABLED: "true",
  KOED_ACCOUNT_CLIENT_ID: "client_productionfixture",
  KOED_ACCOUNT_ENVIRONMENT: "production",
  KOED_ACCOUNT_LOGIN_MODE: "forwarder",
  KOED_ACCOUNT_FORWARDER_URL: "https://release.example.test/desktop/callback"
};
function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "account-packaging-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appDirectory = resolve(root, "app");
  mkdirSync(appDirectory);
  writeFileSync(
    resolve(appDirectory, "account-config.json"),
    '{"enabled":false}\n'
  );
  return {
    root,
    appDirectory,
    output: resolve(appDirectory, ".account-build/account-config.json")
  };
}
test("source and local packages default off without credentials or changing the source file", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    prepareDesktopAccountConfig({
      appDirectory: f.appDirectory,
      environment: {}
    }),
    { enabled: false }
  );
  assert.deepEqual(JSON.parse(readFileSync(f.output, "utf8")), {
    enabled: false
  });
  assert.equal(
    readFileSync(resolve(f.appDirectory, "account-config.json"), "utf8"),
    '{"enabled":false}\n'
  );
  assert.deepEqual(
    desktopAccountBuildConfig({
      appDirectory: f.appDirectory,
      release: true,
      environment: {
        KOED_ACCOUNT_ENABLED: "false",
        WORKOS_API_KEY: "synthetic-never-copy"
      }
    }),
    { enabled: false }
  );
});
test("developer overrides opt in to staging without editing public defaults", (t) => {
  const f = fixture(t);
  const result = prepareDesktopAccountConfig({
    appDirectory: f.appDirectory,
    environment: {
      ...production,
      KOED_ACCOUNT_ENVIRONMENT: "staging",
      KOED_ACCOUNT_LOGIN_MODE: "forwarder"
    }
  });
  assert.equal(result.enabled, true);
  assert.equal(result.environment, "staging");
  assert.equal(result.loginMode, "forwarder");
});
test("auth-enabled production output is public-only and restores without a shell environment", (t) => {
  const f = fixture(t);
  prepareDesktopAccountConfig({
    appDirectory: f.appDirectory,
    environment: {
      ...production,
      WORKOS_API_KEY: "synthetic-never-copy",
      CF_WORKER_API_KEY: "synthetic-never-copy"
    },
    release: true
  });
  const text = readFileSync(f.output, "utf8");
  assert.doesNotMatch(text, /synthetic-never-copy|API_KEY/);
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value).sort(), [
    "clientId",
    "enabled",
    "environment",
    "forwarderUrl",
    "loginMode"
  ]);
  const sessionConfig = resolveAccountConfig({
    KOED_ACCOUNT_ENABLED: String(value.enabled),
    KOED_ACCOUNT_CLIENT_ID: value.clientId,
    KOED_ACCOUNT_ENVIRONMENT: value.environment,
    KOED_ACCOUNT_LOGIN_MODE: value.loginMode,
    KOED_ACCOUNT_FORWARDER_URL: value.forwarderUrl
  });
  assert.equal(sessionConfig.callbackUri, "ai.koed.desktop.auth://callback");
  assert.equal(
    sessionConfig.redirectUri,
    production.KOED_ACCOUNT_FORWARDER_URL
  );
  assert.deepEqual(
    desktopAccountBuildConfig({
      appDirectory: f.appDirectory,
      environment: { ...production, KOED_ACCOUNT_LOGIN_MODE: "direct" },
      release: true
    }),
    {
      enabled: true,
      clientId: value.clientId,
      environment: value.environment,
      loginMode: "direct"
    }
  );
});
test("enabled releases reject missing, staging and unsupported settings; failed prep removes stale output", (t) => {
  const f = fixture(t);
  for (const environment of [
    {},
    { ...production, KOED_ACCOUNT_ENABLED: "TRUE" },
    { ...production, KOED_ACCOUNT_CLIENT_ID: undefined },
    { ...production, KOED_ACCOUNT_CLIENT_ID: "not-a-client" },
    { ...production, KOED_ACCOUNT_CLIENT_ID: "client_bad\nvalue" },
    { ...production, KOED_ACCOUNT_ENVIRONMENT: "staging" },
    { ...production, KOED_ACCOUNT_ENVIRONMENT: undefined },
    { ...production, KOED_ACCOUNT_LOGIN_MODE: undefined },
    { ...production, KOED_ACCOUNT_FORWARDER_URL: undefined },
    { ...production, KOED_ACCOUNT_FORWARDER_URL: "" },
    {
      ...production,
      KOED_ACCOUNT_FORWARDER_URL: "http://release.example.test/desktop/callback"
    },
    {
      ...production,
      KOED_ACCOUNT_FORWARDER_URL:
        "https://operator:secret@release.example.test/desktop/callback"
    },
    {
      ...production,
      KOED_ACCOUNT_FORWARDER_URL:
        "https://release.example.test/desktop/callback?next=elsewhere"
    },
    {
      ...production,
      KOED_ACCOUNT_FORWARDER_URL:
        "https://release.example.test/desktop/callback#fragment"
    },
    {
      ...production,
      KOED_ACCOUNT_FORWARDER_URL: "https://release.example.test/other"
    },
    {
      ...production,
      KOED_ACCOUNT_LOGIN_MODE: "https://untrusted.example/callback"
    }
  ]) {
    mkdirSync(resolve(f.appDirectory, ".account-build"), { recursive: true });
    writeFileSync(f.output, JSON.stringify({ enabled: true }));
    assert.throws(() =>
      prepareDesktopAccountConfig({
        appDirectory: f.appDirectory,
        environment,
        release: true
      })
    );
    assert.equal(existsSync(f.output), false);
  }
  writeFileSync(
    resolve(f.appDirectory, "account-config.json"),
    JSON.stringify({
      enabled: true,
      clientId: "client_stagingfixture",
      environment: "staging",
      loginMode: "forwarder"
    })
  );
  assert.throws(() =>
    desktopAccountBuildConfig({
      appDirectory: f.appDirectory,
      environment: { KOED_ACCOUNT_ENABLED: "true" },
      release: true
    })
  );
});
test("rejects malformed or secret-bearing input without printing rejected values", (t) => {
  const f = fixture(t);
  for (const text of [
    "{",
    " ".repeat(4097),
    '{"enabled":false,"apiKey":"synthetic-secret"}'
  ]) {
    writeFileSync(resolve(f.appDirectory, "account-config.json"), text);
    assert.throws(
      () =>
        prepareDesktopAccountConfig({
          appDirectory: f.appDirectory,
          environment: {}
        }),
      (error) =>
        !error.message.includes("synthetic-secret") &&
        /Invalid public/.test(error.message)
    );
  }
});
test("inspects ASAR config for disabled and production builds and rejects missing, stale or secret-bearing copies", async (t) => {
  const f = fixture(t);
  const packaged = resolve(f.root, "packaged");
  mkdirSync(packaged);
  writeFileSync(resolve(packaged, "package.json"), "{}");
  const asar = resolve(f.root, "app.asar");
  for (const environment of [{ KOED_ACCOUNT_ENABLED: "false" }, production]) {
    const expected = prepareDesktopAccountConfig({
      appDirectory: f.appDirectory,
      environment,
      release: true
    });
    writeFileSync(
      resolve(packaged, "account-config.json"),
      JSON.stringify(expected)
    );
    await createPackage(packaged, asar);
    assert.deepEqual(
      verifyPackagedAccountConfig(asar, {
        appDirectory: f.appDirectory,
        environment
      }),
      expected
    );
  }
  for (const value of [
    { enabled: false },
    {
      enabled: true,
      clientId: production.KOED_ACCOUNT_CLIENT_ID,
      environment: "production",
      loginMode: "forwarder"
    },
    {
      enabled: true,
      clientId: production.KOED_ACCOUNT_CLIENT_ID,
      environment: "production",
      loginMode: "forwarder",
      forwarderUrl: "https://stale.example.test/desktop/callback"
    },
    {
      enabled: true,
      clientId: production.KOED_ACCOUNT_CLIENT_ID,
      environment: "production",
      loginMode: "forwarder",
      forwarderUrl: "http://release.example.test/desktop/callback"
    },
    {
      enabled: true,
      environment: "production",
      clientId: production.KOED_ACCOUNT_CLIENT_ID,
      loginMode: "direct"
    },
    {
      enabled: true,
      environment: "staging",
      clientId: "client_stagingfixture",
      loginMode: "direct"
    },
    {
      enabled: true,
      environment: "production",
      clientId: "client_wrongfixture",
      loginMode: "direct"
    },
    { enabled: true, apiKey: "synthetic-secret" }
  ]) {
    writeFileSync(
      resolve(packaged, "account-config.json"),
      JSON.stringify(value)
    );
    await createPackage(packaged, asar);
    assert.throws(() =>
      verifyPackagedAccountConfig(asar, {
        appDirectory: f.appDirectory,
        environment: production
      })
    );
  }
  rmSync(resolve(packaged, "account-config.json"));
  await createPackage(packaged, asar);
  assert.throws(() =>
    verifyPackagedAccountConfig(asar, {
      appDirectory: f.appDirectory,
      environment: production
    })
  );
});
