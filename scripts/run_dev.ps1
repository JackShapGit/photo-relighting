# Activate venv, then start uvicorn with hot reload.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root ".venv\Scripts\Activate.ps1")
$env:RELIGHT_CACHE_DIR = (Join-Path $root "cache\sessions")
uvicorn relighting_api.main:app --reload --port 8000
