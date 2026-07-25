// ==UserScript==
// name: tg-ai-bot
// ==/UserScript==
// 🤖 Telegram-бот с Gemini AI (текст + картинки, лимиты, рефералы)

// ── конфиг ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Ты — полезный ИИ-помощник в Telegram.
Отвечай подробно, развёрнуто, но без лишней воды.
Если тебя просят создать видео — сразу отвечай, что не умеешь создавать видео.
Отвечай на том же языке, на котором к тебе обратились.`;

const DAILY_LIMIT = 20;           // лимит запросов в день
const REFERRAL_BONUS = 5;         // бонус за реферала
const MAX_HISTORY = 15;           // пар сообщений в истории

// ── основной обработчик ──────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // health-check
    if (request.method === "GET") {
      return new Response("Bot is running", { status: 200 });
    }

    // webhook от Telegram
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

// ── обработка сообщения ──────────────────────────────────────────────────────
async function processMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || "").trim();
  if (!text) return;

  // ── показываем "печатает…" сразу ──────────────────────────────────────────
  sendAction(env, chatId);

  // ── реферальная система (команда /start ref_XXXX) ─────────────────────────
  if (text.startsWith("/start ") && text.includes("ref_")) {
    const refUserId = text.split("ref_")[1]?.split(" ")[0];
    if (refUserId && refUserId !== userId && env.BOT_DATA) {
      const key = "referral:" + refUserId;
      const count = parseInt((await env.BOT_DATA.get(key)) || "0");
      await env.BOT_DATA.put(key, String(count + REFERRAL_BONUS));
      await env.BOT_DATA.put("referred:" + userId, refUserId);
      await env.BOT_DATA.put("referral_used:" + refUserId + ":" + userId, "1");
      await sendMsg(env, chatId, "Добро пожаловать! 🎉\n\nПригласивший получил +" + REFERRAL_BONUS + " запросов.");
      return;
    }
  }

  // ── команда /start ────────────────────────────────────────────────────────
  if (text === "/start" || text.startsWith("/start ")) {
    await sendMsg(env, chatId,
      "👋 *Привет!* Я бот с ИИ на базе Google Gemini.\n\n"
      + "Я умею:\n"
      + "• ✍️ Отвечать на вопросы (режим *текст*)\n"
      + "• 🎨 Рисовать картинки (режим *изображение*)\n\n"
      + "Команды:\n"
      + "• `/mode` — посмотреть/сменить режим\n"
      + "• `/mode text` — текстовый режим\n"
      + "• `/mode image` — режим картинок\n"
      + "• `/limit` — сколько запросов осталось\n"
      + "• `/ref` — получить реферальную ссылку\n"
      + "• `/clear` — очистить историю"
    );
    return;
  }

  // ── команда /mode ─────────────────────────────────────────────────────────
  if (text === "/mode" || text.startsWith("/mode ")) {
    const parts = text.split(" ");
    if (parts.length >= 2) {
      const newMode = parts[1];
      if (newMode === "text" || newMode === "image") {
        if (env.BOT_DATA) {
          await env.BOT_DATA.put("mode:" + userId, newMode);
        }
        await sendMsg(env, chatId,
          newMode === "text"
            ? "✅ Переключён на *текстовый* режим. Просто задавай вопросы!"
            : "✅ Переключён на *режим изображений*. Опиши, что нарисовать!"
        );
        return;
      }
    }
    // показать текущий режим
    const mode = await getUserMode(userId, env);
    await sendMsg(env, chatId,
      "🎛 *Текущий режим:* " + (mode === "image" ? "🎨 Изображение" : "✍️ Текст")
      + "\n\nЧтобы сменить:\n• `/mode text` — текстовый режим\n• `/mode image` — режим картинок"
    );
    return;
  }

  // ── команда /limit ────────────────────────────────────────────────────────
  if (text === "/limit") {
    const used = await getDailyUsage(userId, env);
    const bonus = await getBonusRequests(userId, env);
    const remaining = DAILY_LIMIT + bonus - used;
    await sendMsg(env, chatId,
      "📊 *Лимит на сегодня:*\n"
      + "• Использовано: " + used + "\n"
      + "• Бонусных: " + bonus + "\n"
      + "• Осталось: " + Math.max(0, remaining)
    );
    return;
  }

  // ── команда /ref ──────────────────────────────────────────────────────────
  if (text === "/ref" || text === "/referral") {
    const botName = env.BOT_USERNAME || "td_ai_bot";
    const link = "https://t.me/" + botName + "?start=ref_" + userId;
    await sendMsg(env, chatId,
      "🔗 *Твоя реферальная ссылка:*\n`" + link + "`\n\n"
      + "За каждого приглашённого ты получишь +" + REFERRAL_BONUS + " запросов!"
    );
    return;
  }

  // ── команда /clear ────────────────────────────────────────────────────────
  if (text === "/clear") {
    if (env.BOT_DATA) {
      await env.BOT_DATA.put("history:" + userId, JSON.stringify([]));
    }
    await sendMsg(env, chatId, "🧹 История диалога очищена!");
    return;
  }

  // ── видео? ────────────────────────────────────────────────────────────────
  const lower = text.toLowerCase();
  const videoWords = ["видео", "video", "ролик", "клип", "mp4", "animation", "анимация", "сделай видео", "создай видео"];
  const isVideoRequest = videoWords.some(w => lower.includes(w)) && !lower.includes("не видео");
  if (isVideoRequest) {
    await sendMsg(env, chatId,
      "😅 Извини, я не умею создавать видео. Я могу только:\n"
      + "• ✍️ Отвечать текстом (режим *текст*)\n"
      + "• 🎨 Рисовать картинки (режим *изображение*)\n\n"
      + "Используй `/mode` чтобы переключиться."
    );
    return;
  }

  // ── проверка лимита ───────────────────────────────────────────────────────
  if (env.BOT_DATA) {
    const used = await getDailyUsage(userId, env);
    const bonus = await getBonusRequests(userId, env);
    if (used >= DAILY_LIMIT + bonus) {
      const botName = env.BOT_USERNAME || "td_ai_bot";
      const refLink = "https://t.me/" + botName + "?start=ref_" + userId;
      await sendMsg(env, chatId,
        "😔 Лимит на сегодня исчерпан (" + DAILY_LIMIT + " запросов).\n\n"
        + "Завтра лимит обновится ✨\n"
        + "Или пригласи друга и получи +" + REFERRAL_BONUS + " запросов: `" + refLink + "`"
      );
      return;
    }
  }

  // ── проверка ИИ по теме ───────────────────────────────────────────────────
  const currentMode = await getUserMode(userId, env);

  if (currentMode === "image") {
    // ── режим ИЗОБРАЖЕНИЕ ──
    const result = await generateImage(text, env);
    if (result.image) {
      await sendImage(env, chatId, result.image, result.caption);
    } else {
      await sendMsg(env, chatId, result.text);
    }
  } else {
    // ── режим ТЕКСТ ──
    const answer = await askGemini(userId, text, env);
    await sendMsg(env, chatId, answer);
  }

  // ── сохраняем историю и лимит ─────────────────────────────────────────────
  if (env.BOT_DATA) {
    // история
    const h = JSON.parse((await env.BOT_DATA.get("history:" + userId)) || "[]");
    h.push({ role: "user", text: text });
    h.push({ role: "model", text: answer || "сгенерировано изображение" });
    if (h.length > MAX_HISTORY * 2) h.splice(0, h.length - MAX_HISTORY * 2);
    await env.BOT_DATA.put("history:" + userId, JSON.stringify(h));

    // лимит
    const today = new Date().toISOString().slice(0, 10);
    const counter = parseInt((await env.BOT_DATA.get("daily:" + today + ":" + userId)) || "0");
    await env.BOT_DATA.put("daily:" + today + ":" + userId, String(counter + 1));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function getUserMode(userId, env) {
  if (!env.BOT_DATA) return "text";
  return (await env.BOT_DATA.get("mode:" + userId)) || "text";
}

async function getDailyUsage(userId, env) {
  if (!env.BOT_DATA) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return parseInt((await env.BOT_DATA.get("daily:" + today + ":" + userId)) || "0");
}

async function getBonusRequests(userId, env) {
  if (!env.BOT_DATA) return 0;
  return parseInt((await env.BOT_DATA.get("referral:" + userId)) || "0");
}

// ── показываем "печатает…" ──────────────────────────────────────────────────
async function sendAction(env, chatId) {
  try {
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendChatAction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch (e) { /* ignore */ }
}

// ── отправка текста ──────────────────────────────────────────────────────────
async function sendMsg(env, chatId, text) {
  const mode = "text"; // будет заменено ниже
  // добавляем подсказку по режиму в каждый ответ
  const hint = "\n\n—\n🔄 *Изменить режим:* /mode";
  if (text.length > 4000) text = text.slice(0, 4000) + "\n\n…*(обрезано)*";
  if (!text.includes("/mode") && !text.includes("режим")) {
    text = text + hint;
  }
  try {
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    // если Markdown не прошел — отправляем без форматирования
    try {
      await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/[*_`\[\]]/g, "") }),
      });
    } catch (e2) { /* ignore */ }
  }
}

