"""Системный прокси Windows для Python.

Старые Python/pip читают прокси из настроек Windows как https://адрес и падают
с «check_hostname requires server_hostname». Здесь прокси переписывается в http://
(так с ним и нужно разговаривать) и кладётся в переменные окружения.
Запуск отдельно печатает адрес прокси (или пустую строку) — его берёт install.bat.
"""
import os
import urllib.request


def fix(direct=False):
    if direct:
        for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
            os.environ.pop(k, None)
        os.environ['NO_PROXY'] = os.environ['no_proxy'] = '*'
        return {}
    out = {}
    for k, v in urllib.request.getproxies().items():
        if k not in ('http', 'https') or not v:
            continue
        if v.startswith('https://'):
            v = 'http://' + v[len('https://'):]
        elif '://' not in v:
            v = 'http://' + v
        out[k] = v
    for k, v in out.items():
        os.environ[k.upper() + '_PROXY'] = os.environ[k + '_proxy'] = v
    return out


if __name__ == '__main__':
    p = fix()
    print(p.get('https') or p.get('http') or '')
