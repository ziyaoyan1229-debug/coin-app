"""Telegram 推播：把幣策略 App 的重點發到一個 Telegram 頻道（大家加入頻道就收得到）。
由 .github/workflows/klines.yml 每 15 分鐘執行；沒設定 TG_TOKEN、TG_CHAT 這兩個 secret 就什麼都不做。\n網站「通知」頁讀這裡寫出的 tg_log.json（頻道連結、最近 30 則通知）。
用法：python3 scripts/tg_notify.py <news.json> <資料夾（讀 paper.json 的價格；tg_state.json、tg_log.json 寫在這）>
發什麼：
  1. 每天早上 8 點（台灣）早報：BTC／ETH 價格、恐懼貪婪、今天的事件
  2. 重要事件前 1 小時提醒（行事曆內容開頭有 HH:MM 的）
  3. 市場分析更新（標題、偏多／偏空、概要）
第一次執行只記下目前狀態，不補發舊的。只用標準函式庫。"""
import html, json, os, re, sys, time, urllib.parse, urllib.request

NEWS, D = sys.argv[1], sys.argv[2]
TOKEN, CHAT = os.environ.get('TG_TOKEN', '').strip(), os.environ.get('TG_CHAT', '').strip()
SITE = 'https://ziyaoyan1229-debug.github.io/coin-app/'
STATE = os.path.join(D, 'tg_state.json')
TW = 8 * 3600
if not TOKEN or not CHAT:
    print('沒設定 TG_TOKEN／TG_CHAT，跳過 Telegram 推播')
    sys.exit(0)


def load(p, default):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def send(text):
    data = urllib.parse.urlencode(dict(chat_id=CHAT, text=text, parse_mode='HTML', disable_web_page_preview='true')).encode()
    for i in range(3):
        try:
            with urllib.request.urlopen(f'https://api.telegram.org/bot{TOKEN}/sendMessage', data, timeout=20) as r:
                if json.load(r).get('ok'):
                    return True
        except Exception as e:
            print('Telegram 傳送失敗', getattr(e, 'code', ''), str(e)[:200])
            if getattr(e, 'code', 0) in (400, 401, 403, 404):
                return False
            time.sleep(2 ** i)
    return False


esc = lambda s: html.escape(str(s or ''), quote=False)
now = time.time()
twt = time.gmtime(now + TW)
today = time.strftime('%Y-%m-%d', twt)
news, paper = load(NEWS, {}), load(os.path.join(D, 'paper.json'), {})
M = news.get('market') or {}
st = load(STATE, {})
first = not st.get('init')
st.setdefault('ev', []); st.setdefault('log', [])
msgs = []


# 行事曆：「10/16」「10/27-28」「10/31-11/1」；內容開頭 HH:MM 算到那個時間（台灣），沒有就算當天
def events():
    out = []
    for x in M.get('calendar') or []:
        m = re.match(r'\s*(\d{1,2})/(\d{1,2})', str(x.get('d', '')))
        if not m:
            continue
        tm = re.match(r'\s*(\d{1,2}):(\d{2})', str(x.get('e', '')))
        y = twt.tm_year
        t = time.mktime((y, int(m[1]), int(m[2]), int(tm[1]) if tm else 0, int(tm[2]) if tm else 0, 0, 0, 0, 0)) - time.timezone - TW
        if t < now - 180 * 86400:
            t = time.mktime((y + 1, int(m[1]), int(m[2]), int(tm[1]) if tm else 0, int(tm[2]) if tm else 0, 0, 0, 0, 0)) - time.timezone - TW
        title = re.sub(r'^\s*\d{1,2}:\d{2}\s*', '', str(x.get('e', '')))
        out.append(dict(t=t, timed=bool(tm), d=x.get('d', ''), title=title, key=f"{x.get('d')}|{x.get('e')}"))
    return sorted(out, key=lambda e: e['t'])


EV = events()

