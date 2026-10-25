@echo off
chcp 65001 >nul
title Le Cube - Démarrage automatique
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -ErrorAction SilentlyContinue ([Environment]::GetFolderPath('Startup') + '\Le Cube - serveur.lnk')"
echo.
echo  [OK] Le serveur ne démarrera plus tout seul avec Windows.
echo.
pause
