// pnpm dev: запускает API (порт 3000) и SPA (Vite, порт 5173) вместе.
// SPA отправляет /api и /healthz на API через прокси Vite (apps/web/vite.config.ts).
// Остановка любого процесса или Ctrl+C останавливает оба. Код выхода: 0 после Ctrl+C,
// иначе код первого процесса, который завершился сам (1, если процесс убит сигналом).
import { spawn } from "node:child_process";

const services = [
  { name: "api", filter: "@studhub/api" },
  { name: "web", filter: "@studhub/web" },
];

let exitCode = 0;
let stopping = false;
let running = services.length;

const children = services.map(({ name, filter }) => {
  const child = spawn("pnpm", ["--filter", filter, "dev"], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[dev] ${name} остановлен (код ${code ?? signal})`);
      exitCode = code || 1;
      stopAll();
    }
    running -= 1;
    if (running === 0) process.exit(exitCode);
  });
  return child;
});

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
