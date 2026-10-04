import { Recorder, NullRecorder, releaseMic, encodeWav, decodeWav, segmentAll, decodeAudioFile } from './audio.js?v=1.8';
import { YDisk, API, PC_ONLINE_MS, ago, diffWords } from './pc.js?v=1.5';

/* ================= Настройки ================= */
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Встроенное распознавание браузера (на iPhone — то же, что диктовка Siri)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const DEFAULTS = { engine: SR && IS_IOS ? 'sys' : 'whisper', model: IS_IOS ? 'base' : 'small', device: 'auto', lang: 'ru', segMax: 12, autoload: true, keepAudio: true, pcAuto: false };
const MODELS = {
  tiny: { name: 'Tiny', size: '~45 МБ', note: 'Самая лёгкая. Много ошибок, но почти наверняка не вылетит — для проверки, что всё работает.' },
  base: { name: 'Base', size: '~80 МБ', note: 'Быстро и надёжно, но больше ошибок. Лучший вариант для «живого» текста на iPhone.' },
  small: { name: 'Small', size: '~250 МБ', note: 'Точнее, но на iPhone заметно медленнее: текст может догонять уже после остановки.' },
  medium: { name: 'Medium', size: '~800 МБ', note: 'Только для компьютера. На iPhone в браузере не хватает памяти.' },
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const S = Object.assign({}, DEFAULTS, ls.get('vn.settings', {}));
const saveS = () => ls.set('vn.settings', S);
const VERSION = '1.8';
if (!MODELS[S.model]) S.model = DEFAULTS.model;
// v0.4: на iPhone один раз переводим на Base — Small в Safari вылетал по памяти
if (IS_IOS && !ls.get('vn.mig04', false)) { if (S.model === 'small' || S.model === 'medium') S.model = 'base'; S.device = 'auto'; ls.set('vn.mig04', true); saveS(); }
// v0.7: Whisper в Safari на iPhone вылетает при распознавании — переводим на встроенное распознавание
if (IS_IOS && SR && !ls.get('vn.mig07', false)) { S.engine = 'sys'; ls.set('vn.mig07', true); saveS(); }
if (!SR) S.engine = 'whisper';
const useSys = () => S.engine === 'sys' && !!SR;
// Whisper в Safari на iPhone падает во время распознавания — там его не предлагаем
const RETRY_HINT = IS_IOS ? 'Аудио сохранено, его можно прослушать ниже.' : 'Нажмите «Перераспознать».';
// На iPhone WebGPU-версия Whisper упирается в лимит памяти Safari — по умолчанию считаем на CPU
function effDevice() { return S.device === 'auto' && IS_IOS ? 'wasm' : S.device; }
// На iPhone многопоточный WebAssembly с общей памятью — частая причина вылетов Safari, поэтому там один поток
function effThreads() { return !IS_IOS && self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1; }

/* ================= Журнал (виден после вылета) ================= */
// Последние шаги пишутся в localStorage сразу: если вкладка упадёт, при следующем запуске видно, на чём именно
const LOG_MAX = 40;
function trace(text, replaceSame) {
  try {
    const l = ls.get('vn.log', []);
    if (l.length && l[l.length - 1].slice(9) === text) return;
    // пульс «жив» не копится, а обновляет последнюю строку
    if (replaceSame && l.length && l[l.length - 1].slice(9).startsWith(replaceSame)) l.pop();
    l.push(new Date().toTimeString().slice(0, 8) + ' ' + text);
    ls.set('vn.log', l.slice(-LOG_MAX));
  } catch {}
}
// «Приложение живо и на экране». Если при запуске метка стоит — прошлый раз вкладка закрылась аварийно
const markAlive = (v) => ls.set('vn.alive', v);
// пульс раз в 3 с: по нему видно, сколько приложение прожило после последнего действия
const T0 = Date.now();
setInterval(() => { if (!document.hidden) trace(`жив ${Math.round((Date.now() - T0) / 1000)} с${rec ? ` · запись ${rec.seconds.toFixed(0)} с` : ''}${ASR.queue ? ' · в очереди ' + ASR.queue : ''}`, 'жив '); }, 3000);

/* ================= База (IndexedDB) ================= */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('voicenotes', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('notes', { keyPath: 'id' });
    db.createObjectStore('projects', { keyPath: 'id' });
    db.createObjectStore('audio');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const DB = {
  all: (s) => tx(s, 'readonly', (st) => st.getAll()),
  get: (s, k) => tx(s, 'readonly', (st) => st.get(k)),
  put: (s, v, k) => tx(s, 'readwrite', (st) => (k === undefined ? st.put(v) : st.put(v, k))),
  del: (s, k) => tx(s, 'readwrite', (st) => st.delete(k)),
};

/* ================= Состояние ================= */
let notes = [], projects = [], crashNote = '';
const filter = { project: null, tag: null, q: '' };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

const TAG_RE = /(^|[\s(,.;:!?])#([\p{L}\p{N}_\-/]+)/gu;
const LINK_RE = /\[\[([^\[\]\n]{1,120})\]\]/g;

function titleOf(n) {
  if (n.title?.trim()) return n.title.trim();
  const t = (n.text || '').replace(/^#{1,6} .*$/gm, '').replace(LINK_RE, (_, x) => linkParts(x).label).replace(/\s+/g, ' ').trim();
  if (t) { const w = t.split(' ').slice(0, 7).join(' '); return w.length < t.length ? w + '…' : w; }
  return 'Заметка ' + fmtDate(n.createdAt);
}
function tagsOf(n) {
  const set = new Set(n.tags || []);
  for (const m of (n.text || '').matchAll(TAG_RE)) set.add(m[2].toLowerCase());
  return [...set];
}
// [[Заметка|текст]] — ссылка на «Заметку», а в тексте видно «текст» (как в Obsidian)
function linkParts(x) { const i = x.indexOf('|'); return i < 0 ? { target: x.trim(), label: x.trim() } : { target: x.slice(0, i).trim(), label: x.slice(i + 1).trim() || x.slice(0, i).trim() }; }
function linksOf(n) { return [...(n.text || '').matchAll(LINK_RE)].map((m) => linkParts(m[1]).target); }

/* ---- Подсказки меток и связей: простое сравнение слов, без моделей ---- */
const STOP = new Set('и в во на не что как это об о обо для по из за от до у к ко с со же ли бы то а но или да нет его ее её их мы вы они он она оно я ты мне меня нам вас там тут так уже еще ещё все всё very the and for with this that'.split(' '));
const END_RE = /(иями|ями|ами|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ов|ев|ей|ах|ях|ам|ям|ом|ем|ию|ия|ии|ть|ся|сь|а|я|о|е|ы|и|у|ю|ь|й)$/;
function stem(w) {
  w = w.toLowerCase().replace(/ё/g, 'е');
  if (w.length <= 3) return w;
  const r = w.replace(END_RE, '');
  return r.length >= 3 ? r : w;
}
const sameStem = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && Math.abs(a.length - b.length) <= 2 && (a.startsWith(b) || b.startsWith(a)));
const WORD_RE = /[\p{L}\p{N}]+/gu;
// значимые слова с позициями; пропускаем то, что уже внутри [[ссылок]] и #меток
function wordsOf(text) {
  const skip = [];
  for (const m of text.matchAll(LINK_RE)) skip.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(TAG_RE)) skip.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/^#{1,6} .*$/gm)) skip.push([m.index, m.index + m[0].length]); // заголовки «🎙 дата»
  const out = [];
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0], i = m.index;
    if (skip.some(([a, b]) => i >= a && i < b)) continue;
    out.push({ w, s: stem(w), i, e: i + w.length, stop: w.length < 3 || STOP.has(w.toLowerCase()) });
  }
  return out;
}
const keyWords = (s) => [...s.replace(/[_\-/]/g, ' ').matchAll(WORD_RE)].map((m) => m[0]).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase())).map(stem);
// ищет в тексте подряд идущие слова, похожие на keys (между ними допускаются короткие служебные слова)
function findRun(words, keys) {
  for (let k = 0; k < words.length; k++) {
    if (words[k].stop || !sameStem(words[k].s, keys[0])) continue;
    let j = k, ki = 1;
    while (ki < keys.length) {
      let t = j + 1;
      while (t < words.length && words[t].stop && t - j <= 2) t++;
      if (t < words.length && !words[t].stop && sameStem(words[t].s, keys[ki])) { j = t; ki++; } else break;
    }
    if (ki === keys.length) return { a: words[k].i, b: words[j].e };
  }
  return null;
}
function suggestFor(n) {
  const text = n.text || '';
  if (!text.trim()) return [];
  const words = wordsOf(text), sig = words.filter((w) => !w.stop);
  if (!sig.length) return [];
  const hidden = new Set(n.sugHidden || []), out = [];
  const has = new Set(tagsOf(n));
  const counts = {};
  notes.forEach((o) => { if (o.id !== n.id) tagsOf(o).forEach((t) => (counts[t] = (counts[t] || 0) + 1)); });
  for (const [t, c] of Object.entries(counts)) {
    if (has.has(t) || hidden.has('#' + t)) continue;
    const keys = keyWords(t); if (!keys.length) continue;
    const hit = keys.every((k) => sig.some((w) => sameStem(w.s, k)));
    if (hit) out.push({ kind: 'tag', key: '#' + t, tag: t, score: keys.length * 10 + c });
  }
  const linked = new Set(linksOf(n).map((l) => l.toLowerCase()));
  for (const o of notes) {
    if (o.id === n.id || !o.title?.trim()) continue;
    const title = o.title.trim();
    if (linked.has(title.toLowerCase()) || hidden.has('[[' + title.toLowerCase())) continue;
    const keys = keyWords(title); if (!keys.length || keys.length > 6) continue;
    const run = findRun(words, keys);
    if (run) { out.push({ kind: 'link', key: '[[' + title.toLowerCase(), title, run, score: keys.length * 10 + 5 }); continue; }
    // слова названия встречаются не подряд — тоже подсказываем, если их хватает
    const found = keys.filter((k) => sig.some((w) => sameStem(w.s, k))).length;
    if (keys.length >= 2 && found === keys.length) out.push({ kind: 'link', key: '[[' + title.toLowerCase(), title, run: null, score: keys.length * 5 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}
function applySuggestion(n, g) {
  if (g.kind === 'tag') { if (!(n.tags || []).includes(g.tag)) n.tags = [...(n.tags || []), g.tag]; return; }
  const text = n.text || '';
  if (g.run) {
    const frag = text.slice(g.run.a, g.run.b);
    const link = frag.toLowerCase() === g.title.toLowerCase() ? `[[${g.title}]]` : `[[${g.title}|${frag}]]`;
    n.text = text.slice(0, g.run.a) + link + text.slice(g.run.b);
  } else n.text = text.replace(/\s*$/, '') + ` [[${g.title}]]`;
  n.segTexts = null; n.prefix = '';
}
function sugHTML(n) {
  const list = suggestFor(n);
  if (!list.length) return '';
  return `<div class="sec">Подсказки</div><div class="chips" style="flex-wrap:wrap">${list.map((g, i) => g.kind === 'tag'
    ? `<button class="chip tag" data-sug="${i}">+ #${esc(g.tag)}</button>`
    : `<button class="chip" data-sug="${i}">+ 🔗 ${esc(g.title)}</button>`).join('')}<button class="chip" data-sughide style="color:var(--muted)">Скрыть</button></div>`;
}

function findByTitle(t) { const k = t.trim().toLowerCase(); return notes.find((n) => titleOf(n).toLowerCase() === k || (n.title || '').trim().toLowerCase() === k); }
function fmtDate(ts) { return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function fmtDur(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function projName(id) { return projects.find((p) => p.id === id)?.name; }

let saveTimers = {};
function saveNote(n, delay = 0) {
  n.updatedAt = Date.now();
  clearTimeout(saveTimers[n.id]);
  saveTimers[n.id] = setTimeout(() => DB.put('notes', n).catch((e) => toast('Ошибка сохранения: ' + e)), delay);
}

// Весь текст заметки одной кнопкой: без разметки ### и с подписями ссылок вместо [[…]]
function plainText(n) {
  return (n.text || '').replace(/^#{1,6} /gm, '').replace(LINK_RE, (_, x) => linkParts(x).label).trim();
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  // запасной путь для старых браузеров
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;opacity:0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

/* ================= Обновление приложения ================= */
// Номер свежей версии берём прямо из app.js на сайте, мимо всех кэшей
async function latestVersion() {
  try {
    const t = await (await fetch('app.js?check=' + Date.now(), { cache: 'no-store' })).text();
    return t.match(/const VERSION = '([\d.]+)'/)?.[1] || null;
  } catch { return null; }
}
async function applyUpdate() {
  if (rec) { toast('Сначала остановите запись'); return; }
  toast('Обновляю…', 5000);
  trace('обновление: с ' + VERSION);
  try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch {}
  try { for (const k of await caches.keys()) if (k.startsWith('vn-shell')) await caches.delete(k); } catch {}
  location.reload();
}
let lastCheck = 0;
async function checkUpdate(manual) {
  if (!manual && Date.now() - lastCheck < 10 * 60 * 1000) return;
  lastCheck = Date.now();
  const v = await latestVersion();
  if (v && v !== VERSION) {
    if (manual) { applyUpdate(); return; }
    if ($('#updbar')) return;
    const b = document.createElement('div');
    b.id = 'updbar'; b.className = 'toast';
    b.style.cssText = 'top:calc(env(safe-area-inset-top) + 10px);bottom:auto;display:flex;gap:10px;align-items:center';
    b.innerHTML = `<span>Есть новая версия ${esc(v)}</span><button class="btn" style="padding:6px 10px">Обновить</button><button aria-label="Закрыть" style="padding:4px 6px">✕</button>`;
    const [upd, close] = b.querySelectorAll('button');
    upd.onclick = applyUpdate; close.onclick = () => b.remove();
    document.body.appendChild(b);
  } else if (manual) toast(v ? `У вас последняя версия (${VERSION})` : 'Не удалось проверить — нет интернета?');
}

/* ================= Иконки ================= */
const I = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6M9 15l3 3 3-3"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

/* ================= Распознавание ================= */
const ASR = {
  w: null, state: 'idle', msg: '', progress: 0, info: null, pending: new Map(), seq: 0, want: '',
  rtf: ls.get('vn.rtf', null),
  init() {
    try {
      this.w = new Worker('asr-worker.js?v=1.5', { type: 'module' });
      this.w.onmessage = (e) => this.on(e.data);
      this.w.onerror = (e) => { this.state = 'error'; this.msg = 'Модуль распознавания не запустился (нужен интернет при первом запуске).'; asrUI(); e.preventDefault?.(); };
    } catch (e) { this.state = 'error'; this.msg = String(e); }
  },
  load() {
    if (!this.w) this.init();
    if (!this.w) return;
    this.state = 'loading'; this.progress = 0; this.msg = 'Запуск…';
    this.want = S.model + '|' + S.device;
    // Метка «идёт загрузка»: если приложение вылетит, при следующем запуске увидим её и откатимся на более лёгкий режим
    ls.set('vn.loading', { model: S.model, device: effDevice(), t: Date.now() });
    trace(`модель: загрузка ${S.model} / ${effDevice() === 'wasm' ? 'CPU×' + effThreads() : effDevice()}`);
    this.w.postMessage({ type: 'load', model: S.model, device: effDevice(), threads: effThreads() });
    asrUI();
  },
  ensure() {
    const key = S.model + '|' + S.device;
    if ((this.state === 'ready' || this.state === 'loading') && this.want === key) return;
    this.load();
  },
  run(audio) {
    this.ensure();
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, res);
      trace(`распознавание: кусок ${(audio.length / 16000).toFixed(1)} с`);
      this.w.postMessage({ type: 'run', id, audio, language: S.lang }, [audio.buffer]);
    });
  },
  get queue() { return this.pending.size; },
  on(m) {
    if (m.type === 'boot') { this.isolated = m.isolated; }
    else if (m.type === 'trace') { trace('распознавание: ' + m.text, m.replace); return; }
    else if (m.type === 'status') { this.msg = m.text; trace('модель: ' + m.text); if (m.stage) { const g = ls.get('vn.loading', null); if (g) ls.set('vn.loading', { ...g, device: m.stage.dev }); } }
    else if (m.type === 'progress') {
      if (m.filePct === 100) trace(`скачан ${m.file} (${m.fileMB.toFixed(0)} МБ)`);
      this.progress = m.filePct / 100;
      this.msg = `Скачано ${m.loadedMB.toFixed(0)} МБ · файл ${m.file} (${m.fileMB.toFixed(0)} МБ): ${m.filePct}%`;
    }
    else if (m.type === 'ready') {
      this.state = 'ready'; this.info = m; this.msg = '';
      trace(`модель готова: ${m.repo} (${m.device}${m.threads ? '×' + m.threads : ''})`);
      ls.set('vn.loading', null);
      ls.set('vn.safe', false);
      ls.set('vn.dl.' + m.model, true);
      try { navigator.storage?.persist?.(); } catch {}
    }
    else if (m.type === 'error') { this.state = 'error'; this.msg = m.text; trace('ошибка модели: ' + m.text.slice(0, 200)); ls.set('vn.loading', null); }
    else if (m.type === 'result') {
      const res = this.pending.get(m.id); this.pending.delete(m.id);
      trace(m.error ? 'распознавание: ошибка ' + m.error : `распознано за ${(m.ms / 1000).toFixed(1)} с`);
      if (m.ms && m.dur) { this.rtf = m.ms / 1000 / m.dur; ls.set('vn.rtf', this.rtf); }
      res && res(m);
    }
    asrUI();
  },
};

function asrStatusHTML() {
  if (useSys()) return `<span class="dot ok"></span><span>Встроенное распознавание ${IS_IOS ? 'iPhone' : 'браузера'}</span>`;
  const name = MODELS[S.model].name;
  let cls = '', txt;
  if (ASR.state === 'ready') { cls = 'ok'; txt = `${name} · ${ASR.info.device === 'webgpu' ? 'WebGPU' : 'CPU×' + ASR.info.threads} · готово`; }
  else if (ASR.state === 'loading') { cls = 'warn'; txt = `${name}: ${ASR.msg || 'загрузка…'}`; }
  else if (ASR.state === 'error') { cls = 'err'; txt = 'Ошибка модели — открыть настройки'; }
  else txt = `${name} · загрузится при первой записи (${MODELS[S.model].size})`;
  if (ASR.queue) txt += ` · в очереди: ${ASR.queue}`;
  if (ASR.rtf && ASR.state === 'ready') txt += ` · скорость ×${ASR.rtf.toFixed(2)}`;
  return `<span class="dot ${cls}"></span><span>${esc(txt)}</span>`;
}
function asrUI() {
  document.querySelectorAll('[data-asr]').forEach((el) => (el.innerHTML = asrStatusHTML()));
  const p = $('#dlprog'); if (p) p.style.width = (ASR.state === 'ready' ? 100 : ASR.progress * 100) + '%';
  const m = $('#dlmsg'); if (m) m.textContent = ASR.state === 'error' ? ASR.msg : ASR.state === 'ready' ? `Загружено: ${ASR.info.repo} (${ASR.info.device})` : ASR.msg;
  const q = $('#recq'); if (q) q.textContent = recInfo();
}

/* ================= Очередь распознавания ================= */
const HALL = [/субтитр/i, /dimatorzok/i, /продолжение следует/i, /спасибо за просмотр/i, /подпис(ыв)?айтесь/i, /amara\.org/i, /редактор/i];
function clean(t) {
  t = (t || '').trim();
  if (!t || /^[\s.,!?…\-–—]*$/.test(t)) return '';
  if (t.length < 90 && HALL.some((r) => r.test(t))) return '';
  if (/^[\[(][^\])]*[\])]$/.test(t)) return ''; // «[музыка]», «(аплодисменты)»
  return t;
}
const jobs = new Map(); // noteId -> {total, done}

function enqueue(note, audio, index) {
  note.segTexts = note.segTexts || [];
  note.segTexts[index] = null;
  const j = jobs.get(note.id) || { total: 0, done: 0, failed: 0 };
  j.total++; jobs.set(note.id, j);
  note.status = 'transcribing';
  ASR.run(audio).then((m) => {
    j.done++;
    if (m.error) { j.failed++; note.segTexts[index] = ''; }
    else note.segTexts[index] = clean(m.text);
    note.text = joinSegs(note);
    finishIfDone(note);
    saveNote(note, 300);
    onNoteChanged(note);
  });
}
function joinSegs(n) {
  const head = n.prefix ? (n.prefix.endsWith('\n') ? n.prefix : n.prefix + ' ') : '';
  return (head + (n.segTexts || []).filter(Boolean).join(' ')).trim();
}
function finishIfDone(note) {
  const j = jobs.get(note.id);
  if (!j || note.status === 'recording') return;
  if (j.done >= j.total) {
    note.status = j.failed ? 'error' : 'done';
    jobs.delete(note.id);
    if (j.failed) toast('Часть записи не распознана — можно перераспознать');
  }
}

/* ================= Журнал: дозапись голосом в существующую заметку ================= */
// Текст заметки — главное. Каждая новая запись не перезаписывает его, а добавляет в конец раздел
// «### 🎙 4 октября 2026, 11:40» со своим текстом; аудио записи хранится отдельно (note.clips),
// его можно прослушать и отдельно отправить на компьютер. В экспорте под заголовком — ![[аудио]].
// clip = { id, at, head, duration, hasAudio, pc, pcText }
const clipKey = (n, c) => n.id + '--' + c.id;
function clipHead(n, ts) {
  const d = new Date(ts);
  const base = '### 🎙 ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  let h = base, k = 2;
  while ((n.text || '').includes(h) || (n.clips || []).some((c) => c.head === h)) h = `${base} (${k++})`;
  return h;
}
// где в тексте раздел этой записи: от её заголовка до заголовка следующей записи (или до конца)
function clipRange(n, c) {
  const t = n.text || '';
  const h = c.head ? t.indexOf(c.head) : -1;
  if (h < 0) return null;
  const a = h + c.head.length;
  let b = t.length;
  for (const o of n.clips || []) { if (o === c || !o.head) continue; const i = t.indexOf(o.head, a); if (i >= 0 && i < b) b = i; }
  return { a, b, body: t.slice(a, b).trim() };
}
function setClipBody(n, r, body) {
  const t = n.text || '', rest = t.slice(r.b);
  setText(n, t.slice(0, r.a) + '\n' + body.trim() + (rest ? '\n\n' + rest : ''));
}
// Первая запись заметки тоже начинается с заголовка «### 🎙 дата» (note.head) — единый вид журнала.
// Её раздел — от начала (после заголовка) до первой дозаписи; расшифровка с ПК меняет только его.
function mainRange(n) {
  const t = n.text || '';
  const a = n.head && t.startsWith(n.head) ? n.head.length : 0;
  let b = t.length;
  for (const c of n.clips || []) { if (!c.head) continue; const i = t.indexOf(c.head, a); if (i >= 0 && i < b) b = i; }
  return { a, b, body: t.slice(a, b).trim() };
}
function setMainBody(n, r, body) {
  const t = n.text || '', rest = t.slice(r.b);
  setText(n, (t.slice(0, r.a) + (r.a ? '\n' : '') + body.trim() + (rest ? '\n\n' + rest : '')).trim());
}
const clipTime = (c) => new Date(c.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/* ================= Запись ================= */
let rec = null, recNote = null, recTimer = null, wake = null, segIndex = 0;

function recInfo() {
  if (useSys()) return 'Встроенное распознавание' + (Sys.err ? ' · ' + Sys.err : '');
  const j = recNote && jobs.get(recNote.id);
  const parts = [MODELS[S.model].name];
  if (ASR.state === 'loading') parts.push(ASR.msg || 'загрузка модели');
  if (j) parts.push(`кусков: ${j.done}/${j.total}`);
  if (ASR.rtf && ASR.state === 'ready') parts.push(`скорость ×${ASR.rtf.toFixed(2)}`);
  return parts.join(' · ');
}

// target — существующая заметка: запись дописывается в неё новым разделом (журнал), а не создаёт новую
async function startRecording(target) {
  if (rec) return;
  let note, clip = null, undo = null;
  if (target && target.id) {
    if (jobs.has(target.id) || target.status === 'transcribing' || target.status === 'recording') { toast('Дождитесь окончания распознавания'); return; }
    note = target;
    undo = { text: note.text, segTexts: note.segTexts, prefix: note.prefix, status: note.status };
    clip = { id: uid(), at: Date.now() };
    clip.head = clipHead(note, clip.at);
    const base = (note.text || '').replace(/\s+$/, '');
    // прежний текст — неизменная «шапка», новый текст пишется после заголовка раздела
    note.prefix = (base ? base + '\n\n' : '') + clip.head + '\n';
    note.segTexts = [];
    note.clips = [...(note.clips || []), clip];
    note.recClip = clip.id;
    note.status = 'recording';
    note.text = joinSegs(note);
  } else {
    note = {
      id: uid(), createdAt: Date.now(), updatedAt: Date.now(), title: '', text: '', segTexts: [],
      tags: [], projectId: filter.project && filter.project !== 'none' ? filter.project : null, status: 'recording',
    };
    if (filter.tag) note.tags.push(filter.tag);
    note.head = clipHead(note, note.createdAt);
    note.prefix = note.head + '\n';
  }
  const recKey = clip ? clipKey(note, clip) : note.id;
  const sys = useSys();
  trace('запись: нажата кнопка' + (sys ? ' (встроенное распознавание)' : '') + (clip ? ' · дозапись в заметку' : ''));
  // если встроенное распознавание не уживается с нашей записью звука — пишем только текст
  rec = sys && ls.get('vn.sysNoRec', false) ? new NullRecorder() : new Recorder();
  segIndex = 0;
  try {
    // сначала микрофон, потом распознавание: пока наш поток открыт, Safari не спрашивает разрешение
    // второй раз для распознавания (раньше оба запроса шли одновременно — два вопроса подряд)
    await rec.start({
      segOpts: { minSec: 3, maxSec: S.segMax, silenceMs: 500 },
      onSegment: (a) => { if (!sys) enqueue(note, a, segIndex++); },
      log: trace,
    });
    if (sys) Sys.start(note);
  } catch (e) {
    rec = null;
    if (sys) Sys.abort();
    if (clip) { Object.assign(note, undo); note.clips = note.clips.filter((c) => c !== clip); delete note.recClip; }
    trace('запись: ошибка ' + (e?.name || '') + ' ' + (e?.message || e));
    toast(e?.name === 'NotAllowedError' ? 'Нет доступа к микрофону. Разрешите его в настройках Safari.' : 'Микрофон недоступен: ' + (e?.message || e), 4500);
    return;
  }
  recNote = note;
  trace('запись: старт');
  note.parts = 0;
  if (!clip) notes.unshift(note);
  saveNote(note);
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  renderRec();
  recTimer = setInterval(updateRec, 100);
  // Автосохранение звука каждые 5 с: если приложение вылетит, запись не пропадёт
  const r = rec;
  recSaver = setInterval(async () => {
    if (rec !== r) return;
    const pcm = r.takeNew();
    if (!pcm.length) return;
    const k = note.parts++;
    if (clip) clip.duration = r.seconds; else note.duration = r.seconds;
    await DB.put('audio', encodeWav(pcm), recKey + ':p' + k);
    saveNote(note);
  }, 5000);
  // модель грузим чуть позже, чтобы запись точно успела стартовать
  if (!sys && !ls.get('vn.safe', false)) setTimeout(() => ASR.ensure(), 300);
}
let recSaver = null;

async function stopRecording() {
  if (!rec) return;
  clearInterval(recTimer); clearInterval(recSaver);
  const r = rec; rec = null;
  trace('запись: стоп');
  const note = recNote;
  if (Sys.note === note) { await Sys.stop(); note.segTexts = Sys.texts(); note.text = joinSegs(note); Sys.note = null; }
  recNote = null;
  const pcm = await rec_stop(r);
  try { await wake?.release(); } catch {}
  wake = null;
  const clip = note.recClip ? (note.clips || []).find((c) => c.id === note.recClip) : null;
  const key = clip ? clipKey(note, clip) : note.id, holder = clip || note;
  delete note.recClip;
  holder.duration = pcm.length ? pcm.length / 16000 : r.seconds;
  if (S.keepAudio && pcm.length) { await DB.put('audio', encodeWav(pcm), key); holder.hasAudio = true; }
  for (let i = 0; i < (note.parts || 0); i++) await DB.del('audio', key + ':p' + i);
  note.parts = 0;
  note.status = jobs.has(note.id) ? 'transcribing' : 'done';
  finishIfDone(note);
  if (S.pcAuto && pcOn() && holder.hasAudio) holder.pc = { state: 'outbox', sentAt: Date.now(), base: clip ? clipRange(note, clip)?.body || '' : mainRange(note).body };
  saveNote(note);
  if (holder.pc) pcSync();
  $('.rec')?.remove();
  editMode = false;
  if (location.hash === '#/n/' + note.id) render(); else location.hash = '#/n/' + note.id;
  if (clip) toast('Дописано в заметку');
}

function renderRec() {
  const el = document.createElement('div');
  el.className = 'rec';
  const quick = ['идея', 'баг', 'задача', 'вопрос'];
  const into = recNote.recClip ? `<div class="small center" style="padding:10px 0 4px">Дописываю в «${esc(titleOf(recNote))}» — прежний текст не изменится</div>` : '';
  el.innerHTML = into ? `${into}
    <div class="timer" id="rtime">0:00</div>
    <div class="meter"><i id="rlvl"></i></div>
    <div class="small center" id="recq">${esc(recInfo())}</div>
    <div class="live" id="rlive"><span class="pend">Говорите… новый текст появится здесь.</span></div>
    <button class="stopbtn" id="rstop" aria-label="Остановить"><i></i></button>
    <div class="small center" style="margin-top:10px">Нажмите, чтобы остановить.</div>` : `
    <div class="chips" id="rqt">
      <button class="chip" data-proj>${I.folder.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"')} ${esc(projName(recNote.projectId) || 'Без проекта')}</button>
      ${quick.map((t) => `<button class="chip tag ${recNote.tags.includes(t) ? 'on' : ''}" data-t="${t}">#${t}</button>`).join('')}
    </div>
    <div class="timer" id="rtime">0:00</div>
    <div class="meter"><i id="rlvl"></i></div>
    <div class="small center" id="recq">${esc(recInfo())}</div>
    <div class="live" id="rlive"><span class="pend">Говорите… текст появится через несколько секунд после первой паузы.</span></div>
    <button class="stopbtn" id="rstop" aria-label="Остановить"><i></i></button>
    <div class="small center" style="margin-top:10px">Нажмите, чтобы остановить. Распознавание доделается в фоне.</div>`;
  document.body.appendChild(el);
  $('#rstop').onclick = stopRecording;
  if (into) return;
  el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.t, i = recNote.tags.indexOf(t);
    if (i >= 0) recNote.tags.splice(i, 1); else recNote.tags.push(t);
    b.classList.toggle('on', i < 0); saveNote(recNote, 300);
  }));
  $('[data-proj]', el).onclick = () => pickProject(recNote.projectId, (pid) => {
    recNote.projectId = pid; saveNote(recNote, 300);
    $('[data-proj]', el).innerHTML = I.folder.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"') + ' ' + esc(projName(pid) || 'Без проекта');
  });
}
function updateRec() {
  if (!rec) return;
  const t = $('#rtime'); if (t) t.textContent = fmtDur(rec.seconds);
  const l = $('#rlvl'); if (l) l.style.width = Math.min(100, Math.sqrt(rec.level) * 260) + '%';
}
function updateRecLive() {
  const box = $('#rlive'); if (!box || !recNote) return;
  const parts = (recNote.segTexts || []).map((s) => (s === null ? '<span class="pend">…</span>' : esc(s)));
  if (parts.length) { box.innerHTML = parts.join(' '); box.scrollTop = box.scrollHeight; }
  const q = $('#recq'); if (q) q.textContent = recInfo();
}

function onNoteChanged(note) {
  if (recNote && note.id === recNote.id) updateRecLive();
  const r = route();
  if (r.name === 'note' && r.id === note.id) updateNoteDyn(note);
  else if (r.name === 'home') renderList();
  asrUI();
}

// запись могла быть подменена заглушкой во время работы (см. Sys) — останавливаем то, что есть
async function rec_stop(r) { try { return await r.stop(); } catch { return new Float32Array(0); } }

/* ================= Встроенное распознавание (Web Speech API) ================= */
// Safari обрывает сессию распознавания на паузах и примерно через минуту — перезапускаем, пока идёт запись.
// Встроенное распознавание не ставит знаков. Голосовые команды («запятая», «точка», «вопросительный знак»,
// «новая строка»…) превращаем в знаки, конец фразы (пауза) — в точку, начало предложения — с заглавной.
const PUNCT_CMDS = [
  [/(^|\s)вопросительный знак(?=\s|$)/giu, '?'],
  [/(^|\s)восклицательный знак(?=\s|$)/giu, '!'],
  [/(^|\s)многоточие(?=\s|$)/giu, '…'],
  [/(^|\s)двоеточие(?=\s|$)/giu, ':'],
  [/(^|\s)точка с запятой(?=\s|$)/giu, ';'],
  [/(^|\s)запятая(?=\s|$)/giu, ','],
  [/(^|\s)точка(?=\s|$)(?!\s+зрения)/giu, '.'],
  [/(^|\s)(новая строка|с новой строки|новый абзац)(?=\s|$)/giu, '\n'],
];
function punctuate(t, final) {
  t = (t || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  for (const [re, ch] of PUNCT_CMDS) t = t.replace(re, ch);
  t = t.replace(/ *\n */g, '\n').replace(/\s+([,.!?:;…])/g, '$1').replace(/([,.!?:;…])(?=[^\s,.!?:;…\n])/g, '$1 ');
  // Apple начинает новое предложение с заглавной, но без точки — ставим точку перед ним
  t = t.replace(/(\p{Ll})\s+(?=\p{Lu}\p{Ll})/gu, '$1. ');
  // заглавная в начале и после .!?… и переноса строки
  t = t.replace(/(^|[.!?…]\s+|\n)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  if (final && !/[.!?…:;,]$/.test(t)) t += '.';
  if (final) t = t.replace(/,$/, '.');
  return t;
}

const Sys = {
  r: null, on: false, done: [], cur: '', note: null, err: '', quick: 0, endWait: null,
  texts() { return [...this.done.map((t) => punctuate(t, true)), punctuate(this.cur, false)].filter(Boolean); },
  start(note) {
    this.note = note; this.on = true; this.done = []; this.cur = ''; this.err = ''; this.quick = 0; this.revives = 0;
    this.spawn();
    // Сторож: иногда Safari запускает распознавание, но оно не получает звук (в журнале «слушаю», текста нет,
    // при стопе «No speech detected»), хотя наш микрофон речь слышит. Тогда перезапускаем сессию,
    // а если не помогло — отдаём микрофон распознаванию (дальше только текст, без звука для ПК).
    clearInterval(this.dog);
    this.dog = setInterval(() => {
      if (!this.on || !this.r || this.heard || !rec) return;
      const age = (Date.now() - this.t0) / 1000, voiced = rec.voicedSec - this.v0;
      if (age < 4 || voiced < 1.5) return;
      if (++this.revives <= 2) {
        trace(`встроенное: не слышит (речь ${voiced.toFixed(1)} с), перезапуск ${this.revives}`);
        try { this.r.abort(); } catch {}
        return;
      }
      if (!(rec instanceof NullRecorder)) {
        trace('встроенное: всё ещё не слышит — отдаю микрофон распознаванию, звук дальше не пишется');
        const old = rec; rec = new NullRecorder(old.seconds); rec.start(); old.stop().catch(() => {}).finally(() => releaseMic(true));
        try { this.r.abort(); } catch {}
      }
      clearInterval(this.dog);
    }, 1000);
  },
  spawn() {
    const r = new SR();
    this.r = r;
    r.lang = { ru: 'ru-RU', en: 'en-US' }[S.lang] || navigator.language || 'ru-RU';
    r.continuous = true;
    r.interimResults = true;
    const t0 = Date.now();
    this.t0 = t0; this.heard = false; this.v0 = rec ? rec.voicedSec : 0;
    r.onstart = () => trace('встроенное: слушаю');
    r.onaudiostart = () => trace('встроенное: звук пошёл');
    r.onspeechstart = () => { this.heard = true; trace('встроенное: слышу речь'); };
    r.onresult = (e) => {
      if (!this.heard) { this.heard = true; trace('встроенное: первый текст'); }
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript + ' ';
      this.cur = t.replace(/\s+/g, ' ').trim();
      this.quick = 0;
      if (this.note) { this.note.segTexts = this.texts(); this.note.text = joinSegs(this.note); updateRecLive(); saveNote(this.note, 500); }
    };
    r.onerror = (e) => {
      trace('встроенное: ошибка ' + e.error + (e.message ? ' ' + e.message : ''));
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.on = false; this.err = 'нет разрешения';
        toast('Распознавание речи запрещено. Включите Siri и Диктовку: Настройки iPhone → Основные → Клавиатура → «Включить диктовку».', 7000);
      } else if (e.error === 'audio-capture' && rec && !(rec instanceof NullRecorder)) {
        // микрофон занят нашей записью звука: дальше пишем только текст
        ls.set('vn.sysNoRec', true);
        trace('встроенное: отключаю запись звука, чтобы освободить микрофон');
        const old = rec; rec = new NullRecorder(old.seconds); rec.start(); old.stop().catch(() => {}).finally(() => releaseMic(true));
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') this.err = e.error;
    };
    r.onend = () => {
      if (this.cur) this.done.push(this.cur);
      this.cur = '';
      if (this.endWait) { const f = this.endWait; this.endWait = null; f(); return; }
      if (!this.on) return;
      if (Date.now() - t0 < 1500 && ++this.quick > 5) { this.on = false; this.err = 'распознавание не запускается'; trace('встроенное: не запускается, сдаюсь'); updateRecLive(); return; }
      try { this.spawn(); } catch (err) { trace('встроенное: перезапуск не удался ' + err); }
    };
    try { r.start(); } catch (err) { trace('встроенное: start ' + err); }
  },
  stop() {
    this.on = false; clearInterval(this.dog);
    if (!this.r) return Promise.resolve();
    return new Promise((res) => {
      this.endWait = res;
      try { this.r.stop(); } catch { this.endWait = null; res(); return; }
      setTimeout(() => { if (this.endWait) { this.endWait = null; if (this.cur) { this.done.push(this.cur); this.cur = ''; } res(); } }, 2000);
    });
  },
  abort() { this.on = false; this.note = null; clearInterval(this.dog); try { this.r?.abort(); } catch {} },
};

/* ================= Перераспознавание ================= */
async function retranscribe(note) {
  const blob = await DB.get('audio', note.id);
  if (!blob) { toast('Аудио не сохранено'); return; }
  if (note.text && note.status === 'done' && !confirm('Текст будет заменён новым распознаванием. Продолжить?')) return;
  const pcm = await decodeWav(blob);
  const segs = segmentAll(pcm, { minSec: 3, maxSec: S.segMax, silenceMs: 500 });
  addVersion(note, 'До перераспознавания', note.text);
  const keepHead = note.head && (note.text || '').startsWith(note.head);
  note.segTexts = []; note.prefix = keepHead ? note.head + '\n' : ''; note.text = keepHead ? note.head : ''; note.status = 'transcribing';
  jobs.delete(note.id);
  if (!segs.length) { note.status = 'done'; toast('В записи не найдено речи'); }
  segs.forEach((s, i) => enqueue(note, s.a, i));
  saveNote(note);
  onNoteChanged(note);
}

/* ================= Распознавание на компьютере (через Яндекс Диск) ================= */
// note.pc = { state: 'outbox' | 'queued' | 'ready' | 'done' | 'error', sentAt, base, model, err }
//   outbox — ещё не загружено на Диск (нет сети), queued — ждёт ПК, ready — текст с ПК ждёт решения
// note.pcText — расшифровка с ПК, если заметку успели поправить вручную (сама не подставляется)
// note.versions — прежние варианты текста [{label, text, at}], чтобы ничего не терялось
const PC = {
  token: () => ls.get('vn.ydToken', ''),
  disk: () => new YDisk(PC.token(), ls.get('vn.ydApi', API)),
  seen: () => ls.get('vn.pcSeen', null), // {seen, model, device, busy}
  busy: false, timer: null, dirsOk: false,
};
const pcOn = () => !!PC.token();
// pcActive/pcBoxHTML работают и с заметкой, и с отдельной записью журнала (у обеих есть .pc / .pcText)
const pcActive = (n) => n.pc && (n.pc.state === 'outbox' || n.pc.state === 'queued');
const pcAnyActive = (n) => pcActive(n) || (n.clips || []).some(pcActive);
const pcAnyReady = (n) => n.pc?.state === 'ready' || (n.clips || []).some((c) => c.pc?.state === 'ready');
// всё, что отправлено на ПК: заметка целиком (ключ = id) и записи журнала (ключ = id--clip)
function pcUnits() {
  const out = [];
  for (const n of notes) {
    if (n.pc) out.push({ n, o: n, key: n.id });
    for (const c of n.clips || []) if (c.pc) out.push({ n, o: c, c, key: clipKey(n, c) });
  }
  return out;
}
function pcOnlineText() {
  const p = PC.seen();
  if (!p?.seen) return { on: false, text: 'Программа на компьютере ещё ни разу не выходила на связь.' };
  if (Date.now() - p.seen < PC_ONLINE_MS) return { on: true, text: `Компьютер в сети${p.model ? ' · ' + p.model : ''}${p.device ? ' (' + (p.device === 'cuda' ? 'видеокарта' : 'процессор') + ')' : ''}.` };
  return { on: false, text: `Компьютер выключен (был в сети ${ago(p.seen)}).` };
}
function addVersion(n, label, text) {
  if (!text?.trim()) return;
  n.versions = n.versions || [];
  if (n.versions.some((v) => v.text === text)) return;
  n.versions.unshift({ label, text, at: Date.now() });
  n.versions = n.versions.slice(0, 8);
}
function setText(n, text) { n.text = text; n.segTexts = null; n.prefix = ''; }
async function sendToPC(n, quiet, c) {
  if (!pcOn()) { toast('Сначала подключите Яндекс Диск в настройках'); location.hash = '#/settings'; return; }
  const o = c || n;
  if (!o.hasAudio) { toast('У заметки нет аудио'); return; }
  if (pcActive(o)) { toast('Уже в очереди на компьютер'); return; }
  if (o.pc?.state === 'ready') { toast('Расшифровка с ПК уже готова — выберите, что с ней сделать'); return; }
  o.pc = { state: 'outbox', sentAt: Date.now(), base: c ? clipRange(n, c)?.body || '' : mainRange(n).body };
  trace('ПК: в очередь ' + (c ? clipKey(n, c) : n.id));
  saveNote(n); onNoteChanged(n);
  if (!quiet) toast(pcOnlineText().on ? 'Отправляю на компьютер…' : 'Компьютер выключен — задание будет ждать в очереди');
  pcSync();
}
async function cancelPC(n, c) {
  const o = c || n, was = o.pc?.state; o.pc = null; saveNote(n); onNoteChanged(n);
  if (was === 'queued') try { await PC.disk().remove(`app:/jobs/${c ? clipKey(n, c) : n.id}.wav`); } catch {}
}
// Пришла расшифровка с ПК. Если текст не трогали после отправки — подставляем сами,
// если трогали — ничего не перезаписываем, показываем плашку с выбором.
function applyPCResult(n, res) {
  if (res.error) { n.pc = { ...n.pc, state: 'error', err: res.error }; return 'error'; }
  const text = (res.text || '').trim();
  const editing = $('#ntext') && lastNoteId === n.id;
  const r = mainRange(n);
  const untouched = !editing && r.body === (n.pc?.base || '').trim();
  n.pc = { ...n.pc, state: untouched ? 'done' : 'ready', model: res.model, device: res.device, doneAt: Date.now() };
  if (untouched) { addVersion(n, 'До компьютера', n.text); setMainBody(n, r, text); delete n.pcText; if (n.status !== 'recording') n.status = 'done'; return 'replaced'; }
  n.pcText = text; return 'ready';
}
// То же для записи журнала: заменяется только её раздел и только если его не правили после отправки
function applyClipResult(n, c, res) {
  if (res.error) { c.pc = { ...c.pc, state: 'error', err: res.error }; return 'error'; }
  const text = (res.text || '').trim();
  const editing = $('#ntext') && lastNoteId === n.id;
  const r = clipRange(n, c);
  const untouched = !editing && r && r.body === (c.pc?.base || '').trim();
  c.pc = { ...c.pc, state: untouched ? 'done' : 'ready', model: res.model, device: res.device, doneAt: Date.now() };
  if (untouched) { addVersion(n, 'До компьютера', n.text); setClipBody(n, r, text); delete c.pcText; return 'replaced'; }
  c.pcText = text; return 'ready';
}
function resolveClipPC(n, c, how) {
  const t = c.pcText || '', r = clipRange(n, c);
  if (how === 'replace' && r) { addVersion(n, 'Мой текст', n.text); setClipBody(n, r, t); }
  else if (how === 'append' && r) setClipBody(n, r, r.body + '\n\n— Расшифровка с компьютера —\n' + t);
  // раздел не найден (заголовок стёрли) — добавляем расшифровку в конец, ничего не заменяя
  else if (how === 'append' || how === 'replace') setText(n, (n.text || '').trimEnd() + `\n\n— Расшифровка с компьютера (запись ${clipTime(c)}) —\n` + t);
  else addVersion(n, `С компьютера (запись ${clipTime(c)})`, t);
  delete c.pcText; c.pc = { ...c.pc, state: 'done' };
  saveNote(n); renderNote(n.id);
}
function resolvePC(n, how) {
  const t = n.pcText || '';
  const r = mainRange(n);
  // заменяется только раздел первой записи — дозаписи журнала остаются на месте
  if (how === 'replace') { addVersion(n, 'Мой текст', n.text); setMainBody(n, r, t); }
  else if (how === 'append') setMainBody(n, r, r.body + '\n\n— Расшифровка с компьютера —\n' + t);
  else addVersion(n, 'С компьютера', t);
  delete n.pcText; n.pc = { ...n.pc, state: 'done' };
  saveNote(n); renderNote(n.id);
}
function diffHTML(a, b) {
  return diffWords(a, b).map((p) => p.t === '=' ? esc(p.s) : p.t === '-' ? `<del>${esc(p.s)}</del>` : `<ins>${esc(p.s)}</ins>`).join('');
}
function showDiff(a, b, title) {
  sheet(`<div class="row" style="margin-bottom:10px"><b class="grow">${esc(title)}</b><button class="btn" data-close>Закрыть</button></div>
    <div class="small" style="margin-bottom:8px"><del>зачёркнуто</del> — есть только в текущем тексте, <ins>подчёркнуто</ins> — только в другом варианте.</div>
    <div class="rendered diff">${diffHTML(a, b)}</div>`, (el, close) => { $('[data-close]', el).onclick = close; });
}
// Синхронизация: загрузить задания из «исходящих», забрать готовые результаты, обновить «ПК в сети»
async function pcSync() {
  if (!pcOn() || PC.busy) return;
  PC.busy = true;
  const d = PC.disk();
  try {
    if (!PC.dirsOk) { await d.mkdir('app:/jobs'); await d.mkdir('app:/results'); PC.dirsOk = true; }
    for (const { n, o, key } of pcUnits().filter((u) => u.o.pc.state === 'outbox')) {
      const blob = await DB.get('audio', key);
      if (!blob) { o.pc = { ...o.pc, state: 'error', err: 'аудио не найдено' }; saveNote(n); continue; }
      await d.upload(`app:/jobs/${key}.wav`, blob);
      try { await d.props(`app:/jobs/${key}.wav`, { lang: S.lang, sentAt: o.pc.sentAt }); } catch {}
      o.pc = { ...o.pc, state: 'queued' }; saveNote(n); onNoteChanged(n);
      trace(`ПК: загружено ${key} (${(blob.size / 1e6).toFixed(1)} МБ)`);
    }
    try {
      const m = await d.meta('app:/pc.json');
      const p = m.custom_properties || {};
      if (p.seen) ls.set('vn.pcSeen', { seen: +p.seen, model: p.model, device: p.device, busy: p.busy });
    } catch (e) { if (e.status !== 404) throw e; }
    const jobsOnDisk = await d.list('app:/jobs');
    PC.working = new Set(jobsOnDisk.filter((f) => f.custom_properties?.status === 'working').map((f) => f.name.replace(/\.wav$/, '')));
    for (const f of await d.list('app:/results')) {
      const id = f.name.replace(/\.json$/, '');
      const u = pcUnits().find((x) => x.key === id);
      if (u && pcActive(u.o)) {
        const n = u.n;
        const res = JSON.parse(await d.download('app:/results/' + f.name));
        const how = u.c ? applyClipResult(n, u.c, res) : applyPCResult(n, res);
        trace(`ПК: результат ${id} → ${how}`);
        saveNote(n); onNoteChanged(n);
        toast(how === 'error' ? 'Компьютер не смог распознать запись' : how === 'replaced' ? `Готова расшифровка с компьютера: «${titleOf(n)}»` : `Расшифровка с компьютера готова — ваш исправленный текст не тронут`, 4000);
      }
      await d.remove('app:/results/' + f.name);
    }
    PC.err = '';
  } catch (e) {
    PC.err = e.status === 401 ? 'Ключ Яндекс Диска недействителен — получите новый в настройках' : (e.message || String(e));
    trace('ПК: ошибка ' + PC.err);
  } finally {
    PC.busy = false;
    const r = route();
    if (r.name === 'note') {
      const n = notes.find((x) => x.id === r.id);
      if (n && (n.pc || n.pcText)) { const st = $('#npc'); if (st) st.innerHTML = pcBoxHTML(n); }
      for (const c of n?.clips || []) { const st = $(`[data-cpcbox="${c.id}"]`); if (st) st.innerHTML = pcBoxHTML(c, c.id); }
      if (n) bindPCBox(n);
    }
    clearTimeout(PC.timer);
    // пока что-то ждёт компьютер — проверяем раз в 20 с, иначе раз в 2 мин (обновить «ПК в сети»)
    if (pcOn() && !document.hidden) PC.timer = setTimeout(pcSync, notes.some(pcAnyActive) ? 20000 : 120000);
  }
}
// cid — id записи журнала (кнопки тогда относятся к ней, а не ко всей заметке)
function pcBoxHTML(n, cid = '') {
  const p = n.pc, B = (a, label, cls = '') => `<button class="btn ${cls}" data-pc="${a}" data-cid="${cid}">${label}</button>`;
  if (n.pcText && p?.state === 'ready') return `<div class="warnbox pcbox"><b>Готова расшифровка с компьютера</b>${p.model ? ' <span class="small">(' + esc(p.model) + ')</span>' : ''}. Вы правили ${cid ? 'этот раздел' : 'текст'} после отправки, поэтому он не заменён.
    <div class="btns" style="margin-top:8px">${B('diff', 'Сравнить')}${B('replace', 'Заменить', 'primary')}${B('append', 'Добавить ниже')}${B('reject', 'Оставить мой')}</div></div>`;
  if (!p) return '';
  if (p.state === 'error') return `<div class="warnbox">Компьютер не смог распознать запись: ${esc(p.err || 'ошибка')}. <a data-pc="retry" data-cid="${cid}">Отправить ещё раз</a></div>`;
  if (!pcActive(n)) return '';
  const on = pcOnlineText();
  const what = p.state === 'outbox' ? 'Ждёт отправки на Яндекс Диск (нет связи?).'
    : PC.working?.has(n.id) ? 'Компьютер распознаёт запись…'
    : on.on ? 'В очереди, компьютер в сети — скоро будет готово.' : `${on.text} Задание в очереди: расшифровка появится, когда он включится.`;
  return `<div class="warnbox">🖥 ${esc(what)}${PC.err ? `<div class="small" style="margin-top:4px">Последняя ошибка: ${esc(PC.err)}</div>` : ''}
    <div class="btns" style="margin-top:8px">${B('check', 'Проверить сейчас')}${B('cancel', 'Отменить')}</div></div>`;
}
function bindPCBox(n) {
  app.querySelectorAll('[data-pc]').forEach((b) => (b.onclick = () => {
    const a = b.dataset.pc, c = b.dataset.cid ? (n.clips || []).find((x) => x.id === b.dataset.cid) : null;
    if (b.dataset.cid && !c) return;
    if (a === 'check') { toast('Проверяю…'); pcSync(); }
    else if (a === 'cancel') cancelPC(n, c);
    else if (a === 'retry') { (c || n).pc = null; sendToPC(n, false, c); }
    else if (c) {
      if (a === 'diff') showDiff(clipRange(n, c)?.body || '', c.pcText || '', `Запись ${clipTime(c)} ↔ компьютер`);
      else resolveClipPC(n, c, a);
    }
    else if (a === 'diff') showDiff(mainRange(n).body, n.pcText || '', 'Ваш текст ↔ компьютер');
    else resolvePC(n, a);
  }));
}
function versionsHTML(n) {
  if (!n.versions?.length) return '';
  return `<details class="vers"><summary class="sec" style="cursor:pointer">Прежние варианты текста (${n.versions.length})</summary>
    ${n.versions.map((v, i) => `<div class="card" style="margin-bottom:6px"><div class="meta" style="margin:0 0 4px"><b>${esc(v.label)}</b><span>${fmtDate(v.at)}</span></div>
      <div class="s">${esc(v.text.slice(0, 200))}</div>
      <div class="btns" style="margin-top:8px"><button class="btn" data-vdiff="${i}">Сравнить с текущим</button><button class="btn" data-vback="${i}">Вернуть</button></div></div>`).join('')}</details>`;
}
function bindVersions(n) {
  app.querySelectorAll('[data-vdiff]').forEach((b) => (b.onclick = () => { const v = n.versions[+b.dataset.vdiff]; showDiff(n.text || '', v.text, `Текущий ↔ «${v.label}»`); }));
  app.querySelectorAll('[data-vback]').forEach((b) => (b.onclick = () => {
    const v = n.versions[+b.dataset.vback];
    const cur = n.text; n.versions.splice(+b.dataset.vback, 1);
    addVersion(n, 'Перед возвратом', cur); setText(n, v.text); saveNote(n); renderNote(n.id); toast('Текст возвращён');
  }));
}

/* ================= Импорт аудиофайлов (голосовые из Telegram и т. п.) ================= */
// Распознать файл можно только Whisper'ом: встроенное распознавание слушает лишь микрофон,
// а Whisper в Safari на iPhone вылетает — там файл просто сохраняется с аудио.
const canTranscribeFile = () => !IS_IOS;
async function importAudio(files) {
  files = [...(files || [])];
  if (!files.length) return;
  if (rec) { toast('Сначала остановите запись'); return; }
  let added = 0, last = null;
  for (const f of files) {
    toast(`Читаю ${f.name}…`, 2000);
    trace(`импорт: ${f.name} (${(f.size / 1e6).toFixed(1)} МБ, ${f.type || 'тип неизвестен'})`);
    let pcm;
    try { pcm = await decodeAudioFile(f, trace); }
    catch (e) { trace('импорт: ошибка ' + (e?.message || e)); toast(`Не удалось открыть ${f.name}: ${e?.message || e}`, 5000); continue; }
    if (!pcm.length) { toast(`В файле ${f.name} нет звука`); continue; }
    const note = {
      id: uid(), createdAt: Date.now(), updatedAt: Date.now(), title: '', text: '', segTexts: [],
      tags: filter.tag ? [filter.tag] : [], projectId: filter.project && filter.project !== 'none' ? filter.project : null,
      status: 'done', source: 'file', fileName: f.name, duration: pcm.length / 16000, hasAudio: true,
    };
    note.head = clipHead(note, note.createdAt); note.prefix = note.head + '\n'; note.text = note.head;
    await DB.put('audio', encodeWav(pcm), note.id);
    notes.unshift(note);
    if (canTranscribeFile()) {
      const segs = segmentAll(pcm, { minSec: 3, maxSec: S.segMax, silenceMs: 500 });
      segs.forEach((s, i) => enqueue(note, s.a, i));
      if (!segs.length) toast('В файле не найдено речи');
    }
    if (S.pcAuto && pcOn()) note.pc = { state: 'outbox', sentAt: Date.now(), base: mainRange(note).body };
    saveNote(note);
    added++; last = note;
  }
  if (added && S.pcAuto && pcOn()) pcSync();
  if (added === 1) location.hash = '#/n/' + last.id;
  else if (added) { toast(`Добавлено заметок: ${added}`); render(); }
}
function pickAudioFiles() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  // на iPhone .ogg/.oga не всегда считаются «аудио» и становятся серыми в «Файлах» — там тип не ограничиваем
  if (!IS_IOS) inp.accept = 'audio/*,.ogg,.oga,.opus,.m4a,.mp3,.wav,.webm';
  inp.onchange = () => importAudio(inp.files);
  inp.click();
}

/* ================= Роутинг ================= */
function route() {
  const h = location.hash.slice(1);
  let m;
  if ((m = h.match(/^\/n\/(.+)$/))) return { name: 'note', id: decodeURIComponent(m[1]) };
  if (h === '/settings') return { name: 'settings' };
  if (h === '/projects') return { name: 'projects' };
  return { name: 'home' };
}
function render() {
  const r = route();
  if (r.name === 'note') renderNote(r.id);
  else if (r.name === 'settings') renderSettings();
  else if (r.name === 'projects') renderProjects();
  else renderHome();
}
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });

/* ================= Главный экран ================= */
function renderHome() {
  app.innerHTML = `
  <header class="top"><div class="wrap">
    <div class="row"><h1 class="grow">Заметки</h1>
      <button class="iconbtn" id="impbtn" aria-label="Добавить аудиофайл" title="Добавить голосовое из файла (Telegram)">${I.file}</button>
      <a class="iconbtn" href="#/projects" aria-label="Проекты">${I.folder}</a>
      <a class="iconbtn" href="#/settings" aria-label="Настройки">${I.gear}</a></div>
    <input class="search" id="q" type="search" placeholder="Поиск по тексту, #меткам, [[связям]]" value="${esc(filter.q)}">
    <div class="chips" id="pchips"></div>
    <div class="status" data-asr>${asrStatusHTML()}</div>
  </div></header>
  <main class="wrap">${crashNote ? `<div class="warnbox" id="crash">${esc(crashNote)} <a href="#/settings">Настройки</a> · <a id="crashok">Понятно</a></div>` : ''}<div class="list" id="list"></div></main>
  <button class="fab" id="fab" aria-label="Записать">${I.mic}</button>`;
  $('#q').oninput = (e) => { filter.q = e.target.value; renderList(); };
  $('#fab').onclick = () => startRecording();
  $('#impbtn').onclick = pickAudioFiles;
  const ok = $('#crashok'); if (ok) ok.onclick = () => { crashNote = ''; $('#crash').remove(); };
  renderChips(); renderList();
}
function renderChips() {
  const el = $('#pchips'); if (!el) return;
  const c = (val, label, extra = '') => `<button class="chip ${filter.project === val ? 'on' : ''}" data-p="${val ?? ''}" ${extra}>${esc(label)}</button>`;
  let html = c(null, 'Все') + projects.map((p) => c(p.id, p.name)).join('') + c('none', 'Без проекта');
  if (filter.tag) html = `<button class="chip tag on" id="tagoff">#${esc(filter.tag)} ✕</button>` + html;
  const allTags = {};
  notes.forEach((n) => tagsOf(n).forEach((t) => (allTags[t] = (allTags[t] || 0) + 1)));
  html += Object.entries(allTags).filter(([t]) => t !== filter.tag).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([t]) => `<button class="chip tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  el.innerHTML = html;
  el.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { filter.project = b.dataset.p || null; renderChips(); renderList(); }));
  el.querySelectorAll('[data-tag]').forEach((b) => (b.onclick = () => { filter.tag = b.dataset.tag; renderChips(); renderList(); }));
  const off = $('#tagoff'); if (off) off.onclick = () => { filter.tag = null; renderChips(); renderList(); };
}
function filtered() {
  const q = filter.q.trim().toLowerCase();
  return notes.filter((n) => {
    if (filter.project === 'none' && n.projectId) return false;
    if (filter.project && filter.project !== 'none' && n.projectId !== filter.project) return false;
    if (filter.tag && !tagsOf(n).includes(filter.tag)) return false;
    if (q) {
      const hay = (titleOf(n) + ' ' + (n.text || '') + ' ' + tagsOf(n).map((t) => '#' + t).join(' ') + ' ' + (projName(n.projectId) || '')).toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }).sort((a, b) => b.createdAt - a.createdAt);
}
function renderList() {
  const el = $('#list'); if (!el) return;
  const list = filtered();
  if (!notes.length) {
    el.innerHTML = `<div class="empty">Пока пусто.<br>Нажмите красную кнопку и надиктуйте первую заметку.<br><br><span class="small">Первая запись скачает модель распознавания (${MODELS[S.model].size}). Дальше всё работает без интернета.</span></div>`;
    return;
  }
  if (!list.length) { el.innerHTML = '<div class="empty">Ничего не найдено</div>'; return; }
  el.innerHTML = list.map((n) => {
    const st = n.status === 'transcribing' || n.status === 'recording' ? '<span>⏳ распознаётся</span>' : n.status === 'error' ? '<span style="color:var(--accent)">⚠︎ ошибка</span>' : '';
    const pcs = pcAnyActive(n) ? '<span>🖥 ждёт ПК</span>' : pcAnyReady(n) ? '<span style="color:var(--warn)">🖥 готово, выберите</span>' : '';
    const nc = (n.clips || []).length;
    const links = linksOf(n).length;
    return `<a class="card" href="#/n/${encodeURIComponent(n.id)}">
      <div class="t">${esc(titleOf(n))}</div>
      <div class="s">${esc((n.text || '').replace(/^#{1,6} .*$/gm, '').trim().slice(0, 220)) || '<i>без текста</i>'}</div>
      <div class="meta"><span>${fmtDate(n.createdAt)}</span>${n.source === 'file' ? '<span>📎 файл</span>' : ''}${n.duration ? `<span>${fmtDur(n.duration)}</span>` : ''}${nc ? `<span>🎙 ${nc}</span>` : ''}
        ${n.projectId ? `<span class="badge">${esc(projName(n.projectId) || '?')}</span>` : ''}
        ${tagsOf(n).slice(0, 4).map((t) => `<span class="tg">#${esc(t)}</span>`).join('')}
        ${links ? `<span>🔗 ${links}</span>` : ''}${st}${pcs}</div></a>`;
  }).join('');
}

/* ================= Заметка ================= */
let editMode = false, lastNoteId = null;
function renderedText(n) {
  let h = esc(n.text || '');
  h = h.replace(/\[\[([^\[\]\n]{1,120})\]\]/g, (_, x) => {
    const { target: t, label } = linkParts(x);
    const target = findByTitle(t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
    return `<a class="lk ${target ? '' : 'missing'}" data-link="${t}">${label}</a>`;
  });
  h = h.replace(/(^|[\s(,.;:!?])#([\p{L}\p{N}_\-/]+)/gu, (_, p, t) => `${p}<a class="tg" data-tag="${t.toLowerCase()}">#${t}</a>`);
  // заголовки разделов (### 🎙 дата записи) — как подписи в журнале
  h = h.replace(/^#{1,6} (.+)$/gm, '<span class="jh">$1</span>');
  return h || '<span class="small">Текста пока нет. Нажмите красную кнопку внизу и надиктуйте — запись допишется сюда.</span>';
}
function statusHTML(n) {
  const j = jobs.get(n.id);
  if (n.status === 'transcribing' && j) {
    return `<div class="warnbox">Распознаётся: ${j.done} из ${j.total}. Можно уйти с экрана, текст допишется сам, пока приложение открыто.
      <div class="progress"><i style="width:${(j.done / j.total) * 100}%"></i></div></div>`;
  }
  if (n.recovered && n.status !== 'done') return `<div class="warnbox">Запись восстановлена после сбоя приложения (${fmtDur(n.duration)}). ${RETRY_HINT}</div>`;
  if (n.status === 'transcribing' || n.status === 'recording') return `<div class="warnbox">Распознавание было прервано (приложение закрывалось). ${n.hasAudio ? RETRY_HINT : ''}</div>`;
  if (n.status === 'error') return `<div class="warnbox">Часть записи не распознана. ${RETRY_HINT}</div>`;
  if (n.source === 'file' && !mainRange(n).body && IS_IOS && !(n.clips || []).length) return `<div class="warnbox">Голосовое добавлено из файла, аудио ниже. Распознать файл на iPhone пока нельзя: встроенное распознавание Apple слушает только микрофон, а Whisper в Safari вылетает. Нажмите «🖥 Распознать на ПК» ниже или впишите текст в «Правке».</div>`;
  return '';
}
function renderNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) { app.innerHTML = '<div class="wrap empty">Заметка не найдена. <a href="#/">На главную</a></div>'; return; }
  if (lastNoteId !== id) { editMode = !n.text && n.status === 'done'; lastNoteId = id; }
  const busy = n.status === 'transcribing' && jobs.has(n.id);
  const clips = n.clips || [];
  const backlinks = notes.filter((o) => o.id !== n.id && linksOf(o).some((l) => l.toLowerCase() === titleOf(n).toLowerCase() || (n.title && l.toLowerCase() === n.title.trim().toLowerCase())));
  const outgoing = linksOf(n);
  app.innerHTML = `
  <header class="top"><div class="wrap row">
    <a class="iconbtn" href="#/" aria-label="Назад">${I.back}</a>
    <div class="grow small">${fmtDate(n.createdAt)}${n.duration ? ' · ' + fmtDur(n.duration) : ''}${n.fileName ? ' · 📎 ' + esc(n.fileName) : ''}</div>
    <div class="seg" style="width:170px"><button data-m="0" class="${!editMode ? 'on' : ''}">Просмотр</button><button data-m="1" class="${editMode ? 'on' : ''}">Правка</button></div>
  </div></header>
  <main class="wrap" style="padding-bottom:130px">
    <input class="title-in" id="ntitle" placeholder="${esc(titleOf(n))}" value="${esc(n.title || '')}">
    <div class="chips">
      <button class="chip" id="nproj">${I.folder.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"')} ${esc(projName(n.projectId) || 'Без проекта')}</button>
      ${(n.tags || []).map((t) => `<button class="chip tag on" data-rmtag="${esc(t)}">#${esc(t)} ✕</button>`).join('')}
      <button class="chip tag" id="addtag">+ метка</button>
    </div>
    <div id="nstatus">${statusHTML(n)}</div>
    <div id="npc">${pcBoxHTML(n)}</div>
    ${editMode && !busy ? `
      <div class="btns" style="margin:8px 0"><button class="btn" id="inslink">[[ ]] Связать</button><button class="btn" id="instag"># Метка</button></div>
      <textarea class="field" id="ntext" placeholder="Текст заметки. #метки и [[ссылки на другие заметки]] работают прямо в тексте.">${esc(n.text || '')}</textarea>`
      : `<div class="rendered" id="ntextv">${renderedText(n)}</div>`}
    <div id="nsug">${busy ? '' : sugHTML(n)}</div>
    ${outgoing.length ? `<div class="sec">Связи из заметки</div><div class="chips" style="flex-wrap:wrap">${outgoing.map((l) => `<button class="chip" data-link="${esc(l)}">🔗 ${esc(l)}</button>`).join('')}</div>` : ''}
    <div class="sec">Ссылаются сюда</div>
    ${backlinks.length ? backlinks.map((b) => `<a class="card" href="#/n/${encodeURIComponent(b.id)}" style="margin-bottom:6px"><div class="t">${esc(titleOf(b))}</div><div class="meta">${fmtDate(b.createdAt)}</div></a>`).join('') : '<div class="small">Пока никто. Напишите [[' + esc(titleOf(n)) + ']] в другой заметке.</div>'}
    ${versionsHTML(n)}
    <div class="sec">Аудио${clips.length ? ' · записей: ' + (clips.length + (n.hasAudio ? 1 : 0)) : ''}</div>
    ${n.hasAudio || !clips.length ? `${clips.length ? '<div class="small" style="margin-bottom:4px">Первая запись</div>' : ''}<div id="naudio" class="small">${n.hasAudio ? 'Загрузка…' : 'Не сохранено'}</div>` : ''}
    <div class="btns" style="margin-top:10px">
      ${n.hasAudio && !pcActive(n) && n.pc?.state !== 'ready' ? `<button class="btn" id="topc">🖥 Распознать на ПК</button>` : ''}
      ${n.hasAudio && !IS_IOS && !clips.length ? `<button class="btn" id="retr">↻ Перераспознать (${MODELS[S.model].name})</button>` : ''}
      ${clips.length ? '' : '<button class="btn" id="ncopy">📋 Скопировать весь текст</button><button class="btn danger" id="del">Удалить</button>'}
    </div>
    ${clips.map((c) => `<div class="card" style="margin-top:10px" data-clip="${c.id}">
      <div class="meta" style="margin:0 0 4px"><b>🎙 ${esc(clipTime(c))}</b>${c.duration ? `<span>${fmtDur(c.duration)}</span>` : ''}${clipRange(n, c) ? '' : '<span>раздел в тексте удалён</span>'}</div>
      <div data-caudio="${c.id}" class="small">${c.hasAudio ? 'Загрузка…' : 'Аудио не сохранено'}</div>
      <div data-cpcbox="${c.id}">${pcBoxHTML(c, c.id)}</div>
      <div class="btns" style="margin-top:8px">
        ${c.hasAudio && !pcActive(c) && c.pc?.state !== 'ready' ? `<button class="btn" data-ctopc="${c.id}">🖥 Распознать на ПК</button>` : ''}
        <button class="btn danger" data-cdel="${c.id}">Удалить аудио</button>
      </div></div>`).join('')}
    ${clips.length ? '<div class="btns" style="margin-top:14px"><button class="btn" id="ncopy">📋 Скопировать весь текст</button><button class="btn danger" id="del">Удалить заметку</button></div>' : ''}
  </main>
  ${busy || n.status === 'recording' ? '' : `<button class="fab" id="nfab" aria-label="Дописать голосом" title="Дописать голосом">${I.mic}</button>`}`;

  app.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
    if (busy && b.dataset.m === '1') { toast('Дождитесь окончания распознавания'); return; }
    editMode = b.dataset.m === '1'; renderNote(id);
  }));
  $('#ntitle').oninput = (e) => { n.title = e.target.value; saveNote(n, 500); };
  const ta = $('#ntext'), fab = $('#nfab');
  if (fab) fab.onclick = () => { if (ta) n.text = ta.value; startRecording(n); };
  if (ta) {
    let sugT;
    // кнопка записи не должна закрывать текст над клавиатурой
    if (fab) { ta.onfocus = () => (fab.style.display = 'none'); ta.onblur = () => setTimeout(() => (fab.style.display = ''), 150); }
    ta.oninput = () => {
      n.text = ta.value; n.segTexts = null; n.prefix = ''; saveNote(n, 500);
      clearTimeout(sugT); sugT = setTimeout(() => bindSug(n), 800);
    };
    // выделенный текст остаётся в заметке как есть: [[Заметка|выделенное]]
    $('#inslink').onclick = () => {
      const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b).trim();
      pickNote(n.id, (title) => {
        ta.selectionStart = a; ta.selectionEnd = b;
        insertAt(ta, sel && sel.toLowerCase() !== title.toLowerCase() ? `[[${title}|${sel}]]` : `[[${title}]]`);
      }, sel);
    };
    // с выделением метка добавляется после него, слово не пропадает
    $('#instag').onclick = () => {
      const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b).trim();
      const t = prompt('Метка (без #):', sel.replace(/\s+/g, '_').toLowerCase()); if (!t?.trim()) return;
      ta.selectionStart = ta.selectionEnd = b;
      insertAt(ta, '#' + t.trim().replace(/^#/, '').replace(/\s+/g, '_') + ' ');
    };
  }
  $('#nproj').onclick = () => pickProject(n.projectId, (pid) => { n.projectId = pid; saveNote(n); renderNote(id); });
  $('#addtag').onclick = () => {
    const t = prompt('Новая метка (без #):'); if (!t) return;
    const v = t.trim().replace(/^#/, '').replace(/\s+/g, '_').toLowerCase();
    if (v && !(n.tags || []).includes(v)) { n.tags = [...(n.tags || []), v]; saveNote(n); renderNote(id); }
  };
  app.querySelectorAll('[data-rmtag]').forEach((b) => (b.onclick = () => { n.tags = n.tags.filter((t) => t !== b.dataset.rmtag); saveNote(n); renderNote(id); }));
  bindTextLinks(app);
  bindSug(n, false);
  const rt = $('#retr'); if (rt) rt.onclick = () => retranscribe(n);
  const tp = $('#topc'); if (tp) tp.onclick = () => sendToPC(n);
  bindPCBox(n); bindVersions(n);
  $('#ncopy').onclick = async () => {
    const ta2 = $('#ntext'); if (ta2) n.text = ta2.value;
    const t = plainText(n);
    if (!t) { toast('Текста пока нет'); return; }
    toast(await copyText(t) ? 'Текст скопирован' : 'Не удалось скопировать');
  };
  $('#del').onclick = async () => {
    if (!confirm('Удалить заметку безвозвратно?')) return;
    notes = notes.filter((x) => x.id !== n.id); jobs.delete(n.id);
    await DB.del('notes', n.id); await DB.del('audio', n.id);
    for (const c of clips) await DB.del('audio', clipKey(n, c));
    location.hash = '#/';
  };
  for (const c of clips) {
    if (c.hasAudio) DB.get('audio', clipKey(n, c)).then((blob) => {
      const box = $(`[data-caudio="${c.id}"]`); if (!box) return;
      if (!blob) { box.textContent = 'Не найдено'; return; }
      box.innerHTML = `<audio controls preload="metadata" src="${URL.createObjectURL(blob)}"></audio><div>${(blob.size / 1e6).toFixed(1)} МБ</div>`;
    });
  }
  app.querySelectorAll('[data-ctopc]').forEach((b) => (b.onclick = () => sendToPC(n, false, clips.find((c) => c.id === b.dataset.ctopc))));
  app.querySelectorAll('[data-cdel]').forEach((b) => (b.onclick = async () => {
    const c = clips.find((x) => x.id === b.dataset.cdel); if (!c) return;
    if (!confirm('Удалить аудио этой записи? Её текст в заметке останется.')) return;
    if (pcActive(c)) await cancelPC(n, c);
    await DB.del('audio', clipKey(n, c));
    n.clips = n.clips.filter((x) => x !== c); saveNote(n); renderNote(n.id);
  }));
  if (n.hasAudio) DB.get('audio', n.id).then((blob) => {
    const box = $('#naudio'); if (!box) return;
    if (!blob) { box.textContent = 'Не найдено'; return; }
    box.innerHTML = `<audio controls preload="metadata" src="${URL.createObjectURL(blob)}"></audio><div>${(blob.size / 1e6).toFixed(1)} МБ</div>`;
  });
}
function bindSug(n, redraw = true) {
  const box = $('#nsug'); if (!box) return;
  if (redraw) box.innerHTML = sugHTML(n);
  const list = suggestFor(n);
  box.querySelectorAll('[data-sug]').forEach((b) => (b.onclick = () => {
    const g = list[+b.dataset.sug]; if (!g) return;
    const ta = $('#ntext');
    if (ta) n.text = ta.value;
    applySuggestion(n, g); saveNote(n);
    const keep = scrollY; renderNote(n.id); scrollTo(0, keep);
    toast(g.kind === 'tag' ? `Добавлена метка #${g.tag}` : `Связано с «${g.title}»`);
  }));
  const h = box.querySelector('[data-sughide]');
  if (h) h.onclick = () => { n.sugHidden = [...new Set([...(n.sugHidden || []), ...list.map((g) => g.key)])]; saveNote(n); box.innerHTML = ''; };
}
function bindTextLinks(root) {
  root.querySelectorAll('[data-link]').forEach((a) => (a.onclick = () => openLink(a.dataset.link)));
  root.querySelectorAll('#ntextv [data-tag]').forEach((a) => (a.onclick = () => { filter.tag = a.dataset.tag; location.hash = '#/'; }));
}
function updateNoteDyn(n) {
  const st = $('#nstatus'); if (st) st.innerHTML = statusHTML(n);
  const v = $('#ntextv'); if (v) { v.innerHTML = renderedText(n); bindTextLinks(v.parentElement); }
  if (n.status !== 'transcribing' && !$('#ntext')) { const keep = scrollY; renderNote(n.id); scrollTo(0, keep); }
}
function openLink(title) {
  title = title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const t = findByTitle(title);
  if (t) { location.hash = '#/n/' + encodeURIComponent(t.id); return; }
  if (confirm(`Заметки «${title}» нет. Создать?`)) {
    const n = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), title, text: '', tags: [], projectId: null, status: 'done' };
    notes.unshift(n); saveNote(n); location.hash = '#/n/' + n.id;
  }
}
function insertAt(ta, s) {
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  const pre = a > 0 && !/\s/.test(ta.value[a - 1]) ? ' ' : '';
  ta.value = ta.value.slice(0, a) + pre + s + ta.value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + pre.length + s.length;
  ta.focus(); ta.dispatchEvent(new Event('input'));
}

