@echo off
chcp 65001 >nul
echo Отключаю автозапуск и останавливаю программу распознавания...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'pythonw.exe' -and $_.CommandLine -like '*vn_agent.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
"%LOCALAPPDATA%\voice-notes-agent\venv\Scripts\python.exe" "%LOCALAPPDATA%\voice-notes-agent\vn_agent.py" --remove-extras 2>nul
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'VoiceNotesAgent' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'VoiceNotesAgent' -Confirm:$false -ErrorAction SilentlyContinue"
echo Готово. Чтобы освободить место, можно удалить папку %LOCALAPPDATA%\voice-notes-agent
echo (модели Whisper лежат в %USERPROFILE%\.cache\huggingface).
pause
