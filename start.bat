@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  ══════════════════════════════════════
echo   Cromitos Auto
echo  ══════════════════════════════════════
echo.
echo  1. Instala Violentmonkey o Tampermonkey.
echo  2. Chrome / Edge: clic derecho en el icono
echo     → Administrar extensión
echo     → activa "Allow user scripts".
echo  3. Arrastra este archivo al gestor:
echo.
echo     %~dp0cromitos-auto.user.js
echo.
echo  Luego abre tu inventario de Steam o
echo  https://steamcommunity.com/market
echo  con la sesión iniciada.
echo.

if exist "%~dp0cromitos-auto.user.js" (
  explorer /select,"%~dp0cromitos-auto.user.js"
) else (
  echo  ERROR: no encuentro cromitos-auto.user.js
)

echo  Pulsa una tecla para cerrar...
pause >nul
