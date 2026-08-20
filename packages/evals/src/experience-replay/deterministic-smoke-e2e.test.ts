import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runExperienceReplay } from "./coordinator.js";
import { resolveExperienceReplayConfig } from "./core/index.js";
import { preflightExperienceReplay } from "./preflight.js";
import { createCliExperienceReplayDependencies } from "./runtime-options.js";

const databaseUrl = process.env.KOED_EXPERIENCE_REPLAY_DATABASE_URL;
const suite =
  databaseUrl && process.platform === "linux" ? describe : describe.skip;
const roots: string[] = [];
const fixturePath = fileURLToPath(
  new URL("./fixtures/smoke.config.json", import.meta.url)
);

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true }))
  );
});

suite("Experience Replay deterministic product-path smoke", () => {
  it("runs every condition through real PostgreSQL, Redis, API, MCP, embeddings and LCM", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-replay-e2e-"));
    roots.push(root);
    const template = JSON.parse(await readFile(fixturePath, "utf8")) as Record<
      string,
      unknown
    >;
    const config = resolveExperienceReplayConfig({
      ...template,
      output_dir: path.join(root, "run")
    });
    const parsed = new URL(databaseUrl!);
    const environment = {
      KOED_EXPERIENCE_REPLAY_POSTGRES_ADMIN_URL: `${parsed.protocol}//${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`,
      KOED_EXPERIENCE_REPLAY_POSTGRES_USER: decodeURIComponent(parsed.username),
      KOED_EXPERIENCE_REPLAY_POSTGRES_PASSWORD: decodeURIComponent(
        parsed.password
      )
    };
    const preflight = await preflightExperienceReplay({ config });
    const result = await runExperienceReplay(config, {
      preflight,
      dependencies: createCliExperienceReplayDependencies(config, environment)
    });
    expect(result).toMatchObject({
      replayAttemptCount: 8,
      productPathExercised: true
    });
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Failures and missing outcomes: 0");
  }, 120_000);
});
