import { defineConfig } from "@playwright/test";
import { STORAGE_STATE } from "./tests/global-setup";

const externalURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  // tests/sql holds node:test suites run by `npm run test:sql`, not browser tests.
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: false,
  use: {
    baseURL: externalURL ?? "http://127.0.0.1:3000",
    browserName: "chromium",
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    storageState: STORAGE_STATE,
  },
  webServer: externalURL
    ? undefined
    : {
        command: "npm run start -- --hostname 127.0.0.1",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 60000,
      },
});
