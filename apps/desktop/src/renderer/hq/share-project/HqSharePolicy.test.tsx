// @vitest-environment happy-dom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import { HqSharePolicy } from "./HqSharePolicy.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "10000000-0000-4000-8000-000000000001";
const otherProjectId = "10000000-0000-4000-8000-000000000002";
const policy = (status: "absent" | "active" | "revoked") => ({
  projectId: "20000000-0000-4000-8000-000000000001",
  teamId: "30000000-0000-4000-8000-000000000001",
  workspaceId: "40000000-0000-4000-8000-000000000001",
  projectName: "Plan",
  policyVersion: status === "absent" ? 0 : 1,
  status,
  pendingAction: null,
  reviewRequired: false,
  manifestId: null,
  manifestHash: null,
  eligibleCount: 1,
  reviewSources: [
    {
      sessionId: "50000000-0000-4000-8000-000000000001",
      reviewLabel: "Planning chat · 20 Oct",
      eligible: true
    }
  ]
});
const stageResult = () => ({
  policy: policy("active"),
  initialStage: {
    stagedCount: 1,
    skippedCount: 0,
    pendingCount: 1,
    needsReviewCount: 1,
    items: [
      { label: "Planning chat · 20 Oct", state: "pending" as const },
      { label: "Updated chat", state: "needs_review" as const }
    ]
  }
});

