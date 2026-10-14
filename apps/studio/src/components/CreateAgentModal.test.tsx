// @vitest-environment happy-dom
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateAgentModal } from "./CreateAgentModal";

vi.mock("./WorkspaceProvider", () => ({
  useWorkspace: () => {
    throw new Error(
      "Production editor must use its authenticated submit adapter"
    );
  }
}));
vi.mock("./PixelkinLab", () => ({
  PixelkinLab: forwardRef(function PixelkinLab(_props, ref) {
    useImperativeHandle(ref, () => ({
      capture: () => ({ image: "pixelkin:test", spec: { color: "green" } })
    }));
    return <div>Pixelkin appearance</div>;
  })
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("saves an Agent with an optional title and its Pixelkin without instruction or model configuration", async () => {
  const submit = vi.fn(async () => ({ definitionId: "alice" }));
  const created = vi.fn();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected lookup"));
  await act(async () =>
    root.render(
      <CreateAgentModal
        initialValues={{ name: "Alice" }}
        onClose={() => {}}
        onCreated={created}
        onSubmit={submit}
      />
    )
  );
  expect(container.querySelectorAll("input")).toHaveLength(2);
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).toContain("Job title");
  expect(container.textContent).toContain("optional");
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(submit).toHaveBeenCalledWith({
    name: "Alice",
    role: "",
    avatar: { image: "pixelkin:test", spec: { color: "green" } }
  });
  expect(created).toHaveBeenCalledWith("alice");
  expect(fetch).not.toHaveBeenCalled();
});
it("cancels without saving or restoring an old instruction draft", async () => {
  const submit = vi.fn(async () => ({ definitionId: "alice" }));
  const close = vi.fn();
  await act(async () =>
    root.render(
      <CreateAgentModal
        initialValues={{ name: "Alice", role: "Project manager" }}
        draftIdentity={{
          scope: { ownerId: "owner", backendId: "backend" },
          target: "create"
        }}
        onClose={close}
        onCreated={() => {}}
        onSubmit={submit}
      />
    )
  );
  const cancel = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel"
  )!;
  await act(async () => cancel.click());
  expect(close).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});
