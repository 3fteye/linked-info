import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:1422";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Edge"],
    baseURL,
    channel: "msedge",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 1422",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    url: baseURL,
  },
});
