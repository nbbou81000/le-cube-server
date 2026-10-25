@echo off
chcp 65001 >nul
title Le Cube - Démarrage automatique
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\Le Cube - serveur.lnk'); $s.TargetPath='%~dp02-DEMARRER.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo  [X] Impossible de créer le raccourci de démarrage.
) else (
  echo.
  echo  [OK] Le serveur démarrera tout seul à chaque ouverture de session Windows.
  echo       ^(fenêtre réduite dans la barre des tâches^)
)
echo.
pause
