import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import {
  ackLinkedTeamCatchUp,
  readLinkedTeamCatchUp
} from "./team-catch-up.js";

vi.mock("@koed/shared", async (original) => ({
  ...(await original<typeof import("@koed/shared")>()),
  verifyLocalEdgeClientCredentialAuthorization: (
    _home: string,
    header: string | undefined,
    binding: { backendId: string; operationFamily: string }
  ) =>
    header === "Koed-Device sealed:credential" &&
    binding.backendId === "team-backend" &&
    binding.operationFamily === "team_workspace_read"
      ? { backendId: "team-backend" }
      : null
}));
vi.mock("../local-edge/upstream-routing.js", async (original) => ({
  ...(await original<typeof import("../local-edge/upstream-routing.js")>()),
  readLocalEdgeUpstreamRegistry: () => ({ backends: [] }),
  upstreamBackendById: (_registry: unknown, id: string) =>
    id === "team-backend"
      ? { id, baseUrl: "https://team.example.test", profile: "private_vps" }
      : null
}));

const at = "2026-10-20T10:00:00.000Z";
const fixture = () => {
  const ownerUserId = randomUUID();
  const personalProjectId = randomUUID();
  const workspaceProjectId = randomUUID();
  const teamPrincipalUserId = randomUUID();
  const memberId = randomUUID();
  const eventRef = randomUUID();
  const link = {
    ownerUserId,
    teamBackendId: "team-backend",
    workspaceProjectId
  };
  let linked = true;
  let remoteAllowed = true;
  let principal: string = teamPrincipalUserId;
  let active = true;
  let projectVersion = 4;
  let memberVersion = 2;
  let seenCursor = "seen-1";
  let welcomeDue = true;
  let loseAckResponse = false;
  let lifecycleReads = 0;
  let onLifecycleRead: (() => void) | null = null;
  let activityItems: Array<{
    cursor: string;
    actorTeamMemberId: string;
    kind: "work_item_created" | "work_item_done" | "source_added" | "pr_merged";
    ref: string;
    at: string;
  }> | null = null;
  let activityPageReads = 0;
  const paths: string[] = [];
  const puts: Array<{ cursor: string; welcomeDelivered: boolean }> = [];
  const fetch = vi.fn(
    async (url: URL | string | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      paths.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
      expect(parsed.origin).toBe("https://team.example.test");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer enrolled"
      );
      const path = parsed.pathname;
      if (path.endsWith("/device-credentials/status"))
        return Response.json({
          ok: true,
          auth: "device_credential",
          user: { id: principal }
        });
      if (path.endsWith("/lifecycle")) {
        lifecycleReads++;
        onLifecycleRead?.();
        return Response.json({
          id: workspaceProjectId,
          active,
          version: projectVersion,
          memberVersion
        });
      }
      if (path.endsWith("/activity/seen") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          cursor: string;
          welcomeDelivered: boolean;
        };
        puts.push(body);
        seenCursor = body.cursor;
        if (body.welcomeDelivered) welcomeDue = false;
        if (loseAckResponse) {
          loseAckResponse = false;
          throw new Error("Team ACK response lost");
        }
        return Response.json({
          cursor: seenCursor,
          seenAt: at,
          welcomeDue,
          memberId
        });
      }
      if (path.endsWith("/activity/seen"))
        return Response.json({
          cursor: seenCursor,
          seenAt: at,
          welcomeDue,
          memberId
        });
      if (path.endsWith("/activity")) {
        activityPageReads++;
        if (activityItems) {
          const after = parsed.searchParams.get("after");
          const index = activityItems.findIndex(
            (item) => item.cursor === after
          );
          const items = activityItems.slice(index + 1, index + 101);
          return Response.json({
            projectId: workspaceProjectId,
            memberId,
            items,
            hasMore: index + 1 + items.length < activityItems.length,
            nextCursor: items.at(-1)?.cursor ?? null
          });
        }
        return Response.json({
          projectId: workspaceProjectId,
          memberId,
          items:
            seenCursor === "seen-1"
              ? [
                  {
                    cursor: "event-2",
                    actorTeamMemberId: memberId,
                    kind: "work_item_done",
                    ref: eventRef,
                    at
                  }
                ]
              : [],
          hasMore: false,
          nextCursor: seenCursor === "seen-1" ? "event-2" : null
        });
      }
      return Response.json({}, { status: 404 });
    }
  );
  const context = {
    config: { koedHome: "/unused" },
    localEdge: {
      remoteOperationsAllowed: () => remoteAllowed,
      upstreamBackendsPath: "/unused",
      resolveUpstreamAuthorization: () => "Bearer enrolled",
      fetch
    }
  } as unknown as ApiRouteContext;
  const repository = {
    getLink: vi.fn(async () => (linked ? link : null)),
    principalBinding: vi.fn(async () => principal)
  };
  const input = {
    context,
    repository: repository as never,
    request: {
      headers: {
        "x-koed-team-client-credential": "Koed-Device sealed:credential"
      }
    } as never,
    ownerUserId,
    personalProjectId
  };
  return {
    input,
    paths,
    puts,
    fetch,
    setLinked: (value: boolean) => {
      linked = value;
    },
    setRemoteAllowed: (value: boolean) => {
      remoteAllowed = value;
    },
    setPrincipal: (value: string) => {
      principal = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setProjectVersion: (value: number) => {
      projectVersion = value;
    },
    setMemberVersion: (value: number) => {
      memberVersion = value;
    },
    setWelcomeDue: (value: boolean) => {
      welcomeDue = value;
    },
    setLoseAckResponse: () => {
      loseAckResponse = true;
    },
    onLifecycleRead: (callback: () => void) => {
      onLifecycleRead = callback;
    },
    lifecycleReads: () => lifecycleReads,
    setActivityItems: (items: NonNullable<typeof activityItems>) => {
      activityItems = items;
    },
    activityPageReads: () => activityPageReads,
    activityItem: (
      index: number,
      kind: NonNullable<typeof activityItems>[number]["kind"]
    ) => ({
      cursor: `event-${String(index).padStart(4, "0")}`,
      actorTeamMemberId: memberId,
      kind,
      ref: eventRef,
      at
    })
  };
};

