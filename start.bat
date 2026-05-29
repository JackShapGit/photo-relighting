@echo off
REM Start the photo-relighting dev server and open the browser.
setlocal
set "ROOT=%~dp0"
start "" "http://127.0.0.1:8001"
call "%ROOT%scripts\run_dev.bat"
endlocal
