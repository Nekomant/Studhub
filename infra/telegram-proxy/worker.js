// Прокси для алертов Telegram на Cloudflare Workers (SH-012). Нужен, потому что Telegram закрыт с VPS в РФ.
// Принимает только POST /bot<токен>/sendMessage с заголовком X-Proxy-Secret и пересылает его на api.telegram.org.
// Секрет задаётся в Cloudflare как секрет Worker с именем PROXY_SECRET. Токен бота и текст сообщений не пишутся в лог.
const TELEGRAM_ORIGIN = "https://api.telegram.org";
const SEND_MESSAGE_PATH = /^\/bot\d+:[A-Za-z0-9_-]+\/sendMessage$/;
const MAX_BODY_BYTES = 8192;

const text = (body, status) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

// Сравнение за постоянное время: сравниваем хеши, поэтому длина секрета не влияет на время.
async function sameSecret(given, expected) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map(
      async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    ),
  );
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (!env.PROXY_SECRET) return text("proxy secret is not configured", 500);
    if (!(await sameSecret(request.headers.get("x-proxy-secret") ?? "", env.PROXY_SECRET))) {
      return text("forbidden", 403);
    }
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || !SEND_MESSAGE_PATH.test(pathname)) return text("not found", 404);

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return text("payload too large", 413);

    const upstream = await fetch(`${TELEGRAM_ORIGIN}${pathname}`, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  },
};
