#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只重建前端（复用线上已有数据）。

用途：改的是页面样式 / 交互（app.js、style.css、index.html），数据本身没变。
这时没必要重新抓 2.6 万条曲线（要 100 分钟），直接从线上站点把 data/*.js 取回来，
重新生成聚合并套上新模板，几十秒就能发布。

环境变量：
  SITE_URL  线上站点根地址，默认 https://lcldnpkx.github.io/tianya-rank
  RANK_OUT  输出目录，默认 public
"""

import json
import os
import re
import sys
import urllib.request

SITE = (os.environ.get('SITE_URL') or 'https://lcldnpkx.github.io/tianya-rank').rstrip('/')
OUT = os.environ.get('RANK_OUT') or 'public'
DATA = os.path.join(OUT, 'data')


def grab(url, path):
    req = urllib.request.Request(url, headers={'User-Agent': 'rank-rebuild'})
    with urllib.request.urlopen(req, timeout=180) as r:
        blob = r.read()
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'wb') as f:
        f.write(blob)
    return len(blob)


def main():
    os.makedirs(DATA, exist_ok=True)

    grab(SITE + '/data/servers.js', os.path.join(DATA, 'servers.js'))
    t = open(os.path.join(DATA, 'servers.js'), encoding='utf-8').read()
    lst = json.loads(re.search(r'window\.__SRV_LIST=(\[.*?\]);', t, re.DOTALL).group(1))
    meta = json.loads(re.search(r'window\.__SRV_META=(\{.*?\});', t, re.DOTALL).group(1))
    ids = [s['id'] for s in lst]
    print('复用 %d 个服务器的数据（快照 %s）' % (len(ids), meta.get('snapshot')))

    for sid in ids:
        for pat in ('s-%s.js', 'gd-%s.js'):
            name = pat % sid
            try:
                grab(SITE + '/data/' + name, os.path.join(DATA, name))
            except Exception as e:            # noqa: BLE001
                print('  skip %s: %s' % (name, e))
    for name in ('ghist.js', 'grel.js'):
        try:
            grab(SITE + '/data/' + name, os.path.join(DATA, name))
        except Exception as e:                # noqa: BLE001
            print('  skip %s: %s' % (name, e))

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import gen_agg
    import gen_ghist
    stats = gen_agg.build(OUT)
    gen_ghist.build(OUT)
    print('聚合成 %d 份（含分片）' % len(stats))

    snap = meta.get('snapshot') or 'dev'
    tpl = open('template.html', encoding='utf-8').read().replace('__DATA_VER__', snap)
    with open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(tpl)
    print('前端重建完成，页面版本号 %s' % snap)


if __name__ == '__main__':
    main()
