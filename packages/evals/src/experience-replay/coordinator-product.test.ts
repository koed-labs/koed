import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import {
  runExperienceReplay,
  type ExperienceReplayCoordinatorDependencies
} from "./coordinator.js";
import type { PreflightResult } from "./preflight.js";

interface ManualIntegrationFixture {
  config: ResolvedExperienceReplayConfig;
  preflight: PreflightResult;
  dependencies: ExperienceReplayCoordinatorDependencies;
}

const fixtureModule = process.env.KOED_EXPERIENCE_REPLAY_INTEGRATION_FIXTURE;

describe.skipIf(!fixtureModule)(
  "manual Experience Replay product-path integration",
  () => {
    it(
      "runs the explicitly provisioned PostgreSQL/Redis/Harbor product fixture",
      async () => {
        // The fixture is operator-owned because it provisions real local databases,
        // containers, credentials and (for recorded profiles) model quota. Keeping
        // this opt-in prevents default CI from pretending those prerequisites exist.
        const fixture = (await import(
          pathToFileURL(fixtureModule!).href
        )) as Partial<ManualIntegrationFixture>;
        if (!fixture.config || !fixture.preflight || !fixture.dependencies) {
          throw new Error(
            "Integration fixture must export config, preflight and dependencies"
          );
        }
        const result = await runExperienceReplay(fixture.config, {
          preflight: fixture.preflight,
          dependencies: fixture.dependencies
        });
        expect(result.productPathExercised).toBe(true);
        expect(result.replayAttemptCount).toBeGreaterThan(0);
      },
      60 * 60 * 1_000
    );
  }
);
