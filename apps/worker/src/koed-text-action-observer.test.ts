import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import { createKoedTextActionObserver } from "./koed-text-action-observer.js";

const homes: string[] = [];
afterEach(() =>
  homes
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }))
);

const fixture = (apiUrl = "http://127.0.0.1:32123") => {
  const koedHome = mkdtempSync(join(tmpdir(), "hq504-text-action-"));
  homes.push(koedHome);
  const ownerUserId = randomUUID();
  storeDesktopLocalCredential(koedHome, {
    ownerUserId,
    operationFamilies: ["personal_collaboration_write", "managed_execution"]
  });
  const executionId = randomUUID();
  const commandId = randomUUID();
  const leaseToken = randomUUID();
  const command = {
    ownerUserId,
    executionId,
    commandKind: "prompt",
    executionGeneration: 2,
    state: "dispatching",
    leaseToken,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: { prompt: "Add problem set 4 by Friday" }
  };
  const repository = {
    getManagedConversationCommand: vi.fn(async () => command)
  };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response('{"status":"recorded"}', { status: 202 })
  );
  const observer = createKoedTextActionObserver({
    repository: repository as never,
    apiUrl,
    koedHome,
    fetch
  });
  const event = {
    execution: { id: executionId, ownerUserId, executionGeneration: 2 },
    command: { id: commandId, leaseToken },
    providerTurnId: "turn-1",
    toolCallId: "call-1",
    toolName: "koed_todo_add",
    arguments: {
      projectId: randomUUID(),
      title: "Problem set 4",
      dueOn: "2026-10-23"
    },
    result: { structuredContent: { status: "requested" } }
  };
  return { observer, event, command, repository, fetch };
};

describe("leased Koed text action observer", () => {
  it("delivers exact typed selector and lease only to loopback Personal API", async () => {
    const f = fixture();
    expect(await f.observer(f.event)).toBe(true);
    expect(f.fetch).toHaveBeenCalledOnce();
    const [input, init] = f.fetch.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe(
      `/v1/managed-conversations/${f.event.execution.id}/text-actions`
    );
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "koed_todo_add",
      commandId: f.event.command.id,
      leaseToken: f.event.command.leaseToken,
      toolCallId: "call-1",
      arguments: f.event.arguments
    });
    expect(String(init?.body)).not.toContain("Koed-Desktop");
  });

  it("rejects stale lease, malformed selector, false receipt, and remote transport", async () => {
    const f = fixture();
    f.repository.getManagedConversationCommand.mockResolvedValueOnce({
      ...f.command,
      leaseToken: randomUUID()
    });
    expect(await f.observer(f.event)).toBe(false);
    expect(
      await f.observer({
        ...f.event,
        arguments: { ...f.event.arguments, ownerUserId: randomUUID() }
      })
    ).toBe(false);
    expect(
      await f.observer({
        ...f.event,
        result: { structuredContent: { status: "applied" } }
      })
    ).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
    const remote = fixture("https://example.test");
    expect(await remote.observer(remote.event)).toBe(false);
    expect(remote.fetch).not.toHaveBeenCalled();
    const embedded = fixture("http://user:password@127.0.0.1:32123");
    expect(await embedded.observer(embedded.event)).toBe(false);
    expect(embedded.fetch).not.toHaveBeenCalled();
  });
});
