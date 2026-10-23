// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationSharingRuleCreationReviewSchema,
  ownedSharingReasonSchema,
  sharedMemoryCandidatePreviewSchema,
  sharedMemoryPreviewSchema,
  sharingRuleDeliverySchema
} from "@koed/shared";
import { SnapshotConversionReview } from "./SnapshotConversionReview.js";

type Client = Parameters<typeof SnapshotConversionReview>[0]["client"];
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64);
const at = "2026-10-21T12:00:00.000Z";
const source = {
  kind: "captured_session" as const,
  sessionId: id(3),
  logicalMemoryId: id(4)
};
const reason = ownedSharingReasonSchema.parse({
  id: id(1),
  consentId: id(2),
  consentVersion: 1,
  kind: "direct",
  rule: null,
  mode: "snapshot",
  updateState: "fixed_snapshot",
  maximumFidelity: "lcm_rollups",
  includeCuratedMemory: false,
  permittedRepresentations: ["lcm_rollups"],
  maximumAuthorizedSourceRevision: 1,
  expiresAt: null,
  repositorySnapshot: {
    version: 1,
    classification: "unresolved",
    fingerprint: null,
    label: null,
    branchObservation: null
  },
  repositorySnapshotSourceRevision: 1,
  publishedRepresentations: []
});
const item = {
  id: id(8),
  representation: "lcm_rollups",
  sequence: 1,
  occurredAt: at,
  summaryText: "Current eligible summary",
  lexicalAnchors: [],
  sourceCount: 1,
  sourceRevision: hash
};
const candidate = sharedMemoryCandidatePreviewSchema.parse({
  source,
  logicalMemoryId: source.logicalMemoryId,
  sourceCapabilities: ["lcm_rollups"],
  activationRepresentation: "lcm_rollups",
  mode: "continuous",
  expiresAt: null,
  sourceRevision: 2,
  candidateHash: hash,
  itemCount: 1,
  excludedItemCount: 0,
  manifest: [{ sourceId: item.id, revisionHash: hash }],
  byteCount: 128,
  items: [item]
});
const preview = sharedMemoryPreviewSchema.parse({
  source,
  logicalMemoryId: source.logicalMemoryId,
  teamId: id(5),
  workspaceId: id(6),
  sourceCapabilities: ["lcm_rollups"],
  activationRepresentation: "lcm_rollups",
  maximumFidelity: "lcm_rollups",
  includeCuratedMemory: false,
  mode: "continuous",
  previewRevision: 1,
  sourceRevision: 2,
  policyRevision: 1,
  contentPolicyVersion: 1,
  classifierVersion: 1,
  sourceContentHash: hash,
  previewHash: hash,
  itemCount: 1,
  items: [item],
  nextCursor: null
});
const review = () =>
  conversationSharingRuleCreationReviewSchema.parse({
    snapshotReasonId: reason.id,
    snapshotConversion: {
      reasonId: reason.id,
      consentId: reason.consentId,
      consentVersion: reason.consentVersion,
      sourceRevision: 1,
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      expiresAt: null
    },
    previewId: id(9),
    previewHash: hash,
    previewRevision: 1,
    logicalMemoryId: source.logicalMemoryId,
    teamId: id(5),
    teamWorkspaceId: id(6),
    source,
    sourceTitle: "Conversation",
    teamName: "Team",
    workspaceName: "Engineering",
    logicalGrantId: id(10),
    expectedGrantVersion: 8,
    effectivePrivacyPolicyHash: hash,
    maximumFidelity: "lcm_rollups",
    includeCuratedMemory: false,
    activationRepresentation: "lcm_rollups",
    sourceCapabilities: ["lcm_rollups"],
    expiresAt: null,
    reviewExpiresAt: new Date(Date.now() + 60_000).toISOString()
  });
const fixture = () => ({
  previewSharedMemoryCandidate: vi.fn<Client["previewSharedMemoryCandidate"]>(
    async () => candidate
  ),
  previewSharedMemory: vi.fn<Client["previewSharedMemory"]>(
    async () => preview
  ),
  reviewConversationRuleCreation: vi.fn<
    Client["reviewConversationRuleCreation"]
  >(async () => review()),
  createConversationRule: vi.fn<Client["createConversationRule"]>(
    async (input) => {
      const { workspaceId, ...intent } = input;
      return sharingRuleDeliverySchema.parse({
        intent: { ...intent, teamWorkspaceId: workspaceId },
        presentation: {
          sourceTitle: "Conversation",
          teamName: "Team",
          workspaceName: "Engineering"
        },
        state: "queued",
        control: null,
        creation: null,
        failureCode: null,
        updatedAt: new Date().toISOString()
      });
    }
  )
});
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});
const mount = async (client: Client) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onDelivery = vi.fn();
  await act(async () =>
    root!.render(
      <SnapshotConversionReview
        client={client}
        source={source}
        reason={reason}
        grantVersion={8}
        teamId={id(5)}
        workspaceId={id(6)}
        disabled={false}
        onDelivery={onDelivery}
      />
    )
  );
  return onDelivery;
};
const click = async (text: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
describe("snapshot conversion review", () => {
  it("prepares the same source and destination, then submits only its exact reviewed conversion", async () => {
    const client = fixture(),
      onDelivery = await mount(client);
    await click("Convert snapshot to continuous sharing");
    expect(client.createConversationRule).not.toHaveBeenCalled();
    expect(client.previewSharedMemory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source,
        teamId: id(5),
        workspaceId: id(6),
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        mode: "continuous",
        candidate: expect.objectContaining({ expiresAt: reason.expiresAt })
      })
    );
    expect(
      client.reviewConversationRuleCreation
    ).toHaveBeenCalledExactlyOnceWith({
      snapshotReasonId: reason.id,
      previewHash: hash,
      previewRevision: 1,
      logicalMemoryId: source.logicalMemoryId,
      teamId: id(5),
      workspaceId: id(6)
    });
    expect(container.textContent).toContain("snapshot stays available");
    await click("Review snapshot conversion");
    expect(client.createConversationRule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source,
        teamId: id(5),
        workspaceId: id(6),
        mode: "continuous",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        expectedGrantVersion: 8,
        snapshotConversion: review().snapshotConversion
      })
    );
    const submitted = client.createConversationRule.mock.calls[0]![0];
    expect(submitted).not.toHaveProperty("teamWorkspaceId");
    expect(submitted).not.toHaveProperty("sourceTitle");
    expect(submitted).not.toHaveProperty("snapshotReasonId");
    expect(onDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: "queued" })
    );
  });
  it("rejects a changed snapshot scope before requesting conversion approval", async () => {
    const client = fixture();
    client.reviewConversationRuleCreation.mockResolvedValue({
      ...review(),
      snapshotConversion: { ...review().snapshotConversion!, consentVersion: 2 }
    });
    await mount(client);
    await click("Convert snapshot to continuous sharing");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(client.createConversationRule).not.toHaveBeenCalled();
  });
  it("requires a new review after approval or execution fails", async () => {
    const client = fixture();
    client.createConversationRule.mockRejectedValue(
      new Error("Snapshot changed")
    );
    await mount(client);
    await click("Convert snapshot to continuous sharing");
    await click("Review snapshot conversion");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.textContent).not.toContain("Review snapshot conversion");
    expect(client.createConversationRule).toHaveBeenCalledOnce();
  });
});
