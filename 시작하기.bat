@echo off
title LMS
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node check-node.js
if errorlevel 1 goto oldnode

if "%PORT%"=="" set PORT=3000
if not "%LMS_NO_OPEN%"=="1" start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"
node --disable-warning=ExperimentalWarning server.js
echo.
echo LMS가 종료되었습니다.
pause
exit /b 0

:nonode
echo.
echo Node.js가 설치되어 있지 않습니다.
echo 곧 열리는 페이지에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행해 주세요.
echo.
start "" https://nodejs.org/ko/download
pause
exit /b 1

:oldnode
echo.
echo Node.js 버전이 낮습니다. 22.13 이상이 필요합니다.
echo 곧 열리는 페이지에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행해 주세요.
echo.
start "" https://nodejs.org/ko/download
pause
exit /b 1