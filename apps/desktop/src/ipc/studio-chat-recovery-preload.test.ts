import { describe, expect, it, vi } from "vitest";

import { createStudioChatRecoveryPreloadApi } from "./studio-chat-recovery-preload.js";
import { studioChatRecoveryCommandChannel } from "./studio-chat-recovery-protocol.js";

describe("Studio chat recovery preload bridge", () => {
  it("uses the Studio scoped channel and preserves string values", async () => {
    const invoke = vi.fn(async (_channel: string, request: any) =>
      request.operation === "read"
        ? { operation: "read", value: "{\"pending\":[]}" }
        : { operation: request.operation, ok: true }
    );
    const api = createStudioChatRecoveryPreloadApi(invoke);
    const identity = { ownerId: "owner-one", executionId: "execution-one" };

    await expect(api.read(identity)).resolves.toBe('{"pending":[]}');
    await expect(
      api.write({ ...identity, value: "{\"pending\":[1]}" })
    ).resolves.toBeUndefined();
    await expect(api.delete(identity)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenNthCalledWith(1, studioChatRecoveryCommandChannel, {
      operation: "read",
      ...identity
    });
    expect(invoke).toHaveBeenNthCalledWith(2, studioChatRecoveryCommandChannel, {
      operation: "write",
      ...identity,
      value: "{\"pending\":[1]}"
    });
  });
});