// ── отправка изображения ─────────────────────────────────────────────────────
async function sendImage(env, chatId, base64Data, caption) {
  try {
    const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const blob = new Blob([binary], { type: "image/png" });
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("photo", blob, "image.png");
    if (caption) formData.append("caption", caption.slice(0, 200) + "\n\n🔄 /mode — сменить режим");
    await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendPhoto", {
      method: "POST",
      body: formData,
    });
  } catch (e) {
    await sendMsg(env, chatId, "😔 Не удалось отправить изображение: " + e.message);
  }
}

// ── Gemini: текст ────────────────────────────────────────────────────────────
async function askGemini(userId, message, env) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + env.GEMINI_API_KEY;

  // история
  let contents = [];
  if (env.BOT_DATA) {
    const hist = JSON.parse((await env.BOT_DATA.get("history:" + userId)) || "[]");
    for (const m of hist.slice(-MAX_HISTORY)) {
      contents.push({ role: m.role, parts: [{ text: m.text }] });
    }
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
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return (result || "😔 Нет ответа от ИИ").trim();
  } catch (e) {
    return "😔 Ошибка Gemini: " + e.message;
  }
}

// ── Gemini: изображение ──────────────────────────────────────────────────────
async function generateImage(prompt, env) {
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
      return { text: "😔 Ошибка генерации: " + (resp.status === 429 ? "лимит API" : errText.slice(0, 100)) };
    }

    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];

    const textPart = parts.find(p => p.text)?.text || "";
    const imagePart = parts.find(p => p.inlineData);

    if (imagePart) {
      return { image: imagePart.inlineData.data, caption: textPart };
    }

    // если изображения нет, но есть модель — сообщаем
    if (textPart.toLowerCase().includes("can't generate") || textPart.toLowerCase().includes("cannot")) {
      return { text: "😔 Модель не смогла сгенерировать изображение. Попробуй изменить запрос.\n\nИли переключись в текстовый режим: `/mode text`" };
    }

    return { text: "😔 Не удалось сгенерировать изображение. Попробуй другой запрос или переключись в `/mode text`" };
  } catch (e) {
    return { text: "😔 Ошибка: " + e.message + "\n\nПопробуй `/mode text`" };
  }
}
