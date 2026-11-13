import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundAgentLaunchConfigurationStore } from "./launch-configuration.js";

const roots: string[] = [];

const createFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "koed-agent-config-")));
  roots.push(root);
  const bundlePath = join(root, "Koed.app");
  const koedHome = join(root, "koed-home");
  mkdirSync(bundlePath);
  mkdirSync(koedHome);
  return {
    root,
    bundlePath: realpathSync(resolve(bundlePath)),
    koedHome: realpathSync(resolve(koedHome)),
    store: createBackgroundAgentLaunchConfigurationStore({
      directoryPath: join(root, "desktop-user-data", "background-agent"),
      bundlePath
    })
  };
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("background-agent launch configuration", () => {
  it("persists the canonical bundle, KOED_HOME, and installation identity privately", () => {
    const fixture = createFixture();
    const configuration = {
      installationId: randomUUID(),
      bundlePath: fixture.bundlePath,
      koedHome: fixture.koedHome
    };

    fixture.store.write(configuration);

    expect(fixture.store.read()).toEqual({
      kind: "valid",
      configuration: { schemaVersion: 1, ...configuration }
    });
    expect(
      statSync(join(fixture.root, "desktop-user-data", "background-agent"))
        .mode & 0o777
    ).toBe(0o700);
    expect(statSync(fixture.store.filePath).mode & 0o777).toBe(0o600);
  });

  it("rejects a launch configuration from another app bundle", () => {
    const fixture = createFixture();
    const otherBundle = join(fixture.root, "Other.app");
    mkdirSync(otherBundle);

    expect(() =>
      fixture.store.write({
        installationId: randomUUID(),
        bundlePath: otherBundle,
        koedHome: fixture.koedHome
      })
    ).toThrow(/bundle/i);
    expect(fixture.store.read()).toEqual({ kind: "missing" });
  });

  it("fails closed when the launch config is replaced by a symlink", () => {
    const fixture = createFixture();
    const configuration = {
      installationId: randomUUID(),
      bundlePath: fixture.bundlePath,
      koedHome: fixture.koedHome
    };
    fixture.store.write(configuration);
    const malicious = join(fixture.root, "external-config.json");
    writeFileSync(malicious, JSON.stringify(configuration));
    unlinkSync(fixture.store.filePath);
    symlinkSync(malicious, fixture.store.filePath);

    expect(fixture.store.read()).toEqual({ kind: "invalid" });
  });
});
