@echo off
REM Launch the photo-relighting server for Cloudflare-Tunnel-facing demo use.
REM Loads RELIGHT_DEMO_PASSWORD from .env.demo and starts uvicorn (no reload).
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"

if not exist "%ROOT%.env.demo" (
    echo ERROR: .env.demo not found. Copy .env.demo.example to .env.demo and set RELIGHT_DEMO_PASSWORD.
    exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%.env.demo") do (
    set "key=%%A"
    set "val=%%B"
    if not "!key:~0,1!"=="#" if not "!key!"=="" set "!key!=!val!"
)

if "!RELIGHT_DEMO_PASSWORD!"=="" (
    echo ERROR: RELIGHT_DEMO_PASSWORD is empty in .env.demo.
    exit /b 1
)

call "%ROOT%scripts\run_demo.bat"
endlocal
