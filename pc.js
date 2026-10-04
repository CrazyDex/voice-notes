// Распознавание на компьютере через Яндекс Диск.
// Телефон кладёт аудио в папку приложения на Диске (app:/jobs), программа на ПК (pc-agent/)
// забирает его, распознаёт faster-whisper'ом и кладёт текст в app:/results.
// Отметка «ПК в сети» — свойства файла app:/pc.json (seen = время последней отметки).

export const API = 'https://cloud-api.yandex.net/v1/disk';
export const PC_ONLINE_MS = 3 * 60 * 1000;

export class YDisk {
  constructor(token, api = API) { this.token = token; this.api = api; }
  async req(method, path, params = {}, body) {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(this.api + path + (qs ? '?' + qs : ''), {
      method,
      headers: { Authorization: 'OAuth ' + this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(j?.message || j?.description || 'HTTP ' + r.status);
      e.status = r.status; e.code = j?.error; throw e;
    }
    return j;
  }
  // У ключа есть доступ только к папке приложения (без «информации о Диске»),
  // поэтому проверяем его созданием папки app:/jobs, а не запросом GET /
  async check() { await this.mkdir('app:/jobs'); return this.meta('app:/jobs'); }
  meta(path) { return this.req('GET', '/resources', { path, fields: 'name,modified,size,custom_properties' }); }
  async list(dir) {
    try {
      const j = await this.req('GET', '/resources', { path: dir, limit: 500, fields: '_embedded.items.name,_embedded.items.modified,_embedded.items.size,_embedded.items.custom_properties' });
      return j?._embedded?.items || [];
    } catch (e) { if (e.status === 404) return []; throw e; }
  }
  async mkdir(path) {
    try { await this.req('PUT', '/resources', { path }); } catch (e) { if (e.status !== 409) throw e; }
  }
  async upload(path, blob) {
    const { href, method } = await this.req('GET', '/resources/upload', { path, overwrite: 'true' });
    // ссылка загрузки уже подписана — без заголовка Authorization (иначе браузер упрётся в CORS)
    const r = await fetch(href, { method: method || 'PUT', body: blob });
    if (!r.ok && r.status !== 201 && r.status !== 202) throw new Error('загрузка: HTTP ' + r.status);
  }
  async download(path) {
    const { href } = await this.req('GET', '/resources/download', { path });
    const r = await fetch(href, { referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error('скачивание: HTTP ' + r.status);
    return r.text();
  }
  async remove(path) {
    try { await this.req('DELETE', '/resources', { path, permanently: 'true' }); } catch (e) { if (e.status !== 404) throw e; }
  }
  props(path, custom_properties) { return this.req('PATCH', '/resources', { path }, { custom_properties }); }
}

// «3 ч назад», «5 мин назад»
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return 'только что';
  const m = Math.round(s / 60); if (m < 60) return m + ' мин назад';
  const h = Math.round(m / 60); if (h < 36) return h + ' ч назад';
  return Math.round(h / 24) + ' дн назад';
}

// Пословное сравнение двух текстов: [{t:'=',s}|{t:'-',s}|{t:'+',s}]
export function diffWords(a, b) {
  const A = (a || '').split(/(\s+)/).filter((x) => x !== ''), B = (b || '').split(/(\s+)/).filter((x) => x !== '');
  const n = A.length, m = B.length;
  // на очень длинных текстах таблица слишком большая — показываем «было/стало» целиком
  if (n * m > 4e6) return [{ t: '-', s: a }, { t: '+', s: b }];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [], push = (t, s) => { const l = out[out.length - 1]; if (l && l.t === t) l.s += s; else out.push({ t, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('=', A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('-', A[i++]);
    else push('+', B[j++]);
  }
  while (i < n) push('-', A[i++]);
  while (j < m) push('+', B[j++]);
  return out;
}
