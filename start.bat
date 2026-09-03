@echo off
setlocal

rem Run this file to start the debug Chrome session, Node server, and local page.
cd /d "%~dp0"

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
  echo Chrome was not found. Please install Google Chrome or edit start.bat.
  pause
  exit /b 1
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js and try again.
  pause
  exit /b 1
)

rem Reuse an already-running debug endpoint when possible; otherwise launch one.
curl.exe --silent --fail http://127.0.0.1:9222/json/version >nul 2>&1
if errorlevel 1 (
  start "Douyin Chrome" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%~dp0.chrome-debug-profile" --no-first-run --no-default-browser-check "https://www.douyin.com/user/self"
) else (
  start "Douyin Chrome" "%CHROME%" "https://www.douyin.com/user/self"
)

start "Douyin Node Server" cmd /k npm start
timeout /t 2 /nobreak >nul
start "Douyin Library" http://localhost:5173

echo Douyin EXT is starting at http://localhost:5173
endlocal
