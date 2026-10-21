import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readManagedProjectRecallContext } from "../src/managed-project-recall-context.js";

describe("managed recall owner credential transport", () => {
  it.each([
    "http://remote.example.test:32123",
    "https://127.0.0.1:32123",
    "http://user:password@127.0.0.1:32123"
  ])(
    "rejects an unsafe endpoint before reading or sending the credential: %s",
    async (url) => {
      const send = vi.fn<typeof fetch>();
      await expect(
        readManagedProjectRecallContext(
          {
            executionId: randomUUID(),
            generation: 1,
            apiUrl: new URL(url),
            koedHome: "/nonexistent-local-credential-home"
          },
          send
        )
      ).rejects.toThrow("endpoint must be local HTTP");
      expect(send).not.toHaveBeenCalled();
    }
  );
});
