import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLaunchValidationEnvironment,
  automatedLaunchTestCommands,
  formatLaunchValidationReport,
  launchValidationGates,
  runStagedRemoteValidation,
  summarizeLaunchValidation
} from "./team-saas-launch-validation-lib.mjs";

test("launch validation requires API_TOKEN_PEPPER for Auth gate coverage", () => {
  assert.doesNotThrow(() =>
    assertLaunchValidationEnvironment({ API_TOKEN_PEPPER: "pepper" })
  );
  assert.throws(
    () => assertLaunchValidationEnvironment({ API_TOKEN_PEPPER: "" }),
    /API_TOKEN_PEPPER is required/
  );
  assert.throws(
    () => assertLaunchValidationEnvironment({}),
    /API_TOKEN_PEPPER is required/
  );
});

test("launch validation gates cover Team SaaS critical path areas", () => {
  const criteria = launchValidationGates.map((gate) => gate.launchCriterion);
  const descriptions = launchValidationGates.map((gate) => gate.description);

  assert.ok(criteria.some((criterion) => criterion.includes("signs up")));
  assert.ok(criteria.some((criterion) => criterion.includes("Team")));
  assert.ok(criteria.some((criterion) => criterion.includes("Workspace")));
  assert.ok(criteria.some((criterion) => criterion.includes("shared")));
  assert.ok(criteria.some((criterion) => criterion.includes("Unauthorized")));
  assert.ok(criteria.some((criterion) => criterion.includes("Member removal")));
  assert.ok(
    criteria.some((criterion) => criterion.includes("Personal deletion"))
  );
  assert.ok(criteria.some((criterion) => criterion.includes("Billing")));
  assert.ok(criteria.some((criterion) => criterion.includes("observability")));
  assert.ok(criteria.some((criterion) => criterion.includes("Backups")));
  assert.ok(criteria.some((criterion) => criterion.includes("capacity")));
  assert.ok(criteria.some((criterion) => criterion.includes("API-token")));
  assert.ok(criteria.some((criterion) => criterion.includes("Local edge")));
  assert.ok(criteria.some((criterion) => criterion.includes("Share Grants")));
  assert.ok(criteria.some((criterion) => criterion.includes("Encrypted")));
  assert.ok(criteria.some((criterion) => criterion.includes("identity")));
  assert.ok(
    descriptions.some((description) =>
      description.includes("Capability discovery")
    )
  );
  assert.ok(
    descriptions.some((description) =>
      description.includes("Encrypted Team fixture")
    )
  );
  assert.ok(
    descriptions.some((description) =>
      description.includes("Unauthorized memory is excluded")
    )
  );
  assert.ok(
    automatedLaunchTestCommands.some(
      (command) => command.id === "db-encrypted-tenant-boundaries"
    )
  );
  assert.ok(
    automatedLaunchTestCommands.some(
      (command) => command.id === "api-auth-runtime-boundaries"
    )
  );
});

test("launch validation report separates automated and manual gates", () => {
  const summary = summarizeLaunchValidation({
    memories: 13,
    checks: ["Fixture access check"]
  });
  const report = formatLaunchValidationReport(summary);

  assert.equal(summary.byMode.automated, 12);
  assert.equal(summary.byMode.manual, 3);
  assert.equal(summary.byMode.staging, 4);
  assert.equal(summary.automatedTestStatus, "not_run");
  assert.match(report, /Automated launch gates:/);
  assert.match(report, /Automated repository test gates: not_run/);
  assert.match(report, /db-encrypted-tenant-boundaries/);
  assert.match(report, /Manual launch gates:/);
  assert.match(report, /Staging launch gates:/);
  assert.match(report, /Remote Team recall respects session/);
  assert.match(report, /Encrypted Team fixture cases prove/);
  assert.match(report, /Capability discovery and diagnostics/);
  assert.match(report, /Any failed launch blocker/);
});

test("staged remote validation requires explicit route credentials", async () => {
  await assert.rejects(
    () => runStagedRemoteValidation({ baseUrl: "http://localhost:3300" }),
    /requires .*session-cookie.*device-credential/
  );
});

test("staged remote validation probes Team routes and local-edge proxy", async () => {
  const calls = [];
  const result = await runStagedRemoteValidation(
    {
      baseUrl: "http://hosted.local/",
      sessionCookie: "cm_session=session-secret",
      deviceCredential: "device-key:secret",
      apiToken: "koed_test",
      teamWorkspaceId: "30000000-0000-4000-8000-000000000001",
      teamNodeId: "60000000-0000-4000-8000-000000000001",
      localEdgeBaseUrl: "http://edge.local/",
      localEdgeBackendId: "team-vps"
    },
    async (url, init) => {
      calls.push({ url, init });
      const status =
        init?.headers?.authorization === "Bearer koed_test" ? 403 : 200;
      return new Response(JSON.stringify({ ok: true, nodes: [] }), {
        status,
        headers: { "content-type": "application/json" }
      });
    }
  );

  assert.equal(result.baseUrl, "http://hosted.local");
  assert.equal(result.localEdgeBaseUrl, "http://edge.local");
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "api-token-team-answer-rejected"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "api-token-team-graph-rejected"
    )
  );
  assert.ok(
    result.probes.some((probe) => probe.name === "public-capabilities")
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "session-authenticated-capabilities"
    )
  );
  assert.ok(result.probes.some((probe) => probe.name === "device-team-search"));
  assert.ok(
    result.probes.some((probe) => probe.name === "session-team-graph-events")
  );
  assert.ok(
    result.probes.some((probe) => probe.name === "session-team-node-expand")
  );
  assert.ok(
    result.probes.some((probe) => probe.name === "local-edge-team-answer-proxy")
  );
  assert.ok(
    calls.some((call) => call.url === "http://hosted.local/v1/capabilities")
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/capabilities/authenticated" &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/memory/answer" &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url ===
          "http://hosted.local/v1/memory/graph/events?teamWorkspaceId=30000000-0000-4000-8000-000000000001" &&
        call.init.headers.authorization === "Bearer koed_test"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url ===
          "http://hosted.local/v1/memory/graph/events?teamWorkspaceId=30000000-0000-4000-8000-000000000001" &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/memory/answer" &&
        call.init.headers.authorization === "Koed-Device device-key:secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/memory/search" &&
        call.init.headers.authorization === "Koed-Device device-key:secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url ===
          "http://hosted.local/v1/memory/nodes/60000000-0000-4000-8000-000000000001/expand?team_workspace_id=30000000-0000-4000-8000-000000000001" &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://edge.local/v1/local-edge/upstream-operations" &&
        JSON.parse(call.init.body).upstream_backend_id === "team-vps"
    )
  );
});

test("staged remote validation fails if a remote response leaks route credentials", async () => {
  await assert.rejects(
    () =>
      runStagedRemoteValidation(
        {
          baseUrl: "http://hosted.local/",
          sessionCookie: "cm_session=session-secret",
          deviceCredential: "device-key:secret",
          apiToken: "koed_test",
          teamWorkspaceId: "30000000-0000-4000-8000-000000000001"
        },
        async () =>
          new Response(
            JSON.stringify({ echoed: "cm_session=session-secret" }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
      ),
    /leaked staged credential sentinel/
  );
});