/* ================= Листы выбора ================= */
function sheet(html, bind) {
  const bg = document.createElement('div'); bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  document.body.appendChild(bg); bind(bg, () => bg.remove());
}
function pickProject(current, cb) {
  sheet(`<div class="sec" style="margin-top:0">Проект</div>
    <button class="item" data-pid="">${current ? '' : '✓ '}Без проекта</button>
    ${projects.map((p) => `<button class="item" data-pid="${p.id}">${p.id === current ? '✓ ' : ''}${esc(p.name)}</button>`).join('')}
    <button class="item" id="newp" style="color:var(--link)">+ Новый проект</button>`, (el, close) => {
    el.querySelectorAll('[data-pid]').forEach((b) => (b.onclick = () => { close(); cb(b.dataset.pid || null); }));
    $('#newp', el).onclick = async () => { const p = await createProject(); if (p) { close(); cb(p.id); } };
  });
}
function pickNote(selfId, cb, q0 = '') {
  sheet(`<input class="search" id="pq" placeholder="Найти заметку или ввести новое название" value="${esc(q0)}"><div id="pl" style="margin-top:8px"></div>`, (el, close) => {
    const draw = () => {
      const q = $('#pq', el).value.trim().toLowerCase();
      const qk = keyWords(q);
      const list = notes.filter((n) => n.id !== selfId && (titleOf(n).toLowerCase().includes(q) || (qk.length && qk.every((k) => keyWords(titleOf(n)).some((t) => sameStem(t, k)))))).slice(0, 30);
      $('#pl', el).innerHTML = list.map((n) => `<button class="item" data-t="${esc(titleOf(n).replace(/…$/, ''))}">${esc(titleOf(n))}<div class="small">${fmtDate(n.createdAt)}</div></button>`).join('')
        + (q ? `<button class="item" data-t="${esc($('#pq', el).value.trim())}" style="color:var(--link)">+ Ссылка на новую «${esc($('#pq', el).value.trim())}»</button>` : '');
      el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
        const nt = notes.find((n) => titleOf(n).replace(/…$/, '') === b.dataset.t);
        // если у заметки нет явного заголовка, закрепляем его, чтобы ссылка не сломалась при правке текста
        if (nt && !nt.title) { nt.title = b.dataset.t; saveNote(nt); }
        close(); cb(b.dataset.t);
      }));
    };
    $('#pq', el).oninput = draw; draw();
  });
}
async function createProject() {
  const name = prompt('Название проекта:'); if (!name?.trim()) return null;
  const p = { id: uid(), name: name.trim(), createdAt: Date.now() };
  projects.push(p); await DB.put('projects', p); return p;
}

