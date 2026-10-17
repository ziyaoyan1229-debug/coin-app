"""通知：每 15 分鐘產生六類通知寫進 tg_log.json（網站「通知」頁的瀏覽器通知讀這個）；有設定 Telegram 時也發到各類頻道。
由 .github/workflows/klines.yml 每 15 分鐘執行。只用標準函式庫。
用法：python3 scripts/tg_notify.py <news.json> <資料夾（讀 BTC／ETH 15 分 K、MSTR／MSTU 1 小時 K、signals.json、paper.json；tg_state.json、tg_log.json 寫在這）>
Secrets：TG_TOKEN（機器人 token）＋每類頻道（@公開頻道名稱）：
  TG_CH_SIG 策略信號：8 個策略在 BTC／ETH 進場、加倉、出場、停損（signals.json，由 sig_notify.js 用 App 同一套引擎算）
  TG_CH_US  美股開盤：MSTR、MSTU 開盤與收盤，附估算 mNAV
  TG_CH_EV  重要事件：早上 8 點列今天的事件、有時間的事件前 1 小時提醒
  TG_CH_MKT 市場分析：早上 8 點早報、市場分析更新
  TG_CH_LV  關鍵價位：BTC 站上／跌破市場分析寫的支撐、壓力
  TG_CH_FG  恐懼貪婪極端：低於 20 或高於 80
沒設定的類別就不發（TG_CHAT 有設的話，沒有自己頻道的類別都發到 TG_CHAT）。每類第一次執行只記狀態，不補發舊的。
背景推播（iPhone 主畫面 App、Android、電腦，App 關著也收得到）：有設定 CF_API_TOKEN、CF_ACCOUNT_ID 時，
  找出 worker/push.js 部署後的網址寫進 push.json（App 用它訂閱），再把這次新的通知送給推播後端，由後端依各裝置開的類別推出去。"""
import calendar, hashlib, html, json, os, re, sys, time, urllib.parse, urllib.request

NEWS, D = sys.argv[1], sys.argv[2]
TOKEN = os.environ.get('TG_TOKEN', '').strip()
SITE = 'https://ziyaoyan1229-debug.github.io/coin-app/'
STATE = os.path.join(D, 'tg_state.json')
TW = 8 * 3600
CATS = [('sig', '策略信號'), ('us', '美股開盤'), ('ev', '重要事件'), ('mkt', '市場分析'), ('lv', '關鍵價位'), ('fg', '恐懼貪婪極端')]
FALL = os.environ.get('TG_CHAT', '').strip()
CH = {c: os.environ.get('TG_CH_' + c.upper(), '').strip() or FALL for c, _ in CATS}
TG = bool(TOKEN and any(CH.values()))   # 沒設定 Telegram 也照樣產生通知，寫進 tg_log.json 給網站的瀏覽器通知用
if not TG:
    print('沒設定 TG_TOKEN 或任何頻道：只寫 tg_log.json，不發 Telegram')


def load(p, default):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def send(chat, text):
    data = urllib.parse.urlencode(dict(chat_id=chat, text=text, parse_mode='HTML', disable_web_page_preview='true')).encode()
    for i in range(3):
        try:
            with urllib.request.urlopen(f'https://api.telegram.org/bot{TOKEN}/sendMessage', data, timeout=20) as r:
                if json.load(r).get('ok'):
                    return True
        except Exception as e:
            print('Telegram 傳送失敗', chat, getattr(e, 'code', ''), str(e)[:200])
            if getattr(e, 'code', 0) in (400, 401, 403, 404):
                return False
            time.sleep(2 ** i)
    return False


def csv_rows(name):
    try:
        with open(os.path.join(D, name)) as f:
            return [list(map(float, l.split(',')[:6])) for l in f.read().strip().split('\n')[1:] if l]
    except Exception:
        return []


