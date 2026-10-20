#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从源文件构建 template.html
==========================
把 index.html 的骨架 + style.css + app.js 合成一份「内联样式与逻辑、只留数据占位符」的模板，
供 update.py 每次填充最新数据使用。

用法：python3 build_template.py
"""

import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))


def read(name):
    with open(os.path.join(BASE, name), encoding='utf-8') as f:
        return f.read()


def main():
    html = read('index.html')
    css = read('style.css')
    app = read('app.js')

    # 1) CSS 内联
    link_tag = '<link rel="stylesheet" href="./style.css" />'
    if link_tag not in html:
        raise SystemExit('index.html 中未找到 CSS 引用标签')
    html = html.replace(link_tag, '<style>\n' + css + '\n</style>')

    # 2) 数据脚本位 + app.js 内联
    m = re.search(r'<script src="\./data/servers\.js[^"]*"></script>\s*<script src="\./app\.js" defer></script>', html)
    if not m:
        raise SystemExit('index.html 中未找到脚本引用标签')
    # servers.js 保持外链（数据清单，每日更新，带 ?v= 破缓存）；app.js 内联
    srv_tag = re.search(r'<script src="\./data/servers\.js[^"]*"></script>', html).group(0)
    new_scripts = srv_tag + '\n<script>\n' + app + '\n</script>'
    html = html.replace(m.group(0), new_scripts)

    # 3) 去掉 Google Fonts 外链（改走系统字体栈，保证离线/国内可用）
    html = re.sub(r'[ \t]*<link rel="preconnect"[^>]*>\n?', '', html)
    html = re.sub(r'[ \t]*<link href="https://fonts\.googleapis\.com[^>]*>\n?', '', html)

    # 4) 校验：必须零外部依赖
    for bad in ('href="./style.css"', 'src="./app.js"', 'fonts.googleapis'):
        if bad in html:
            raise SystemExit('仍有外部依赖残留: ' + bad)
    if 'src="./data/servers.js' not in html:
        raise SystemExit('缺少服务器清单引用')

    out = os.path.join(BASE, 'template.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print('template.html 构建完成: %d bytes' % len(html.encode('utf-8')))


if __name__ == '__main__':
    main()
