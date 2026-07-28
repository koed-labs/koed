import type { ThemeSource } from "./semantic-themes.js";

// Sanitized and lightly condensed from local Pi and Codex JSONL transcripts.
// Names, machine paths, issue numbers, URLs, and repository identifiers were
// removed while preserving the language patterns that theme extraction sees.
export const semanticThemeHistoryFixtures: Array<{
  exclusions: string[];
  expectedThemes: string[];
  name: string;
  sources: ThemeSource[];
}> = [
  {
    name: "Pi — interactive otter landing page",
    exclusions: [
      "marketing-site",
      "/Users/example/worktrees/feature-otter-landing-page"
    ],
    sources: [
      {
        kind: "generated_title",
        text: "feature-otter-landing-page"
      },
      {
        kind: "narrative",
        text: "Retool the marketing landing page around the otter-themed water effect. Mouse clicks should cause ripples in the water, move the ball, and affect the otters like the original prototype."
      }
    ],
    expectedThemes: ["water effect", "mouse clicks", "otters"]
  },
  {
    name: "Pi — isolated multi-device sync testing",
    exclusions: [
      "memory-server",
      "/Users/example/worktrees/feature-multi-device-sync"
    ],
    sources: [
      {
        kind: "generated_title",
        text: "feature-multi-device-sync"
      },
      {
        kind: "narrative",
        text: "Give me a local testing plan for multi-device sync behaviour. Could Docker isolate and simulate multiple instances? Can the instances run with filesystem isolation and separate processes on a headless machine?"
      }
    ],
    expectedThemes: [
      "local testing",
      "filesystem isolation",
      "separate processes"
    ]
  },
  {
    name: "Codex — programme and composer presentation",
    exclusions: ["concert-web", "/workspace/concert-web/src/pages/live.tsx"],
    sources: [
      {
        kind: "generated_title",
        text: "Update live show page"
      },
      {
        kind: "narrative",
        text: "Programme cards should show the composer as well as the piece name. Show a deduplicated short list of composers that expands into all songs, keeping composer chips but using a traditional list layout when expanded."
      }
    ],
    expectedThemes: ["programme cards", "piece name", "composer chips"]
  },
  {
    name: "Codex — release pipeline investigation",
    exclusions: [
      "desktop-app",
      "/workspace/desktop-app/.github/workflows/release.yml"
    ],
    sources: [
      {
        kind: "generated_title",
        text: "Release failed again"
      },
      {
        kind: "narrative",
        text: "The release failed again. I thought the Homebrew dependency for build assets had been removed from the pipeline. Consider running GitHub Actions locally to prevent repeated cloud failures."
      },
      {
        kind: "narrative",
        text: "Expand the pull request description with local validation so reviewers have confidence that the release pipeline will succeed."
      }
    ],
    expectedThemes: ["Homebrew dependency", "build assets", "local validation"]
  },
  {
    name: "Machine noise — paths, hashes, flags, and tool metadata",
    exclusions: [
      "feature-schema-reset",
      "/Users/example/.paseo/worktrees/a1b2c3d4/feature-schema-reset"
    ],
    sources: [
      {
        kind: "generated_title",
        text: "feature-schema-reset"
      },
      {
        kind: "narrative",
        text: 'Inspect /Users/example/.paseo/worktrees/a1b2c3d4/feature-schema-reset/src/schema.ts and apps/github/src/client.ts plus https://example.invalid/run/123. {"toolName":"functions.bash","callId":"a1b2c3d4e5f6"} --remote-debugging-port=9222 `await Promise.all(tasks)` ylWgMiGFUnqZLBE8aSWqDUVY The migration should preserve membership epochs and deletion floors.'
      }
    ],
    expectedThemes: ["membership epochs", "deletion floors"]
  }
];
