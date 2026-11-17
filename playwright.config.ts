import { defineConfig, devices } from "@playwright/test";
import { loadConfig } from "./server/config.ts";

const { e2e } = loadConfig();
const base = `http://127.0.0.1:${e2e.port}`;

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  reporter: "list",
  use: { baseURL: base, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && node server/main.ts",
    url: `${base}/api/health`,
    timeout: 120000,
    env: {
      PORT: String(e2e.port),
      SPREADSHEET_DATABASE_PGLITE_DIR: "memory://",
      SPREADSHEET_SERVER_LOG_LEVEL: "warn",
      SPREADSHEET_AUTH_GUEST_PER_HOUR: "1000",
      SPREADSHEET_AUTH_SIGNUP_PER_HOUR: "1000",
      SPREADSHEET_AUTH_LOGIN_PER_MINUTE: "1000",
    },
  },
});
