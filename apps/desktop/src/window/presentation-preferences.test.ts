import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readPresentationPreferences,
  writePresentationPreferences
} from "./presentation-preferences.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("persists window preferences independently of backend acceleration", () => {
  const root = mkdtempSync(join(tmpdir(), "koed-presentation-"));
  roots.push(root);
  const file = join(root, "preferences.json");
  expect(readPresentationPreferences(file)).toEqual({
    graphicsAcceleration: true,
    showMenuBar: true,
    floatingKin: false,
    kinResolution: "max"
  });
  writeFileSync(
    file,
    JSON.stringify({ graphicsAcceleration: false, showMenuBar: false })
  );
  expect(readPresentationPreferences(file)).toEqual({
    graphicsAcceleration: false,
    showMenuBar: false,
    floatingKin: false,
    kinResolution: "max"
  });
  writePresentationPreferences(file, {
    graphicsAcceleration: true,
    showMenuBar: true,
    floatingKin: true,
    kinResolution: "balanced"
  });
  expect(readPresentationPreferences(file).floatingKin).toBe(true);
  expect(readPresentationPreferences(file).kinResolution).toBe("balanced");
  expect(statSync(file).mode & 0o077).toBe(0);
  writeFileSync(
    file,
    JSON.stringify({ floatingKin: "true", kinResolution: 160 })
  );
  expect(readPresentationPreferences(file).floatingKin).toBe(false);
  expect(readPresentationPreferences(file).kinResolution).toBe("max");
  writeFileSync(file, "invalid");
  expect(readPresentationPreferences(file)).toEqual({
    graphicsAcceleration: true,
    showMenuBar: true,
    floatingKin: false,
    kinResolution: "max"
  });
});
