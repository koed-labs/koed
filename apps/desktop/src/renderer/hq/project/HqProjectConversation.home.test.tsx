// @vitest-environment happy-dom
import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectHqConversationDesktopApi } from "../../../ipc/project-hq-conversation-protocol.js";
import { HqProjectConversation } from "./HqProjectConversation.js";

vi.mock("../conversation/HqConversation.js", () => ({
  HqActiveConversation: () => <div>Captured HQ</div>,
  HqConversationSettings: () => null
}));
vi.mock("../agents/Pixelkin.js", () => ({
  Pixelkin: () => <span>Pixelkin</span>
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

const render = async (home: boolean) => {
  const projectId = randomUUID();
  const api = {
    reserve: vi.fn(async () => ({ projectId, executionId: null }))
  } as unknown as ProjectHqConversationDesktopApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <HqProjectConversation
        home={home}
        project={{ id: projectId, name: "Chief of Staff", path: null } as never}
        chiefName="Juno"
        chiefAgent={{ id: "chief", name: "Juno", look: {} } as never}
        chiefInstanceId={null}
        api={api}
        managedConversations={
          {
            launchOptions: async () => ({
              options: { runners: [], instances: [] }
            }),
            inspect: async () => ({ status: "starting", conversation: null })
          } as never
        }
        managedProject={null}
        store={{ registerPrivateThread: () => undefined } as never}
        lifecycle={{} as never}
        markdownAdapters={{} as never}
      />
    )
  );
  return host;
};

describe("Chief of Staff on Solo's Now", () => {
  it("names the Chief and invites a message, not a question about a Project", async () => {
    const host = await render(true);
    expect(host.textContent).toContain("Juno");
    expect(host.textContent).toContain("Your chief of staff");
    expect(
      host.querySelector(".hq-project-conversation__header")?.textContent
    ).not.toContain("Just me");
    const composer = host.querySelector("textarea");
    expect(composer?.placeholder).toBe("Message Juno");
  });

  it("keeps the Project HQ wording inside a Project", async () => {
    const host = await render(false);
    expect(
      host.querySelector(".hq-project-conversation__header")?.textContent
    ).toContain("Just me");
    expect(host.querySelector("textarea")?.placeholder).toBe(
      "Ask Juno about Chief of Staff"
    );
  });
});
