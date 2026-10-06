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
if not exist "%APPDATA%\voice-notes-agent" mkdir "%APPDATA%\voice-notes-agent"
del "%APPDATA%\voice-notes-agent\proxy.json" 2>nul
rem Системный прокси Windows старый pip понимает неправильно — передаём его явно как http://
set "VNPROXY="
for /f "usebackq delims=" %%P in (`call "%PY%" "%~dp0proxy_fix.py"`) do set "VNPROXY=%%P"
if defined VNPROXY (
  echo  В Windows включён прокси %VNPROXY% — подключаюсь через него.
  set "HTTP_PROXY=%VNPROXY%"
  set "HTTPS_PROXY=%VNPROXY%"
)
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install --upgrade "faster-whisper>=1.1" requests sherpa-onnx pystray pillow nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
if not errorlevel 1 goto pip_ok
if not defined VNPROXY goto pip_fail
echo.
echo  Через прокси не получилось. Пробую напрямую, без прокси...
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "NO_PROXY=*"
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install --upgrade "faster-whisper>=1.1" requests sherpa-onnx pystray pillow nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
if not errorlevel 1 (
  echo {"proxy": "off"}> "%APPDATA%\voice-notes-agent\proxy.json"
  goto pip_ok
)
:pip_fail
echo.
echo  Ошибка установки библиотек. Сделайте снимок экрана последних строк и пришлите в чат.
pause
exit /b 1
:pip_ok
rem старая копия (в т. ч. запущенная ярлыком) должна закрыться, иначе файл занят и останутся две
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'pythonw.exe' -and $_.CommandLine -like '*vn_agent.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
copy /y "%~dp0vn_agent.py" "%DIR%\vn_agent.py" >nul
copy /y "%~dp0proxy_fix.py" "%DIR%\proxy_fix.py" >nul

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
"%PY%" "%DIR%\vn_agent.py" --install-extras
echo.
echo  Всё готово. Программа работает в фоне и сама запускается при входе в Windows.
echo  Её значок - в трее справа внизу, у часов (может прятаться под стрелкой). Правый щелчок - меню и «Выход».
echo  Запустить снова: ярлык «Голосовые заметки (ПК)» на рабочем столе или в меню «Пуск».
echo  Программа установлена в %DIR%
echo  Журнал работы: %APPDATA%\voice-notes-agent\agent.log  (или show-log.bat)
pause
