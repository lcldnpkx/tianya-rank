#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全服功力榜 · 数据同步脚本
==========================
抓取全服（6 大区 / 17 服）的功力榜 + 帮派榜 + 每个角色的成长曲线，
按服务器拆分为多个数据文件，供主页面按需加载。

产物：
  publish/rank.html           榜单页（骨架，不含数据）
  publish/index.html          导航首页（home.html 副本）
  publish/data/servers.js     服务器清单 + 全局日期表
  publish/data/s-<id>.js      各服务器数据

用法：
  python3 update.py             全量更新（含全部曲线，约 5-8 分钟）
  python3 update.py --no-hist   跳过曲线抓取（约 1 分钟）
  python3 update.py --dry-run   只抓取统计，不写文件

数据源：rank.qquu.chat（抓自天涯明月刀 OL 官方名人堂）
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor

# ---------------- 配置 ----------------
API = 'https://rank.qquu.chat/api/fullserver'
BASE = os.path.dirname(os.path.abspath(__file__))

TEMPLATE = os.path.join(BASE, 'template.html')            # 主页面模板
# 输出目录：默认写本机发布目录；跑 GitHub Actions 时用 RANK_OUT=./public 覆盖
PUBLISH_DIR = os.environ.get('RANK_OUT') or \
    '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d4b-adc287da0000/publish'
# 额外保留一份单文件副本（仅本机需要；CI 上留空则不写）
OUT_LOCAL = os.environ.get('RANK_LOCAL', '/workspace/全服功力榜.html')

HIST_WORKERS = 6          # 曲线抓取并发。数据源不支持高并发（实测并发 12 会全部失败），勿调高
ROLE_PAGE_SIZE = 200

# 不采集的大区（按官方大区名精确匹配）。想恢复就把名字从这里删掉，下次运行自动补回来。
EXCLUDE_REGIONS = {'天下无双'}
# 按服务器 id 精确排除（留空即可；一般用大区排除更省事）
EXCLUDE_SERVERS = set()

UA = 'Mozilla/5.0 (compatible; quanserver-rank-sync/2.0)'


# ---------------- 基础请求 ----------------
def fetch(url, tries=3, timeout=30):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:  # noqa: BLE001
            last = e
            if i < tries - 1:
                time.sleep(1.5 * (i + 1))
    raise RuntimeError('请求失败 %s: %s' % (url[:110], last))


# ---------------- 抓取 ----------------
def fetch_all_roles():
    """分页抓取全服所有角色。"""
    items, seen = [], set()
    page = 1
    while True:
        d = fetch('%s/roles?page=%d&pageSize=%d' % (API, page, ROLE_PAGE_SIZE))
        batch = d.get('items') or []
        for it in batch:
            k = it.get('key')
            if k and k not in seen:
                seen.add(k)
                items.append(it)
        total = d.get('total') or 0
        if not batch or page * ROLE_PAGE_SIZE >= total or page > 400:
            break
        page += 1
        time.sleep(0.12)
    items.sort(key=lambda x: (x.get('rank') if x.get('rank') is not None else 10 ** 9))
    return items


def fetch_guilds(server, server_id=None):
    """某服的帮派榜（分页取全）。

    ⚠️ 数据源的 server 参数是按「服务器名」匹配的，**同名服务器会混在一起返回**：
    例如「白玉京」同时存在于大地飞鹰(2017) 和天下无双(2101)，按名字查会拿到
    两服共 487 个帮派。所以必须再用每条记录自带的 serverId 过滤一次，
    否则会串服（同一帮派被写进两个服务器、大区榜里出现两条同名帮派）。
    """
    out, seen = [], set()
    page = 1
    try:
        while True:
            d = fetch('%s/guilds?page=%d&pageSize=200&server=%s'
                      % (API, page, quote(server, safe='')))
            batch = d.get('items') or []
            for x in batch:
                if server_id and str(x.get('serverId') or '') != str(server_id):
                    continue                      # 同名服务器的数据，丢掉
                k = x.get('key') or x.get('guild')
                if k and k not in seen:
                    seen.add(k)
                    out.append(x)
            total = d.get('total') or 0           # 注意：total 是含同名服的混合总数
            if not batch or page * 200 >= total or page > 20:
                break
            page += 1
            time.sleep(0.12)
    except Exception:  # noqa: BLE001
        pass
    return out


