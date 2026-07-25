// ==UserScript==
// name: tg-ai-bot
// ==/UserScript==
// 🤖 Telegram-бот с Gemini AI для Cloudflare Workers

const HISTORY = new Map();  // chatId -> [{role, text}]
const MAX_HISTORY = 20;
const SYSTEM_PROMPT = "Ты — дружелюбный, полезный и умный ИИ-помощник в Telegram. Отвечай кратко, по делу, на том же языке, на котором к тебе обратились.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // health-check
    if (request.method === "GET") {
      return new Response("🤖 Бот работает!", { status: 200 });
    }

    // webhook от Telegram
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      if (update.message) {
        ctx.waitUntil(handleMessage(update.message, env));
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── обработка сообщений ───────────────────────────────────────────────────────

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (!text) return;

  // команды
  if (text === "/start") {
    return sendMsg(env, chatId,
      `👋 Привет! Я бот с бесплатной ИИ на базе **Google Gemini**.\n\n`
      + `Просто напиши мне что-нибудь.\n`
      + `• /clear — очистить историю\n`
      + `• /stats — статистика`);
  }
  if (text === "/clear") {
    HISTORY.set(String(userId), []);
    return sendMsg(env, chatId, "🧹 История очищена!");
  }
  if (text === "/stats") {
    const h = HISTORY.get(String(userId)) || [];
    return sendMsg(env, chatId, `📈 Сообщений в истории: ${h.length}`);
  }

  // спрашиваем Gemini
  const answer = await askGemini(userId, text, env);

  // сохраняем в историю
  const h = HISTORY.get(String(userId)) || [];
  h.push({ role: "user", text });
  h.push({ role: "model", text: answer });
  if (h.length > MAX_HISTORY * 2) h.splice(0, 2);
  HISTORY.set(String(userId), h);

  await sendMsg(env, chatId, answer);
}

// ── Gemini через REST API ────────────────────────────────────────────────────

async function askGemini(userId, message, env) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  // собираем историю
  const h = HISTORY.get(String(userId)) || [];
  const contents = [];
  for (const m of h.slice(-MAX_HISTORY)) {
    contents.push({ role: m.role, parts: [{ text: m.text }] });
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || "😔 Пустой ответ от ИИ";
  } catch (e) {
    return `😔 Ошибка: ${e.message}`;
  }
}

// ── отправка в Telegram ──────────────────────────────────────────────────────

async function sendMsg(env, chatId, text) {
  if (text.length > 4000) text = text.slice(0, 4000) + "\n\n… *(ответ обрезан)*";
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("send error:", e);
  }
}
