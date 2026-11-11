import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    launchOptions: process.env.CI ? {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    } : undefined,
  },
  webServer: [
    {
      command: "python3 ../backend/server.py --port 8100",
      url: "http://127.0.0.1:8100",
      reuseExistingServer: false,
    },
    {
      command: process.env.PLAYWRIGHT_USE_BUILD
        ? "npm run start -- --port 3100"
        : "npm run dev -- --port 3100",
      url: "http://127.0.0.1:3100",
      env: { FLOW_API_URL: "http://127.0.0.1:8100/api/generate" },
      reuseExistingServer: false,
    },
  ],
});
