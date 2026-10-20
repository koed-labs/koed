// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import { HqSettingsDeleted } from "./HqSettingsDeleted.js";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
type DeletedPage = Awaited<
  ReturnType<NonNullable<PersonalDesktopApi["listDeletedSessions"]>>
>;
const page = (title: string): DeletedPage => ({
  sessions: [
    {
      sessionId: "00000000-0000-4000-8000-000000000001",
      title,
      trashedAt: "2026-10-20T12:00:00.000Z",
      batchId: "00000000-0000-4000-8000-000000000002"
    }
  ],
  nextCursor: null
});

describe("Deleted chat Settings authority", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  it("discards the previous profile's late Deleted list response", async () => {
    const old = deferred<DeletedPage>();
    const next = deferred<DeletedPage>();
    const listDeletedSessions = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => next.promise);
    const api = { listDeletedSessions } as unknown as PersonalDesktopApi;
    await act(async () =>
      root.render(
        <HqSettingsDeleted api={api} authorityKey="owner-a|profile-a" />
      )
    );
    await act(async () =>
      root.render(
        <HqSettingsDeleted api={api} authorityKey="owner-b|profile-b" />
      )
    );
    await act(async () => old.resolve(page("Old owner's chat")));
    expect(host.textContent).not.toContain("Old owner's chat");
    await act(async () => next.resolve(page("Current owner's chat")));
    expect(host.textContent).toContain("Current owner's chat");
    expect(host.textContent).not.toContain("Old owner's chat");
  });
});
