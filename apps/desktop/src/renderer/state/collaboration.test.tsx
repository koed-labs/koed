// @vitest-environment happy-dom

import type {
  CollaborationSelection,
  CollaborationSnapshot
} from "@koed/shared/collaboration";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CollaborationClientListener,
  CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import { useCollaborationSnapshot } from "./collaboration.js";

const selection: CollaborationSelection = { kind: "personal_memory" };

const snapshot = (revision: number): CollaborationSnapshot =>
  ({
    contractVersion: 3,
    snapshotRevision: revision,
    generatedAt: "2026-07-23T00:00:00.000Z",
    connection: {
      state: "disconnected",
      remoteUrl: null,
      safeError: null
    },
    limits: {},
    navigation: {
      personal: { memory: [], threads: [] },
      teams: []
    },
    selection,
    view: { kind: "empty", reason: "not_loaded" }
  }) as unknown as CollaborationSnapshot;

describe("useCollaborationSnapshot", () => {
  const containers: HTMLElement[] = [];
  afterEach(async () => {
    for (const container of containers.splice(0)) container.remove();
  });

  const renderSnapshot = async (client: CollaborationRendererClient) => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    const Probe = () => {
      const current = useCollaborationSnapshot(client);
      return <output>{current?.snapshotRevision ?? "none"}</output>;
    };
    await act(async () => root.render(<Probe />));
    return { container, root };
  };

  it("subscribes to the existing client without duplicating its snapshot", async () => {
    let current: CollaborationSnapshot | null = snapshot(1);
    const listeners = new Set<CollaborationClientListener>();
    const client = {
      current: () => current,
      subscribe: (listener: CollaborationClientListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    } as unknown as CollaborationRendererClient;

    const { container, root } = await renderSnapshot(client);
    expect(container.textContent).toBe("1");
    expect(listeners.size).toBe(1);

    const next = snapshot(2);
    await act(async () => {
      current = next;
      for (const listener of listeners) {
        void listener(next, { kind: "realtime" });
      }
    });
    expect(container.textContent).toBe("2");

    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
  });

  it("does not trigger client loading as a subscription side effect", async () => {
    const load = vi.fn();
    const client = {
      current: () => null,
      subscribe: () => () => undefined,
      load
    } as unknown as CollaborationRendererClient;

    const { container, root } = await renderSnapshot(client);
    expect(container.textContent).toBe("none");
    expect(load).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