/* ================= Проекты ================= */
function renderProjects() {
  const count = (id) => notes.filter((n) => n.projectId === id).length;
  app.innerHTML = `
  <header class="top"><div class="wrap row"><a class="iconbtn" href="#/">${I.back}</a><h1 class="grow" style="margin:0">Проекты</h1></div></header>
  <main class="wrap">
    ${projects.map((p) => `<div class="card row" style="margin-bottom:8px"><button class="grow" style="text-align:left" data-open="${p.id}"><div class="t">${esc(p.name)}</div><div class="small">${count(p.id)} заметок</div></button>
      <button class="btn" data-ren="${p.id}">Переименовать</button><button class="btn danger" data-del="${p.id}">✕</button></div>`).join('') || '<div class="empty">Проектов пока нет</div>'}
    <button class="btn primary" id="addp" style="margin-top:8px">+ Новый проект</button>
  </main>`;
  $('#addp').onclick = async () => { if (await createProject()) renderProjects(); };
  app.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => { filter.project = b.dataset.open; location.hash = '#/'; }));
  app.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = async () => {
    const p = projects.find((x) => x.id === b.dataset.ren); const name = prompt('Новое название:', p.name);
    if (name?.trim()) { p.name = name.trim(); await DB.put('projects', p); renderProjects(); }
  }));
  app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const p = projects.find((x) => x.id === b.dataset.del);
    if (!confirm(`Удалить проект «${p.name}»? Заметки останутся, но без проекта.`)) return;
    projects = projects.filter((x) => x.id !== p.id); await DB.del('projects', p.id);
    for (const n of notes) if (n.projectId === p.id) { n.projectId = null; saveNote(n); }
    if (filter.project === p.id) filter.project = null;
    renderProjects();
  }));
}