esc = lambda s: html.escape(str(s or ''), quote=False)
f0 = lambda x: f'{x:,.0f}'
pc = lambda x: f"{'+' if x >= 0 else ''}{x * 100:.1f}%"
now = time.time()
twt = time.gmtime(now + TW)
today = time.strftime('%Y-%m-%d', twt)
news, paper = load(NEWS, {}), load(os.path.join(D, 'paper.json'), {})
M = news.get('market') or {}
st = load(STATE, {})
st.setdefault('init', {})
if st['init'] is True:          # 舊版狀態（單一頻道）
    st['init'] = {c: True for c, _ in CATS if c in ('ev', 'mkt')}
st.setdefault('ev', []); st.setdefault('log', []); st.setdefault('sig', []); st.setdefault('lvhit', {})
msgs = []                        # (類別, 內容, 附加欄位)
add = lambda c, m, **kw: msgs.append((c, m, kw))
btc15 = csv_rows('BTCUSDT_15m.csv')
btc = btc15[-1][4] if btc15 else (paper.get('market', {}).get('BTC', {}).get('price') or 0)


# 行事曆：「10/16」「10/27-28」；內容開頭 HH:MM 算到那個時間（台灣），沒有就算當天
def events():
    out = []
    for x in M.get('calendar') or []:
        m = re.match(r'\s*(\d{1,2})/(\d{1,2})', str(x.get('d', '')))
        if not m:
            continue
        tm = re.match(r'\s*(\d{1,2}):(\d{2})', str(x.get('e', '')))
        at = lambda y: calendar.timegm((y, int(m[1]), int(m[2]), int(tm[1]) if tm else 0, int(tm[2]) if tm else 0, 0)) - TW
        t = at(twt.tm_year)
        if t < now - 180 * 86400:
            t = at(twt.tm_year + 1)
        out.append(dict(t=t, timed=bool(tm), d=x.get('d', ''), title=re.sub(r'^\s*\d{1,2}:\d{2}\s*', '', str(x.get('e', ''))), key=f"{x.get('d')}|{x.get('e')}"))
    return sorted(out, key=lambda e: e['t'])


EV = events()
todays = [e for e in EV if time.strftime('%Y-%m-%d', time.gmtime(e['t'] + TW)) == today]
morning = 8 <= twt.tm_hour < 12

# ── 市場分析：早報、分析更新 ──
fg = None
if (morning and st.get('brief') != today) or st.get('fgday') != time.strftime('%Y-%m-%d', time.gmtime(now)):
    try:
        with urllib.request.urlopen('https://api.alternative.me/fng/?limit=2', timeout=15) as r:
            fg = json.load(r)['data']
    except Exception as e:
        print('恐懼貪婪抓不到', e)
ZH = {'Extreme Fear': '極度恐懼', 'Fear': '恐懼', 'Neutral': '中性', 'Greed': '貪婪', 'Extreme Greed': '極度貪婪'}
if morning and st.get('brief') != today:
    mk = paper.get('market') or {}
    L = [f'☀️ <b>HexStack 早報 {today[5:].replace("-", "/")}</b>']
    for s in ('BTC', 'ETH'):
        if s in mk:
            L.append(f"{s} {f0(mk[s]['price'])}（4h EMA200 {'之上' if mk[s].get('above_h4') else '之下'}）")
    if fg:
        L.append(f"恐懼貪婪 {fg[0]['value']} {ZH.get(fg[0]['value_classification'], '')}（昨天 {fg[1]['value']}）")
    if todays:
        L.append('📅 今天：' + '；'.join(esc(e['title']) for e in todays))
    if M.get('title'):
        L.append(f"\n📊 {esc(M['title'])}")
    L.append(f'\n<a href="{SITE}">打開 App</a>')
    add('mkt', '\n'.join(L))
    if todays:
        add('ev', '📅 <b>今天的重要事件</b>\n' + '\n'.join(f"・{time.strftime('%H:%M', time.gmtime(e['t'] + TW)) + ' ' if e['timed'] else ''}{esc(e['title'])}" for e in todays) + f'\n\n<a href="{SITE}#news">點開 App 看可能的影響</a>')
    st['brief'] = today
