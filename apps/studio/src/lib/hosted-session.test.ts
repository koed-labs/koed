import assert from "node:assert/strict";
import test from "node:test";
// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { hostedWorkosLoginUrl, loadHostedSession, selectHostedTeamId, signInAndLoadHostedSession, signInWithLocalSession } from "./hosted-session.ts";

const me = {
  user: { id: "user-1", email: "member@example.test", displayName: "Member" }
};

const navigation = {
  principal: me.user,
  teams: [
    {
      team: { id: "team-1", name: "Authorized Team" },
      membership: { userId: "user-1", role: "admin", status: "enabled" },
      members: [
        { userId: "user-1", displayName: "Member", status: "enabled" },
        { userId: "user-2", displayName: "Colleague", status: "enabled" }
      ],
      workspaces: [
        {
          teamWorkspace: {
            id: "workspace-1",
            name: "Authorized Workspace",
            lifecycle: "active"
          },
          access: { access: "write" }
        }
      ]
    }
  ]
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

test("loads real Team navigation using the same-origin browser session", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return url === "/me" ? json(me) : json(navigation);
  };

  const result = await loadHostedSession(fetcher);

  assert.deepEqual(result, {
    status: "authenticated",
    user: me.user,
    teams: [
      {
        id: "team-1",
        name: "Authorized Team",
        membership: {
          userId: "user-1",
          role: "admin",
          status: "enabled"
        },
        members: [
          { id: "user-1", name: "Member", status: "enabled" },
          { id: "user-2", name: "Colleague", status: "enabled" }
        ],
        workspaces: [
          {
            id: "workspace-1",
            name: "Authorized Workspace",
            access: "write",
            lifecycle: "active"
          }
        ]
      }
    ]
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/me", "/v1/teams/navigation"]
  );
  for (const call of calls) {
    assert.equal(call.init?.credentials, "include");
    assert.equal(call.init?.cache, "no-store");
  }
});

test("reports signed out and uses advertised local and WorkOS providers", async () => {
  const fetcher: typeof fetch = async (input) =>
    String(input) === "/me"
      ? json({ error: "Unauthorized" }, 401)
      : json({ auth: { providers: ["local", "workos", "unknown"] } });

  assert.deepEqual(await loadHostedSession(fetcher), {
    status: "signed_out",
    providers: ["local", "workos"]
  });
});

test("classifies expired or revoked Team navigation access as a reauthentication state", async () => {
  const fetcher: typeof fetch = async (input) => {
    switch (String(input)) {
      case "/me":
        return json(me);
      case "/v1/teams/navigation":
        return json({ error: "Forbidden" }, 403);
      default:
        return json({ auth: { providers: ["workos"] } });
    }
  };

  assert.deepEqual(await loadHostedSession(fetcher), {
    status: "revoked",
    user: me.user,
    providers: ["workos"],
    message:
      "This session expired or Team access changed. Sign in again to continue."
  });
});

test("fails closed when the session principal changes before Team navigation returns", async () => {
  const fetcher: typeof fetch = async (input) =>
    String(input) === "/me"
      ? json(me)
      : json({ ...navigation, principal: { ...me.user, id: "user-2" } });

  assert.deepEqual(await loadHostedSession(fetcher), {
    status: "session_changed",
    message:
      "The signed-in account changed while Team navigation was loading. Refresh to load the current session."
  });
});

test("uses the current route query when switching between authorized Teams", () => {
  const makeTeam = (id: string) => ({
    id,
    name: id,
    membership: { userId: "user-1", role: "member", status: "enabled" },
    workspaces: [],
    members: []
  });
  const teams = [makeTeam("team-a"), makeTeam("team-b")];

  assert.equal(selectHostedTeamId(teams, "team-a"), "team-a");
  assert.equal(selectHostedTeamId(teams, "team-b"), "team-b");
  assert.equal(selectHostedTeamId(teams, "outside-team"), "team-a");
});

test("keeps connection failures retryable and refuses malformed navigation data", async () => {
  const offline: typeof fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal((await loadHostedSession(offline)).status, "unavailable");

  const malformed: typeof fetch = async (input) =>
    String(input) === "/me"
      ? json(me)
      : json({ principal: me.user, teams: [{ name: "Fake" }] });
  assert.equal((await loadHostedSession(malformed)).status, "unavailable");
});

test("posts local credentials to the backend session route and returns an origin-relative WorkOS URL", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = { url: String(input), init };
    return json({ user: me.user });
  };
  await signInWithLocalSession("member@example.test", "secret", fetcher);
  assert.equal(request?.url, "/auth/login");
  assert.equal(request?.init?.method, "POST");
  assert.equal(request?.init?.credentials, "include");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    email: "member@example.test",
    password: "secret"
  });
  assert.equal(
    hostedWorkosLoginUrl("/collaboration?team=team%2F1"),
    "/auth/workos/login?return_to=%2Fcollaboration%3Fteam%3Dteam%252F1"
  );
});

test("local sign-in starts a fresh session load after an overlapping refresh", async () => {
  let loggedIn = false;
  let meRequestCount = 0;
  let releaseOldSession!: (response: Response) => void;
  const oldSessionResponse = new Promise<Response>((resolve) => {
    releaseOldSession = resolve;
  });
  let currentSequence = 0;
  const fetcher: typeof fetch = async (input) => {
    switch (String(input)) {
      case "/auth/login":
        loggedIn = true;
        return json({ user: me.user });
      case "/me":
        meRequestCount += 1;
        if (meRequestCount === 1) return oldSessionResponse;
        assert.equal(loggedIn, true);
        return json(me);
      case "/v1/teams/navigation":
        return json(navigation);
      case "/v1/capabilities":
        return json({ auth: { providers: ["local"] } });
      default:
        throw new Error(`Unexpected request ${String(input)}`);
    }
  };

  const oldRefreshSequence = ++currentSequence;
  const oldRefresh = loadHostedSession(fetcher);
  await Promise.resolve();
  const login = await signInAndLoadHostedSession(
    "member@example.test",
    "secret",
    () => ++currentSequence,
    fetcher
  );

  assert.equal(login.requestSequence, currentSequence);
  assert.equal(login.result.status, "authenticated");
  assert.ok(login.requestSequence > oldRefreshSequence);

  releaseOldSession(json({ error: "Unauthorized" }, 401));
  const oldResult = await oldRefresh;
  assert.equal(oldResult.status, "signed_out");
  assert.notEqual(oldRefreshSequence, currentSequence);
});
