import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { loadConfig } from "./server/config.ts";

const { server } = loadConfig();

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": { target: `http://127.0.0.1:${server.port}`, ws: true } } },
  test: { root: ".", include: ["shared/**/*.test.ts", "server/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000 },
});
