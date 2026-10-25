@echo off
chcp 65001 >nul
title Le Cube - Installation
cd /d "%~dp0"
echo.
echo  ==========================================================
echo     LE CUBE - Installation du serveur maison
echo  ==========================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js n'est pas installé sur ce PC.
  echo.
  echo      La page de téléchargement va s'ouvrir : prends la version "LTS",
  echo      installe-la ^(Suivant, Suivant...^) puis relance ce fichier.
  echo.
  start "" "https://nodejs.org/fr/download"
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo  [X] Ta version de Node.js est trop ancienne. Installe la version "LTS" actuelle.
  start "" "https://nodejs.org/fr/download"
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo  [OK] Node.js %%v est installé.

if exist "cloudflared.exe" (
  echo  [OK] cloudflared est déjà présent.
) else (
  echo  [..] Téléchargement de cloudflared ^(le tunnel Internet gratuit^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'"
  if exist "cloudflared.exe" (
    echo  [OK] cloudflared téléchargé.
  ) else (
    echo  [X] Le téléchargement de cloudflared a échoué. Vérifie la connexion Internet et relance ce fichier.
    pause
    exit /b 1
  )
)

if exist "node_modules\@electric-sql\pglite" (
  echo  [OK] Les composants du jeu sont présents.
) else (
  echo  [..] Installation des composants du jeu...
  call npm install --omit=dev --no-audit --no-fund
)

echo.
echo  ==========================================================
echo     Installation terminée !
echo     Lance maintenant  2-DEMARRER.bat  ^(double-clic^).
echo  ==========================================================
echo.
pause
