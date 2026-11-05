import { describe, expect, it, vi } from "vitest";

import { createManagedConversationServiceForWorker } from "./managed-conversation-availability.js";

describe("managed Conversation worker availability", () => {
  it("does not construct the coordinator or resolve its prerequisites", async () => {
    const create = vi.fn(async () => ({ start: vi.fn(), stop: vi.fn() }));

    expect(await createManagedConversationServiceForWorker(create)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
