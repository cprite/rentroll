# Sprint 11 test helper: print the visible text of chosen <section id=...> blocks (or the flash) of a tenant page.
import re, sys, html
doc = open(sys.argv[1], encoding='utf-8').read()
def text(s): return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip()
for sid in sys.argv[2:]:
    if sid == 'flash':
        m = re.search(r'<div class="flash[^"]*"[^>]*>(.*?)</div>', doc, re.S)
    else:
        m = re.search(r'<section[^>]*id="%s"[^>]*>(.*?)</section>' % re.escape(sid), doc, re.S)
    print('  [%s] %s' % (sid, text(m.group(1)) if m else '(absent)'))