describe("linked Team catch-up facade", () => {
  it("scans excluded activity pages to the first eligible event without leaking excluded rows", async () => {
    const test = fixture();
    test.setActivityItems([
      ...Array.from({ length: 100 }, (_, index) =>
        test.activityItem(index + 1, index % 2 ? "pr_merged" : "work_item_done")
      ),
      test.activityItem(101, "source_added")
    ]);
    const window = await readLinkedTeamCatchUp(test.input);
    expect(window).toMatchObject({
      seenCursor: "seen-1",
      highCursor: "event-0101",
      events: [{ kind: "source_added" }]
    });
    expect(test.activityPageReads()).toBe(2);
    expect(test.puts).toEqual([]);
    expect(
      test.paths.every(
        (path) => !path.includes("collaboration") && !path.includes("messages")
      )
    ).toBe(true);
  });

  it("pins the high cursor to the hundredth eligible row, without ACKing a later row", async () => {
    const test = fixture();
    test.setActivityItems([
      ...Array.from({ length: 99 }, (_, index) =>
        test.activityItem(index + 1, "work_item_done")
      ),
      ...Array.from({ length: 102 }, (_, index) =>
        test.activityItem(index + 100, "work_item_created")
      )
    ]);
    const window = await readLinkedTeamCatchUp(test.input);
    expect(window?.events).toHaveLength(100);
    expect(window?.highCursor).toBe("event-0199");
    expect(test.activityPageReads()).toBe(2);
    expect(test.puts).toEqual([]);
  });

  it("does not ACK excluded-only activity without a welcome terminal", async () => {
    const test = fixture();
    test.setWelcomeDue(false);
    const window = await readLinkedTeamCatchUp(test.input);
    expect(window?.events).toEqual([]);
    await expect(
      ackLinkedTeamCatchUp({ ...test.input, window: window! })
    ).rejects.toThrow("Excluded Team activity is not acknowledged");
    expect(test.puts).toEqual([]);
  });

  it("reads only public activity, rechecks versions, and reconciles a lost exact-cursor ACK", async () => {
    const test = fixture();
    const completed = await readLinkedTeamCatchUp(test.input);
    expect(completed).toMatchObject({
      seenCursor: "seen-1",
      highCursor: "event-2",
      welcomeDue: true,
      projectVersion: 4,
      memberVersion: 2,
      events: []
    });
    expect(test.lifecycleReads()).toBe(2);
    expect(
      test.paths.every(
        (path) => !path.includes("collaboration") && !path.includes("messages")
      )
    ).toBe(true);
    test.setProjectVersion(5); // An unrelated Team edit must not strand the old proven cursor.
    test.setLoseAckResponse();
    await expect(
      ackLinkedTeamCatchUp({ ...test.input, window: completed! })
    ).resolves.toMatchObject({
      cursor: "event-2",
      welcomeDue: false
    });
    expect(test.puts).toEqual([{ cursor: "event-2", welcomeDelivered: true }]);
  });

  it("rejects a mid-read member version change or disabled Team Project before exposing a window", async () => {
    const changed = fixture();
    changed.onLifecycleRead(() => {
      if (changed.lifecycleReads() === 2) changed.setMemberVersion(3);
    });
    await expect(readLinkedTeamCatchUp(changed.input)).rejects.toThrow(
      "version changed"
    );
    const disabled = fixture();
    disabled.onLifecycleRead(() => {
      if (disabled.lifecycleReads() === 2) disabled.setActive(false);
    });
    await expect(readLinkedTeamCatchUp(disabled.input)).rejects.toThrow();
  });

  it("does not ACK after link, principal, or membership changes", async () => {
    for (const change of [
      (test: ReturnType<typeof fixture>) => test.setLinked(false),
      (test: ReturnType<typeof fixture>) => test.setPrincipal(randomUUID()),
      (test: ReturnType<typeof fixture>) => test.setMemberVersion(3)
    ]) {
      const test = fixture();
      const completed = await readLinkedTeamCatchUp(test.input);
      change(test);
      await expect(
        ackLinkedTeamCatchUp({ ...test.input, window: completed! })
      ).rejects.toThrow();
      expect(test.puts).toEqual([]);
    }
  });

  it("denies a disabled remote boundary or missing sealed Team credential before any upstream fetch", async () => {
    const disabled = fixture();
    disabled.setRemoteAllowed(false);
    await expect(readLinkedTeamCatchUp(disabled.input)).rejects.toThrow(
      "Remote Team operations are unavailable"
    );
    expect(disabled.fetch).not.toHaveBeenCalled();

    const unsealed = fixture();
    await expect(
      readLinkedTeamCatchUp({
        ...unsealed.input,
        request: { headers: {} } as never
      })
    ).rejects.toThrow("Enrolled Team read authority required");
    expect(unsealed.fetch).not.toHaveBeenCalled();
  });
});
