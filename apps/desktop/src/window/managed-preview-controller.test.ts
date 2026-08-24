import { describe, expect, it } from "vitest";

import { isAllowedManagedPreviewRequest } from "./managed-preview-controller.js";

describe("managed preview network isolation", () => {
  const origin = "http://127.0.0.1:5173";

  it("allows only the verified origin and its hot-reload websocket", () => {
    expect(
      isAllowedManagedPreviewRequest(
        origin,
        `${origin}/assets/app.js`,
        "script"
      )
    ).toBe(true);
    expect(
      isAllowedManagedPreviewRequest(
        origin,
        "ws://127.0.0.1:5173/hmr",
        "webSocket"
      )
    ).toBe(true);
    expect(
      isAllowedManagedPreviewRequest(
        origin,
        "http://127.0.0.1:3300/v1/users/me",
        "xhr"
      )
    ).toBe(false);
    expect(
      isAllowedManagedPreviewRequest(
        origin,
        "http://169.254.169.254/latest/meta-data",
        "xhr"
      )
    ).toBe(false);
    expect(
      isAllowedManagedPreviewRequest(origin, "file:///etc/passwd", "xhr")
    ).toBe(false);
  });

  it("permits inert inline subresources but not top-level inline navigation", () => {
    expect(
      isAllowedManagedPreviewRequest(
        origin,
        "data:image/png;base64,AA==",
        "image"
      )
    ).toBe(true);
    expect(
      isAllowedManagedPreviewRequest(origin, "data:text/html,test", "mainFrame")
    ).toBe(false);
  });
});
