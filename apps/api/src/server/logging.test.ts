import { describe, expect, it } from "vitest";
import {
  formatApiLogBindings,
  resolveRequestId,
  serializeApiRequest
} from "./logging.js";

describe("API logging", () => {
  it("serializes requests without query values or headers", () => {
    const serialized = serializeApiRequest({
      id: "req-1",
      method: "GET",
      url: "/v1/memory/graph/events?query=secret+memory&includeRaw=true",
      headers: {
        authorization: "Bearer cmt_secret",
        cookie: "cm_session=cms_secret"
      },
      routeOptions: { url: "/v1/memory/graph/events" },
      raw: {
        socket: {
          remoteAddress: "127.0.0.1",
          remotePort: 12345
        }
      }
    });

    expect(serialized).toEqual({
      id: "req-1",
      method: "GET",
      path: "/v1/memory/graph/events",
      query_keys: ["includeRaw", "query"],
      route: "/v1/memory/graph/events"
    });
    expect(JSON.stringify(serialized)).not.toContain("secret");
    expect(JSON.stringify(serialized)).not.toContain("Bearer");
    expect(JSON.stringify(serialized)).not.toContain("cm_session");
  });

  it("serializes POST requests without body payloads or memory text", () => {
    const serialized = serializeApiRequest({
      id: "req-body-redaction",
      method: "POST",
      url: "/v1/memory/answer",
      headers: {
        authorization: "Bearer cmt_raw_secret"
      },
      body: {
        query: "raw memory sentinel should never enter API request logs",
        apiKey: "sk-do-not-log"
      },
      routeOptions: { url: "/v1/memory/answer" }
    });

    expect(serialized).toEqual({
      id: "req-body-redaction",
      method: "POST",
      path: "/v1/memory/answer",
      route: "/v1/memory/answer"
    });
    expect(JSON.stringify(serialized)).not.toContain("raw memory sentinel");
    expect(JSON.stringify(serialized)).not.toContain("sk-do-not-log");
    expect(JSON.stringify(serialized)).not.toContain("Bearer");
  });

  it("redacts Team Memory request bodies from diagnostic logs", () => {
    const serialized = serializeApiRequest({
      id: "req-team-memory-redaction",
      method: "POST",
      url: "/v1/team-workspaces/workspace-1/memory/questions",
      headers: {
        authorization: "Bearer cmt_team_secret",
        cookie: "cm_session=cms_team_secret"
      },
      body: {
        query: "shared roadmap memory sentinel",
        evidence: [{ text: "private customer evidence sentinel" }],
        localMemoryWorker: {
          prompt: "worker prompt sentinel"
        },
        apiKey: "sk-team-do-not-log"
      },
      routeOptions: {
        url: "/v1/team-workspaces/:teamWorkspaceId/memory/questions"
      }
    });

    expect(serialized).toEqual({
      id: "req-team-memory-redaction",
      method: "POST",
      path: "/v1/team-workspaces/workspace-1/memory/questions",
      route: "/v1/team-workspaces/:teamWorkspaceId/memory/questions"
    });
    const serializedText = JSON.stringify(serialized);
    expect(serializedText).not.toContain("shared roadmap memory sentinel");
    expect(serializedText).not.toContain("private customer evidence sentinel");
    expect(serializedText).not.toContain("worker prompt sentinel");
    expect(serializedText).not.toContain("sk-team-do-not-log");
    expect(serializedText).not.toContain("cmt_team_secret");
    expect(serializedText).not.toContain("cms_team_secret");
  });

  it("redacts PDS relay concrete params and query keys by route category", () => {
    const serialized = serializeApiRequest({
      id: "req-pds",
      method: "GET",
      url: "/v1/personal-device-sync/relay/transports/opaque-id/chunks/7?proof=signature&cursor=opaque",
      routeOptions: {
        url: "/v1/personal-device-sync/relay/transports/:transportId/chunks/:chunkIndex"
      }
    });
    expect(serialized).toEqual({
      id: "req-pds",
      method: "GET",
      path: "/v1/personal-device-sync/relay/transports/:transportId/chunks/:chunkIndex",
      category: "pds_relay",
      route:
        "/v1/personal-device-sync/relay/transports/:transportId/chunks/:chunkIndex"
    });
    expect(JSON.stringify(serialized)).not.toContain("opaque-id");
    expect(JSON.stringify(serialized)).not.toContain("signature");
  });

  it.each([
    [
      "/high-risk/browser-activations/953249fe-6002-4750-83e8-fe89268e35ac",
      "/high-risk/browser-activations/:selector"
    ],
    [
      "/v1/high-risk/browser-activations/953249fe-6002-4750-83e8-fe89268e35ac/decision",
      "/v1/high-risk/browser-activations/:selector/decision"
    ],
    [
      "/device-enrollment/953249fe-6002-4750-83e8-fe89268e35ac",
      "/device-enrollment/:challengeId"
    ]
  ])("redacts approval identifiers from %s logs", (url, route) => {
    const serialized = serializeApiRequest({
      id: "req-approval",
      method: "GET",
      url,
      routeOptions: { url: route }
    });

    expect(serialized).toMatchObject({ path: route, route });
    expect(JSON.stringify(serialized)).not.toContain(
      "953249fe-6002-4750-83e8-fe89268e35ac"
    );
  });

  it("preserves W3C trace ids without logging all headers", () => {
    const serialized = serializeApiRequest({
      id: "req-2",
      method: "POST",
      url: "/v1/memory/search",
      headers: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
      }
    });

    expect(serialized).toMatchObject({
      trace: {
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        span_id: "00f067aa0ba902b7"
      }
    });
    expect(JSON.stringify(serialized)).not.toContain("traceparent");
  });

  it("accepts bounded request ids and replaces unsafe values", () => {
    expect(resolveRequestId("operator-request-1")).toBe("operator-request-1");
    expect(resolveRequestId("contains space")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("does not stringify object request ids in logs", () => {
    expect(
      serializeApiRequest({
        id: { toString: () => "should-not-log" },
        method: "GET",
        url: "/health"
      })
    ).toEqual({
      id: "",
      method: "GET",
      path: "/health"
    });
  });

  it("normalizes Fastify log keys to the API schema", () => {
    expect(
      formatApiLogBindings({
        req: {
          id: "req-1",
          method: "GET",
          url: "/v1/memory/items?query=secret",
          raw: {
            rawHeaders: ["authorization", "Bearer cmt_secret"],
            socket: { remoteAddress: "127.0.0.1", remotePort: 12345 }
          }
        },
        res: { statusCode: 200 },
        responseTime: 12.5,
        msg: "request completed"
      })
    ).toEqual({
      request: {
        id: "req-1",
        method: "GET",
        path: "/v1/memory/items",
        query_keys: ["query"]
      },
      client: { ip: "127.0.0.1", port: 12345 },
      http: { duration_ms: 13 },
      response: { status_code: 200 },
      msg: "request completed"
    });
  });
});
