import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callLocalRuntimeTool,
  createRuntimeTaskPort,
  readRuntimeRegistration
} from "../integrations/pi/runtime-client.mjs";
const directories: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "koed-pi-runtime-"));
  directories.push(h);
  mkdirSync(join(h, "run"));
  return h;
};
const registration = (h: string, overrides = {}) => {
  writeFileSync(
    join(h, "run/local-ai-runtime.json"),
    JSON.stringify({
      protocolVersion: 1,
      url: "http://127.0.0.1:5555",
      authorization: `Bearer ${"a".repeat(32)}`,
      pid: 123,
      startedAt: new Date().toISOString(),
      ...overrides
    }),
    { mode: 0o600 }
  );
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of directories.splice(0))
    rmSync(d, { recursive: true, force: true });
});
describe("standalone Pi runtime port", () => {
  it.each([
    [429, 1000, 1000],
    [429, 300000, 300000],
    [429, 0, undefined],
    [429, -1, undefined],
    [429, 1.5, undefined],
    [429, 300001, undefined],
    [429, "1000", undefined],
    [429, null, undefined],
    [403, 1000, undefined]
  ])(
    "preserves only bounded numeric quota advice for HTTP %s (%s)",
    async (status, retryAfterMs, expected) => {
      const h = home();
      registration(h);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status,
          json: async () => ({
            retryAfterMs,
            error: "private provider payload"
          })
        }))
      );
      try {
        await createRuntimeTaskPort(h).get("task");
        throw new Error("Expected runtime error");
      } catch (error) {
        expect(error).toMatchObject({
          statusCode: status,
          message: `Koed Local AI Runtime returned HTTP ${status}`
        });
        expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(
          expected
        );
        expect(String(error)).not.toContain("private provider payload");
      }
    }
  );

  it("uses authenticated canonical task operations and reloads registration after restart", async () => {
    const h = home();
    registration(h);
    const fetch = vi.fn(
      async (
        _url: URL,
        _options: {
          headers: Record<string, string>;
          body: string;
          redirect: string;
        }
      ) => {
        void _url;
        void _options;
        return {
          ok: true,
          json: async () => ({ task: { id: "task" } })
        };
      }
    );
    vi.stubGlobal("fetch", fetch);
    const port = createRuntimeTaskPort(h);
    await port.start(
      { query: "generated" },
      { cwd: "/generated" },
      "invocation"
    );
    registration(h, {
      url: "http://127.0.0.1:5556",
      authorization: `Bearer ${"b".repeat(32)}`
    });
    await port.get("task");
    await port.cancel("task");
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5555/v1/tasks/memory-answer",
      "http://127.0.0.1:5556/v1/tasks/task",
      "http://127.0.0.1:5556/v1/tasks/task/cancel"
    ]);
    expect(fetch.mock.calls[1]![1].headers.authorization).toBe(
      `Bearer ${"b".repeat(32)}`
    );
    expect(
      fetch.mock.calls.every(([, options]) => options.redirect === "error")
    ).toBe(true);
  });
  it("preserves authoritative 409 for blocking fallback without provider-text disclosure", async () => {
    const h = home();
    registration(h);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (
          _url: URL,
          _options: {
            headers: Record<string, string>;
            body: string;
            redirect: string;
          }
        ) => {
          void _url;
          void _options;
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: "private provider payload",
              errorCode: "memory_answer_team_ineligible"
            })
          };
        }
      )
    );
    await expect(
      createRuntimeTaskPort(h).start({}, {}, "call")
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "memory_answer_team_ineligible",
      message: "Koed Local AI Runtime returned HTTP 409"
    });
  });
  it.each([
    [409, undefined],
    [409, "private arbitrary code"],
    [503, "memory_answer_team_ineligible"]
  ])(
    "does not classify unrelated HTTP %s errors (%s)",
    async (status, errorCode) => {
      const h = home();
      registration(h);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status,
          json: async () => ({ error: "private provider payload", errorCode })
        }))
      );
      const error: unknown = await createRuntimeTaskPort(h)
        .start({}, {}, "call")
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        statusCode: status,
        message: `Koed Local AI Runtime returned HTTP ${status}`
      });
      expect(error).not.toHaveProperty("code");
    }
  );
  it("keeps the existing intake tool route and Pi caller", async () => {
    const h = home();
    registration(h);
    const fetch = vi.fn(
      async (
        _url: URL,
        _options: {
          headers: Record<string, string>;
          body: string;
          redirect: string;
        }
      ) => {
        void _url;
        void _options;
        return {
          ok: true,
          json: async () => ({ proposed: true })
        };
      }
    );
    vi.stubGlobal("fetch", fetch);
    await callLocalRuntimeTool({
      koedHome: h,
      name: "memory_intake_propose",
      input: { proposed_claim: "generated" },
      context: { cwd: "/generated" },
      invocationKey: "call"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
      caller: { cwd: "/generated", clientInfo: { name: "pi" } },
      invocationKey: "call"
    });
  });
  it.each([
    { url: "https://example.com" },
    { url: "http://127.0.0.1:5555/path" },
    { authorization: "Bearer short" },
    { protocolVersion: 2 }
  ])("rejects untrusted registrations: %j", (overrides) => {
    const h = home();
    registration(h, overrides);
    expect(() => readRuntimeRegistration(h)).toThrow();
  });
  it("rejects public-readable or symlink registration files", () => {
    if (process.platform === "win32") return;
    const h = home();
    registration(h);
    chmodSync(join(h, "run/local-ai-runtime.json"), 0o644);
    expect(() => readRuntimeRegistration(h)).toThrow();
    rmSync(join(h, "run/local-ai-runtime.json"));
    const other = join(h, "other.json");
    writeFileSync(other, "{}", { mode: 0o600 });
    symlinkSync(other, join(h, "run/local-ai-runtime.json"));
    expect(() => readRuntimeRegistration(h)).toThrow();
  });
});
