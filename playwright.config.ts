import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./browser-tests", fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:1420", trace: "retain-on-failure" },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: { command: "npm run dev", url: "http://127.0.0.1:1420", reuseExistingServer: !process.env.CI },
});
