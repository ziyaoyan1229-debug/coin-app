"""抓 Bybit、OKX、幣安、Bitget 的餘額與合約持倉，加密後寫成 portfolio.enc.json。

在你自己的電腦上跑（台灣 IP 才連得到 Bybit 和幣安）。金鑰從同資料夾的 .env 讀，
只用唯讀權限；明文結果存在 portfolio_latest.json（不上傳），加密結果寫進 coin-app
資料夾，幣策略 App 的「我的資產」頁輸入密碼解開。

用法：python fetch_portfolio.py           # 抓取、加密、（PUSH=1 時）上傳
      python fetch_portfolio.py --dry-run # 只抓取並印出，不加密不上傳
"""
import base64
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import ccxt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = Path(__file__).resolve().parent
TPE = timezone(timedelta(hours=8))
PBKDF2_ITER = 600_000
DUST_USD = 1.0  # 小於 1 美元的零頭不列
STABLE = {"USDT", "USDC", "FDUSD", "BUSD", "DAI", "USD"}

EXCHANGES = [
    # 名稱, ccxt id, 環境變數前綴, 要查的帳戶類型
    ("Bybit", "bybit", "BYBIT", [{"type": "unified"}, {"type": "fund"}]),
    ("OKX", "okx", "OKX", [{"type": "trading"}, {"type": "funding"}]),
    ("幣安", "binance", "BINANCE", [{"type": "spot"}, {"type": "future"}, {"type": "funding"}]),
    ("Bitget", "bitget", "BITGET", [{"type": "spot"}, {"type": "swap"}]),
]


def load_env():
    env_path = HERE / ".env"
    if not env_path.exists():
        sys.exit("找不到 .env：請把 .env.example 複製成 .env 並填好。")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def make_client(ccxt_id, prefix):
    key = os.environ.get(f"{prefix}_KEY", "")
    secret = os.environ.get(f"{prefix}_SECRET", "")
    if not key or not secret:
        return None
    opts = {"apiKey": key, "secret": secret, "enableRateLimit": True, "timeout": 20000}
    password = os.environ.get(f"{prefix}_PASSWORD", "")
    if password:
        opts["password"] = password
    return getattr(ccxt, ccxt_id)(opts)


def check_read_only(name, ex):
    """能查到權限的交易所，發現有交易或提領權限就拒絕執行。回傳提醒文字或 None。"""
    try:
        if ex.id == "bybit":
            info = ex.privateGetV5UserQueryApi()["result"]
            if str(info.get("readOnly")) != "1":
                raise SystemExit(f"{name} 金鑰不是唯讀，請刪掉這組金鑰、改開只有讀取權限的。")
        elif ex.id == "binance":
            r = ex.sapiGetAccountApiRestrictions()
            risky = [k for k in ("enableWithdrawals", "enableSpotAndMarginTrading", "enableFutures",
                                 "enableInternalTransfer", "enableMargin") if r.get(k) in (True, "true")]
            if risky:
                raise SystemExit(f"{name} 金鑰有 {', '.join(risky)} 權限，請刪掉這組金鑰、改開只有讀取權限的。")
        else:
            return "無法自動確認權限，請確定建立時只勾讀取"
    except SystemExit:
        raise
    except Exception as e:  # 查不到權限不擋，但記下來
        return f"權限檢查失敗：{type(e).__name__}"
    return None


def usd_price(ex, coin, cache):
    if coin in STABLE:
        return 1.0
    if coin in cache:
        return cache[coin]
    price = None
    for quote in ("USDT", "USDC"):
        try:
            t = ex.fetch_ticker(f"{coin}/{quote}")
            price = t.get("last") or t.get("close")
            if price:
                break
        except Exception:
            continue
    cache[coin] = price
    return price


