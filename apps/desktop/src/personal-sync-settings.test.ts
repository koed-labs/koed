import { describe, expect, it } from "vitest";
import {
  personalSyncSettingsViewFrom,
  personalSyncStatusLabel,
  renderPersonalSyncSettings
} from "./personal-sync-settings.js";

describe("Personal Sync settings", () => {
  it("discloses full replication and revocation boundary without secrets", () => {
    const html = renderPersonalSyncSettings({
      busy: false,
      detail: "redacted status",
      status: "enabled",
      devices: [{ id: "device_one", label: "Laptop", state: "active" }],
      freshness: "2026-07-15T00:00:00.000Z"
    });
    expect(personalSyncStatusLabel("enabled")).toBe("Syncing future Sessions");
    expect(html).toContain(
      "Every selected device receives decryptable Personal Memory"
    );
    expect(html).toContain("cannot erase plaintext already downloaded");
    expect(html).toContain("future closed Sessions");
    expect(html).toContain('data-personal-sync-revoke="device_one"');
    expect(html).toContain('aria-label="Revoke Laptop"');
    expect(html).not.toContain("API Token copy");
    expect(html).not.toContain("window.localStorage");
  });

  it("maps only redacted status fields and preserves busy state", () => {
    const view = personalSyncSettingsViewFrom(
      {
        state: "paused",
        message: "Publication paused",
        devices: [
          { id: "device_one", label: "Laptop", state: "active" },
          { id: 42, state: "active" }
        ],
        replica: { lastSuccessfulSyncAt: "2026-07-15T00:00:00.000Z" },
        secretRef: "must-not-be-rendered"
      },
      {
        busy: true,
        detail: "old",
        status: "enabled",
        devices: [],
        freshness: "old"
      }
    );
    expect(view).toEqual({
      busy: true,
      detail: "Publication paused",
      status: "paused",
      devices: [{ id: "device_one", label: "Laptop", state: "active" }],
      freshness: "2026-07-15T00:00:00.000Z"
    });
    expect(renderPersonalSyncSettings(view)).not.toContain(
      "must-not-be-rendered"
    );
  });
});
