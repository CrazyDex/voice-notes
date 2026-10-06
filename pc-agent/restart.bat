@echo off
chcp 65001 >nul
copy /y "%~dp0vn_agent.py" "%LOCALAPPDATA%\voice-notes-agent\vn_agent.py" >nul
copy /y "%~dp0proxy_fix.py" "%LOCALAPPDATA%\voice-notes-agent\proxy_fix.py" >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'pythonw.exe' -and $_.CommandLine -like '*vn_agent.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'VoiceNotesAgent' -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName 'VoiceNotesAgent'"
echo Программа перезапущена (и обновлена из этой папки).
timeout /t 3 >nul
