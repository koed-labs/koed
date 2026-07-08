import { describe, expect, it } from "vitest";
import { createWorkosAuthKitClient } from "./workos.js";

describe("createWorkosAuthKitClient", () => {
  const config = {
    apiBaseUrl: "https://workos.example.test",
    clientId: "client_test",
    clientSecret: "secret_test",
    redirectUri: "https://koed.example.test/auth/workos/callback"
  };

  it("normalizes invalid WorkOS authentication responses into upstream errors", async () => {
    const client = createWorkosAuthKitClient(config, async () => {
      return new Response(JSON.stringify({ user: { id: "missing-email" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await expect(
      client.authenticateWithCode({ code: "auth-code" })
    ).rejects.toMatchObject({
      message: "Invalid WorkOS authentication response",
      statusCode: 502
    });
  });
});
