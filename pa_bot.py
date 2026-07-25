#!/usr/bin/env python3
"""
🤖 Telegram-бот для PythonAnywhere (вебхуки + Flask).
Gemini вызывается через REST API (библиотека google-genai не нужна).
"""
import json
import logging
import os
from collections import defaultdict

import requests
from flask import Flask, request

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
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"
)

# ── логирование ──────────────────────────────────────────────────────────────
logging.basicConfig(format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", level=logging.INFO)
log = logging.getLogger(__name__)

# ── история диалогов ────────────────────────────────────────────────────────
chat_history: dict[int, list[dict]] = defaultdict(list)


# ── Gemini через REST ────────────────────────────────────────────────────────

def ask_gemini(user_id: int, user_message: str) -> str:
    """Отправляет запрос в Gemini через REST API и возвращает ответ."""
    try:
        # собираем содержимое: системный промпт + история + текущее сообщение
        contents = []
        for msg in chat_history[user_id][-MAX_HISTORY:]:
            contents.append({"role": msg["role"], "parts": [{"text": msg["text"]}]})
        contents.append({"role": "user", "parts": [{"text": user_message}]})

        payload = {
            "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": contents,
            "generationConfig": {
                "temperature": 0.7,
                "maxOutputTokens": 4096,
            },
        }

        log.info("Gemini запрос от user=%d: %.80s", user_id, user_message)
        resp = requests.post(GEMINI_URL, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        answer = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        log.info("Gemini ответ user=%d: %d символов", user_id, len(answer))
        return answer

    except Exception as exc:
        log.exception("Gemini ошибка user=%d", user_id)
        return f"😔 Ошибка: {exc!s}"


# ── отправка сообщений в Telegram ───────────────────────────────────────────

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
        log.error("Ошибка отправки: %s", exc)


# ── обработка сообщений ─────────────────────────────────────────────────────

def handle_message(chat_id: int, user_id: int, text: str) -> str:
    if text == "/start":
        return (
            f"👋 Привет! Я бот с бесплатной ИИ на базе **Google Gemini** ({GEMINI_MODEL}).\n\n"
            f"Просто напиши мне что-нибудь.\n"
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
    msg = data.get("message", {})

    log.info("Webhook от user=%d: %.80s", msg.get("from", {}).get("id"), msg.get("text", ""))

    if "message" not in data:
        return "OK", 200

    text = msg.get("text", "").strip()
    if not text:
        return "OK", 200

    chat_id = msg["chat"]["id"]
    user_id = msg["from"]["id"]

    answer = handle_message(chat_id, user_id, text)
    tg_send(chat_id, answer)
    return "OK", 200


@app.route("/")
def index():
    return "🤖 Бот работает!"


# для локального теста
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
