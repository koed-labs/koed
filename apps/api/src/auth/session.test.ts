import type { FastifyRequest } from "fastify";
import type { MemorySourceRepository } from "@koed/db";
import { expect, it, vi } from "vitest";
import { createAuthHelpers } from "./session.js";

it("refreshes long-lived device authority on the same request after scope removal and revocation", async () => {
  const user = {
    id: "fixture-owner",
    email: "fixture@example.test",
    displayName: null
  };
  const getDeviceCredentialUser = vi
    .fn()
    .mockResolvedValueOnce({
      user,
      credential: { operationFamilies: ["managed_terminal"] }
    })
    .mockResolvedValueOnce({
      user,
      credential: { operationFamilies: ["managed_file_read"] }
    })
    .mockResolvedValueOnce(null);
  const auth = createAuthHelpers(
    () => ({ getDeviceCredentialUser }) as unknown as MemorySourceRepository,
    { hashSecret: (value) => `hashed:${value}`, cookieSecure: false }
  );
  const request = {
    headers: { authorization: "Koed-Device fixture:secret" },
    cookies: {}
  } as FastifyRequest;
  await expect(
    auth.authenticateSessionOrDeviceCredential(request, "managed_terminal")
  ).resolves.toEqual(user);
  await expect(
    auth.authenticateSessionOrDeviceCredential(request, "managed_terminal", {
      freshDeviceCredential: true
    })
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    auth.authenticateSessionOrDeviceCredential(request, "managed_terminal", {
      freshDeviceCredential: true
    })
  ).rejects.toMatchObject({ statusCode: 401 });
  expect(getDeviceCredentialUser).toHaveBeenCalledTimes(3);
});
