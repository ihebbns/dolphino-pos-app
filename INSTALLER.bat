@echo off
title Dolphino POS — Installation
color 0A
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║          DOLPHINO POS - INSTALLATION         ║
echo  ║        Restaurant ^& Fast Food — Tunisie      ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js non trouvé. Téléchargement...
    echo  [!] Visitez: https://nodejs.org ^(version LTS^)
    echo  [!] Installez Node.js puis relancez ce fichier.
    pause
    start https://nodejs.org
    exit /b 1
)

echo  [✓] Node.js détecté
echo.
echo  [→] Installation des dépendances Electron...
npm install
if %errorlevel% neq 0 (
    echo  [!] Erreur npm install
    pause
    exit /b 1
)

echo.
echo  [✓] Installation terminée !
echo.
echo  [→] Création du raccourci sur le Bureau...

:: Create desktop shortcut via PowerShell
powershell -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Dolphino POS.lnk'); ^
   $s.TargetPath = '%CD%\LANCER.bat'; ^
   $s.WorkingDirectory = '%CD%'; ^
   $s.Description = 'Dolphino POS - Caisse Restaurant'; ^
   $s.Save()"

echo  [✓] Raccourci créé sur le Bureau
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Installation réussie ! Bonne caisse ! ║
echo  ╚══════════════════════════════════════════╝
echo.
echo  Appuyez sur une touche pour lancer le POS...
pause >nul
call LANCER.bat
