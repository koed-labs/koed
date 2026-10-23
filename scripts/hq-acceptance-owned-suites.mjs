// HQ-901 approved non-simulated acceptance claims. This is a traceability
// registry, not evidence that a test ran: the coordinator must match exact
// Vitest titles, reject skipped/pending cases, and require HQ-713 record IDs.
// An empty `proof` or nonempty `unresolvedClauses` is an explicit gap and must
// fail the acceptance gate even when every listed adjacent test passes.
const real = "apps/api/tests/hq-integration/hq713-two-user.integration.ts";
const main =
  "shares, recalls, revokes, and restores through listening production APIs";
const curated =
  "requires separate consent for exact-Session Curated sharing and scope withdrawal";
const leave = "keeps Team leave and frozen grants isolated from prior deletion";
const ownedLeave = "copies a last owner's Team Project back exactly once";
// `title` is the exact leaf title. Match it uniquely within `file` in the
// Vitest JSON result; a duplicate title must fail rather than select a pass.
const unit = (file, title) => ({
  kind: "vitest",
  file,
  title,
  titleMatch: "exact-leaf-unique-in-file"
});
const hq521Native = (assertion) => ({
  key: `HQ-521 native ${assertion}`,
  runner: "apps/desktop/scripts/validate-hq521-native.mjs",
  reportPath: "scratch/hq-521/HQ521.native.json",
  proofId: assertion
});
const integration = (title, record) => ({
  kind: "hq713-record",
  file: real,
  title,
  record
});

