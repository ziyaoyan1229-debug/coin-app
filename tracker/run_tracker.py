#!/usr/bin/env python3
"""交易員追蹤系統（前瞻紀錄）。只用 Hyperliquid 公開 info API，不需金鑰、不下單。

每次執行：對名單上每個地址抓
  - clearinghouseState（目前合約持倉、權益、強平價、設定槓桿）
  - spotClearinghouseState（現貨餘額）
  - portfolio（week 視窗：約每 2 小時一點的權益與損益，用來算扣入出金的報酬）
  - userFillsByTime（上次執行之後的新成交）
然後寫入（CSV 都是「追加」，依月份分檔 YYYY-MM.csv，不改舊資料）：
  equity/        每次快照每人一列：權益（全帳戶、合約帳戶）、實際槓桿（兩種分母）、多空名目、未實現損益
  positions/     每次快照每個部位一列（設定槓桿、強平價、離強平距離）
  events/        與上次快照比較的部位變化（初始、開倉、加碼、減碼、平倉、翻向）
  fills/         新成交（含強平標記）
  consensus/     名單群體在各幣的淨多空
  series/{addr}.csv  扣入出金的權益指數（兩種分母），約每 2 小時一點 → 前瞻 TWR
  alerts.md      警報（被強平、離強平價 < 5%、單次新部位 ≥ 權益 1 倍、追蹤以來回撤跨過 20/30/40/50/70%）
  forward.csv    每人自加入名單起的 TWR、同期 BTC、超額、最大回撤（每次重算）
  summary.md     最新摘要；log.md 每次一行；state.json 上次部位、BTC 1 小時收盤快取
用法：python3 run_tracker.py --watchlist watchlist.csv --out OUTDIR
"""
import argparse, csv, gzip, json, os, random, sys, time
from datetime import datetime, timezone

import requests

URL = "https://api.hyperliquid.xyz/info"
WEIGHT_PER_MIN = 900.0
_tok = {"t": time.time(), "v": 150.0}
S = requests.Session()


def _take(w):
    while True:
        now = time.time()
        _tok["v"] = min(150.0, _tok["v"] + (now - _tok["t"]) * WEIGHT_PER_MIN / 60)
        _tok["t"] = now
        if _tok["v"] >= w:
            _tok["v"] -= w
            return
        time.sleep(0.2)


def post(body, w=20, tries=7):
    _take(w)
    d = 2.0
    for _ in range(tries):
        try:
            r = S.post(URL, json=body, timeout=40)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(d + random.random()); d = min(d * 2, 90); continue
            r.raise_for_status()
            return r.json()
        except (requests.Timeout, requests.ConnectionError):
            time.sleep(d + random.random()); d = min(d * 2, 90)
    raise RuntimeError(f"API failed: {body.get('type')}")


