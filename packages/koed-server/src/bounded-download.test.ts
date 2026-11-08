import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fetchBounded } from "./bounded-download.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const destination = () => {
  const dir = mkdtempSync(resolve(tmpdir(), "koed-bounded-download-"));
  dirs.push(dir);
  return resolve(dir, "asset");
};

it("reports a caller deadline as a timeout and an Operator abort as a cancellation", async () => {
  await expect(
    fetchBounded(
      "https://fixture.test/asset",
      destination(),
      1024,
      AbortSignal.abort(new DOMException("deadline", "TimeoutError"))
    )
  ).rejects.toThrow("component installation timed out");
  await expect(
    fetchBounded(
      "https://fixture.test/asset",
      destination(),
      1024,
      AbortSignal.abort()
    )
  ).rejects.toThrow("component installation cancelled");
});
