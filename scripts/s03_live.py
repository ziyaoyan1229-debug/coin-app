# 這是投資組 /mnt/project-files/finance/模擬盤/s03_live.py 的複本（2026-10-15 複製），規則以投資組那份為準；那份改了要同步過來。
"""S-03 模擬盤每日檢查（10/15 07:17 版規則）。
用法：python3 s03_live.py <data 目錄>（含 BTCUSDT_15m.csv 等四檔，來自 coin-app 的 data 分支）
輸出：目前環境條件、近 24h 訊號、模擬盤部位（自 PAPER_START 起，起始權益 1.0）。
5 分濾網結果會記在 s03_state.json，5 分 K 只保留 3 天，判過就不再重算。"""
import sys, json, os, numpy as np, pandas as pd
D=sys.argv[1]; HERE=os.path.dirname(os.path.abspath(__file__)); STATE=os.path.join(HERE,"s03_state.json")
PAPER_START=pd.Timestamp(os.environ.get("PAPER_START","2026-10-14 16:00"))  # = 10/15 00:00 台北
FEE=0.00075; CONF_MULT=14.7
def load(f):
    df=pd.read_csv(os.path.join(D,f)); df.index=pd.to_datetime(df.open_time,unit="ms")
    return df.rename(columns={"volume":"v"})[["open","high","low","close","v"]].set_axis(list("ohlcv"),axis=1)
B,E=load("BTCUSDT_15m.csv"),load("ETHUSDT_15m.csv"); idx=B.index.intersection(E.index); B,E=B.loc[idx],E.loc[idx]; t=idx; n=len(t)
F5={"BTC":load("BTCUSDT_5m.csv"),"ETH":load("ETHUSDT_5m.csv")}
isclose4h=np.array([(x.hour%4==3 and x.minute==45) for x in t])
def prep(b):
    o,h,l,c,v=[b[x].values for x in "ohlcv"]
    h4=b.c.resample("4h").last(); d1=b.c.resample("1D").last(); e50=d1.ewm(span=50,adjust=False).mean()
    d=dict(o=o,h=h,l=l,c=c,v=v)
    d["up4"]=(h4>h4.ewm(span=200,adjust=False).mean()).shift(1).reindex(t,method="ffill").values==True
    d["upd"]=(d1>e50).shift(1).reindex(t.normalize()).values==True
    d["e20"]=h4.ewm(span=20,adjust=False).mean().shift(1).reindex(t,method="ffill").values
    d["exit_d50"]=np.array([(x.hour==0 and x.minute==0) for x in t])&((d1<e50).shift(1).reindex(t.normalize()).values==True)
    d["hh"]=pd.Series(h).rolling(96).max().shift(1).values; d["vm"]=pd.Series(v).rolling(96).median().shift(1).values
    d["d1c"],d["d1e50"]=d1.iloc[-1],e50.iloc[-1]; d["h4c"],d["h4e200"]=h4.iloc[-1],h4.ewm(span=200,adjust=False).mean().iloc[-1]
    return d
P={"BTC":prep(B),"ETH":prep(E)}
def signals(sym):
    d=P[sym]; c,h,l,v,hh,vm=d["c"],d["h"],d["l"],d["v"],d["hh"],d["vm"]; out=[]
    for i in range(200,n-3):
        if not (c[i]>hh[i] and c[i-1]<=hh[i-1]): continue
        if not ((c[i+1:i+4]>hh[i]).all() and v[i+1:i+4].sum()>=vm[i]*CONF_MULT): continue
        if sym=="BTC" and not (d["up4"][i] and d["upd"][i]): continue
        if not (v[i-32:i].mean()<0.8*v[i-96:i-32].mean() and l[i-32:i].min()>=l[i-96:i-32].min()): continue
        out.append((i+3,min(hh[i]*0.997,l[i+1:i+4].min()*0.999),i))
    return out
def hhhl_ok(sym,ts,k=3):
    b=F5[sym]; b=b[b.index<=ts]
    if len(b)<60: return None
    h,l=b.h.values,b.l.values; m=len(b)
    ph=[j for j in range(k,m-k) if h[j]==h[j-k:j+k+1].max()]; pl=[j for j in range(k,m-k) if l[j]==l[j-k:j+k+1].min()]
    if len(ph)<2 or len(pl)<2: return False
    return bool(h[ph[-1]]>h[ph[-2]] and l[pl[-1]]>l[pl[-2]])
