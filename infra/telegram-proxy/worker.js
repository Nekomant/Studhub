// Прокси для алертов Telegram на Cloudflare Workers (SH-012). Нужен, потому что Telegram закрыт с VPS в РФ.
// Токен бота хранится только здесь, в секрете Worker TELEGRAM_BOT_TOKEN. Сервер токена не знает.
// Принимает только POST /send с заголовком X-Proxy-Secret и телом с text (форма или JSON),
// пересылает на api.telegram.org/bot<токен>/sendMessage и возвращает ответ Telegram как есть.
// Переменные Worker: PROXY_SECRET (секрет), TELEGRAM_BOT_TOKEN (секрет), TELEGRAM_CHAT_ID (обязательна: чат задан здесь,
// сервер его не передаёт; запрос с другим chat_id получает 403). Токен и тексты сообщений не пишутся в лог.
const TELEGRAM_ORIGIN = "https://api.telegram.org";
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

// Достаёт chat_id и text из формы или JSON. Остальные поля отбрасываются: прокси не пересылает parse_mode и подобное.
function parseMessage(raw, contentType) {
  try {
    const fields = contentType.includes("application/json")
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw));
    const chatId = fields.chat_id === undefined || fields.chat_id === null ? "" : String(fields.chat_id);
    const message = typeof fields.text === "string" ? fields.text : "";
    return { chatId, message };
  } catch {
    return { chatId: "", message: "" };
  }
}

export default {
  async fetch(request, env) {
    if (!env.PROXY_SECRET) return text("proxy secret is not configured", 500);
    if (!(await sameSecret(request.headers.get("x-proxy-secret") ?? "", env.PROXY_SECRET))) {
      return text("forbidden", 403);
    }
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/send") return text("not found", 404);
    if (!env.TELEGRAM_BOT_TOKEN) return text("bot token is not configured", 500);
    if (!env.TELEGRAM_CHAT_ID) return text("chat id is not configured", 500);

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return text("payload too large", 413);

    const { chatId, message } = parseMessage(new TextDecoder().decode(body), request.headers.get("content-type") ?? "");
    if (!message) return text("text is required", 400);
    const target = String(env.TELEGRAM_CHAT_ID);
    if (chatId && chatId !== target) return text("forbidden chat", 403);

    const upstream = await fetch(`${TELEGRAM_ORIGIN}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: message }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  },
};
