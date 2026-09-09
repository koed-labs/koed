import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileValidationCache } from "./validation-cache.js";
import { DeterministicPrivacyRuntime } from "./runtime.js";

it("invalidates changed runtime fingerprints, model identities, and malformed cache files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "privacy-validation-"));
  try {
    const path = join(directory, "cache.json");
    const runtime = new DeterministicPrivacyRuntime();
    const cache = fileValidationCache(path, "runtime-one");
    const value = {
      baseline: Array.from({ length: 3 }, () => ({
        maskedText: "synthetic",
        spans: "[]"
      })),
      providers: ["cpu" as const],
      calibrations: []
    };
    await cache.write(runtime, value);
    expect(await cache.read(runtime)).toEqual(value);
    expect(
      await fileValidationCache(path, "runtime-two").read(runtime)
    ).toBeUndefined();
    expect(
      await cache.read({
        ...runtime,
        modelRevision: "changed"
      } as typeof runtime)
    ).toBeUndefined();
    await writeFile(path, "{broken");
    expect(await cache.read(runtime)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
