import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("API and server resolve the shared enrollment fence transport", () => {
  for (const directory of ["apps/api", "packages/koed-server"]) {
    const probe = `import { startEnrollmentFenceIpcDispatcher, encodeEnrollmentFenceMessage } from "@koed-labs/shared/enrollment-fence-ipc";
      if (typeof startEnrollmentFenceIpcDispatcher !== "function" || typeof encodeEnrollmentFenceMessage !== "function") process.exit(1);`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", probe],
      {
        cwd: resolve(root, directory),
        encoding: "utf8"
      }
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

test("compiled API server entry exports the shared dispatcher without activating IPC", () => {
  const entry = pathToFileURL(
    resolve(root, "apps/api/dist/server/index.js")
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const api = await import(${JSON.stringify(entry)}); if (typeof api.startEnrollmentFenceIpcDispatcher !== "function") process.exit(1);`
    ],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
});
