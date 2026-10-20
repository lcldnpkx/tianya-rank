#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
聚合数据生成
============
把各服务器数据合并成「全区全服」与「各大区」两份聚合榜单。

体积是首要约束（全服 3.3 万人），所以用**定长数组 + 字典索引**编码，
而不是带键名的对象——实测可省 45%：

    对象格式：4.91 MB
    数组格式：2.89 MB

产物（写入发布目录 data/）：
  agg-meta.js      服务器 / 门派字典 + 快照信息
  agg-all.js       全区全服（角色 + 帮派）
  agg-r-<aid>.js   各大区

用法：python3 gen_agg.py            # 从已有的 data/s-*.js 生成
      （update.py 主流程内部也会调用本模块的函数）
"""

import glob
import json
import os
import re
import sys

PUBLISH_DIR = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d4b-adc287da0000/publish'

# 与 update.py 保持一致：这些大区不参与任何榜单（含全区全服）
EXCLUDE_REGIONS = {'天下无双'}

# 角色数组的字段顺序（前端据此解码）
ROLE_FIELDS = [
    'r',    # 0 名次
    'ro',   # 1 官方在榜
    'n',    # 2 角色名
    'nh',   # 3 名字隐藏
    'fn',   # 4 曾用名
    'si',   # 5 服务器索引
    'mi',   # 6 门派索引
    'g',    # 7 帮派名
    'gh',   # 8 帮派隐藏
    'p',    # 9 功力
    'ph',   # 10 功力隐藏
    'pe',   # 11 估算功力
    'rm',   # 12 门派内名次
    't',    # 13 榜段
    'pr',   # 14 功力区间
]

GUILD_FIELDS = [
    'g',    # 0 帮派名
    'si',   # 1 服务器索引
    'tm',   # 2 上榜成员
    'ov',   # 3 官方帮派功力
    'oa',   # 4 官方平均功力
    't80',  # 5 自算前80总和
    'a80',  # 6 自算平均
    'hp',   # 7 自算总功力
    'ld',   # 8 盟主
    'off',  # 9 是否有官方数据
    'hpm',  # 10 隐藏功力成员数
    'f',    # 11 每日变化 [[MM-DD, delta, stayDelta, outN, inN], ...]
]


def load_servers(pub_dir):
    """读回各服数据文件。"""
    out = []
    for f in sorted(glob.glob(os.path.join(pub_dir, 'data', 's-*.js'))):
        t = open(f, encoding='utf-8').read()
        m = re.search(r'window\.__SRV_DATA\["(\d+)"\]\s*=\s*(\{.*\});\s*$', t, re.DOTALL)
        if not m:
            continue
        out.append((m.group(1), json.loads(m.group(2))))
    return out


def build(pub_dir):
    servers = [(rid, d) for rid, d in load_servers(pub_dir)
               if (d.get('region') or '其他') not in EXCLUDE_REGIONS]
    if not servers:
        raise SystemExit('没有找到任何 s-*.js 数据')

    srv_ids = sorted(rid for rid, _ in servers)
    srv_pos = {s: i for i, s in enumerate(srv_ids)}

    mp_names, mp_pos = [], {}

    def mi(name):
        if name not in mp_pos:
            mp_pos[name] = len(mp_names)
            mp_names.append(name)
        return mp_pos[name]

    def enc_role(r, si):
        return [
            r.get('r'),
            1 if r.get('ro') else 0,
            r.get('n'),
            1 if r.get('nh') else 0,
            r.get('fn') or [],
            si,
            mi(r.get('m') or '未知'),
            r.get('g') or '',
            1 if r.get('gh') else 0,
            r.get('p'),
            1 if r.get('ph') else 0,
            r.get('pe'),
            r.get('rm'),
            r.get('t'),
            r.get('pr'),
        ]

    def enc_guild(g, si):
        return [
            g.get('g'),
            si,
            g.get('tm') or 0,
            g.get('ov'),
            g.get('oa'),
            g.get('t80'),
            g.get('a80'),
            g.get('hp'),
            g.get('ld') or '',
            1 if g.get('off') else 0,
            g.get('hpm') or 0,
            g.get('f') or [],
        ]

    snapshot = ''
    all_roles, all_guilds = [], []
    by_region = {}

    for rid, d in servers:
        si = srv_pos[rid]
        snapshot = d.get('snapshot') or snapshot
        region = d.get('region') or '其他'
        reg = by_region.setdefault(region, {'roles': [], 'guilds': []})

        for r in d.get('roles') or []:
            e = enc_role(r, si)
            all_roles.append(e)
            reg['roles'].append(e)
        for g in d.get('guilds') or []:
            e = enc_guild(g, si)
            all_guilds.append(e)
            reg['guilds'].append(e)

    # 角色按名次、帮派按官方值（无则自算）排序
    all_roles.sort(key=lambda x: x[0] if x[0] is not None else 10 ** 9)
    for reg in by_region.values():
        reg['roles'].sort(key=lambda x: x[0] if x[0] is not None else 10 ** 9)

    def gkey(x):
        return -(x[3] if x[3] is not None else (x[5] or 0))

    all_guilds.sort(key=gkey)
    for reg in by_region.values():
        reg['guilds'].sort(key=gkey)

    def dump(path, var, obj):
        js = '%s=%s;' % (var, json.dumps(obj, ensure_ascii=False, separators=(',', ':')))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(js)
        return len(js.encode('utf-8'))

    data_dir = os.path.join(pub_dir, 'data')
    stats = []

    # 元信息：服务器与门派字典
    meta = {
        'servers': srv_ids,
        'menpai': mp_names,
        'snapshot': snapshot,
    }
    n = dump(os.path.join(data_dir, 'agg-meta.js'),
             'window.__AGG_META', meta)
    stats.append(('agg-meta', 0, 0, n))

    # 全区全服：拆成「首屏」+「其余」两段。
    # 国内访问 GitHub Pages 只有 20~60 KB/s，整包 2.7 MB 要 40 秒才出首屏；
    # 首屏只放前 HEAD_ROLES 名 / HEAD_GUILDS 个帮派，其余后台静默加载。
    HEAD_ROLES, HEAD_GUILDS = 2000, 300
    n = dump(os.path.join(data_dir, 'agg-all.js'), 'window.__AGG_ALL', {
        'label': '全区全服',
        'kind': 'all',
        'partial': 1 if len(all_roles) > HEAD_ROLES or len(all_guilds) > HEAD_GUILDS else 0,
        'totalRoles': len(all_roles),
        'totalGuilds': len(all_guilds),
        'roles': all_roles[:HEAD_ROLES],
        'guilds': all_guilds[:HEAD_GUILDS],
    })
    stats.append(('全区全服(首屏)', min(len(all_roles), HEAD_ROLES),
                  min(len(all_guilds), HEAD_GUILDS), n))

    n_rest = dump(os.path.join(data_dir, 'agg-all-rest.js'), 'window.__AGG_ALL_REST', {
        'roles': all_roles[HEAD_ROLES:],
        'guilds': all_guilds[HEAD_GUILDS:],
    })
    stats.append(('全区全服(其余)', max(0, len(all_roles) - HEAD_ROLES),
                  max(0, len(all_guilds) - HEAD_GUILDS), n_rest))

    # 各大区
    for region, reg in sorted(by_region.items(), key=lambda x: -len(x[1]['roles'])):
        aid = ''
        for rid, d in servers:
            if (d.get('region') or '其他') == region:
                aid = rid[:2]
                break
        key = 'r-%s' % aid
        n = dump(os.path.join(data_dir, 'agg-%s.js' % key),
                 'window.__AGG_%s' % key.replace('-', '_').upper(), {
            'label': region,
            'kind': 'region',
            'roles': reg['roles'],
            'guilds': reg['guilds'],
        })
        stats.append((region, len(reg['roles']), len(reg['guilds']), n))

    # 可选：清理旧的聚合文件
    keep = {'agg-meta.js', 'agg-all.js', 'agg-all-rest.js'} | {'agg-r-%s.js' % s[:2] for s in srv_ids}
    for f in glob.glob(os.path.join(data_dir, 'agg-*.js')):
        if os.path.basename(f) not in keep:
            os.remove(f)

    return stats


def main():
    pub = sys.argv[1] if len(sys.argv) > 1 else PUBLISH_DIR
    stats = build(pub)
    total = 0
    for label, nr, ng, n in stats:
        total += n
        print('  %-12s 角色 %6s  帮派 %5s  → %7.0f KB' % (
            label, format(nr, ',') if nr else '-', format(ng, ',') if ng else '-', n / 1024))
    print('\n聚合数据合计 %.2f MB' % (total / 1048576))


if __name__ == '__main__':
    main()
