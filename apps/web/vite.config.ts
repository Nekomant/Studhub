import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Адрес API для прокси. В dev это API на порту 3000. E2E подставляют порт своего процесса API.
// /healthz лежит на корне API, поэтому его проксируем так же, как /api: в prod обе группы адресов ведёт Caddy.
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000";
const proxy = { "/api": apiTarget, "/healthz": apiTarget };
// Порт dev-сервера: по умолчанию 5173. Тест `pnpm dev` задаёт WEB_PORT и требует именно его.
const devPort = process.env.WEB_PORT === undefined ? 5173 : Number(process.env.WEB_PORT);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // «Доступна новая версия»: приложение само спросит пользователя (ТД §8). Регистрируем service worker в main.tsx.
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "Studhub",
        short_name: "Studhub",
        description: "Ученики, расписание и оплаты частного репетитора",
        lang: "ru",
        start_url: "/today",
        scope: "/",
        display: "standalone",
        background_color: "#f6f2ea",
        theme_color: "#f6f2ea",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      // Service worker кэширует только собранную статику (ТД §3, §8). Запросов к API он не перехватывает:
      // данными управляет TanStack Query. Адреса сервера не отдаём страницей-заменой при переходе.
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,svg,png,ico,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/, /^\/ical\//, /^\/__test\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: { proxy, port: devPort, strictPort: process.env.WEB_PORT !== undefined },
  preview: { proxy },
});
