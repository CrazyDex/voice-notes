@echo off
chcp 65001 >nul
echo Отключаю автозапуск и останавливаю программу распознавания...
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'VoiceNotesAgent' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'VoiceNotesAgent' -Confirm:$false -ErrorAction SilentlyContinue"
echo Готово. Чтобы освободить место, можно удалить папку %LOCALAPPDATA%\voice-notes-agent
echo (модели Whisper лежат в %USERPROFILE%\.cache\huggingface).
pause
