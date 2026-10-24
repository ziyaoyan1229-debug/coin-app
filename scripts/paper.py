"""把模擬盤結果寫成 paper.json（由 .github/workflows/klines.yml 每 15 分鐘執行）。10/24 起是規則 5（S-04＋S-07），S-03、S-01b 只記訊號。
用法：python3 scripts/paper.py <K 線資料夾>；結果寫在同一個資料夾的 paper.json。
規則在 s03_live.py，這裡只讀它算完的變數，不改規則。"""
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
    strategy='規則 5：S-04＋S-07 可疊單、三段式出場 X5、每筆 2%、總風險 ≤10%（10/24 起；18:22 改倉位規則）',
    start=tw(g['PAPER_START']),
    updated=time.strftime('%Y-%m-%d %H:%M', time.gmtime(time.time() + 8 * 3600)),
    last_bar=tw(t[-1]),
    equity=round(float(g['eq']), 6),               # 已實現（每段成交當下記帳）
    equity_mtm=round(float(g['eq_mtm']), 6),       # 含持倉浮動
    open_risk=round(float(g['open_risk']), 4), max_dd=round(float(g['mdd']), 4),
    positions=g['pos'], closed=g['closed'], skipped=g['skipped'],
    curve=g['curve'][-360:],                       # 每根 4h 收盤的 [時間, 已實現, 含浮動]
    watch=g['watch'],                              # 觀察卡 S-03、S-01b 的訊號（不算部位）
    signals24=[dict(sym=s, time=x[:16], stop=float(stp)) for s, x, stp in g['rec24']],
    market=market,
)
with open(os.path.join(D, 'paper.json'), 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print('paper.json：權益', out['equity'], '含浮動', out['equity_mtm'], '持倉', len(out['positions']), '已平倉', len(out['closed']))
