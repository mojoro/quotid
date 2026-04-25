# syntax=docker/dockerfile:1.7

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY workers/temporal-worker/pyproject.toml workers/temporal-worker/uv.lock /app/
COPY workers/temporal-worker/quotid_worker /app/quotid_worker
COPY prisma /app/prisma
RUN ln -sf /app/prisma/schema.prisma /app/schema.prisma
RUN uv sync --frozen --no-dev
RUN uv run prisma generate

CMD ["uv", "run", "python", "-m", "quotid_worker.main"]
