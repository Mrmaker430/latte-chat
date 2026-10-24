#!/usr/bin/env bash
# Latte — one-command start. Works on Linux, macOS and Termux (Android).
# Installs deps on first run, then serves on http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python

if ! "$PY" -c "import aimind, fastapi, uvicorn" >/dev/null 2>&1; then
  echo "→ installing dependencies…"
  "$PY" -m pip install -r requirements.txt \
    || "$PY" -m pip install --break-system-packages -r requirements.txt
fi

PORT="${PORT:-8000}"
echo "→ Latte is pouring at  http://localhost:${PORT}"
echo "  (same Wi-Fi? try http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<phone-ip>'):${PORT} from another device)"
exec "$PY" server.py
