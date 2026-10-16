// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentTeamAvailability } from "./AgentTeamAvailability";

const { loadSession } = vi.hoisted(() => ({ loadSession: vi.fn() }));

vi.mock("@/lib/studio-collaboration-client", () => ({
  StudioCollaborationClient: class {
    loadSession() {
      return loadSession();
    }
  }
}));

vi.mock("@/lib/hosted-session", () => ({
  loadHostedSession: vi.fn()
}));

vi.mock("@/lib/team-agent-requests-client", () => ({
  TeamAgentRequestsClient: class {}
}));

vi.mock("@/components/TeamAgentOffers", () => ({
  TeamAgentOffers: ({
    teamName,
    authorityKey
  }: {
    teamName: string;
    authorityKey: string;
  }) => (
    <div data-testid="team-offer" data-authority-key={authorityKey}>
      {teamName}
    </div>
  )
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agentId = "agent-from-the-private-library";
let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  loadSession.mockReset();
  vi.unstubAllEnvs();
});

function studioSession(
  principalId: string | null,
  backendId: string,
  teamName: string
) {
  return {
    connection: { backendId },
    navigation: {
      teamPrincipal: principalId ? { id: principalId } : null,
      teams: [{ id: `${teamName}-id`, name: teamName }]
    }
  };
}

async function mountAvailability() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AgentTeamAvailability agentId={agentId} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

it("uses the authenticated Team principal independently of the private draft owner", async () => {
  vi.stubEnv("NEXT_PUBLIC_KOED_STUDIO_HOSTED", "0");
  const privateDraftOwnerId = "local-private-owner";
  const remoteTeamPrincipalId = "remote-team-owner";
  expect(remoteTeamPrincipalId).not.toBe(privateDraftOwnerId);
  loadSession.mockResolvedValueOnce(
    studioSession(remoteTeamPrincipalId, "remote-backend", "Research Team")
  );

  const view = await mountAvailability();

  expect(view.querySelector('[data-testid="team-offer"]')?.textContent).toBe(
    "Research Team"
  );
  expect(
    JSON.parse(
      view
        .querySelector('[data-testid="team-offer"]')!
        .getAttribute("data-authority-key")!
    )
  ).toEqual(["studio", "remote-backend", remoteTeamPrincipalId, agentId]);
});

it("clears the previous Team while refreshing and when authenticated context is missing", async () => {
  vi.stubEnv("NEXT_PUBLIC_KOED_STUDIO_HOSTED", "0");
  loadSession
    .mockResolvedValueOnce(
      studioSession("first-remote-owner", "first-backend", "First Team")
    )
    .mockResolvedValueOnce(
      studioSession(null, "second-backend", "Unverified Team")
    );

  const view = await mountAvailability();
  expect(view.textContent).toContain("First Team");

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(view.textContent).not.toContain("First Team");
  expect(view.textContent).not.toContain("Unverified Team");
  expect(view.textContent).toContain(
    "Could not verify the Team account. Check the Team connection and retry."
  );
  expect(view.querySelector('[data-testid="team-offer"]')).toBeNull();
});

it("replaces Team state and authority key when the remote identity changes", async () => {
  vi.stubEnv("NEXT_PUBLIC_KOED_STUDIO_HOSTED", "0");
  let resolveChangedSession: ((value: unknown) => void) | undefined;
  loadSession
    .mockResolvedValueOnce(
      studioSession("first-remote-owner", "first-backend", "First Team")
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveChangedSession = resolve;
        })
    );

  const view = await mountAvailability();
  expect(view.textContent).toContain("First Team");

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(view.textContent).toContain("Checking your Teams…");
  expect(view.textContent).not.toContain("First Team");

  await act(async () => {
    resolveChangedSession?.(
      studioSession("second-remote-owner", "second-backend", "Second Team")
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const offer = view.querySelector('[data-testid="team-offer"]');
  expect(offer?.textContent).toBe("Second Team");
  expect(JSON.parse(offer!.getAttribute("data-authority-key")!)).toEqual([
    "studio",
    "second-backend",
    "second-remote-owner",
    agentId
  ]);
});
