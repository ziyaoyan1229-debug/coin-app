"""MSTR（Strategy）基本面自動更新：從 SEC EDGAR 公告抓持幣數、ATM 增發、可轉債／優先股發行，寫成 mstr.json 給網站 MSTR 圖用
（mNAV、持幣、股數延伸到今天；可轉債／增發事件自動加點）。由 .github/workflows/klines.yml 執行，6 小時最多抓一次。只用標準函式庫。
用法：python3 scripts/fetch_mstr.py <資料夾（mstr.json 讀寫都在這）>
來源：
  - data.sec.gov/submissions：8-K 清單（每週一的持幣更新、發債、優先股定價）
  - 每份 8-K 主文件：表格裡的 Aggregate BTC Holdings、ATM 每種證券賣了幾股／淨額；文字裡的可轉債、優先股發行金額
  - data.sec.gov companyfacts：最近一季的流通股數（A 股＋B 股），之後加上 8-K 裡 MSTR ATM 賣出的股數
SEC 要求 User-Agent 帶聯絡方式；可在 repo secrets 設 SEC_UA（例如「公司名 聯絡信箱」），沒設就用 repo 網址。"""
import calendar, html, json, os, re, sys, time, urllib.request
from html.parser import HTMLParser

OUT = sys.argv[1] if len(sys.argv) > 1 else 'data'
PATH = os.path.join(OUT, 'mstr.json')
CIK = '1050446'
UA = os.environ.get('SEC_UA', '').strip() or 'HexStack coin-app https://github.com/ziyaoyan1229-debug/coin-app'
START = '2026-03-01'           # 內建事件只到 2026-03，從這天開始補
FORCE = os.environ.get('MSTR_FORCE') == '1'
VERBOSE = os.environ.get('MSTR_VERBOSE') == '1'


def load(p, d):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return d


def get(url, js=True):
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Encoding': 'identity'})
            with urllib.request.urlopen(req, timeout=30) as r:
                b = r.read()
            time.sleep(0.15)                      # SEC 限制每秒 10 次
            return json.loads(b) if js else b.decode('utf-8', 'replace')
        except Exception as e:
            print('SEC 讀取失敗', url, getattr(e, 'code', ''), str(e)[:150])
            if getattr(e, 'code', 0) in (403, 404):
                raise
            time.sleep(2 ** i)
    raise RuntimeError('讀不到 ' + url)


class Tables(HTMLParser):
    """把 HTML 表格攤成 [[儲存格文字…]…]，順便收集全文"""
    def __init__(self):
        super().__init__(); self.rows = []; self.row = None; self.cell = None; self.text = []
    def handle_starttag(self, t, a):
        if t == 'tr': self.row = []
        elif t in ('td', 'th') and self.row is not None: self.cell = []
        elif t in ('br', 'p', 'div'): self.text.append('\n')
    def handle_endtag(self, t):
        if t in ('td', 'th') and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r'\s+', ' ', ''.join(self.cell)).strip()); self.cell = None
        elif t == 'tr' and self.row is not None:
            r = [c for c in self.row if c not in ('', '$', '%', ')')]
            if r: self.rows.append(r)
            self.row = None
        elif t in ('p', 'div', 'tr'): self.text.append('\n')
    def handle_data(self, d):
        if self.cell is not None: self.cell.append(d)
        self.text.append(d)


num = lambda s: float(re.sub(r'[^\d.]', '', s)) if re.search(r'\d', s or '') else None
money = lambda v, unit: v * (1000 if unit.lower().startswith('b') else 1) if v is not None else None   # 換成百萬美元


