"""Голосовые заметки — программа распознавания на компьютере.

Забирает аудио из папки приложения на Яндекс Диске (app:/jobs), распознаёт его
faster-whisper'ом на видеокарте (или процессоре) и кладёт текст в app:/results.
Раз в минуту отмечается «я в сети» в свойствах файла app:/pc.json — по этой
отметке телефон пишет «компьютер в сети / выключен».

Запуск:  python vn_agent.py           — работать (так её запускает Windows при входе)
         python vn_agent.py --setup   — ввести ключ, проверить связь, скачать модель
         python vn_agent.py --once    — обработать очередь один раз и выйти
"""
import json
import logging
import logging.handlers
import os
import re
import sys
import tempfile
import time
import traceback

import proxy_fix

# прокси Windows: переписываем https://адрес → http://адрес (иначе старый Python падает),
# а если установщик выяснил, что через прокси не работает, — ходим напрямую
_HOME = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'voice-notes-agent')
try:
    with open(os.path.join(_HOME, 'proxy.json'), encoding='utf-8') as _f:
        _DIRECT = json.load(_f).get('proxy') == 'off'
except Exception:
    _DIRECT = False
proxy_fix.fix(direct=_DIRECT)

import requests  # noqa: E402  (после настройки прокси)

AGENT_VERSION = '1.2'
API = os.environ.get('VN_YD_API', 'https://cloud-api.yandex.net/v1/disk')
HOME = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'voice-notes-agent')
TOKEN_FILE = os.path.join(HOME, 'token.txt')
CONFIG_FILE = os.path.join(HOME, 'config.json')
LOG_FILE = os.path.join(HOME, 'agent.log')
DEFAULTS = {
    'model': 'large-v3-turbo',  # точная и быстрая; на GTX 1050 4 ГБ в int8 занимает ~1,5 ГБ
    'device': 'auto',           # auto | cuda | cpu
    'compute_type': 'auto',     # auto: видеокарта → int8 (у GTX 10xx нет быстрого fp16), процессор → int8
    'cpu_model': 'large-v3-turbo',
    'poll_sec': 20,
    'heartbeat_sec': 60,
    'unload_after_min': 10,     # выгружать модель из видеопамяти, если заданий нет
    'beam_size': 5,
}
PROMPT_RU = 'Это голосовая заметка. Я говорю короткими предложениями. Здесь стоят точки, запятые и вопросительные знаки. Всё понятно?'


def punctuate(parts):
    """Кусок речи между паузами — отдельная фраза: если модель не поставила знак в конце,
    ставим точку, а следующую фразу начинаем с заглавной."""
    out = []
    for t in parts:
        if out and re.search(r'[.!?…]$', out[-1]) and t[:1].islower():
            t = t[:1].upper() + t[1:]
        if not re.search(r'[.!?…,;:]$', t):
            t += '.'
        out.append(t)
    text = ' '.join(out).strip()
    if text:
        text = text[:1].upper() + text[1:]
    return text


HALL = [r'субтитр', r'dimatorzok', r'продолжение следует', r'спасибо за просмотр', r'подпис(ыв)?айтесь', r'amara\.org', r'редактор']

