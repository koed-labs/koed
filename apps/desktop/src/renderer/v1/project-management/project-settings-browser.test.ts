import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("loads Project settings in a renderer without Node globals", async () => {
  const result = await build({
    entryPoints: [resolve(import.meta.dirname, "project-settings-model.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "ProjectSettings",
    external: ["node:*"],
    define: { "process.env.NODE_ENV": '"production"' }
  });
  // A server-only import must not require Node during renderer startup.
  expect(
    runInNewContext(
      `${result.outputFiles[0]!.text}\n typeof ProjectSettings.loadProjectSettings`
    )
  ).toBe("function");
});