if M.get('updated') and M.get('updated') != st.get('market'):
    if st.get('market'):
        B = {'bull': '🟢 偏多', 'bear': '🔴 偏空'}.get(M.get('bias'), '⚪ 中性')
        sm = re.search(r'^\**(?:一句話|概要)\**[：:]\s*(.+)$', str(M.get('body') or ''), re.M)
        add('mkt', f"📊 <b>市場分析更新</b>　{B}\n{esc(M.get('title'))}" + (f"\n\n{esc(re.sub(r'[*]', '', sm[1]))}" if sm else '') + f"\n\n<a href=\"{SITE}#news\">看完整分析</a>")
    st['market'] = M['updated']

# ── 重要事件：前 1 小時 ──
for e in EV:
    if e['timed'] and 0 < e['t'] - now <= 70 * 60 and e['key'] not in st['ev']:
        add('ev', f"⏰ <b>{round((e['t'] - now) / 60)} 分鐘後</b>（台灣 {time.strftime('%H:%M', time.gmtime(e['t'] + TW))}）\n{esc(e['title'])}\n\n<a href=\"{SITE}#news\">點開 App 看可能的影響</a>")
        st['ev'].append(e['key'])
st['ev'] = st['ev'][-60:]

# ── 策略信號 ──
S = load(os.path.join(D, 'signals.json'), {})
TY = {'entry': '進場', 'add': '加倉', 'exit': '出場', 'tp': '減倉', 'stop': '停損'}
for m in S.get('marks') or []:
    if m['key'] in st['sig']:
        continue
    st['sig'].append(m['key'])
    if now - m['t'] > 6 * 3600:     # 太舊的（重算才出現的）只記不發
        continue
    side = '多' if m.get('side', 1) > 0 else '空'
    ic = {'entry': '🟢' if side == '多' else '🔴', 'add': '➕', 'stop': '⛔'}.get(m['type'], '🟠')
    add('sig', f"{ic} <b>{esc(m['sym'])} {side}單{TY.get(m['type'], m['type'])}</b>　約 {f0(m['price']) if m['sym'] == 'BTC' else format(m['price'], ',.1f')}\n{esc(m['name'])}" + (f"（{esc(m['text'])}）" if m.get('text') else '') + f"\n台灣 {time.strftime('%m/%d %H:%M', time.gmtime(m['t'] + TW))} 收線\n\n<i>回測規則自動訊號，非投資建議</i>", st=m['st'], sym=m['sym'])
st['sig'] = st['sig'][-400:]

# ── 美股開盤／收盤（MSTR、MSTU，紐約時間判斷，含夏令） ──
def ny_offset(t):
    y = time.gmtime(t).tm_year
    sun = lambda mo, n: [d for d in range(1, 32) if time.gmtime(calendar.timegm((y, mo, d, 12, 0, 0))).tm_wday == 6][n - 1]
    a = calendar.timegm((y, 3, sun(3, 2), 7, 0, 0)); b = calendar.timegm((y, 11, sun(11, 1), 6, 0, 0))
    return -4 * 3600 if a <= t < b else -5 * 3600


nyo = ny_offset(now)
ny = time.gmtime(now + nyo)
nyday = time.strftime('%Y-%m-%d', ny)
R, U = csv_rows('MSTR_1h.csv'), csv_rows('MSTU_1h.csv')


def day_split(rows):
    """回傳 (今天紐約日期的 K 棒, 前一個交易日收盤)"""
    td = [r for r in rows if time.strftime('%Y-%m-%d', time.gmtime(r[0] / 1000 + nyo)) == nyday]
    prev = [r for r in rows if time.strftime('%Y-%m-%d', time.gmtime(r[0] / 1000 + nyo)) < nyday]
    return td, (prev[-1][4] if prev else None)


def stk_meta():
    try:
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
        f = [x for x in os.listdir(root) if x.startswith('stk-')][0]
        S_ = json.loads(re.sub(r'^window\.STK=|;\s*$', '', open(os.path.join(root, f), encoding='utf-8').read().strip()))['MSTR']
        return S_['shares'][-1], S_['btc'][-1]
    except Exception as e:
        print('讀不到 MSTR 股數／持幣', e)
        return None, None


