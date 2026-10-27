import { afterEach, describe, expect, it } from "vitest";
import type { PhoneLiveEvent } from "./contract.js";
import {
  startPhoneGatewayListener,
  type PhoneGatewayListener,
  type PhoneGatewayRoutes
} from "./server.js";
import type { PhoneGatewayService } from "./service.js";

const TOKEN = "t".repeat(43);
const phone = {
  id: "6f7c3b2a-6a4f-4d55-9d43-2f3c1b2a1e10",
  name: "Pixel",
  platform: "android" as const,
  tokenHash: "0".repeat(64),
  createdAt: "",
  lastSeenAt: null,
  expoPushToken: null
};

let listener: PhoneGatewayListener | null = null;
afterEach(async () => {
  await listener?.close();
  listener = null;
});

const start = async (overrides: Partial<PhoneGatewayRoutes> = {}) => {
  let emit: ((event: PhoneLiveEvent) => void) | null = null;
  const routes: PhoneGatewayRoutes = {
    hello: () => ({ app: "koed", api: 1, name: "Studio", pairing: true }),
    pair: async () => ({ token: TOKEN, phoneId: phone.id, macName: "Studio" }),
    authenticate: async (token) => (token === TOKEN ? phone : null),
    service: {
      home: async () => ({
        mac: { name: "Studio" },
        chief: null,
        agents: [],
        chiefConversation: null,
        working: [],
        upcoming: [],
        needs: [],
        complete: true
      })
    } as unknown as PhoneGatewayService,
    setPushToken: async () => undefined,
    unpair: async () => undefined,
    subscribe: (_phoneId, send) => {
      emit = send;
      return () => (emit = null);
    },
    ...overrides
  };
  listener = await startPhoneGatewayListener({
    hosts: ["127.0.0.1"],
    port: 0,
    routes
  });
  return {
    base: `${listener.addresses[0]}/koed-phone/v1`,
    emit: (event: PhoneLiveEvent) => emit?.(event)
  };
};

describe("phone gateway listener", () => {
  it("answers hello without a token", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/hello`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app: "koed",
      name: "Studio"
    });
  });

  it("refuses everything else without a paired phone's token", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/home`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/home`, {
          headers: { authorization: `Bearer ${"x".repeat(43)}` }
        })
      ).status
    ).toBe(401);
    const ok = await fetch(`${base}/home`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ mac: { name: "Studio" } });
  });

  it("validates pairing requests and returns the token once paired", async () => {
    const { base } = await start();
    const bad = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "12",
        deviceName: "Pixel",
        platform: "android"
      })
    });
    expect(bad.status).toBe(400);
    const good = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "123456",
        deviceName: "Pixel",
        platform: "android"
      })
    });
    expect(await good.json()).toEqual({
      token: TOKEN,
      phoneId: phone.id,
      macName: "Studio"
    });
  });

  it("limits pairing attempts per address", async () => {
    const { base } = await start({
      pair: async () => Promise.reject(new Error("no"))
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fetch(`${base}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "123456",
          deviceName: "Pixel",
          platform: "android"
        })
      });
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("streams live events to a paired phone", async () => {
    const { base, emit } = await start();
    const controller = new AbortController();
    const response = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    await reader.read();
    emit({ type: "changed", keys: ["chief"] });
    let text = "";
    while (!text.includes("event: changed"))
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"keys":["chief"]');
    controller.abort();
  });

  it("routes job edits, proposals and editions with validated bodies", async () => {
    const seen: unknown[] = [];
    const { base } = await start({
      service: {
        editJob: async (jobId: string, edit: unknown) => {
          seen.push(["edit", jobId, edit]);
          return { accepted: true };
        },
        resolveProposal: async (request: unknown) => {
          seen.push(["proposal", request]);
          return { accepted: true, state: "applied" };
        },
        assignEdition: async (editionId: string, agentId: string | null) => {
          seen.push(["edition", editionId, agentId]);
          return { accepted: true };
        }
      } as unknown as PhoneGatewayService
    });
    const send = (method: string, path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
    expect(
      (
        await send("POST", "/jobs/job-1/edit", {
          schedule: { kind: "weekdays", at: "09:15", tz: "Europe/Oslo" }
        })
      ).status
    ).toBe(200);
    expect(
      (await send("POST", "/jobs/job-1/edit", { schedule: { kind: "hourly" } }))
        .status
    ).toBe(400);
    expect(
      (
        await send("POST", "/proposals/respond", {
          executionId: "99999999-9999-4999-8999-999999999999",
          actionId: "88888888-8888-4888-8888-888888888888",
          decision: "approve"
        })
      ).status
    ).toBe(200);
    expect(
      (await send("PUT", "/editions/graphite", { agentId: null })).status
    ).toBe(200);
    expect(seen).toEqual([
      [
        "edit",
        "job-1",
        { schedule: { kind: "weekdays", at: "09:15", tz: "Europe/Oslo" } }
      ],
      [
        "proposal",
        {
          executionId: "99999999-9999-4999-8999-999999999999",
          actionId: "88888888-8888-4888-8888-888888888888",
          decision: "approve"
        }
      ],
      ["edition", "graphite", null]
    ]);
  });
});
