import {
  readFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sharingHelpInstructions } from "@koed/shared";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { resolveInstalledKoedHome } from "../integrations/pi/koed-home.mjs";

describe("Koed Pi extension package", () => {
  it("loads the copied Pi resource with only its declared peer and gets shared help from the managed runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "koed-pi-copy-"));
    try {
      const installed = join(root, "integrations/pi");
      cpSync(
        fileURLToPath(new URL("../integrations/pi", import.meta.url)),
        installed,
        { recursive: true }
      );
      const peer = join(installed, "node_modules/typebox");
      mkdirSync(peer, { recursive: true });
      // Pi supplies the schema-builder peer. This test exercises module location,
      // not TypeBox validation, and intentionally supplies no workspace packages.
      writeFileSync(
        join(peer, "package.json"),
        JSON.stringify({
          name: "typebox",
          type: "module",
          exports: "./index.mjs"
        })
      );
      writeFileSync(
        join(peer, "index.mjs"),
        "export const Type = new Proxy({}, { get: () => () => ({}) });"
      );
      // Native ESM bypasses Vitest's aliases. Compile the real helper into this
      // isolated installation so a fresh checkout needs no prior dist build.
      const helperPath = join(root, "sharing-overview-tool.mjs");
      buildSync({
        entryPoints: [
          fileURLToPath(
            new URL("../src/sharing-overview-tool.ts", import.meta.url)
          )
        ],
        outfile: helperPath,
        bundle: true,
        platform: "node",
        format: "esm",
        alias: {
          "@koed/shared": fileURLToPath(
            new URL("../../shared/src/index.ts", import.meta.url)
          )
        }
      });
      const program = `import assert from 'node:assert/strict';
        const {default:extension}=await import(${JSON.stringify(pathToFileURL(join(installed, "extensions/koed.mjs")).href)});
        const hooks=new Map();extension({on:(name,fn)=>hooks.set(name,fn),registerTool:()=>{}});
        const hook=hooks.get('before_agent_start');assert.ok(hook);
        const result=await hook({systemPrompt:'Base prompt'});
        process.stdout.write(JSON.stringify(result));`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", program],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            KOED_HOME: root,
            KOED_MANAGED_TEXT_ACTIONS: "1",
            KOED_MANAGED_RECALL_EXECUTION_ID:
              "11111111-1111-4111-8111-111111111111",
            KOED_MANAGED_RECALL_EXECUTION_GENERATION: "1",
            KOED_MANAGED_RECALL_API_URL: "http://127.0.0.1:7777",
            KOED_MANAGED_SHARING_HELPER_URL: pathToFileURL(helperPath).href
          }
        }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        systemPrompt: `Base prompt\n\n${sharingHelpInstructions}`
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gates native completion registration and returns a request-only result", async () => {
    const source = readFileSync(
      new URL("../integrations/pi/extensions/koed.mjs", import.meta.url),
      "utf8"
    );
    expect(source).toContain(
      'process.env.KOED_MANAGED_WORK_ITEM_COMPLETION === "1"'
    );
    expect(source).toContain('name: "work_item_complete"');
    expect(source).toContain('process.env.KOED_MANAGED_MERGE_PROPOSAL === "1"');
    expect(source).toContain('name: "review_request_merge_propose"');
    expect(source).toContain("return workItemCompletionRequest()");
    const { workItemCompletionRequest } =
      await import("../integrations/pi/work-item-completion-request.mjs");
    const receipt = workItemCompletionRequest();
    expect(receipt.details).toEqual({ status: "requested" });
    expect(receipt.content[0]?.type).toBe("text");
    expect(receipt.content[0]?.text).toContain("will verify");
  });
  it("packages supported tools and session-scoped lifecycle handlers", () => {
    const source = readFileSync(
      new URL("../integrations/pi/extensions/koed.mjs", import.meta.url),
      "utf8"
    );
    expect(source).toContain('"memory_answer"');
    expect(source).toContain('"memory_workspaces"');
    expect(source).toContain("team_backend_id: Type.Optional");
    expect(source).toContain('"memory_intake_propose"');
    expect(source).toContain('pi.on("session_start"');
    expect(source).toContain('pi.on("session_shutdown"');
    expect(source).toContain('pi.on("agent_settled"');
    expect(source).toContain("resolveInstalledKoedHome");
    expect(source).not.toContain("KOED_API_TOKEN");
    expect(source).not.toContain("ANTHROPIC_API_KEY");
    expect(source).not.toContain("OPENAI_API_KEY");
  });

  it("derives custom KOED_HOME from the stable installed package path", () => {
    expect(
      resolveInstalledKoedHome(
        {},
        new URL(
          "file:///custom/koed/integrations/pi/extensions/koed.mjs"
        ).toString(),
        "/fallback-home"
      )
    ).toBe("/custom/koed");
    expect(
      resolveInstalledKoedHome(
        {},
        new URL(
          "file:///repo/packages/mcp-server/extensions/koed.mjs"
        ).toString(),
        "/fallback-home"
      )
    ).toBe("/fallback-home/.koed");
  });

  it("declares only Koed-owned extension as installed package resource", () => {
    const parsed: unknown = JSON.parse(
      readFileSync(
        new URL("../integrations/pi/package.json", import.meta.url),
        "utf8"
      )
    );
    expect(parsed).toMatchObject({
      pi: { extensions: ["./extensions/koed.mjs"] }
    });
    expect(
      parsed && typeof parsed === "object" && "dependencies" in parsed
    ).toBe(false);
  });
});
