import { describe, expect, it } from "vitest";

import { createPersonalDevicePairingInbox } from "./personal-device-pairing-inbox.js";

describe("Personal Device pairing inbox", () => {
  it("retains links until the renderer explicitly consumes them", () => {
    const inbox = createPersonalDevicePairingInbox();
    inbox.accept("link-a");
    inbox.accept("link-b");

    expect(inbox.consume("missing")).toBeNull();
    expect(inbox.consume("link-b")).toBe("link-b");
    expect(inbox.consume()).toBe("link-a");
    expect(inbox.consume()).toBeNull();
  });

  it("deduplicates links and bounds retained startup state", () => {
    const inbox = createPersonalDevicePairingInbox(2);
    inbox.accept("link-a");
    inbox.accept("link-b");
    inbox.accept("link-a");
    inbox.accept("link-c");

    expect(inbox.consume()).toBe("link-a");
    expect(inbox.consume()).toBe("link-c");
    expect(inbox.consume()).toBeNull();
  });
});
