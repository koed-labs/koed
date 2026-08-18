import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@koed/shared/collaboration",
        replacement: `${root}packages/shared/src/collaboration-contract.ts`
      },
      {
        find: "@koed/shared/personal-desktop",
        replacement: `${root}packages/shared/src/personal-desktop-contract.ts`
      },
      {
        find: "@koed/shared/secure-upstream-fetch",
        replacement: `${root}packages/shared/src/secure-upstream-fetch.ts`
      },
      {
        find: "@koed/core",
        replacement: `${root}packages/core/src/index.ts`
      },
      {
        find: "@koed/db",
        replacement: `${root}packages/db/src/index.ts`
      },
      {
        find: "@koed/mcp-server/codex-transcript-parser",
        replacement: `${root}packages/mcp-server/src/codex-transcript-parser.ts`
      },
      {
        find: "@koed/mcp-server/claude-transcript-parser",
        replacement: `${root}packages/mcp-server/src/claude-transcript-parser.ts`
      },
      {
        find: "@koed/mcp-server/runtime-contracts",
        replacement: `${root}packages/mcp-server/src/runtime-contracts.ts`
      },
      {
        find: "@koed/mcp-server",
        replacement: `${root}packages/mcp-server/src/index.ts`
      },
      {
        find: "@koed/worker/embedding-workflow",
        replacement: `${root}apps/worker/src/embedding-workflow.ts`
      },
      {
        find: "@koed/shared",
        replacement: `${root}packages/shared/src/index.ts`
      }
    ]
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    testTimeout: 15_000
  }
});