def now_ms():
    return int(time.time() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def append_csv(path, rows, header):
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        if new:
            w.writeheader()
        for r in rows:
            w.writerow(r)


def read_watchlist(p):
    with open(p, encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r.get("addr", "").startswith("0x") and r.get("active", "1") != "0"]


def mids():
    return {k: float(v) for k, v in post({"type": "allMids"}, w=2).items()}


STABLE = {"USDC", "USDT0", "USDH", "USDE", "USDT", "FEUSD", "USDHL"}


def spot_value(spot, mid, spot_meta):
    """現貨餘額換美元：USDC＝1；其他代幣用 spot 交易對中價（@index）或同名永續中價近似。
    回傳 (現貨總值, USDC 餘額（portfolioMargin 可為負＝借款）, 非穩定幣現貨價值＝價格曝險)。"""
    tot = 0.0; usdc = 0.0; risky = 0.0
    name2px = {}
    if spot_meta:
        toks = {t["index"]: t["name"] for t in spot_meta.get("tokens", [])}
        for u in spot_meta.get("universe", []):
            base = toks.get(u["tokens"][0]); key = u["name"]
            if base and key in mid:
                name2px[base] = mid[key]
    for b in (spot or {}).get("balances", []):
        coin = b["coin"]; amt = float(b["total"])
        if coin == "USDC":
            tot += amt; usdc += amt; continue
        if coin in STABLE:
            tot += amt; continue
        px = name2px.get(coin) or mid.get(coin)
        if px:
            tot += amt * px; risky += amt * px
    return tot, usdc, risky


MIN_DEN = 1000.0


def fetch_fills(addr, since, max_pages=6):
    """userFillsByTime 回傳時間窗內最早的 2000 筆（由舊到新）→ 往後翻頁，用 key 去重。"""
    out = {}; start = int(since)
    for _ in range(max_pages):
        js = post({"type": "userFillsByTime", "user": addr, "startTime": start, "aggregateByTime": True}, w=20)
        if not js:
            break
        for f in js:
            out[(f.get("tid"), f.get("oid"), f["time"], f["coin"], f.get("px"), f.get("sz"))] = f
        if len(js) < 2000:
            break
        nxt = max(int(f["time"]) for f in js)
        if nxt <= start:
            break
        start = nxt
    return sorted(out.values(), key=lambda f: f["time"])


def parse_added(added):
    if not added:
        return 0
    for fmt, n in (("%Y-%m-%d %H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            return int(datetime.strptime(added[:n], fmt).replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
    return 0


def window_points(pw, name):
    """portfolio 某視窗的 (t, 總權益, 總損益, perp 權益, perp 損益)；損益是相對視窗起點的累積值。"""
    a = pw.get(name, {}) or {}
    p = pw.get("perp" + name[0].upper() + name[1:], {}) or {}
    av = {int(x[0]): float(x[1]) for x in a.get("accountValueHistory", [])}
    pn = {int(x[0]): float(x[1]) for x in a.get("pnlHistory", [])}
    pav = {int(x[0]): float(x[1]) for x in p.get("accountValueHistory", [])}
    ppn = {int(x[0]): float(x[1]) for x in p.get("pnlHistory", [])}
    return [(t, av[t], pn[t], pav[t], ppn[t]) for t in sorted(av) if t in pn and t in pav and t in ppn]


def seg_ret(a, b):
    """一段的報酬：分子＝perp 損益變化；分母＝段初權益＋半段淨入金（Modified Dietz）。
    r_tot 分母用全帳戶權益（入出金由全帳戶序列推得）；r_perp 分母用合約帳戶權益（現貨↔合約轉帳也算入出金）。"""
    dpp = b[4] - a[4]
    flow = (b[1] - a[1]) - (b[2] - a[2]); den = a[1] + 0.5 * flow
    flow_p = (b[3] - a[3]) - (b[4] - a[4]); den_p = a[3] + 0.5 * flow_p
    clip = lambda v: max(-0.99, min(5.0, v))
    r_tot = clip(dpp / den) if den >= MIN_DEN else None
    r_perp = clip(dpp / den_p) if den_p >= MIN_DEN else None
    return r_tot, r_perp


SER_H = ["t", "av", "av_perp", "idx_tot", "idx_perp", "src", "gap", "live"]


def update_series(sp, pw, t_add):
    """series/{addr}.csv：權益指數（起點＝1）。
    實測（2026-11-04）：portfolio 各視窗的歷史點時間固定、不同次抓取的段落損益完全相同；最後一點是「抓取當下」的即時點，下次不會再出現。
    → 第一次：從加入時間之後的第一個歷史點起算（不用即時點起算）。
    → 之後：在 week→month→allTime 視窗中，找與已存序列共同的最晚歷史點當錨點，從錨點往後用同一視窗接續；
      即時點只當暫時的最後一列（live=1），下次讀檔時丟掉。month 的點是 week 點的子集，追蹤中斷 7～30 天仍接得上。
    → 都找不到共同點：接在最後一點、中間報酬記 0，gap=1 註明。"""
    old = []
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            old = [dict(t=int(x["t"]), av=float(x["av"]), av_perp=float(x["av_perp"]), idx_tot=float(x["idx_tot"]),
                        idx_perp=float(x["idx_perp"]), src=x["src"], gap=int(x.get("gap") or 0), live=0)
                   for x in csv.DictReader(f) if str(x.get("live", "0")) != "1"]
    week = window_points(pw, "week")
    if len(week) < 2:
        return
    if not old:
        grid = [p for p in week[:-1] if p[0] >= t_add]
        if not grid:
            return  # 加入後還沒有新的歷史點，下次再起算
        p0 = grid[0]
        rows = [dict(t=p0[0], av=p0[1], av_perp=p0[3], idx_tot=1.0, idx_perp=1.0, src="week", gap=0, live=0)]
        wname, base = "week", [p for p in week if p[0] >= p0[0]]
        start_i, it, ip = 0, 1.0, 1.0
    else:
        have = {x["t"]: i for i, x in enumerate(old)}
        anchor = None
        for wname in ("week", "month", "allTime"):
            pts = window_points(pw, wname)
            common = [i for i, p in enumerate(pts[:-1]) if p[0] in have]
            if common:
                anchor = (wname, pts, common[-1]); break
        if anchor is None:
            wname = "week"
            later = [p for p in week if p[0] > old[-1]["t"]]
            if not later:
                return
            rows = old + [dict(t=later[0][0], av=later[0][1], av_perp=later[0][3], idx_tot=old[-1]["idx_tot"],
                               idx_perp=old[-1]["idx_perp"], src=wname, gap=1, live=0)]
            base, start_i = later, 0
            it, ip = old[-1]["idx_tot"], old[-1]["idx_perp"]
        else:
            wname, base, start_i = anchor
            rows = old[: have[base[start_i][0]] + 1]
            it, ip = rows[-1]["idx_tot"], rows[-1]["idx_perp"]
    for i in range(start_i + 1, len(base)):
        rt, rp = seg_ret(base[i - 1], base[i])
        it *= 1 + (rt or 0.0); ip *= 1 + (rp or 0.0)
        rows.append(dict(t=base[i][0], av=base[i][1], av_perp=base[i][3], idx_tot=it, idx_perp=ip, src=wname, gap=0,
                         live=1 if i == len(base) - 1 else 0))
    with open(sp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=SER_H); w.writeheader()
        for x in rows:
            w.writerow(dict(x, idx_tot=round(x["idx_tot"], 8), idx_perp=round(x["idx_perp"], 8)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=500)
    ap.add_argument("--snapshots", action="store_true", help="另存原始持倉快照（gz），預設不存")
    a = ap.parse_args()
    out = a.out
    os.makedirs(os.path.join(out, "series"), exist_ok=True)
    state_p = os.path.join(out, "state.json")
    state = json.load(open(state_p)) if os.path.exists(state_p) else {"last": {}}
    wl = read_watchlist(a.watchlist)[: a.max]
    ts = now_ms(); T = iso(ts)
    mid = mids()
    try:
        spot_meta = post({"type": "spotMeta"})
    except Exception:
        spot_meta = None
    btc = mid.get("BTC")
    eq_rows, pos_rows, ev_rows, fill_rows, alerts = [], [], [], [], []
    cons = {}
    raw = []
    nerr = 0
    try:
        dex_names = [d["name"] for d in post({"type": "perpDexs"}) if d]  # HIP-3 自建合約 dex（預設 dex 看不到）
    except Exception:
        dex_names = []
    modes = state.setdefault("mode", {})
    for r in wl:
        addr = r["addr"].lower(); label = r.get("label", "")
        try:
            perps = {"": post({"type": "clearinghouseState", "user": addr}, w=2)}
            for dx in dex_names:
                s_ = post({"type": "clearinghouseState", "user": addr, "dex": dx}, w=2)
                if float(s_.get("marginSummary", {}).get("accountValue", 0) or 0) != 0 or s_.get("assetPositions"):
                    perps[dx] = s_
            spot = post({"type": "spotClearinghouseState", "user": addr}, w=2)
            port = post({"type": "portfolio", "user": addr})
            md = modes.get(addr)
            if not md or ts - md.get("t", 0) > 86400_000:
                modes[addr] = {"m": post({"type": "userAbstraction", "user": addr}), "t": ts}
            mode = str(modes[addr]["m"])
            last = state["last"].get(addr, {})
            since = int(last.get("last_fill", ts - 3 * 86400_000)) + 1
            fills = fetch_fills(addr, since)
        except Exception as e:
            nerr += 1
            alerts.append(f"- {T} 抓取失敗 {label} {addr}: {e}")
            continue
        raw.append({"addr": addr, "mode": mode, "perp": perps, "spot": spot})
        unified = mode in ("unifiedAccount", "portfolioMargin")
        av_perp = sum(float(s_.get("marginSummary", {}).get("accountValue", 0) or 0) for s_ in perps.values())
        sv, usdc, risky = spot_value(spot, mid, spot_meta)
        pw = dict(port)
        wk = (pw.get("week") or {}).get("accountValueHistory") or []
        # 總權益用 Hyperliquid 自己算的 portfolio 即時點（最後一點＝抓取當下）。
        # 實測：unifiedAccount／portfolioMargin 帳戶的合約權益已含在現貨 USDC 裡，合約＋現貨相加會重複計算。
        av_tot = float(wk[-1][1]) if wk else (sv if unified else av_perp + sv)
        long_n = short_n = upnl = 0.0
        cur, cur_ntl = {}, {}
        for dx, perp in perps.items():
            for ap_ in perp.get("assetPositions", []):
                p = ap_["position"]; coin = p["coin"]; szi = float(p["szi"])
                if szi == 0:
                    continue
                ntl = abs(float(p["positionValue"])); up = float(p["unrealizedPnl"])
                liq = p.get("liquidationPx"); lev = p.get("leverage", {})
                mark = ntl / abs(szi)
                if szi > 0: long_n += ntl
                else: short_n += ntl
                upnl += up
                cur[coin] = szi; cur_ntl[coin] = ntl if szi > 0 else -ntl
                dist = (abs(mark - float(liq)) / mark) if (liq and mark) else None
                pos_rows.append(dict(ts=T, addr=addr, label=label, dex=dx or "main", coin=coin, szi=szi, side="多" if szi > 0 else "空", ntl=round(ntl, 2),
                                     entry=p.get("entryPx"), mark=round(mark, 6), upnl=round(up, 2), lev_type=lev.get("type"), lev_set=lev.get("value"),
                                     liq=liq, liq_dist=round(dist, 4) if dist is not None else "", margin=p.get("marginUsed"),
                                     funding_since_open=(p.get("cumFunding") or {}).get("sinceOpen")))
                c = cons.setdefault(coin, {"long": 0.0, "short": 0.0, "nl": 0, "ns": 0})
                if szi > 0: c["long"] += ntl; c["nl"] += 1
                else: c["short"] += ntl; c["ns"] += 1
                if dist is not None and dist < 0.05:
                    alerts.append(f"- {T} ⚠️ 離強平價 < 5%：{label} {coin} {'多' if szi>0 else '空'} 名目 {ntl:,.0f}，距離 {dist:.1%}")
        gross = long_n + short_n
        eq_rows.append(dict(ts=T, addr=addr, label=label, mode=mode, av_total=round(av_tot, 2), av_perp=round(av_perp, 2), av_spot=round(sv, 2),
                            spot_usdc=round(usdc, 2), spot_risky=round(risky, 2), long_ntl=round(long_n, 2), short_ntl=round(short_n, 2),
                            upnl=round(upnl, 2), n_pos=len(cur), n_dex=len(perps),
                            lev_total=round(gross / av_tot, 3) if av_tot > 0 else "",
                            lev_perp=(round(gross / av_perp, 3) if av_perp > 0 else "") if not unified else "",
                            lev_exposure=round((gross + abs(risky)) / av_tot, 3) if av_tot > 0 else "",
                            net_lev_total=round((long_n - short_n) / av_tot, 3) if av_tot > 0 else "",
                            net_exposure_with_spot=round((long_n - short_n + risky) / av_tot, 3) if av_tot > 0 else ""))
        # 部位變化（名目變化用前後兩次快照的部位名目，不用中價，HIP-3 也算得到）
        prev = last.get("pos", {}); prev_ntl = last.get("ntl", {})
        for coin in set(prev) | set(cur):
            b = float(prev.get(coin, 0)); n = float(cur.get(coin, 0))
            if abs(b - n) < 1e-12:
                continue
            if not last: ev = "初始"
            elif b == 0: ev = "開倉"
            elif n == 0: ev = "平倉"
            elif (b > 0) != (n > 0): ev = "翻向"
            elif abs(n) > abs(b): ev = "加碼"
            else: ev = "減碼"
            nb = abs(float(prev_ntl.get(coin, 0))); nn = abs(float(cur_ntl.get(coin, 0)))
            dn = nn - nb if ev in ("加碼", "減碼") else (nn if ev in ("開倉", "翻向", "初始") else -nb)
            ev_rows.append(dict(ts=T, addr=addr, label=label, coin=coin, event=ev, size_before=b, size_after=n, ntl_change=round(dn, 2)))
            if last and ev in ("開倉", "加碼", "翻向") and av_tot > 0 and abs(dn) >= av_tot:
                alerts.append(f"- {T} 大額{ev}：{label} {coin} 名目 {abs(dn):,.0f}（≥ 權益 1 倍）")
        # 新成交
        lf = int(last.get("last_fill", 0))
        for fl in fills or []:
            if int(fl["time"]) <= int(last.get("last_fill", -1)):
                continue
            liq = fl.get("liquidation")
            fill_rows.append(dict(time=iso(fl["time"]), ms=fl["time"], addr=addr, label=label, coin=fl["coin"], dir=fl.get("dir"), side=fl.get("side"),
                                  px=fl["px"], sz=fl["sz"], closedPnl=fl.get("closedPnl"), fee=fl.get("fee"), crossed=fl.get("crossed"),
                                  liquidation=1 if liq else 0, hash=fl.get("hash")))
            lf = max(lf, int(fl["time"]))
            if liq and str(liq.get("liquidatedUser", "")).lower() == addr:
                alerts.append(f"- {T} ❗ 被強平：{label} {fl['coin']} {fl.get('sz')} @ {fl['px']}")
        # 權益指數（扣入出金的 TWR，兩種分母），用 portfolio 視窗內序列接續
        try:
            t_add = parse_added(r.get("added_utc", ""))
            update_series(os.path.join(out, "series", f"{addr}.csv"), pw, t_add)
        except Exception as e:
            alerts.append(f"- {T} 權益序列更新失敗 {label} {addr}: {e}")
        # 沒有新成交時也往前推（否則下次會從很久以前重抓、重複寫入）
        lf = max(lf, since - 1, ts - 10 * 60_000)
        state["last"][addr] = {"pos": cur, "ntl": cur_ntl, "last_fill": lf, "ts": ts, "av_total": av_tot, "av_perp": av_perp, "mode": mode}
    # 群體共識
    cons_rows = []
    tot_eq = sum(x["av_total"] for x in eq_rows) or 1
    for coin, c in sorted(cons.items(), key=lambda kv: -(kv[1]["long"] + kv[1]["short"])):
        g = c["long"] + c["short"]
        cons_rows.append(dict(ts=T, coin=coin, n_long=c["nl"], n_short=c["ns"], long_ntl=round(c["long"], 2), short_ntl=round(c["short"], 2),
                              net_ntl=round(c["long"] - c["short"], 2), long_ratio=round(c["long"] / g, 3) if g else "",
                              net_vs_equity=round((c["long"] - c["short"]) / tot_eq, 4)))
    H_EQ = ["ts", "addr", "label", "mode", "av_total", "av_perp", "av_spot", "spot_usdc", "spot_risky", "long_ntl", "short_ntl", "upnl", "n_pos", "n_dex",
            "lev_total", "lev_perp", "lev_exposure", "net_lev_total", "net_exposure_with_spot"]
    H_POS = ["ts", "addr", "label", "dex", "coin", "szi", "side", "ntl", "entry", "mark", "upnl", "lev_type", "lev_set", "liq", "liq_dist", "margin", "funding_since_open"]
    H_EV = ["ts", "addr", "label", "coin", "event", "size_before", "size_after", "ntl_change"]
    H_FI = ["time", "ms", "addr", "label", "coin", "dir", "side", "px", "sz", "closedPnl", "fee", "crossed", "liquidation", "hash"]
    H_CO = ["ts", "coin", "n_long", "n_short", "long_ntl", "short_ntl", "net_ntl", "long_ratio", "net_vs_equity"]
    ym = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m")
    def mp(name):  # 依月份分檔，git 每次只改當月檔
        os.makedirs(os.path.join(out, name), exist_ok=True)
        return os.path.join(out, name, f"{ym}.csv")
    append_csv(mp("equity"), eq_rows, H_EQ)
    append_csv(mp("positions"), pos_rows, H_POS)
    append_csv(mp("events"), ev_rows, H_EV)
    append_csv(mp("fills"), fill_rows, H_FI)
    append_csv(mp("consensus"), cons_rows, H_CO)
    if a.snapshots:
        os.makedirs(os.path.join(out, "snapshots"), exist_ok=True)
        snap = os.path.join(out, "snapshots", datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y%m%d_%H%M") + ".jsonl.gz")
        with gzip.open(snap, "wt", encoding="utf-8") as f:
            for x in raw:
                f.write(json.dumps(x, separators=(",", ":")) + "\n")
    # 前瞻績效（自加入名單起）
    fw = forward(wl, out, btc_now=btc, st=state)
    ma = state.setdefault("mdd_alerted", {})
    for x in fw:
        if x.get("mdd") in ("", None):
            continue
        lvl = max([0] + [k for k in (20, 30, 40, 50, 70) if float(x["mdd"]) * 100 >= k])
        if lvl > ma.get(x["addr"], 0):
            alerts.append(f"- {T} 追蹤以來最大回撤達 {lvl}%：{x['label']} {x['addr']}（{float(x['mdd']):.0%}）")
            ma[x["addr"]] = lvl
    with open(os.path.join(out, "forward.csv"), "w", newline="", encoding="utf-8") as f:
        H_FW = ["addr", "label", "mode", "added", "days", "twr", "twr_perp", "btc", "excess", "mdd", "mdd_perp", "n_pts", "gaps", "av_total_now"]
        w = csv.DictWriter(f, fieldnames=H_FW); w.writeheader(); [w.writerow(x) for x in fw]
    if alerts:
        with open(os.path.join(out, "alerts.md"), "a", encoding="utf-8") as f:
            f.write("\n".join(alerts) + "\n")
    state.setdefault("btc", []).append([ts, btc])
    json.dump(state, open(state_p, "w"))
    write_summary(out, T, eq_rows, ev_rows, cons_rows, fw, alerts, nerr, len(wl))
    with open(os.path.join(out, "log.md"), "a", encoding="utf-8") as f:
        f.write(f"- {T} UTC：{len(wl)} 人，失敗 {nerr}，部位 {len(pos_rows)}，變化 {len(ev_rows)}，新成交 {len(fill_rows)}，警報 {len(alerts)}\n")
    print(f"done {T} n={len(wl)} err={nerr} pos={len(pos_rows)} events={len(ev_rows)} fills={len(fill_rows)} alerts={len(alerts)}")


def btc_history(st, t_from):
    """BTC 1 小時 K 線收盤價（快取在 state.json，只補新的）。回傳 [(收盤時間, 收盤價)]。"""
    c = st.setdefault("btc_1h", [])
    have_from = c[0][0] if c else None
    start = t_from - 2 * 3600_000 if (not c or t_from < have_from) else c[-1][0]
    try:
        js = post({"type": "candleSnapshot", "req": {"coin": "BTC", "interval": "1h", "startTime": int(start), "endTime": now_ms()}}, w=20 + 80)
        new = {int(k["T"]): float(k["c"]) for k in js if int(k["T"]) <= now_ms()}
        merged = {int(t): px for t, px in c}; merged.update(new)
        st["btc_1h"] = sorted([[t, px] for t, px in merged.items()])
    except Exception:
        pass
    return st["btc_1h"]


def px_at(hist, t):
    last = None
    for t_, px in hist:
        if t_ <= t:
            last = px
        else:
            break
    return last if last is not None else (hist[0][1] if hist else None)


def forward(wl, out, btc_now, st):
    """自加入名單起的 TWR（兩種分母）、同期 BTC、超額、最大回撤（用權益指數，約每 2 小時一點）。"""
    t_min = min([parse_added(r.get("added_utc", "")) or now_ms() for r in wl] or [now_ms()])
    btc_hist = btc_history(st, t_min)
    res = []
    for r in wl:
        addr = r["addr"].lower(); added = r.get("added_utc", ""); t_add = parse_added(added)
        sp = os.path.join(out, "series", f"{addr}.csv")
        if not os.path.exists(sp):
            continue
        with open(sp, encoding="utf-8") as f:
            xs = list(csv.DictReader(f))
        if len(xs) < 2:
            res.append(dict(addr=addr, label=r.get("label", ""), added=added, days=round((now_ms() - t_add) / 86400_000, 1) if t_add else "",
                            twr="", twr_perp="", btc="", excess="", mdd="", mdd_perp="", n_pts=len(xs), gaps=0,
                            av_total_now=st.get("last", {}).get(addr, {}).get("av_total", "")))
            continue
        it = [float(x["idx_tot"]) for x in xs]; ip = [float(x["idx_perp"]) for x in xs]
        peak, mdd = it[0], 0.0
        for v in it:
            peak = max(peak, v); mdd = max(mdd, 1 - v / peak)
        t_first = int(xs[0]["t"])
        b0 = px_at(btc_hist, t_first)
        jp, mdd_p = ip[0], 0.0
        for v in ip:
            jp = max(jp, v); mdd_p = max(mdd_p, 1 - v / jp)
        btc_r = (btc_now / b0 - 1) if (b0 and btc_now) else ""
        twr = it[-1] / it[0] - 1; twr_p = ip[-1] / ip[0] - 1
        mode = st.get("last", {}).get(addr, {}).get("mode", "")
        if mode in ("unifiedAccount", "portfolioMargin"):  # 合約帳戶不是獨立保證金池 → 合約帳戶分母不適用
            twr_p, mdd_p = None, None
        res.append(dict(addr=addr, label=r.get("label", ""), added=added, days=round((now_ms() - t_add) / 86400_000, 1) if t_add else "",
                        twr=round(twr, 4), twr_perp=round(twr_p, 4) if twr_p is not None else "", btc=round(btc_r, 4) if btc_r != "" else "", mode=mode,
                        excess=round(twr - btc_r, 4) if btc_r != "" else "", mdd=round(mdd, 4), mdd_perp=round(mdd_p, 4) if mdd_p is not None else "", n_pts=len(xs),
                        gaps=sum(int(x.get("gap") or 0) for x in xs),
                        av_total_now=st.get("last", {}).get(addr, {}).get("av_total", "")))
    return res


def write_summary(out, T, eq_rows, ev_rows, cons_rows, fw, alerts, nerr, n):
    L = [f"# 交易員追蹤摘要（{T} UTC）", "", f"名單 {n} 人，抓取失敗 {nerr}。", ""]
    L += ["## 群體淨多空（名目前 10 幣）", "", "| 幣 | 多單人數 | 空單人數 | 多單名目 | 空單名目 | 多單占比 |", "|---|---|---|---|---|---|"]
    for c in cons_rows[:10]:
        L.append(f"| {c['coin']} | {c['n_long']} | {c['n_short']} | {c['long_ntl']:,.0f} | {c['short_ntl']:,.0f} | {c['long_ratio']} |")
    L += ["", "## 本次部位變化（前 20 大）", "", "| 交易員 | 幣 | 變化 | 名目變化 |", "|---|---|---|---|"]
    for e in sorted([e for e in ev_rows if e["event"] != "初始"], key=lambda x: -abs(x["ntl_change"]))[:20]:
        L.append(f"| {e['label'] or e['addr'][:10]} | {e['coin']} | {e['event']} | {e['ntl_change']:,.0f} |")
    L += ["", "## 前瞻績效（自加入名單起；TWR 已扣入出金）", "",
          "分子都是合約損益（不含現貨漲跌）；全帳戶分母＝Hyperliquid 算的總權益。合約帳戶分母只對 default／disabled 模式有意義（獨立保證金池），統一帳戶標「—」。", "",
          "| 交易員 | 加入 | 天數 | TWR（全帳戶） | TWR（合約帳戶） | 同期 BTC | 超額（全帳戶） | 超額（合約帳戶） | 最大回撤（全帳戶／合約帳戶） |", "|---|---|---|---|---|---|---|---|---|"]
    for x in sorted(fw, key=lambda x: -(x["excess"] if x["excess"] != "" else -9)):
        f = lambda v: f"{v:+.1%}" if v != "" else "—"
        g = lambda v: f"{v:.1%}" if v != "" else "—"
        exp = (x["twr_perp"] - x["btc"]) if (x["twr_perp"] != "" and x["btc"] != "") else ""
        L.append(f"| {x['label'] or x['addr'][:10]} | {x['added'][:10]} | {x['days']} | {f(x['twr'])} | {f(x['twr_perp'])} | {f(x['btc'])} | {f(x['excess'])} | {f(exp)} | {g(x['mdd'])}／{g(x['mdd_perp'])} |")
    L += ["", "## 實際槓桿", "",
          "實際槓桿＝合約部位名目加總 ÷ 總權益（Hyperliquid portfolio 的即時總權益）。unifiedAccount／portfolioMargin 模式的保證金是整個帳戶，"
          "「只看合約帳戶」的槓桿不適用，標「—」。含現貨曝險＝（合約名目＋非穩定幣現貨）÷ 總權益。", "",
          "| 交易員 | 帳戶模式 | 總權益 | 多單名目 | 空單名目 | 實際槓桿 | 只看合約帳戶 | 含現貨曝險 |", "|---|---|---|---|---|---|---|---|"]
    for e in sorted(eq_rows, key=lambda x: -x["av_total"])[:50]:
        L.append(f"| {e['label'] or e['addr'][:10]} | {e['mode']} | {e['av_total']:,.0f} | {e['long_ntl']:,.0f} | {e['short_ntl']:,.0f} | {e['lev_total']} | {e['lev_perp'] if e['lev_perp'] != '' else '—'} | {e['lev_exposure']} |")
    if alerts:
        L += ["", "## 本次警報", ""] + alerts
    open(os.path.join(out, "summary.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
