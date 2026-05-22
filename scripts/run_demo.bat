@echo off
REM Activate venv, then start uvicorn for tunnel-facing demo use (no --reload).
setlocal
set "ROOT=%~dp0.."
call "%ROOT%\.venv\Scripts\activate.bat" || exit /b 1
set "RELIGHT_CACHE_DIR=%ROOT%\cache\sessions"
uvicorn relighting_api.main:app --host 127.0.0.1 --port 8000
endlocal
