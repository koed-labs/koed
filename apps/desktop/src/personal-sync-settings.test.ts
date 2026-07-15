import { describe, expect, it } from "vitest";
import {
  personalSyncSettingsViewFrom,
  personalSyncStatusLabel,
  renderPersonalSyncSettings
} from "./personal-sync-settings.js";

const previous = {
  busy: false,
  detail: "old",
  status: "enabled" as const,
  devices: [],
  freshness: "old",
  groupId: null,
  pairing: null
};

describe("Personal Sync settings", () => {
  it("discloses replication boundary without secrets", () => {
    const html = renderPersonalSyncSettings({
      ...previous,
      detail: "redacted status",
      devices: [{ id: "device_one", label: "Laptop", state: "active" }],
      freshness: "2026-07-15T00:00:00.000Z",
      groupId: "group_one",
      pairing: { challengeId: "challenge_one", shortCode: "12345678" }
    });
    expect(personalSyncStatusLabel("enabled")).toBe("Syncing future Sessions");
    expect(html).toContain(
      "Every selected device receives decryptable Personal Memory"
    );
    expect(html).toContain("cannot erase plaintext already downloaded");
    expect(html).toContain('data-personal-sync-revoke="device_one"');
    expect(html).toContain("12345678");
    expect(html).not.toContain("API Token copy");
    expect(html).not.toContain("window.localStorage");
  });

  it("maps backend group and preserves safe pairing artifact", () => {
    const view = personalSyncSettingsViewFrom(
      {
        state: "backend",
        message: "Authority-owned status",
        groups: [
          {
            group_id: "group_one",
            policy: { enabled: true },
            members: [{ device_id: "device_one", state: "active" }]
          }
        ],
        pairing: { challengeId: "challenge_one", shortCode: "12345678" },
        secretRef: "must-not-be-rendered"
      },
      { ...previous, busy: true }
    );
    expect(view).toMatchObject({
      busy: true,
      status: "enabled",
      groupId: "group_one",
      devices: [{ id: "device_one", state: "active" }],
      pairing: { challengeId: "challenge_one", shortCode: "12345678" }
    });
    expect(renderPersonalSyncSettings(view)).not.toContain(
      "must-not-be-rendered"
    );
  });
});