def fetch_exchange(name, ccxt_id, prefix, account_types):
    ex = make_client(ccxt_id, prefix)
    if ex is None:
        return None
    out = {"name": name, "ok": True, "notes": [], "assets": [], "positions": [], "total_usd": 0.0}
    try:
        ex.load_markets()
        note = check_read_only(name, ex)
        if note:
            out["notes"].append(note)

        amounts, read_ok = {}, 0
        for params in account_types:
            try:
                bal = ex.fetch_balance(params)
                read_ok += 1
            except Exception as e:
                out["notes"].append(f"{params['type']} 帳戶讀取失敗：{type(e).__name__}")
                continue
            for coin, amt in (bal.get("total") or {}).items():
                if amt:
                    amounts[coin] = amounts.get(coin, 0.0) + float(amt)

        if not read_ok:
            out["ok"] = False
        cache = {}
        for coin, amt in sorted(amounts.items()):
            price = usd_price(ex, coin, cache)
            usd = amt * price if price else None
            if usd is not None and abs(usd) < DUST_USD:
                continue
            out["assets"].append({"coin": coin, "amount": amt, "usd": usd})
            out["total_usd"] += usd or 0.0

        try:
            for p in ex.fetch_positions():
                if not p.get("contracts"):
                    continue
                out["positions"].append({
                    "symbol": p.get("symbol"),
                    "side": p.get("side"),
                    "contracts": p.get("contracts"),
                    "notional": p.get("notional"),
                    "entry": p.get("entryPrice"),
                    "mark": p.get("markPrice"),
                    "upnl": p.get("unrealizedPnl"),
                    "liq": p.get("liquidationPrice"),
                    "leverage": p.get("leverage"),
                    "margin_mode": p.get("marginMode"),
                })
        except Exception as e:
            out["notes"].append(f"持倉讀取失敗：{type(e).__name__}")
    except SystemExit:
        raise
    except Exception as e:
        out["ok"] = False
        out["notes"].append(f"連線失敗：{type(e).__name__}: {str(e)[:120]}")
    return out


def encrypt(data, password):
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITER).derive(password.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(data, ensure_ascii=False).encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def git_push(repo, path):
    def run(*args):
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    run("pull", "--rebase", "--autostash")
    run("add", path.name)
    if run("diff", "--cached", "--quiet").returncode == 0:
        print("沒有變動，不用上傳。")
        return
    stamp = datetime.now(TPE).strftime("%Y-%m-%d %H:%M")
    run("commit", "-m", f"資產更新 {stamp}")
    r = run("push")
    print("已上傳。" if r.returncode == 0 else f"上傳失敗：{r.stderr.strip()[:300]}")


def main():
    dry = "--dry-run" in sys.argv
    load_env()
    password = os.environ.get("PORTFOLIO_PASSWORD", "")
    if not dry and len(password) < 12:
        sys.exit("PORTFOLIO_PASSWORD 至少要 12 位。")

    exchanges = [r for r in (fetch_exchange(*e) for e in EXCHANGES) if r]
    if not exchanges:
        sys.exit(".env 裡沒有任何交易所金鑰。")
    usdtwd = float(os.environ.get("USDTWD", "32") or 32)
    data = {
        "updated_at": datetime.now(TPE).isoformat(timespec="minutes"),
        "usdtwd": usdtwd,
        "total_usd": round(sum(x["total_usd"] for x in exchanges), 2),
        "exchanges": exchanges,
    }

    (HERE / "portfolio_latest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    for x in exchanges:
        flag = "OK" if x["ok"] else "失敗"
        print(f"{x['name']}: {flag}  約 US${x['total_usd']:,.2f}  持倉 {len(x['positions'])} 筆  {'；'.join(x['notes'])}")
    print(f"合計約 US${data['total_usd']:,.2f}（約 {data['total_usd'] * usdtwd:,.0f} 台幣）")
    if dry:
        return

    repo = Path(os.environ.get("REPO_DIR", "") or HERE.parent.parent)
    target = repo / "portfolio.enc.json"
    target.write_text(json.dumps(encrypt(data, password)), encoding="utf-8")
    print(f"已加密寫入 {target}")
    if os.environ.get("PUSH", "1") == "1":
        git_push(repo, target)


if __name__ == "__main__":
    main()
