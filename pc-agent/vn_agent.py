"""Голосовые заметки — программа распознавания на компьютере.

Забирает аудио из папки приложения на Яндекс Диске (app:/jobs), распознаёт его
faster-whisper'ом на видеокарте (или процессоре) и кладёт текст в app:/results.
Раз в минуту отмечается «я в сети» в свойствах файла app:/pc.json — по этой
отметке телефон пишет «компьютер в сети / выключен».

Запуск:  python vn_agent.py           — работать (так её запускает Windows при входе)
         python vn_agent.py --setup   — ввести ключ, проверить связь, скачать модель
         python vn_agent.py --once    — обработать очередь один раз и выйти
         python vn_agent.py --install-extras / --remove-extras — значок, ярлыки на рабочем столе и в «Пуске»

Пока работает, в трее (у часов) значок с меню: состояние, журнал, папка, перезапуск, выход.
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

AGENT_VERSION = '1.5'
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
    'keep_awake': True,         # не давать Windows уснуть, пока идёт распознавание
}
MODELS_DIR = os.path.join(HOME, 'models')
# Разметка говорящих (sherpa-onnx, без регистрации и без torch): сегментация pyannote 3.0 + «отпечатки голоса» 3D-Speaker
SEG_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
EMB_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'
# Что звучит в неразборчивом месте (музыка, крик, смех…) — классификатор звуков AudioSet, 28 МБ
TAG_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2'
# Пометка трудного места: её ищут поиском и по ней включают запись с этого момента
CHECK = '(ЧЕЛОВЕК ПРОВЕРЬ)'
LOW_PROB = 0.45      # слово с меньшей уверенностью Whisper — сомнительное
LOW_RUN = 3          # столько сомнительных слов подряд — пометка [?…?]
GAP_SEC = 2.0        # речь есть (по разметке говорящих), а слов нет — [НЕРАЗБОРЧИВО]
OVERLAP_SEC = 1.0    # двое говорят одновременно дольше — [ГОВОРЯТ ОДНОВРЕМЕННО]
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


def fmt_ts(x):
    x = int(x)
    return f'{x // 3600}:{x % 3600 // 60:02d}:{x % 60:02d}' if x >= 3600 else f'{x // 60}:{x % 60:02d}'


def keep_awake(on):
    """Пока идёт распознавание, Windows не уходит в сон (экран при этом гаснет как обычно)."""
    if os.name != 'nt':
        return
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))
    except Exception:
        pass


def fetch_file(url, dest):
    tmp = dest + '.part'
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, 'wb') as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    os.replace(tmp, dest)


class Diarizer:
    """Кто когда говорит. Модели (~45 МБ) скачиваются при первой расшифровке встречи."""

    def __init__(self):
        self.seg = os.path.join(MODELS_DIR, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')
        self.emb = os.path.join(MODELS_DIR, os.path.basename(EMB_URL))

    def ensure(self):
        os.makedirs(MODELS_DIR, exist_ok=True)
        if not os.path.exists(self.seg):
            log.info('Скачиваю модель разметки говорящих (7 МБ)…')
            arc = os.path.join(MODELS_DIR, 'seg.tar.bz2')
            fetch_file(SEG_URL, arc)
            import tarfile
            with tarfile.open(arc) as t:
                t.extractall(MODELS_DIR)
            os.remove(arc)
        if not os.path.exists(self.emb):
            log.info('Скачиваю модель голосов (40 МБ)…')
            fetch_file(EMB_URL, self.emb)

    def run(self, audio, speakers=0):
        """audio — float32 16 кГц; speakers — сколько человек (0 — определить самому).
        Возвращает [(start, end, speaker)] по времени."""
        import sherpa_onnx
        self.ensure()
        th = max(1, (os.cpu_count() or 4) - 1)
        cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=self.seg), num_threads=th),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=self.emb, num_threads=th),
            # порог 0.9 на тестах правильно находит число говорящих, когда оно не задано
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=speakers if speakers > 0 else -1, threshold=0.9),
            min_duration_on=0.3, min_duration_off=0.5)
        if not cfg.validate():
            raise RuntimeError('модели разметки говорящих не прочитались')
        sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
        res = sd.process(audio).sort_by_start_time()
        return [(r.start, r.end, r.speaker) for r in res]


class Tagger:
    """Определяет, что звучит в отрезке: музыка, крик, смех, шум… Модель качается один раз."""
    MAP = [  # (слова в названии класса AudioSet, пометка)
        (('music', 'singing', 'song', 'musical', 'guitar', 'piano', 'drum', 'a capella'), 'МУЗЫКА'),
        (('shout', 'yell', 'scream', 'bellow', 'whoop'), 'КРИК'),
        (('laugh', 'giggle', 'chuckle', 'snicker'), 'СМЕХ'),
        (('crying', 'sobbing', 'whimper', 'baby cry'), 'ПЛАЧ'),
        (('telephone', 'ringtone', 'ring'), 'ЗВОНОК'),
        (('dog', 'bark'), 'ЛАЙ СОБАКИ'),
        (('vehicle', 'traffic', 'car', 'engine', 'motor', 'train', 'bus'), 'ШУМ ТРАНСПОРТА'),
        (('applause', 'clapping'), 'АПЛОДИСМЕНТЫ'),
        (('speech', 'conversation', 'babble', 'narration', 'chatter', 'whisper'), 'РЕЧЬ'),
        (('silence',), 'ТИШИНА'),
    ]

    def __init__(self):
        self.dir = os.path.join(MODELS_DIR, 'sherpa-onnx-ced-tiny-audio-tagging-2024-04-19')
        self.at = None

    def load(self):
        if self.at:
            return
        import sherpa_onnx
        if not os.path.exists(os.path.join(self.dir, 'model.int8.onnx')):
            log.info('Скачиваю модель распознавания звуков (28 МБ)…')
            os.makedirs(MODELS_DIR, exist_ok=True)
            arc = os.path.join(MODELS_DIR, 'tag.tar.bz2')
            fetch_file(TAG_URL, arc)
            import tarfile
            with tarfile.open(arc) as t:
                t.extractall(MODELS_DIR)
            os.remove(arc)
        self.at = sherpa_onnx.AudioTagging(sherpa_onnx.AudioTaggingConfig(
            model=sherpa_onnx.AudioTaggingModelConfig(ced=os.path.join(self.dir, 'model.int8.onnx'), num_threads=2),
            labels=os.path.join(self.dir, 'class_labels_indices.csv'), top_k=5))

    def label(self, audio, a, b):
        """Русская пометка для отрезка a..b (секунды) или None, если не понять."""
        self.load()
        x = audio[int(a * 16000):int(min(b, a + 10) * 16000)]
        if len(x) < 8000:
            return None
        st = self.at.create_stream()
        st.accept_waveform(16000, x)
        for e in self.at.compute(st):
            name = e.name.lower()
            for keys, ru in self.MAP:
                if any(k in name for k in keys):
                    return ru
        return 'ШУМ'


def find_events(words, turns, drops, dur):
    """Трудные места: [(start, end, kind)], kind = gap | overlap | drop.
    gap — разметка говорящих слышит речь, а Whisper не дал ни слова;
    overlap — два голоса одновременно; drop — отброшенная «галлюцинация» Whisper (обычно шум/музыка)."""
    ev = []
    covered = sorted((w[0] - 0.5, w[1] + 0.5) for w in words)
    for a, b, _ in turns:
        t = a
        for ca, cb in covered:
            if cb <= t or ca >= b:
                continue
            if ca - t >= GAP_SEC:
                ev.append((t, ca, 'gap'))
            t = max(t, cb)
        if b - t >= GAP_SEC:
            ev.append((t, b, 'gap'))
    for i in range(len(turns)):
        for j in range(i + 1, len(turns)):
            a1, b1, s1 = turns[i]
            a2, b2, s2 = turns[j]
            if a2 >= b1:
                break
            if s1 != s2 and min(b1, b2) - max(a1, a2) >= OVERLAP_SEC:
                ev.append((max(a1, a2), min(b1, b2), 'overlap'))
    ev += [(a, b, 'drop') for a, b in drops]
    # перекрывающиеся пометки — одной; вид — самый говорящий (наложение голосов > отброшенный текст > пропуск)
    rank = {'overlap': 2, 'drop': 1, 'gap': 0}
    ev.sort()
    out = []
    for e in ev:
        if out and e[0] <= out[-1][1] + 0.5:
            k = max(out[-1][2], e[2], key=rank.get)
            out[-1] = (out[-1][0], max(out[-1][1], e[1]), k)
        else:
            out.append(e)
    return out


def mark_low_confidence(words):
    """Подряд ≥ LOW_RUN сомнительных слов → «[?слова?] (ЧЕЛОВЕК ПРОВЕРЬ)», как в судебных стенограммах."""
    out, i = [], 0
    while i < len(words):
        j = i
        while j < len(words) and words[j][3] < LOW_PROB:
            j += 1
        if j - i >= LOW_RUN:
            run = words[i:j]
            first, last = run[0], run[-1]
            out.append((first[0], first[1], re.sub(r'^(\s*)', r'\1[?', first[2], count=1), None))
            out += [(w[0], w[1], w[2], None) for w in run[1:-1]]
            out.append((last[0], last[1], last[2] + '?] ' + CHECK, first[0]))
            i = j
        else:
            w = words[i]
            out.append((w[0], w[1], w[2], None))
            i += 1
    return out


def assign_speakers(words, turns):
    """Каждому слову — говорящего, чей отрезок накрывает середину слова (или ближайшего).
    Номера говорящих перенумеровываются по порядку появления: 0, 1, 2…"""
    if not turns:
        return [None] * len(words)
    out, j, ren = [], 0, {}
    for w in words:
        mid = (w[0] + w[1]) / 2
        while j + 1 < len(turns) and turns[j][1] < mid:
            j += 1
        best, dist = None, 1e9
        for k in (j - 1, j, j + 1):
            if 0 <= k < len(turns):
                a, b, sp = turns[k]
                d = 0 if a <= mid <= b else min(abs(mid - a), abs(mid - b))
                if d < dist:
                    best, dist = sp, d
        if best not in ren:
            ren[best] = len(ren)
        out.append(ren[best])
    return out


def build_utterances(words, spk, max_sec=45):
    """Слова → реплики: новая реплика при смене говорящего, паузе > 2 с
    или когда реплика длиннее max_sec и закончилось предложение."""
    utts = []
    for (a, b, t, chk), sp in zip(words, spk):
        u = utts[-1] if utts else None
        if (u is None or sp != u['spk'] or a - u['e'] > 2
                or (b - u['s'] > max_sec and re.search(r'[.!?…)]$', u['text']))):
            u = {'s': round(a, 2), 'e': round(b, 2), 'spk': sp, 'text': ''}
            utts.append(u)
        u['text'] += t
        u['e'] = round(max(u['e'], b), 2)
        if chk is not None:  # время каждой пометки «ЧЕЛОВЕК ПРОВЕРЬ» по порядку — телефон включает с него запись
            u.setdefault('chk', []).append(round(chk, 2))
    for u in utts:
        u['text'] = u['text'].strip()
        u['text'] = u['text'][:1].upper() + u['text'][1:]
    return [u for u in utts if u['text']]


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

    def meeting(self, path, lang, speakers, progress):
        """Расшифровка встречи: реплики со временем и говорящим."""
        self.load()
        t0 = time.time()
        from faster_whisper import decode_audio
        audio = decode_audio(path, sampling_rate=16000)
        dur = len(audio) / 16000
        try:
            words, drops = self._words(audio, lang, dur, progress)
        except Exception as e:
            if self.device != 'cuda':
                raise
            log.info('Ошибка на видеокарте (%s) — повторяю на процессоре', e)
            self.cuda_failed = True
            self.model = None
            self.load()
            words, drops = self._words(audio, lang, dur, progress)
        self.last_used = time.time()
        turns, derr = [], None
        # разметка нужна и одному говорящему: по ней видно, где речь была, а слов нет
        if words or drops:
            progress(0.97, 'speakers')
            try:
                td = time.time()
                turns = Diarizer().run(audio, speakers if speakers > 0 else 0)
                log.info('Разметка говорящих: %d отрезков, %d чел., %.0f с', len(turns), len({t[2] for t in turns}), time.time() - td)
            except Exception as e:
                derr = str(e)[:200]
                log.info('Разметка говорящих не удалась: %s\n%s', e, traceback.format_exc())
        tokens = mark_low_confidence(words)
        # трудные места (шум, наложение голосов, неразборчиво) — пометками в тексте, в своё время
        tagger = Tagger()
        nev = 0
        for a, b, kind in find_events(words, turns, drops, dur):
            label = None
            try:
                label = tagger.label(audio, a, b)
            except Exception as e:
                if not nev:
                    log.info('Классификатор звуков не сработал: %s', e)
            if label == 'ТИШИНА':
                continue
            if kind == 'overlap':
                txt = 'ГОВОРЯТ ОДНОВРЕМЕННО'
            elif label in (None, 'РЕЧЬ'):
                txt = 'НЕРАЗБОРЧИВО'
            else:
                txt = label + ', НЕ РАЗОБРАТЬ СЛОВ' if kind == 'gap' else label
            tokens.append((a, b, f' [{txt}, {fmt_ts(a)}–{fmt_ts(b)}] {CHECK}', a))
            nev += 1
        tokens.sort(key=lambda w: w[0])
        log.info('Трудных мест: %d', sum(1 for w in tokens if w[3] is not None))
        if speakers == 1:
            turns = []
        spk = assign_speakers(tokens, turns)
        utts = build_utterances(tokens, spk)
        n = len({u['spk'] for u in utts if u['spk'] is not None})
        return utts, n, derr, dur, time.time() - t0

    def _words(self, audio, lang, dur, progress):
        ru = lang in ('ru', None, '', 'auto')
        segs, info = self.model.transcribe(
            audio, language=None if lang in (None, '', 'auto') else lang, beam_size=self.cfg['beam_size'],
            vad_filter=True, vad_parameters={'min_silence_duration_ms': 500},
            initial_prompt=PROMPT_RU if ru else None, word_timestamps=True,
            # на длинной записи эти настройки не дают Whisper «зациклиться» на тишине
            condition_on_previous_text=True, compression_ratio_threshold=2.2, no_speech_threshold=0.6,
            hallucination_silence_threshold=2)
        words, drops, last, prev = [], [], 0, None
        for s in segs:
            t = s.text.strip()
            if not t or re.fullmatch(r'[\s.,!?…\-–—]*', t):
                continue
            if len(t) < 90 and any(re.search(h, t, re.I) for h in HALL):
                drops.append((s.start, s.end))  # «Субтитры…» на шуме или музыке — место стоит проверить
                continue
            if t == prev:  # повтор — типичная «петля» Whisper
                drops.append((s.start, s.end))
                continue
            prev = t
            for w in s.words or []:
                words.append((w.start, w.end, w.word, w.probability if w.probability is not None else 1.0))
            if time.time() - last > 30:
                progress(min(0.95, s.end / max(dur, 1)), 'text')
                last = time.time()
        return words, drops

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
        self.slept = None
        self.ready = False
        self.status = 'запускается…'
        self.stopping = False
        import threading
        self.wake = threading.Event()

    def setup_dirs(self):
        for p in ('app:/jobs', 'app:/results'):
            self.d.mkdir(p)
        if not self.d.exists('app:/pc.json'):
            self.d.upload_bytes('app:/pc.json', b'{"about": "voice-notes: computer heartbeat in custom_properties"}')
        self.ready = True

    def beat_props(self, busy):
        p = {
            'seen': int(time.time() * 1000), 'busy': 1 if busy else 0, 'agent': AGENT_VERSION,
            'model': self.eng.name or self.cfg['model'],
            'device': self.eng.device or ('cpu' if self.cfg['device'] == 'cpu' or self.eng.cuda_failed else 'cuda'),
            'stoppedAt': 0,
        }
        if self.slept:
            p['sleptFrom'], p['sleptTo'] = self.slept
        return p

    def note_gap(self, last_ms, now_ms):
        """Перерыв в отметках дольше 5 мин — компьютер спал или был выключен: запоминаем когда."""
        if last_ms and now_ms - last_ms > 5 * 60 * 1000:
            self.slept = (int(last_ms), int(now_ms))
            log.info('Компьютер спал или был выключен: %s — %s',
                     time.strftime('%d.%m %H:%M', time.localtime(last_ms / 1000)), time.strftime('%d.%m %H:%M', time.localtime(now_ms / 1000)))

    def beat(self, busy=False, force=False):
        if not force and time.time() - self.last_beat < self.cfg['heartbeat_sec']:
            return
        if not self.last_beat:  # первый запуск после выключения: перерыв считаем от прошлой отметки
            try:
                prev = (self.d.req('GET', '/resources', {'path': 'app:/pc.json', 'fields': 'custom_properties'}, ok404=True) or {}).get('custom_properties') or {}
                self.note_gap(int(prev.get('seen') or 0), int(time.time() * 1000))
                if not self.slept and prev.get('sleptFrom'):
                    self.slept = (int(prev['sleptFrom']), int(prev['sleptTo']))
            except Exception:
                pass
        self.d.props('app:/pc.json', self.beat_props(busy))
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
            self.status = 'распознаёт запись…'
            if self.cfg.get('keep_awake', True):
                keep_awake(True)
            self.beat(busy=True, force=True)
            fd, tmp = tempfile.mkstemp(suffix='.wav')
            os.close(fd)
            try:
                self.d.download_to(path, tmp)
                try:
                    if props.get('mode') == 'meeting':
                        def progress(x, stage, _p=path):
                            try:
                                self.d.props(_p, {'progress': round(x, 3), 'stage': stage})
                            except Exception:
                                pass
                        utts, n, derr, dur, secs = self.eng.meeting(tmp, props.get('lang') or 'ru', int(props.get('speakers') or 0), progress)
                        res = {'mode': 'meeting', 'segments': utts, 'speakers': n, 'model': self.eng.name, 'device': self.eng.device,
                               'audioSec': round(dur, 1), 'secs': round(secs, 1), 'at': int(time.time() * 1000)}
                        if derr:
                            res['diarError'] = derr
                        log.info('Встреча готова: %.0f мин аудио за %.0f мин, реплик %d, говорящих %d', dur / 60, secs / 60, len(utts), n)
                    else:
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
                keep_awake(False)
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
            last = time.time()
            while not self.stopping:
                time.sleep(self.cfg['heartbeat_sec'])
                if self.stopping:
                    return
                now = time.time()
                # во сне поток стоит: после пробуждения «прошла минута» оказывается часами
                self.note_gap(last * 1000, now * 1000)
                last = now
                try:
                    d.props('app:/pc.json', self.beat_props(self.busy))
                except Exception as e:
                    log.info('Отметка «в сети» не ушла: %s', e.__class__.__name__)
        threading.Thread(target=loop, daemon=True).start()

    def run(self):
        log.info('Запуск программы распознавания v%s (прокси: %s)', AGENT_VERSION,
                 os.environ.get('HTTPS_PROXY') or ('нет' if not os.environ.get('NO_PROXY') else 'напрямую'))
        self.heartbeat_loop()
        delay = self.cfg['poll_sec']
        while not self.stopping:
            try:
                self.tick()
                self.status = 'в сети, ждёт заданий'
                delay = self.cfg['poll_sec']
            except ApiError as e:
                if e.status == 401:
                    log.info('Ключ Яндекс Диска недействителен — запустите install.bat заново и вставьте новый ключ')
                    self.status = 'ключ Яндекс Диска недействителен'
                    delay = 600
                else:
                    log.info('Яндекс Диск: %s', e)
                    self.status = 'Яндекс Диск не отвечает'
                    delay = min(300, delay * 2)
            except requests.exceptions.ProxyError as e:
                log.info('Прокси не отвечает (%s) — дальше хожу напрямую', e.__class__.__name__)
                proxy_fix.fix(direct=True)
                delay = 10
            except requests.RequestException as e:
                log.info('Нет связи: %s', e.__class__.__name__)  # компьютер только проснулся / нет интернета
                self.status = 'нет интернета'
                delay = min(300, delay * 2)
            except Exception as e:
                log.info('Ошибка: %s\n%s', e, traceback.format_exc())
                self.status = 'ошибка, см. журнал'
                delay = 60
            self.wake.wait(delay)
            self.wake.clear()

    def stop(self):
        """Выход из трея: телефон должен написать «программа закрыта», а не «компьютер спит»."""
        self.stopping = True
        log.info('Программа закрыта из трея')
        try:
            now = int(time.time() * 1000)
            self.d.props('app:/pc.json', {**self.beat_props(False), 'seen': now, 'stoppedAt': now})
        except Exception:
            pass

# ---------------- Значок в трее, ярлыки ----------------
INSTALL_DIR = os.path.dirname(os.path.abspath(__file__))
ICON_FILE = os.path.join(INSTALL_DIR, 'icon.ico')
SHORTCUT = 'Голосовые заметки (ПК)'


def make_image(busy=False, size=64):
    """Красный круг с белым микрофоном (оранжевый — когда распознаёт)."""
    from PIL import Image, ImageDraw
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = size / 64
    d.ellipse((2 * k, 2 * k, 62 * k, 62 * k), fill=(240, 140, 30) if busy else (229, 72, 77))
    d.rounded_rectangle((25 * k, 12 * k, 39 * k, 38 * k), radius=7 * k, fill='white')
    d.arc((18 * k, 22 * k, 46 * k, 46 * k), 0, 180, fill='white', width=max(1, int(3 * k)))
    d.line((32 * k, 46 * k, 32 * k, 52 * k), fill='white', width=max(1, int(3 * k)))
    d.line((24 * k, 52 * k, 40 * k, 52 * k), fill='white', width=max(1, int(3 * k)))
    return im


def single_instance():
    """Вторая копия не запускается (ярлык при работающей программе): только подсказка, где значок."""
    if os.name != 'nt':
        return True
    import ctypes
    k32 = ctypes.windll.kernel32
    globals()['_MUTEX'] = k32.CreateMutexW(None, False, 'VoiceNotesAgentMutex')
    if k32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        ctypes.windll.user32.MessageBoxW(None, 'Программа распознавания уже работает.\n\nЕё значок — в трее справа внизу, у часов '
                                         '(может прятаться под стрелкой ˄). Правый щелчок по значку — меню и «Выход».',
                                         'Голосовые заметки', 0x40)
        return False
    return True


def run_tray(agent):
    """Основной цикл — в отдельном потоке, значок — в главном (так требует Windows)."""
    import threading
    try:
        import pystray
    except Exception as e:
        log.info('Значок в трее недоступен (%s) — работаю без него', e)
        agent.run()
        return
    threading.Thread(target=agent.run, daemon=True).start()
    imgs = {False: make_image(False), True: make_image(True)}

    def title():
        return f'Голосовые заметки v{AGENT_VERSION}: {agent.status}'

    def do_exit(icon, _):
        agent.stop()
        icon.stop()

    def do_restart(icon, _):
        agent.stop()
        icon.stop()
        globals()['_RESTART'] = True

    def check_now(icon, _):
        agent.wake.set()

    icon = pystray.Icon('voice-notes-agent', imgs[False], title(), menu=pystray.Menu(
        pystray.MenuItem(lambda _: title(), None, enabled=False),
        pystray.MenuItem('Проверить задания сейчас', check_now, default=True),
        pystray.MenuItem('Открыть журнал', lambda *_: os.startfile(LOG_FILE)),
        pystray.MenuItem('Открыть папку с журналом и настройками', lambda *_: os.startfile(HOME)),
        pystray.MenuItem('Открыть папку программы', lambda *_: os.startfile(INSTALL_DIR)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Перезапустить', do_restart),
        pystray.MenuItem('Выход', do_exit),
    ))

    def refresh(ic):
        ic.visible = True
        while not agent.stopping:
            try:
                ic.icon = imgs[agent.busy]
                ic.title = title()[:127]
                ic.update_menu()
            except Exception:
                pass
            time.sleep(3)
    icon.run(setup=refresh)


def _ps(script):
    """PowerShell-скрипт с русскими путями: через -EncodedCommand, чтобы кодировка не ломалась."""
    import base64
    import subprocess
    enc = base64.b64encode(script.encode('utf-16-le')).decode()
    return subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
                          capture_output=True, text=True)


def install_extras():
    """Значок icon.ico и ярлыки «Голосовые заметки (ПК)» на рабочем столе и в меню «Пуск»."""
    make_image(False, 256).save(ICON_FILE, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
    pyw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
    script = os.path.abspath(__file__)
    ps = f"""
