@echo off
setlocal
set "ROOT=%~dp0.."
call "%ROOT%\.venv\Scripts\activate.bat" || exit /b 1
set "RELIGHT_CACHE_DIR=%ROOT%\cache\sessions"
set "RELIGHT_DEMO_PASSWORD="
uvicorn relighting_api.main:app --reload --port 8001
endlocal
