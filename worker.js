// Cloudflare Worker: Telegram Bot with Gemini AI
// Текст через Gemini, картинки через Pollinations.ai (бесплатно)

const SYSTEM_PROMPT = `Ты — полезный ИИ-помощник в Telegram.
Отвечай подробно, развёрнуто, без воды.
Если просят создать видео — отвечай, что не умеешь.
Отвечай на том же языке, что и вопрос.
После ответа добавляй строчку: "/mode — сменить режим".`;

const TEXT_MODEL = "gemini-3.5-flash";
const MAX_HISTORY = 15;

const userMode = new Map();
const chatHistory = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      return new Response("Bot is running", { status: 200 });
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      if (update.message) ctx.waitUntil(processMessage(update.message, env));
      return new Response("OK", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  },
};

async function processMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || "").trim();
  if (!text) return;

  // показываем "печатает..."
  sendAction(env, chatId);

  // ── команды ───────────────────────────────────────────────────────────────
  if (text === "/start") {
    return sendMsg(env, chatId,
      "👋 *Привет!* Я бот с ИИ на Google Gemini.\n\n"
      + "• ✍️ */mode text* — отвечаю на вопросы\n"
      + "• 🎨 */mode image* — создаю картинки\n"
      + "• 🧹 */clear* — очистить историю"
    );
  }

  if (text === "/mode" || text.startsWith("/mode ")) {
    const parts = text.split(" ");
    if (parts.length >= 2) {
      const m = parts[1];
      if (m === "text" || m === "image") {
        userMode.set(userId, m);
        return sendMsg(env, chatId,
          m === "text"
            ? "✅ *Текст* — задавай вопросы!"
            : "✅ *Картинки* — опиши что нарисовать!"
        );
      }
    }
    const cur = userMode.get(userId) || "text";
    return sendMsg(env, chatId,
      "🎛 Режим: " + (cur === "image" ? "🎨 Картинки" : "✍️ Текст")
      + "\n· `/mode text`\n· `/mode image`"
    );
  }

  if (text === "/clear") {
    chatHistory.set(userId, []);
    return sendMsg(env, chatId, "🧹 История очищена!");
  }

  // ── проверка на видео ────────────────────────────────────────────────────
  const low = text.toLowerCase();
  if (["видео", "video", "ролик", "клип", "сделай видео"].some(w => low.includes(w))) {
    return sendMsg(env, chatId, "😅 Я не умею создавать видео. Только текст ✍️ или картинки 🎨");
  }

  // ── режим ИЗОБРАЖЕНИЕ ────────────────────────────────────────────────────
  if ((userMode.get(userId) || "text") === "image") {
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendChatAction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "upload_photo" }),
    }).catch(() => {});

    const result = await generateImage(text);
    if (result.error) {
      await sendMsg(env, chatId, result.error);
    } else {
      await sendImage(env, chatId, result.url, result.caption);
    }
    return;
  }

  // ── режим ТЕКСТ ──────────────────────────────────────────────────────────
  const answer = await askGemini(userId, text, env);

  const h = chatHistory.get(userId) || [];
  h.push({ role: "user", text });
  h.push({ role: "model", text: "ok" });
  if (h.length > MAX_HISTORY * 2) h.splice(0, h.length - MAX_HISTORY * 2);
  chatHistory.set(userId, h);

  await sendMsg(env, chatId, answer);
}

// ── "печатает..." ────────────────────────────────────────────────────────────
async function sendAction(env, chatId) {
  try {
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendChatAction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch (_) {}
}

// ── Gemini: текст ────────────────────────────────────────────────────────────
async function askGemini(userId, message, env) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + TEXT_MODEL + ":generateContent?key=" + env.GEMINI_API_KEY;
  const h = chatHistory.get(userId) || [];
  const contents = h.slice(-MAX_HISTORY).map(m => ({ role: m.role, parts: [{ text: m.text }] }));
  contents.push({ role: "user", parts: [{ text: message }] });

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 8192 },
      }),
    });
    const data = await resp.json();
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || "😔 Нет ответа").trim();
  } catch (e) {
    return "😔 Ошибка Gemini: " + e.message;
  }
}

// ── Картинки через Pollinations.ai (бесплатно, без ключа) ────────────────────
async function generateImage(prompt) {
  try {
    const imageUrl = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt);

    // проверяем, что API отвечает
    const check = await fetch(imageUrl, { method: "HEAD" });
    if (!check.ok) throw new Error("HTTP " + check.status);

    return {
      url: imageUrl,
      caption: "🎨 " + prompt.slice(0, 100),
    };
  } catch (e) {
    return { error: "😔 Не удалось создать картинку. Попробуй другой запрос или `/mode text`" };
  }
}

// ── отправка текста ──────────────────────────────────────────────────────────
async function sendMsg(env, chatId, text) {
  if (text.length > 4000) text = text.slice(0, 4000) + "\n\n…*(обрезано)*";
  try {
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (_) {
    try {
      await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/[*_`\[\]]/g, "") }),
      });
    } catch (_) {}
  }
}

// ── отправка картинки (через URL — Telegram сам скачает) ─────────────────────
async function sendImage(env, chatId, imageUrl, caption) {
  try {
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendPhoto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: imageUrl,
        caption: (caption || "") + "\n\n🔄 /mode — сменить режим",
      }),
    });
  } catch (e) {
    await sendMsg(env, chatId, "😔 Ошибка отправки картинки");
  }
}