os.makedirs(HOME, exist_ok=True)
log = logging.getLogger('vn')
log.setLevel(logging.INFO)
_h = logging.handlers.RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding='utf-8')
_h.setFormatter(logging.Formatter('%(asctime)s %(message)s', '%Y-%m-%d %H:%M:%S'))
log.addHandler(_h)
if sys.stdout and sys.stdout.isatty():
    log.addHandler(logging.StreamHandler(sys.stdout))


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_FILE, encoding='utf-8') as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(DEFAULTS, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.info('config.json не прочитан (%s), беру настройки по умолчанию', e)
    return cfg


def read_token():
    t = os.environ.get('VN_YD_TOKEN', '').strip()
    if t:
        return t
    try:
        with open(TOKEN_FILE, encoding='utf-8') as f:
            return f.read().strip()
    except FileNotFoundError:
        return ''


# ---------------- Яндекс Диск ----------------
class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(f'HTTP {status}: {msg}')
        self.status = status


class Disk:
    def __init__(self, token):
        self.s = requests.Session()
        self.s.headers['Authorization'] = 'OAuth ' + token

    def req(self, method, path, params=None, body=None, ok404=False):
        r = self.s.request(method, API + path, params=params, json=body, timeout=60)
        if ok404 and r.status_code == 404:
            return None
        if r.status_code >= 400:
            try:
                msg = r.json().get('message') or r.text
            except Exception:
                msg = r.text
            raise ApiError(r.status_code, msg[:200])
        return r.json() if r.content else None

    def check(self):
        # у ключа доступ только к папке приложения — проверяем созданием app:/jobs
        self.mkdir('app:/jobs')
        return self.req('GET', '/resources', {'path': 'app:/jobs', 'fields': 'name'})

    def list(self, d):
        j = self.req('GET', '/resources', {'path': d, 'limit': 500, 'sort': 'created',
                                           'fields': '_embedded.items.name,_embedded.items.size,_embedded.items.custom_properties'}, ok404=True)
        return (j or {}).get('_embedded', {}).get('items', [])

    def mkdir(self, d):
        try:
            self.req('PUT', '/resources', {'path': d})
        except ApiError as e:
            if e.status != 409:
                raise

    def upload_bytes(self, path, data):
        j = self.req('GET', '/resources/upload', {'path': path, 'overwrite': 'true'})
        r = requests.put(j['href'], data=data, timeout=300)
        if r.status_code >= 400:
            raise ApiError(r.status_code, 'загрузка')

    def download_to(self, path, dest):
        j = self.req('GET', '/resources/download', {'path': path})
        with requests.get(j['href'], stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(dest, 'wb') as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)

    def remove(self, path):
        try:
            self.req('DELETE', '/resources', {'path': path, 'permanently': 'true'})
        except ApiError as e:
            if e.status != 404:
                raise

    def exists(self, path):
        return self.req('GET', '/resources', {'path': path, 'fields': 'name'}, ok404=True) is not None

    def props(self, path, p):
        return self.req('PATCH', '/resources', {'path': path}, {'custom_properties': p})


# ---------------- Модель ----------------
def add_cuda_dlls():
    """Библиотеки CUDA ставятся pip-пакетами nvidia-cublas-cu12 / nvidia-cudnn-cu12 — подсказываем Windows, где их DLL."""
    try:
        import nvidia  # noqa
        base = list(nvidia.__path__)[0]
    except Exception:
        return
    for sub in os.listdir(base):
        b = os.path.join(base, sub, 'bin')
        if os.path.isdir(b):
            os.environ['PATH'] = b + os.pathsep + os.environ.get('PATH', '')
            if hasattr(os, 'add_dll_directory'):
                try:
                    os.add_dll_directory(b)
                except OSError:
                    pass


class Engine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.model = None
        self.name = None
        self.device = None
        self.last_used = 0
        self.cuda_failed = False

    def load(self):
        if self.model is not None:
            return
        from faster_whisper import WhisperModel
        add_cuda_dlls()
        want = self.cfg['device']
        tries = []
        if want in ('auto', 'cuda') and not self.cuda_failed:
            tries.append(('cuda', self.cfg['model'], 'int8' if self.cfg['compute_type'] == 'auto' else self.cfg['compute_type']))
        if want in ('auto', 'cpu') or self.cuda_failed:
            tries.append(('cpu', self.cfg['cpu_model'], 'int8' if self.cfg['compute_type'] == 'auto' else self.cfg['compute_type']))
        err = None
        for dev, name, ct in tries:
            try:
                t0 = time.time()
                log.info('Загружаю модель %s на %s (%s)… первый раз она скачивается, ~1,6 ГБ', name, dev, ct)
                self.model = WhisperModel(name, device=dev, compute_type=ct, cpu_threads=max(1, (os.cpu_count() or 4) - 1))
                self.name, self.device = name, dev
                log.info('Модель готова за %.0f с', time.time() - t0)
                return
            except Exception as e:
                err = e
                log.info('Не вышло на %s: %s', dev, e)
                if dev == 'cuda':
                    self.cuda_failed = True
        raise RuntimeError(f'модель не загрузилась: {err}')

    def unload_if_idle(self):
        if self.model is not None and time.time() - self.last_used > self.cfg['unload_after_min'] * 60:
            log.info('Заданий нет — выгружаю модель из памяти')
            self.model = None
            import gc
            gc.collect()

    def transcribe(self, path, lang):
        self.load()
        t0 = time.time()
        try:
            text, dur = self._run(path, lang)
        except Exception as e:
            # ошибки CUDA (нет памяти, нет DLL) — повторяем на процессоре
            if self.device == 'cuda':
                log.info('Ошибка на видеокарте (%s) — повторяю на процессоре', e)
                self.cuda_failed = True
                self.model = None
                self.load()
                text, dur = self._run(path, lang)
            else:
                raise
        self.last_used = time.time()
        return text, dur, time.time() - t0

    def _run(self, path, lang):
        ru = lang in ('ru', None, '', 'auto')
        segs, info = self.model.transcribe(
            path, language=None if lang in (None, '', 'auto') else lang, beam_size=self.cfg['beam_size'],
            vad_filter=True, vad_parameters={'min_silence_duration_ms': 500},
            # пример хорошо расставленного текста задаёт модели стиль: точки, запятые, короткие фразы.
            # Подсказка и предыдущий текст передаются в каждое окно, иначе после первых 30 с
            # модель «забывает» про знаки препинания
            initial_prompt=PROMPT_RU if ru else None,
            condition_on_previous_text=True, compression_ratio_threshold=2.2, no_speech_threshold=0.6)
        parts = []
        for s in segs:
            t = s.text.strip()
            if not t or re.fullmatch(r'[\s.,!?…\-–—]*', t):
                continue
            if len(t) < 90 and any(re.search(h, t, re.I) for h in HALL):
                continue
            if parts and parts[-1] == t:  # повтор — типичная «петля» Whisper
                continue
            parts.append(t)
        return punctuate(parts), info.duration


# ---------------- Основной цикл ----------------
class Agent:
    def __init__(self, token, cfg):
        self.token = token
        self.busy = False
        self.d = Disk(token)
        self.cfg = cfg
        self.eng = Engine(cfg)
        self.last_beat = 0
        self.ready = False

    def setup_dirs(self):
        for p in ('app:/jobs', 'app:/results'):
            self.d.mkdir(p)
        if not self.d.exists('app:/pc.json'):
            self.d.upload_bytes('app:/pc.json', b'{"about": "voice-notes: computer heartbeat in custom_properties"}')
        self.ready = True

    def beat(self, busy=False, force=False):
        if not force and time.time() - self.last_beat < self.cfg['heartbeat_sec']:
            return
        self.d.props('app:/pc.json', {
            'seen': int(time.time() * 1000), 'busy': 1 if busy else 0, 'agent': AGENT_VERSION,
            'model': self.eng.name or self.cfg['model'],
            'device': self.eng.device or ('cpu' if self.cfg['device'] == 'cpu' or self.eng.cuda_failed else 'cuda'),
        })
        self.last_beat = time.time()

    def process(self):
        jobs = [j for j in self.d.list('app:/jobs') if j['name'].endswith('.wav')]
        for j in jobs:
            nid = j['name'][:-4]
            props = j.get('custom_properties') or {}
            path = 'app:/jobs/' + j['name']
            log.info('Задание %s (%.1f МБ)', nid, (j.get('size') or 0) / 1e6)
            self.d.props(path, {'status': 'working', 'startedAt': int(time.time() * 1000)})
            self.busy = True
            self.beat(busy=True, force=True)
            fd, tmp = tempfile.mkstemp(suffix='.wav')
            os.close(fd)
            try:
                self.d.download_to(path, tmp)
                try:
                    text, dur, secs = self.eng.transcribe(tmp, props.get('lang') or 'ru')
                    res = {'text': text, 'model': self.eng.name, 'device': self.eng.device,
                           'audioSec': round(dur, 1), 'secs': round(secs, 1), 'at': int(time.time() * 1000)}
                    log.info('Готово: %.0f с аудио за %.0f с, %d символов', dur, secs, len(text))
                except Exception as e:
                    log.info('Не распознано: %s\n%s', e, traceback.format_exc())
                    res = {'error': str(e)[:300], 'at': int(time.time() * 1000)}
                self.d.upload_bytes(f'app:/results/{nid}.json', json.dumps(res, ensure_ascii=False).encode('utf-8'))
                self.d.remove(path)
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                self.busy = False
            self.beat(force=True)
        return len(jobs)

    def tick(self):
        if not self.ready:
            self.setup_dirs()
        self.beat()
        n = self.process()
        if not n:
            self.eng.unload_if_idle()
        return n

    def heartbeat_loop(self):
        """Отметка «в сети» в отдельном потоке: пока идёт долгое распознавание
        (или первая загрузка модели), телефон не должен считать компьютер выключенным."""
        import threading
        d = Disk(self.token)

        def loop():
            while True:
                time.sleep(self.cfg['heartbeat_sec'])
                try:
                    d.props('app:/pc.json', {
                        'seen': int(time.time() * 1000), 'busy': 1 if self.busy else 0, 'agent': AGENT_VERSION,
                        'model': self.eng.name or self.cfg['model'],
                        'device': self.eng.device or ('cpu' if self.cfg['device'] == 'cpu' or self.eng.cuda_failed else 'cuda'),
                    })
                except Exception as e:
                    log.info('Отметка «в сети» не ушла: %s', e.__class__.__name__)
        threading.Thread(target=loop, daemon=True).start()

    def run(self):
        log.info('Запуск программы распознавания v%s (прокси: %s)', AGENT_VERSION,
                 os.environ.get('HTTPS_PROXY') or ('нет' if not os.environ.get('NO_PROXY') else 'напрямую'))
        self.heartbeat_loop()
        delay = self.cfg['poll_sec']
        while True:
            try:
                self.tick()
                delay = self.cfg['poll_sec']
            except ApiError as e:
                if e.status == 401:
                    log.info('Ключ Яндекс Диска недействителен — запустите install.bat заново и вставьте новый ключ')
                    delay = 600
                else:
                    log.info('Яндекс Диск: %s', e)
                    delay = min(300, delay * 2)
            except requests.exceptions.ProxyError as e:
                log.info('Прокси не отвечает (%s) — дальше хожу напрямую', e.__class__.__name__)
                proxy_fix.fix(direct=True)
                delay = 10
            except requests.RequestException as e:
                log.info('Нет связи: %s', e.__class__.__name__)  # компьютер только проснулся / нет интернета
                delay = min(300, delay * 2)
            except Exception as e:
                log.info('Ошибка: %s\n%s', e, traceback.format_exc())
                delay = 60
            time.sleep(delay)


def setup(cfg):
    print('\n=== Настройка распознавания на компьютере ===\n')
    tok = read_token()
    if tok:
        print('Ключ уже сохранён. Нажмите Enter, чтобы оставить его, или вставьте новый.')
    print('Ключ: в приложении на телефоне → Настройки → «Скопировать ключ для ПК».')
    new = input('Ключ: ').strip()
    if new:
        tok = new
    if not tok:
        print('Ключ не введён.')
        return 1
    d = Disk(tok)
    try:
        d.check()
    except Exception as e:
        print('Ключ не подошёл:', e)
        return 1
    with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
        f.write(tok)
    print('Яндекс Диск: подключён')
    a = Agent(tok, cfg)
    a.setup_dirs()
    a.beat(force=True)
    print('Скачиваю и проверяю модель (первый раз ~1,6 ГБ, несколько минут)…')
    a.eng.load()
    print(f'Модель {a.eng.name} работает на: {"видеокарте" if a.eng.device == "cuda" else "процессоре"}.')
    a.beat(force=True)
    print('\nГотово. Программа будет сама запускаться при входе в Windows.')
    return 0


def main():
    cfg = load_config()
    if '--setup' in sys.argv:
        sys.exit(setup(cfg))
    tok = read_token()
    if not tok:
        log.info('Нет ключа Яндекс Диска — запустите install.bat')
        sys.exit(1)
    a = Agent(tok, cfg)
    if '--once' in sys.argv:
        a.tick()
        return
    a.run()


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        log.info('Программа упала:\n%s', traceback.format_exc())
        raise
