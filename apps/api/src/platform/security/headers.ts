import type { MiddlewareHandler } from "hono";

// Заголовки безопасности из ТД §9. Внешних ресурсов пока нет, поэтому политика разрешает только свой домен.
// Домен S3 для img-src и media-src добавит задача файлов.
export const CONTENT_SECURITY_POLICY = "default-src 'self'; frame-ancestors 'none'";

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
};
