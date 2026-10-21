// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { KoedTextActionProjection } from "@koed/shared";
import type { ManagedTextActionDesktopApi } from "../../../ipc/managed-text-action-protocol.js";
import { ManagedTextActions } from "./ManagedTextActions.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const owner = "11111111-1111-4111-8111-111111111111";
const execution = "22222222-2222-4222-8222-222222222222";
const action: KoedTextActionProjection = {
  id: "33333333-3333-4333-8333-333333333333",
  effectKey: "33333333-3333-4333-8333-333333333333",
  ownerUserId: owner,
  logicalSessionId: "44444444-4444-4444-8444-444444444444",
  executionId: execution,
  commandId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
  providerTurnId: "turn-1",
  toolCallId: "tool-1",
  name: "koed_project_create",
  arguments: { name: "Research" },
  snapshot: {},
  state: "awaiting_review",
  revision: 1,
  reviewKind: "ask_first",
  createdAt: "2026-10-20T12:00:00Z",
  decidedAt: null
};

it("shows exact Scheduled Job approval facts before the decision", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const jobAction: KoedTextActionProjection = {
    ...action,
    name: "koed_job_create",
    arguments: {
      title: "Morning brief",
      instruction: "Brief me on AI news\nInclude sources.",
      schedule: { kind: "weekdays", at: "08:00", tz: "Europe/Oslo" }
    },
    snapshot: {
      agentId: "66666666-6666-4666-8666-666666666666",
      agentName: "Quinn",
      conversationSessionId: "77777777-7777-4777-8777-777777777777",
      projectName: "Research archive",
      projectVersion: 2
    }
  };
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn(async () => [jobAction]),
    get: vi.fn(),
    review: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(),
    applyTeamTodoAdd: vi.fn()
  };
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          profileKey="profile-a"
        />
      )
    );
    const review = container.querySelector(".hq-text-action__job-review");
    expect(review?.textContent).toContain(
      "Every weekday at 08:00 (Europe/Oslo)"
    );
    expect(review?.textContent).toContain("Next");
    expect(review?.textContent).toContain(
      "Brief me on AI news\nInclude sources."
    );
    const facts = Object.fromEntries(
      [...review!.querySelectorAll("div")].map((row) => [
        row.querySelector("dt")?.textContent,
        row.querySelector("dd")?.textContent
      ])
    );
    expect(facts.Results).toBe("this chat");
    expect(facts.Project).toBe("Research archive");
    expect(container.textContent).toContain("Quinn");
    expect(container.querySelector("button")?.textContent).toBe("Approve");
    expect(review?.textContent).not.toContain(
      "77777777-7777-4777-8777-777777777777"
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("asks once, claims before the button service, and records only a verified result", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const order: string[] = [];
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn().mockResolvedValue([action]),
    get: vi.fn(),
    review: vi.fn(async () => {
      order.push("review");
      return { ...action, state: "ready" as const, revision: 2 };
    }),
    claim: vi.fn(async () => {
      order.push("claim");
      return { ...action, state: "claimed" as const, revision: 3 };
    }),
    complete: vi.fn(async () => {
      order.push("complete");
      return { ...action, state: "applied" as const, revision: 4 };
    }),
    applyTeamTodoAdd: vi.fn()
  };
  const onApply = vi.fn(async () => {
    order.push("effect");
    return true;
  });
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          profileKey="profile-a"
          onApply={onApply}
        />
      )
    );
    expect(container.textContent).toContain("Research");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button")!.click()
    );
    expect(order).toEqual(["review", "claim", "effect", "complete"]);
    expect(container.textContent).toContain("Done");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("does not replay an uncertain claimed effect on poll or profile switch", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current: KoedTextActionProjection = {
    ...action,
    name: "koed_todo_add",
    arguments: {
      projectId: "66666666-6666-4666-8666-666666666666",
      title: "Read chapter 4"
    },
    snapshot: {
      projectId: "66666666-6666-4666-8666-666666666666",
      projectVersion: 1
    },
    state: "ready",
    reviewKind: "none"
  };
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn(async () => [current]),
    get: vi.fn(),
    review: vi.fn(),
    claim: vi.fn(async () => {
      current = { ...current, state: "claimed", revision: 2 };
      return current;
    }),
    complete: vi.fn().mockRejectedValue(new Error("no exact receipt")),
    applyTeamTodoAdd: vi.fn()
  };
  const onApply = vi.fn().mockRejectedValue(new Error("lost response"));
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          profileKey="profile-a"
          onApply={onApply}
        />
      )
    );
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "will not run it again automatically"
    );
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          profileKey="profile-b"
          onApply={onApply}
        />
      )
    );
    // A changed profile reloads authority; no old claimed effect is replayed.
    expect(api.claim).toHaveBeenCalledTimes(1);
    expect(api.complete).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("reconciles a partially completed button effect without issuing it twice", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ready = {
    ...action,
    state: "ready" as const,
    reviewKind: "none" as const
  };
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn(async () => [ready]),
    get: vi.fn(),
    review: vi.fn(),
    claim: vi.fn(async () => ({
      ...ready,
      state: "claimed" as const,
      revision: 2
    })),
    complete: vi.fn(async () => ({
      ...ready,
      state: "applied" as const,
      revision: 3
    })),
    applyTeamTodoAdd: vi.fn()
  };
  const onApply = vi.fn(async () => false);
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          profileKey="profile-a"
          onApply={onApply}
        />
      )
    );
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(api.complete).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Done");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("reports opening a composer without claiming a Conversation was persisted", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ready = {
    ...action,
    name: "koed_chat_create" as const,
    arguments: {},
    state: "ready" as const,
    reviewKind: "none" as const
  };
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn(async () => [ready]),
    get: vi.fn(),
    review: vi.fn(),
    claim: vi.fn(async () => ({
      ...ready,
      state: "claimed" as const,
      revision: 2
    })),
    complete: vi.fn(async () => ({
      ...ready,
      state: "applied" as const,
      revision: 3,
      uiOutcome: "opened_composer" as const
    })),
    applyTeamTodoAdd: vi.fn()
  };
  const onApply = vi.fn(async () => true);
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          profileKey="profile-a"
          onApply={onApply}
        />
      )
    );
    expect(onApply).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Composer opened");
    expect(container.textContent).not.toContain("Conversation created");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("checks a reloaded claimed durable action without claiming or replaying its effect", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const claimed = { ...action, state: "claimed" as const, revision: 3 };
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn(async () => [claimed]),
    get: vi.fn(async () => claimed),
    review: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(async () => ({
      ...claimed,
      state: "applied" as const,
      revision: 4
    })),
    applyTeamTodoAdd: vi.fn()
  };
  const onApply = vi.fn(async () => true);
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          onApply={onApply}
        />
      )
    );
    expect(container.textContent).toContain("Check result");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button")!.click()
    );
    expect(api.get).toHaveBeenCalledWith(execution, claimed.id);
    expect(api.complete).toHaveBeenCalledWith(execution, claimed.id, 3);
    expect(api.claim).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Done");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("continues only an existing reviewed move after reload", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const claimed = {
    ...action,
    name: "koed_chat_move" as const,
    arguments: {
      sessionId: "66666666-6666-4666-8666-666666666666",
      projectId: "77777777-7777-4777-8777-777777777777"
    },
    snapshot: {
      chatTitle: "Planning",
      sourceProjectName: "Shared",
      projectName: "Personal"
    },
    state: "claimed" as const,
    revision: 3
  };
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn(async () => [claimed]),
    get: vi.fn(async () => claimed),
    review: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(async () => ({
      ...claimed,
      state: "applied" as const,
      revision: 4
    })),
    applyTeamTodoAdd: vi.fn()
  };
  const onApply = vi.fn(async () => true);
  const onResumeMove = vi.fn(async () => true);
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          onApply={onApply}
          onResumeMove={onResumeMove}
        />
      )
    );
    expect(container.textContent).toContain("Planning: Shared → Personal");
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Continue reviewed move")
    );
    await act(async () => button!.click());
    expect(onResumeMove).toHaveBeenCalledWith(claimed);
    expect(api.complete).toHaveBeenCalledWith(execution, claimed.id, 3);
    expect(api.claim).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("leaves a claimed action uncertain when no exact receipt exists; UI effects get no recovery button", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const claimed = { ...action, state: "claimed" as const, revision: 3 };
  const api: ManagedTextActionDesktopApi = {
    list: vi.fn(async () => [claimed]),
    get: vi.fn(async () => claimed),
    review: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn().mockRejectedValue(new Error("receipt missing")),
    applyTeamTodoAdd: vi.fn()
  };
  const onApply = vi.fn(async () => true);
  try {
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          onApply={onApply}
        />
      )
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button")!.click()
    );
    expect(container.textContent).toContain("exact effect is not confirmed");
    expect(api.claim).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={api}
          executionId={execution}
          ownerId={owner}
          profileKey="fresh"
          onApply={onApply}
        />
      )
    );
    expect(onApply).not.toHaveBeenCalled();
    expect(api.claim).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <ManagedTextActions
          api={{
            ...api,
            list: vi.fn(async () => [
              { ...claimed, name: "koed_chat_create" as const }
            ])
          }}
          executionId={execution}
          ownerId={owner}
          profileKey="ui"
          onApply={onApply}
        />
      )
    );
    expect(container.textContent).not.toContain("Check result");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