export const ownedAcceptanceSuites = [
  {
    id: "I720.1",
    clause: "Project departure retains recall and the current Team byline.",
    proof: [
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.1"
      },
      {
        runner: "apps/desktop/scripts/validate-hq726-native.mjs",
        reportPath: "scratch/hq-726/HQ726.native.json",
        proofId: "I720.1.presentation"
      }
    ]
  },
  {
    id: "I720.2",
    clause:
      "Project chat and Note author revocation is refused while transcript access can be separately revoked.",
    proof: [
      unit(
        "apps/api/src/high-risk/shared-memory-action-definitions.test.ts",
        "steps up source sharing and uses Native review for source revocation"
      ),
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.2.chat"
      },
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.2.note"
      },
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.2.transcript"
      }
    ]
  },
  {
    id: "I720.3",
    clause:
      "Native-reviewed current Project owner removes exactly one frozen contribution with one replayable audited receipt.",
    proof: [
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.3"
      }
    ]
  },
  {
    id: "I720.4",
    clause: "Independent non-Project grants remain author-revocable.",
    proof: [
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.4"
      }
    ]
  },
  {
    id: "I720.5",
    clause:
      "Source metadata deletion hides/freezes its Note while retained content and other contributions stay independent.",
    proof: [
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.5"
      }
    ]
  },
  {
    id: "I720.6",
    clause:
      "Team departure retains others recall, updates attribution and denies the departed author.",
    proof: [
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.6"
      },
      {
        runner: "apps/desktop/scripts/validate-hq726-native.mjs",
        reportPath: "scratch/hq-726/HQ726.native.json",
        proofId: "I720.6.presentation"
      }
    ]
  },
  {
    id: "N726.14",
    clause:
      "Only the current Project owner can remove exact contributions, with stale requests and author revokes failing closed.",
    proof: [
      {
        kind: "vitest",
        file: "packages/db/src/workspace-project-grant-lifecycle.test.ts",
        title:
          "keeps chat and Note Project grants against author revoke and atomically removes one by current Project owner",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.3"
      }
    ]
  },
  {
    id: "N726.15",
    clause:
      "Current Team departure denies author recall at the boundary while keeping published contributions.",
    proof: [
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.6"
      }
    ]
  },
  {
    id: "N726.31",
    clause:
      "Note-only canonical event fallback never exposes captured transcripts; Source metadata removal preserves its contribution.",
    proof: [
      {
        kind: "vitest",
        file: "apps/api/src/team/workspace-project-contributions-routes.test.ts",
        title:
          "shows a validated Note event but never falls back to captured-chat raw events",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "hq713-record",
        file: "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
        title:
          "keeps Project contributions through departure and owner-reviewed removal",
        record: "I720.5"
      }
    ]
  },
  {
    id: "U726.1",
    clause:
      "The HQ panel keeps Team contributions read-only and scopes Personal memory independently.",
    proof: [
      {
        kind: "vitest",
        file: "apps/desktop/src/renderer/hq/memory/WhatKoedKnows.test.tsx",
        title:
          "labels a retained Team contribution only after current group membership ends",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        runner: "apps/desktop/scripts/validate-hq726-native.mjs",
        reportPath: "scratch/hq-726/HQ726.native.json",
        proofId: "Me.unscoped.isolation"
      },
      {
        runner: "apps/desktop/scripts/validate-hq726-native.mjs",
        reportPath: "scratch/hq-726/HQ726.native.json",
        proofId: "late.scope.response"
      }
    ]
  },
  {
    id: "U722.1",
    clause:
      "Sharing metadata reflects current Project/Team visibility and effective removal/cancellation authority.",
    proof: [
      {
        kind: "vitest",
        file: "apps/api/src/team/sharing-read.pg.test.ts",
        title:
          "uses Team membership authority, Project owner visibility and metadata-only output",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/api/src/team/sharing-read.test.ts",
        title: "projects only metadata and current Project owner authority",
        titleMatch: "exact-leaf-unique-in-file"
      }
    ]
  },
  {
    id: "N722.16",
    clause:
      "Team sharing never includes Personal Conversation content/ids; Personal enrichment is current-owner bound.",
    proof: [
      {
        kind: "vitest",
        file: "packages/shared/src/local-edge-upstream-registry.test.ts",
        title: "keeps legacy and malformed source owner bindings unbound",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "packages/koed-server/src/upstream-enrollment.test.ts",
        title:
          "authenticates replacement enrollment as an exact predecessor rotation",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "packages/koed-server/src/upstream-enrollment.test.ts",
        title:
          "recovers a replacement interrupted after successor commit without deleting it",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "packages/shared/src/sharing-contract.test.ts",
        title:
          "rejects a Personal Conversation id at every Team origin nesting",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/api/src/local-edge/sharing-routes.test.ts",
        title:
          "rejects a Team response containing a Personal Conversation origin",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/api/src/local-edge/sharing-routes.test.ts",
        title:
          "redacts the inviter's Agent name from pending incoming invitations",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/api/src/local-edge/sharing-routes.test.ts",
        title:
          "fails the whole read when the current Personal profile changes during an upstream await",
        titleMatch: "exact-leaf-unique-in-file"
      }
    ]
  },
  {
    id: "N722.27",
    clause:
      "A failed or unenrolled backend remains explicit beside available backends; live events queue a fresh read.",
    proof: [
      {
        kind: "vitest",
        file: "apps/api/src/local-edge/sharing-routes.test.ts",
        title:
          "retains an unavailable backend next to available metadata and does not reuse another owner's last reach",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/api/src/local-edge/sharing-routes.test.ts",
        title: "reports unenrolled and disabled-policy backends explicitly",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/desktop/src/renderer/hq/sharing/sharing-store.test.ts",
        title:
          "queues one refresh for collaboration invalidations received during a read",
        titleMatch: "exact-leaf-unique-in-file"
      }
    ]
  },
  {
    id: "N722.33",
    clause:
      "Cancellation capability follows current Team owner/admin authority, distinct from Project ownership.",
    proof: [
      {
        kind: "vitest",
        file: "apps/api/src/team/sharing-read.pg.test.ts",
        title:
          "uses Team membership authority, Project owner visibility and metadata-only output",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/api/src/team/sharing-read.test.ts",
        title:
          "limits cancellation to current Team managers and owner invitations to owners",
        titleMatch: "exact-leaf-unique-in-file"
      }
    ]
  },
  {
    id: "U722.2",
    clause:
      "Typed read-only Desktop IPC rejects untrusted senders and stale Personal authority.",
    proof: [
      {
        kind: "vitest",
        file: "apps/desktop/src/ipc/commands.test.ts",
        title: "accepts only trusted, read-only Sharing IPC requests",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/desktop/src/koed-server/manager-sharing.test.ts",
        title: "discards a pending read when the Personal origin changes",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/desktop/src/koed-server/manager-sharing.test.ts",
        title: "discards a pending read when the Personal owner changes",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/desktop/src/koed-server/manager-sharing.test.ts",
        title: "discards a pending read when the Personal credential changes",
        titleMatch: "exact-leaf-unique-in-file"
      },
      {
        kind: "vitest",
        file: "apps/desktop/src/koed-server/manager-sharing.test.ts",
        title: "returns a strict empty-backend read for unchanged authority",
        titleMatch: "exact-leaf-unique-in-file"
      }
    ]
  },
  {
    id: "U521.1",
    clause:
      "U1: Native Settings Agents puts usage above Connections and renders reported provider windows, bucket notes and restrictions.",
    proof: [
      hq521Native("U1"),
      unit(
        "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
        "keeps Codex windows and model buckets distinct"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
        "uses Claude allowed without inventing a percentage and identifies Opus"
      )
    ]
  },
  {
    id: "U521.2",
    clause:
      "U2: Native table reports age and source details, and refresh status reflects the actual Codex result.",
    proof: [
      hq521Native("U2"),
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageTable.test.tsx",
        "reports refresh outcomes truthfully"
      )
    ]
  },
  {
    id: "U521.3",
    clause:
      "U3: Native AI Client menu exposes usage lines and See usage opens Settings Agents.",
    proof: [
      hq521Native("U3"),
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageMenu.test.tsx",
        "shows a usage line under each AI Client and opens Settings usage"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageMenu.test.tsx",
        "colors the selected model's usage rather than the first model's usage"
      )
    ]
  },
  {
    id: "N521.19",
    clause:
      "N19: Providers with no reading show unknown or not shared without a fabricated percentage.",
    proof: [
      hq521Native("N19"),
      unit(
        "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
        "does not infer that a provider with no reading is fine"
      )
    ]
  },
  {
    id: "N521.24",
    clause:
      "N24: Passed resets and stale observations never appear as zero or current fine usage.",
    proof: [
      hq521Native("N24"),
      unit(
        "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
        "shows no percentage after reset or for unknown readings"
      )
    ]
  },
  {
    id: "N521.34",
    clause:
      "N34: Distinct reported buckets, restrictions and Claude overage remain conservative.",
    proof: [
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageTable.test.tsx",
        "keeps a selected model's five-hour Codex bucket beside the default window only"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
        "keeps Codex windows and model buckets distinct"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
        "keeps a more constrained global or overage weekly limit ahead of Opus"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
        "shows no percentage after reset or for unknown readings"
      )
    ]
  },
  {
    id: "N521.35",
    clause:
      "N35: Completion re-reads, authority changes discard late results, invalidation resets refresh, and listeners unsubscribe.",
    proof: [
      hq521Native("N35"),
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageTable.test.tsx",
        "subscribes before reading, then updates when a probe completes"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageTable.test.tsx",
        "drops a response from an earlier authority and unsubscribes"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageTable.test.tsx",
        "clears a pending refresh on account change and ignores its late checked result"
      ),
      unit(
        "apps/desktop/src/renderer/hq/usage/HqUsageTable.test.tsx",
        "clears pending refresh state when the usage stream invalidates"
      )
    ]
  },
  {
    id: "U520.1",
    clause:
      "Official provider usage remains separate by bucket/window and unknown evidence never looks fine.",
    proof: [
      unit(
        "packages/mcp-server/tests/ai-client-usage-readers.test.ts",
        "keeps every Codex bucket and window distinct with restrictions"
      ),
      unit(
        "packages/mcp-server/tests/ai-client-usage-readers.test.ts",
        "stores unknown Codex fields conservatively"
      ),
      unit(
        "packages/mcp-server/tests/ai-client-usage-readers.test.ts",
        "retains Claude model-specific and overage fields even without utilization"
      )
    ]
  },
  {
    id: "U520.2",
    clause:
      "A runtime completion traverses real Personal SSE and the typed Desktop preload boundary.",
    proof: [
      unit(
        "apps/api/src/server.test.ts",
        "delivers a runtime completion through Personal SSE and typed Desktop preload"
      ),
      unit(
        "packages/mcp-server/tests/codex-managed-conversation.test.ts",
        "reads post-turn account and limits through the still-open turn client"
      ),
      unit(
        "apps/worker/src/optional-codex-usage.test.ts",
        "preserves provider completion when the configured instance disappears"
      )
    ]
  },
  {
    id: "I520.1",
    clause:
      "Personal usage is isolated between owners and absent from Team storage and reads.",
    proof: [integration(main, "N21")]
  },
  {
    id: "U21.1",
    clause:
      "The same due_on is relative to each viewer's time zone without moving its stored calendar date.",
    proof: [
      unit(
        "apps/desktop/src/renderer/hq/due/hq-due-model.test.ts",
        "reads one calendar date in each viewer's time zone without moving its stored date"
      )
    ]
  },
  {
    id: "I03.1",
    clause:
      "Colleague work reveals a privacy note, safe status and step, with no private chat link or content.",
    proof: [
      unit(
        "apps/desktop/src/renderer/hq/shared-project/SharedProjectPanel.test.tsx",
        "shows safe colleague progress with a privacy note and no private chat link"
      ),
      integration(main, "HQ713-step5-private-agent-boundary")
    ]
  },
  {
    id: "I13.1",
    clause:
      "Share and join disclose summaries and yield Bob's own private HQ with a private welcome catch-up.",
    proof: [
      unit(
        "apps/api/src/managed-conversations/project-catch-up-route.test.ts",
        "queues a private HQ welcome catch-up from Team welcome due without exposing Team message text"
      ),
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "HQ713-step2-private-project-HQ"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I14.1",
    clause:
      "Real invitation and share effects: reviewed scope, accepted link, shared work and retained owner boundaries.",
    proof: [
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "HQ713-step4-work-item-CAS"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I724.2.data",
    clause:
      "Personal-only Share Origin links an accepted invitation to the backend-qualified Workspace Access key and grant version; re-grants preserve history and Team responses omit Conversation ids.",
    proof: [
      unit(
        "packages/db/src/personal-share-origin-repository.pg.test.ts",
        "keeps the chat local through invitation acceptance, later re-grant, and backend collision"
      ),
      unit(
        "apps/api/src/team/lifecycle-routes.test.ts",
        "serves accepted invitation grant version without the Personal Conversation id"
      ),
      integration(
        "links a real accepted invitation across separate Personal and Team databases",
        "I724.2.data.N17.separate-backends"
      )
    ]
  },
  {
    id: "I20.3",
    clause:
      "Team leave copies owned Project work back without removing retained shared evidence.",
    proof: [integration(leave, "I713.11"), integration(ownedLeave, "I713.14")]
  },
  {
    id: "I24.1",
    clause:
      "Deleted/left source grants pin the last authorized publication and do not resume on restore.",
    proof: [
      integration(main, "I24"),
      integration(main, "I713.8"),
      integration(main, "I713.9"),
      integration(leave, "I713.11")
    ]
  },
  {
    id: "I25.1",
    clause:
      "Owned leave copy-back resumes once; last-owner preflight blocks mutation until ownership transfer.",
    proof: [integration(ownedLeave, "I25"), integration(ownedLeave, "I713.14")]
  },
  {
    id: "I26.1",
    clause:
      "Shared deck/cards coexist with separate per-member progress and private Again learning.",
    proof: [
      integration(main, "I26"),
      integration(main, "I713.13"),
      integration(main, "I713.13.learning.alice"),
      integration(main, "I713.13.learning.bob")
    ]
  },
  {
    id: "I27.1",
    clause:
      "Explicit Curated consent admits only exact-session Project evidence and invalidates prior Team material on scope change.",
    proof: [
      integration(curated, "I27"),
      integration(curated, "I27.scope-change")
    ]
  },
  {
    id: "I28.1",
    clause:
      "Multiple persisted citations reload and reauthorize after Team revocation.",
    proof: [
      integration(main, "I28.question-history"),
      integration(main, "I28.question-history-revoked"),
      integration(main, "I28.managed-turn"),
      integration(main, "I28.managed-turn-revoked")
    ]
  },
  {
    id: "U29.1",
    clause:
      "Merge readiness drift conflicts; uncertain dispatch reconciles without another mutation.",
    proof: [
      unit(
        "apps/api/src/source-control/runtime.test.ts",
        "requires fresh review when checks change on the same head"
      ),
      unit(
        "apps/desktop/src/koed-server/source-control-merge-native-client.test.ts",
        "returns only the journal identity after an uncertain dispatch and never retries"
      ),
      unit(
        "apps/api/src/source-control/merge-provider-driver.test.ts",
        "does not credit another actor's merge after a dispatch timeout"
      )
    ]
  },
  {
    id: "I30.1",
    clause:
      "Trusted Personal selector includes linked Project plus Me; Team selector uses trusted global Workspace/backend fields and no personal project_id.",
    proof: [
      integration(main, "I30"),
      integration(main, "I30.runtime-selectors"),
      integration(main, "I30.runtime-Team-unavailable")
    ]
  },
  {
    id: "N1.U",
    clause:
      "With Team messages present, catch-up, memory proposal and agent-turn prompt spies see no Team message text.",
    proof: [
      unit(
        "apps/api/src/projects/project-catch-up.test.ts",
        "keeps finished Work Items and merged PRs out of Team catch-up prose"
      ),
      unit(
        "packages/mcp-server/tests/curated-memory-review-worker.test.ts",
        "excludes a Team message field from the actual Curated review agent prompt"
      ),
      unit(
        "apps/worker/src/memory-action-observer.test.ts",
        "creates a reviewed correction only from the exact captured User item"
      ),
      unit(
        "apps/worker/src/managed-conversation-service.test.ts",
        "excludes a present Team message from the actual managed provider turn"
      )
    ]
  },
  {
    id: "N2.I",
    clause: "Project Share Policy creates no Conversation Source Access.",
    proof: [integration(main, "N2")]
  },
  {
    id: "N3.U",
    clause:
      "Every merge needs fresh Native review even in Full access; drift, method policy, duplicate dispatch and uncertainty fail closed.",
    proof: [
      unit(
        "apps/desktop/src/koed-server/source-control-merge-native-client.test.ts",
        "never dispatches a merge when Native review is declined regardless of permission mode"
      ),
      unit(
        "apps/api/src/source-control/runtime.test.ts",
        "requires fresh review when checks change on the same head"
      ),
      unit(
        "apps/api/src/source-control/merge-provider-driver.test.ts",
        "uses the exact protected head, allowed method, complete readiness and no bypass"
      ),
      unit(
        "packages/db/src/source-control-merge-repository.test.ts",
        "claims one approval once and fences another approval for the same PR across processes"
      ),
      unit(
        "apps/desktop/src/koed-server/source-control-merge-native-client.test.ts",
        "returns only the journal identity after an uncertain dispatch and never retries"
      )
    ]
  },
  {
    id: "N4.U",
    clause:
      "Launched AI Client process receives no source-control credential in env or arguments.",
    proof: [
      unit(
        "packages/mcp-server/tests/ai-client-runner.test.ts",
        "passes only the bounded environment and removes provider credentials"
      ),
      unit(
        "packages/mcp-server/tests/ai-client-runner.test.ts",
        "spawns JavaScript Claude SDK entries through the trusted runtime"
      ),
      unit(
        "packages/mcp-server/tests/ai-client-runner.test.ts",
        "keeps source-control credentials out of the launched AI Client environment and arguments"
      ),
      unit(
        "packages/mcp-server/tests/pi-rpc-runner.test.ts",
        "uses minimal environment without Koed or provider credentials"
      )
    ]
  },
  {
    id: "N5.I",
    clause: "Owner Desktop cannot grant another member's Conversation.",
    proof: [integration(main, "N5")]
  },
  {
    id: "N6.I",
    clause: "Leave has no Undo; restore never revives frozen/revoked access.",
    proof: [
      unit(
        "apps/desktop/src/renderer/hq/HqTeamGroups.test.tsx",
        "shows the exact owned Project effect before the real leave action and offers no Undo"
      ),
      integration(main, "N6")
    ]
  },
  {
    id: "N7.U",
    clause:
      "Deleting a chat retains its Personal recall; Forget this chat removes it.",
    proof: [
      unit(
        "packages/db/src/chat-lifecycle.test.ts",
        "keeps owned recall after trash, excludes navigation, and restores within 30 days"
      ),
      unit(
        "packages/db/src/chat-lifecycle.test.ts",
        "forgets only Personal evidence and restores exact evidence on Undo"
      )
    ]
  },
  {
    id: "N8.I",
    clause:
      "Curated positive exact granted Conversation control passes; Me, unscoped, mixed-session and non-Conversation controls remain Personal.",
    proof: [integration(curated, "N8")]
  },
  {
    id: "N9.U",
    clause:
      "An open or closed-unmerged PR never marks Work Item Done; merged provider evidence is required.",
    proof: [
      unit(
        "apps/api/src/work-items/pr-reconciliation.pg.test.ts",
        "leaves an open PR In review and marks closed-unmerged Blocked"
      ),
      unit(
        "apps/api/src/work-items/pr-reconciliation.pg.test.ts",
        "moves a quiesced execution's item to Done only after provider merged reads, once"
      ),
      unit(
        "apps/api/src/work-items/pr-reconciliation.pg.test.ts",
        "captures an agent closing reply after the provider merge as one Personal Memory event"
      ),
      unit(
        "packages/db/tests/managed-conversation-citations.test.ts",
        "binds two trusted recalls to one durable turn and reloads after transient output deletion"
      )
    ]
  },
  {
    id: "N10.U",
    clause:
      "Two online devices cannot materialize or start the same scheduled run.",
    proof: [
      unit(
        "apps/api/src/scheduled-jobs/runtime-tick.test.ts",
        "only the assigned device materializes and an overlapping occurrence is skipped"
      ),
      unit(
        "apps/api/src/scheduled-jobs/runtime-tick.test.ts",
        "allows only one of two online devices to claim the same scheduled run"
      )
    ]
  },
  {
    id: "N11.T",
    clause:
      "Freeze linearizes with an in-flight publication, pins a closed frontier, leaves a second grant advancing, and denies revoked/suppressed/expired access.",
    proof: [
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "publishes an exact Project policy summary to a teammate but blocks a private source before activation"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "linearizes an in-flight legacy row writer with a whole-transaction freeze retry"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "rejects legacy READ COMMITTED and stale repeatable-read publication after freeze"
      ),
      unit(
        "packages/db/src/workspace-project-grant-lifecycle.test.ts",
        "atomically freezes all bound grants on owner delete and leaves independent grants active"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "invalidates the frozen copy when its exact sanitized preview is privacy-invalidated"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "keeps current consent expiry authoritative for a frozen representation"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "freezes a Memory Answer grant set while revocation and regrant fail closed"
      ),
      unit(
        "packages/db/src/shared-memory-preview-retry.test.ts",
        "retries a serialization conflict while the grant remains active"
      ),
      unit(
        "packages/db/src/shared-memory-preview-retry.test.ts",
        "does not hide an unexpected error behind a concurrent freeze"
      )
    ]
  },
  {
    id: "N11.I",
    clause:
      "Real-backend freeze retains Project contributions against author revoke; independent grant revoke, suppression and expiry still deny.",
    proof: [
      integration(
        "keeps Project contributions through departure and owner-reviewed removal",
        "I720.4"
      ),
      integration(
        "keeps Project contributions through departure and owner-reviewed removal",
        "I720.3"
      ),
      integration(main, "N11.post-freeze"),
      integration(main, "N11.in-flight-freeze"),
      integration(main, "N11.independent-grant"),
      integration(main, "N11.revocation"),
      integration(main, "N11.suppression"),
      integration(main, "N11.expiry"),
      integration(main, "I24")
    ]
  },
  {
    id: "N12.U",
    clause:
      "memory_forget ownership check never falls back from cited/latest teammate item to older owned item; ambiguity asks.",
    proof: [
      unit(
        "apps/worker/src/memory-action-observer.test.ts",
        "keeps latest cited teammate ownership and never mutates the older owned source"
      ),
      unit(
        "apps/worker/src/memory-action-observer.test.ts",
        "rejects a model-selected older alias against an unqualified User prompt"
      ),
      unit(
        "apps/worker/src/memory-action-selection.test.ts",
        "rejects unrendered and multiple explicit references"
      ),
      unit(
        "apps/worker/src/memory-action-selection.test.ts",
        "asks when the same displayed citation number occurs in multiple answers"
      )
    ]
  },
  {
    id: "N13.U",
    clause:
      "Source trash and Note revision Forget are independent; Source never marks Session personal_deleted_at; retry creates no duplicate Note revision or Memory Event.",
    proof: [
      unit(
        "apps/api/src/projects/source-ingestion.integration.test.ts",
        "ingests real PDF/DOCX and >32 KiB text into one event per actual Note revision"
      ),
      unit(
        "packages/db/src/project-source-repository.test.ts",
        "deletes only active references in its exact batch and Undo preserves prior trash"
      ),
      unit(
        "apps/api/src/work-items/from-document.integration.test.ts",
        "creates three Plan.md Work Items once and preserves their identities on repeat"
      )
    ]
  },
  {
    id: "I713.01",
    clause:
      "Alice shares landing; share review lists docs, to-dos and summaries.",
    proof: [
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I713.02",
    clause:
      "Bob accepts summary-sharing disclosure, sees Shared landing and private HQ.",
    proof: [
      integration(main, "I13-I14-step1-step2-share-join"),
      integration(main, "HQ713-step2-private-project-HQ"),
      integration(main, "I713.Native")
    ]
  },
  {
    id: "I713.03",
    clause:
      "Alice chat summary recalls with Team citation but no reachable transcript.",
    proof: [integration(main, "I713.3"), integration(main, "N2")]
  },
  {
    id: "I713.04",
    clause:
      "Both users see work-item updates; concurrent title edits conflict without loss.",
    proof: [integration(main, "HQ713-step4-work-item-CAS")]
  },
  {
    id: "I713.05",
    clause: "Alice sees Bob's agent work status/step only.",
    proof: [integration(main, "HQ713-step5-private-agent-boundary")]
  },
  {
    id: "I713.06",
    clause:
      "Making Alice chat private keeps its earlier summary in Bob's recall and excludes later messages.",
    proof: [integration(main, "I713.6")]
  },
  {
    id: "N26",
    clause:
      "Make private converges after one freeze, share again needs its own freeze, and historical frozen grants cause no conflict.",
    proof: [
      unit(
        "packages/db/src/project-share-policy-integration.test.ts",
        "requires freeze only for a live original policy grant and settles after its freeze"
      ),
      unit(
        "packages/db/src/project-share-policy-integration.test.ts",
        "settles multiple historical frozen grants and freezes a share-again grant once"
      ),
      unit(
        "packages/db/tests/shared-memory-repository.test.ts",
        "wakes pending activation for either semantic publication order and defers stale derivatives"
      ),
      integration(main, "N26")
    ]
  },
  {
    id: "I713.07",
    clause: "Offline Team backend makes Project read-only with notice.",
    proof: [integration(main, "HQ713-step7-Team-offline")]
  },
  {
    id: "I713.08",
    clause:
      "Delete removes Project from Bob, retains published recall and freezes Bob grants before later source.",
    proof: [integration(main, "I713.8"), integration(main, "N11.post-freeze")]
  },
  {
    id: "I713.09",
    clause:
      "Restore returns records and thread while Bob's moved chats/frozen grants stay detached.",
    proof: [integration(main, "I713.9"), integration(main, "N6")]
  },
  {
    id: "I713.10",
    clause: "Interrupted second share resumes without duplicates.",
    proof: [integration(main, "HQ713-step10-interrupted-first-share")]
  },
  {
    id: "I713.11",
    clause:
      "Team leave freezes Bob publication for Alice, denies Bob Alice recall; Project leave preserves membership.",
    proof: [
      integration(leave, "I713.11"),
      integration(leave, "I713.11.project-leave")
    ]
  },
  {
    id: "I713.12",
    clause:
      "Curated positive/negative eligibility, scope invalidation and trusted Personal/Team selectors.",
    proof: [
      integration(curated, "I713.12"),
      integration(curated, "I27.scope-change"),
      integration(main, "I30"),
      integration(main, "I30.runtime-selectors")
    ]
  },
  {
    id: "I713.13",
    clause: "Shared cards with member-private progress and Again learning.",
    proof: [
      integration(main, "I713.13"),
      integration(main, "I713.13.learning.alice"),
      integration(main, "I713.13.learning.bob")
    ]
  },
  {
    id: "I713.14",
    clause:
      "Owned leave resumes exact copy once and blocks last-owner until transfer and revalidation.",
    proof: [integration(ownedLeave, "I713.14"), integration(ownedLeave, "I25")]
  }
];
