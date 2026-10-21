/* ============================================================
   彼岸花功力榜 · 交互逻辑
   ============================================================ */
(function () {
  'use strict';

  // 数据版本号（构建时替换为快照日期）。给所有 data/*.js 带上 ?v=，
  // 否则浏览器/边缘节点会一直用缓存里的旧榜单——每天更新了也看不到。
  var DATA_VER = '__DATA_VER__';

  // 服务器清单 / 全局日期表 / 总览统计 由 data/servers.js 提供
  var SRV_LIST = window.__SRV_LIST || [];
  var HD = window.__SRV_DAYS || [];
  var META = window.__SRV_META || {};
  // 注意：各服数据是动态 <script> 载入的，必须每次现取 window.__SRV_DATA，
  // 不能在启动时缓存引用，否则动态挂上去的数据读不到。
  function store() { return window.__SRV_DATA || {}; }

  // 服务器 id → 服名（聚合数据里只存 id 索引）
  var SRV_NAME = {};
  SRV_LIST.forEach(function (s) { SRV_NAME[s.id] = s.name; });

  // 聚合视图（全区全服 / 各大区）——数据由 data/agg-*.js 按需载入
  var AGG_META = null;
  var AGG_CACHE = {};
  var VIEWS = [];

  var DB = null;        // 当前服务器的数据
  var ROLES = [];
  var GUILDS = [];

  var MENPAI_ORDER = ['真武','太白','神威','丐帮','唐门','五毒','少林','天香','神刀','移花','从龙','雪衣','长生剑','万象'];

  var state = {
    view: '',
    board: 'power',
    q: '',
    menpai: '',
    guild: '',
    tier: '',
    measure: 'hp',
    sort: 'rank',
    page: 1,
    pageSize: 30
  };

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  };
  // 大数值量级化：亿 / 万，避免小服显示成「0亿」
  var bigNum = function (v) {
    v = v || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(v >= 1e9 ? 0 : 1) + '亿';
    if (v >= 1e4) return Math.round(v / 1e4) + '万';
    return fmt(v);
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // 隐藏功力的角色：用「上一位 + 下一位公开功力」的平均值显示（pe 由数据层算好）
  var powerHtml = function (r) {
    if (!r.ph) {
      return r.p ? '<span class="pw">' + fmt(r.p) + '</span>'
                 : '<span class="pw hidden">—</span>';
    }
    if (r.pe) {
      return '<span class="pw est" title="估算值：取上下相邻名次公开功力的平均，非官方数据">≈' +
             fmt(r.pe) + '<i class="est-tag">估</i></span>';
    }
    return '<span class="pw hidden">隐藏未公开</span>';
  };
  var powerText = function (r) {
    if (!r.ph) return r.p ? fmt(r.p) : '—';
    return r.pe ? '≈' + fmt(r.pe) + '(估算)' : '隐藏';
  };

  /* ---------- 派生数据（切换服务器时重算） ---------- */
  var guildMemberCount = {};
  var menpaiCount = {};
  var GUILD_TOP = [];
  var maxPower = 0;

  var IS_AGG = false;

  function recomputeDerived() {
    ROLES.forEach(function (r, i) {
      r._i = i;   // 每行一个稳定索引，用于点击定位（聚合数据没有 key）
      r._search = (r.n + ' ' + (r.fn || []).join(' ') + ' ' + r.g + ' ' + r.m).toLowerCase();
    });
    guildMemberCount = {};
    menpaiCount = {};
    maxPower = 0;
    ROLES.forEach(function (r) {
      if (r.g) guildMemberCount[r.g] = (guildMemberCount[r.g] || 0) + 1;
      menpaiCount[r.m] = (menpaiCount[r.m] || 0) + 1;
      if (r.p && r.p > maxPower) maxPower = r.p;
    });
    GUILD_TOP = Object.keys(guildMemberCount)
      .sort(function (a, b) { return guildMemberCount[b] - guildMemberCount[a]; })
      .slice(0, 24);

    GUILDS.forEach(function (g, i) {
      g._gi = i;
      // 最近一天的功力变化：f = [[MM-DD, 总变化, 留守增长, 走人数, 来人数], ...]
      var f = g.f || [];
      g._d = f.length ? f[f.length - 1] : null;
      g._d0 = g._d ? g._d[1] : null;
    });
  }

  /* ---------- 顶部数值条 ---------- */
  function renderStats() {
    var withPower = ROLES.filter(function (r) { return r.p; }).length;
    var official = ROLES.filter(function (r) { return r.ro; }).length;
    var totalPower = ROLES.reduce(function (s, r) { return s + (r.p || 0); }, 0);
    var stats = [
      { b: fmt(ROLES.length), s: '收录角色' },
      { b: fmt(withPower), s: '公开功力' },
      { b: fmt(official), s: '官方在榜' },
      { b: fmt(Object.keys(guildMemberCount).length), s: '帮派' },
      { b: MENPAI_ORDER.filter(function (m) { return menpaiCount[m]; }).length, s: '门派' },
      { b: bigNum(totalPower), s: '收录总功力' }
    ];
    $('statStrip').innerHTML = stats.map(function (x) {
      return '<div class="stat"><b>' + x.b + '</b><span>' + x.s + '</span></div>';
    }).join('');
  }

  /* ---------- 前三甲 ---------- */
  function renderPodium() {
    var top3 = ROLES.slice().sort(function (a, b) {
      var ra = a.ro ? a.r : 1e9, rb = b.ro ? b.r : 1e9;
      return ra - rb;
    }).slice(0, 3);
    $('podium').innerHTML = top3.map(function (r, i) {
      var pos = i + 1;
      var power = powerHtml(r);
      var guild = r.g ? esc(r.g) : (r.gh ? '帮派隐藏' : '无帮派');
      // 跨服视图（全区 / 大区 / 多服对比）要标出服务器，否则看不出是哪个服的人
      var svTag = (IS_AGG && r.sv) ? '<span class="pod-tag pod-sv">' + esc(r.sv) + '</span>' : '';
      return '<li class="pod" data-pos="' + pos + '" data-idx="' + r._i + '">' +
        '<div class="pod-crown">TOP ' + pos + '</div>' +
        '<div class="pod-rank">' + pos + '</div>' +
        '<p class="pod-name' + (r.nh ? ' is-hidden' : '') + '">' + esc(r.n) + '</p>' +
        '<div class="pod-meta">' +
          svTag +
          '<span class="pod-tag">' + esc(r.m) + '</span>' +
          '<span class="pod-tag">' + guild + '</span>' +
        '</div>' +
        '<div class="pod-power">' + power + '<small>' + (r.ro ? '官方名次 ' + r.r : '预估名次 ~' + r.r) + '</small></div>' +
        '</li>';
    }).join('');
  }

  /* ---------- 筛选 chips ---------- */
  function renderChips() {
    var mp = MENPAI_ORDER.filter(function (m) { return menpaiCount[m]; });
    $('menpaiChips').innerHTML = chip('menpai', '', '全部门派', ROLES.length) +
      mp.map(function (m) { return chip('menpai', m, m, menpaiCount[m]); }).join('');

    $('guildChips').innerHTML = chip('guild', '', '全部帮派', ROLES.filter(function (r) { return r.g; }).length) +
      GUILD_TOP.map(function (g) { return chip('guild', g, g, guildMemberCount[g]); }).join('');

    var tiers = [
      ['', '全部'], ['top10', '十强'], ['top100', '百强'], ['top500', '五百强'], ['extended', '扩容收录']
    ];
    var tc = {};
    ROLES.forEach(function (r) { tc[r.t] = (tc[r.t] || 0) + 1; });
    $('tierChips').innerHTML = tiers.map(function (t) {
      var n = t[0] ? (tc[t[0]] || 0) : ROLES.length;
      return chip('tier', t[0], t[1], n);
    }).join('');

    var mc = $('measureChips');
    if (mc) mc.innerHTML = '';
  }

  function chip(axis, val, label, n) {
    var active = state[axis] === val ? ' is-active' : '';
    var num = n === undefined ? '' : '<span class="chip-n">' + n + '</span>';
    return '<button type="button" class="chip' + active + '" data-axis="' + axis + '" data-val="' + esc(val) + '">' +
      esc(label) + num + '</button>';
  }

  /* ---------- 排序 / 每页 ---------- */
  function renderBars() {
    var sorts = state.board === 'power'
      ? [['rank', '名次'], ['power', '功力'], ['name', '角色名'], ['guild', '帮派']]
      : [['ov', '帮派功力'], ['hp', '总功力'], ['oa', '平均功力'], ['up', '日涨幅'],
         ['down', '日跌幅'], ['tm', '上榜成员'], ['name', '帮派名']];
    $('sortGroup').innerHTML = sorts.map(function (s) {
      return '<button type="button" class="bar-btn' + (state.sort === s[0] ? ' is-active' : '') +
        '" data-sort="' + s[0] + '">' + s[1] + '</button>';
    }).join('');
    $('pageSizeGroup').innerHTML = [20, 30, 50, 100].map(function (n) {
      return '<button type="button" class="bar-btn' + (state.pageSize === n ? ' is-active' : '') +
        '" data-size="' + n + '">' + n + '</button>';
    }).join('');
  }

  /* ---------- 角色筛选与排序 ---------- */
  function filterRoles() {
    var q = state.q.trim().toLowerCase();
    var list = ROLES.filter(function (r) {
      if (state.menpai && r.m !== state.menpai) return false;
      if (state.guild && r.g !== state.guild) return false;
      if (state.tier && r.t !== state.tier) return false;
      if (q && r._search.indexOf(q) === -1) return false;
      return true;
    });
    list.sort(function (a, b) {
      switch (state.sort) {
        case 'power':
          return (b.p || b.pe || 0) - (a.p || a.pe || 0);
        case 'name':
          return a.n.localeCompare(b.n, 'zh');
        case 'guild':
          return (a.g || '\uffff').localeCompare(b.g || '\uffff', 'zh') || a.r - b.r;
        default:
          return a.r - b.r;
      }
    });
    return list;
  }

  /* ---------- 帮派口径 ----------
     官方帮派榜：帮派功力 = 前 80 名成员功力之和；平均功力 = 该值 ÷ 80。
     本站只收录榜上有名的成员，自算会随收录完整度浮动（小帮派偏差可达 30%），
     所以**官方值优先**，官方榜没收录这个帮派时才退回自算值并标注。 */
  function guildOff(g) { return !!(g.off && g.ov !== null && g.ov !== undefined); }
  function guildPower(g) {
    return guildOff(g) ? g.ov : (g.t80 || 0);
  }
  function guildAvg(g) {
    if (guildOff(g)) return (g.oa !== null && g.oa !== undefined) ? g.oa : Math.round((g.ov || 0) / 80);
    return g.a80 || 0;
  }

  /* ---------- 帮派筛选与排序 ---------- */
  function filterGuilds() {
    var q = state.q.trim().toLowerCase();
    var list = GUILDS.filter(function (g) {
      if (q && (g.g + ' ' + g.ld).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    list.sort(function (a, b) {
      var k = state.sort;
      if (k === 'name') return a.g.localeCompare(b.g, 'zh');
      if (k === 'tm') return (b.tm || 0) - (a.tm || 0);
      if (k === 'hp') return (b.hp || 0) - (a.hp || 0);
      if (k === 'oa') return guildAvg(b) - guildAvg(a);
      if (k === 'up') return (b._d0 === null ? -1e18 : b._d0) - (a._d0 === null ? -1e18 : a._d0);
      if (k === 'down') return (a._d0 === null ? 1e18 : a._d0) - (b._d0 === null ? 1e18 : b._d0);
      return guildPower(b) - guildPower(a);
    });
    return list;
  }

  /* ---------- 渲染表格 ---------- */
  function renderTable() {
    var isPower = state.board === 'power';
    var row = $('tierRow');
    if (row) row.hidden = !isPower;

    var list = isPower ? filterRoles() : filterGuilds();
    var totalPages = Math.max(1, Math.ceil(list.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    var start = (state.page - 1) * state.pageSize;
    var pageList = list.slice(start, start + state.pageSize);

    if (isPower) {
      if (IS_AGG) {
        $('ledgerCols').innerHTML = '<col style="width:74px"><col><col style="width:100px"><col style="width:88px"><col style="width:168px"><col style="width:118px">';
        $('ledgerHead').innerHTML =
          '<th>名次</th><th>角色</th><th>服务器</th><th>门派</th><th>帮派</th><th class="num">功力</th>';
      } else {
        $('ledgerCols').innerHTML = '<col style="width:74px"><col><col style="width:90px"><col style="width:170px"><col style="width:120px">';
        $('ledgerHead').innerHTML =
          '<th>名次</th><th>角色</th><th>门派</th><th>帮派</th><th class="num">功力</th>';
      }
    } else {
      $('ledgerCols').innerHTML = '<col style="width:66px"><col><col style="width:82px"><col style="width:108px"><col style="width:108px"><col style="width:94px"><col style="width:102px"><col style="width:96px">';
      $('ledgerHead').innerHTML =
        '<th>排行</th><th>帮派</th><th class="num">上榜成员</th><th class="num">总功力</th>' +
        '<th class="num">帮派功力</th><th class="num">平均功力</th><th class="num">日变化</th>' +
        '<th class="ctr">盟主</th>';
    }

    if (!pageList.length) {
      $('ledgerBody').innerHTML = '';
      $('empty').hidden = false;
      $('empty').textContent = isPower ? '没有找到符合条件的角色' : '没有找到符合条件的帮派';
    } else {
      $('empty').hidden = true;
      $('ledgerBody').innerHTML = isPower ? pageList.map(roleRow).join('') : pageList.map(guildRow).join('');
    }

    renderResultLine(list.length, start, pageList.length, isPower);
    renderPager(totalPages);
  }

  function roleRow(r) {
    var rk = start0rank(r);
    return '<tr data-idx="' + r._i + '">' +
      '<td class="rank-cell">' + rk + '</td>' +
      '<td>' +
        '<div class="role-name">' +
          '<span class="rn-text' + (r.nh ? ' is-hidden' : '') + '">' + esc(r.n) + '</span>' +
          (r.fn && r.fn.length ? '<span class="badge former">曾用名 ' + esc(r.fn.join(' / ')) + '</span>' : '') +
        '</div>' +
      '</td>' +
      (IS_AGG ? '<td><span class="srv-cell">' + esc(r.sv || '') + '</span></td>' : '') +
      '<td><span class="badge menpai">' + esc(r.m) + '</span></td>' +
      '<td><span class="guild-name">' + (r.g ? esc(r.g) : '<span class="guild-none">' + (r.gh ? '帮派隐藏' : '无帮派') + '</span>') + '</span></td>' +
      '<td class="num">' + powerCell(r) + '</td>' +
    '</tr>';
  }

  function guildDeltaCell(g) {
    if (g._d0 === null || g._d0 === undefined) return '<span class="guild-est">—</span>';
    var f = g._d, d = g._d0;
    var stay = f[2] || 0, outN = f[3] || 0, inN = f[4] || 0;
    var cls = d > 0 ? 'up' : (d < 0 ? 'down' : 'flat');
    // 悬停摊开：总变化含人员进出，留守增长才是「练功」的部分
    var tip = '总变化 ' + (d > 0 ? '+' : '') + fmt(d) + '（含成员进出）\n' +
              '留守增长 ' + (stay > 0 ? '+' : '') + fmt(stay) + '\n' +
              '走 ' + outN + ' 人 / 来 ' + inN + ' 人';
    return '<span class="ch-delta ' + cls + '" title="' + esc(tip) + '">' +
           (d > 0 ? '+' : '') + fmt(d) + '</span>';
  }

  function guildRow(g) {
    var off = guildOff(g);
    var pCell = off
      ? '<span class="pw">' + fmt(guildPower(g)) + '</span>'
      : '<span class="pw est">' + fmt(guildPower(g)) + '<i class="est-tag">估</i></span>';
    var aCell = off ? fmt(guildAvg(g)) : '<span class="guild-est">' + fmt(guildAvg(g)) + '</span>';
    var sub = '上榜 ' + (g.tm || 0) + ' 人' +
      (g.hpm ? ' · 含 ' + g.hpm + ' 名隐藏功力' : ' · 功力全公开') +
      (off ? '' : ' · 官方榜未收录，数值为本站推算');
    return '<tr data-guild="' + esc(g.g) + '" data-gidx="' + g._gi + '">' +
      '<td class="rank-cell"><span class="rk" data-rank="' + (state.page - 1) + '"></span></td>' +
      '<td><span class="rn-text">' + esc(g.g) + '</span>' +
        (IS_AGG && g.sv ? '<span class="badge srv-badge">' + esc(g.sv) + '</span>' : '') +
        '<span class="cell-sub">' + sub + '</span></td>' +
      '<td class="num">' + (g.tm || 0) + '</td>' +
      '<td class="num"><span class="pw dim">' + fmt(g.hp || 0) + '</span></td>' +
      '<td class="num">' + pCell + '</td>' +
      '<td class="num">' + aCell + '</td>' +
      '<td class="num">' + guildDeltaCell(g) + '</td>' +
      '<td class="ctr">' + (g.ld ? esc(g.ld) : '<span class="guild-none">未知</span>') + '</td>' +
    '</tr>';
  }

  var _rankSeq = 0;
  function start0rank(r) {
    var cls = 'rk';
    if (r.r === 1) cls += ' t3-1';
    else if (r.r === 2) cls += ' t3-2';
    else if (r.r === 3) cls += ' t3-3';
    else if (r.r <= 10) cls += ' t10';
    var pre = r.ro ? '' : '<span class="tilde">~</span>';
    return '<span class="' + cls + '">' + pre + r.r + '</span>';
  }

  function powerCell(r) {
    return powerHtml(r);
  }

  function renderResultLine(total, start, shown, isPower) {
    var unit = isPower ? '名角色' : '个帮派';
    var extra = '';
    if (isPower && (state.menpai || state.guild || state.tier || state.q)) extra = '（已筛选）';
    // 首屏只载入前 N 名时如实说明，避免用户以为榜单只有这么点人
    var loadingHint = (DB && DB.partial && isPower)
      ? ' · <span class="rest-hint">前 ' + fmt(DB.roles.length) + ' 名已就绪，完整榜单载入中…</span>' : '';
    $('resultLine').innerHTML = '共 <b>' + total + '</b> ' + unit + extra + loadingHint +
      (total ? ' · 当前显示第 ' + (start + 1) + '–' + (start + shown) + ' 条' : '');
  }

  /* ---------- 分页 ---------- */
  function renderPager(totalPages) {
    var p = state.page, out = [];
    var btn = function (label, page, dis, active, gap) {
      if (gap) return '<span class="pg gap">…</span>';
      return '<button type="button" class="pg' + (active ? ' is-active' : '') + '"' +
        (dis ? ' disabled' : '') + ' data-page="' + page + '">' + label + '</button>';
    };
    out.push(btn('‹', p - 1, p <= 1, false));
    var pages = [];
    for (var i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - p) <= 1) pages.push(i);
      else if (pages[pages.length - 1] !== 'gap') pages.push('gap');
    }
    pages.forEach(function (x) {
      if (x === 'gap') out.push(btn('', 0, false, false, true));
      else out.push(btn(x, x, false, x === p));
    });
    out.push(btn('›', p + 1, p >= totalPages, false));
    $('pager').innerHTML = out.join('');
  }

  /* ---------- 帮派榜行号修正 ---------- */
  function fixGuildRanks() {
    var rows = $('ledgerBody').querySelectorAll('tr');
    var base = (state.page - 1) * state.pageSize;
    rows.forEach(function (tr, i) {
      var el = tr.querySelector('.rk');
      if (el) {
        el.textContent = base + i + 1;
        el.classList.remove('t3-1', 't3-2', 't3-3', 't10');
        if (base + i === 0) el.classList.add('t3-1');
        else if (base + i === 1) el.classList.add('t3-2');
        else if (base + i === 2) el.classList.add('t3-3');
        else if (base + i < 10) el.classList.add('t10');
      }
    });
  }

  /* ---------- 功力成长曲线 ---------- */
  // 解码紧凑格式：r.h = [起始下标, [功力,名次], ..., [-1, 跳过的天数], ...]
  function parseHistory(r) {
    if (!r.h || r.h.length < 2) return null;
    var idx = r.h[0], out = [];
    for (var i = 1; i < r.h.length; i++) {
      var v = r.h[i];
      if (!v || v.length < 2) continue;
      if (v[0] === -1) { idx += (v[1] || 1); continue; }   // 断点/缺值：跳过若干天
      out.push({ date: HD[idx] || '', power: v[0], rank: v[1] || 0 });
      idx += 1;
    }
    return out.length >= 2 ? out : null;
  }

  function historyChart(r) {
    var pts = parseHistory(r);
    if (!pts) {
      var why;
      if (DB && DB.kind === 'agg') {
        why = '全服 / 大区视图为控制体积未载入成长曲线，<b>切换到该角色所属的服务器</b>即可查看。';
      } else if (r.nh) {
        why = '该角色隐藏了角色名，且没有可锚定的签名，本表无法追踪它的历史。';
      } else {
        why = '该角色暂无历史曲线：数据来源于 ' + esc(HD[0] || '—') +
              ' 开始，之后才上榜或改名重建的角色没有足够的数据点。';
      }
      return '<div class="dw-sec"><h4>功力成长曲线</h4><p class="dw-note">' + why + '</p></div>';
    }
    var f = pts[0], l = pts[pts.length - 1];
    // 隐藏功力的角色，历史里只有名次 → 改画名次曲线
    var hasPower = pts.some(function (p) { return p.power !== null && p.power !== undefined; });

    var W = 380, H = 168, pl = 52, pr = 14, pt = 14, pb = 26;
    var iw = W - pl - pr, ih = H - pt - pb;

    var vals = pts.map(function (p) { return hasPower ? p.power : p.rank; });
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
    if (mx === mn) { var bump = hasPower ? 100 : 1; mx += bump; mn -= bump; }
    var pad = (mx - mn) * 0.14; mn -= pad; mx += pad;

    var X = function (i) { return pl + (pts.length < 2 ? iw / 2 : iw * i / (pts.length - 1)); };
    var Y = function (v) {
      var t = (v - mn) / (mx - mn);
      return pt + ih * (hasPower ? (1 - t) : t);   // 功力越高越靠上；名次越小越靠上
    };
    var valOf = function (p) { return hasPower ? p.power : p.rank; };

    var grid = '';
    [0, 0.5, 1].forEach(function (t) {
      var v = mx - (mx - mn) * t, y = pt + ih * t;
      grid += '<line x1="' + pl + '" y1="' + y.toFixed(1) + '" x2="' + (pl + iw) + '" y2="' + y.toFixed(1) + '" class="ch-grid"/>' +
        '<text x="' + (pl - 6) + '" y="' + (y + 3.5).toFixed(1) + '" class="ch-ylab" text-anchor="end">' +
        (hasPower ? fmt(Math.round(v)) : Math.round(v)) + '</text>';
    });

    var line = pts.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(valOf(p)).toFixed(1); }).join(' ');
    var area = pl + ',' + (pt + ih) + ' ' + line + ' ' + (pl + iw) + ',' + (pt + ih);

    var step = pts.length > 32 ? Math.ceil(pts.length / 32) : 1;
    var dots = '';
    pts.forEach(function (p, i) {
      if (i % step !== 0 && i !== pts.length - 1) return;
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(valOf(p)).toFixed(1) + '" r="2.5" class="ch-dot"/>';
    });

    var xlab = '<text x="' + pl + '" y="' + (H - 8) + '" class="ch-xlab" text-anchor="start">' + esc((f.date || '').slice(5)) + '</text>' +
      '<text x="' + (pl + iw) + '" y="' + (H - 8) + '" class="ch-xlab" text-anchor="end">' + esc((l.date || '').slice(5)) + '</text>';

    // 指标：功力用增减值，名次用升降位数
    var metric;
    if (hasPower) {
      var d = l.power - f.power;
      metric = '<b class="ch-delta ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '+' : '') + fmt(d) + '</b>';
    } else {
      var dr = f.rank - l.rank;   // 正数 = 名次变小 = 上升
      metric = '<b class="ch-delta ' + (dr > 0 ? 'up' : dr < 0 ? 'down' : 'flat') + '">' +
        (dr === 0 ? '持平' : (dr > 0 ? '↑ ' + dr + ' 位' : '↓ ' + (-dr) + ' 位')) + '</b>';
    }

    var foot = hasPower
      ? '当前 <b>' + fmt(l.power) + '</b> 功力 · 名次 <b>' + l.rank + '</b>'
      : '该玩家隐藏了功力，走势改用 <b>名次</b> 呈现（名次越小越靠前） · 当前名次 <b>' + l.rank + '</b>';

    return '<div class="dw-sec">' +
      '<h4>' + (hasPower ? '功力成长曲线' : '名次变化曲线') + '</h4>' +
      '<div class="dw-chart-meta">' +
        '<span>' + esc(f.date) + ' → ' + esc(l.date) + '</span>' +
        '<span>' + pts.length + ' 个数据点</span>' +
        metric +
      '</div>' +
      '<svg class="dw-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + (hasPower ? '功力成长曲线' : '名次变化曲线') + '">' +
        '<defs><linearGradient id="chGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="rgba(255,46,77,.36)"/>' +
          '<stop offset="100%" stop-color="rgba(255,46,77,0)"/>' +
        '</linearGradient></defs>' +
        grid +
        '<polygon points="' + area + '" fill="url(#chGrad)"/>' +
        '<polyline points="' + line + '" class="ch-line"/>' +
        dots +
        '<circle cx="' + X(pts.length - 1).toFixed(1) + '" cy="' + Y(valOf(l)).toFixed(1) + '" r="4.2" class="ch-last"/>' +
        xlab +
      '</svg>' +
      '<p class="dw-chart-foot">' + foot + '</p>' +
      '</div>';
  }

  /* ---------- 详情抽屉 ---------- */
  function openRole(idx) {
    var r = ROLES[idx];
    if (!r) return;
    var maxRef = Math.max(maxPower, r.p || 0);
    var powerBlock = r.ph
      ? (r.pe
          ? '<b style="color:var(--warn)">≈' + fmt(r.pe) + '</b>' +
            '<span>估算值 · 取上下相邻名次公开功力的平均</span>' +
            (r.pr ? '<span style="margin-top:7px;font-size:12px;color:var(--slate)">区间 ' +
              fmt(r.pr.lo) + ' – ' + fmt(r.pr.hi) +
              (r.pr.hiAt && r.pr.loAt ? '（第 ' + r.pr.hiAt + ' 名与第 ' + r.pr.loAt + ' 名之间）' : '') +
              '</span>' : '')
          : '<b style="font-size:20px;color:var(--slate)">隐藏未公开</b><span>该玩家隐藏了功力数值</span>')
      : '<b>' + fmt(r.p) + '</b><span>功力' + (r.ro ? ' · 官方在榜' : ' · 并集推定') + '</span>';

    var rankBars = '';
    if (r.rm) {
      var pct = Math.max(3, 100 - Math.min(97, (r.rm - 1) / 15 * 100));
      rankBars += rankBar('门派内', r.rm, pct, '第 ' + r.rm + ' 名');
    }
    var powerPct = r.p ? Math.max(3, Math.min(100, (r.p / maxRef) * 100)) : 0;
    if (r.p) rankBars += rankBar('功力水位', null, powerPct, '相对全服榜首 ' + Math.round(r.p / maxRef * 100) + '%');

    var formerHtml = (r.fn && r.fn.length)
      ? '<div class="dw-formers">' + r.fn.map(function (f) {
          return '<span class="fm">' + esc(f) + ' <i>推断</i></span>';
        }).join('') + '</div>'
      : '<p class="dw-note">无推断出的曾用名记录。官方接口不提供改名履历，本站曾用名全部来自历次数据比对推断，仅供参考。</p>';

    var sigHtml = r.sig
      ? '<p class="dw-sig">' + esc(r.sig) + '</p>'
      : '<p class="dw-note">该角色没有公开的玩家签名。</p>';

    $('drawerContent').innerHTML =
      '<p class="dw-eyebrow">' + (r.ro ? '官方在榜' : '扩容收录') + ' · ' + esc(r.m) + '</p>' +
      '<h3 class="dw-name' + (r.nh ? ' is-hidden' : '') + '">' + esc(r.n) + '</h3>' +
      '<p class="dw-rankline">全服名次 <b>' + (r.ro ? '' : '~') + r.r + '</b>' +
        (r.rm ? ' · 门派内第 <b>' + r.rm + '</b> 名' : '') + '</p>' +
      '<div class="dw-power">' + powerBlock + '</div>' +
      '<dl class="dw-grid">' +
        '<div class="dw-item"><dt>门派</dt><dd>' + esc(r.m) + '</dd></div>' +
        '<div class="dw-item"><dt>服务器</dt><dd>' + esc(r.sv || DB.server) +
          (DB.kind === 'agg' ? '' : '（' + esc(DB.region) + '）') + '</dd></div>' +
        '<div class="dw-item wide"><dt>帮派</dt><dd>' + (r.g ? esc(r.g) : (r.gh ? '帮派名已隐藏' : '无帮派')) + '</dd></div>' +
        '<div class="dw-item"><dt>数据来源于</dt><dd>' + esc(DB.snapshot) + '</dd></div>' +
      '</dl>' +
      (rankBars ? '<div class="dw-sec"><h4>名次水位</h4><div class="dw-rankbars">' + rankBars + '</div></div>' : '') +
      historyChart(r) +
      '<div class="dw-sec"><h4>曾用名（推断）</h4>' + formerHtml + '</div>' +
      '<div class="dw-sec"><h4>玩家签名</h4>' + sigHtml + '</div>' +
      '<div class="dw-sec"><h4>成员构成</h4><div class="dw-note">收录于彼岸花服务器，出于并集重建，同一角色只保留最高功力记录。</div></div>';

    $('drawerContent').querySelector('.dw-name').setAttribute('title', r.n);
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawerBackdrop').hidden = false;
  }

  function rankBar(k, rank, pct, valText) {
    return '<div class="dw-rankbar"><span class="k">' + k + '</span>' +
      '<span class="track"><span class="fill" style="width:' + pct.toFixed(1) + '%"></span></span>' +
      '<span class="v">' + valText + '</span></div>';
  }

  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawerBackdrop').hidden = true;
  }

  /* ---------- 帮派详情 ---------- */
  // 详情数据按服分包（data/gd-<serverId>.js），点到某个帮派才加载那个服的
  var GHIST = null;
  var GD_PENDING = {};
  var GHIST_PENDING = null;

  function loadGuildDetail(sid) {
    if (!sid) return Promise.resolve(null);
    var cached = (window.__GD || {})[sid];
    if (cached) return Promise.resolve(cached);
    if (GD_PENDING[sid]) return GD_PENDING[sid];      // 连点多个帮派时不重复下载
    GD_PENDING[sid] = loadScript('data/gd-' + sid + '.js').then(function () {
      return (window.__GD || {})[sid] || null;
    });
    return GD_PENDING[sid];
  }

  function loadGhist() {
    if (GHIST) return Promise.resolve(GHIST);
    if (GHIST_PENDING) return GHIST_PENDING;
    GHIST_PENDING = loadScript('data/ghist.js').then(function () {
      GHIST = window.__GHIST || { days: [], g: {} };
      return GHIST;
    }, function () {
      GHIST = { days: [], g: {} };
      return GHIST;
    });
    return GHIST_PENDING;
  }

  // 通用折线绘制（帮派成长曲线用）
  function lineSvg(pts, opts) {
    opts = opts || {};
    var W = opts.w || 400, H = opts.h || 152, pl = 64, pr = 14, pt = 14, pb = 26;
    var iw = W - pl - pr, ih = H - pt - pb;
    var vals = pts.map(function (p) { return p.v; });
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
    if (mx === mn) { mx += 1000; mn -= 1000; }
    var pad = (mx - mn) * 0.16; mn -= pad; mx += pad;
    var X = function (i) { return pl + (pts.length < 2 ? iw / 2 : iw * i / (pts.length - 1)); };
    var Y = function (v) { return pt + ih * (1 - (v - mn) / (mx - mn)); };

    var grid = '';
    [0, 0.5, 1].forEach(function (t) {
      var v = mx - (mx - mn) * t, y = pt + ih * t;
      grid += '<line x1="' + pl + '" y1="' + y.toFixed(1) + '" x2="' + (pl + iw) + '" y2="' + y.toFixed(1) + '" class="ch-grid"/>' +
        '<text x="' + (pl - 6) + '" y="' + (y + 3.5).toFixed(1) + '" class="ch-ylab" text-anchor="end">' +
        bigNum(Math.round(v)) + '</text>';
    });

    var line = pts.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
    var area = pl + ',' + (pt + ih) + ' ' + line + ' ' + (pl + iw) + ',' + (pt + ih);
    var step = pts.length > 30 ? Math.ceil(pts.length / 30) : 1;
    var dots = '';
    pts.forEach(function (p, i) {
      if (i % step !== 0 && i !== pts.length - 1) return;
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="2.5" class="ch-dot"/>';
    });
    var lab = '<text x="' + pl + '" y="' + (H - 8) + '" class="ch-xlab" text-anchor="start">' + esc(pts[0].d) + '</text>' +
      '<text x="' + (pl + iw) + '" y="' + (H - 8) + '" class="ch-xlab" text-anchor="end">' + esc(pts[pts.length - 1].d) + '</text>';

    return '<svg class="dw-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
      '<defs><linearGradient id="gpGrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="rgba(224,160,68,.32)"/>' +
        '<stop offset="100%" stop-color="rgba(224,160,68,0)"/>' +
      '</linearGradient></defs>' +
      grid +
      '<polygon points="' + area + '" fill="url(#gpGrad)"/>' +
      '<polyline points="' + line + '" class="ch-line"/>' +
      dots +
      '<circle cx="' + X(pts.length - 1).toFixed(1) + '" cy="' + Y(pts[pts.length - 1].v).toFixed(1) + '" r="4.2" class="ch-last"/>' +
      lab +
    '</svg>';
  }

  /* ---------- 帮派评级 / 稳定度 / 成员榜 / 关系网 ---------- */
  var RATING = null;        // 当前视图内的评级缓存，切换视图时清空

  function guildKeyOf(g) {
    return (IS_AGG && g.sv) ? (g.sv + '|' + g.g) : g.g;
  }

  // 综合评分：前80战力 65% + 成员平均 15% + 最高战力 10% + 阵容规模 10%，
  // 全部取「当前视图内的百分位」，再用幂函数压缩（低分段抬升，头部集中）
  function computeRatings() {
    var n = GUILDS.length;
    if (!n) return null;
    if (RATING && RATING._n === n && RATING._v === state.view) return RATING;

    var maxMap = {};
    ROLES.forEach(function (r) {
      if (!r.g || !r.p) return;
      var k = guildKeyOf(r);
      if (!maxMap[k] || r.p > maxMap[k]) maxMap[k] = r.p;
    });

    var list = GUILDS.map(function (g) {
      var k = guildKeyOf(g);
      return { k: k, power: guildPower(g) || 0, avg: guildAvg(g) || 0,
               size: g.tm || 0, mx: maxMap[k] || 0 };
    });

    function pctMap(field) {
      var sorted = list.slice().sort(function (a, b) { return a[field] - b[field]; });
      var m = {};
      sorted.forEach(function (x, i) {
        m[x.k] = sorted.length > 1 ? i / (sorted.length - 1) : 1;
      });
      return m;
    }
    var pP = pctMap('power'), pA = pctMap('avg'), pS = pctMap('size'), pM = pctMap('mx');

    var out = { _n: n, _v: state.view, _total: n };
    list.forEach(function (x) {
      var push = function (p) { return Math.pow(Math.max(0, p || 0), 0.45); };
      var d = 0.65 * push(pP[x.k]) + 0.15 * push(pA[x.k]) +
              0.10 * push(pM[x.k]) + 0.10 * push(pS[x.k]);
      out[x.k] = {
        score: Math.round(d * 1000) / 10,
        parts: [['前80战力深度', Math.round(push(pP[x.k]) * 100)],
                ['成员平均功力', Math.round(push(pA[x.k]) * 100)],
                ['最高战力', Math.round(push(pM[x.k]) * 100)],
                ['阵容规模', Math.round(push(pS[x.k]) * 100)]],
      };
    });

    var order = list.slice().sort(function (a, b) { return out[b.k].score - out[a.k].score; });
    var tot = order.length;
    order.forEach(function (x, i) {
      var p = (i + 1) / tot;
      out[x.k].rank = i + 1;
      out[x.k].grade = p <= 0.02 ? 'S+' : p <= 0.10 ? 'S' : p <= 0.25 ? 'A+'
                     : p <= 0.50 ? 'A' : p <= 0.75 ? 'B' : 'C';
    });
    RATING = out;
    return out;
  }

  function stabilityOf(d) {
    var mv = 0, real = 0;
    (d.rf || []).forEach(function (x) {
      mv += (x[3] || 0) + (x[4] || 0) + (x[5] || 0) + (x[6] || 0);
      real += (x[3] || 0) + (x[5] || 0);
    });
    var rate = d.tm ? mv / d.tm : 0;
    var score = Math.round(100 / (1 + rate * 1.5) * 10) / 10;
    var label = score >= 85 ? '铁板一块' : score >= 70 ? '稳定' : score >= 50 ? '略有流动'
              : score >= 30 ? '频繁换血' : '大换血';
    var cls = score >= 70 ? 'ok' : score >= 50 ? 'mid' : 'bad';
    return { mv: mv, real: real, score: score, label: label, cls: cls,
             inN: (d.rf || []).reduce(function (a, x) { return a + (x[3] || 0) + (x[4] || 0); }, 0),
             outN: (d.rf || []).reduce(function (a, x) { return a + (x[5] || 0) + (x[6] || 0); }, 0) };
  }

  function shortName(s, n) {
    s = String(s || '');
    n = n || 6;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // 帮内成员榜（直接由当前视图的角色表算，零额外数据）
  function guildMembersOf(g, cap) {
    var out = [];
    for (var i = 0; i < ROLES.length; i++) {
      var r = ROLES[i];
      if (!r.g || r.g !== g.g || !r.p) continue;
      if (IS_AGG && g.sv && r.sv !== g.sv) continue;
      out.push(r);
    }
    out.sort(function (a, b) { return b.p - a.p; });
    return { arr: out.slice(0, cap || 80), total: out.length };
  }

  function ratingHtml(g, d) {
    var R = computeRatings();
    var key = guildKeyOf(g);
    var info = R ? R[key] : null;
    if (!info) return '';

    var bars = info.parts.map(function (p) {
      return '<div class="gd-bar"><span class="gd-bar-name">' + p[0] + '</span>' +
        '<i class="gd-bar-track"><em style="width:' + Math.max(2, p[1]) + '%"></em></i>' +
        '<b class="gd-bar-val">' + p[1] + '</b></div>';
    }).join('');

    var st = stabilityOf(d);
    var scope = (IS_AGG && state.view !== 'all')
      ? (((viewById(state.view) || {}).label || '').replace(/大区$/, '') + '大区')
      : (state.view === 'all' ? '全区全服' : ((viewById(state.view) || {}).label || ''));

    return '<div class="dw-sec"><h4>帮派评级</h4>' +
      '<div class="gd-grade">' +
        '<div class="gd-grade-badge g' + esc(info.grade.replace('+', 'p')) + '">' + esc(info.grade) + '</div>' +
        '<div class="gd-grade-info"><b>' + info.score.toFixed(1) + '</b>' +
          '<span>综合评分 · ' + esc(scope) + '第 ' + info.rank + ' 名 / 共 ' + R._total + ' 个帮派</span></div>' +
      '</div>' +
      '<div class="gd-bars">' + bars + '</div>' +
      '<p class="dw-note">评级为<b>本站算法</b>：以当前视图内的百分位计权——前 80 战力占 65%、成员平均功力 15%、' +
        '最高战力 10%、阵容规模 10%，并用幂函数压缩（低分段抬升）。等级按名次分布划分：' +
        '<b>S+</b> 前 2%、<b>S</b> 前 10%、<b>A+</b> 前 25%、<b>A</b> 前 50%、<b>B</b> 前 75%，其余为 C。</p>' +
      '<div class="gd-stab">' +
        '<div class="gd-stab-head"><span>帮派稳定度</span>' +
          '<b class="gd-stab-score ' + st.cls + '">' + st.score.toFixed(1) + '</b>' +
          '<i class="gd-stab-tag ' + st.cls + '">' + st.label + '</i></div>' +
        '<div class="gd-stab-bar"><i class="' + st.cls + '" style="width:' + Math.max(2, st.score) + '%"></i></div>' +
        '<dl class="gd-stats gd-stats-inline">' +
          '<div class="gd-stat"><dt>记录流入</dt><dd class="mono up">+' + fmt(st.inN) + '</dd></div>' +
          '<div class="gd-stat"><dt>记录流出</dt><dd class="mono down">-' + fmt(st.outN) + '</dd></div>' +
          '<div class="gd-stat"><dt>真实人员变动</dt><dd class="mono">' + st.real + ' 人次</dd></div>' +
          '<div class="gd-stat"><dt>记录变动合计</dt><dd class="mono">' + fmt(st.mv) + ' 人次</dd></div>' +
        '</dl>' +
        '<p class="dw-note">稳定度＝变动人次相对成员数的换血率换算（100 ÷ (1 + 1.5 × 换血率)），窗口为最近 5 天。' +
          '「记录流入/流出」含收录边界的进出，「真实人员变动」只算入帮与退帮。</p>' +
      '</div></div>';
  }

  function relHtml(g, d) {
    var rel = (d.rel || []).filter(function (r) { return r[1] || r[3]; });
    if (!rel.length) {
      return '<div class="dw-sec"><h4>挖人关系网</h4>' +
        '<p class="dw-note">最近 5 天内该帮派没有与其他帮派之间的人员往来记录（入帮时携带来源帮派的成员）。</p></div>';
    }
    var tin = rel.reduce(function (a, r) { return a + (r[1] || 0); }, 0);
    var tout = rel.reduce(function (a, r) { return a + (r[3] || 0); }, 0);
    var net = tin - tout;

    var rows = rel.map(function (r) {
      var inn = r[1] || 0, inp = r[2] || 0, outn = r[3] || 0, outp = r[4] || 0;
      var n = inn - outn;
      return '<li><span class="gd-rel-name">' + esc(r[0]) + '</span>' +
        '<span class="gd-rel-nums">' +
          (inn ? '<i class="up">流入 ' + inn + ' 人 +' + fmt(inp) + '</i>' : '') +
          (outn ? '<i class="down">流出 ' + outn + ' 人 -' + fmt(outp) + '</i>' : '') +
        '</span>' +
        '<b class="gd-rel-net ' + (n > 0 ? 'up' : n < 0 ? 'down' : 'flat') + '">' +
          (n > 0 ? '+ ' + n : n < 0 ? '− ' + (-n) : '0') + '</b></li>';
    }).join('');

    return '<div class="dw-sec"><h4>挖人关系网</h4>' +
      '<div class="gd-rel-sum">' +
        '<span>流入 <b class="up">+' + tin + '</b> 人</span>' +
        '<span>流出 <b class="down">-' + tout + '</b> 人</span>' +
        '<span>净流入 <b class="' + (net > 0 ? 'up' : net < 0 ? 'down' : 'flat') + '">' +
          (net > 0 ? '+' : '') + net + '</b> 人</span>' +
      '</div>' +
      relSvg(g, rel) +
      '<ul class="gd-rel-list">' + rows + '</ul>' +
      '<p class="dw-note">数据源自带的人员流动只记录「入帮时的来源帮派」，<b>不提供退帮去向</b>；' +
        '表中流出方向是靠对方帮派的入帮记录反推出来的。窗口为最近 5 天，本站会逐日累积。</p></div>';
  }

  function relSvg(g, rel) {
    var W = 360, H = 250, cx = W / 2, cy = H / 2;
    var n = Math.min(rel.length, 8);
    var maxV = 1;
    rel.forEach(function (r) { maxV = Math.max(maxV, (r[1] || 0) + (r[3] || 0)); });
    var R = 96, parts = [];
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + i * (2 * Math.PI / n);
      var x = cx + R * Math.cos(a), y = cy + (R * 0.74) * Math.sin(a);
      var r = rel[i], inn = r[1] || 0, outn = r[3] || 0;
      var w = (1 + 3 * ((inn + outn) / maxV)).toFixed(1);
      if (inn) parts.push('<line x1="' + x.toFixed(1) + '" y1="' + y.toFixed(1) +
        '" x2="' + cx + '" y2="' + cy + '" class="gd-rel-line in" stroke-width="' + w + '"/>');
      if (outn) parts.push('<line x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(1) +
        '" y2="' + y.toFixed(1) + '" class="gd-rel-line out" stroke-width="' + w + '"/>');
      parts.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4.5" class="gd-rel-node"/>');
      parts.push('<text x="' + x.toFixed(1) + '" y="' + (y - 10).toFixed(1) +
        '" class="gd-rel-label" text-anchor="middle">' + esc(shortName(r[0], 5)) + '</text>');
      parts.push('<text x="' + x.toFixed(1) + '" y="' + (y + 19).toFixed(1) +
        '" class="gd-rel-num" text-anchor="middle">入' + inn + ' 出' + outn + '</text>');
    }
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="30" class="gd-rel-hub"/>');
    parts.push('<text x="' + cx + '" y="' + (cy + 4) + '" class="gd-rel-hub-label" text-anchor="middle">' +
      esc(shortName(g.g, 6)) + '</text>');
    return '<svg class="gd-rel-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="帮派人员往来关系">' +
      parts.join('') + '</svg>';
  }

  function membersHtml(g) {
    var m = guildMembersOf(g, 80);
    if (!m.arr.length) {
      return '<div class="dw-sec"><h4>帮内成员功力榜</h4>' +
        '<p class="dw-note">当前视图里没有该帮派的上榜成员（帮派若隐藏了帮派名，成员不会被归属到这里）。</p></div>';
    }
    function rows(arr, from) {
      return arr.map(function (r, i) {
        var idx = from + i + 1;
        return '<tr data-ridx="' + r._i + '" class="gd-mem-row">' +
          '<td class="num gd-mem-rank">' + idx + '</td>' +
          '<td><span class="rn-text' + (r.nh ? ' is-hidden' : '') + '">' + esc(r.n) + '</span>' +
            (IS_AGG && r.sv ? '<span class="cell-sub">' + esc(r.sv) + '</span>' : '') + '</td>' +
          '<td><span class="badge menpai">' + esc(r.m) + '</span></td>' +
          '<td class="num">' + powerHtml(r) + '</td></tr>';
      }).join('');
    }
    var head = '<thead><tr><th class="num">#</th><th>角色</th><th>门派</th><th class="num">功力</th></tr></thead>';
    var first = m.arr.slice(0, 10), rest = m.arr.slice(10);
    return '<div class="dw-sec"><h4>帮内成员功力榜 · 前 ' + m.arr.length + '</h4>' +
      '<table class="mini-table gd-mem">' + head + '<tbody>' + rows(first, 0) + '</tbody></table>' +
      (rest.length
        ? '<div id="gdMemMore" hidden><table class="mini-table gd-mem"><tbody>' +
            rows(rest, 10) + '</tbody></table></div>' +
          '<button type="button" class="gd-more-btn" id="gdMemBtn" data-more="展开其余 ' + rest.length +
            ' 名成员">展开其余 ' + rest.length + ' 名成员</button>'
        : '') +
      '<p class="dw-note">按当前视图内的收录成员计算（共 ' + m.total + ' 人，展示前 ' + m.arr.length +
        ' 名）。点任意一行可查看该角色详情。隐藏功力的成员用估算值显示。</p></div>';
  }

  function openGuild(g) {
    var sid = g.rid || ((viewById(state.view) || {}).kind === 'srv' ? state.view : '');
    var off = guildOff(g);
    var total = g._d0;
    var totalCls = total > 0 ? 'up' : (total < 0 ? 'down' : 'flat');

    function wireDrawer(g) {
      var btn = $('guildMembersBtn');
      if (btn) btn.addEventListener('click', function () { gotoGuildMembers(g.g); });
      var mb = $('gdMemBtn');
      if (mb) mb.addEventListener('click', function () {
        var box = $('gdMemMore');
        if (!box) return;
        var open = box.hidden;
        box.hidden = !open;
        mb.textContent = open ? '收起成员名单' : mb.dataset.more;
      });
      var rows = document.querySelectorAll('#drawerContent .gd-mem-row');
      Array.prototype.forEach.call(rows, function (tr) {
        tr.addEventListener('click', function () { openRole(+tr.getAttribute('data-ridx')); });
      });
    }

    function shell(inner) {
      $('drawerContent').innerHTML = inner;
      $('drawer').classList.add('open');
      $('drawer').setAttribute('aria-hidden', 'false');
      $('drawerBackdrop').hidden = false;
      wireDrawer(g);
    }

    function head(d) {
      var power = d ? d.ov : guildPower(g);
      var isOff = d ? d.off : off;
      var rg = (viewById(sid) || {}).region || g.rg || DB.region || '';
      return '<p class="dw-eyebrow">帮派 · ' + esc(rg) + ' · ' +
          esc(g.sv || DB.server || '') + '</p>' +
        '<h3 class="dw-name">' + esc(g.g) + '</h3>' +
        '<p class="dw-rankline">官方帮派榜 · 帮派功力值为<b>前 80 名成员功力之和</b>' +
          (isOff ? '（含隐藏数值的成员）' : '') + '</p>' +
        '<div class="dw-power"><b>' + fmt(power) + '</b>' +
          '<span>' + (isOff ? '官方帮派功力' : '本站推算 · 前 80 名之和（官方榜未收录）') + '</span>' +
          (total !== null && total !== undefined
            ? '<span style="margin-top:7px">最近一日 <b class="ch-delta ' + totalCls +
              '" style="font-size:15px">' + (total > 0 ? '+' : '') + fmt(total) + '</b></span>'
            : '') +
        '</div>';
    }

    // 先渲染骨架（基础信息立即可见），详情到达后替换
    shell(head(null) +
      '<div id="gdMore">' +
        '<dl class="dw-grid">' +
          '<div class="dw-item"><dt>平均功力</dt><dd class="mono">' + fmt(guildAvg(g)) + '</dd></div>' +
          '<div class="dw-item"><dt>上榜成员</dt><dd>' + (g.tm || 0) + ' 人</dd></div>' +
        '</dl>' +
        '<div class="dw-sec"><p class="dw-note">正在载入帮派详情…</p></div>' +
      '</div>');

    Promise.all([loadGuildDetail(sid), loadGhist()]).then(function (res) {
      var d = res[0] && sid ? res[0][g.g] : null;
      var gh = res[1];
      var more = $('gdMore');
      if (!more) return;                       // 抽屉已被关闭
      more.outerHTML = guildDetailHtml(g, d, gh, sid);
      wireDrawer(g);
    }, function () {
      var more = $('gdMore');
      if (more) more.outerHTML =
        '<div class="dw-sec"><p class="dw-note">帮派详情载入失败（data/gd-' + esc(sid) + '.js 不可访问），' +
        '以上为基础信息。</p></div>';
    });
  }

  function guildDetailHtml(g, d, gh, sid) {
    if (!d) {
      return '<div class="dw-sec"><p class="dw-note">该帮派暂无官方详情数据（数据源仅对收录到的帮派提供明细）。</p></div>' +
        '<div class="dw-sec"><button type="button" class="find-go" id="guildMembersBtn" style="width:100%">查看该帮派的上榜成员</button></div>';
    }

    var out = '';

    // ---- 关键数据 ----
    var rows = [];
    var rgName = (viewById(sid) || {}).region || g.rg || '';
    if (d.ogr) rows.push(['官方名次', '全服第 <b>' + d.ogr + '</b> 名' +
      (d.orr && rgName ? ' · ' + esc(rgName) + '第 <b>' + d.orr + '</b> 名' : '')]);
    if (d.top) rows.push(['功力最高成员', esc(d.top[0]) + ' <b>' + fmt(d.top[1]) + '</b>' +
      (d.top[2] ? '<span class="gd-dim">（名次 ' + d.top[2] + '）</span>' : '')]);
    if (d.ld) rows.push(['官方代表角色 / 盟主', esc(d.ld)]);
    rows.push(['平均功力', '<b>' + fmt(d.oa || guildAvg(g)) + '</b>' +
      (d.off ? '<span class="gd-dim">官方值 ÷ 80</span>' : '<span class="gd-dim">本站推算</span>')]);
    if (d.cap) rows.push(['采集时间', '<span class="mono">' + esc(d.cap) + '</span>']);

    out += '<div class="dw-sec"><h4>关键数据</h4><dl class="gd-stats">' +
      rows.map(function (r) {
        return '<div class="gd-stat"><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>';
      }).join('') + '</dl></div>';

    // ---- 成员与功力构成 ----
    var pub = d.pm || Math.max(0, (d.tm || 0) - (d.hpm || 0));
    var powerLine = fmt(d.tp) + ' = 公开值合计 <b>' + fmt(d.vp) + '</b>' +
      (d.he ? ' + 隐藏成员估算 <b>' + fmt(d.he) + '</b>' : '');
    out += '<div class="dw-sec"><h4>榜单收录构成</h4>' +
      '<dl class="gd-stats">' +
      '<div class="gd-stat"><dt>数据来源于·收录成员</dt><dd><b>' + (d.tm || 0) + '</b> 人' +
        (d.hpm ? '，其中 <b>' + d.hpm + '</b> 人隐藏了功力（计入人数，功力按名次区间中位值计入）' : '') + '</dd></div>' +
      '<div class="gd-stat"><dt>收录总功力</dt><dd class="mono">' + powerLine + '</dd></div>' +
      '<div class="gd-stat"><dt>前 80 之和（本站口径）</dt><dd class="mono">' + fmt(d.t80) +
        '<span class="gd-dim">公开数值里的前 80 名，共 ' + (d.tm || 0) + ' 人参与</span></dd></div>' +
      '</dl>' +
      '<p class="dw-note">官方功力值已包含隐藏成员，<b>不要与「收录总功力」相加</b>。收录人数只统计进入榜单的成员，不等于帮派真实人数。</p>' +
      '</div>';

    // ---- 帮派评级与稳定度 ----
    out += ratingHtml(g, d);

    // ---- 前80之和成长曲线（数据源近 5 天） ----
    var hf = d.hf || [];
    if (hf.length >= 2) {
      var pts = hf.map(function (x) { return { d: x[0], v: x[1] }; });
      var delta = pts[pts.length - 1].v - pts[0].v;
      var dcls = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
      out += '<div class="dw-sec"><h4>前 80 之和成长曲线</h4>' +
        '<div class="dw-chart-meta"><span>' + esc(hf[0][0]) + ' → ' + esc(hf[hf.length - 1][0]) + '</span>' +
          '<span>' + hf.length + ' 个数据点</span>' +
          '<b class="ch-delta ' + dcls + '">' + (delta >= 0 ? '+' : '') + fmt(delta) + '</b></div>' +
        lineSvg(pts) +
        '<p class="dw-chart-foot">当前前 80 之和 <b>' + fmt(hf[hf.length - 1][1]) + '</b>' +
          ' · 收录成员 <b>' + (d.tm || 0) + '</b> 人</p>' +
        '<p class="dw-note">该曲线含成员进出的影响（吸收高手会抬升、成员流失会拉低）。</p></div>';
    }

    // ---- 30 天长周期曲线（按成员功力曲线回溯聚合） ----
    var key = sid + '|' + g.g;
    var arr = (gh && gh.g && gh.g[key]) || null;
    if (arr && gh.days && gh.days.length >= 2) {
      var lp = [];
      for (var i = 0; i < gh.days.length; i++) {
        var v = arr[i];
        if (v !== null && v !== undefined) lp.push({ d: gh.days[i].slice(5), v: v });
      }
      if (lp.length >= 2) {
        var ld = lp[lp.length - 1].v - lp[0].v;
        var lcls = ld > 0 ? 'up' : (ld < 0 ? 'down' : 'flat');
        out += '<div class="dw-sec"><h4>帮派功力走势（近 ' + gh.days.length + ' 天）</h4>' +
          '<div class="dw-chart-meta"><span>' + esc(lp[0].d) + ' → ' + esc(lp[lp.length - 1].d) + '</span>' +
            '<span>' + lp.length + ' 天</span>' +
            '<b class="ch-delta ' + lcls + '">' + (ld >= 0 ? '+' : '') + fmt(ld) + '</b></div>' +
          lineSvg(lp) +
          '<p class="dw-note">按收录成员的功力曲线逐日回溯聚合，取当日前 80 名之和，口径与榜单一致；个别成员当天未上榜时会略微低估。成员进出的影响同样体现在曲线里。</p></div>';
      }
    }

    // ---- 挖人关系网 ----
    out += relHtml(g, d);

    // ---- 人员流动明细 ----
    var rf = (d.rf || []).slice().reverse();     // 最近的排前面
    if (rf.length) {
      out += '<div class="dw-sec"><h4>人员流动（入帮 / 新收录 / 退帮 / 掉出收录）</h4>';
      rf.forEach(function (x) {
        var dt = x[0], prevN = x[1], curN = x[2];
        var joinN = x[3], freshN = x[4], leaveN = x[5], dropN = x[6];
        var joinP = x[7], freshP = x[8], leaveP = x[9], dropP = x[10];
        var net = (joinN + freshN) - (leaveN + dropN);
        var has = joinN || freshN || leaveN || dropN;

        out += '<div class="gd-flow">' +
          '<div class="gd-flow-head"><b>' + esc(dt) + '</b>' +
            '<span>' + prevN + ' → ' + curN + ' 人' +
              '<b class="ch-delta ' + (net > 0 ? 'up' : net < 0 ? 'down' : 'flat') + '">' +
              (net > 0 ? '+' : '') + net + ' 人</b></span></div>';
        if (!has) { out += '<p class="dw-note">当日无人员变动。</p></div>'; return; }

        out += '<div class="gd-flow-body">' +
          flowItem('新收录', freshN, freshP, x[12], 'up', '功力达到收录线、进入榜单视野') +
          flowItem('入帮', joinN, joinP, x[11], 'up', '从其他帮派转入') +
          flowItem('掉出收录', dropN, dropP, x[14], 'down', '功力掉出榜单收录范围（不等于退帮）') +
          flowItem('退帮', leaveN, leaveP, x[13], 'down', '离开该帮派') +
        '</div></div>';
      });
      out += '<p class="dw-note">「新收录 / 掉出收录」是本站视野的变化——功力越过收录边界就会进出榜，' +
        '<b>掉出收录不等于退帮</b>；「入帮 / 退帮」才是真实的帮派成员变动。数据源仅提供最近 5 天。</p></div>';
    }

    // ---- 帮内成员功力榜 ----
    out += membersHtml(g);

    out += '<div class="dw-sec"><button type="button" class="find-go" id="guildMembersBtn" style="width:100%">' +
      '在功力榜中筛选该帮派成员</button></div>';

    return out;
  }

  function flowItem(label, n, p, list, dir, tip) {
    if (!n) return '';
    var cls = dir === 'up' ? 'up' : 'down';
    var signed = dir === 'down' ? -Math.abs(p || 0) : Math.abs(p || 0);
    var arr = list || [];
    var names = arr.map(function (x) {
      return '<li><span class="gd-nm">' + esc(x[0]) + '</span>' +
        (x[1] ? '<span class="gd-pw">' + fmt(x[1]) + '</span>' : '') + '</li>';
    }).join('');
    // 名单被截断时说明还有多少人（数据源本身没给名单时不显示）
    if (arr.length && n > arr.length) {
      names += '<li class="gd-nm-more">…另 ' + (n - arr.length) + ' 人</li>';
    }
    return '<div class="gd-flow-item">' +
      '<div class="gd-flow-row"><span class="gd-flow-label" title="' + esc(tip) + '">' + label + '</span>' +
        '<span class="gd-flow-n">' + n + ' 人</span>' +
        '<b class="ch-delta ' + cls + '">' + (signed > 0 ? '+' : '') + fmt(signed) + '</b></div>' +
      (names ? '<ul class="gd-names">' + names + '</ul>' : '') +
    '</div>';
  }

  function gotoGuildMembers(name) {
    closeDrawer();
    state.board = 'power';
    state.guild = name;
    state.page = 1;
    state.sort = 'rank';
    document.querySelectorAll('.board-btn').forEach(function (x) {
      x.classList.toggle('is-active', x.dataset.board === 'power');
      x.setAttribute('aria-pressed', x.dataset.board === 'power' ? 'true' : 'false');
    });
    refresh();
    $('rosterBar').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------- 刷新 ---------- */
  function refresh() {
    renderBars();
    renderTable();
    if (state.board === 'guild') fixGuildRanks();
    document.querySelectorAll('.chip').forEach(function (c) {
      var axis = c.dataset.axis;
      c.classList.toggle('is-active', state[axis] === c.dataset.val);
    });
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    // 服务器选择器
    $('srvBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleServerMenu();
    });
    $('srvMenu').addEventListener('click', function (e) {
      // 勾选对比（不关闭菜单，方便连点两个服）
      var pk = e.target.closest('.srv-pick');
      if (pk) {
        e.preventDefault();
        e.stopPropagation();
        togglePick(pk.getAttribute('data-pick'));
        renderServerPicker();
        markCurrentServer();
        return;
      }
      // 开始对比
      var cb = e.target.closest('[data-cmp]');
      if (cb) {
        e.preventDefault();
        if (PICK.length >= 2) {
          toggleServerMenu(false);
          startCompare();
        }
        return;
      }
      var b = e.target.closest('.srv-item');
      if (!b) return;
      toggleServerMenu(false);
      var id = b.getAttribute('data-srv');
      if (id && id !== state.view) switchView(id);
    });
    document.addEventListener('click', function (e) {
      if (!$('srvPicker').contains(e.target)) toggleServerMenu(false);
    });

    // 榜单切换
    document.querySelectorAll('.board-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.board === b.dataset.board) return;
        state.board = b.dataset.board;
        document.querySelectorAll('.board-btn').forEach(function (x) {
          x.classList.toggle('is-active', x === b);
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        document.body.classList.toggle('board-guild', state.board === 'guild');
        // 该榜单默认排序
        state.sort = state.board === 'power' ? 'rank' : 'ov';
        state.page = 1;
        $('rosterBar').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        refresh();
      });
    });

    // 搜索
    $('findForm').addEventListener('submit', function (e) {
      e.preventDefault();
      state.q = $('q').value;
      state.page = 1;
      $('findClear').hidden = !state.q;
      refresh();
    });
    $('q').addEventListener('input', function () {
      $('findClear').hidden = !$('q').value;
    });
    $('findClear').addEventListener('click', function () {
      $('q').value = '';
      state.q = '';
      state.page = 1;
      $('findClear').hidden = true;
      refresh();
    });

    // chips
    $('sieve').addEventListener('click', function (e) {
      var c = e.target.closest('.chip');
      if (!c) return;
      var axis = c.dataset.axis, val = c.dataset.val;
      state[axis] = state[axis] === val ? '' : val;
      state.page = 1;
      refresh();
    });

    // 排序 / 每页
    $('rosterBar').addEventListener('click', function (e) {
      var s = e.target.closest('[data-sort]');
      if (s) { state.sort = s.dataset.sort; state.page = 1; refresh(); return; }
      var z = e.target.closest('[data-size]');
      if (z) { state.pageSize = +z.dataset.size; state.page = 1; refresh(); return; }
      if (e.target.closest('#copyPageBtn')) copyPage();
    });

    // 翻页
    $('pager').addEventListener('click', function (e) {
      var b = e.target.closest('[data-page]');
      if (!b || b.disabled) return;
      state.page = +b.dataset.page;
      refresh();
      $('rosterBar').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // 表格行点击
    $('ledgerBody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr');
      if (!tr) return;
      if (tr.dataset.idx !== undefined && tr.dataset.idx !== '') openRole(+tr.dataset.idx);
      else if (tr.dataset.gidx !== undefined && tr.dataset.gidx !== '') {
        var g = null;
        for (var i = 0; i < GUILDS.length; i++) if (GUILDS[i]._gi === +tr.dataset.gidx) { g = GUILDS[i]; break; }
        if (g) openGuild(g);
      }
    });

    // 前三甲 & 抽屉
    $('podium').addEventListener('click', function (e) {
      var p = e.target.closest('.pod');
      if (p) openRole(+p.dataset.idx);
    });
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    // 回到顶部
    var toTop = $('toTop');
    toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    window.addEventListener('scroll', function () {
      toTop.classList.toggle('show', window.scrollY > 500);
    }, { passive: true });
  }

  /* ---------- 复制本页名单 ---------- */
  function copyPage() {
    var rows = $('ledgerBody').querySelectorAll('tr');
    var lines = [];
    if (state.board === 'power') {
      lines.push('名次\t角色\t' + (IS_AGG ? '服务器\t' : '') + '门派\t帮派\t功力');
      rows.forEach(function (tr) {
        var r = ROLES[+tr.dataset.idx];
        if (!r) return;
        lines.push([r.r, r.n].concat(IS_AGG ? [r.sv || ''] : []).concat(
          [r.m, r.g || '无', powerText(r)]).join('\t'));
      });
    } else {
      lines.push('排行\t帮派\t上榜成员\t总功力\t帮派功力\t平均功力\t日变化\t口径\t盟主');
      var list = filterGuilds();
      var start = (state.page - 1) * state.pageSize;
      rows.forEach(function (tr, i) {
        var g = list[start + i];
        if (!g) return;
        lines.push([start + i + 1, g.g, g.tm || 0, g.hp || 0, guildPower(g), guildAvg(g),
                    (g._d0 === null || g._d0 === undefined) ? '—' : g._d0,
                    guildOff(g) ? '官方' : '推算', g.ld || '未知'].join('\t'));
      });
    }
    var text = lines.join('\n');
    var done = function () {
      var btn = $('copyPageBtn');
      var old = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(function () { btn.textContent = old; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else fallback(text, done);
  }
  function fallback(text, cb) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); cb(); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ---------- 花瓣 ---------- */
  function petals() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var box = $('petals');
    var n = window.innerWidth < 700 ? 12 : 22;
    var html = '';
    for (var i = 0; i < n; i++) {
      var left = Math.random() * 100;
      var dur = 11 + Math.random() * 13;
      var delay = -Math.random() * 24;
      var sz = 0.65 + Math.random() * 0.95;
      var drift = (Math.random() * 160 - 80).toFixed(0);
      html += '<span class="petal" style="left:' + left.toFixed(1) + '%;' +
        'animation-duration:' + dur.toFixed(1) + 's;animation-delay:' + delay.toFixed(1) + 's;' +
        'transform:scale(' + sz.toFixed(2) + ');--drift:' + drift + 'px"></span>';
    }
    box.innerHTML = html;
  }

  /* ---------- 初始化 ---------- */
  /* ---------- 视图：全区全服 / 大区 / 单服 ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src + (src.indexOf('?') < 0 ? '?' : '&') + 'v=' + encodeURIComponent(DATA_VER);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error(src + ' 读取失败')); };
      document.head.appendChild(s);
    });
  }

  function buildViews() {
    var groups = {};
    SRV_LIST.forEach(function (s) {
      var r = s.region || '其他大区';
      (groups[r] = groups[r] || []).push(s);
    });
    var total = 0;
    SRV_LIST.forEach(function (s) { total += (s.n || 0); });

    var views = [{ id: 'all', label: '全区全服', short: '全区全服', n: total, kind: 'agg', region: '' }];
    var ORDER = ['青龙乱舞', '大地飞鹰', '云上之城', '沧海云帆', '时光吹雪', '其他大区'];
    Object.keys(groups).sort(function (a, b) {
      var ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }).forEach(function (region) {
      var list = groups[region].slice().sort(function (a, b) { return (b.n || 0) - (a.n || 0); });
      var rn = list.reduce(function (a, s) { return a + (s.n || 0); }, 0);
      views.push({
        id: 'r-' + String(list[0].id).slice(0, 2),
        label: region, short: region, n: rn, kind: 'agg', region: region
      });
      list.forEach(function (s) {
        views.push({ id: s.id, label: s.name, short: s.name, n: s.n || 0, kind: 'srv', region: region });
      });
    });
    return views;
  }

  function viewById(id) {
    for (var i = 0; i < VIEWS.length; i++) if (VIEWS[i].id === id) return VIEWS[i];
    return null;
  }

  /* ---------- 多服对比 ---------- */
  // 在下拉列表里勾 2~4 个服，合成一个临时榜单：功力统一排序、行内标服务器。
  var PICK = [];
  var CMP_MAX = 4;

  function savePick() {
    try { localStorage.setItem('pick', JSON.stringify(PICK)); } catch (e) {}
  }

  function loadPick() {
    try {
      var raw = JSON.parse(localStorage.getItem('pick') || '[]');
      if (Object.prototype.toString.call(raw) !== '[object Array]') return;
      PICK = raw.filter(function (id) {
        var v = viewById(id);
        return v && v.kind === 'srv';
      }).slice(0, CMP_MAX);
    } catch (e) { PICK = []; }
  }

  function loadServerData(id) {
    var c = store()[id];
    if (c) return Promise.resolve(c);
    return loadScript('data/s-' + id + '.js').then(function () { return store()[id] || null; });
  }

  function togglePick(id) {
    var i = PICK.indexOf(id);
    if (i >= 0) PICK.splice(i, 1);
    else if (PICK.length >= CMP_MAX) return false;
    else PICK.push(id);
    savePick();
    return true;
  }

  function buildCompareView(ids) {
    return Promise.all(ids.map(loadServerData)).then(function (list) {
      var roles = [], guilds = [], names = [], snap = '';
      list.forEach(function (d, i) {
        if (!d) return;
        var sid = ids[i];
        names.push(d.server);
        snap = snap || d.snapshot || '';
        (d.roles || []).forEach(function (r) {
          var o = {};
          for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
          o.rid = sid;
          o.sv = d.server;
          roles.push(o);
        });
        (d.guilds || []).forEach(function (g) {
          var o = {};
          for (var k in g) if (Object.prototype.hasOwnProperty.call(g, k)) o[k] = g[k];
          o.rid = sid;
          o.sv = d.server;
          guilds.push(o);
        });
      });
      var pv = function (r) { return (r.p !== null && r.p !== undefined) ? r.p : (r.pe || 0); };
      roles.sort(function (a, b) { return pv(b) - pv(a) || (a.r || 0) - (b.r || 0); });
      roles.forEach(function (r, i) { r.r = i + 1; });      // 合并后名次重排
      guilds.sort(function (a, b) { return (guildPower(b) || 0) - (guildPower(a) || 0); });
      return {
        label: names.join(' + '),
        kind: 'agg',
        aggKind: 'cmp',
        cmp: 1,
        server: names.join(' + '),
        region: '多服对比',
        snapshot: snap,
        roles: roles,
        guilds: guilds,
        partial: 0,
        totalRoles: roles.length,
        totalGuilds: guilds.length
      };
    });
  }

  function startCompare() {
    if (PICK.length < 2) return;
    var v = viewById('cmp');
    if (!v) {
      v = { id: 'cmp', kind: 'agg', cmp: 1, region: '', label: '', short: '对比', n: 0 };
      VIEWS.splice(1, 0, v);        // 排在「全区全服」之后
    }
    // 先把名字填上，载入提示才是「正在合并 彼岸花 + 千秋月…」而不是空白
    var names = PICK.map(function (id) { return SRV_NAME[id] || id; });
    v.label = names.join(' + ');
    v.short = names.length > 2 ? (names.length + ' 服') : names.join('/');
    switchView('cmp');
  }

  function loadAggMeta() {
    if (AGG_META) return Promise.resolve(AGG_META);
    return loadScript('data/agg-meta.js').then(function () {
      AGG_META = window.__AGG_META || { servers: [], menpai: [], snapshot: '' };
      return AGG_META;
    });
  }

  // 聚合数据是定长数组（省 45% 体积），在这里还原成标准字段
  function decodeAgg(raw) {
    var SV = (AGG_META && AGG_META.servers) || [];
    var MP = (AGG_META && AGG_META.menpai) || [];
    var roles = (raw.roles || []).map(function (a) {
      return {
        r: a[0], ro: !!a[1], n: a[2], nh: !!a[3], fn: a[4] || [],
        rid: SV[a[5]], sv: SRV_NAME[SV[a[5]]] || SV[a[5]], m: MP[a[6]] || '未知',
        g: a[7] || '', gh: !!a[8], p: a[9], ph: !!a[10], pe: a[11],
        rm: a[12], t: a[13], pr: a[14], h: null
      };
    });
    var guilds = (raw.guilds || []).map(function (a) {
      return {
        g: a[0], rid: SV[a[1]], sv: SRV_NAME[SV[a[1]]] || SV[a[1]], tm: a[2], ov: a[3], oa: a[4],
        t80: a[5], a80: a[6], hp: a[7], ld: a[8], off: !!a[9], hpm: a[10],
        f: a[11] || []          // 每日变化（聚合数据里也带着）
      };
    });
    return {
      label: raw.label,
      kind: 'agg',              // 前端用它判断「跨服视图」
      aggKind: raw.kind,        // all / region
      server: raw.label,
      region: raw.kind === 'all' ? '全区' : raw.label,
      snapshot: (AGG_META && AGG_META.snapshot) || '',
      roles: roles,
      guilds: guilds,
      partial: raw.partial || 0,          // 1 = 只载入了首屏，其余还在后台拉
      totalRoles: raw.totalRoles || roles.length,
      totalGuilds: raw.totalGuilds || guilds.length
    };
  }

  // 全区全服首屏只有前 2000 名；其余在后台静默接着拉，拉完原地合并重绘。
  var REST_PENDING = {};
  function prefetchAggRest(id, data) {
    if (!data || !data.partial || REST_PENDING[id]) return;
    REST_PENDING[id] = true;
    loadScript('data/agg-all-rest.js').then(function () {
      var raw = window.__AGG_ALL_REST;
      if (!raw) return;
      var more = decodeAgg({ label: data.label, kind: data.kind, roles: raw.roles || [], guilds: raw.guilds || [] });
      data.roles = data.roles.concat(more.roles);
      data.guilds = data.guilds.concat(more.guilds);
      data.partial = 0;
      if (state.view === id && DB === data) {
        ROLES = data.roles;                 // 数组已被替换，必须同步引用
        GUILDS = data.guilds.slice();
        refresh();
      }
    }, function () { /* 拉不到就保持首屏，不影响使用 */ });
  }

  function loadView(id) {
    var v = viewById(id);
    if (!v) return Promise.reject(new Error('未知的视图'));
    if (v.cmp) {
      return buildCompareView(PICK.slice()).then(function (d) {
        var vv = viewById('cmp');
        if (vv) { vv.label = d.label; vv.n = d.roles.length; }
        return d;
      });
    }
    if (v.kind === 'srv') {
      var c = store()[id];
      if (c) return Promise.resolve(c);
      return loadScript('data/s-' + id + '.js').then(function () {
        var d = store()[id];
        if (!d) throw new Error('文件已载入但内容为空');
        return d;
      });
    }
    if (AGG_CACHE[id]) return Promise.resolve(AGG_CACHE[id]);
    return loadAggMeta().then(function () {
      var vname = '__AGG_' + id.replace(/-/g, '_').toUpperCase();
      return loadScript('data/agg-' + id + '.js').then(function () {
        var raw = window[vname];
        if (!raw) throw new Error('聚合数据为空');
        AGG_CACHE[id] = decodeAgg(raw);
        prefetchAggRest(id, AGG_CACHE[id]);
        return AGG_CACHE[id];
      });
    });
  }

  function setBusy(on, msg) {
    if (!on) return;
    $('resultLine').innerHTML = esc(msg || '载入中…');
    $('ledgerBody').innerHTML = '';
    $('podium').innerHTML = '';
    $('statStrip').innerHTML = '';
    $('pager').innerHTML = '';
    $('ledgerHead').innerHTML = '';
  }

  function renderHeader() {
    var v = viewById(state.view) || { label: '—', short: '—', kind: 'srv', region: '', id: '' };
    var snap = (DB && DB.snapshot) || META.snapshot || '—';
    var isAgg = v.kind === 'agg';
    var isCmp = !!v.cmp;
    $('snapshotLine').innerHTML = '数据来源于 <b>' + esc(snap) + '</b> · 全服 <b>' + fmt(META.total || 0) +
      '</b> 名角色 · <b>' + (META.servers || 0) + '</b> 个服务器';
    $('heroEyebrow').textContent = (isCmp ? '多服对比'
      : (isAgg ? (v.id === 'all' ? '全区全服' : '大区榜') : v.region)) +
      ' · ' + v.label + ' · ' + snap + ' 数据';
    $('btMain').textContent = isCmp ? '多服对比榜'
      : (isAgg ? (v.id === 'all' ? '全区全服功力榜' : v.label + '大区榜')
               : v.label + ' 功力榜');
    $('srvName').textContent = isCmp ? '对比' : v.short;
    $('footSnap').textContent = '数据来源于 ' + snap;
    var rm = $('riteMeta');
    if (rm) rm.textContent = (META.regions || 0) + ' 大区 ' + (META.servers || 0) + ' 服';
    var rc = $('riteCount');
    if (rc) rc.textContent = fmt(META.total || 0);
    document.title = v.label + ' · 天刀全服功力榜 — CY';
    document.body.classList.toggle('view-agg', isAgg);
  }

  function switchView(id, opts) {
    opts = opts || {};
    var v = viewById(id);
    if (!v) return;
    setBusy(true, v.cmp
      ? ('正在合并 ' + (v.label || (PICK.length + ' 个服')) + ' 的数据…（首次需下载这几个服的完整数据）')
      : ('正在载入 ' + v.label + ' 的数据…'));
    loadView(id).then(function (d) {
      DB = d;
      ROLES = d.roles || [];
      GUILDS = (d.guilds || []).slice();
      state.view = id;
      IS_AGG = (d.kind === 'agg');
      RATING = null;              // 评级依赖当前视图的分布，换视图必须重算
      recomputeDerived();

      state.page = 1;
      state.q = '';
      state.menpai = '';
      state.guild = '';
      state.tier = '';
      state.sort = state.board === 'power' ? 'rank' : 'ov';
      $('q').value = '';
      $('findClear').hidden = true;
      try { localStorage.setItem('view', v.cmp ? '' : id); } catch (e) {}

      renderHeader();
      renderStats();
      renderPodium();
      renderChips();
      refresh();
      markCurrentServer();
    }, function (err) {
      var hint = v.kind === 'agg'
        ? '（聚合数据较大，请确认 data/agg-*.js 可访问）'
        : '（若你是把网页下载到本地双击打开的，请确认 data 文件夹与本文件在同一层）';
      $('resultLine').innerHTML = '<b style="color:var(--warn)">数据载入失败</b>：' +
        esc(err.message) + hint;
    });
  }

  function renderServerPicker() {
    var html = '';
    var lastRegion = undefined;
    VIEWS.forEach(function (v) {
      if (v.cmp) return;                       // 「对比」不是可选的目标，由勾选生成
      var isRegionHead = (v.kind === 'agg' && v.id !== 'all');
      if (v.region !== lastRegion) {
        if (lastRegion !== undefined) html += '</div>';
        html += '<div class="srv-group">' +
          (v.region ? '<div class="srv-group-title">' + esc(v.region) + '</div>' : '');
        lastRegion = v.region;
      }
      var picked = PICK.indexOf(v.id) >= 0;
      var cls = 'srv-item' + (v.kind === 'agg' ? ' is-agg' : '') + (picked ? ' is-picked' : '');
      var tag = v.id === 'all' ? '<span class="srv-tag">全部</span>'
              : (isRegionHead && !/大区$/.test(v.short) ? '<span class="srv-tag">大区</span>' : '');
      // 单服右侧给一个勾选钮，用来多选对比
      var pick = v.kind === 'srv'
        ? '<span class="srv-pick' + (picked ? ' is-on' : '') + '" data-pick="' + esc(v.id) + '"' +
          ' role="checkbox" aria-checked="' + picked + '" title="加入对比">' + (picked ? '✓' : '+') + '</span>'
        : '';
      html += '<button type="button" class="' + cls + '" role="option" data-srv="' + esc(v.id) + '">' +
        '<span class="srv-item-name">' + esc(v.kind === 'agg' ? v.short : v.label) + tag + '</span>' +
        pick +
        '<span class="srv-item-n">' + fmt(v.n) + '</span></button>';
    });
    if (lastRegion !== undefined) html += '</div>';

    // 底部对比操作栏
    var hint = PICK.length >= 2 ? '已选 ' + PICK.length + ' 个服'
             : (PICK.length === 1 ? '再选 1 个服就能对比' : '点右侧 + 可多选对比（2~' + CMP_MAX + ' 个）');
    html += '<div class="srv-cmp-bar">' +
      '<span class="srv-cmp-hint">' + esc(hint) + '</span>' +
      '<button type="button" class="srv-cmp-btn" data-cmp="go"' + (PICK.length < 2 ? ' disabled' : '') + '>' +
      (PICK.length >= 2 ? '开始对比' : '对比') + '</button></div>';

    $('srvMenu').innerHTML = html;
  }

  function markCurrentServer() {
    var items = document.querySelectorAll('.srv-item');
    Array.prototype.forEach.call(items, function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-srv') === state.view);
    });
  }

  function toggleServerMenu(force) {
    var menu = $('srvMenu'), btn = $('srvBtn');
    var open = (force === undefined) ? menu.hidden : force;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) markCurrentServer();
  }

  function init() {
    if (!SRV_LIST.length) {
      $('resultLine').innerHTML = '<b style="color:var(--warn)">服务器清单载入失败</b>：请确认 data/servers.js 可以访问。';
      return;
    }
    VIEWS = buildViews();
    loadPick();
    renderServerPicker();
    renderHeader();
    bind();
    petals();

    // 默认：上次选择 → 全区全服
    var saved = '';
    try { saved = localStorage.getItem('view') || ''; } catch (e) {}
    var pick = (saved && viewById(saved)) || viewById('all') || VIEWS[0];
    switchView(pick.id);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
