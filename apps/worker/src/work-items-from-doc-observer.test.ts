import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import { createWorkItemsFromDocObserver } from "./work-items-from-doc-observer.js";

const homes: string[] = [];
afterEach(() =>
  homes
    .splice(0)
    .forEach((home) => rmSync(home, { recursive: true, force: true }))
);

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "hq406-worker-"));
  homes.push(home);
  const ownerUserId = randomUUID();
  storeDesktopLocalCredential(home, {
    ownerUserId,
    operationFamilies: ["personal_collaboration_write", "managed_execution"]
  });
  const executionId = randomUUID();
  const commandId = randomUUID();
  const leaseToken = randomUUID();
  const sourceId = randomUUID();
  const sourceRevisionId = randomUUID();
  const noteRevisionId = randomUUID();
  const live = {
    ownerUserId,
    executionId,
    executionGeneration: 2,
    state: "dispatching",
    leaseToken,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const repository = {
    getManagedConversationCommand: vi.fn(async () => live),
    putManagedConversationRuntimeItem: vi.fn(async () => undefined)
  };
  const send = vi.fn(
    async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      void [_url, _init];
      return new Response('{"created":0,"alreadyExisting":1}', { status: 200 });
    }
  );
  const observer = createWorkItemsFromDocObserver({
    repository: repository as never,
    apiUrl: "http://127.0.0.1:32123",
    koedHome: home,
    fetch: send
  });
  const event = {
    execution: { id: executionId, ownerUserId, executionGeneration: 2 },
    command: { id: commandId, leaseToken },
    toolCallId: "tool-1",
    toolName: "work_items_from_doc",
    arguments: {
      mode: "apply",
      source_id: sourceId,
      source_revision_id: sourceRevisionId,
      note_revision_id: noteRevisionId,
      proposals: [
        {
          line_number: 1,
          source_line: "Paper due Friday",
          title: "Paper",
          goal: "Write paper",
          due_text: "Friday"
        }
      ]
    },
    result: { structuredContent: { status: "requested" } }
  };
  return { observer, event, live, repository, send, home };
};

describe("leased document Work Item observer", () => {
  it("posts exact evidence with the current command lease and no credential in tool payload", async () => {
    const f = fixture();
    expect(await f.observer(f.event)).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    const init = f.send.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      commandId: f.event.command.id,
      leaseToken: f.event.command.leaseToken,
      proposals: [{ sourceLine: "Paper due Friday" }]
    });
    expect(String(init.body)).not.toContain("Koed-Desktop");
    expect(
      f.repository.putManagedConversationRuntimeItem
    ).toHaveBeenCalledTimes(1);
    expect(f.repository.putManagedConversationRuntimeItem).toHaveBeenCalledWith(
      { userId: f.event.execution.ownerUserId },
      expect.objectContaining({
        payload: { text: expect.stringContaining("1 already had a Work Item") }
      })
    );
  });
  it("rejects stale leases, malformed evidence, and forged receipts without applying", async () => {
    const f = fixture();
    f.repository.getManagedConversationCommand.mockResolvedValueOnce({
      ...f.live,
      leaseToken: randomUUID()
    });
    expect(await f.observer(f.event)).toBe(false);
    expect(
      await f.observer({
        ...f.event,
        arguments: {
          ...f.event.arguments,
          proposals: [{ ...f.event.arguments.proposals[0], source_line: "" }]
        }
      })
    ).toBe(false);
    expect(
      await f.observer({
        ...f.event,
        result: { structuredContent: { status: "applied" } }
      })
    ).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });
});
