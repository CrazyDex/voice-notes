import { Recorder, encodeWav, decodeWav, segmentAll } from './audio.js';

/* ================= Настройки ================= */
const DEFAULTS = { model: 'small', device: 'auto', lang: 'ru', segMax: 12, autoload: true, keepAudio: true };
const MODELS = {
  base: { name: 'Base', size: '~80 МБ', note: 'Быстро, но больше ошибок. Для слабых устройств.' },
  small: { name: 'Small', size: '~250 МБ', note: 'Баланс скорости и качества. Рекомендуется для iPhone.' },
  medium: { name: 'Medium', size: '~800 МБ', note: 'Эксперимент: точнее, но медленно и может вылетать на телефоне по памяти.' },
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const S = Object.assign({}, DEFAULTS, ls.get('vn.settings', {}));
const saveS = () => ls.set('vn.settings', S);

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
let notes = [], projects = [];
const filter = { project: null, tag: null, q: '' };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

const TAG_RE = /(^|[\s(,.;:!?])#([\p{L}\p{N}_\-/]+)/gu;
const LINK_RE = /\[\[([^\[\]\n]{1,120})\]\]/g;

function titleOf(n) {
  if (n.title?.trim()) return n.title.trim();
  const t = (n.text || '').replace(LINK_RE, '$1').replace(/\s+/g, ' ').trim();
  if (t) { const w = t.split(' ').slice(0, 7).join(' '); return w.length < t.length ? w + '…' : w; }
  return 'Заметка ' + fmtDate(n.createdAt);
}
function tagsOf(n) {
  const set = new Set(n.tags || []);
  for (const m of (n.text || '').matchAll(TAG_RE)) set.add(m[2].toLowerCase());
  return [...set];
}
function linksOf(n) { return [...(n.text || '').matchAll(LINK_RE)].map((m) => m[1].trim()); }
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

function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

/* ================= Иконки ================= */
const I = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

/* ================= Распознавание ================= */
const ASR = {
  w: null, state: 'idle', msg: '', progress: 0, info: null, pending: new Map(), seq: 0, want: '',
  rtf: ls.get('vn.rtf', null),
  init() {
    try {
      this.w = new Worker('asr-worker.js', { type: 'module' });
      this.w.onmessage = (e) => this.on(e.data);
      this.w.onerror = (e) => { this.state = 'error'; this.msg = 'Модуль распознавания не запустился (нужен интернет при первом запуске).'; asrUI(); e.preventDefault?.(); };
    } catch (e) { this.state = 'error'; this.msg = String(e); }
  },
  load() {
    if (!this.w) this.init();
    if (!this.w) return;
    this.state = 'loading'; this.progress = 0; this.msg = 'Запуск…';
    this.want = S.model + '|' + S.device;
    this.w.postMessage({ type: 'load', model: S.model, device: S.device });
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
      this.w.postMessage({ type: 'run', id, audio, language: S.lang }, [audio.buffer]);
    });
  },
  get queue() { return this.pending.size; },
  on(m) {
    if (m.type === 'status') { this.msg = m.text; }
    else if (m.type === 'progress') { this.progress = m.total ? m.loaded / m.total : 0; this.msg = `Скачивание модели ${Math.round(this.progress * 100)}% (${(m.loaded / 1e6).toFixed(0)} из ${(m.total / 1e6).toFixed(0)} МБ)`; }
    else if (m.type === 'ready') {
      this.state = 'ready'; this.info = m; this.msg = '';
      ls.set('vn.dl.' + m.model, true);
      try { navigator.storage?.persist?.(); } catch {}
    }
    else if (m.type === 'error') { this.state = 'error'; this.msg = m.text; }
    else if (m.type === 'result') {
      const res = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.ms && m.dur) { this.rtf = m.ms / 1000 / m.dur; ls.set('vn.rtf', this.rtf); }
      res && res(m);
    }
    asrUI();
  },
};

