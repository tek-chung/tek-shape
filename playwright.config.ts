import { defineConfig } from "@playwright/test";
import { STORAGE_STATE } from "./tests/global-setup";
import * as nextEnvModule from "@next/env";

// @next/env is CommonJS marked as an ES module, and Playwright compiles this file to CommonJS: there the
// default import is undefined and the functions sit on the namespace. Native ESM (the scripts) is the reverse.
type NextEnv = typeof nextEnvModule;
const nextEnv: NextEnv = (nextEnvModule as NextEnv & { default?: NextEnv }).default ?? nextEnvModule;
nextEnv.loadEnvConfig(process.cwd());

const externalURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  // tests/sql holds node:test suites run by `npm run test:sql`, not browser tests.
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: false,
  use: {
    baseURL: externalURL ?? "http://127.0.0.1:3100",
    browserName: "chromium",
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    storageState: STORAGE_STATE,
  },
  webServer: externalURL
    ? undefined
    : {
        command: "node scripts/test-server.mjs",
        url: "http://127.0.0.1:3100",
        reuseExistingServer: false,
        timeout: 180000,
      },
});
