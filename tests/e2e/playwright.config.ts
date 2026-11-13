import { defineConfig, devices } from "@playwright/test";

// E2E идут против собранного приложения (ТД §14): скрипт стека поднимает БД, API и `vite preview` собранной SPA.
// Порт стека можно сменить переменной E2E_PORT.
const port = Number(process.env.E2E_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;
// Админка платформы (apps/admin) отдаётся отдельным `vite preview` на своём порту: в prod это другой домен.
// По умолчанию порт стека + 1: смена E2E_PORT сдвигает оба порта, и параллельные запуски не сталкиваются.
const adminPort = Number(process.env.E2E_ADMIN_PORT ?? port + 1);
const adminBaseURL = `http://127.0.0.1:${adminPort}`;

export default defineConfig({
  testDir: "src",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    locale: "ru-RU",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", testIgnore: "**/admin.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "admin", testMatch: "**/admin.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: adminBaseURL } },
  ],
  webServer: [
    {
      command: "node src/support/stack.ts",
      url: `${baseURL}/healthz`,
      env: { E2E_PORT: String(port) },
      timeout: 120_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${adminPort} --strictPort`,
      cwd: "../../apps/admin",
      url: adminBaseURL,
      timeout: 60_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
