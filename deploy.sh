#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Secrets via SOPS (read from secrets.env)
if [[ -f secrets.env ]]; then
  set -a
  source secrets.env
  set +a
fi

# Build
docker compose build --no-cache

# Deploy
docker compose up -d

echo "clockwork deployed"
