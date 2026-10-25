@echo off
chcp 65001 >nul
title Le Cube - SERVEUR EN MARCHE (ne pas fermer cette fenêtre)
cd /d "%~dp0"
if not exist "cloudflared.exe" (
  echo  Lance d'abord 1-INSTALLER.bat
  pause
  exit /b 1
)
:boucle
node server.js
echo.
echo  Le serveur s'est arrêté. Redémarrage automatique dans 10 secondes...
echo  ^(pour l'arrêter vraiment, ferme cette fenêtre^)
timeout /t 10 >nul
goto boucle
