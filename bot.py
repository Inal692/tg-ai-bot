#!/usr/bin/env python3
"""
🤖 Telegram-бот со встроенной бесплатной ИИ на базе Google Gemini.

Запуск:
    cp .env.example .env   # заполнить ключи
    python3 bot.py
"""
import asyncio
import logging
import threading
from collections import defaultdict
from http.server import HTTPServer, BaseHTTPRequestHandler

from google import genai
from google.genai import types as genai_types
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

from config import config

# ── логирование ──────────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

# ── история диалогов (в памяти: user_id -> список Content) ───────────────────
chat_history: dict[int, list[genai_types.Content]] = defaultdict(list)


# ── helpers ──────────────────────────────────────────────────────────────────

def _init_gemini() -> genai.Client | None:
    """Инициализирует Gemini-клиент. Вернёт None, если ключ не задан."""
    if not config.gemini_api_key:
        log.error("GEMINI_API_KEY не задан — бот не сможет отвечать")
        return None
    client = genai.Client(api_key=config.gemini_api_key)
    log.info("Gemini клиент инициализирован, модель: %s", config.gemini_model)
    return client


client = _init_gemini()


def _build_contents(user_id: int, user_message: str) -> list[genai_types.Content]:
    """
    Собирает список Content для Gemini:
      - системный промпт
      - последние N пар из истории
      - текущее сообщение пользователя
    """
    contents: list[genai_types.Content] = []

    # история (последние max_history сообщений)
    history = chat_history[user_id][-config.max_history:]
    contents.extend(history)

    # текущее сообщение
    contents.append(genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=user_message)],
    ))
    return contents


async def ask_gemini(user_id: int, user_message: str) -> str:
    """Отправляет запрос в Gemini и возвращает ответ (или сообщение об ошибке)."""
    if client is None:
        return "❌ Бот не настроен: не задан GEMINI_API_KEY. Попроси администратора проверить .env"

    try:
        log.info("Gemini запрос от user=%d: %.80s", user_id, user_message)

        contents = _build_contents(user_id, user_message)

        response = await asyncio.to_thread(
            lambda: client.models.generate_content(
                model=config.gemini_model,
                contents=contents,
                config=genai_types.GenerateContentConfig(
                    system_instruction=config.system_prompt,
                    temperature=0.7,
                    max_output_tokens=4096,
                ),
            ),
        )

        answer = response.text.strip()
        log.info("Gemini ответ user=%d: %d символов", user_id, len(answer))
        return answer

    except Exception as exc:
        log.exception("Gemini ошибка user=%d", user_id)
        return f"😔 Извини, произошла ошибка при обращении к ИИ. Попробуй ещё раз позже.\n\n`{exc!s}`"


# ── обработчики ──────────────────────────────────────────────────────────────

async def start(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Команда /start — приветствие."""
    user = update.effective_user
    await update.message.reply_text(
        f"👋 Привет, {user.first_name}!\n\n"
        f"Я — бот с бесплатной ИИ на базе **Google Gemini** ({config.gemini_model}).\n"
        f"Просто напиши мне что-нибудь — и я отвечу.\n\n"
        f"Команды:\n"
        f"• /start — это сообщение\n"
        f"• /clear — очистить историю диалога\n"
        f"• /model — какая модель сейчас используется\n"
        f"• /stats — статистика диалога",
        parse_mode=ParseMode.MARKDOWN,
    )


async def clear_history(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Команда /clear — сброс истории."""
    user_id = update.effective_user.id
    if user_id in chat_history:
        chat_history[user_id] = []
    await update.message.reply_text("🧹 История диалога очищена! Начинаем с чистого листа.")


async def show_model(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Команда /model — показывает текущую модель."""
    text = (
        f"🤖 **Модель:** `{config.gemini_model}`\n"
        f"📊 **Бесплатный тариф Gemini:** лимит — 60 запросов/мин, 1 500 запросов/день"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)


async def show_stats(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Команда /stats — статистика диалога."""
    user_id = update.effective_user.id
    count = len(chat_history.get(user_id, []))
    await update.message.reply_text(
        f"📈 Сохранено сообщений в истории: **{count}**\n"
        f"(максимум: {config.max_history})",
        parse_mode=ParseMode.MARKDOWN,
    )


async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Обрабатывает любое текстовое сообщение."""
    user = update.effective_user
    user_id = user.id
    user_message = update.message.text.strip()

    if not user_message:
        return

    # печатает «...» в чате, пока бот думает
    await ctx.bot.send_chat_action(chat_id=update.effective_chat.id, action="typing")

    # спрашиваем Gemini
    answer = await ask_gemini(user_id, user_message)

    # сохраняем в историю (вопрос и ответ)
    chat_history[user_id].append(genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=user_message)],
    ))
    chat_history[user_id].append(genai_types.Content(
        role="model",
        parts=[genai_types.Part(text=answer)],
    ))

    # отправляем ответ (если длинный — режем, Telegram не любит >4096)
    if len(answer) > 4000:
        answer = answer[:4000] + "\n\n… *(ответ обрезан)*"

    await update.message.reply_text(answer, parse_mode=ParseMode.MARKDOWN)


async def error_handler(update: Update | object, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Глобальный обработчик ошибок."""
    log.error("Exception while handling an update: %s", context.error)


# ── health-check сервер (для Koyeb/Fly.io) ──────────────────────────────────

class _HealthHandler(BaseHTTPRequestHandler):
    """Возвращает 200 OK — Koyeb проверяет, что сервер жив."""

    def do_GET(self) -> None:                    # noqa: N802
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, fmt, *args) -> None:   # noqa: N802
        log.debug("Health: " + fmt, *args)


def _start_health_server() -> None:
    """Запускает простой HTTP-сервер на порту 8080 в фоновом потоке."""
    server = HTTPServer(("0.0.0.0", 8080), _HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info("Health-check сервер запущен на порту 8080")


# ── точка входа ──────────────────────────────────────────────────────────────

def main() -> None:
    if not config.is_valid:
        log.error(
            "❌ Конфигурация неполная. Убедись, что заданы переменные:\n"
            "  TG_BOT_TOKEN  — токен от @BotFather\n"
            "  GEMINI_API_KEY — ключ Google AI Studio\n\n"
            "Скопируй .env.example → .env и заполни."
        )
        return

    app = Application.builder().token(config.bot_token).build()

    # команды
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("clear", clear_history))
    app.add_handler(CommandHandler("model", show_model))
    app.add_handler(CommandHandler("stats", show_stats))

    # текстовые сообщения (не команды)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # ошибки
    app.add_error_handler(error_handler)

    # health-check (для облачных платформ)
    _start_health_server()

    log.info(
        "🚀 Бот запущен!\n"
        "   Telegram: @%s\n"
        "   Gemini:   %s\n"
        "   История:  %d сообщений макс.",
        config.bot_token.split(":")[0] if ":" in config.bot_token else "?",
        config.gemini_model,
        config.max_history,
    )
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
