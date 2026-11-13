import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, MiddlewareHandler } from "hono";

// Раздача собранной SPA процессом app (ТД §2.1). Caddy только проксирует запросы.
// Пути, которые принадлежат серверу и не должны получать index.html.
// Путь без слэша (`/api`) тоже принадлежит серверу: он получает 404 problem+json, а не index.html.
const SERVER_PATHS = ["/api", "/ical", "/__test", "/healthz"];

const isServerPath = (path: string) => SERVER_PATHS.some((base) => path === base || path.startsWith(`${base}/`));

// Файл с расширением (`/assets/x.js`) либо есть на диске, либо это честный 404. Остальное — маршрут роутера SPA.
const hasExtension = (path: string) => /\.[^/]+$/.test(path);

export type Spa = {
  // Отдаёт файлы из webRoot и ставит Cache-Control: файлы с хешем в имени кэшируются надолго, остальное проверяется заново.
  files: MiddlewareHandler;
  // Ответ index.html для маршрута SPA или undefined, если путь принадлежит серверу или это файл с расширением.
  fallback: (c: Context) => Promise<Response | undefined>;
};

export function createSpa(webRoot: string): Spa {
  const files = serveStatic({ root: webRoot });
  const index = serveStatic({ path: join(webRoot, "index.html") });

  const withCache = (response: Response, path: string) => {
    if (response.status === 200) {
      response.headers.set(
        "Cache-Control",
        path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      );
    }
    return response;
  };

  return {
    files: async (c, next) => {
      if (isServerPath(c.req.path)) return next();
      // serveStatic возвращает ответ, а если файла нет, передаёт запрос дальше через next: тогда ответ лежит в c.res.
      const response = await files(c, next);
      // Если файла нет, ответ формирует следующий обработчик: его заголовки не трогаем.
      return response ? withCache(response, c.req.path) : undefined;
    },
    fallback: async (c) => {
      const path = c.req.path;
      if (isServerPath(path) || hasExtension(path)) return undefined;
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return undefined;
      const response = await index(c, async () => {});
      return response ? withCache(response, "/index.html") : undefined;
    },
  };
}
