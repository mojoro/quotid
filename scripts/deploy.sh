#!/usr/bin/env bash
set -euo pipefail

# Quotid deploy script — run from the repo root on the Lightsail instance.
# Prerequisites: repo cloned, .env copied into repo root.

echo "=== Quotid deploy ==="

# 1. Install Docker if missing
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  sudo apt-get update -qq
  sudo apt-get install -y docker.io docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo ""
  echo "Docker installed. Start a new shell (or run 'newgrp docker'), then re-run this script."
  exit 0
fi

# 2. Sanity checks
if [ ! -f "compose.yaml" ]; then
  echo "ERROR: Run this script from the quotid repo root (~/quotid)."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "ERROR: .env not found. Copy it from your local machine first:"
  echo "  scp .env ubuntu@<LIGHTSAIL-IP>:~/quotid/.env"
  exit 1
fi

# 3. Verify required env vars are set
for var in DATABASE_URL DIRECT_URL TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN \
           TWILIO_PHONE_NUMBER DEEPGRAM_API_KEY OPENROUTER_API_KEY \
           BOT_PUBLIC_URL APP_PUBLIC_URL; do
  val=$(grep -E "^${var}=" .env | cut -d= -f2- | tr -d '"' || true)
  if [ -z "$val" ] || [[ "$val" == *"example.com"* ]] || [[ "$val" == *"xxx"* ]]; then
    echo "WARNING: $var looks unset or placeholder — check .env before calling"
  fi
done

# 4. Pull pre-built base images and build app images, then start
echo "Building images and starting services..."
docker compose build --pull
docker compose up -d

# 5. Status
echo ""
echo "Waiting 10s for services to settle..."
sleep 10
docker compose ps

echo ""
echo "=== Done ==="
echo "App:  https://quotid.johnmoorman.com"
echo "Bot:  https://v.quotid.johnmoorman.com"
echo "Logs: docker compose logs -f"
