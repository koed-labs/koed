import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountConfig,
  packagedAccountConfig,
  desktopAccountEnvironment
} from "./config.js";
const FORWARDER_URL = "https://login.example.test/desktop/callback";
let directory: string;
const scratch = resolve(import.meta.dirname, "../../../../scratch");
beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  directory = mkdtempSync(resolve(scratch, "account-config-"));
});

describe("source Desktop account environment", () => {
  const rootConfig = [
    "# Public developer settings",
    'DESKTOP_ACCOUNT_ENABLED="true"',
    "DESKTOP_ACCOUNT_CLIENT_ID='client_rootfixture'",
    "DESKTOP_ACCOUNT_ENVIRONMENT=staging # staging only",
    "DESKTOP_ACCOUNT_LOGIN_MODE=forwarder",
    `DESKTOP_ACCOUNT_FORWARDER_URL="${FORWARDER_URL}"`,
    "WORKOS_API_KEY=synthetic-secret",
    "DESKTOP_ACCOUNT_API_KEY=synthetic-secret",
    "NODE_OPTIONS=synthetic-never-load"
  ].join("\n");
  const load = (environment: NodeJS.ProcessEnv = {}, packaged = false) =>
    desktopAccountEnvironment({
      repoRoot: directory,
      packaged,
      environment
    });

  it("maps quoted prefixed root settings and ignores unrelated values without mutating the process", () => {
    writeFileSync(join(directory, ".env"), rootConfig);
    const environment = { EXISTING_VALUE: "preserved" };
    const result = load(environment);
    expect(result).toEqual({
      ...environment,
      KOED_ACCOUNT_ENABLED: "true",
      KOED_ACCOUNT_CLIENT_ID: "client_rootfixture",
      KOED_ACCOUNT_ENVIRONMENT: "staging",
      KOED_ACCOUNT_LOGIN_MODE: "forwarder",
      KOED_ACCOUNT_FORWARDER_URL: FORWARDER_URL
    });
    expect(environment).toEqual({ EXISTING_VALUE: "preserved" });
    expect(accountConfig(result)).toMatchObject({
      clientId: "client_rootfixture",
      loginMode: "forwarder"
    });
  });
  it("gives canonical shell settings precedence over prefixed shell settings and root values", () => {
    writeFileSync(join(directory, ".env"), rootConfig);
    expect(
      accountConfig(
        load({ KOED_ACCOUNT_ENABLED: "false", DESKTOP_ACCOUNT_ENABLED: "true" })
      )
    ).toBeNull();
    expect(
      accountConfig(load({ DESKTOP_ACCOUNT_ENABLED: "false" }))
    ).toBeNull();
    expect(
      accountConfig(load({ DESKTOP_ACCOUNT_CLIENT_ID: "client_shellfixture" }))
        ?.clientId
    ).toBe("client_shellfixture");
    expect(
      accountConfig(
        load({
          KOED_ACCOUNT_CLIENT_ID: "client_canonicalfixture",
          DESKTOP_ACCOUNT_CLIENT_ID: "client_shellfixture"
        })
      )?.clientId
    ).toBe("client_canonicalfixture");
    expect(
      accountConfig(
        load({
          DESKTOP_ACCOUNT_FORWARDER_URL:
            "https://shell.example.test/desktop/callback",
          KOED_ACCOUNT_FORWARDER_URL:
            "https://canonical.example.test/desktop/callback"
        })
      )?.redirectUri
    ).toBe("https://canonical.example.test/desktop/callback");
  });
  it("supports an explicit source env path and leaves missing files optional", () => {
    expect(accountConfig(load())).toBeNull();
    writeFileSync(join(directory, ".env"), "DESKTOP_ACCOUNT_ENABLED=false\n");
    const path = join(directory, "developer.env");
    writeFileSync(path, rootConfig);
    expect(accountConfig(load({ KOED_ENV_PATH: path }))).not.toBeNull();
    expect(
      accountConfig(load({ KOED_ENV_PATH: join(directory, "absent.env") }))
    ).toBeNull();
  });
  it("never imports checkout or explicit env-file settings into packaged execution", () => {
    writeFileSync(join(directory, ".env"), rootConfig);
    const environment = { KOED_ENV_PATH: join(directory, ".env") };
    expect(load(environment, true)).toBe(environment);
    const configFile = join(directory, "account-config.json");
    writeFileSync(configFile, JSON.stringify({ enabled: false }));
    expect(
      packagedAccountConfig(configFile, load(environment, true))
    ).toBeNull();
    writeFileSync(
      configFile,
      JSON.stringify({
        enabled: true,
        environment: "production",
        clientId: "client_productionfixture",
        loginMode: "direct"
      })
    );
    expect(
      packagedAccountConfig(configFile, load(environment, true))
    ).toMatchObject({
      environment: "production",
      clientId: "client_productionfixture"
    });
  });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
describe("packaged public account configuration", () => {
  it("ships disabled source defaults and allows explicit staging overrides", () => {
    const file = resolve(import.meta.dirname, "../../account-config.json");
    expect(packagedAccountConfig(file, {})).toBeNull();
    expect(
      packagedAccountConfig(
        file,
        {
          KOED_ACCOUNT_ENABLED: "true",
          KOED_ACCOUNT_CLIENT_ID: "client_stagingfixture",
          KOED_ACCOUNT_ENVIRONMENT: "staging",
          KOED_ACCOUNT_LOGIN_MODE: "forwarder",
          KOED_ACCOUNT_FORWARDER_URL: FORWARDER_URL
        },
        { packaged: false }
      )
    ).toMatchObject({ environment: "staging", loginMode: "forwarder" });
  });
  it("supports Finder launches with public packaged defaults and explicit disablement", () => {
    const file = join(directory, "account-config.json");
    writeFileSync(
      file,
      JSON.stringify({
        enabled: true,
        clientId: "client_test",
        environment: "production"
      })
    );
    expect(packagedAccountConfig(file, {})).toMatchObject({
      clientId: "client_test",
      loginMode: "direct",
      redirectUri: "ai.koed.desktop.auth://callback",
      callbackUri: "ai.koed.desktop.auth://callback"
    });
    expect(
      packagedAccountConfig(file, { KOED_ACCOUNT_ENABLED: "false" })
    ).toBeNull();
  });
  it("uses a configured HTTPS staging redirect while keeping the native callback and direct mode", () => {
    const file = join(directory, "account-config.json");
    writeFileSync(
      file,
      JSON.stringify({
        enabled: true,
        clientId: "client_test",
        environment: "staging",
        loginMode: "forwarder",
        forwarderUrl: FORWARDER_URL
      })
    );
    expect(packagedAccountConfig(file, {})).toEqual({
      clientId: "client_test",
      environment: "staging",
      loginMode: "forwarder",
      redirectUri: FORWARDER_URL,
      callbackUri: "ai.koed.desktop.auth.dev://callback"
    });
    expect(
      packagedAccountConfig(file, { KOED_ACCOUNT_LOGIN_MODE: "direct" })
    ).toMatchObject({
      loginMode: "direct",
      redirectUri: "ai.koed.desktop.auth.dev://callback"
    });
  });
  it("bundles the configured production URL and ignores a runtime forwarder override", () => {
    const file = join(directory, "account-config.json");
    writeFileSync(
      file,
      JSON.stringify({
        enabled: true,
        clientId: "client_productionfixture",
        environment: "production",
        loginMode: "forwarder",
        forwarderUrl: FORWARDER_URL
      })
    );
    expect(packagedAccountConfig(file, {})).toEqual({
      clientId: "client_productionfixture",
      environment: "production",
      loginMode: "forwarder",
      redirectUri: FORWARDER_URL,
      callbackUri: "ai.koed.desktop.auth://callback"
    });
    expect(
      packagedAccountConfig(
        file,
        {
          KOED_ACCOUNT_FORWARDER_URL:
            "https://runtime.example.test/desktop/callback"
        },
        { packaged: true }
      )?.redirectUri
    ).toBe(FORWARDER_URL);
    expect(
      packagedAccountConfig(
        file,
        {
          KOED_ACCOUNT_FORWARDER_URL:
            "https://source.example.test/desktop/callback"
        },
        { packaged: false }
      )?.redirectUri
    ).toBe("https://source.example.test/desktop/callback");
    expect(
      packagedAccountConfig(file, { KOED_ACCOUNT_LOGIN_MODE: "direct" })
    ).toMatchObject({
      loginMode: "direct",
      redirectUri: "ai.koed.desktop.auth://callback",
      callbackUri: "ai.koed.desktop.auth://callback"
    });
  });
  it("rejects unknown forwarder environments and unsupported login modes", () => {
    for (const environment of ["preview", "constructor", "toString"]) {
      expect(
        accountConfig({
          KOED_ACCOUNT_ENABLED: "true",
          KOED_ACCOUNT_CLIENT_ID: "client_test",
          KOED_ACCOUNT_ENVIRONMENT: environment,
          KOED_ACCOUNT_LOGIN_MODE: "forwarder",
          KOED_ACCOUNT_FORWARDER_URL: FORWARDER_URL
        })
      ).toBeNull();
    }
    expect(
      accountConfig({
        KOED_ACCOUNT_ENABLED: "true",
        KOED_ACCOUNT_CLIENT_ID: "client_test",
        KOED_ACCOUNT_ENVIRONMENT: "staging",
        KOED_ACCOUNT_LOGIN_MODE: "https://attacker.test"
      })
    ).toBeNull();
  });
  it.each([
    undefined,
    "",
    "not-a-url",
    "http://login.example.test/desktop/callback",
    "javascript:alert(1)",
    "ai.koed.desktop.auth.dev://callback",
    "https://operator:secret@login.example.test/desktop/callback",
    "https://@login.example.test/desktop/callback",
    "https://login.example.test:8443/desktop/callback",
    "https://login.example.test:443/desktop/callback",
    "https://login.example.test/other",
    "https://login.example.test/desktop/callback/",
    "https://login.example.test/desktop/callback?next=elsewhere",
    "https://login.example.test/desktop/callback?",
    "https://login.example.test/desktop/callback#fragment",
    "https://login.example.test/desktop/callback#",
    "https://login.example.test/desktop/../desktop/callback",
    "https://LOGIN.example.test/desktop/callback",
    "https://login.example.test/desktop/call\tback",
    `https://${"a".repeat(2048)}.test/desktop/callback`
  ])("rejects missing, unsafe or noncanonical forwarder URL %#", (url) => {
    const environment = {
      KOED_ACCOUNT_ENABLED: "true",
      KOED_ACCOUNT_CLIENT_ID: "client_test",
      KOED_ACCOUNT_ENVIRONMENT: "staging",
      KOED_ACCOUNT_LOGIN_MODE: "forwarder",
      KOED_ACCOUNT_FORWARDER_URL: url
    };
    expect(accountConfig(environment)).toBeNull();
    // Direct mode does not depend on a forwarder, including during recovery.
    expect(
      accountConfig({ ...environment, KOED_ACCOUNT_LOGIN_MODE: "direct" })
    ).toMatchObject({ redirectUri: "ai.koed.desktop.auth.dev://callback" });
  });
  it("cannot supply a missing or invalid packaged forwarder through the runtime environment", () => {
    const file = join(directory, "account-config.json");
    const override = {
      KOED_ACCOUNT_ENABLED: "true",
      KOED_ACCOUNT_CLIENT_ID: "client_test",
      KOED_ACCOUNT_ENVIRONMENT: "production",
      KOED_ACCOUNT_LOGIN_MODE: "forwarder",
      KOED_ACCOUNT_FORWARDER_URL: FORWARDER_URL
    };
    for (const raw of [
      JSON.stringify({ enabled: false }),
      JSON.stringify({
        enabled: true,
        clientId: "client_test",
        environment: "production",
        loginMode: "forwarder"
      }),
      JSON.stringify({
        enabled: true,
        forwarderUrl: "https://login.example.test/other"
      }),
      " ".repeat(4097),
      "{"
    ]) {
      writeFileSync(file, raw);
      expect(
        packagedAccountConfig(file, override, { packaged: true })
      ).toBeNull();
    }
  });
  it("leaves accounts unavailable for malformed or secret-bearing files", () => {
    const file = join(directory, "account-config.json");
    for (const raw of [
      "{",
      JSON.stringify({ enabled: true, apiKey: "must-not-be-packaged" }),
      JSON.stringify({ enabled: true, loginMode: "other" }),
      JSON.stringify({ enabled: true, redirectUri: "https://attacker.test" })
    ]) {
      writeFileSync(file, raw);
      expect(packagedAccountConfig(file, {})).toBeNull();
    }
  });
});
