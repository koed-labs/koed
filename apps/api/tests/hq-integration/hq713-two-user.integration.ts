import assert from "node:assert/strict";
import { describe, it, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Hq713Fixture } from "./hq713-fixture.js";
import { withHq713Fixture } from "./hq713-fixture.js";
import {
  runHq713ShareAndJoin,
  runHq713LiveWorkItemCas,
  runHq713PrivateAgentBoundary,
  runHq713OfflineReadOnly,
  runHq713InterruptedFirstShare
} from "./hq713-collaboration.js";
import {
  runHq713MemoryStep3,
  runHq713MemoryN2,
  runHq713MemoryStep6,
  runHq713MemoryN5,
  runHq713MemoryStep12,
  runHq713MemoryScopeChangeControl,
  runHq713MemorySelectorControl,
  runHq713MemoryCitationControl,
  runHq713MemoryCitationRevocationControl
} from "./hq713-memory.js";
import {
  createHq713LeasedExecution,
  runHq713ManagedCitationControl,
  runHq713ManagedCitationRevocationControl
} from "./hq713-managed-citations.js";
import { runHq713RuntimeSelectorControl } from "./hq713-runtime.js";
import { runHq713DesktopProof } from "./hq713-desktop.js";
import { runHq713Decks } from "./hq713-decks.js";
import {
  runHq713ChatDeleteFreeze,
  runHq713DeleteRestore,
  runHq713Leave,
  runHq713OwnedLeave
} from "./hq713-lifecycle.js";

import {
  runHq713FirstShareReplyReplay,
  runHq713FirstShareTargetMismatch,
  runHq713FirstShareDelayedCreate,
  runHq713FirstShareDeleteBeforeConfirm,
  runHq713FirstShareDeleteAfterConfirm,
  runHq713FirstShareAccessLossBeforeConfirm,
  runHq713FirstShareAccessLossAfterConfirm
} from "./hq713-first-share-lifecycle.js";

import { runHq713FuturePolicy } from "./hq713-future-policy.js";
import { runHq713ShareOrigin } from "./hq713-share-origin.js";
import { runHq713AiClientUsageBoundary } from "./hq713-ai-client-usage.js";

const required = [
  "I13-I14-step1-step2-share-join",
  "HQ713-step2-private-project-HQ",
  "I713.3",
  "HQ713-step4-work-item-CAS",
  "HQ713-step5-private-agent-boundary",
  "I713.6",
  "N26",
  "HQ713-step7-Team-offline",
  "I713.8",
  "I713.9",
  "HQ713-step10-interrupted-first-share",
  "I713.11",
  "I713.11.project-leave",
  "I713.12",
  "I713.13",
  "I713.13.learning.alice",
  "I713.13.learning.bob",
  "I713.14",
  "I713.chat-delete-freeze",
  "N2",
  "N21",
  "N5",
  "N6",
  "N8",
  "N11.post-freeze",
  "N11.independent-grant",
  "N11.in-flight-freeze",
  "N11.revocation",
  "N11.suppression",
  "N11.expiry",
  "I24",
  "I25",
  "I26",
  "I27",
  "I27.scope-change",
  "I28.question-history",
  "I28.question-history-revoked",
  "I28.managed-turn",
  "I28.managed-turn-revoked",
  "I30",
  "I30.runtime-selectors",
  "I30.runtime-Team-unavailable",
  "I713.first-share-reply-replay",
  "I713.first-share-target-mismatch",
  "I713.first-share-delayed-create",
  "I713.first-share-delete-before-confirm",
  "I713.first-share-delete-after-confirm",
  "I713.first-share-access-loss-before-confirm",
  "I713.first-share-access-loss-after-confirm",
  "I713.future-empty-policy",
  "I724.2.data.N17.separate-backends"
];
const results = new Map<string, Record<string, unknown>>();
const collect = (fixture: Hq713Fixture) => {
  for (const entry of fixture.results.entries()) {
    assert.ok(
      !results.has(entry.id),
      `Duplicate integration result: ${entry.id}`
    );
    results.set(entry.id, entry.evidence);
  }
};
const withRecordedFixture = async (
  run: (fixture: Hq713Fixture) => Promise<void>
) =>
  withHq713Fixture(async (fixture) => {
    try {
      await run(fixture);
    } finally {
      // Preserve completed assertion evidence even when a later required case fails.
      collect(fixture);
    }
  });
