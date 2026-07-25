# 🤖 Telegram AI Bot — бесплатный ИИ-помощник

Бот для Telegram с встроенной ИИ на базе **Google Gemini API** (бесплатный тариф).

## ✨ Возможности

- 🆓 **Полностью бесплатно** — Gemini Flash имеет generous free tier
- 🧠 **Умные ответы** — модель Gemini 2.5 Flash отвечает на любой вопрос
- 💬 **История диалога** — бот помнит контекст беседы
- 🗑️ **Сброс истории** — команда `/clear`
- 🌍 **Поддержка любого языка** — отвечает на том же языке, что и вопрос
- ⚡ **Быстрый запуск** — одна команда `python3 bot.py`

## 🔧 Установка и запуск

### 1. Получить ключи

| Что нужно | Где взять |
|-----------|-----------|
| **Токен Telegram** | Напиши [@BotFather](https://t.me/botfather), создай бота — получишь токен |
| **API-ключ Gemini** | Зарегистрируйся на [Google AI Studio](https://aistudio.google.com/app/apikey) → Create API Key (бесплатно) |

> **Важно:** для Gemini API нужна только обычная учётка Google (не Google Cloud, не платёжка). Бесплатный лимит — 60 запросов/мин, 1500 запросов/день. Этого хватает на полноценное использование.

### 2. Заполнить конфиг

```bash
cd ~/tg_ai_bot
cp .env.example .env
nano .env   # вставь свои токены
```

### 3. Запустить

```bash
python3 bot.py
```

Бот запущен и готов отвечать в Telegram!

## 🚀 Запуск на сервере (чтобы работал 24/7)

```bash
# установи screen/tmux или используй systemd
screen -S tg_bot
python3 bot.py
# Ctrl+A, D — отключиться от screen
```

## 📋 Команды

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие |
| `/clear` | Очистить историю диалога |
| `/model` | Какая модель ИИ используется |
| `/stats` | Статистика диалога |

## 🧪 Смена модели

В `.env` поменяй `GEMINI_MODEL`:

```env
GEMINI_MODEL=gemini-2.5-flash      # рекомендую — умная и быстрая
GEMINI_MODEL=gemini-2.0-flash-lite  # ещё быстрее, чуть проще
```

## ⚙️ Системный промпт

Можешь задать стиль общения через `SYSTEM_PROMPT` в `.env`:

```env
SYSTEM_PROMPT=Ты — саркастичный ИТ-евангелист. Отвечай дерзко, но с юмором.
```

## 🛠 Технологии

- **Python 3.14+**
- [python-telegram-bot](https://github.com/python-telegram-bot/python-telegram-bot) v22.x
- [Google Generative AI SDK](https://github.com/google-gemini/generative-ai-python) (Gemini)
