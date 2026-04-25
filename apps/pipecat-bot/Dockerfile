# syntax=docker/dockerfile:1.7

FROM python:3.12-slim AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY apps/pipecat-bot/pyproject.toml apps/pipecat-bot/uv.lock /app/
RUN uv sync --frozen --no-dev

COPY apps/pipecat-bot/quotid_bot /app/quotid_bot

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "quotid_bot.server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