def parse_8k(doc):
    T = Tables(); T.feed(doc)
    text = re.sub(r'[ \t\xa0]+', ' ', html.unescape(''.join(T.text)))
    out = {}
    # 持幣：表頭有 Aggregate BTC Holdings 的那欄
    for i, r in enumerate(T.rows):
        hdr = ' '.join(r)
        if re.search(r'Aggregate\s+BTC\s+Holdings', hdr, re.I) and i + 1 < len(T.rows):
            ci = next(j for j, c in enumerate(r) if re.search(r'Aggregate\s+BTC\s+Holdings', c, re.I))
            for r2 in T.rows[i + 1:i + 4]:
                if ci < len(r2) and re.fullmatch(r'[\d,]{5,}', r2[ci].replace(' ', '')):
                    out['btc'] = num(r2[ci]); break          # 欄位對得上就用那一欄
                vals = [num(c) for c in r2 if re.fullmatch(r'[\d,]{5,}', c.replace(' ', ''))]
                if vals:
                    out['btc'] = max(vals); break           # 對不上時取最大的整數（持幣數一定比均價大）
            if 'btc' in out: break
    if 'btc' not in out:
        m = re.search(r'(?:holds?|held|holding)\s+(?:an\s+aggregate\s+of\s+)?(?:approximately\s+)?([\d,]{5,})\s+(?:bitcoins?|BTC)\b', text, re.I)
        if m: out['btc'] = num(m[1])
    # ATM：表頭有 Shares Sold／Net Proceeds；MSTR／Class A 那列是普通股，STR? 是優先股
    for i, r in enumerate(T.rows):
        hdr = ' '.join(r)
        if re.search(r'Shares\s+Sold', hdr, re.I) and re.search(r'Net\s+Proceeds', hdr, re.I):
            unit = 'b' if any(re.search(r'Net\s+Proceeds', c, re.I) and re.search(r'billion', c, re.I) for c in r) else 'm'
            for r2 in T.rows[i + 1:i + 12]:
                lab = r2[0]
                ns = [num(c) for c in r2[1:] if re.search(r'\d', c)]
                if len(ns) < 2: continue
                if re.search(r'\bMSTR\b|Class\s+A', lab, re.I):
                    out['atm_sh'] = out.get('atm_sh', 0) + ns[0]; out['atm_usd'] = out.get('atm_usd', 0) + money(ns[1], unit)
                elif re.search(r'\bSTR[A-Z]\b|Preferred', lab, re.I):
                    out['pref_usd'] = out.get('pref_usd', 0) + money(ns[1], unit)
                elif re.search(r'Total', lab, re.I):
                    break
            break
    # 可轉債定價／發行
    if re.search(r'convertible\s+senior\s+notes', text, re.I) and re.search(r'pric(?:ed|ing)|closed|completed|issued', text, re.I):
        m = re.search(r'\$\s?([\d.,]+)\s*(million|billion)\s+aggregate\s+principal\s+amount', text, re.I)
        if m:
            c = re.search(r'([\d.]+%)\s+Convertible\s+Senior\s+Notes\s+due\s+(\d{4})', text, re.I)
            out['conv_usd'] = money(num(m[1]), m[2]); out['conv_note'] = f'{c[1]} {c[2]} notes' if c else 'convertible notes'
    # 優先股 IPO／增發定價（不是每週 ATM）
    if re.search(r'Preferred\s+Stock', text, re.I) and re.search(r'pric(?:ed|ing)\s+of', text, re.I) and 'pref_usd' not in out:
        m = re.search(r'(?:gross|net)\s+proceeds[^.]{0,80}?\$\s?([\d.,]+)\s*(million|billion)', text, re.I)
        s = re.search(r'\((STR[A-Z])\)|Series\s+A\s+([\w ]{3,40}?)\s+Preferred', text)
        if m:
            out['pref_usd'] = money(num(m[1]), m[2]); out['pref_note'] = (s[1] or s[2]).strip() + ' preferred' if s else 'preferred'
    if VERBOSE:
        for r in T.rows[:30]: print('   |', ' | '.join(r)[:200])
    return out


