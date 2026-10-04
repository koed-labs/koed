import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPersonalRemovals,
  setPersonalRemoval
} from "./personal-removals-client";

afterEach(() => vi.unstubAllGlobals());

describe("Personal Studio removals client", () => {
  it("loads local CSRF session then sends an authenticated gateway PUT", async () => {
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return calls.length === 1
        ? Response.json({ csrfToken: "csrf-local" })
        : Response.json({ ok: true });
    };

    await setPersonalRemoval(
      { kind: "project", projectId: "project-1" },
      true,
      fetcher
    );

    expect(calls.map((call) => call.input)).toEqual([
      "/studio-api/github/session",
      "/studio-api/personal-removals"
    ]);
    expect(calls[0]?.init).toMatchObject({
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" }
    });
    const write = calls[1]?.init;
    expect(write).toMatchObject({
      method: "PUT",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({
        kind: "project",
        id: "project-1",
        aliases: [],
        removed: true
      })
    });
    expect(new Headers(write?.headers).get("x-studio-csrf")).toBe("csrf-local");
  });

  it("uses the hosted API route without a local gateway session request", async () => {
    vi.stubGlobal("window", {
      location: { pathname: "/studio/projects" }
    });
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({ ok: true });
    };

    await setPersonalRemoval(
      { kind: "conversation", sourceId: "managed:job-1" },
      false,
      fetcher
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/v1/studio/personal-removals");
    expect(new Headers(calls[0]?.init?.headers).has("x-studio-csrf")).toBe(
      false
    );
    expect(calls[0]?.init).toMatchObject({
      credentials: "include",
      cache: "no-store",
      redirect: "error"
    });
  });

  it("does not send a local write when session token loading fails", async () => {
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const fetcher: typeof fetch = vi.fn(async () =>
      Response.json({ error: "unavailable" }, { status: 503 })
    );

    await expect(
      setPersonalRemoval(
        { kind: "conversation", sourceId: "codex:thread-1" },
        true,
        fetcher
      )
    ).rejects.toThrow("Studio session is unavailable.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/studio-api/github/session",
      expect.objectContaining({ cache: "no-store", redirect: "error" })
    );
  });

  it("reads the correct catalog route with no-store credentials", async () => {
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const fetcher: typeof fetch = vi.fn(async () =>
      Response.json({
        removals: [
          {
            kind: "conversation",
            id: "managed:job-1",
            aliases: ["codex:native%2Fthread-1"]
          }
        ]
      })
    );

    await expect(listPersonalRemovals(fetcher)).resolves.toEqual([
      {
        kind: "conversation",
        sourceId: "managed:job-1",
        aliases: ["codex:native%2Fthread-1"]
      }
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "/studio-api/personal-removals",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error"
      })
    );
  });
});
