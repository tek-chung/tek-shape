import { defineConfig } from "@playwright/test";

const externalURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  use: { baseURL: externalURL ?? "http://127.0.0.1:3000", browserName: "chromium", viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true },
  webServer: externalURL ? undefined : { command: "npm run start -- --hostname 127.0.0.1", url: "http://127.0.0.1:3000", reuseExistingServer: !process.env.CI, timeout: 60000 },
});
