import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

const report = process.env.LINKED_INFO_ARRANGEMENT_REPORT;
const outputDir = process.env.LINKED_INFO_ARRANGEMENT_OUTPUT;
if (!report || !outputDir || !baseConfig.webServer || Array.isArray(baseConfig.webServer)) {
  throw new Error("Cold-start validation requires isolated report/output directories and one server");
}

const baseURL = "http://127.0.0.1:1423";

export default defineConfig({
  ...baseConfig,
  grep: /smart arrangement normalizes width and saves one undoable layout step$/,
  outputDir,
  reporter: [["json", { outputFile: report }]],
  retries: 0,
  use: { ...baseConfig.use, baseURL },
  webServer: {
    ...baseConfig.webServer,
    command: "pnpm dev --config e2e/fixtures/vite-arrangement-cold-start.config.ts --host 127.0.0.1 --port 1423",
    reuseExistingServer: false,
    url: baseURL,
  },
});
