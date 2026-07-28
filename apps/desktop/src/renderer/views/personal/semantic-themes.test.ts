import { describe, expect, it } from "vitest";

import { semanticThemeHistoryFixtures } from "./semantic-themes.fixtures.js";
import { rankThemes } from "./semantic-themes.js";

describe("semantic theme extraction", () => {
  it.each(semanticThemeHistoryFixtures)(
    "extracts meaningful themes from $name",
    ({ exclusions, expectedThemes, sources }) => {
      const themes = rankThemes({ exclusions, limit: 6, sources }).map(
        (theme) => theme.toLocaleLowerCase()
      );

      expect(themes).toEqual(
        expect.arrayContaining(
          expectedThemes.map((theme) => theme.toLocaleLowerCase())
        )
      );
    }
  );

  it("does not emit identity or machine-shaped text from mined history", () => {
    const fixture = semanticThemeHistoryFixtures.at(-1)!;
    const themes = rankThemes({
      exclusions: fixture.exclusions,
      limit: 10,
      sources: fixture.sources
    })
      .join(" ")
      .toLocaleLowerCase();

    expect(themes).not.toMatch(
      /users|worktrees|schema\.ts|client\.ts|functions\.bash|promise|await|ylwgmi|a1b2c3d4|remote|9222|feature/
    );
  });
});
