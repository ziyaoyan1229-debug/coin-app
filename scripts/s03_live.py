# 模擬盤每 15 分鐘檢查（2026-10-24 版）。原本是投資組 /mnt/project-files/finance/模擬盤/s03_live.py 的複本，10/24 起改成規則 5。
"""模擬盤：規則 5（線 5 組合規則，見 finance/投資研究計畫.md「今日可用規則」第 5 條，10/24 00:00 台北起）。
用法：python3 s03_live.py <data 目錄>（含 BTCUSDT_15m.csv 等四檔，來自 coin-app 的 data 分支）

算部位：S-04、S-07（BTC、ETH，4h K 由 15 分 K 合成，只用已收完的 4h K）
  - 每張卡各自開單：同幣同一張卡同時只持一張，S-04、S-07 可疊單；帳戶同時開著的總風險 ≤15%，超過就不開。
  - 出場三段式 X5：到 1R 出 1/2；第 3 根起 4h 收破 EMA20 出 1/4（1R 還沒到時那 1/2 也一起出）；
    最後 1/4 在第 3 根起、每天最後一根 4h 收盤跌破日線 EMA50 出，最長 360 根（60 天）。碰停損全出。
  - 每筆風險 3%；回撤 >15% 減半、>30% 剩 1/5（回撤含持倉浮動）。
  - 成本照回測實盤化版（backtest/l5_audit.py）：手續費每邊 0.075%、進場與停損各多 0.05% 滑價、跳空停損按開盤價、資金費每 8 小時 0.01%。
  - 損益在每一段實際成交的那根 K 記進權益（不是進場時就把整筆最後損益記進去）。
只記訊號、不算部位（10/24 起降為觀察）：S-03（15 分 K 突破確認）、S-01b（4h 急殺回收）。"""
import sys, os, numpy as np, pandas as pd
D = sys.argv[1]
PAPER_START = pd.Timestamp(os.environ.get("PAPER_START", "2026-10-23 16:00"))  # UTC＝10/24 00:00 台北；4h K 收盤時間 ≥ 這個才開單
FEE, SLIP, FUND = 0.00075, 0.0005, 0.0001
RISK = {"S-04": 0.03, "S-07": 0.03}; RISK_CAP = 0.15; HOLD = 360; CONF_MULT = 14.7
TW = lambda x: (x + pd.Timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")

def load(f):
    df = pd.read_csv(os.path.join(D, f)); df.index = pd.to_datetime(df.open_time, unit="ms")
    return df.rename(columns={"volume": "v"})[["open", "high", "low", "close", "v"]].set_axis(list("ohlcv"), axis=1)
B, E = load("BTCUSDT_15m.csv"), load("ETHUSDT_15m.csv"); idx = B.index.intersection(E.index); B, E = B.loc[idx], E.loc[idx]; t = idx; n = len(t)

def ema(v, k):
    a, e, o = 2/(k+1), v[0], []
    for x in v: e = x*a + e*(1-a); o.append(e)
    return o

# ---------- 15 分 K：市場概況＋S-03 訊號（只記錄） ----------
def prep(b):
    o, h, l, c, v = [b[x].values for x in "ohlcv"]
    h4 = b.c.resample("4h").last(); d1 = b.c.resample("1D").last(); e50 = d1.ewm(span=50, adjust=False).mean()
    d = dict(o=o, h=h, l=l, c=c, v=v)
    d["up4"] = (h4 > h4.ewm(span=200, adjust=False).mean()).shift(1).reindex(t, method="ffill").values == True
    d["upd"] = (d1 > e50).shift(1).reindex(t.normalize()).values == True
    d["hh"] = pd.Series(h).rolling(96).max().shift(1).values; d["vm"] = pd.Series(v).rolling(96).median().shift(1).values
    d["d1c"], d["d1e50"] = d1.iloc[-1], e50.iloc[-1]; d["h4c"], d["h4e200"] = h4.iloc[-1], h4.ewm(span=200, adjust=False).mean().iloc[-1]
    return d
P = {"BTC": prep(B), "ETH": prep(E)}

def s03_signals(sym):
    d = P[sym]; c, l, v, hh, vm = d["c"], d["l"], d["v"], d["hh"], d["vm"]; out = []
    for i in range(200, n-3):
        if not (c[i] > hh[i] and c[i-1] <= hh[i-1]): continue
        if not ((c[i+1:i+4] > hh[i]).all() and v[i+1:i+4].sum() >= vm[i]*CONF_MULT): continue
        if sym == "BTC" and not (d["up4"][i] and d["upd"][i]): continue
        if not (v[i-32:i].mean() < 0.8*v[i-96:i-32].mean() and l[i-32:i].min() >= l[i-96:i-32].min()): continue
        out.append((i+3, min(hh[i]*0.997, l[i+1:i+4].min()*0.999), i))
    return out
SIG = {s: s03_signals(s) for s in P}

# ---------- 4h K（由 15 分 K 合成，只留 16 根都到齊的） ----------
def to4h(b):
    g = b.resample("4h"); x = pd.DataFrame(dict(o=g.o.first(), h=g.h.max(), l=g.l.min(), c=g.c.last(), v=g.v.sum(), k=g.c.count()))
    return x[x.k == 16].drop(columns="k")
H = {"BTC": to4h(B), "ETH": to4h(E)}
h4i = H["BTC"].index.intersection(H["ETH"].index); H = {s: H[s].loc[h4i] for s in H}; m = len(h4i)
DAY = pd.Timedelta(days=1)

def pivots(h, l, k=3):
    lo = [i for i in range(k, len(h)-k) if all(l[i] < l[j] for j in range(i-k, i+k+1) if j != i)]
    hi = [i for i in range(k, len(h)-k) if all(h[i] > h[j] for j in range(i-k, i+k+1) if j != i)]
    return lo, hi

def cards(x):
    """回傳 {卡: [(i, 停損基準)]}，i 是 4h K 位置（收盤進場）。和 backtest/l5_step1_portfolio.py 的 cards() 同一套條件。"""
    o, h, l, c, v = [list(x[k].values) for k in "ohlcv"]; e200 = ema(c, 200); N = len(c)
    s04, s07c, s01 = [], [], []; last4 = -99
    lo, hi = pivots(h, l); hl = [False]*N; lp = hp = 0; los, his = [], []
    for i in range(N):
        while lp < len(lo) and lo[lp] <= i-3: los.append(lo[lp]); lp += 1   # 樞紐要等右邊 3 根收完
        while hp < len(hi) and hi[hp] <= i-3: his.append(hi[hp]); hp += 1
        if len(los) >= 2 and his and l[los[-1]] > l[los[-2]]: hl[i] = c[i] >= (l[los[-1]] + h[his[-1]])/2
    for i in range(200, N):
        avg20 = sum(v[i-20:i])/20
        if c[i]/c[i-1]-1 >= 0.015 and v[i] >= 2*avg20 and i-last4 >= 6:
            last4 = i
            if c[i] > e200[i]: s04.append((i, min(l[i-5:i+1])))
        if c[i] > o[i] and v[i] >= 1.5*avg20 and hl[i] and c[i] > e200[i] and c[i] > max(c[i-30:i]): s07c.append(i)
        body = abs(c[i]-o[i]); lw = min(o[i], c[i]) - l[i]
        if l[i]/c[i-1]-1 <= -0.07 and v[i] >= 2*avg20 and lw >= 2*max(body, 1e-9): s01.append((i, l[i]))
    s07, lst = [], -99
    for i in s07c:
        if i - lst >= 6: s07.append((i, l[i])); lst = i
    return {"S-04": s04, "S-07": s07, "S-01b": s01}
CARDS = {s: cards(H[s]) for s in H}

# ---------- 規則 5 模擬盤（照 backtest/l5_audit.py engine 的實盤化版，逐根記帳） ----------
pre = {}
for s in H:
    x = H[s]; c = list(x.c.values); dd = x.index.floor("1D")
    last = [i == m-1 or dd[i+1] != dd[i] for i in range(m)]   # 每天（UTC）最後一根 4h
    e, d50 = None, []
    for i in range(m):
        if last[i]: e = c[i] if e is None else c[i]*2/51 + e*(1-2/51)
        d50.append(e)
    pre[s] = dict(o=list(x.o.values), h=list(x.h.values), l=list(x.l.values), c=c, e20=ema(c, 20), last=last, d50=d50,
                  at={i: [(k, sl) for k in RISK for j, sl in CARDS[s][k] if j == i] for i in range(m)})
closet = lambda i: h4i[i] + pd.Timedelta(hours=4)
eq = peak = 1.0; mdd = 0.0; units = []; closed = []; skipped = []; curve = []
for j in range(m):
    for u in list(units):
        p = pre[u["s"]]
        if j <= u["i"]: continue
        fee = u["q"]*u["e"]*FUND/2*u["w"]; eq -= fee; u["pnl"] -= fee                        # 每根 4h 付半個 8 小時資金費
        out = []
        if p["l"][j] <= u["stop"]:
            out = [(u["w"], min(u["stop"], p["o"][j])*(1-SLIP), "停損")]; u["parts"] = []
        else:
            nxt = []
            for w, rule in u["parts"]:
                if rule == "r1" and p["h"][j] >= u["e"]+u["R"]: out.append((w, u["e"]+u["R"], "到 1R")); continue
                if rule in ("e20", "r1") and j-u["i"] >= 3 and p["c"][j] < p["e20"][j]: out.append((w, p["c"][j], "收破 4h EMA20")); continue
                if rule == "d50" and p["last"][j] and j-u["i"] >= 3 and p["c"][j] < p["d50"][j]: out.append((w, p["c"][j], "日線收破 EMA50")); continue
                nxt.append((w, rule))
            u["parts"] = nxt
            if j-u["i"] >= HOLD: out += [(w, p["c"][j], "滿 60 天") for w, _ in nxt]; u["parts"] = []
        for w, px, why in out:
            g = u["q"]*w*(px-u["e"]) - u["q"]*w*px*FEE; eq += g; u["pnl"] += g; u["w"] -= w
            f = u["fills"][-1] if u["fills"] and u["fills"][-1]["時間"] == TW(closet(j)) and u["fills"][-1]["原因"] == why else None
            if f: f["比例"] += w; f["_g"] += g; f["損益佔起始權益"] = f"{f['_g']:+.2%}"; continue    # 同一根同原因（1R 還沒到就收破 EMA20）併成一筆
            u["fills"].append(dict(時間=TW(closet(j)), 原因=why, 比例=w, 價格=round(float(px), 2), 損益佔起始權益=f"{g:+.2%}", _g=g))
        if not u["parts"]: u["j"] = j; units.remove(u); closed.append(u)
    for s in H:
        p = pre[s]
        for k, sl in p["at"][j]:
            if closet(j) < PAPER_START or any(u["s"] == s and u["card"] == k for u in units): continue
            e = p["c"][j]*(1+SLIP); stop = sl*0.997; R = e-stop
            if R <= 0: continue
            mtm = eq + sum(u["q"]*u["w"]*(pre[u["s"]]["c"][j]-u["e"]) for u in units); peak = max(peak, mtm)
            ddv = (peak-mtm)/peak; kk = 0.2 if ddv > 0.30 else 0.5 if ddv > 0.15 else 1
            stake = eq*RISK[k]*kk
            if sum(u["stake"] for u in units) + stake > RISK_CAP*eq + 1e-12:
                skipped.append(dict(幣=s, 卡=k, 時間=TW(closet(j)), 原因="帳戶總風險會超過 15%")); continue
            q = stake/R; f0 = q*e*FEE; eq -= f0
            units.append(dict(s=s, card=k, i=j, e=e, stop=stop, R=R, q=q, stake=stake, w=1.0, parts=[(.5, "r1"), (.25, "e20"), (.25, "d50")],
                              pnl=-f0, fills=[], kk=kk))
    mtm = eq + sum(u["q"]*u["w"]*(pre[u["s"]]["c"][j]-u["e"]) for u in units); peak = max(peak, mtm); mdd = max(mdd, (peak-mtm)/peak)
    if closet(j) >= PAPER_START: curve.append((TW(closet(j)), round(eq, 6), round(mtm, 6)))

def rec(u):
    p = pre[u["s"]]; r = dict(幣=u["s"], 卡=u["card"], 進場時間=TW(closet(u["i"])), 進場價=round(float(u["e"]), 2), 停損=round(float(u["stop"]), 2),
                             一R=round(float(u["R"]), 2), 風險=f"{u['stake']:.2%}", 部位價值佔權益=f"{u['q']*u['e']:.0%}",
                             分批=[{k: v for k, v in f.items() if k != "_g"} for f in u["fills"]])
    if "j" in u: r["出場時間"] = TW(closet(u["j"])); r["損益佔起始權益"] = f"{u['pnl']:+.2%}"
    else:
        up = u["q"]*u["w"]*(p["c"][-1]-u["e"])
        r["剩餘比例"] = u["w"]; r["已實現佔起始權益"] = f"{u['pnl']:+.2%}"; r["未實現佔起始權益"] = f"{up:+.2%}"
    return r
pos = [rec(u) for u in units]; closed = [rec(u) for u in closed]
eq_mtm = eq + sum(u["q"]*u["w"]*(pre[u["s"]]["c"][-1]-u["e"]) for u in units)
open_risk = sum(u["stake"] for u in units)

# ---------- 觀察訊號（不算部位） ----------
watch = [dict(卡="S-03", 幣=s, 時間=TW(t[e]), 停損=round(float(stp), 2)) for s in SIG for e, stp, _ in SIG[s] if t[e] >= PAPER_START]
watch += [dict(卡="S-01b", 幣=s, 時間=TW(closet(i)), 停損=round(float(sl)*0.997, 2)) for s in CARDS for i, sl in CARDS[s]["S-01b"] if closet(i) >= PAPER_START]
watch.sort(key=lambda x: x["時間"])
rec24 = [(s, str(t[e]+pd.Timedelta(hours=8)), round(stp, 2)) for e, s, stp in sorted([(e, s, stp) for s in SIG for e, stp, _ in SIG[s]]) if t[e] >= t[-1]-pd.Timedelta(hours=24)]

if __name__ == "__main__":
    print(f"資料最後一根：{t[-1]+pd.Timedelta(hours=8)} 台北（15 分 K 開盤時間）｜最後一根收完的 4h：{TW(closet(m-1))} 收")
    for s in P:
        d = P[s]; print(f"{s} 現價 {d['c'][-1]:.2f}｜4h EMA200 {d['h4e200']:.0f}（{'上' if d['h4c'] > d['h4e200'] else '下'}）｜日線 EMA50 {d['d1e50']:.0f}（{'上' if d['d1c'] > d['d1e50'] else '下'}）")
    print(f"規則 5 模擬盤（起始 1.0，自 {TW(PAPER_START)} 起）：已實現權益 {eq:.4f}｜含浮動 {eq_mtm:.4f}｜開著的風險 {open_risk:.2%}｜含浮動最大回撤 {mdd:.1%}")
    print("持倉：", pos if pos else "無")
    print("已平倉：", closed if closed else "無")
    print("因風險上限沒開：", skipped if skipped else "無")
    print("觀察訊號（S-03、S-01b，不算部位）：", watch if watch else "無")