def shares_base():
    """最近一季的流通股數（百萬股）：dei:EntityCommonStockSharesOutstanding，同一天的各類股加總"""
    f = get(f'https://data.sec.gov/api/xbrl/companyfacts/CIK{CIK.zfill(10)}.json')
    rows = (f.get('facts', {}).get('dei', {}).get('EntityCommonStockSharesOutstanding', {}).get('units', {}).get('shares')) or []
    by = {}
    for r in rows:
        by.setdefault(r['end'], {})[r.get('accn', '') + str(r.get('frame', '')) + str(r['val'])] = r['val']
    if not by: return None, None
    end = max(by)
    return end, sum(by[end].values()) / 1e6


def main():
    prev = load(PATH, {})
    if not FORCE and time.time() - prev.get('fetched', 0) < 6 * 3600:
        print('mstr.json 6 小時內抓過，跳過'); return
    try:
        sub = get(f'https://data.sec.gov/submissions/CIK{CIK.zfill(10)}.json')['filings']['recent']
    except Exception as e:
        if getattr(e, 'code', 0) == 403:
            print('SEC 拒絕（403）：SEC 要求 User-Agent 帶聯絡信箱，請在 repo secrets 設 SEC_UA，例如「HexStack 你的信箱」。這次沿用上一版 mstr.json')
            return
        raise
    parsed = prev.get('parsed', {})
    n_new = 0
    for k in range(len(sub['form'])):
        if sub['form'][k] != '8-K' or sub['filingDate'][k] < START: continue
        acc = sub['accessionNumber'][k]
        if acc in parsed: continue
        url = f"https://www.sec.gov/Archives/edgar/data/{CIK}/{acc.replace('-', '')}/{sub['primaryDocument'][k]}"
        try:
            p = parse_8k(get(url, js=False))
        except Exception as e:
            print('8-K 解析失敗', acc, e); continue
        p.update(date=sub['filingDate'][k], items=sub.get('items', [''] * len(sub['form']))[k], url=url)
        parsed[acc] = p; n_new += 1
        print('8-K', p['date'], acc, {x: p[x] for x in p if x not in ('url', 'date')})
    end, base = None, None
    try:
        end, base = shares_base()
        print('流通股數', end, base, '百萬股')
    except Exception as e:
        print('companyfacts 抓不到', e)
    F = sorted(parsed.values(), key=lambda p: p['date'])
    day = lambda s: int(calendar.timegm(time.strptime(s, '%Y-%m-%d')) // 86400)
    btc = [[day(p['date']), p['btc']] for p in F if p.get('btc')]
    shares = []
    if base:
        s = base
        shares.append([day(end), round(s, 3)])
        for p in F:
            if p['date'] > end and p.get('atm_sh'):
                s += p['atm_sh'] / 1e6; shares.append([day(p['date']), round(s, 3)])
    ev = []
    for p in F:
        if p.get('conv_usd'): ev.append(dict(d=day(p['date']), type='convert', usd=round(p['conv_usd']), note=p.get('conv_note', ''), url=p['url']))
        if p.get('atm_usd'): ev.append(dict(d=day(p['date']), type='atm', usd=round(p['atm_usd']), note=f"ATM {p.get('atm_sh', 0) / 1e6:.2f}M sh", url=p['url']))
        if p.get('pref_usd'): ev.append(dict(d=day(p['date']), type='pref', usd=round(p['pref_usd']), note=p.get('pref_note', 'preferred ATM'), url=p['url']))
    out = dict(fetched=int(time.time()), asof=F[-1]['date'] if F else None, btc=btc, shares=shares, ev=ev, parsed=parsed)
    with open(PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    print(f'mstr.json：新解析 {n_new} 份 8-K；持幣 {len(btc)} 筆（最新 {btc[-1] if btc else "—"}），股數 {len(shares)} 筆（最新 {shares[-1] if shares else "—"}），事件 {len(ev)} 個')


if __name__ == '__main__':
    main()