$w = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {{
  $l = $w.CreateShortcut((Join-Path $dir '{SHORTCUT}.lnk'))
  $l.TargetPath = '{pyw}'
  $l.Arguments = '"{script}"'
  $l.WorkingDirectory = '{INSTALL_DIR}'
  $l.IconLocation = '{ICON_FILE}'
  $l.Description = 'Распознавание голосовых заметок на компьютере (значок появится в трее)'
  $l.Save()
}}
"""
    r = _ps(ps)
    print('Ярлыки «%s» — на рабочем столе и в меню «Пуск».' % SHORTCUT if r.returncode == 0 else 'Ярлыки не созданы: ' + (r.stderr or '')[:300])


def remove_extras():
    _ps(f"""
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {{
  Remove-Item -LiteralPath (Join-Path $dir '{SHORTCUT}.lnk') -ErrorAction SilentlyContinue
}}
""")


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
    if '--install-extras' in sys.argv:
        install_extras()
        return
    if '--remove-extras' in sys.argv:
        remove_extras()
        return
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
    if not single_instance():
        return
    run_tray(a)
    if globals().get('_RESTART'):
        import ctypes
        import subprocess
        if os.name == 'nt':
            ctypes.windll.kernel32.CloseHandle(globals()['_MUTEX'])
        subprocess.Popen([sys.executable, os.path.abspath(__file__)], cwd=INSTALL_DIR)
    os._exit(0)  # фоновые потоки (отметка «в сети», загрузка) не держат программу


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        log.info('Программа упала:\n%s', traceback.format_exc())
        raise
