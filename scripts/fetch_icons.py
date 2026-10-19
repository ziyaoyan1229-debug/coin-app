"""幫 scripts/markets.json 的每個標的抓一張圖示存到 data/icons/<代號>.png／.svg（已經有的就不再抓）。給網站「查看價格」卡片用。
幣：CoinCap → spothq cryptocurrency-icons；美股：Financial Modeling Prep 公開 logo。原物料網站自己畫，不用抓。"""
import json, os, sys, urllib.request

OUT = os.path.join(sys.argv[1] if len(sys.argv) > 1 else 'data', 'icons')
MK = json.load(open(os.path.join(os.path.dirname(__file__), 'markets.json')))
os.makedirs(OUT, exist_ok=True)


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        b = r.read()
        if r.status != 200 or len(b) < 200:
            raise ValueError('bad')
        return b


got, miss = 0, []
for m in MK:
    s = m['s']
    if any(os.path.exists(os.path.join(OUT, s + e)) for e in ('.png', '.svg')):
        continue
    if m['cat'] == '原物料':
        continue
    src = ([(f'https://assets.coincap.io/assets/icons/{s.lower()}@2x.png', '.png'),
            (f'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/{s.lower()}.svg', '.svg'),
            (f'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/{s.lower()}.png', '.png')]
           if m['src'] == 'bn' else [(f'https://financialmodelingprep.com/image-stock/{s}.png', '.png')])
    for url, ext in src:
        try:
            b = get(url)
        except Exception:
            continue
        open(os.path.join(OUT, s + ext), 'wb').write(b)
        got += 1
        break
    else:
        miss.append(s)
have = sorted(f for f in os.listdir(OUT))
json.dump(have, open(os.path.join(OUT, 'index.json'), 'w'))
print('新抓', got, '張；共', len(have) - ('index.json' in have), '張；抓不到：', ','.join(miss) or '無')
