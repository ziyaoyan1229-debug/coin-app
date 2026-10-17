"""抓 scripts/markets.json 列的所有標的日 K，寫成 data/d/<代號>.csv 和 data/d/index.json（給網站「查看價格」的更多幣種用，由 .github/workflows/klines.yml 每 15 分鐘執行）。
只用標準函式庫。幣：Binance 現貨 data-api.binance.vision（USDT 交易對）；美股、原物料：Yahoo Finance（期貨用連續近月合約 GC=F、SI=F、CL=F、BZ=F）。
最後一根是今天還沒收完的 K 棒，會一直更新。舊檔在就只抓最近幾天接上去，沒有才抓全部歷史；某個標的抓不到就沿用舊檔。"""
import csv, json, os, sys, time, urllib.request

OUT = os.path.join(sys.argv[1] if len(sys.argv) > 1 else 'data', 'd')
MK = json.load(open(os.path.join(os.path.dirname(__file__), 'markets.json')))
BN = 'https://data-api.binance.vision/api/v3/klines'
YF = 'https://{}.finance.yahoo.com/v8/finance/chart/{}?interval=1d&{}'
DAY = 86400


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1 or getattr(e, 'code', 0) in (400, 404, 422):
                raise
            time.sleep(2 ** i)


def num(x):
    return float(f'{x:.6g}')


def bn(m, since):
    rows, t = [], since * 1000
    while True:
        j = get(f"{BN}?symbol={m['s']}USDT&interval=1d&startTime={t}&limit=1000")
        if not j:
            break
        rows += [[r[0] // 1000, num(float(r[1])), num(float(r[2])), num(float(r[3])), num(float(r[4])), round(float(r[7]))] for r in j]   # 量用 USDT 成交額
        if len(j) < 1000:
            break
        t = j[-1][0] + DAY * 1000
    return rows


def yf(m, since):
    rng = 'range=max' if since == 0 else 'range=1mo'
    res = None
    for host in ('query1', 'query2'):
        try:
            res = get(YF.format(host, urllib.request.quote(m['yf']), rng))['chart']['result'][0]
            break
        except Exception as e:
            print(m['s'], host, '失敗：', e)
    if res is None:
        return []
    q, rows = res['indicators']['quote'][0], []
    for k, t in enumerate(res.get('timestamp') or []):
        o, h, l, c, v = (q[x][k] for x in ('open', 'high', 'low', 'close', 'volume'))
        if None in (o, h, l, c) or c <= 0:
            continue
        rows.append([t // DAY * DAY, num(o), num(h), num(l), num(c), round(v or 0)])
    return rows


def load(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [[int(r[0])] + [float(x) for x in r[1:5]] + [float(r[5])] for r in csv.reader(f) if r and r[0].isdigit()]


os.makedirs(OUT, exist_ok=True)
idx, bad = [], []
for m in MK:
    path = os.path.join(OUT, m['s'] + '.csv')
    old = load(path)
    since = old[-3][0] if len(old) > 3 else 0
    try:
        new = (bn if m['src'] == 'bn' else yf)(m, since)
    except Exception as e:
        print(m['s'], '抓不到：', e)
        new = []
    by = {r[0]: r for r in old}
    for r in new:
        by[r[0]] = r
    rows = [by[k] for k in sorted(by)]
    if not rows:
        bad.append(m['s'])
        continue
    if new:
        with open(path, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['day', 'open', 'high', 'low', 'close', 'volume'])
            w.writerows(rows)
    else:
        bad.append(m['s'])
    last, prev = rows[-1], rows[-2] if len(rows) > 1 else rows[-1]
    idx.append({'s': m['s'], 'name': m['name'], 'cat': m['cat'], 'src': m['src'], 'px': last[4], 'ch': round(last[4] / prev[4] - 1, 5), 't0': rows[0][0], 't1': last[0], 'n': len(rows)})
    if m['src'] == 'yf':
        time.sleep(0.3)
json.dump({'updated': int(time.time()), 'list': idx}, open(os.path.join(OUT, 'index.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(idx), '檔完成', ('；抓不到（沿用舊檔或略過）：' + ','.join(bad)) if bad else '')
if len(idx) < len(MK) // 2:
    sys.exit('一半以上抓不到，視為失敗')
