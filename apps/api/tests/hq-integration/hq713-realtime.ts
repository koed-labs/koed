import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { collaborationRealtimeProtocolVersion } from "../../src/server/capabilities.js";
import { z } from "zod";
import type { Hq713Fixture } from "./hq713-fixture.js";

/** Observe the production Team refresh protocol, not the Personal item protocol. */
export async function openHq713WorkItemStream(fixture: Hq713Fixture) {
  const clientInstanceId = `hq713-${randomUUID()}`;
  const subscriptionKey = `hq713-${randomUUID()}`;
  const scope = {
    scope: "team",
    teamId: fixture.ids.teamId,
    clientInstanceId,
    subscriptionKey
  };
  const snapshot = await fixture.alice.team.request<{
    cursor: string;
    subscription: { id: string };
  }>("POST", "/v2/collaboration/realtime/snapshot", {
    body: scope,
    expectedStatus: 200
  });
  assert.equal(typeof snapshot.body.cursor, "string");
  const url = new URL(
    "/v2/collaboration/realtime/stream",
    fixture.team.baseUrl
  );
  for (const [key, value] of Object.entries({
    ...scope,
    cursor: snapshot.body.cursor
  }))
    url.searchParams.set(key, value);
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { authorization: fixture.alice.deviceAuthorization },
    redirect: "error",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
  });
  assert.equal(response.status, 200);
  assert.ok(
    response.headers.get("content-type")?.startsWith("text/event-stream")
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextFrame = async (): Promise<{ event: string; data: unknown }> => {
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = block.split(/\r?\n/);
        const event = lines
          .find((line) => line.startsWith("event: "))
          ?.slice(7);
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (event && data) return { event, data: JSON.parse(data) };
        continue;
      }
      const chunk = await reader.read();
      assert.ok(
        !chunk.done,
        "Realtime stream closed before its required refresh signal"
      );
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  const binding = z.object({
    protocolVersion: z.literal(collaborationRealtimeProtocolVersion),
    messageContractVersion: z.literal(2),
    subscription: z
      .object({ id: z.literal(snapshot.body.subscription.id) })
      .strict()
  });
  try {
    const ready = await nextFrame();
    assert.equal(ready.event, "ready");
    binding
      .extend({ cursor: z.literal(snapshot.body.cursor) })
      .strict()
      .parse(ready.data);
  } catch (error) {
    controller.abort();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
  return {
    async waitForRefresh() {
      while (true) {
        const frame = await nextFrame();
        if (frame.event === "heartbeat") continue;
        assert.equal(
          frame.event,
          "control",
          "Shared Project mutation must request authoritative refresh"
        );
        const control = binding
          .extend({ reason: z.literal("requires_snapshot") })
          .strict()
          .parse(frame.data);
        return {
          subscriptionId: control.subscription.id,
          reason: control.reason
        };
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
}
