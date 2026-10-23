import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Hq713Fixture } from "./hq713-fixture.js";

/** Official-provider data is a bounded fixture; all authority, HTTP and storage are real. */
export async function runHq713AiClientUsageBoundary(fixture: Hq713Fixture) {
  const alice = fixture.alice;
  const bob = fixture.bob;
  const base = `/v1/memory/ai-client-instances/${alice.aiClientInstanceId}/usage`;
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const profileScopeHash = createHash("sha256")
    .update(resolve(alice.koedHome))
    .digest("hex");
  const nextProfileScopeHash = createHash("sha256")
    .update(resolve(alice.koedHome, "next-profile"))
    .digest("hex");
  const headers = { "x-koed-ai-client-profile-scope": profileScopeHash };
  const nextProfileHeaders = {
    "x-koed-ai-client-profile-scope": nextProfileScopeHash
  };
  const observedAt = new Date(Date.now() - 2_000).toISOString();
  const switchedAt = new Date(Date.now() - 1_000).toISOString();
  const profileSwitchedAt = new Date(
    Date.parse(switchedAt) + 1_000
  ).toISOString();
  const reading = {
    source: "codex_app_server",
    bucketId: "codex",
    bucketName: "Codex",
    window: "primary",
    windowDurationMins: 300,
    usedPercent: 12.5,
    status: "ok",
    resetsAt: null,
    planType: "plus",
    details: {
      ordinaryUsageAllowed: true
    },
    observedAt
  };
  const bind = await alice.personalTokenClient.request<{ accepted: boolean }>(
    "PUT",
    `${base}/account`,
    {
      body: {
        account_identity_hash: first,
        profile_scope_hash: profileScopeHash,
        observed_at: observedAt
      },
      expectedStatus: 200
    }
  );
  assert.equal(bind.body.accepted, true);
  const stored = await alice.personalTokenClient.request<{
    snapshots: unknown[];
  }>("POST", `${base}/snapshots`, {
    body: {
      account_identity_hash: first,
      profile_scope_hash: profileScopeHash,
      observed_at: observedAt,
      readings: [reading]
    },
    expectedStatus: 200
  });
  assert.equal(stored.body.snapshots.length, 1);
  const aliceRead = await alice.personalTokenClient.request<{
    snapshots: Array<{ usedPercent: number }>;
    authorityGeneration: string;
  }>("GET", "/v1/memory/ai-client-instances/usage", {
    headers,
    expectedStatus: 200
  });
  assert.equal(aliceRead.body.snapshots[0]?.usedPercent, 12.5);
  assert.equal(JSON.stringify(aliceRead.body).includes(first), false);
  const unmatchedProfile = await alice.personalTokenClient.request<{
    snapshots: unknown[];
  }>("GET", "/v1/memory/ai-client-instances/usage", {
    headers: nextProfileHeaders,
    expectedStatus: 200
  });
  assert.deepEqual(unmatchedProfile.body.snapshots, []);
  const bobRead = await bob.personalTokenClient.request<{
    snapshots: unknown[];
  }>("GET", "/v1/memory/ai-client-instances/usage", {
    headers,
    expectedStatus: 200
  });
  assert.deepEqual(bobRead.body.snapshots, []);
  // Bob has his own enabled instance with this ID, but no account binding.
  // The write must produce no snapshot in Bob's separate Personal store.
  const bobUnboundWrite = await bob.personalTokenClient.request<{
    snapshots: unknown[];
  }>("POST", `${base}/snapshots`, {
    body: {
      account_identity_hash: first,
      profile_scope_hash: profileScopeHash,
      observed_at: observedAt,
      readings: [reading]
    },
    expectedStatus: 200
  });
  assert.deepEqual(bobUnboundWrite.body.snapshots, []);
  const aliceOnlyInstanceId = "codex.hq713.alice-only";
  await alice.personalTokenClient.request(
    "PUT",
    `/v1/memory/ai-client-instances/${aliceOnlyInstanceId}`,
    {
      body: {
        driver_id: "codex",
        display_name: "Alice-only usage fixture",
        enabled: true
      },
      expectedStatus: 200
    }
  );
  await bob.personalTokenClient.request(
    "POST",
    `/v1/memory/ai-client-instances/${aliceOnlyInstanceId}/usage/snapshots`,
    {
      body: {
        account_identity_hash: first,
        profile_scope_hash: profileScopeHash,
        observed_at: observedAt,
        readings: [reading]
      },
      expectedStatus: 409
    }
  );
  const bobUsageRows = await fixture.personalDb(bob).query<{
    count: string;
  }>("select count(*)::text as count from ai_client_usage_snapshots where owner_user_id = $1", [bob.id]);
  assert.equal(bobUsageRows.rows[0]?.count, "0");
  const aliceStillOwnsReading = await alice.personalTokenClient.request<{
    snapshots: Array<{ usedPercent: number }>;
    authorityGeneration: string;
  }>("GET", "/v1/memory/ai-client-instances/usage", {
    headers,
    expectedStatus: 200
  });
  assert.equal(aliceStillOwnsReading.body.snapshots[0]?.usedPercent, 12.5);
  await alice.personalTokenClient.request("PUT", `${base}/account`, {
    body: {
      account_identity_hash: second,
      profile_scope_hash: profileScopeHash,
      observed_at: switchedAt
    },
    expectedStatus: 200
  });
  const delayed = await alice.personalTokenClient.request<{
    snapshots: unknown[];
  }>("POST", `${base}/snapshots`, {
    body: {
      account_identity_hash: first,
      profile_scope_hash: profileScopeHash,
      observed_at: observedAt,
      readings: [reading]
    },
    expectedStatus: 200
  });
  assert.deepEqual(delayed.body.snapshots, []);
  const after = await alice.personalTokenClient.request<{
    snapshots: unknown[];
    authorityGeneration: string;
  }>("GET", "/v1/memory/ai-client-instances/usage", {
    headers,
    expectedStatus: 200
  });
  assert.deepEqual(after.body.snapshots, []);
  assert.notEqual(
    after.body.authorityGeneration,
    aliceRead.body.authorityGeneration
  );
  assert.notEqual(
    after.body.authorityGeneration,
    aliceStillOwnsReading.body.authorityGeneration,
    "Switching account must invalidate authority after the instance-only fixture change"
  );
  const profileBind = await alice.personalTokenClient.request<{
    accepted: boolean;
  }>("PUT", `${base}/account`, {
    body: {
      account_identity_hash: second,
      profile_scope_hash: nextProfileScopeHash,
      observed_at: profileSwitchedAt
    },
    expectedStatus: 200
  });
  assert.equal(profileBind.body.accepted, true);
  const oldProfileAfterSwitch = await alice.personalTokenClient.request<{
    snapshots: unknown[];
  }>("GET", "/v1/memory/ai-client-instances/usage", {
    headers,
    expectedStatus: 200
  });
  assert.deepEqual(oldProfileAfterSwitch.body.snapshots, []);
  const staleProfileWrite = await alice.personalTokenClient.request<{
    snapshots: unknown[];
  }>("POST", `${base}/snapshots`, {
    body: {
      account_identity_hash: second,
      profile_scope_hash: profileScopeHash,
      observed_at: switchedAt,
      readings: [{ ...reading, observedAt: profileSwitchedAt }]
    },
    expectedStatus: 200
  });
  assert.deepEqual(staleProfileWrite.body.snapshots, []);
  const teamRows = await fixture.team.db.query<{ count: string }>(
    "select count(*)::text as count from ai_client_usage_snapshots where owner_user_id = any($1::uuid[])",
    [[alice.teamUserId, bob.teamUserId]]
  );
  assert.equal(teamRows.rows[0]?.count, "0");
  await alice.team.request("GET", "/v1/memory/ai-client-instances/usage", {
    expectedStatus: 404
  });
  fixture.results.record("N21", {
    personalOwners: ["Alice", "Bob"],
    foreignInstanceWriteDenied: true,
    bobPersonalUsageRows: 0,
    bucketAndWindow: "codex/primary",
    fractionalPercentPreserved: true,
    teamRows: 0,
    oldAccountReadRejected: true,
    delayedOldAccountWriteRejected: true,
    sameOwnerProfileReadIsolated: true,
    staleProfileWriteRejected: true,
    credentialFieldsAbsent: true
  });
}
