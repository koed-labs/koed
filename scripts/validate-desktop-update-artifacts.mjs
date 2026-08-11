import { parseArgs } from "node:util";
import { validateDesktopUpdateArtifacts } from "./desktop-update-artifacts-lib.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    version: { type: "string" },
    json: { type: "boolean", default: false }
  },
  strict: true
});

try {
  const result = validateDesktopUpdateArtifacts({
    root: values.root,
    expectedVersion: values.version ?? null
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } else {
    process.stdout.write(
      `Validated ${result.version} Desktop updater artifacts (${result.artifacts.join(", ")})\n`
    );
  }
} catch (error) {
  process.stderr.write(
    `Desktop updater artifact validation failed: ${error.message}\n`
  );
  process.exitCode = 1;
}
