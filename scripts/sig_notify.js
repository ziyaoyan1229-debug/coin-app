// 策略信號：用 App 同一套回測引擎（index.html 裡的「策略回測引擎」）和預設最佳參數，
// 把 data 分支最新的 15 分 K 接成 1 小時 K，算 8 個策略在 BTC／ETH 最近 3 天的進出場，寫成 signals.json 給 tg_notify.py 發通知。
// 有設定 CF_API_TOKEN、CF_ACCOUNT_ID 時，也照使用者在 App 鎖定的參數各算一份（訊號帶 lk）。
// 用法：node scripts/sig_notify.js <資料夾（含 BTCUSDT_15m.csv、ETHUSDT_15m.csv；signals.json 也寫在這）>
// 只用 Node 內建模組；資金費率不補（內建資料之後算 0），策略 8 的 5 分點火只到內建資料尾端。
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), D = process.argv[2] || 'data';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
global.window = global;
for (const pre of ['data-', 'ign-']) {
  const f = fs.readdirSync(path.join(ROOT, 'assets')).find(x => x.startsWith(pre) && x.endsWith('.js'));
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8'));
}
// 1 小時 K：把 15 分 K 每 4 根（同一小時、都收完）合成一根，接在內建資料後面
const now = Date.now() / 1000;
for (const sym of ['BTC', 'ETH']) {
  const d = DATA[sym], p = path.join(D, `${sym}USDT_15m.csv`);
  if (!fs.existsSync(p)) continue;
  const H = new Map();
  for (const l of fs.readFileSync(p, 'utf8').trim().split('\n')) {
    const r = l.split(',').map(Number); if (!isFinite(r[0]) || r.length < 6) continue;
    const t = r[0] / 1000, h = Math.floor(t / 3600) * 3600;
    if (!H.has(h)) H.set(h, []);
    H.get(h).push(r);
  }
  let c = d.c0; for (let i = 0; i < d.n; i++) c += d.dc[i];
  let n = d.n;
  for (;;) {
    const t = d.t0 + n * 3600, q = (H.get(t) || []).sort((a, b) => a[0] - b[0]);
    if (q.length !== 4 || t + 3600 > now) break;
    const C = Math.round(q[3][4] * d.sc), hi = Math.max(...q.map(x => x[2])), lo = Math.min(...q.map(x => x[3]));
    d.dc.push(C - c); c = C; d.o.push(Math.round(q[0][1] * d.sc) - C); d.h.push(Math.round(hi * d.sc) - C); d.l.push(Math.round(lo * d.sc) - C); d.v.push(q.reduce((a, x) => a + x[5], 0)); n++;
  }
  console.log(sym, '內建', d.n, '根，接上', n - d.n, '根，到', new Date((d.t0 + n * 3600) * 1000).toISOString());
  d.n = n;
}
// 從 index.html 取出引擎、預設參數、策略名稱
const eng = html.match(/<script>\/\/ 策略回測引擎[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
vm.runInThisContext(eng);
const bi = html.indexOf('const BEST={'); let k = bi + 11, dep = 0;
for (; k < html.length; k++) { if (html[k] === '{') dep++; else if (html[k] === '}' && --dep === 0) break; }
// 策略 7（knifeB）、8（my）的預設參數寫在字面量後面的 BEST.xx=… 單行裡，一起帶進來
const bestX = html.slice(k + 1, html.indexOf('for(const st in BEST)for(const k in BEST[st])', k)).split('\n').filter(l => /^(BEST\.|Object\.assign\(BEST)/.test(l)).join('\n');
const BEST = vm.runInThisContext('(()=>{var BEST=' + html.slice(bi + 11, k + 1) + ';\n' + bestX + '\nreturn BEST})()');
const simSrc = html.match(/function simulate\(st,sym,t0,t1,p\)\{[^\n]*\}/)[0];
const E = Engine; global.E = E;
// 策略框架（倉位倍數、回撤降倉）：simulate 會先把參數交給 fwP
vm.runInThisContext(html.match(/const DDCUT=[^\n]*\n/)[0].replace(/^const /, 'var ').replace(/,KSC=/, ';var KSC=') + html.match(/function fwP\(p\)\{[^\n]*\n[^\n]*\}/)[0]);
const simulate = vm.runInThisContext('(' + simSrc + ')');
const NAME = {}; for (const m of html.matchAll(/<option value="(\w+)">(\d+)\.\s*([^<]+)<\/option>/g)) if (BEST[m[1]]) NAME[m[1]] = m[3].trim();
const LOCK = { knife: 'ETH', knifeB: 'BTC' };
const out = [], D1 = 86400;
function marks(st, sym, p, kp, extra) {
  try {
    const Hb = E.load(sym), t1 = Hb.T[Hb.n - 1] + 3600;
    const r = simulate(st, sym, t1 - 370 * D1, t1, Object.assign({ capital: 1000 }, BEST[st][sym], p));
    for (const m of r.marks || []) if (m.t >= t1 - 3 * D1 && m.type !== 'liq') {
      const i = Math.min(Hb.n - 1, Math.max(0, Math.floor((m.t - Hb.T[0]) / 3600) - 1));
      out.push(Object.assign({ key: `${kp}${st}|${sym}|${m.t}|${m.type}|${m.side || 1}`, st, name: NAME[st], sym, t: m.t, type: m.type, side: m.side || 1, text: m.text || '', price: Math.round(Hb.C[i] * 100) / 100 }, extra));
    }
  } catch (e) { console.log(st, sym, '算不出來', e.message); }
}
for (const st of Object.keys(NAME)) for (const sym of ['BTC', 'ETH']) {
  if (st === 'cus' || !BEST[st][sym] || (LOCK[st] && LOCK[st] !== sym)) continue;   // 自訂策略只照使用者存的規則算
  marks(st, sym, {}, '', {});
}
// 使用者在 App 鎖定的策略參數（推播後端 /locks）：每組各算一次，訊號帶 lk，只推給鎖定那組的裝置
async function locked() {
  const tok = (process.env.CF_API_TOKEN || '').trim(), acc = (process.env.CF_ACCOUNT_ID || '').trim();
  if (!tok || !acc) return;
  try {
    const sub = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/workers/subdomain`, { headers: { Authorization: 'Bearer ' + tok } })).json()).result.subdomain;
    const key = (process.env.PUSH_KEY || '').trim() || require('crypto').createHash('sha256').update(tok + 'hexstack-push').digest('hex');
    const L = await (await fetch(`https://hexstack-push.${sub}.workers.dev/locks`, { headers: { Authorization: 'Bearer ' + key } })).json();
    let n = 0;
    for (const x of (Array.isArray(L) ? L : []).slice(0, 300)) {
      if (!NAME[x.st] || !BEST[x.st] || !BEST[x.st][x.sym] || (LOCK[x.st] && LOCK[x.st] !== x.sym) || !/^[0-9a-f]{12}$/.test(x.h)) { console.log('略過', x.st, x.sym); continue; }
      delete (x.p || {}).capital;
      marks(x.st, x.sym, x.p || {}, 'L' + x.h + '|', { lk: x.h }); n++;
    }
    console.log('鎖定參數：', n, '組');
  } catch (e) { console.log('讀鎖定參數失敗', e.message); }
}
locked().then(() => {
  out.sort((a, b) => a.t - b.t);
  const H0 = E.load('BTC');
  fs.writeFileSync(path.join(D, 'signals.json'), JSON.stringify({ asof: H0.T[H0.n - 1] + 3600, marks: out }));
  console.log('signals.json：最近 3 天', out.length, '個訊號');
});
