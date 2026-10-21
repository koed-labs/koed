// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedSharingReason } from "@koed/shared/collaboration";
import { OwnedSharingReasons } from "./OwnedSharingReasons.js";

const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
});

describe("owner sharing explanation", () => {
  it.each([
    ["fixed_snapshot", "Fixed snapshot. Later content is not included."],
    ["active", "Updates active for this Conversation only."],
    ["paused", "Updates paused. Previously authorized content remains shared."],
    ["stopped", "Sharing stopped. This reason no longer grants access."],
    ["expired", "Consent expired. This reason no longer grants access."]
  ] as const)(
    "explains %s without treating source access as shared detail",
    async (updateState, explanation) => {
      const reason: OwnedSharingReason = {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "direct",
        rule: null,
        consentId: "00000000-0000-4000-8000-000000000002",
        consentVersion: 1,
        mode: updateState === "fixed_snapshot" ? "snapshot" : "continuous",
        updateState,
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false,
        permittedRepresentations: ["lcm_leaves", "lcm_rollups"],
        maximumAuthorizedSourceRevision:
          updateState === "fixed_snapshot" ? 3 : null,
        expiresAt: null,
        repositorySnapshot: {
          version: 1,
          classification: "unresolved",
          fingerprint: null,
          label: null,
          branchObservation: null
        },
        repositorySnapshotSourceRevision: 3,
        publishedRepresentations: [
          {
            representation: "lcm_leaves",
            sourceRevision: 3,
            recordVersion: 1,
            state: "available"
          }
        ]
      };
      root = createRoot(host);
      await act(async () =>
        root.render(
          <OwnedSharingReasons
            reasons={[reason]}
            pending={false}
            representationLabel={(value) => value}
          />
        )
      );
      expect(host.textContent).toContain(explanation);
      expect(host.textContent).toContain("lcm_leaves at revision 3");
      expect(host.textContent).toContain(
        "Conversation Source Access requires separate authorization."
      );
      expect(host.textContent).not.toContain("memory_events");
    }
  );

  it("explains a preparing share without claiming publication", async () => {
    root = createRoot(host);
    await act(async () =>
      root.render(
        <OwnedSharingReasons
          reasons={[]}
          pending
          representationLabel={(value) => value}
        />
      )
    );
    expect(host.textContent).toContain(
      "No Workspace content access has been granted yet."
    );
  });
  it.each(["captured_session", "repository", "folder", "project"] as const)(
    "keeps Team state visible while an exact %s rule stop awaits acknowledgment",
    async (selectorKind) => {
      const reason: OwnedSharingReason = {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "rule",
        rule: {
          id: "00000000-0000-4000-8000-000000000003",
          selectorKind,
          authorityVersion: 2,
          publisherFence: 1,
          state: "active",
          catchUpState: "needs_attention",
          failureCode: "preparation_failed"
        },
        consentId: "00000000-0000-4000-8000-000000000002",
        consentVersion: 1,
        mode: "continuous",
        updateState: "active",
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false,
        permittedRepresentations: ["lcm_leaves"],
        maximumAuthorizedSourceRevision: null,
        expiresAt: null,
        repositorySnapshot: {
          version: 1,
          classification: "unresolved",
          fingerprint: null,
          label: null,
          branchObservation: null
        },
        repositorySnapshotSourceRevision: null,
        publishedRepresentations: []
      };
      const controlIntent = {
        mutationId: crypto.randomUUID(),
        teamId: crypto.randomUUID(),
        teamWorkspaceId: crypto.randomUUID(),
        ruleId: reason.rule!.id,
        expectedAuthorityVersion: 2,
        controlAction: "stop" as const,
        ...(selectorKind === "captured_session"
          ? {
              shareGrantId: crypto.randomUUID(),
              reasonId: reason.id,
              expectedGrantVersion: 4
            }
          : { selectorKind: "selection" as const, publisherFence: 1 })
      };
      const onControl = vi.fn();
      root = createRoot(host);
      const render = async (queued: boolean) =>
        act(async () =>
          root.render(
            <OwnedSharingReasons
              reasons={[reason]}
              pending={false}
              onControl={onControl}
              representationLabel={(value) => value}
              deliveries={
                queued
                  ? [
                      {
                        intent: controlIntent,
                        presentation: {
                          sourceTitle: "Conversation",
                          teamName: "Team",
                          workspaceName: "Workspace"
                        },
                        state: "queued",
                        control: null,
                        creation: null,
                        failureCode: "offline",
                        updatedAt: new Date().toISOString()
                      }
                    ]
                  : []
              }
            />
          )
        );
      await render(false);
      expect(
        [...host.querySelectorAll("button")].map((button) => button.textContent)
      ).toEqual(["Pause updates", "Retry catch-up", "Stop this rule"]);
      await act(async () => host.querySelectorAll("button")[2]!.click());
      expect(onControl).toHaveBeenCalledWith(reason, "stop");
      await render(true);
      expect(
        [...host.querySelectorAll("button")].every((button) => button.disabled)
      ).toBe(true);
      expect(host.textContent).toContain(
        selectorKind === "captured_session"
          ? "Updates active for this Conversation only."
          : selectorKind === "folder"
            ? "Updates active for eligible Conversations in this exact Folder."
            : selectorKind === "project"
              ? "Updates active while this Conversation remains in the private Project."
              : "Updates active for eligible Conversations matching this Git Anchor."
      );
      expect(host.textContent).toContain(
        "Team access may remain until acknowledged."
      );
      expect(host.textContent).not.toContain("Sharing stopped.");
    }
  );
});
