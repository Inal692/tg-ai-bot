"""
Конфигурация бота — подгружаем из .env и переменных окружения.
"""
import os
from pathlib import Path
from dataclasses import dataclass, field

from dotenv import load_dotenv

# загружаем .env из той же папки, где лежит config.py
load_dotenv(Path(__file__).parent / ".env")


@dataclass
class Config:
    # Токен бота — получить у @BotFather в Telegram
    bot_token: str = field(default_factory=lambda: os.getenv("TG_BOT_TOKEN", ""))

    # API-ключ Google Gemini — получить на https://aistudio.google.com/app/apikey
    gemini_api_key: str = field(default_factory=lambda: os.getenv("GEMINI_API_KEY", ""))

    # Модель Gemini (бесплатные: gemini-2.5-flash, gemini-2.0-flash-lite)
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    # Максимальная длина истории диалога (пар "пользователь → бот")
    max_history: int = int(os.getenv("MAX_HISTORY", "20"))

    # Системный промпт — задаёт стиль и правила ИИ
    system_prompt: str = os.getenv(
        "SYSTEM_PROMPT",
        "Ты — дружелюбный, полезный и умный ИИ-помощник в Telegram. "
        "Отвечай кратко, по делу, на том же языке, на котором к тебе обратились. "
        "Если вопрос сложный — можно развернуто, но без воды.",
    )

    @property
    def is_valid(self) -> bool:
        return bool(self.bot_token) and bool(self.gemini_api_key)


config = Config()
