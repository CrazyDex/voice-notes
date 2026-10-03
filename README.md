ГОЛОСОВЫЕ ЗАМЕТКИ — PWA с локальным распознаванием речи (Whisper на устройстве)

Как разместить (нужен HTTPS, иначе браузер не даст микрофон):
  Вариант 1 — GitHub Pages: создать репозиторий, загрузить ВСЕ файлы этой папки в корень,
  Settings → Pages → Branch: main / root → Save. Через минуту будет адрес https://<имя>.github.io/<репо>/
  Вариант 2 — Netlify Drop (app.netlify.com/drop): перетащить папку с компьютера.
  Вариант 3 — Cloudflare Pages: Upload assets, перетащить папку.

На iPhone: открыть адрес в Safari → «Поделиться» → «На экран „Домой“».
Первая запись скачает модель (Small ≈ 250 МБ) — лучше по Wi-Fi. Дальше работает офлайн.

Файлы: index.html (интерфейс), app.js (логика), audio.js (микрофон, нарезка по паузам),
asr-worker.js (Whisper через transformers.js), sw.js (офлайн), manifest.webmanifest, иконки.