/* ================= Настройки ================= */
async function renderSettings() {
  const segBtn = (key, vals) => `<div class="seg">${vals.map(([v, l]) => `<button data-k="${key}" data-v="${v}" class="${String(S[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = `Занято приложением: ${(e.usage / 1e6).toFixed(0)} МБ`; } catch {}
  app.innerHTML = `
  <header class="top"><div class="wrap row"><a class="iconbtn" href="#/">${I.back}</a><h1 class="grow" style="margin:0">Настройки</h1></div></header>
  <main class="wrap" style="padding-bottom:60px">
    <div class="sec">Способ распознавания</div>${SR ? segBtn('engine', [['sys', IS_IOS ? 'Встроенное iPhone' : 'Встроенное браузера'], ['whisper', 'Whisper']]) : '<div class="small">В этом браузере встроенного распознавания нет — используется Whisper.</div>'}
    <div class="small" style="margin-top:6px">Встроенное — то же, что диктовка Siri: работает сразу, без скачивания, хорошо понимает русский. Звук может обрабатываться на серверах Apple. Whisper — модель прямо на устройстве: на компьютере работает, на iPhone в Safari пока вылетает.</div>
    <div class="sec">Модель Whisper</div>
    ${Object.entries(MODELS).map(([k, m]) => `<button class="opt ${S.model === k ? 'on' : ''}" data-model="${k}"><div><b>${m.name} <span class="small">${m.size}${ls.get('vn.dl.' + k, false) ? ' · скачана' : ''}</span></b><span class="small">${m.note}</span></div></button>`).join('')}
    <div class="status" data-asr>${asrStatusHTML()}</div>
    <div class="progress"><i id="dlprog"></i></div>
    <div class="small" id="dlmsg" style="margin-top:6px;word-break:break-word"></div>
    <div class="btns" style="margin-top:10px"><button class="btn primary" id="loadm">Загрузить / проверить модель</button></div>

    <div class="sec">Язык речи</div>${segBtn('lang', [['ru', 'Русский'], ['en', 'English'], ['auto', 'Авто']])}
    <div class="sec">Вычисления</div>${segBtn('device', [['auto', 'Авто'], ['webgpu', 'WebGPU'], ['wasm', 'CPU']])}
    <div class="small" style="margin-top:6px">WebGPU — видеочип, быстрее, но требует больше памяти. На iPhone «Авто» = CPU: WebGPU-версия модели вылетает по памяти Safari.</div>
    <div class="sec">Максимальная длина куска</div>${segBtn('segMax', [[8, '8 с'], [12, '12 с'], [20, '20 с'], [28, '28 с']])}
    <div class="small" style="margin-top:6px">Запись режется по паузам. Whisper тратит почти одинаковое время на кусок любой длины до 30 с, поэтому на медленном устройстве длинные куски (20–28 с) выгоднее: меньше кусков — меньше общее время.</div>
    <div class="sec">Прочее</div>
    ${segBtn('autoload', [[true, 'Грузить модель при запуске'], [false, 'Только при записи']])}
    <div style="height:8px"></div>${segBtn('keepAudio', [[true, 'Хранить аудио'], [false, 'Только текст']])}

    <div class="sec">Распознавание на компьютере</div>
    <div id="pcset">${pcSettingsHTML()}</div>

    <div class="sec">Экспорт и резервная копия</div>
    <div class="btns">
      <button class="btn" id="exmd">Markdown (.zip) для Obsidian</button>
      <button class="btn" id="exmda">… с аудио</button>
      <button class="btn" id="exjs">Копия JSON</button>
      <label class="btn">Импорт JSON<input type="file" id="imjs" accept="application/json" hidden></label>
    </div>
    <div class="sec">Хранилище</div>
    <div class="small">${usage} · заметок: ${notes.length}</div>
    <div class="btns" style="margin-top:8px"><button class="btn danger" id="clrm">Удалить скачанные модели</button></div>
    <div class="sec">Диагностика</div>
    <div class="btns" style="margin-bottom:8px"><button class="btn" id="updchk">Проверить обновления</button></div>
    <div class="small" style="line-height:1.7">Версия ${VERSION} · ${IS_IOS ? 'iOS' : 'не iOS'} · многопоточность: ${self.crossOriginIsolated ? 'да (потоков ' + effThreads() + ')' : 'нет'} · WebGPU: ${navigator.gpu ? 'есть' : 'нет'} · режим: ${effDevice() === 'wasm' ? 'CPU' : effDevice()}${ASR.rtf ? ' · последняя скорость ×' + ASR.rtf.toFixed(2) : ''}</div>
    <details style="margin-top:8px"><summary class="small">Журнал последних действий</summary>
      <pre class="small" id="vlog" style="white-space:pre-wrap;user-select:text;margin:8px 0">${esc(ls.get('vn.log', []).join('\n') || 'пусто')}</pre>
      <button class="btn" id="cplog">Скопировать журнал</button>
    </details>
    <div class="small" style="margin-top:24px">Всё хранится только на этом устройстве. Распознавание идёт локально, интернет нужен только для первой загрузки модели. Исключение — «Распознавание на компьютере»: аудио этих заметок проходит через ваш Яндекс Диск.</div>
  </main>`;
  asrUI();
  app.querySelectorAll('[data-model]').forEach((b) => (b.onclick = () => {
    S.model = b.dataset.model; saveS();
    if (S.model === 'medium' && IS_IOS) toast('Medium на iPhone почти наверняка закроет приложение из-за памяти', 4500);
    if (ASR.state === 'ready' || ASR.state === 'loading' || ls.get('vn.dl.' + S.model, false)) ASR.load();
    renderSettings();
  }));
  app.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.k, raw = b.dataset.v;
    S[k] = raw === 'true' ? true : raw === 'false' ? false : isNaN(+raw) ? raw : +raw;
    saveS();
    if (k === 'device' && (ASR.state === 'ready' || ASR.state === 'loading')) ASR.load();
    renderSettings();
  }));
  $('#loadm').onclick = () => ASR.load();
  bindPCSettings();
  $('#updchk').onclick = () => checkUpdate(true);
  $('#cplog').onclick = async () => {
    const t = `v${VERSION} ${navigator.userAgent}\n` + ls.get('vn.log', []).join('\n');
    try { await navigator.clipboard.writeText(t); toast('Журнал скопирован'); } catch { toast('Не удалось скопировать — выделите текст вручную'); }
  };
  $('#exmd').onclick = () => exportMarkdown(false);
  $('#exmda').onclick = () => exportMarkdown(true);
  $('#exjs').onclick = exportJSON;
  $('#imjs').onchange = importJSON;
  $('#clrm').onclick = async () => {
    if (!confirm('Удалить скачанные модели? Их придётся скачать заново.')) return;
    for (const k of await caches.keys()) if (k.includes('transformers')) await caches.delete(k);
    Object.keys(MODELS).forEach((m) => ls.set('vn.dl.' + m, false));
    toast('Модели удалены'); renderSettings();
  };
}