describe("HQ Project summary policy", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (item) => item.textContent === label
    ) as HTMLButtonElement | undefined;

  it("offers exact Native review, leaves cancellation off, then retries and revokes future sharing", async () => {
    const status = vi.fn().mockResolvedValue(policy("absent"));
    const enable = vi
      .fn()
      .mockRejectedValueOnce(new Error("Project summary sharing was canceled."))
      .mockResolvedValueOnce(stageResult());
    const revoke = vi.fn().mockResolvedValue(policy("revoked"));
    const stage = vi.fn().mockResolvedValue({
      policy: policy("active"),
      initialStage: {
        stagedCount: 1,
        skippedCount: 0,
        pendingCount: 0,
        needsReviewCount: 1,
        items: [{ label: "Updated chat", state: "needs_review" }]
      }
    });
    const api = {
      sharedPolicyStatus: status,
      sharedPolicyEnable: enable,
      sharedPolicyRevoke: revoke,
      sharedPolicyStageInitial: stage
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqSharePolicy
          key="owner:project"
          identityKey="owner"
          personalProjectId={projectId}
          projectsApi={api}
          autoOfferToken="share-attempt"
        />
      )
    );
    expect(enable).toHaveBeenCalledWith(projectId);
    expect(enable).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Project summary sharing was canceled."
    );
    expect(button("Review summary sharing")).toBeDefined();
    expect(document.body.textContent).not.toContain(
      "50000000-0000-4000-8000-000000000001"
    );
    await act(async () => button("Review summary sharing")!.click());
    expect(enable).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Summary sharing policy is on");
    expect(document.body.textContent).toContain("1 pending");
    expect(document.body.textContent).toContain("Needs review");
    expect(document.body.textContent).toContain("Planning chat · 20 Oct");
    await act(async () => button("Retry pending summaries")!.click());
    expect(stage).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(document.body.textContent).toContain("0 pending");
    await act(async () => button("Stop future summary sharing")!.click());
    expect(revoke).toHaveBeenCalledWith(projectId);
    expect(document.body.textContent).toContain(
      "Existing grants keep their own consent"
    );
  });

  it("drops a previous owner or Project response before rendering private labels", async () => {
    let resolveOld!: (value: ReturnType<typeof policy>) => void;
    const oldStatus = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    const newStatus = vi
      .fn()
      .mockResolvedValue({ ...policy("absent"), reviewSources: [] });
    await act(async () =>
      root.render(
        <HqSharePolicy
          key="old"
          identityKey="old-profile"
          personalProjectId={projectId}
          projectsApi={
            { sharedPolicyStatus: oldStatus } as unknown as ProjectsDesktopApi
          }
        />
      )
    );
    await act(async () =>
      root.render(
        <HqSharePolicy
          key="new"
          identityKey="new-profile"
          personalProjectId={otherProjectId}
          projectsApi={
            { sharedPolicyStatus: newStatus } as unknown as ProjectsDesktopApi
          }
        />
      )
    );
    await act(async () => resolveOld(policy("active")));
    expect(newStatus).toHaveBeenCalledWith(otherProjectId);
    expect(document.body.textContent).not.toContain("Planning chat");
    expect(document.body.textContent).toContain("Summary sharing is off");
  });

  it("does not show prior Project labels while a reused panel awaits a new Native review", async () => {
    const status = vi.fn().mockResolvedValue(policy("active"));
    const enable = vi.fn().mockReturnValue(new Promise(() => undefined));
    const api = {
      sharedPolicyStatus: status,
      sharedPolicyEnable: enable
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqSharePolicy
          identityKey="first-owner"
          personalProjectId={projectId}
          projectsApi={api}
        />
      )
    );
    expect(document.body.textContent).toContain("Planning chat · 20 Oct");
    await act(async () =>
      root.render(
        <HqSharePolicy
          identityKey="second-owner"
          personalProjectId={otherProjectId}
          projectsApi={api}
          autoOfferToken="second-share"
        />
      )
    );
    expect(enable).toHaveBeenCalledWith(otherProjectId);
    expect(document.body.textContent).not.toContain("Planning chat · 20 Oct");
    expect(button("Stop future summary sharing")).toBeUndefined();
  });

  it("hides policy mutation controls after an uncertain broker failure until status is read again", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce(policy("active"))
      .mockResolvedValueOnce(policy("active"));
    const revoke = vi.fn().mockRejectedValue(new Error("Team connection lost"));
    const api = {
      sharedPolicyStatus: status,
      sharedPolicyRevoke: revoke
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqSharePolicy
          identityKey="owner"
          personalProjectId={projectId}
          projectsApi={api}
        />
      )
    );
    await act(async () => button("Stop future summary sharing")!.click());
    expect(document.body.textContent).toContain("Team connection lost");
    expect(button("Stop future summary sharing")).toBeUndefined();
    expect(button("Review summary sharing")).toBeUndefined();
    await act(async () => button("Check status again")!.click());
    expect(status).toHaveBeenCalledTimes(2);
    expect(button("Stop future summary sharing")).toBeDefined();
  });

  it("shows an unresolved exact policy attempt and allows only status retry", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ ...policy("active"), pendingAction: "revoke" })
      .mockResolvedValueOnce(policy("revoked"));
    const enable = vi.fn();
    const revoke = vi.fn();
    const stage = vi.fn();
    const api = {
      sharedPolicyStatus: status,
      sharedPolicyEnable: enable,
      sharedPolicyRevoke: revoke,
      sharedPolicyStageInitial: stage
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqSharePolicy
          identityKey="owner"
          personalProjectId={projectId}
          projectsApi={api}
        />
      )
    );
    expect(document.body.textContent).toContain(
      "Summary sharing revoke result is pending"
    );
    expect(button("Stop future summary sharing")).toBeUndefined();
    expect(button("Retry pending summaries")).toBeUndefined();
    expect(button("Review summary sharing")).toBeUndefined();
    await act(async () => button("Check status again")!.click());
    expect(status).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Summary sharing is off");
    expect(enable).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it("shows an ineligible reviewed chat as skipped rather than shared", async () => {
    const enable = vi.fn().mockResolvedValue({
      policy: policy("active"),
      initialStage: {
        stagedCount: 0,
        skippedCount: 1,
        pendingCount: 0,
        needsReviewCount: 0,
        items: [
          {
            label: "Planning chat · 20 Oct",
            state: "skipped",
            reason: "ineligible"
          }
        ]
      }
    });
    const api = { sharedPolicyEnable: enable } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqSharePolicy
          identityKey="owner"
          personalProjectId={projectId}
          projectsApi={api}
          autoOfferToken="first-share"
        />
      )
    );
    expect(enable).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(document.body.textContent).toContain("0 newly staged");
    expect(document.body.textContent).toContain(
      "Planning chat · 20 Oct · Skipped · No longer eligible for this summary offer"
    );
  });

  it("requires an old active policy to stop before fresh review and withholds staging", async () => {
    const status = vi
      .fn()
      .mockResolvedValue({ ...policy("active"), reviewRequired: true });
    const revoke = vi.fn().mockResolvedValue(policy("revoked"));
    const stage = vi.fn();
    const api = {
      sharedPolicyStatus: status,
      sharedPolicyRevoke: revoke,
      sharedPolicyStageInitial: stage
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqSharePolicy
          identityKey="owner"
          personalProjectId={projectId}
          projectsApi={api}
        />
      )
    );
    expect(document.body.textContent).toContain(
      "Review needed: stop this old summary policy, then review sharing again."
    );
    expect(button("Retry pending summaries")).toBeUndefined();
    expect(button("Stop future summary sharing")).toBeDefined();
    await act(async () => button("Stop future summary sharing")!.click());
    expect(revoke).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(stage).not.toHaveBeenCalled();
  });

  it("offers one Native review under React effect replay", async () => {
    const enable = vi.fn().mockResolvedValue(stageResult());
    const api = { sharedPolicyEnable: enable } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <StrictMode>
          <HqSharePolicy
            identityKey="owner"
            personalProjectId={projectId}
            projectsApi={api}
            autoOfferToken="first-share"
          />
        </StrictMode>
      )
    );
    expect(enable).toHaveBeenCalledExactlyOnceWith(projectId);
  });
});
