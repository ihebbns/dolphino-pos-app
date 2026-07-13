@echo off
title Dolphino POS — Démarrage...
cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules" (
    echo Installation requise. Lancement de l'installateur...
    call INSTALLER.bat
    exit /b
)

:: Launch Electron app
echo Démarrage de Dolphino POS...
npx electron . 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [!] Erreur au démarrage. Vérifiez l'installation.
    pause
)