function pcSettingsHTML() {
  const cid = ls.get('vn.ydClient', '');
  if (!pcOn()) return `<div class="small">Запись уходит в папку приложения на вашем Яндекс Диске, программа на компьютере распознаёт её моделью Whisper large и кладёт текст обратно. Если компьютер выключен, задание ждёт. Инструкция — файл README.txt в архиве pc-agent.</div>
    <div class="small" style="margin:10px 0 4px">1. ClientID приложения Яндекса (oauth.yandex.ru):</div>
    <input class="field" id="ydcid" placeholder="например, 0123456789abcdef…" value="${esc(cid)}" autocomplete="off">
    <div class="btns" style="margin-top:8px"><button class="btn" id="ydget">2. Получить ключ</button></div>
    <div class="small" style="margin:10px 0 4px">3. Вставьте ключ, который показал Яндекс:</div>
    <input class="field" id="ydtok" placeholder="y0_…" autocomplete="off">
    <div class="btns" style="margin-top:8px"><button class="btn primary" id="ydsave">Подключить</button></div>`;
  const on = pcOnlineText();
  return `<div class="status"><span class="dot ${on.on ? 'ok' : 'warn'}"></span>${esc(on.text)}</div>
    <div class="small" id="ydwho" style="margin-top:4px">Яндекс Диск подключён.${PC.err ? ' Последняя ошибка: ' + esc(PC.err) : ''}</div>
    <div style="height:10px"></div>${'<div class="seg">' + [[false, 'Только по кнопке'], [true, 'Все новые записи']].map(([v, l]) => `<button data-k="pcAuto" data-v="${v}" class="${S.pcAuto === v ? 'on' : ''}">${l}</button>`).join('') + '</div>'}
    <div class="small" style="margin-top:6px">«Все новые записи» — каждая запись и импортированный файл сами уходят на компьютер. Текст, который вы успели исправить, не заменяется: появится плашка с выбором.</div>
    <div class="btns" style="margin-top:10px"><button class="btn" id="ydtest">Проверить связь</button><button class="btn" id="ydcopy">Скопировать ключ для ПК</button><button class="btn danger" id="ydoff">Отключить</button></div>
    <div class="small" id="ydmsg" style="margin-top:6px"></div>`;
}
function bindPCSettings() {
  const g = $('#ydget');
  if (g) g.onclick = () => {
    const cid = $('#ydcid').value.trim(); if (!cid) { toast('Сначала вставьте ClientID'); return; }
    ls.set('vn.ydClient', cid);
    window.open('https://oauth.yandex.ru/authorize?response_type=token&client_id=' + encodeURIComponent(cid), '_blank');
  };
  const sv = $('#ydsave');
  if (sv) sv.onclick = async () => {
    const t = $('#ydtok').value.trim().replace(/^.*access_token=([^&]+).*$/, '$1'); if (!t) { toast('Вставьте ключ'); return; }
    try { await new YDisk(t, ls.get('vn.ydApi', API)).check(); ls.set('vn.ydToken', t); trace('ПК: Диск подключён'); toast('Яндекс Диск подключён'); PC.dirsOk = false; pcSync(); renderSettings(); }
    catch (e) { toast('Ключ не подошёл: ' + (e.message || e), 5000); }
  };
  const tst = $('#ydtest');
  if (tst) tst.onclick = async () => {
    const msg = $('#ydmsg'), d = PC.disk(), say = (t) => { msg.textContent = t; trace('ПК: проверка — ' + t); };
    try {
      say('Проверяю доступ…'); await d.check();
      say('Загрузка…'); const probe = 'проверка ' + Date.now(); await d.upload('app:/probe.txt', new Blob([probe]));
      say('Скачивание…'); const back = await d.download('app:/probe.txt'); await d.remove('app:/probe.txt');
      if (back !== probe) throw new Error('файл вернулся не таким');
      await pcSync();
      say(`Всё работает: Диск отвечает, загрузка и скачивание из браузера проходят. ${pcOnlineText().text}`);
    } catch (e) { say('Ошибка: ' + (e.message || e) + '. Скопируйте журнал (внизу) и пришлите разработчику.'); }
  };
  const cp = $('#ydcopy');
  if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(PC.token()); toast('Ключ скопирован — вставьте его в программу на ПК'); } catch { prompt('Скопируйте ключ:', PC.token()); } };
  const off = $('#ydoff');
  if (off) off.onclick = () => { if (!confirm('Отключить Яндекс Диск? Задания в очереди останутся на Диске.')) return; ls.set('vn.ydToken', ''); renderSettings(); };
}

