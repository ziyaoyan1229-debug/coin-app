@echo off
chcp 65001 > nul
cd /d "%~dp0"
title HexStack 執行器
where node > nul 2>&1
if errorlevel 1 (
  echo 找不到 Node.js。請先到 https://nodejs.org 下載安裝 LTS 版，或改用 hexbot.exe 單檔版。
  pause
  exit /b 1
)
node hexbot.js %*
echo.
echo 執行器已結束。要重新開始請再雙擊這個檔案。
pause
