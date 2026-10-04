import { describe, expect, it, vi } from "vitest";
import type { HomeSnapshot } from "@koed/shared/home";
import { HomeFeedClient } from "./home-feed-client";

const item = {
  sourceEventId: "job:one",
  source: "personal_agent_job",
  sourceId: "job-one",
  sourceRevision: "2",
  kind: "approval",
  state: "blocked",
  title: "Approve the job",
  summary: "The Agent is waiting.",
  updatedAt: "2026-10-02T12:00:00.000Z",
  destination: {
    kind: "execution",
    executionId: "123e4567-e89b-42d3-a456-426614174000"
  }
} as const;

const snapshot: HomeSnapshot = {
  schemaVersion: "koed.home-feed/v1",
  accountScope: "owner-one",
  generatedAt: "2026-10-02T12:00:00.000Z",
  coverage: [
    { source: "managed_runtime_item", complete: true, nextCursor: null },
    { source: "personal_agent_job", complete: true, nextCursor: null },
    { source: "pull_request_review", complete: true, nextCursor: null }
  ],
  needsYou: [item],
  ongoing: [],
  recent: [],
  cleared: [],
  badgeCount: 1
};

describe("HomeFeedClient", () => {
  it("calls native fetch without using the client as its receiver", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async function (this: unknown, input: RequestInfo | URL) {
        if (this !== undefined && this !== globalThis)
          throw new TypeError("Illegal invocation");
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/access"))
          return Response.json({
            accountScope: "owner-one",
            backendId: "backend-one"
          });
        if (url === "/studio-api/github/session")
          return Response.json({ csrfToken: "csrf-one" });
        if (url.endsWith("/clear"))
          return Response.json({
            sourceEventId: item.sourceEventId,
            sourceRevision: item.sourceRevision,
            cleared: true
          });
        return Response.json(snapshot);
      }
    );
    try {
      const client = new HomeFeedClient("studio");
      await expect(client.getAccess()).resolves.toMatchObject({
        accountScope: "owner-one"
      });
      await expect(client.get()).resolves.toEqual(snapshot);
      await expect(client.setCleared(item, true)).resolves.toMatchObject({
        cleared: true
      });
      expect(calls).toEqual([
        "/studio-api/home-feed/access",
        "/studio-api/home-feed",
        "/studio-api/github/session",
        "/studio-api/home-feed/reminders/job%3Aone/clear"
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("validates the shared contract and uses the native proxy", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HomeFeedClient("studio", async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json(snapshot);
    });

    expect(await client.get()).toEqual(snapshot);
    expect(calls[0]?.url).toBe("/studio-api/home-feed");
    expect(calls[0]?.init?.cache).toBe("no-store");
  });

  it("reads the verified owner scope before allowing stale rows to remain visible", async () => {
    const calls: string[] = [];
    const client = new HomeFeedClient("studio", async (input) => {
      calls.push(String(input));
      return Response.json({
        accountScope: "owner-one",
        backendId: "backend-one"
      });
    });

    await expect(client.getAccess()).resolves.toEqual({
      accountScope: "owner-one",
      backendId: "backend-one"
    });
    expect(calls).toEqual(["/studio-api/home-feed/access"]);
  });

  it("requests the next page with the source-owned cursor", async () => {
    const calls: string[] = [];
    const client = new HomeFeedClient("hosted", async (input) => {
      calls.push(String(input));
      return Response.json(snapshot);
    });

    await client.get({
      source: "managed_execution",
      cursor: "cursor one",
      limit: 100
    });
    expect(calls[0]).toBe(
      "/v1/home?source=managed_execution&cursor=cursor+one&limit=100"
    );
  });

  it("native reminder mutations obtain CSRF and send the source revision", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HomeFeedClient("studio", async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/studio-api/github/session")
        return Response.json({ csrfToken: "csrf-one" });
      return Response.json({
        sourceEventId: item.sourceEventId,
        sourceRevision: item.sourceRevision,
        cleared: true
      });
    });

    await client.setCleared(item, true);
    expect(calls.map((call) => call.url)).toEqual([
      "/studio-api/github/session",
      "/studio-api/home-feed/reminders/job%3Aone/clear"
    ]);
    expect(new Headers(calls[1]?.init?.headers).get("x-studio-csrf")).toBe(
      "csrf-one"
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      sourceRevision: "2"
    });
  });

  it("hosted reminder mutations use the hosted cookie route without native CSRF", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HomeFeedClient("hosted", async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({
        sourceEventId: item.sourceEventId,
        sourceRevision: item.sourceRevision,
        cleared: String(input).endsWith("/clear")
      });
    });

    await client.setCleared(item, false);
    expect(calls[0]?.url).toBe("/v1/home/reminders/job%3Aone/restore");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(new Headers(calls[0]?.init?.headers).has("x-studio-csrf")).toBe(
      false
    );
  });
});
