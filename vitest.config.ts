import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@koed/core": `${root}packages/core/src/index.ts`,
      "@koed/db": `${root}packages/db/src/index.ts`,
      "@koed/mcp-server": `${root}packages/mcp-server/src/index.ts`,
      "@koed/shared": `${root}packages/shared/src/index.ts`
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"]
  }
});