function asrStatusHTML() {
  const name = MODELS[S.model].name;
  let cls = '', txt;
  if (ASR.state === 'ready') { cls = 'ok'; txt = `${name} · ${ASR.info.device === 'webgpu' ? 'WebGPU' : 'CPU'} · готово`; }
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
  const head = n.prefix ? n.prefix + ' ' : '';
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

/* ================= Запись ================= */
let rec = null, recNote = null, recTimer = null, wake = null, segIndex = 0;

function recInfo() {
  const j = recNote && jobs.get(recNote.id);
  const parts = [MODELS[S.model].name];
  if (ASR.state === 'loading') parts.push(ASR.msg || 'загрузка модели');
  if (j) parts.push(`кусков: ${j.done}/${j.total}`);
  if (ASR.rtf && ASR.state === 'ready') parts.push(`скорость ×${ASR.rtf.toFixed(2)}`);
  return parts.join(' · ');
}

async function startRecording() {
  if (rec) return;
  const note = {
    id: uid(), createdAt: Date.now(), updatedAt: Date.now(), title: '', text: '', segTexts: [],
    tags: [], projectId: filter.project && filter.project !== 'none' ? filter.project : null, status: 'recording',
  };
  if (filter.tag) note.tags.push(filter.tag);
  rec = new Recorder();
  segIndex = 0;
  try {
    await rec.start({
      segOpts: { minSec: 3, maxSec: S.segMax, silenceMs: 500 },
      onSegment: (a) => enqueue(note, a, segIndex++),
    });
  } catch (e) {
    rec = null;
    toast(e?.name === 'NotAllowedError' ? 'Нет доступа к микрофону. Разрешите его в настройках Safari.' : 'Микрофон недоступен: ' + (e?.message || e), 4500);
    return;
  }
  recNote = note;
  notes.unshift(note);
  saveNote(note);
  ASR.ensure();
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  renderRec();
  recTimer = setInterval(updateRec, 100);
}

async function stopRecording() {
  if (!rec) return;
  clearInterval(recTimer);
  const r = rec; rec = null;
  const pcm = await r.stop();
  const note = recNote; recNote = null;
  try { await wake?.release(); } catch {}
  wake = null;
  note.duration = pcm.length / 16000;
  if (S.keepAudio && pcm.length) { await DB.put('audio', encodeWav(pcm), note.id); note.hasAudio = true; }
  note.status = jobs.has(note.id) ? 'transcribing' : 'done';
  finishIfDone(note);
  saveNote(note);
  $('.rec')?.remove();
  location.hash = '#/n/' + note.id;
}

function renderRec() {
  const el = document.createElement('div');
  el.className = 'rec';
  const quick = ['идея', 'баг', 'задача', 'вопрос'];
  el.innerHTML = `
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

/* ================= Перераспознавание ================= */
async function retranscribe(note) {
  const blob = await DB.get('audio', note.id);
  if (!blob) { toast('Аудио не сохранено'); return; }
  if (note.text && note.status === 'done' && !confirm('Текст будет заменён новым распознаванием. Продолжить?')) return;
  const pcm = await decodeWav(blob);
  const segs = segmentAll(pcm, { minSec: 3, maxSec: S.segMax, silenceMs: 500 });
  note.segTexts = []; note.prefix = ''; note.text = ''; note.status = 'transcribing';
  jobs.delete(note.id);
  if (!segs.length) { note.status = 'done'; toast('В записи не найдено речи'); }
  segs.forEach((s, i) => enqueue(note, s.a, i));
  saveNote(note);
  onNoteChanged(note);
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
      <a class="iconbtn" href="#/projects" aria-label="Проекты">${I.folder}</a>
      <a class="iconbtn" href="#/settings" aria-label="Настройки">${I.gear}</a></div>
    <input class="search" id="q" type="search" placeholder="Поиск по тексту, #меткам, [[связям]]" value="${esc(filter.q)}">
    <div class="chips" id="pchips"></div>
    <div class="status" data-asr>${asrStatusHTML()}</div>
  </div></header>
  <main class="wrap"><div class="list" id="list"></div></main>
  <button class="fab" id="fab" aria-label="Записать">${I.mic}</button>`;
  $('#q').oninput = (e) => { filter.q = e.target.value; renderList(); };
  $('#fab').onclick = startRecording;
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
    const links = linksOf(n).length;
    return `<a class="card" href="#/n/${encodeURIComponent(n.id)}">
      <div class="t">${esc(titleOf(n))}</div>
      <div class="s">${esc((n.text || '').slice(0, 220)) || '<i>без текста</i>'}</div>
      <div class="meta"><span>${fmtDate(n.createdAt)}</span>${n.duration ? `<span>${fmtDur(n.duration)}</span>` : ''}
        ${n.projectId ? `<span class="badge">${esc(projName(n.projectId) || '?')}</span>` : ''}
        ${tagsOf(n).slice(0, 4).map((t) => `<span class="tg">#${esc(t)}</span>`).join('')}
        ${links ? `<span>🔗 ${links}</span>` : ''}${st}</div></a>`;
  }).join('');
}

/* ================= Заметка ================= */
let editMode = false, lastNoteId = null;
function renderedText(n) {
  let h = esc(n.text || '');
  h = h.replace(/\[\[([^\[\]\n]{1,120})\]\]/g, (_, t) => {
    const target = findByTitle(t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
    return `<a class="lk ${target ? '' : 'missing'}" data-link="${t}">${t}</a>`;
  });
  h = h.replace(/(^|[\s(,.;:!?])#([\p{L}\p{N}_\-/]+)/gu, (_, p, t) => `${p}<a class="tg" data-tag="${t.toLowerCase()}">#${t}</a>`);
  return h || '<span class="small">Текста пока нет</span>';
}
function statusHTML(n) {
  const j = jobs.get(n.id);
  if (n.status === 'transcribing' && j) {
    return `<div class="warnbox">Распознаётся: ${j.done} из ${j.total}. Можно уйти с экрана, текст допишется сам, пока приложение открыто.
      <div class="progress"><i style="width:${(j.done / j.total) * 100}%"></i></div></div>`;
  }
  if (n.status === 'transcribing' || n.status === 'recording') return `<div class="warnbox">Распознавание было прервано (приложение закрывалось). ${n.hasAudio ? 'Нажмите «Перераспознать».' : ''}</div>`;
  if (n.status === 'error') return `<div class="warnbox">Часть записи не распознана. Нажмите «Перераспознать».</div>`;
  return '';
}
function renderNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) { app.innerHTML = '<div class="wrap empty">Заметка не найдена. <a href="#/">На главную</a></div>'; return; }
  if (lastNoteId !== id) { editMode = !n.text && n.status === 'done'; lastNoteId = id; }
  const busy = n.status === 'transcribing' && jobs.has(n.id);
  const backlinks = notes.filter((o) => o.id !== n.id && linksOf(o).some((l) => l.toLowerCase() === titleOf(n).toLowerCase() || (n.title && l.toLowerCase() === n.title.trim().toLowerCase())));
  const outgoing = linksOf(n);
  app.innerHTML = `
  <header class="top"><div class="wrap row">
    <a class="iconbtn" href="#/" aria-label="Назад">${I.back}</a>
    <div class="grow small">${fmtDate(n.createdAt)}${n.duration ? ' · ' + fmtDur(n.duration) : ''}</div>
    <div class="seg" style="width:170px"><button data-m="0" class="${!editMode ? 'on' : ''}">Просмотр</button><button data-m="1" class="${editMode ? 'on' : ''}">Правка</button></div>
  </div></header>
  <main class="wrap" style="padding-bottom:60px">
    <input class="title-in" id="ntitle" placeholder="${esc(titleOf(n))}" value="${esc(n.title || '')}">
    <div class="chips">
      <button class="chip" id="nproj">${I.folder.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"')} ${esc(projName(n.projectId) || 'Без проекта')}</button>
      ${(n.tags || []).map((t) => `<button class="chip tag on" data-rmtag="${esc(t)}">#${esc(t)} ✕</button>`).join('')}
      <button class="chip tag" id="addtag">+ метка</button>
    </div>
    <div id="nstatus">${statusHTML(n)}</div>
    ${editMode && !busy ? `
      <div class="btns" style="margin:8px 0"><button class="btn" id="inslink">[[ ]] Связать</button><button class="btn" id="instag"># Метка</button></div>
      <textarea class="field" id="ntext" placeholder="Текст заметки. #метки и [[ссылки на другие заметки]] работают прямо в тексте.">${esc(n.text || '')}</textarea>`
      : `<div class="rendered" id="ntextv">${renderedText(n)}</div>`}
    ${outgoing.length ? `<div class="sec">Связи из заметки</div><div class="chips" style="flex-wrap:wrap">${outgoing.map((l) => `<button class="chip" data-link="${esc(l)}">🔗 ${esc(l)}</button>`).join('')}</div>` : ''}
    <div class="sec">Ссылаются сюда</div>
    ${backlinks.length ? backlinks.map((b) => `<a class="card" href="#/n/${encodeURIComponent(b.id)}" style="margin-bottom:6px"><div class="t">${esc(titleOf(b))}</div><div class="meta">${fmtDate(b.createdAt)}</div></a>`).join('') : '<div class="small">Пока никто. Напишите [[' + esc(titleOf(n)) + ']] в другой заметке.</div>'}
    <div class="sec">Аудио</div>
    <div id="naudio" class="small">${n.hasAudio ? 'Загрузка…' : 'Не сохранено'}</div>
    <div class="btns" style="margin-top:10px">
      ${n.hasAudio ? `<button class="btn" id="retr">↻ Перераспознать (${MODELS[S.model].name})</button>` : ''}
      <button class="btn danger" id="del">Удалить</button>
    </div>
  </main>`;

  app.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
    if (busy && b.dataset.m === '1') { toast('Дождитесь окончания распознавания'); return; }
    editMode = b.dataset.m === '1'; renderNote(id);
  }));
  $('#ntitle').oninput = (e) => { n.title = e.target.value; saveNote(n, 500); };
  const ta = $('#ntext');
  if (ta) {
    ta.oninput = () => { n.text = ta.value; n.segTexts = null; n.prefix = ''; saveNote(n, 500); };
    $('#inslink').onclick = () => pickNote(n.id, (title) => insertAt(ta, `[[${title}]]`));
    $('#instag').onclick = () => { const t = prompt('Метка (без #):'); if (t) insertAt(ta, '#' + t.trim().replace(/\s+/g, '_') + ' '); };
  }
  $('#nproj').onclick = () => pickProject(n.projectId, (pid) => { n.projectId = pid; saveNote(n); renderNote(id); });
  $('#addtag').onclick = () => {
    const t = prompt('Новая метка (без #):'); if (!t) return;
    const v = t.trim().replace(/^#/, '').replace(/\s+/g, '_').toLowerCase();
    if (v && !(n.tags || []).includes(v)) { n.tags = [...(n.tags || []), v]; saveNote(n); renderNote(id); }
  };
  app.querySelectorAll('[data-rmtag]').forEach((b) => (b.onclick = () => { n.tags = n.tags.filter((t) => t !== b.dataset.rmtag); saveNote(n); renderNote(id); }));
  bindTextLinks(app);
  const rt = $('#retr'); if (rt) rt.onclick = () => retranscribe(n);
  $('#del').onclick = async () => {
    if (!confirm('Удалить заметку безвозвратно?')) return;
    notes = notes.filter((x) => x.id !== n.id); jobs.delete(n.id);
    await DB.del('notes', n.id); await DB.del('audio', n.id);
    location.hash = '#/';
  };
  if (n.hasAudio) DB.get('audio', n.id).then((blob) => {
    const box = $('#naudio'); if (!box) return;
    if (!blob) { box.textContent = 'Не найдено'; return; }
    box.innerHTML = `<audio controls preload="metadata" src="${URL.createObjectURL(blob)}"></audio><div>${(blob.size / 1e6).toFixed(1)} МБ</div>`;
  });
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
function pickNote(selfId, cb) {
  sheet(`<input class="search" id="pq" placeholder="Найти заметку или ввести новое название"><div id="pl" style="margin-top:8px"></div>`, (el, close) => {
    const draw = () => {
      const q = $('#pq', el).value.trim().toLowerCase();
      const list = notes.filter((n) => n.id !== selfId && titleOf(n).toLowerCase().includes(q)).slice(0, 30);
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
    <div class="sec">Модель распознавания</div>
    ${Object.entries(MODELS).map(([k, m]) => `<button class="opt ${S.model === k ? 'on' : ''}" data-model="${k}"><div><b>${m.name} <span class="small">${m.size}${ls.get('vn.dl.' + k, false) ? ' · скачана' : ''}</span></b><span class="small">${m.note}</span></div></button>`).join('')}
    <div class="status" data-asr>${asrStatusHTML()}</div>
    <div class="progress"><i id="dlprog"></i></div>
    <div class="small" id="dlmsg" style="margin-top:6px;word-break:break-word"></div>
    <div class="btns" style="margin-top:10px"><button class="btn primary" id="loadm">Загрузить / проверить модель</button></div>

    <div class="sec">Язык речи</div>${segBtn('lang', [['ru', 'Русский'], ['en', 'English'], ['auto', 'Авто']])}
    <div class="sec">Вычисления</div>${segBtn('device', [['auto', 'Авто'], ['webgpu', 'WebGPU'], ['wasm', 'CPU']])}
    <div class="small" style="margin-top:6px">WebGPU — видеочип, обычно в разы быстрее. CPU — запасной вариант.</div>
    <div class="sec">Максимальная длина куска</div>${segBtn('segMax', [[8, '8 с'], [12, '12 с'], [20, '20 с']])}
    <div class="small" style="margin-top:6px">Запись режется по паузам. Короче — текст появляется быстрее, длиннее — точнее контекст.</div>
    <div class="sec">Прочее</div>
    ${segBtn('autoload', [[true, 'Грузить модель при запуске'], [false, 'Только при записи']])}
    <div style="height:8px"></div>${segBtn('keepAudio', [[true, 'Хранить аудио'], [false, 'Только текст']])}

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
    <div class="small" style="margin-top:24px">Всё хранится только на этом устройстве. Распознавание идёт локально, интернет нужен только для первой загрузки модели.</div>
  </main>`;
  asrUI();
  app.querySelectorAll('[data-model]').forEach((b) => (b.onclick = () => {
    S.model = b.dataset.model; saveS();
    if (S.model === 'medium') toast('Medium на телефоне — эксперимент: может работать медленно или закрыть приложение', 4500);
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

/* ================= Экспорт ================= */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
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
    for (const n of d.notes || []) if (!notes.find((x) => x.id === n.id)) { if (n.status !== 'done') n.status = 'done'; n.hasAudio = false; notes.push(n); await DB.put('notes', n); added++; }
    toast(`Импортировано заметок: ${added}`); renderSettings();
  } catch (err) { toast('Не удалось прочитать файл: ' + err.message); }
}

/* ================= Запуск ================= */
(async function boot() {
  [notes, projects] = await Promise.all([DB.all('notes'), DB.all('projects')]);
  projects.sort((a, b) => a.createdAt - b.createdAt);
  render();
  if (S.autoload && ls.get('vn.dl.' + S.model, false)) ASR.load();
})();
// Предупреждение, если закрывают во время записи
addEventListener('pagehide', () => { if (rec) stopRecording(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && rec) stopRecording(); });