def fetch_histories(keys, workers=HIST_WORKERS):
    """并发抓取每个角色的成长曲线；单个失败不影响整体。"""
    out = {}
    total = len(keys)

    def one(k):
        try:
            url = '%s/history?key=%s' % (API, quote(k, safe=''))
            d = fetch(url, tries=2, timeout=25)
            return k, (d.get('points') or [])
        except Exception:  # noqa: BLE001
            return k, None

    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for k, pts in ex.map(one, keys):
            done += 1
            if pts:
                out[k] = pts
            if done % 3000 == 0:
                print('  [hist] %d/%d（已用 %.0fs）' % (done, total, time.time() - t0), file=sys.stderr)
    return out


# ---------------- 字段精简 ----------------
# 人工修正表：数据源（官方名人堂）对部分号隐藏了名字/功力，或抓取滞后。
# 这里用玩家提供的游戏内实时截图修正，键为角色 key（服务器id|名字 或 隐藏名占位 key）。
# 文件不存在时跳过。每次 update.py 运行都会套用，不会被每日抓取冲掉。
OVERRIDE_FILE = os.path.join(BASE, 'role_overrides.json')


def load_overrides():
    if not os.path.exists(OVERRIDE_FILE):
        return {}
    try:
        with open(OVERRIDE_FILE, encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception as e:  # noqa: BLE001
        print('  [override] 读取失败，忽略: %s' % e, file=sys.stderr)
        return {}


def apply_overrides(roles):
    """套用人工修正。

    只改「名字」和「帮派归属」两类，**绝不改功力**——帮派总功力是官方口径，
    跟着改动会让帮派数据整体失真。修正过的行带 gu（名字为推断）/ gg（帮派为推断）标记，
    前端会显示成「名字 + 估」，鼠标悬停说明这是玩家截图比对得出的推断值。
    """
    ov = load_overrides()
    if not ov:
        return roles
    n_hit = 0
    for r in roles:
        o = ov.get(r.get('key') or '')
        if not o:
            continue
        n_hit += 1
        if o.get('n'):
            r['name'] = o['n']
            r['nameHidden'] = False
            r['guessName'] = True
        if o.get('g'):
            r['guild'] = o['g']
            r['guildHidden'] = False
            r['guessGuild'] = True
    print('  [override] 套用人工修正 %d 条（共 %d 条规则）' % (n_hit, len(ov)), file=sys.stderr)
    return roles


def slim_role(i):
    return {
        'k': i.get('key'),
        'r': i.get('rank'),
        'ro': i.get('rankOfficial'),
        'n': i.get('name'),
        'nh': i.get('nameHidden', False),
        'gu': i.get('guessName', False),        # 名字为推断（玩家截图比对）
        'fn': i.get('formerNames') or [],
        'm': i.get('menpai'),
        'g': i.get('guild') or '',
        'gh': i.get('guildHidden', False),
        'gg': i.get('guessGuild', False),       # 帮派为推断
        'p': i.get('power'),
        'ph': i.get('powerHidden', False),
        'pr': i.get('powerRange'),
        'sig': i.get('signature') or '',
        'rm': i.get('rankInMenpai'),
        't': i.get('tier'),
        'rid': i.get('serverId'),   # 分组用，输出时会移除
    }


def slim_guild(x):
    """帮派榜字段。

    口径以**官方榜**为准（官方帮派榜 = 前 80 名成员功力之和，平均值 = 该值 ÷ 80），
    因为本站只收录了「榜上有名的成员」，自算口径会随收录完整度浮动，
    越小的帮派偏差越大（实测可达 30%）。官方缺失时才退回自算值。
    """
    return {
        'g': x.get('guild'),
        'tm': x.get('trackedMembers'),          # 上榜成员数（非帮派真实人数）
        'hpm': x.get('hiddenPowerMembers', 0),
        # —— 官方口径（优先）——
        'off': bool(x.get('hasOfficial')),
        'ov': x.get('officialValue'),           # 官方帮派功力（前80之和）
        'oa': x.get('average'),                 # 官方平均值 = ov / 80
        'ogr': x.get('officialGlobalRank'),
        # —— 收录自算（官方缺失时兜底）——
        't80': x.get('top80Power'),
        'a80': x.get('top80Average'),
        'hp': x.get('trackedPower'),
        'ld': x.get('leader') or '',
        # 每日变化：[[日期MM-DD, 总变化, 留守增长, 走人数, 来人数], ...]
        'f': pack_flow(x.get('top80Flow') or []),
    }


def pack_flow(flow):
    """把帮派每日流动压成紧凑数组。

    delta      = 当日总变化（含成员进出）
    stayDelta  = 仅留守成员的功力增长（剔除人员变动）
    两者之差就是人员进出带来的净影响。
    """
    out = []
    for x in flow:
        to = (x.get('to') or '')
        if not to:
            continue
        out.append([
            to[5:],                       # MM-DD
            x.get('delta') or 0,
            x.get('stayDelta') or 0,
            x.get('outCount') or 0,
            x.get('inCount') or 0,
        ])
    return out


def attach_power_estimate(roles):
    """隐藏功力的角色：取上下相邻公开功力的平均作为估算值 pe。"""
    for r in roles:
        r['pe'] = None
        if not r.get('ph'):
            continue
        pr = r.get('pr') or {}
        lo, hi = pr.get('lo'), pr.get('hi')
        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
            r['pe'] = int(round((lo + hi) / 2.0))

    missing = [r for r in roles if r.get('ph') and not r.get('pe') and r.get('r')]
    if missing:
        pub = sorted((r['r'], r['p']) for r in roles
                     if r.get('p') and not r.get('ph') and r.get('r'))
        for r in missing:
            R = r['r']
            above = [p for (rk, p) in pub if rk < R]
            below = [p for (rk, p) in pub if rk > R]
            if above and below:
                r['pe'] = int(round((above[-1] + below[0]) / 2.0))
    return roles


# ---------------- 曲线压缩 ----------------
def collect_days(hist):
    return sorted({p.get('date') for pts in hist.values() for p in pts if p.get('date')})


def pack_history(pts, day_idx):
    """把某角色的曲线压成紧凑数组。

    格式：[startIdx, [power, rank], ...]
      - 断点用 [-1, 跳过天数] 表示
      - power 为 null 表示那天只有名次（隐藏功力的角色）
    """
    pts = [p for p in pts if p.get('date')]
    if len(pts) < 2:
        return None
    seq = []
    prev = None
    for p in pts:
        i = day_idx.get(p.get('date'))
        if i is None:
            continue
        if prev is not None and i != prev + 1:
            seq.append([-1, i - prev])
        seq.append([p.get('power'), p.get('rank') or 0])
        prev = i
    if len(seq) < 2:
        return None
    return [day_idx[pts[0]['date']]] + seq


def update_guild_history(pub_dir, guilds_raw, snapshot, exclude_rids=()):
    """把当天各帮派的功力快照追加进自建历史，长期累积。

    数据源自带的 flow 只有最近 5 天（滚动窗口），本表每天记一笔，
    时间久了就能看到跨月的帮派成长曲线。
    产物：data/ghist.js
        window.__GHIST = { days: ['2026-10-16', ...], g: { 帮派key: [功力, 功力, ...] } }
    """
    path = os.path.join(pub_dir, 'data', 'ghist.js')
    hist = {'days': [], 'g': {}}
    if os.path.exists(path):
        try:
            t = open(path, encoding='utf-8').read()
            m = re.search(r'window\.__GHIST\s*=\s*(\{.*\});', t, re.DOTALL)
            if m:
                hist = json.loads(m.group(1))
        except Exception:  # noqa: BLE001
            hist = {'days': [], 'g': {}}

    days = hist.setdefault('days', [])
    if snapshot and snapshot not in days:
        days.append(snapshot)
        days.sort()
    gi = {d: i for i, d in enumerate(days)}
    idx = gi.get(snapshot)
    if idx is None:
        return 0

    gmap = hist.setdefault('g', {})
    if exclude_rids:                       # 清掉已排除大区的历史帮派
        for k in [k for k in gmap if k.split('|', 1)[0] in exclude_rids]:
            gmap.pop(k, None)
    added = 0
    for x in guilds_raw:
        key = x.get('key')
        # 与榜单口径一致：官方帮派功力优先，官方未收录时退回前80之和
        val = x.get('officialValue')
        if val is None:
            val = x.get('top80Power')
        if not key or val is None:
            continue
        arr = gmap.setdefault(key, [])
        while len(arr) < len(days):        # 与 days 对齐，缺的补 null
            arr.append(None)
        if arr[idx] != val:
            arr[idx] = val
            added += 1

    js = 'window.__GHIST=%s;' % json.dumps(hist, ensure_ascii=False, separators=(',', ':'))
    write_file(path, js)
    return added


# ---------------- 输出 ----------------
def fetch_guild_detail(key):
    """单帮派详情。返回精简后的 dict，失败返回 None。"""
    try:
        d = fetch('%s/guild?key=%s' % (API, quote(key, safe='')), tries=2, timeout=25)
    except Exception:  # noqa: BLE001
        return None
    g = d.get('guild')
    return slim_guild_detail(g) if g else None


def slim_guild_detail(g, cap=8):
    """精简帮派详情，控制在 1KB 以内。

    hf = top80Flow，前 80 名之和的逐日走势（含成员进出影响）
    rf = rosterFlow，逐日人员流动明细（入帮/新收录/退帮/掉出收录 + 名单）
    """
    def lst(a):
        return [[x.get('name'), x.get('power')] for x in (a or [])[:cap] if x.get('name')]

    hf = []
    for x in (g.get('top80Flow') or []):
        to = x.get('to') or ''
        if not to:
            continue
        hf.append([to[5:], x.get('curSum') or 0, x.get('delta') or 0,
                   x.get('stayDelta') or 0, x.get('outCount') or 0, x.get('inCount') or 0])

    rf = []
    for x in (g.get('rosterFlow') or []):
        to = x.get('to') or ''
        if not to:
            continue
        rf.append([to[5:], x.get('prevCount') or 0, x.get('curCount') or 0,
                   x.get('joinCount') or 0, x.get('freshCount') or 0,
                   x.get('leaveCount') or 0, x.get('dropCount') or 0,
                   x.get('joinPower') or 0, x.get('freshPower') or 0,
                   x.get('leavePower') or 0, x.get('dropPower') or 0,
                   lst(x.get('joinList')), lst(x.get('freshList')),
                   lst(x.get('leaveList')), lst(x.get('dropList'))])

    tm = g.get('topMember') or {}
    return {
        'ld': g.get('leader') or '',
        'ov': g.get('officialValue'),
        # 详情接口的 average 可能为空，按官方口径「前80之和 ÷ 80」兜底
        'oa': g.get('average') or (round(g['officialValue'] / 80)
                                   if g.get('officialValue') else None),
        'ogr': g.get('officialGlobalRank'),
        'orr': g.get('officialRegionRank'),
        'off': bool(g.get('hasOfficial')),
        'tm': g.get('trackedMembers') or 0,
        'hpm': g.get('hiddenPowerMembers') or 0,
        'pm': g.get('powerMembers') or 0,
        'tp': g.get('trackedPower') or 0,
        'vp': g.get('visiblePower') or 0,
        'he': g.get('hiddenPowerEst') or 0,
        't80': g.get('top80Power'),
        'a80': g.get('top80Average'),
        'cap': g.get('capturedAt') or '',
        'top': [tm.get('name'), tm.get('power'), tm.get('rank')] if tm.get('name') else None,
        'hf': hf,
        'rf': rf,
    }


def fetch_guild_details(raw_guilds, workers=HIST_WORKERS):
    """并发抓一批帮派的详情。返回 {帮派名: 详情}。"""
    out = {}

    def one(x):
        key = x.get('key')
        if not key:
            return None, None
        return x.get('guild'), fetch_guild_detail(key)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for name, det in ex.map(one, raw_guilds):
            if name and det:
                out[name] = det
    return out


def _bump(rmap, key, other, inn, inp, outn, outp):
    """把一条流动记进 raw_map[key][other]。"""
    if not key or not other:
        return
    arr = rmap.setdefault(key, {})
    cur = arr.get(other) or [0, 0, 0, 0]
    cur[0] += inn
    cur[1] += inp
    cur[2] += outn
    cur[3] += outp
    arr[other] = cur


def update_guild_relations(pub_dir, guilds_raw, exclude_rids=()):
    """累积帮派之间的人员流动关系（长期）。

    数据源的 rosterFlow 只有最近 5 天滚动窗口，所以本表按「日期」去重后
    逐步累积：每天只处理新出现的日期，历史不会丢。

    关键点：rosterFlow 的 joinList 带 from（来源帮派），据此可以一次算出
    两个方向——本帮从 A 流入，同时反推 A 流向本帮（数据源不提供退帮去向，
    只能靠对方帮派的入帮记录反推）。

    产物：data/grel.js
        window.__GREL = {
          days: ['2026-10-12', ...],          # 已处理过的日期
          r: { '2001|龙门神策营': [['2001|水意', inN, inP, outN, outP], ...] }
        }
    返回 (本次新增条数, 关系映射)
    """
    path = os.path.join(pub_dir, 'data', 'grel.js')
    rel = {'days': [], 'r': {}}
    if os.path.exists(path):
        try:
            t = open(path, encoding='utf-8').read()
            m = re.search(r'window\.__GREL\s*=\s*(\{.*\});', t, re.DOTALL)
            if m:
                rel = json.loads(m.group(1))
        except Exception:  # noqa: BLE001
            rel = {'days': [], 'r': {}}

    seen = set(rel.get('days') or [])
    raw_map = {}
    for k, v in (rel.get('r') or {}).items():
        if exclude_rids and k.split('|', 1)[0] in exclude_rids:
            continue                       # 已排除大区的历史，顺手清掉
        for row in v:
            if len(row) >= 5:
                raw_map.setdefault(k, {})[row[0]] = [row[1], row[2], row[3], row[4]]

    all_days = set()
    for d in guilds_raw:
        for day in (d.get('rosterFlow') or []):
            to = day.get('to') or ''
            if to:
                all_days.add(to)

    new_days = sorted(all_days - seen)
    if new_days:
        newset = set(new_days)
        for d in guilds_raw:
            gname = d.get('guild')
            sid = str(d.get('serverId') or '')
            gkey = d.get('key')
            if not gname or not sid or not gkey:
                continue
            for day in (d.get('rosterFlow') or []):
                if (day.get('to') or '') not in newset:
                    continue
                for j in (day.get('joinList') or []):
                    frm = (j.get('from') or '').strip()
                    if not frm or frm == gname:
                        continue
                    pw = j.get('power') or 0
                    fkey = sid + '|' + frm
                    _bump(raw_map, gkey, fkey, 1, pw, 0, 0)   # 本帮：从 fkey 流入
                    _bump(raw_map, fkey, gkey, 0, 0, 1, pw)   # 反推：fkey 流向本帮

    rel['days'] = sorted(seen | set(new_days))
    rel['r'] = {k: [[kk, vv[0], vv[1], vv[2], vv[3]] for kk, vv in v.items()]
                for k, v in raw_map.items()}

    write_file(path, 'window.__GREL=%s;' % json.dumps(rel, ensure_ascii=False,
                                                     separators=(',', ':')))
    return len(new_days), rel['r']


def apply_exclusion(items):
    """按大区 / 服务器 id 剔除不要的记录，返回 (保留项, 被剔除的服务器 id 集合)。

    数据源每条角色/帮派记录都带 region 与 serverId，按这两个字段过滤最准确
    —— 不能用服务器名（「白玉京」同名服分属两个大区）。
    """
    keep, dropped = [], set()
    for it in items:
        rid = str(it.get('serverId') or '')
        reg = it.get('region') or ''
        if reg in EXCLUDE_REGIONS or rid in EXCLUDE_SERVERS:
            if rid:
                dropped.add(rid)
            continue
        keep.append(it)
    return keep, dropped


def purge_excluded(pub_dir, exclude_rids):
    """删掉已排除服务器的单服数据 + 详情文件，避免聚合时又被读回去。"""
    if not exclude_rids:
        return 0
    n = 0
    for rid in exclude_rids:
        for pat in ('s-%s.js', 'gd-%s.js'):
            p = os.path.join(pub_dir, 'data', pat % rid)
            if os.path.exists(p):
                os.remove(p)
                n += 1
    return n


def write_file(path, text):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def main():
    dry = '--dry-run' in sys.argv
    no_hist = '--no-hist' in sys.argv
    no_gd = '--no-gd' in sys.argv
    agg_bytes = 0
    gd_total = 0
    t_start = time.time()

    if not os.path.exists(TEMPLATE):
        raise SystemExit('模板不存在: %s' % TEMPLATE)

    # 1) 元信息
    meta = fetch('%s/meta' % API)
    snapshot = meta.get('crawlDate') or ''
    print('  [meta] 快照日期 %s' % snapshot, file=sys.stderr)

    # 2) 全服角色
    print('  [roles] 抓取全服角色…', file=sys.stderr)
    roles_raw = fetch_all_roles()
    roles_raw, excluded_rids = apply_exclusion(roles_raw)
    roles_raw = apply_overrides(roles_raw)
    roles = [slim_role(i) for i in roles_raw]
    if excluded_rids:
        print('  [exclude] 已剔除大区 %s（服务器 id: %s）'
              % ('/'.join(sorted(EXCLUDE_REGIONS)) or '-', ','.join(sorted(excluded_rids))),
              file=sys.stderr)
    if not roles:
        raise SystemExit('抓取结果为空，放弃写入（避免清空页面）')

    # 数据量兜底：源站偶尔会抓挂，只吐出几百人。这种残缺数据不该覆盖线上的完整榜单。
    # 低于阈值直接失败退出，Actions 会标红、不部署，线上继续保留上一次的完整数据。
    # 确实要强行写入时加 --force。
    _floor = int(os.environ.get('MIN_ROLES') or 5000)
    if len(roles) < _floor and '--force' not in sys.argv:
        raise SystemExit(
            '抓到的角色只有 %d 个，低于安全线 %d —— 源站这次大概抓挂了。\n'
            '已放弃写入，线上保留上一次的数据。确认要强行更新请加 --force。'
            % (len(roles), _floor))
    print('  [roles] 共 %d 个角色' % len(roles), file=sys.stderr)
    attach_power_estimate(roles)

    # 3) 成长曲线
    hist, days = {}, []
    if no_hist:
        print('  [hist] 已跳过（--no-hist）', file=sys.stderr)
    else:
        print('  [hist] 抓取 %d 个角色的曲线…' % len(roles), file=sys.stderr)
        try:
            hist = fetch_histories([r['k'] for r in roles if r.get('k')])
            days = collect_days(hist)
            print('  [hist] 命中 %d / %d，日期共 %d 天' % (len(hist), len(roles), len(days)),
                  file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print('  [hist] 失败，本次跳过曲线: %s' % e, file=sys.stderr)

    day_idx = {d: i for i, d in enumerate(days)}

    # 4) 按服务器分组
    groups = {}
    for r in roles:
        rid = str(r.get('rid') or '')
        if rid:
            groups.setdefault(rid, []).append(r)

    # 5) 逐服产出数据文件
    if not dry:
        ndel = purge_excluded(PUBLISH_DIR, excluded_rids)
        if ndel:
            print('  [exclude] 删除 %d 个已排除服务器的旧数据文件' % ndel, file=sys.stderr)
    server_list = []
    all_guilds_raw = []          # 收集全部帮派原始记录，供自建历史与关系表使用
    gd_store = {}                # rid -> {帮派名: 详情}
    meta_by_id = {}
    for it in roles_raw:
        rid = str(it.get('serverId') or '')
        if rid and rid not in meta_by_id:
            meta_by_id[rid] = (it.get('server') or rid, it.get('region') or '')

    for rid, sroles in sorted(groups.items(), key=lambda x: -len(x[1])):
        sname, region = meta_by_id.get(rid, (rid, ''))
        for r in sroles:
            r.pop('rid', None)      # 服务器信息已在文件顶层，逐行不再重复

        for r in sroles:
            r['h'] = pack_history(hist.get(r.get('k')) or [], day_idx) if hist else None

        raw_g = fetch_guilds(sname, rid)
        all_guilds_raw.extend(raw_g)
        guilds = [slim_guild(x) for x in raw_g]

        payload = {
            'server': sname,
            'region': region,
            'snapshot': snapshot,
            'roles': sroles,
            'guilds': guilds,
        }
        js = ('window.__SRV_DATA=window.__SRV_DATA||{};window.__SRV_DATA[%s]=%s;' % (
            json.dumps(rid), json.dumps(payload, ensure_ascii=False, separators=(',', ':'))))

        n_hist = sum(1 for r in sroles if r.get('h'))
        server_list.append({
            'id': rid, 'name': sname, 'region': region,
            'n': len(sroles), 'g': len(guilds), 'h': n_hist,
        })

        if not dry:
            write_file(os.path.join(PUBLISH_DIR, 'data', 's-%s.js' % rid), js)

        # 帮派详情：先抓下来放内存，等关系表算完再统一写（要合并 rel 字段）
        gd_bytes = 0
        if not no_gd and raw_g:
            det = fetch_guild_details(raw_g)
            if det:
                gd_store[rid] = det
                gd_bytes = len(json.dumps(det, ensure_ascii=False,
                                          separators=(',', ':')).encode('utf-8'))

        print('  [out] %-12s %5d 人 / %3d 帮派 / %5d 条曲线 / 详情 %5.0f KB → %6.0f KB' % (
            sname, len(sroles), len(guilds), n_hist, gd_bytes / 1024,
            (len(js.encode('utf-8')) + gd_bytes) / 1024),
            file=sys.stderr)

    # 6) 服务器清单 + 日期表 + 主页面
    server_list.sort(key=lambda s: (s['region'], -s['n']))
    meta_js = 'window.__SRV_LIST=%s;window.__SRV_DAYS=%s;window.__SRV_META=%s;' % (
        json.dumps(server_list, ensure_ascii=False, separators=(',', ':')),
        json.dumps(days, ensure_ascii=False, separators=(',', ':')),
        json.dumps({'snapshot': snapshot, 'total': len(roles),
                    'servers': len(server_list),
                    'regions': len({s['region'] for s in server_list})},
                   ensure_ascii=False, separators=(',', ':')),
    )
    if not dry:
        write_file(os.path.join(PUBLISH_DIR, 'data', 'servers.js'), meta_js)
        tpl = open(TEMPLATE, encoding='utf-8').read()
        # 快照日期写进 data/*.js 的 ?v=，每天换 URL，避免浏览器/边缘缓存住旧榜单
        tpl = tpl.replace('__DATA_VER__', snapshot or str(int(time.time())))
        # 榜单页 -> rank.html
        write_file(os.path.join(PUBLISH_DIR, 'rank.html'), tpl)
        # 导航首页 -> index.html（根路径即大厅），同时保留 home.html 别名
        import shutil as _shutil
        _home = os.path.join(BASE, 'home.html')
        if os.path.exists(_home):
            _shutil.copyfile(_home, os.path.join(PUBLISH_DIR, 'index.html'))
            _shutil.copyfile(_home, os.path.join(PUBLISH_DIR, 'home.html'))
        # 工具页（染色/砭石/衍心/图鉴/文心/灵势）整目录搬过去，缺了会整片 404
        _tools = os.path.join(BASE, 'tools')
        if os.path.isdir(_tools):
            _dst = os.path.join(PUBLISH_DIR, 'tools')
            if os.path.isdir(_dst):
                _shutil.rmtree(_dst)
            _shutil.copytree(_tools, _dst)
            print('  [tools] 已复制 %d 个文件' % sum(len(f) for _, _, f in os.walk(_dst)),
                  file=sys.stderr)
        else:
            print('  [tools] 警告：源目录不存在 %s' % _tools, file=sys.stderr)
        if OUT_LOCAL:
            write_file(OUT_LOCAL, tpl)

        # 6.5) 帮派功力历史：用角色 30 天曲线按帮派聚合回溯（数据源的帮派 flow 只有 7 天）
        try:
            import gen_ghist
            n_g, sz = gen_ghist.build(PUBLISH_DIR)
            print('  [ghist] %d 个帮派 × %d 天，%.0f KB'
                  % (n_g, len(days), sz / 1024), file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print('  [ghist] 生成失败: %s' % e, file=sys.stderr)

        # 6.6) 帮派间人员流动关系（长期累积），并合并进各服详情
        try:
            n_new, rel_map = update_guild_relations(PUBLISH_DIR, all_guilds_raw, excluded_rids)
            print('  [grel] 新增 %d 天流动关系 / 累计 %d 个帮派有对外关系'
                  % (n_new, len(rel_map)), file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print('  [grel] 关系表生成失败: %s' % e, file=sys.stderr)
            rel_map = {}

        # 6.7) 写各服帮派详情（合并关系 + 剪枝）
        gd_total = 0
        for rid, det in gd_store.items():
            for gname, d in det.items():
                rows = rel_map.get('%s|%s' % (rid, gname)) or []
                if rows:
                    slim = []
                    for r in rows:
                        other = r[0].split('|', 1)[-1]
                        if other and other != gname:
                            slim.append([other, r[1], r[2], r[3], r[4]])
                    # 按「往来规模」取前 12 个，控制体积
                    slim.sort(key=lambda x: -(x[1] + x[3] + x[2] + x[4]))
                    d['rel'] = slim[:12]
            gd_js = ('window.__GD=window.__GD||{};window.__GD[%s]=%s;' % (
                json.dumps(rid),
                json.dumps(det, ensure_ascii=False, separators=(',', ':'))))
            write_file(os.path.join(PUBLISH_DIR, 'data', 'gd-%s.js' % rid), gd_js)
            gd_total += len(gd_js.encode('utf-8'))
        print('  [gd] 写入 %d 个服务器的帮派详情，共 %.2f MB'
              % (len(gd_store), gd_total / 1024 / 1024), file=sys.stderr)

        # 7) 聚合视图：全区全服 + 各大区（供主页默认视图使用）
        try:
            import gen_agg
            agg = gen_agg.build(PUBLISH_DIR)
            for label, nr, ng, n in agg:
                print('  [agg] %-12s %7s 人 / %5s 帮派 → %7.0f KB' % (
                    label, format(nr, ',') if nr else '-',
                    format(ng, ',') if ng else '-', n / 1024), file=sys.stderr)
            agg_bytes = sum(x[3] for x in agg)
        except Exception as e:  # noqa: BLE001
            print('  [agg] 生成失败（不影响单服视图）: %s' % e, file=sys.stderr)
            agg_bytes = 0

    result = {
        'ok': True,
        'snapshot': snapshot,
        'roles': len(roles),
        'servers': len(server_list),
        'histRoles': sum(1 for r in roles if r.get('h')),
        'histDays': len(days),
        'aggBytes': agg_bytes if not dry else 0,
        'gdBytes': gd_total if not dry else 0,
        'wrote': not dry,
        'seconds': round(time.time() - t_start, 1),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)
