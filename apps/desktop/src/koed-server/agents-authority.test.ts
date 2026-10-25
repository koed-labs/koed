import { describe, expect, it, vi } from "vitest";
import { createAgentsAuthorityResolver } from "./agents-authority.js";

describe("HQ Agent authority", () => {
  it("reuses endpoint discovery but rechecks credentials and invalidates on runtime change", async () => {
    let revision = "runtime-one";
    let credential = { ownerUserId: "owner", authorization: "credential-one" };
    const discover = vi.fn(async () => ({
      apiOrigin:
        revision === "runtime-one"
          ? "http://127.0.0.1:3300"
          : "http://127.0.0.1:3301",
      authorization: credential.authorization
    }));
    const resolve = createAgentsAuthorityResolver({
      revision: () => revision,
      credential: () => credential,
      discover
    });
    const first = await resolve();
    expect((await resolve()).key).toBe(first.key);
    expect(discover).toHaveBeenCalledTimes(1);
    credential = {
      ownerUserId: "other-owner",
      authorization: "credential-two"
    };
    const changed = await resolve();
    expect(changed.ownerId).toBe("other-owner");
    expect(changed.key).not.toBe(first.key);
    revision = "runtime-two";
    expect((await resolve()).apiOrigin).toBe("http://127.0.0.1:3301");
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("rejects a credential switch or a revision change during discovery", async () => {
    for (const change of ["credential", "revision"]) {
      let revision = "runtime-one";
      let credential = { ownerUserId: "owner", authorization: "before" };
      const resolve = createAgentsAuthorityResolver({
        revision: () => revision,
        credential: () => credential,
        discover: async () => {
          if (change === "credential")
            credential = { ownerUserId: "other", authorization: "after" };
          else revision = "runtime-two";
          return {
            apiOrigin: "http://127.0.0.1:3300",
            authorization: "before"
          };
        }
      });
      await expect(resolve()).rejects.toThrow("profile changed");
    }
  });

  it("never reuses authority after credentials are removed", async () => {
    let present = true;
    const resolve = createAgentsAuthorityResolver({
      revision: () => "one",
      credential: () =>
        present ? { ownerUserId: "owner", authorization: "one" } : null,
      discover: async () => ({
        apiOrigin: "http://127.0.0.1:3300",
        authorization: "one"
      })
    });
    await resolve();
    present = false;
    await expect(resolve()).rejects.toThrow("unavailable");
  });
});
