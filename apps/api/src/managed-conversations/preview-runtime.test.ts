import { randomUUID } from "node:crypto";

import type { MemorySourceRepository } from "@koed/db";
import type { ManagedTerminalRuntime } from "./terminal-runtime.js";
import { describe, expect, it, vi } from "vitest";

import { createManagedDevelopmentPreviewRuntime } from "./preview-runtime.js";
import type { ManagedTerminalPreviewSignal } from "./terminal-runtime.js";

const eventually = async <T>(read: () => T | undefined): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("Expected preview state did not arrive");
};

const fixture = () => {
  const ownerUserId = randomUUID();
  const executionId = randomUUID();
  const terminalId = randomUUID();
  let listener: ((signal: ManagedTerminalPreviewSignal) => void) | null = null;
  const verifyPreviewListener = vi.fn(async () => true);
  const terminalRuntime = {
    verifyPreviewListener,
    subscribePreviewSignals(
      next: (signal: ManagedTerminalPreviewSignal) => void
    ) {
      listener = next;
      return () => {
        listener = null;
      };
    }
  } as unknown as ManagedTerminalRuntime;
  const repository = {
    getManagedConversationExecution: vi.fn(async () => ({
      id: executionId,
      executionGeneration: 1
    })),
    getManagedConversationRuntimeBinding: vi.fn(async () => ({
      executionGeneration: 1,
      workspaceLifecycle: "ready"
    }))
  } as unknown as MemorySourceRepository;
  const fetch = vi.fn(
    async () =>
      new Response("ready", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
  );
  const changes: string[] = [];
  const runtime = createManagedDevelopmentPreviewRuntime({
    requireRepository: () => repository,
    terminalRuntime,
    fetch,
    readinessDelaysMs: [0],
    onChange: (record) => changes.push(record.state)
  });
  return {
    ownerUserId,
    executionId,
    terminalId,
    verifyPreviewListener,
    fetch,
    changes,
    runtime,
    emit(signal: ManagedTerminalPreviewSignal) {
      if (!listener) throw new Error("Preview signal listener is unavailable");
      listener(signal);
    }
  };
};

describe("managed development preview runtime", () => {
  it("publishes only verified ready listeners and keeps navigation data private", async () => {
    const test = fixture();
    const preview = await test.runtime.nominate(
      test.ownerUserId,
      test.executionId,
      {
        executionGeneration: 1,
        terminalId: test.terminalId,
        scheme: "http",
        port: 5_173
      }
    );
    expect(preview).toMatchObject({
      executionId: test.executionId,
      terminalId: test.terminalId,
      state: "available",
      source: "user_port"
    });
    expect(JSON.stringify(preview)).not.toContain("5173");
    expect(JSON.stringify(preview)).not.toContain("127.0.0.1");
    await expect(
      test.runtime.access({
        ownerUserId: test.ownerUserId,
        executionId: test.executionId,
        previewId: preview.id,
        lifecycleGeneration: preview.lifecycleGeneration
      })
    ).resolves.toMatchObject({ navigationUrl: "http://127.0.0.1:5173/" });
    await expect(
      test.runtime.access({
        ownerUserId: randomUUID(),
        executionId: test.executionId,
        previewId: preview.id,
        lifecycleGeneration: preview.lifecycleGeneration
      })
    ).rejects.toMatchObject({ code: "preview_unavailable" });
    expect(test.verifyPreviewListener).toHaveBeenCalledWith(
      expect.objectContaining({ port: 5_173 })
    );
    expect(test.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: "http://127.0.0.1:5173/" }),
      expect.objectContaining({ credentials: "omit", redirect: "manual" })
    );
    test.runtime.close();
  });

  it("discovers terminal URLs and closes their previews with the process", async () => {
    const test = fixture();
    test.emit({
      type: "candidate",
      ownerUserId: test.ownerUserId,
      executionId: test.executionId,
      executionGeneration: 1,
      terminalId: test.terminalId,
      url: "http://localhost:4173/private?token=must-not-survive#fragment"
    });
    const available = await eventually(() =>
      test.changes.includes("available") ? true : undefined
    );
    expect(available).toBe(true);
    const [preview] = await test.runtime.list(
      test.ownerUserId,
      test.executionId
    );
    expect(preview?.state).toBe("available");
    const access = await test.runtime.access({
      ownerUserId: test.ownerUserId,
      executionId: test.executionId,
      previewId: preview!.id,
      lifecycleGeneration: preview!.lifecycleGeneration
    });
    expect(access.navigationUrl).toBe("http://127.0.0.1:4173/private");

    test.emit({
      type: "closed",
      ownerUserId: test.ownerUserId,
      executionId: test.executionId,
      executionGeneration: 1,
      terminalId: test.terminalId
    });
    expect(
      (await test.runtime.list(test.ownerUserId, test.executionId))[0]?.state
    ).toBe("closed");
    await expect(
      test.runtime.access({
        ownerUserId: test.ownerUserId,
        executionId: test.executionId,
        previewId: preview!.id,
        lifecycleGeneration: preview!.lifecycleGeneration
      })
    ).rejects.toMatchObject({ code: "preview_unavailable" });
    test.runtime.close();
  });

  it("does not probe an unowned listener", async () => {
    const test = fixture();
    test.verifyPreviewListener.mockResolvedValue(false);
    await expect(
      test.runtime.nominate(test.ownerUserId, test.executionId, {
        executionGeneration: 1,
        terminalId: test.terminalId,
        scheme: "http",
        port: 3_300
      })
    ).rejects.toMatchObject({ code: "preview_listener_unverified" });
    expect(test.fetch).not.toHaveBeenCalled();
    test.runtime.close();
  });
});
