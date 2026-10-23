import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  deleteDesktopLocalCredential,
  rotateDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import { createKoedServerManager } from "./manager.js";

const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";

describe("Desktop Sharing manager boundary", () => {
  it.each(["origin", "owner", "credential"] as const)(
    "discards a pending read when the Personal %s changes",
    async (change) => {
      const koedHome = mkdtempSync(resolve(tmpdir(), "koed-sharing-manager-"));
      const firstCredential = storeDesktopLocalCredential(koedHome, {
        ownerUserId: ownerA,
        operationFamilies: ["personal_collaboration_read"]
      });
      let origin = "http://127.0.0.1:4170";
      let releaseResponse: (() => void) | undefined;
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const fetchRequest = vi.fn<typeof fetch>(async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/v1/local-edge/sharing");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          firstCredential.authorization
        );
        await responseGate;
        return new Response(JSON.stringify({ backends: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      });
      const manager = createKoedServerManager({
        repoRoot: "/repo",
        cliPath: "/repo/cli.js",
        environment: { KOED_HOME: koedHome },
        createCliInvocation: (args) => ({
          command: "/node",
          args: ["/repo/cli.js", ...args],
          env: { KOED_HOME: koedHome }
        }),
        existsSync: () => true,
        execFile: (_command, _args, _options, callback) =>
          callback(
            null,
            JSON.stringify({
              ok: true,
              api: { state: "healthy", url: origin }
            }),
            ""
          ),
        spawn: () => new EventEmitter() as never,
        openExternal: async () => undefined,
        personalMemoryFetch: fetchRequest
      });
      try {
        const pending = manager.sharing();
        await vi.waitFor(() => expect(fetchRequest).toHaveBeenCalledOnce());
        if (change === "origin") origin = "http://127.0.0.1:4171";
        else if (change === "credential")
          rotateDesktopLocalCredential(koedHome);
        else {
          deleteDesktopLocalCredential(koedHome);
          storeDesktopLocalCredential(koedHome, {
            ownerUserId: ownerB,
            operationFamilies: ["personal_collaboration_read"]
          });
        }
        releaseResponse?.();
        await expect(pending).rejects.toThrow();
      } finally {
        releaseResponse?.();
        rmSync(koedHome, { recursive: true, force: true });
      }
    }
  );

  it("returns a strict empty-backend read for unchanged authority", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-sharing-manager-"));
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: ownerA,
      operationFamilies: ["personal_collaboration_read"]
    });
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) =>
        callback(
          null,
          JSON.stringify({
            ok: true,
            api: { state: "healthy", url: "http://127.0.0.1:4170" }
          }),
          ""
        ),
      spawn: () => new EventEmitter() as never,
      openExternal: async () => undefined,
      personalMemoryFetch: async () =>
        new Response(JSON.stringify({ backends: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });
    try {
      await expect(manager.sharing()).resolves.toEqual({ backends: [] });
    } finally {
      rmSync(koedHome, { recursive: true, force: true });
    }
  });
});
