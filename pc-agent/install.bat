@echo off
chcp 65001 >nul
setlocal
title Голосовые заметки — установка распознавания на ПК
set "DIR=%LOCALAPPDATA%\voice-notes-agent"
set "PY=%DIR%\venv\Scripts\python.exe"
set "PYW=%DIR%\venv\Scripts\pythonw.exe"

echo.
echo  1/4  Проверяю Python...
where py >nul 2>nul
if errorlevel 1 (
  echo  Python не найден. Устанавливаю Python 3.12 через winget...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  echo.
  echo  Python установлен. ЗАКРОЙТЕ это окно и запустите install.bat ещё раз.
  pause
  exit /b 1
)

if not exist "%PY%" (
  echo  Создаю отдельное окружение в %DIR%\venv ...
  py -3.12 -m venv "%DIR%\venv" 2>nul || py -3 -m venv "%DIR%\venv"
)
if not exist "%PY%" (
  echo  Не удалось создать окружение Python.
  pause
  exit /b 1
)

echo.
echo  2/4  Ставлю faster-whisper и библиотеки видеокарты (около 1,5 ГБ, несколько минут)...
"%PY%" -m pip install --upgrade pip >nul
"%PY%" -m pip install --upgrade "faster-whisper>=1.1" requests nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
if errorlevel 1 (
  echo  Ошибка установки библиотек. Сделайте снимок экрана и пришлите в чат.
  pause
  exit /b 1
)
copy /y "%~dp0vn_agent.py" "%DIR%\vn_agent.py" >nul

echo.
echo  3/4  Ключ Яндекс Диска и проверка модели
"%PY%" "%DIR%\vn_agent.py" --setup
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo  4/4  Включаю автозапуск при входе в Windows (работает и от батареи)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$a = New-ScheduledTaskAction -Execute '%PYW%' -Argument '\"%DIR%\vn_agent.py\"' -WorkingDirectory '%DIR%';" ^
  "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;" ^
  "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew;" ^
  "Register-ScheduledTask -TaskName 'VoiceNotesAgent' -Action $a -Trigger $t -Settings $s -Description 'Voice notes: speech recognition agent' -Force | Out-Null;" ^
  "Stop-ScheduledTask -TaskName 'VoiceNotesAgent' -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName 'VoiceNotesAgent'"
if errorlevel 1 (
  echo  Не удалось включить автозапуск. Сделайте снимок экрана и пришлите в чат.
  pause
  exit /b 1
)

echo.
echo  Всё готово. Программа работает в фоне и сама запускается при входе в Windows.
echo  Журнал работы: %APPDATA%\voice-notes-agent\agent.log  (или show-log.bat)
pause
