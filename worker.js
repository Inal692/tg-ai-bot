// Cloudflare Worker: Telegram Bot with Gemini AI
// Режимы: текст / картинки, подробные ответы, "печатает..."

const SYSTEM_PROMPT = `Ты — полезный ИИ-помощник в Telegram.
Отвечай подробно, развёрнуто.
Если тебя просят создать видео — сразу отвечай, что не умеешь создавать видео.
Отвечай на том же языке, на котором к тебе обратились.
После каждого ответа добавляй короткую подсказку: "/mode — сменить режим".`;

const TEXT_MODEL = "gemini-3.5-flash";
const IMAGE_MODEL = "imagen-4.0-fast-generate-001";
const MAX_HISTORY = 15;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      return new Response("Bot is running", { status: 200 });
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      if (update.message) {
        ctx.waitUntil(processMessage(update.message, env));
      }
      return new Response("OK", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  },
};

// ── хранилище (in-memory, без KV) ───────────────────────────────────────────
const userMode = new Map();    // userId -> "text" | "image"
const chatHistory = new Map(); // userId -> [{role,text}]

async function processMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || "").trim();
  if (!text) return;

  // показываем "печатает..."
  fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendChatAction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});

  // ── команды ───────────────────────────────────────────────────────────────
  if (text === "/start") {
    return sendMsg(env, chatId,
      "👋 *Привет!* Я бот с ИИ от Google Gemini.\n\n"
      + "• ✍️ *Текст* — отвечаю на вопросы\n"
      + "• 🎨 *Картинки* — создаю изображения\n\n"
      + "Команды:\n"
      + "• `/mode` — посмотреть/сменить режим\n"
      + "• `/mode text` — текстовый режим\n"
      + "• `/mode image` — режим картинок\n"
      + "• `/clear` — очистить историю"
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
            ? "✅ *Текстовый* режим. Просто задавай вопросы!"
            : "✅ *Режим картинок*. Опиши, что нарисовать!"
        );
      }
    }
    return sendMsg(env, chatId,
      "🎛 *Текущий режим:* " + (userMode.get(userId) === "image" ? "🎨 Картинки" : "✍️ Текст")
      + "\n\n• `/mode text` — текст\n• `/mode image` — картинки"
    );
  }

  if (text === "/clear") {
    chatHistory.set(userId, []);
    return sendMsg(env, chatId, "🧹 История очищена!");
  }

  // ── проверка на видео ────────────────────────────────────────────────────
  const lower = text.toLowerCase();
  if (["видео", "video", "ролик", "клип", "сделай видео"].some(w => lower.includes(w))) {
    return sendMsg(env, chatId,
      "😅 Я не умею создавать видео.\n"
      + "Могу только текст ✍️ или картинки 🎨\n/compose /mode чтобы переключиться."
    );
  }

  // ── выбор режима ──────────────────────────────────────────────────────────
  const mode = userMode.get(userId) || "text";

  if (mode === "image") {
    const result = await generateImage(text, env);
    if (result.image) {
      await sendImage(env, chatId, result.image, result.caption);
    } else {
      await sendMsg(env, chatId, result.text);
    }
  } else {
    const answer = await askGemini(userId, text, env);
    await sendMsg(env, chatId, answer);
  }

  // ── сохраняем историю ────────────────────────────────────────────────────
  const h = chatHistory.get(userId) || [];
  h.push({ role: "user", text: text });
  h.push({ role: "model", text: "ответил" });
  if (h.length > MAX_HISTORY * 2) h.splice(0, h.length - MAX_HISTORY * 2);
  chatHistory.set(userId, h);
}

// ── Gemini: текст ────────────────────────────────────────────────────────────
async function askGemini(userId, message, env) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + TEXT_MODEL + ":generateContent?key=" + env.GEMINI_API_KEY;

  const h = chatHistory.get(userId) || [];
  const contents = [];
  for (const m of h.slice(-MAX_HISTORY)) {
    contents.push({ role: m.role, parts: [{ text: m.text }] });
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 8192 },
      }),
    });
    const data = await resp.json();
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || "😔 Нет ответа").trim();
  } catch (e) {
    return "😔 Ошибка Gemini: " + e.message;
  }
}

// ── Gemini/Imagen: изображение ───────────────────────────────────────────────
async function generateImage(prompt, env) {
  // Пробуем Imagen 4.0
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + IMAGE_MODEL + ":predict?key=" + env.GEMINI_API_KEY;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: prompt }],
        parameters: { sampleCount: 1 },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();

      // если Imagen не сработал — пробуем Gemini Flash Image
      if (resp.status === 404 || resp.status === 400) {
        return generateImageGemini(prompt, env);
      }

      return { text: "😔 Ошибка: " + (resp.status === 429 ? "лимит API" : "не удалось создать картинку") };
    }

    const data = await resp.json();
    const img = data.predictions?.[0]?.bytesBase64Encoded
               || data.predictions?.[0]?.mimeType?.startsWith("image/") && data.predictions?.[0]?.bytesBase64Encoded;

    if (img) {
      return { image: img, caption: prompt.slice(0, 100) };
    }

    // Если Imagen не дал картинку — пробуем Gemini
    return generateImageGemini(prompt, env);
  } catch (e) {
    return { text: "😔 Ошибка генерации: " + e.message + "\n\nПопробуй `/mode text`" };
  }
}

// ── Gemini Flash Image (запасной вариант) ────────────────────────────────────
async function generateImageGemini(prompt, env) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" + env.GEMINI_API_KEY;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseModalities: ["Image", "Text"],
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      if (resp.status === 429) {
        return { text: "😔 Лимит API на генерацию картинок. Попробуй позже или переключись в `/mode text`" };
      }
      return { text: "😔 Не удалось сгенерировать картинку. Попробуй другой запрос или `/mode text`" };
    }

    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];

    const imagePart = parts.find(p => p.inlineData);
    if (imagePart) {
      return { image: imagePart.inlineData.data, caption: parts.find(p => p.text)?.text || "" };
    }

    return { text: "😔 Не удалось создать картинку. Попробуй другой запрос или `/mode text`" };
  } catch (e) {
    return { text: "😔 Ошибка: " + e.message };
  }
}

// ── отправка текста ──────────────────────────────────────────────────────────
async function sendMsg(env, chatId, text) {
  if (text.length > 4000) text = text.slice(0, 4000) + "\n\n…*(обрезано)*";
  try {
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    // если Markdown упал — отправляем без форматирования
    try {
      await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/[*_`\[\]]/g, "") }),
      });
    } catch (e2) {}
  }
}

// ── отправка картинки ────────────────────────────────────────────────────────
async function sendImage(env, chatId, base64Data, caption) {
  try {
    const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const blob = new Blob([binary], { type: "image/png" });
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    fd.append("photo", blob, "image.png");
    if (caption) {
      fd.append("caption", caption.slice(0, 200) + "\n\n🔄 /mode — сменить режим");
    }
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendPhoto", {
      method: "POST",
      body: fd,
    });
  } catch (e) {
    await sendMsg(env, chatId, "😔 Ошибка отправки картинки");
  }
}