afterAll(async () => {
  const expected =
    process.env.KOED_HQ713_DESKTOP === "1"
      ? [...required, "I713.Native"]
      : required;
  const missing = expected.filter((id) => !results.has(id));
  const report = {
    assertionCoverageComplete: missing.length === 0,
    missing,
    assertions: [...results].map(([id, evidence]) => ({ id, evidence }))
  };
  const output = process.env.KOED_HQ713_RESULT_OUTPUT;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  }
  assert.deepEqual(
    missing,
    [],
    "Every assigned real-service assertion must execute"
  );
  process.stdout.write(
    `HQ two-user integration: ${results.size} assertion records passed.\n`
  );
});

describe("HQ-713 real two-user Team backend", () => {
  it("links a real accepted invitation across separate Personal and Team databases", async () => {
    await withRecordedFixture(runHq713ShareOrigin);
  }, 180_000);

  it("shares the first future chat after an empty policy review", async () => {
    await withRecordedFixture(runHq713FuturePolicy);
  }, 180_000);

  const firstShareCases = [
    [
      "recovers an uncertain first-share reply after Personal API restart",
      runHq713FirstShareReplyReplay
    ],
    ["rejects first-share target drift", runHq713FirstShareTargetMismatch],
    [
      "fences delayed first-share creation after cancellation",
      runHq713FirstShareDelayedCreate
    ],
    [
      "recovers a deleted Team copy before Personal confirmation",
      runHq713FirstShareDeleteBeforeConfirm
    ],
    [
      "reconciles Team deletion after Personal confirmation",
      runHq713FirstShareDeleteAfterConfirm
    ],
    [
      "preserves and safely recovers an unconfirmed attempt after Workspace access loss",
      runHq713FirstShareAccessLossBeforeConfirm
    ],
    [
      "reconciles Workspace access loss after Personal confirmation",
      runHq713FirstShareAccessLossAfterConfirm
    ]
  ] as const;
  it.each(firstShareCases)(
    "%s",
    async (_label, run) => {
      await withRecordedFixture(run);
    },
    180_000
  );

  it("shares, recalls, revokes, and restores through listening production APIs", async () => {
    await withRecordedFixture(async (fixture) => {
      assert.ok(fixture.ids.teamId);
      assert.ok(fixture.ids.workspaceId);
      assert.ok(fixture.ids.workspaceProjectId);
      await runHq713ShareAndJoin(fixture);
      await runHq713LiveWorkItemCas(fixture);
      await runHq713PrivateAgentBoundary(fixture);
      await runHq713OfflineReadOnly(fixture);
      await runHq713InterruptedFirstShare(fixture);

      const shared = await runHq713MemoryN2(fixture);
      await runHq713MemoryStep3(fixture, shared);
      const leased = await createHq713LeasedExecution(fixture);
      await runHq713RuntimeSelectorControl(fixture, leased);
      await runHq713AiClientUsageBoundary(fixture);
      const managed = await runHq713ManagedCitationControl(
        fixture,
        shared,
        leased
      );
      const questionIds = await runHq713MemoryCitationControl(fixture, shared);
      await runHq713MemoryN5(fixture);
      await runHq713MemorySelectorControl(fixture);
      await runHq713Decks(fixture);

      if (process.env.KOED_HQ713_DESKTOP === "1") {
        await runHq713DesktopProof(fixture);
        fixture.results.record("I713.Native", {
          users: ["Alice", "Bob"],
          realIpc: true,
          realHttp: true,
          cachedOfflineReadOnly: true
        });
      }
      await runHq713MemoryStep6(fixture, shared);
      await runHq713ManagedCitationRevocationControl(fixture, managed);
      await runHq713MemoryCitationRevocationControl(fixture, questionIds);
      await runHq713ChatDeleteFreeze(fixture);
      await runHq713DeleteRestore(fixture);
    });
  }, 360_000);

  it("requires separate consent for exact-Session Curated sharing and scope withdrawal", async () => {
    await withRecordedFixture(async (fixture) => {
      const curated = await runHq713MemoryStep12(fixture);
      await runHq713MemoryScopeChangeControl(fixture, curated);
    });
  }, 180_000);

  it("keeps Team leave and frozen grants isolated from prior deletion", async () => {
    await withRecordedFixture(async (fixture) => {
      await runHq713Leave(fixture);
    });
  }, 180_000);

  it("copies a last owner's Team Project back exactly once", async () => {
    await withRecordedFixture(async (fixture) => {
      await runHq713OwnedLeave(fixture);
    });
  }, 180_000);
});