if R and ny.tm_wday < 5:
    hm = ny.tm_hour * 60 + ny.tm_min
    tdR, pR = day_split(R)
    tdU, pU = day_split(U) if U else ([], None)
    sh, hold = stk_meta()
    mnav = lambda px: px * sh * 1e6 / (hold * btc) if sh and hold and btc else None
    line = lambda n, td, p: f"{n} {td[-1][4]:,.2f}（{pc(td[-1][4] / p - 1)}）" if td and p else ''
    if tdR and 9 * 60 + 30 <= hm < 11 * 60 and st.get('usopen') != nyday:
        mv = mnav(tdR[-1][4])
        add('us', f"🔔 <b>美股開盤</b>（台灣 {time.strftime('%H:%M', twt)}）\n" + '\n'.join(x for x in (line('MSTR', tdR, pR), line('MSTU', tdU, pU)) if x)
            + (f"\nmNAV 約 {mv:.2f}（估算）" if mv else '') + f"\nBTC {f0(btc)}\n\n<a href=\"{SITE}#chart\">看 MSTR 盤中圖</a>")
        st['usopen'] = nyday
    if tdR and 16 * 60 + 5 <= hm < 18 * 60 and st.get('usclose') != nyday:
        mv = mnav(tdR[-1][4])
        add('us', f"🏁 <b>美股收盤</b>\n" + '\n'.join(x for x in (line('MSTR', tdR, pR), line('MSTU', tdU, pU)) if x)
            + (f"\nmNAV 約 {mv:.2f}（估算）" if mv else '') + f"\nBTC {f0(btc)}")
        st['usclose'] = nyday

# ── 關鍵價位：BTC 15 分 K 收盤穿過市場分析寫的支撐／壓力（同一價位同方向 6 小時內只發一次） ──
lvsec = re.search(r'##\s*關鍵價位([\s\S]*?)(?:\n##|\Z)', str(M.get('body') or ''))
num = lambda s: [float(x.replace(',', '')) for x in re.findall(r'\d{1,3}(?:,\d{3})+|\d{4,6}', s)]
sup = num((re.search(r'支撐([^；;\n]*)', lvsec[1]) or [None, ''])[1]) if lvsec else []
res = num((re.search(r'壓力([^；;\n]*)', lvsec[1]) or [None, ''])[1]) if lvsec else []
if len(btc15) >= 2 and (sup or res):
    prev, cur = st.get('lvlast') or btc15[-2][4], btc15[-1][4]
    for L_, kind in [(x, '支撐') for x in sup] + [(x, '壓力') for x in res]:
        up, dn = prev < L_ <= cur, prev > L_ >= cur
        if not (up or dn):
            continue
        k = f"{L_:.0f}|{'up' if up else 'dn'}"
        if now - st['lvhit'].get(k, 0) < 6 * 3600:
            continue
        st['lvhit'][k] = now
        add('lv', f"{'📈' if up else '📉'} <b>BTC {'站上' if up else '跌破'} {f0(L_)}</b>（{kind}）\n現在 {f0(cur)}・15 分 K 收盤\n\n<a href=\"{SITE}#chart\">看圖</a>")
    st['lvlast'] = cur
st['lvhit'] = {k: v for k, v in st['lvhit'].items() if now - v < 86400}

# ── 恐懼貪婪極端（一天一次） ──
if fg:
    v = int(fg[0]['value'])
    st['fgday'] = time.strftime('%Y-%m-%d', time.gmtime(now))
    if (v <= 20 or v >= 80) and st.get('fgsent') != fg[0].get('timestamp'):
        add('fg', f"{'😱' if v <= 20 else '🤑'} <b>恐懼貪婪 {v}　{ZH.get(fg[0]['value_classification'], '')}</b>\n昨天 {fg[1]['value']}。{'市場極度恐慌，歷史上常是相對低點區，但也可能續跌。' if v <= 20 else '市場極度貪婪，追高風險升高。'}\n\n<a href=\"{SITE}#news\">看歷史線圖</a>")
        st['fgsent'] = fg[0].get('timestamp')

