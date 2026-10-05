// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LocalConversationBrowser } from "./LocalConversationBrowser";
const projectId = `lp_${"a".repeat(32)}`;
const conversation = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  title: "Fix login",
  projectId: null as string | null,
  provider: "codex",
  state: "running",
  updatedAt: "2026-10-05T12:00:00Z"
};
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});
async function mount(project: string | null) {
  const fetcher = vi.fn(async (url: string) =>
    Response.json(
      url === "/studio-api/projects"
        ? { projects: [{ id: projectId, name: "My project" }] }
        : url.includes("github/session")
          ? { csrfToken: "token" }
          : url.includes("conversation-titles")
            ? { session: { id: conversation.sessionId } }
            : { items: [], nextCursor: null, providers: {}, truncated: false }
    )
  );
  vi.stubGlobal("fetch", fetcher);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <LocalConversationBrowser
        selectedExecutionId={conversation.id}
        managedConversations={[{ ...conversation, projectId: project }]}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return fetcher;
}
it.each([null, projectId])(
  "reveals and selects the new conversation in its correct group (%s)",
  async (project) => {
    await mount(project);
    const selected = container.querySelector('[aria-current="page"]');
    expect(selected?.textContent).toContain("Fix login");
    if (project)
      expect(
        container
          .querySelector('[title="My project"]')
          ?.getAttribute("aria-expanded")
      ).toBe("true");
  }
);
it("saves a user rename with CSRF and retains the selected conversation", async () => {
  const fetcher = await mount(null);
  await act(async () =>
    (
      container.querySelector(
        '[aria-label="Rename Fix login"]'
      ) as HTMLButtonElement
    ).click()
  );
  const input = container.querySelector(
    'input[aria-label="Conversation name"]'
  ) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(input, "My login fix");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(fetcher).toHaveBeenCalledWith(
    `/studio-api/conversation-titles/${conversation.sessionId}`,
    expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "x-studio-csrf": "token" })
    })
  );
  expect(
    container.querySelector('[aria-current="page"]')?.textContent
  ).toContain("My login fix");
});
