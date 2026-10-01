import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.KOED_STUDIO_UI_TEST_PORT ?? 43119);
const appRoot = path.resolve(__dirname, "../..");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: "list",
  outputDir: "../../output/playwright",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: `pnpm exec next dev -H 127.0.0.1 -p ${port}`,
    cwd: appRoot,
    url: `${baseURL}/studio/agents`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NEXT_PUBLIC_KOED_STUDIO_HOSTED: "1",
      KOED_STUDIO_UI_TEST_PORT: String(port)
    }
  }
});
