import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import desktopPackage from "./apps/desktop/package.json" with { type: "json" };

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  define: {
    __KOED_DESKTOP_VERSION__: JSON.stringify(desktopPackage.version)
  },
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
        find: "@koed/shared/private-network",
        replacement: `${root}packages/shared/src/private-network.ts`
      },
      {
        find: "@koed/shared/secure-upstream-fetch",
        replacement: `${root}packages/shared/src/secure-upstream-fetch.ts`
      },
      {
        find: "@koed/shared/ai-client-contract",
        replacement: `${root}packages/shared/src/ai-client-contract.ts`
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
