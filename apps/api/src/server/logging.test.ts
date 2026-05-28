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
