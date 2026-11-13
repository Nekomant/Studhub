import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Порт dev-сервера отличается от порта apps/web (5173), чтобы оба приложения работали вместе.
// Прокси к API не нужен: заглушка не обращается к серверу.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
});
