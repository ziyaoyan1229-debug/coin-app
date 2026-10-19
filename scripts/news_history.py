"""把每一版市場分析（news.json 的 market）存成歷史，給網站「過去分析」用（由 .github/workflows/klines.yml 每 15 分鐘執行）。
用法：python3 scripts/news_history.py <news.json> <K 線資料夾> <舊的 news_history.json 或空字串>
同一個 updated 只存一次；順便記當時 BTC 價格與 24 小時後的價格，看判斷準不準。只用標準函式庫。"""
import csv, json, os, re, sys, time, calendar

NEWS, D, OLD = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else '')
KEEP = 300
bars = []
with open(os.path.join(D, 'BTCUSDT_15m.csv')) as f:
    for r in csv.DictReader(f):
        bars.append((int(r['open_time']) // 1000 + 900, float(r['close'])))  # 收盤時間（秒）、收盤價


def price_at(ts):
    """ts（UTC 秒）當下或之前最後一根已收盤 K 的收盤價；超出資料範圍回 None。"""
    if not bars or ts < bars[0][0] or ts > bars[-1][0] + 900:
        return None
    lo, hi = 0, len(bars) - 1
    while lo < hi:
        m = (lo + hi + 1) // 2
        if bars[m][0] <= ts:
            lo = m
        else:
            hi = m - 1
    return bars[lo][1]


def parse_tw(s):
    m = re.match(r'(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})', s or '')
    if not m:
        return None
    y, mo, d, h, mi = map(int, m.groups())
    return calendar.timegm((y, mo, d, h, mi, 0)) - 8 * 3600


hist = []
if OLD and os.path.exists(OLD) and os.path.getsize(OLD):
    try:
        hist = json.load(open(OLD))
    except Exception:
        hist = []
m = json.load(open(NEWS)).get('market') or {}
if m.get('updated') and not any(h['updated'] == m['updated'] for h in hist):
    hist.append(dict(updated=m['updated'], bias=m.get('bias', ''), title=m.get('title', ''), body=m.get('body', '')))
for h in hist:
    ts = parse_tw(h['updated'])
    if ts is None:
        continue
    if h.get('btc') is None:
        h['btc'] = price_at(ts)
    if h.get('btc24') is None and time.time() >= ts + 86400:
        h['btc24'] = price_at(ts + 86400)
hist = sorted(hist, key=lambda h: h['updated'])[-KEEP:]
with open(os.path.join(D, 'news_history.json'), 'w') as f:
    json.dump(hist, f, ensure_ascii=False, indent=0)
print('news_history.json：', len(hist), '筆')
