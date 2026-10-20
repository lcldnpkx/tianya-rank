#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
帮派功力历史（回溯 30 天）
==========================
数据源的帮派 flow 只给最近 7 天，但**每个角色**的成长曲线有 30 天。
本模块用「角色曲线 → 按帮派聚合」把帮派的历史功力反推出来：

    某帮某天功力 = 当天属于该帮的收录成员功力，取前 80 名求和

口径与榜单「前 80 之和」一致；隐藏功力的成员用其估算值参与。
个别成员当天不在榜（曲线无该点）时不计入，属于已知的轻微低估。

产物：data/ghist.js
    window.__GHIST = { days: ['2026-09-21', ...], g: { '2303|网恋公会': [值, ...] } }

用法：python3 gen_ghist.py [发布目录]
      （update.py 主流程写完各服数据后会调用 build）
"""

import glob
import json
import os
import re
import sys

PUBLISH_DIR = os.environ.get('RANK_OUT') or '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d4b-adc287da0000/publish'

TOP_N = 80            # 与官方「帮派功力 = 前 80 名成员之和」保持一致


def decode_history(arr):
    """还原 pack_history 的编码，返回 {day_idx: power}（power 可能为 None）。"""
    out = {}
    if not arr:
        return out
    i = arr[0]
    for v in arr[1:]:
        if not isinstance(v, list) or not v:
            continue
        if v[0] == -1:                      # 断点：跳到下一个有数据的日期
            i = i + (v[1] or 0) - 1
        else:
            out[i] = v[0]
            i += 1
    return out


def load_days(pub_dir):
    p = os.path.join(pub_dir, 'data', 'servers.js')
    t = open(p, encoding='utf-8').read()
    m = re.search(r'window\.__SRV_DAYS=(\[.*?\]);', t, re.DOTALL)
    return json.loads(m.group(1)) if m else []


def build(pub_dir):
    days = load_days(pub_dir)
    if len(days) < 2:
        return 0, 0

    # (rid|帮派) -> {day_idx: [成员功力, ...]}
    bucket = {}
    files = sorted(glob.glob(os.path.join(pub_dir, 'data', 's-*.js')))
    for f in files:
        t = open(f, encoding='utf-8').read()
        m = re.search(r'window\.__SRV_DATA\["(\d+)"\]\s*=\s*(\{.*\});\s*$', t, re.DOTALL)
        if not m:
            continue
        rid, d = m.group(1), json.loads(m.group(2))
        for r in d.get('roles') or []:
            gname = r.get('g')
            if not gname or r.get('gh'):
                continue                    # 帮派隐藏的角色无法归组
            est = r.get('pe') or r.get('p')
            pts = decode_history(r.get('h'))
            if not pts:
                continue
            slot = bucket.setdefault('%s|%s' % (rid, gname), {})
            for idx, pw in pts.items():
                if idx >= len(days):
                    continue
                val = pw if pw is not None else est
                if val:
                    slot.setdefault(idx, []).append(val)

    out, kept = {}, 0
    for key, slot in bucket.items():
        arr = [None] * len(days)
        for idx, vals in slot.items():
            if len(vals) > TOP_N:
                vals.sort(reverse=True)
                arr[idx] = sum(vals[:TOP_N])
            else:
                arr[idx] = sum(vals)
        n = sum(1 for x in arr if x)
        if n >= 2:                          # 只有一个点的曲线没意义
            out[key] = arr
            kept += 1

    js = 'window.__GHIST=%s;' % json.dumps(
        {'days': days, 'g': out}, ensure_ascii=False, separators=(',', ':'))
    p = os.path.join(pub_dir, 'data', 'ghist.js')
    with open(p, 'w', encoding='utf-8') as f:
        f.write(js)
    return kept, len(js.encode('utf-8'))


def main():
    pub = sys.argv[1] if len(sys.argv) > 1 else PUBLISH_DIR
    n, size = build(pub)
    print('帮派历史：%d 个帮派 / %d 天 / %.0f KB' % (n, len(load_days(pub)), size / 1024))


if __name__ == '__main__':
    main()