# 1. 早報：8:00～11:59 之間、今天還沒發過
if twt.tm_hour >= 8 and twt.tm_hour < 12 and st.get('brief') != today:
    mk = paper.get('market') or {}
    L = [f'☀️ <b>HexStack 早報 {today[5:].replace("-", "/")}</b>']
    for s in ('BTC', 'ETH'):
        if s in mk:
            x = mk[s]
            L.append(f"{s} {x['price']:,.0f}" + ('' if s == 'BTC' else '') + f"（4h EMA200 {'之上' if x.get('above_h4') else '之下'}）")
    try:
        with urllib.request.urlopen('https://api.alternative.me/fng/?limit=2', timeout=15) as r:
            fg = json.load(r)['data']
        ZH = {'Extreme Fear': '極度恐懼', 'Fear': '恐懼', 'Neutral': '中性', 'Greed': '貪婪', 'Extreme Greed': '極度貪婪'}
        L.append(f"恐懼貪婪 {fg[0]['value']} {ZH.get(fg[0]['value_classification'], fg[0]['value_classification'])}（昨天 {fg[1]['value']}）")
    except Exception as e:
        print('恐懼貪婪抓不到', e)
    todays = [e for e in EV if time.strftime('%Y-%m-%d', time.gmtime(e['t'] + TW)) == today]
    if todays:
        L.append('\n📅 <b>今天的事件</b>')
        L += [f"・{time.strftime('%H:%M', time.gmtime(e['t'] + TW)) + ' ' if e['timed'] else ''}{esc(e['title'])}" for e in todays]
    nxt = [e for e in EV if e['t'] > now and e not in todays][:2]
    if nxt:
        L.append('\n⏭ 接下來：' + '；'.join(f"{esc(e['d'])} {esc(e['title'])}" for e in nxt))
    if M.get('title'):
        L.append(f"\n📊 市場分析：{esc(M['title'])}")
    L.append(f'\n<a href="{SITE}">打開 App</a>')
    msgs.append('\n'.join(L))
    st['brief'] = today

# 2. 事件前 1 小時（有時間的事件）
for e in EV:
    if e['timed'] and 0 < e['t'] - now <= 70 * 60 and e['key'] not in st['ev']:
        mins = round((e['t'] - now) / 60)
        msgs.append(f"⏰ <b>{mins} 分鐘後</b>（台灣 {time.strftime('%H:%M', time.gmtime(e['t'] + TW))}）\n{esc(e['title'])}\n\n<a href=\"{SITE}#news\">點開 App 看可能的影響</a>")
        st['ev'].append(e['key'])
st['ev'] = st['ev'][-60:]

# 3. 市場分析更新
if M.get('updated') and M.get('updated') != st.get('market'):
    if st.get('market'):
        B = {'bull': '🟢 偏多', 'bear': '🔴 偏空'}.get(M.get('bias'), '⚪ 中性')
        body = str(M.get('body') or '')
        sm = re.search(r'^\**(?:一句話|概要)\**[：:]\s*(.+)$', body, re.M)
        msgs.append(f"📊 <b>市場分析更新</b>　{B}\n{esc(M.get('title'))}" + (f"\n\n{esc(re.sub(r'[*]', '', sm[1]))}" if sm else '') + f"\n\n<a href=\"{SITE}#news\">看完整分析</a>")
    st['market'] = M['updated']


if first:   # 第一次：只記狀態，不補發（早報除外，讓設定好的人馬上知道有在動）
    msgs = [m for m in msgs if m.startswith('☀️')] or [f'✅ HexStack 推播已開啟。每天早上 8 點早報、重要事件前 1 小時提醒、市場分析更新都會發在這裡。\n<a href="{SITE}">打開 App</a>']
st['init'] = True
sent = 0
for m in msgs:
    if send(m):
        sent += 1
        st['log'].insert(0, dict(t=time.strftime('%Y-%m-%d %H:%M', time.gmtime(time.time() + TW)), text=m))
st['log'] = st['log'][:30]
print('Telegram：要發', len(msgs), '則，成功', sent)
with open(STATE, 'w', encoding='utf-8') as f:
    json.dump(st, f, ensure_ascii=False)
# 給網站「通知」頁：頻道連結＋最近的通知（TG_LINK 可放私人頻道的邀請連結；公開頻道用 @名稱 就會自動產生）
link = os.environ.get('TG_LINK', '').strip() or (f'https://t.me/{CHAT[1:]}' if CHAT.startswith('@') else '')
with open(os.path.join(D, 'tg_log.json'), 'w', encoding='utf-8') as f:
    json.dump(dict(channel=link, items=st['log']), f, ensure_ascii=False)
