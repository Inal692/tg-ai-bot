#!/usr/bin/env python3
"""
🤖 Telegram-бот для PythonAnywhere (вебхуки + Flask)
"""
import logging
import os
from collections import defaultdict

import requests
from flask import Flask, request
from google import genai
from google.genai import types as genai_types

# ── конфиг из переменных окружения ──────────────────────────────────────────
BOT_TOKEN = os.environ["TG_BOT_TOKEN"]
GEMINI_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
MAX_HISTORY = int(os.environ.get("MAX_HISTORY", "20"))
SYSTEM_PROMPT = os.environ.get(
    "SYSTEM_PROMPT",
    "Ты — дружелюбный, полезный и умный ИИ-помощник в Telegram. "
    "Отвечай кратко, по делу, на том же языке, на котором к тебе обратились.",
)

TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# ── логирование ──────────────────────────────────────────────────────────────
logging.basicConfig(format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", level=logging.INFO)
log = logging.getLogger(__name__)

# ── Gemini ───────────────────────────────────────────────────────────────────
client = genai.Client(api_key=GEMINI_KEY)

# ── история диалогов ────────────────────────────────────────────────────────
chat_history: dict[int, list[dict]] = defaultdict(list)


# ── helpers ──────────────────────────────────────────────────────────────────

def _build_contents(user_id: int, message: str) -> list[genai_types.Content]:
    contents = []
    for msg in chat_history[user_id][-MAX_HISTORY:]:
        contents.append(genai_types.Content(
            role=msg["role"],
            parts=[genai_types.Part(text=msg["text"])],
        ))
    contents.append(genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=message)],
    ))
    return contents


def ask_gemini(user_id: int, user_message: str) -> str:
    try:
        contents = _build_contents(user_id, user_message)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=genai_types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                temperature=0.7,
                max_output_tokens=4096,
            ),
        )
        return response.text.strip()
    except Exception as exc:
        log.exception("Gemini error")
        return f"😔 Ошибка: {exc!s}"


def tg_send(chat_id: int, text: str) -> None:
    if len(text) > 4000:
        text = text[:4000] + "\n\n… *(ответ обрезан)*"
    try:
        requests.post(f"{TG_API}/sendMessage", json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }, timeout=15)
    except Exception as exc:
        log.error("Failed to send: %s", exc)


# ── обработка сообщений ─────────────────────────────────────────────────────

def handle_message(chat_id: int, user_id: int, text: str) -> str:
    # команды
    if text == "/start":
        return (
            f"👋 Привет!\n\n"
            f"Я — бот с бесплатной ИИ на базе **Google Gemini** ({GEMINI_MODEL}).\n"
            f"Просто напиши мне что-нибудь.\n\n"
            f"Команды:\n"
            f"• /clear — очистить историю\n"
            f"• /stats — статистика"
        )
    if text == "/clear":
        chat_history[user_id] = []
        return "🧹 История очищена!"
    if text == "/stats":
        return f"📈 Сообщений в истории: {len(chat_history.get(user_id, []))}"

    # обычный вопрос → Gemini
    answer = ask_gemini(user_id, text)

    # сохраняем в историю
    chat_history[user_id].append({"role": "user", "text": text})
    chat_history[user_id].append({"role": "model", "text": answer})

    return answer


# ── Flask ────────────────────────────────────────────────────────────────────

app = Flask(__name__)


@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json(force=True)
    log.info("Webhook: %s", data.get("message", {}).get("text", "(not a message)"))

    if "message" not in data:
        return "OK", 200

    msg = data["message"]
    chat_id = msg["chat"]["id"]
    user_id = msg["from"]["id"]
    text = msg.get("text", "").strip()

    if not text:
        return "OK", 200

    answer = handle_message(chat_id, user_id, text)
    tg_send(chat_id, answer)
    return "OK", 200


@app.route("/")
def index():
    return "🤖 Бот работает!"


# для локального теста
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
