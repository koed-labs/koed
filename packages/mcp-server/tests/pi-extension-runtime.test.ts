import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KOED_HOME;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Koed Pi Memory Answer bridge", () => {
  it("waits for the terminal runtime body and forwards tool-call identity", async () => {
    const koedHome = mkdtempSync(join(tmpdir(), "koed-pi-extension-"));
    roots.push(koedHome);
    mkdirSync(join(koedHome, "run"), { recursive: true });
    writeFileSync(
      join(koedHome, "run", "local-ai-runtime.json"),
      JSON.stringify({
        url: "http://127.0.0.1:32123",
        authorization: "Bearer runtime-secret"
      })
    );
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit
      ): Promise<Response> =>
        await new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { callLocalRuntimeTool } =
      await import("../integrations/pi/runtime-client.mjs");
    let settled = false;
    const pending = callLocalRuntimeTool({
      koedHome,
      name: "memory_answer",
      input: { query: "What did we decide?" },
      context: { cwd: "/work/project" },
      invocationKey: "pi-session:tool-call-1"
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(String(requestUrl)).toBe(
      "http://127.0.0.1:32123/v1/tools/memory_answer"
    );
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      invocationKey: "pi-session:tool-call-1",
      caller: { cwd: "/work/project", clientInfo: { name: "pi" } }
    });

    finish(
      new Response(JSON.stringify({ markdown: "The retained answer." }), {
        status: 200
      })
    );
    await expect(pending).resolves.toEqual({
      markdown: "The retained answer."
    });
  });
});
