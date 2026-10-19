"""把 S-03 模擬盤結果寫成 paper.json，給網站「模擬盤」分頁讀（由 .github/workflows/klines.yml 每 15 分鐘執行）。
用法：python3 scripts/paper.py <K 線資料夾>；結果寫在同一個資料夾的 paper.json。
s03_live.py 是投資組腳本的複本，這裡只讀它算完的變數，不改規則。"""
import contextlib, io, json, os, runpy, sys, time

D = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
sys.argv = [os.path.join(HERE, 's03_live.py'), D]
with contextlib.redirect_stdout(io.StringIO()):
    g = runpy.run_path(sys.argv[0], run_name='__main__')
t, P = g['t'], g['P']
tw = lambda x: (x + g['pd'].Timedelta(hours=8)).strftime('%Y-%m-%d %H:%M')
market = {}
for s, d in P.items():
    market[s] = dict(price=round(float(d['c'][-1]), 2), h4_ema200=round(float(d['h4e200']), 2), above_h4=bool(d['h4c'] > d['h4e200']),
                     d1_ema50=round(float(d['d1e50']), 2), above_d1=bool(d['d1c'] > d['d1e50']), high24=round(float(d['hh'][-1]), 2))
out = dict(
    strategy='S-03 突破確認（10/15 07:17 版）',
    start=tw(g['PAPER_START']),
    updated=time.strftime('%Y-%m-%d %H:%M', time.gmtime(time.time() + 8 * 3600)),
    last_bar=tw(t[-1]),
    equity=round(float(g['eq']), 6),
    positions=g['pos'], closed=g['closed'],
    signals24=[dict(sym=s, time=x[:16], stop=float(stp)) for s, x, stp in g['rec24']],
    market=market,
)
with open(os.path.join(D, 'paper.json'), 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print('paper.json：權益', out['equity'], '持倉', len(out['positions']), '已平倉', len(out['closed']))
