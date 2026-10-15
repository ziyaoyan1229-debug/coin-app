"""抓 BTC、ETH 的 15 分／5 分 K 線寫成 CSV（給投資組模擬盤用，由 .github/workflows/klines.yml 每 15 分鐘執行）。
只用標準函式庫。來源 data-api.binance.vision（現貨），只保留已收盤的 K 棒。"""
import csv, json, os, sys, time, urllib.request

API = 'https://data-api.binance.vision/api/v3/klines'
SYMBOLS = ['BTCUSDT', 'ETHUSDT']
JOBS = [('15m', 15 * 60, 120), ('5m', 5 * 60, 3)]  # (週期, 秒數, 保留天數)
OUT = sys.argv[1] if len(sys.argv) > 1 else 'data'


def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if i == 3:
                raise
            print('retry', url, e)
            time.sleep(2 ** i)


def fetch(sym, iv, step, days):
    now = int(time.time() * 1000)
    start = now - days * 86400 * 1000
    rows, t = [], start
    while True:
        j = get(f'{API}?symbol={sym}&interval={iv}&startTime={t}&limit=1000')
        if not j:
            break
        rows += j
        if len(j) < 1000:
            break
        t = j[-1][0] + step * 1000
    seen, out = set(), []
    for r in rows:
        if r[0] in seen or r[6] >= now:  # 去重、丟掉還沒收盤的那根
            continue
        seen.add(r[0])
        out.append([r[0], r[1], r[2], r[3], r[4], r[5], r[9]])
    return out


os.makedirs(OUT, exist_ok=True)
for sym in SYMBOLS:
    for iv, step, days in JOBS:
        rows = fetch(sym, iv, step, days)
        if len(rows) < days * 86400 // step * 0.9:
            sys.exit(f'{sym} {iv} 只抓到 {len(rows)} 根，資料不足，不更新')
        path = os.path.join(OUT, f'{sym}_{iv}.csv')
        with open(path, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['open_time', 'open', 'high', 'low', 'close', 'volume', 'taker_buy_base'])
            w.writerows(rows)
        print(path, len(rows), 'rows, last', time.strftime('%Y-%m-%d %H:%M', time.gmtime(rows[-1][0] / 1000)), 'UTC')
