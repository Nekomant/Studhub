// pnpm dev: запускает API (порт 3000) и SPA (Vite, порт 5173) вместе.
// SPA отправляет /api и /healthz на API через прокси Vite (apps/web/vite.config.ts).
// Остановка любого процесса или Ctrl+C останавливает оба.
import { spawn } from "node:child_process";

const services = [
  { name: "api", filter: "@studhub/api" },
  { name: "web", filter: "@studhub/web" },
];

const children = services.map(({ name, filter }) => {
  const child = spawn("pnpm", ["--filter", filter, "dev"], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.error(`[dev] ${name} остановлен (код ${code ?? signal})`);
    stopAll(code ?? 1);
  });
  return child;
});

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