st=json.load(open(STATE)) if os.path.exists(STATE) else {"mid_filter":{}}
def sim(d,e,stop,f_early):
    o,l,c=d["o"],d["l"],d["c"]; rem=1.0; fills=[]; done=(f_early==0)
    for j in range(e+1,n):
        if l[j]<=stop: fills.append((j,min(o[j],stop),rem)); return fills,True
        if not done and isclose4h[j] and c[j]<d["e20"][j]: fills.append((j,c[j],f_early)); rem-=f_early; done=True
        if d["exit_d50"][j]: fills.append((j,o[j],rem)); return fills,True
    return fills+[(None,c[-1],rem)],False
SIG={s:signals(s) for s in P}; ev=sorted([(e,s,stp) for s in SIG for e,stp,_ in SIG[s] if t[e]>=PAPER_START])
eq=1.0; peak=1.0; core={"BTC":-1,"ETH":-1}; mid={"BTC":-1,"ETH":-1}; pos=[]; closed=[]
for e,sym,stop in ev:
    d=P[sym]
    if sym=="ETH" and core["BTC"]<=e and mid["BTC"]<=e: continue
    if d["c"][e]<=stop: continue
    if core[sym]<=e: kind,f,rk="核心",0,0.05
    elif mid[sym]<=e:
        key=f"{sym}|{t[e]}"
        if key not in st["mid_filter"]: st["mid_filter"][key]=hhhl_ok(sym,t[e]+pd.Timedelta(minutes=10))
        if not st["mid_filter"][key]: continue
        kind,f,rk="中段",0.5,0.025
    else: continue
    ddv=1-eq/peak; m=1 if ddv<0.15 else (0.5 if ddv<0.3 else 0.2); R=d["c"][e]-stop
    fills,done=sim(d,e,stop,f); q=eq*rk*m/R
    pnl=sum(q*fr*((px-d["c"][e])-(px+d["c"][e])*FEE) for j,px,fr in fills if j is not None)
    last=fills[-1][0] if done else n+10
    if kind=="核心": core[sym]=last
    else: mid[sym]=last
    rec=dict(幣=sym,類型=kind,進場時間=str(t[e]+pd.Timedelta(hours=8))+" 台北",進場價=round(d["c"][e],2),停損=round(stop,2),風險=f"{rk*m:.2%}",部位價值佔權益=f"{q*d['c'][e]/eq:.0%}")
    if done:
        eq+=pnl; peak=max(peak,eq); rec["出場時間"]=str(t[last]+pd.Timedelta(hours=8))+" 台北"; rec["損益佔權益"]=f"{pnl:+.2%}"; closed.append(rec)
    else:
        rem=fills[-1][2]; upnl=pnl+q*rem*(d["c"][-1]-d["c"][e]); rec["剩餘比例"]=rem; rec["未實現佔權益"]=f"{upnl:+.2%}"; pos.append(rec)
json.dump(st,open(STATE,"w"),ensure_ascii=False,indent=1)
print(f"資料最後一根：{t[-1]+pd.Timedelta(hours=8)} 台北（15 分 K 開盤時間）")
for s in P:
    d=P[s]; print(f"{s} 現價 {d['c'][-1]:.2f}｜4h EMA200 {d['h4e200']:.0f}（{'上' if d['h4c']>d['h4e200'] else '下'}）｜日線 EMA50 {d['d1e50']:.0f}（{'上' if d['d1c']>d['d1e50'] else '下'}）｜前 24h 高 {d['hh'][-1]:.2f}")
rec24=[(s,str(t[e]+pd.Timedelta(hours=8)),round(stp,2)) for e,s,stp in sorted([(e,s,stp) for s in SIG for e,stp,_ in SIG[s]]) if t[e]>=t[-1]-pd.Timedelta(hours=24)]
print("近 24h S-03 訊號：",rec24 if rec24 else "無")
print(f"模擬盤權益（起始 1.0，自 10/15 起）：{eq:.4f}")
print("持倉：",json.dumps(pos,ensure_ascii=False) if pos else "無")
print("已平倉：",json.dumps(closed,ensure_ascii=False) if closed else "無")
