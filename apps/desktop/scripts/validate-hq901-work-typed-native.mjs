import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow, ipcMain } from "electron";
import { handleHqSourceControlMerge } from "../dist-electron/koed-server/hq-source-control-merge-client.js";
import { sourceControlMergeReviewOptions } from "../dist-electron/koed-server/source-control-merge-native-review.js";
import { createReviewRequestMergeProposalObserver } from "../../../apps/worker/dist/review-request-merge-proposal.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_TYPED_NATIVE_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-901 typed merge profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  await app.whenReady();
  const executionId = "00000000-0000-4000-8000-000000004405";
  const proposalItemId = "00000000-0000-4000-8000-000000004055";
  const operationId = "22222222-2222-4222-8222-222222222222";
  let proposal;
  let cardShown = 0;
  let providerMutations = 0;
  let observedPermissionMode = "full_access";
  const observeProposal = createReviewRequestMergeProposalObserver({
    getManagedConversationCommand: async () => ({
      executionId,
      commandKind: "prompt",
      executionGeneration: 1,
      leaseToken: "typed-human-prompt",
      state: "dispatching"
    }),
    putManagedConversationRuntimeItem: async (_actor, item) => {
      proposal = { ...item, id: proposalItemId };
    }
  });
  ipcMain.handle("hq901:merge-native", async (_event, request) => {
    assert.equal(request.operation, "source_control_merge");
    assert.equal(request.executionId, executionId);
    assert.equal(request.reviewRequestNumber, 212);
    assert.equal(request.proposalItemId, proposalItemId);
    assert.equal(request.mergeMethod, "squash");
    assert.equal(observedPermissionMode, "full_access");
    await observeProposal({
      execution: {
        id: executionId,
        ownerUserId: "owner",
        executionGeneration: 1,
        permissionMode: observedPermissionMode
      },
      command: {
        id: "66666666-6666-4666-8666-666666666666",
        leaseToken: "typed-human-prompt"
      },
      providerTurnId: "typed-turn-212",
      toolCallId: "typed-tool-212",
      toolName: "review_request_merge_propose",
      arguments: { number: 212 },
      result: { structuredContent: { number: 212, status: "requested" } }
    });
    assert.equal(proposal?.payload.mergeProposal.reviewRequestNumber, 212);
    const requestJson = async (path, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith("/runtime")) return { items: [proposal] };
      if (body?.kind === "review_request_merge_prepare")
        return {
          kind: "review_request_merge_prepared",
          operationId,
          operationGeneration: 1,
          idempotencyKey: `merge:${operationId}`,
          readinessSnapshotDigest: "b".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          readiness: {
            provider: "github",
            accountLabel: "Personal GitHub",
            host: "github.com",
            apiOrigin: "https://api.github.com",
            repository: "koed-labs/koed",
            remoteIdentityHash: request.remoteIdentityHash,
            connectionId: "33333333-3333-4333-8333-333333333333",
            executionId,
            executionGeneration: 1,
            runnerDeploymentId: "44444444-4444-4444-8444-444444444444",
            runnerDeviceId: "55555555-5555-4555-8555-555555555555",
            credentialGeneration: 4,
            policyVersion: 1,
            policyDigest: "e".repeat(64),
            reviewRequestNumber: 212,
            title: "KOE-4 mobile spacing",
            targetBranch: "main",
            expectedHeadObjectId: "c".repeat(40),
            mergeability: "mergeable",
            reviewDecision: "approved",
            requiredReviewCount: 1,
            approvedReviewCount: 1,
            reviews: [
              {
                id: "1",
                user: "reviewer",
                commitObjectId: "c".repeat(40),
                state: "APPROVED",
                submittedAt: "2026-10-20T00:00:00.000Z"
              }
            ],
            checks: [
              {
                id: "2",
                name: "ci",
                source: "check_run",
                state: "success",
                required: true,
                appId: 7,
                objectId: "c".repeat(40)
              }
            ],
            allowedMergeMethods: ["squash"],
            mergeMethod: "squash",
            protectionDigest: "d".repeat(64)
          }
        };
      if (body?.kind === "review_request_merge") {
        assert.equal(cardShown, 1);
        assert.match(body.approvalProof, /^[a-f0-9]{64}$/);
        providerMutations++;
        return {
          kind: "review_request_merge_result",
          operationId,
          outcome: "merged",
          providerOperationId: "77777777-7777-4777-8777-777777777777",
          mergeCommitObjectId: "f".repeat(40)
        };
      }
      throw new Error(`Unexpected Native request: ${path}`);
    };
    const result = await handleHqSourceControlMerge({
      request,
      requestJson,
      access: async () => ({
        authorization: "Koed-Desktop native-fixture:private-secret"
      }),
      confirm: async (value) => {
        cardShown++;
        const card = sourceControlMergeReviewOptions(value);
        assert.equal(card.message, "Merge koed-labs/koed #212?");
        assert.ok(card.detail.includes("Method: squash"));
        assert.deepEqual(card.buttons, ["Cancel", "Merge"]);
        return true;
      }
    });
    return { requestId: request.requestId, ...result };
  });
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      preload: resolve(import.meta.dirname, "hq901-merge-native-preload.cjs")
    }
  });
  try {
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq901TypedMergeNative: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 180; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ901 typed merge did not reach: ${source}; state=${JSON.stringify(await js('({trace: window.__hq405Trace, flag: window.__hq405ProposalCapture, alerts: [...document.querySelectorAll("[role=alert]")].map(x=>x.textContent), proposal: document.body.textContent.includes("Merge of PR #212 proposed"), body: document.body.textContent.slice(-1000)})'))}`
      );
    };
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    // Each run uses an isolated profile; a prior reviewed marker must not
    // suppress the proposal before this run exercises the Native boundary.
    await js(`for (const key of Object.keys(localStorage)) {
      if (key.startsWith("koed-hq-merge-proposal:")) localStorage.removeItem(key);
    }`);
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      'document.querySelector(".hq-project-conversation textarea") !== null'
    );
    assert.equal(await js("window.__hq405Trace.mergeRequests"), 0);
    await js(`(() => {
      const textarea = document.querySelector(".hq-project-conversation textarea");
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setValue.call(textarea, "Merge #212");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor(
      'document.querySelector(".hq-project-conversation form button[type=submit]")?.disabled === false'
    );
    await js(
      'document.querySelector(".hq-project-conversation form").requestSubmit()'
    );
    await waitFor('window.__koedHq204Trace.firstPrompt === "Merge #212"');
    // Reopening Project HQ forces a fresh production runtime read after the
    // worker proposal receipt lands; hidden Electron windows do not tick the
    // visibility-gated periodic refresh.
    await js("document.querySelector('button[aria-label=\"Now\"]').click()");
    await waitFor(
      'document.querySelector("[data-hq-route=\\"home\\"]") !== null'
    );
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor("window.__hq405Trace.mergeRequests === 1");
    await waitFor(
      'document.querySelector(\'[aria-label="Done today"]\')?.textContent.includes("Ship the release")'
    );
    assert.ok(await js("window.__hq405Trace.reconcileReads > 0"));
    assert.equal(cardShown, 1);
    assert.equal(providerMutations, 1);
    const output = resolve(scratch, "hq-901-work-typed-native");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.work-typed-native",
          status: "pass",
          proofIds: [
            "S04.2.full-access-native-card",
            "S05.2.typed-tool-native-provider-done"
          ],
          scope:
            "rendered typed prompt through production Native merge orchestration and observed worker proposal receipt"
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    window.destroy();
    ipcMain.removeHandler("hq901:merge-native");
    app.quit();
  }
};

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
