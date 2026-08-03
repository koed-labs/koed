import { parseCanonicalPdsJson } from "@koed/shared";
import { describe, expect, it } from "vitest";
import {
  pdsCanonicalRelayRecipients,
  pdsRedactedRelayReceipt,
  pdsRelayDeliveryRecipients
} from "./personal-device-sync-relay-repository.js";

describe("Personal Device Sync relay receipts", () => {
  it("serializes numeric audit fields as canonical decimal strings", () => {
    const receipt = pdsRedactedRelayReceipt({
      groupId: "group",
      transportId: "transport",
      packageId: "package",
      sourceManifestHash: "manifest",
      relayAcceptedAt: "2026-07-29T00:00:00.000Z",
      ciphertextBytes: "2048",
      recipientCount: 2
    });

    expect(parseCanonicalPdsJson(receipt)).toMatchObject({
      receiptVersion: "1",
      ciphertextBytes: "2048",
      recipientCount: "2"
    });
  });

  it("canonicalizes unordered database recipient IDs before snapshot checks", () => {
    expect(
      pdsCanonicalRelayRecipients(["z-device", "A-device", "a-device"])
    ).toEqual(["A-device", "a-device", "z-device"]);
  });

  it("delivers to peers without making the serving device ACK itself", () => {
    expect(
      pdsRelayDeliveryRecipients(
        ["device-a", "device-b", "device-c"],
        "device-b"
      )
    ).toEqual(["device-a", "device-c"]);
  });
});
