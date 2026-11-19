/**
 * COSMOS BOX — training request relay (Cloudflare Worker).
 *
 * The site never talks to Telegram directly: anything shipped to the browser
 * (including a bot token) can be read by any visitor. The form posts here and
 * this Worker forwards the request to Telegram, so the token stays on the
 * server side.
 *
 * Secrets (set in the Cloudflare dashboard → Worker → Settings →
 * Variables and secrets, or with `wrangler secret put`; never commit them):
 *   TELEGRAM_BOT_TOKEN — bot token from @BotFather
 *   TELEGRAM_CHAT_ID   — chat that receives booking requests
 *
 * Plain variables (wrangler.toml, not secret):
 *   ALLOWED_ORIGINS — comma-separated list of site origins allowed to post
 */

const MAX_BODY_BYTES = 4096;

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "https://cosmosbox.pro")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Strip control characters and cap the length so the form cannot be used to
// flood the chat with junk. No Telegram markup is used, so nothing is parsed.
function clean(value, limit = 200) {
  return String(value ?? "")
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, limit);
}

async function sendToTelegram(env, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    // Never echo Telegram's response body: an error message could contain
    // part of the token.
    throw new Error(`Telegram API responded ${response.status}`);
  }
}

export default {
  async fetch(request, env) {
    const origins = allowedOrigins(env);
    const origin = request.headers.get("Origin");
    const corsOrigin = origin && origins.includes(origin) ? origin : origins[0];
    const cors = corsHeaders(corsOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    // Only accept requests from our own site.
    if (origin && !origins.includes(origin)) {
      return new Response("Forbidden", { status: 403, headers: cors });
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets are not set");
      return new Response("Not Configured", { status: 503, headers: cors });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413, headers: cors });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return new Response("Bad Request", { status: 400, headers: cors });
    }

    // Honeypot: a hidden field a human never fills in.
    if (clean(data._gotcha)) {
      return Response.json({ ok: true }, { headers: cors });
    }

    const fields = {
      name: clean(data.name, 100),
      contact: clean(data.contact, 120),
      type: clean(data.type, 100),
      message: clean(data.message, 1500),
    };

    if (!fields.name || !fields.contact) {
      return new Response("Bad Request", { status: 400, headers: cors });
    }

    const time = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Madrid" });
    const lines = [
      "🥊 Новая заявка с сайта cosmosbox.pro",
      "",
      `👤 Имя: ${fields.name}`,
      `📱 Контакт: ${fields.contact}`,
      `🏋️ Тип тренировки: ${fields.type || "—"}`,
    ];
    if (fields.message) lines.push(`💬 Сообщение: ${fields.message}`);
    lines.push("", `⏰ ${time}`);
    const text = lines.join("\n");

    try {
      await sendToTelegram(env, text);
    } catch (err) {
      console.error("telegram delivery failed:", err.message);
      return new Response("Upstream Error", { status: 502, headers: cors });
    }

    return Response.json({ ok: true }, { headers: cors });
  },
};
