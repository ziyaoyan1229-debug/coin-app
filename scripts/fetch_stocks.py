"""抓 MSTR、MSTU 的美股盤中 1 小時 K 線寫成 CSV（給網站 MSTR／MSTU 的 1H、4H 用，由 .github/workflows/klines.yml 每 15 分鐘執行）。
只用標準函式庫。來源 Yahoo Finance chart API（只有正常交易時段，每天 7 根：9:30、10:30…15:30 美東；最後一根盤中會一直更新）。"""
import csv, json, os, sys, time, urllib.request

URL = 'https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=60m&range=730d&includePrePost=false'
SYMBOLS = ['MSTR', 'MSTU']
OUT = sys.argv[1] if len(sys.argv) > 1 else 'data'


def get(url):
    for i in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if i == 3:
                raise
            print('retry', url, e)
            time.sleep(2 ** i)


os.makedirs(OUT, exist_ok=True)
for sym in SYMBOLS:
    res = get(URL.format(sym))['chart']['result'][0]
    q = res['indicators']['quote'][0]
    rows = []
    for k, t in enumerate(res.get('timestamp') or []):
        o, h, l, c, v = (q[x][k] for x in ('open', 'high', 'low', 'close', 'volume'))
        if None in (o, h, l, c):
            continue
        rows.append([t * 1000, round(o, 4), round(h, 4), round(l, 4), round(c, 4), int(v or 0)])
    if len(rows) < 500:
        sys.exit(f'{sym} 只抓到 {len(rows)} 根，資料不足，不更新')
    path = os.path.join(OUT, f'{sym}_1h.csv')
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['open_time', 'open', 'high', 'low', 'close', 'volume'])
        w.writerows(rows)
    print(path, len(rows), 'rows, last', time.strftime('%Y-%m-%d %H:%M', time.gmtime(rows[-1][0] / 1000)), 'UTC')
