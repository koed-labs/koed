import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPersonalDeviceNames,
  writePersonalDeviceName
} from "./personal-device-names.js";

describe("local Personal Device nicknames", () => {
  it("persists pairing names and preserves edits when pairing finalization repeats", () => {
    const home = mkdtempSync(join(tmpdir(), "koed-device-names-"));
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    try {
      writePersonalDeviceName(home, id, "studio", true);
      expect(readPersonalDeviceNames(home)[id]).toBe("studio");
      writePersonalDeviceName(home, id, "  Office Mac  ");
      writePersonalDeviceName(home, id, "studio", true);
      expect(readPersonalDeviceNames(home)[id]).toBe("Office Mac");
      expect(
        statSync(join(home, "config", "personal-device-names.json")).mode &
          0o777
      ).toBe(0o600);
      expect(() => writePersonalDeviceName(home, id, "\n")).toThrow();
      expect(() => writePersonalDeviceName(home, "../other", "name")).toThrow();
      expect(readPersonalDeviceNames(home)[id]).toBe("Office Mac");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
