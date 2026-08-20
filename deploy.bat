@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Copiando archivos de producción a deploy-hosting...

if exist "deploy-hosting" rmdir /s /q "deploy-hosting"
mkdir "deploy-hosting"

copy /y "cromitos-auto.user.js" "deploy-hosting\" >nul
copy /y "README.md" "deploy-hosting\" >nul
copy /y "INSTALL.md" "deploy-hosting\" >nul
copy /y "CHANGELOG.md" "deploy-hosting\" >nul
copy /y "LICENSE.txt" "deploy-hosting\" >nul
copy /y "start.bat" "deploy-hosting\" >nul
if exist "docs" xcopy /e /i /y "docs" "deploy-hosting\docs\" >nul

echo.
echo Listo: %~dp0deploy-hosting
echo Ahí está el .user.js para instalarlo en el navegador.
pause
