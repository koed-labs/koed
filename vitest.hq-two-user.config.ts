import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

const config = mergeConfig(
  base,
  defineConfig({
    test: {
      maxWorkers: 1,
      fileParallelism: false
    }
  })
);
// Vite merges arrays by concatenation. Replace the inherited default glob so
// this mandatory CI command executes only this real-service contract once.
config.test!.include = [
  "apps/api/tests/hq-integration/hq713-two-user.integration.ts"
];
export default config;