# ── 記錄：每則通知都進 tg_log.json（網站通知頁列表＋瀏覽器通知用 id 判斷新的）──
for c, m, kw in msgs:
    st['seq'] = st.get('seq', 0) + 1
    st['log'].insert(0, dict(id=st['seq'], ts=int(now), t=time.strftime('%Y-%m-%d %H:%M', time.gmtime(now + TW)), cat=c, text=m, **kw))   # 策略信號多記 st、sym，網站可以只通知選的策略
fresh = st['log'][:len(msgs)][::-1]   # 這次新增的（舊到新），給背景推播
# ── 發送：每類頻道各自第一次只發「已開啟」 ──
sent = 0
for c, name in CATS:
    chat = CH[c] if TG else ''
    if not chat:
        continue
    mine = [m for cc, m, _ in msgs if cc == c]
    if not st['init'].get(c):
        mine = [m for m in mine if m.startswith('☀️') or m.startswith('📅')] or [f'✅ HexStack「{name}」通知已開啟。\n<a href="{SITE}#notify">打開 App</a>']
        st['init'][c] = True
    for m in mine:
        if send(chat, m):
            sent += 1
st['log'] = [x for x in st['log'] if x.get('id')][:60]   # 舊版沒有 id 的紀錄丟掉
print('通知：產生', len(msgs), '則，Telegram 發出', sent)
with open(STATE, 'w', encoding='utf-8') as f:
    json.dump(st, f, ensure_ascii=False)
# 給網站「通知」頁：每類頻道連結＋最近的通知（TG_LINK_<類> 可放私人頻道邀請連結；@名稱 自動產生 t.me 連結）
link = lambda c: os.environ.get('TG_LINK_' + c.upper(), '').strip() or (f'https://t.me/{CH[c][1:]}' if CH[c].startswith('@') else '')
with open(os.path.join(D, 'tg_log.json'), 'w', encoding='utf-8') as f:
    json.dump(dict(channels={c: link(c) for c, _ in CATS}, items=st['log']), f, ensure_ascii=False)

# ── 背景推播：送到 Cloudflare 上的推播後端（worker/push.js，由 push.yml 部署）──
CF_TOKEN, CF_ACC = os.environ.get('CF_API_TOKEN', '').strip(), os.environ.get('CF_ACCOUNT_ID', '').strip()
if CF_TOKEN and CF_ACC:
    def cf(path, data=None, key=None, url=None):
        req = urllib.request.Request(url or f'https://api.cloudflare.com/client/v4/accounts/{CF_ACC}{path}', data=data and json.dumps(data).encode(),
                                     headers={'Authorization': 'Bearer ' + (key or CF_TOKEN), 'Content-Type': 'application/json', 'User-Agent': 'HexStack'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    try:
        sub = cf('/workers/subdomain')['result']['subdomain']
        url = f'https://hexstack-push.{sub}.workers.dev'
        with open(os.path.join(D, 'push.json'), 'w', encoding='utf-8') as f:
            json.dump(dict(url=url), f)
        key = os.environ.get('PUSH_KEY', '').strip() or hashlib.sha256((CF_TOKEN + 'hexstack-push').encode()).hexdigest()
        items = []
        for x in fresh:
            L = [l.strip() for l in re.sub(r'<[^>]+>', '', re.sub(r'<a [^>]*>.*?</a>', '', x['text'])).split('\n')]
            L = [html.unescape(l) for l in L if l]
            items.append(dict(title=L[0] if L else 'HexStack', body='\n'.join(L[1:]), cat=x['cat'], st=x.get('st'), tag=f"hs{x['id']}", url='./#notify'))
        for i in range(0, len(items), 20):
            print('背景推播：', cf('', dict(items=items[i:i + 20]), key, url + '/send'))
    except Exception as e:
        print('背景推播失敗', getattr(e, 'code', ''), str(e)[:200])
