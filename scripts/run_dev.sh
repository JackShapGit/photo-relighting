#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/.venv/bin/activate"
export RELIGHT_CACHE_DIR="$ROOT/cache/sessions"
uvicorn relighting_api.main:app --reload --port 8000
