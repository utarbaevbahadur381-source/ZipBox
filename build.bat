@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Скачай с https://nodejs.org и запусти этот файл снова.
  pause
  exit /b 1
)
echo === Устанавливаю зависимости ===
call npm install
if errorlevel 1 goto err
echo === Собираю ZipBox.exe ===
call npm run dist
if errorlevel 1 goto err
echo.
echo Готово! Программа лежит в папке dist
explorer dist
pause
exit /b 0
:err
echo.
echo Что-то пошло не так. Прочитай сообщения выше или см. README.md
pause
exit /b 1