/* ================= Экспорт ================= */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.crossOrigin = 'anonymous'; s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}
const safeName = (s) => s.replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Заметка';
async function exportMarkdown(withAudio) {
  if (!notes.length) { toast('Нет заметок'); return; }
  try { if (!window.JSZip) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'); }
  catch { toast('Для экспорта в .zip нужен интернет один раз'); return; }
  const zip = new JSZip(), used = new Set();
  for (const n of notes) {
    let name = safeName(titleOf(n).replace(/…$/, '')), k = 2;
    while (used.has(name.toLowerCase())) name = safeName(titleOf(n)) + ' ' + k++;
    used.add(name.toLowerCase());
    const proj = projName(n.projectId);
    const fm = ['---', `created: ${new Date(n.createdAt).toISOString()}`, proj ? `project: "${proj.replace(/"/g, "'")}"` : null,
      `tags: [${tagsOf(n).map((t) => JSON.stringify(t)).join(', ')}]`, n.duration ? `duration: ${fmtDur(n.duration)}` : null, '---'].filter(Boolean).join('\n');
    let body = fm + '\n\n' + (n.text || '');
    if (proj) body += `\n\nПроект: [[${proj}]]`;
    if (withAudio && n.hasAudio) {
      const blob = await DB.get('audio', n.id);
      if (blob) { zip.file(`audio/${n.id}.wav`, blob); body += `\n\n![[audio/${n.id}.wav]]`; }
    }
    // записи журнала: аудио встраивается сразу под заголовком своего раздела
    if (withAudio) for (const c of n.clips || []) {
      if (!c.hasAudio) continue;
      const blob = await DB.get('audio', clipKey(n, c)); if (!blob) continue;
      const f = `audio/${clipKey(n, c)}.wav`, embed = `![[${f}]]`;
      zip.file(f, blob);
      body = c.head && body.includes(c.head) ? body.replace(c.head, c.head + '\n' + embed) : body + `\n\n${embed}`;
    }
    zip.file((proj ? safeName(proj) + '/' : '') + name + '.md', body + '\n');
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  deliver(blob, `voice-notes-${new Date().toISOString().slice(0, 10)}.zip`);
}
function exportJSON() {
  const data = JSON.stringify({ app: 'voice-notes', v: 1, exportedAt: Date.now(), projects, notes }, null, 1);
  deliver(new Blob([data], { type: 'application/json' }), `voice-notes-backup-${new Date().toISOString().slice(0, 10)}.json`);
}
async function importJSON(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    let added = 0;
    for (const p of d.projects || []) if (!projects.find((x) => x.id === p.id)) { projects.push(p); await DB.put('projects', p); }
    for (const n of d.notes || []) if (!notes.find((x) => x.id === n.id)) { if (n.status !== 'done') n.status = 'done'; n.hasAudio = false; (n.clips || []).forEach((c) => (c.hasAudio = false)); notes.push(n); await DB.put('notes', n); added++; }
    toast(`Импортировано заметок: ${added}`); renderSettings();
  } catch (err) { toast('Не удалось прочитать файл: ' + err.message); }
}

/* ================= Запуск ================= */
(async function boot() {
  [notes, projects] = await Promise.all([DB.all('notes'), DB.all('projects')]);
  projects.sort((a, b) => a.createdAt - b.createdAt);

  // 1) Прошлый запуск закрылся аварийно → смотрим журнал и переходим на более лёгкий режим
  const wasAlive = ls.get('vn.alive', false);
  // метка загрузки считается вылетом, только если приложение было на экране (а не свёрнуто посреди загрузки)
  const crashed = wasAlive ? ls.get('vn.loading', null) : null;
  ls.set('vn.loading', null);
  const lastStep = ls.get('vn.log', []).slice(-1)[0] || '';
  const inAsr = /распознавание: (кусок|первый|токенов)/.test(lastStep);
  markAlive(true);
  if (crashed || (wasAlive && inAsr)) {
    ls.set('vn.loading', null);
    const dev = crashed ? crashed.device : effDevice();
    const model = crashed ? crashed.model : S.model;
    const was = `${MODELS[model]?.name || model} (${dev === 'webgpu' ? 'WebGPU' : 'CPU'})`;
    if (dev === 'webgpu' || (dev === 'auto' && !IS_IOS)) { S.device = 'wasm'; }
    else if (model === 'medium') { S.model = 'small'; }
    else if (model === 'small') { S.model = 'base'; }
    else if (model === 'base') { S.model = 'tiny'; }
    // модель больше не грузится сама во время записи: звук сохраняется, распознать можно потом вручную
    ls.set('vn.safe', true);
    saveS();
    crashNote = `Прошлый раз приложение закрылось ${crashed ? 'при загрузке' : 'во время работы'} модели ${was} — скорее всего, не хватило памяти. Переключил на ${MODELS[S.model].name} (${effDevice() === 'webgpu' ? 'WebGPU' : 'CPU'}). Модель теперь загружается только кнопкой в настройках.`;
  } else if (wasAlive) {
    crashNote = `Прошлый раз приложение закрылось аварийно. Последний шаг: «${lastStep || 'неизвестно'}». Журнал — в настройках, внизу.`;
  }
  trace(`запуск v${VERSION}${IS_IOS ? ' · iOS' : ''} · ${useSys() ? 'встроенное распознавание' : 'Whisper'} (в браузере ${SR ? 'есть' : 'нет'}) · изоляция: ${self.crossOriginIsolated ? 'да' : 'нет'}${wasAlive ? ' · после вылета' : ''}`);
  if (IS_IOS && !useSys() && !crashNote) crashNote = SR ? 'Сейчас выбран Whisper — на iPhone он вылетает. Включите «Встроенное iPhone» в настройках.' : 'В этом режиме Safari нет встроенного распознавания речи, а Whisper на iPhone вылетает. Напишите разработчику.';

  // 2) Восстанавливаем записи, прерванные вылетом
  for (const n of notes) {
    if (n.status !== 'recording') continue;
    // дозапись в существующую заметку: звук собираем в аудио этой записи, а не всей заметки
    const clip = n.recClip ? (n.clips || []).find((c) => c.id === n.recClip) : null;
    const key = clip ? clipKey(n, clip) : n.id, holder = clip || n;
    if (n.parts > 0) {
      const pieces = [];
      for (let i = 0; i < n.parts; i++) { const b = await DB.get('audio', key + ':p' + i); if (b) pieces.push(await decodeWav(b)); }
      const len = pieces.reduce((s, p) => s + p.length, 0);
      const all = new Float32Array(len); let o = 0;
      for (const p of pieces) { all.set(p, o); o += p.length; }
      if (len) { await DB.put('audio', encodeWav(all), key); holder.hasAudio = true; holder.duration = len / 16000; }
      for (let i = 0; i < n.parts; i++) await DB.del('audio', key + ':p' + i);
      n.parts = 0;
    }
    delete n.recClip;
    if (clip) { clip.recovered = true; n.status = 'done'; } else { n.recovered = true; n.status = 'error'; }
    await DB.put('notes', n);
  }

  // ключ Яндекс Диска, если вход делали прямо в этом браузере (страница вернулась с #access_token=…)
  const tok = location.hash.match(/access_token=([^&]+)/);
  if (tok) { ls.set('vn.ydToken', decodeURIComponent(tok[1])); history.replaceState(null, '', location.pathname + '#/settings'); toast('Яндекс Диск подключён'); }

  render();
  pcSync();
  if (!useSys() && S.autoload && ls.get('vn.dl.' + S.model, false) && !crashNote) ASR.load();
})();
addEventListener('pagehide', () => markAlive(false));
document.addEventListener('visibilitychange', () => { markAlive(!document.hidden); if (!document.hidden) { checkUpdate(false); pcSync(); } });
setTimeout(() => checkUpdate(false), 3000);
// Предупреждение, если закрывают во время записи
addEventListener('pagehide', () => { if (rec) stopRecording(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (rec) stopRecording().finally(() => releaseMic(true)); else releaseMic(true); } });
