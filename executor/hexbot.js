#!/usr/bin/env node
// HexStack 執行器（hexbot）：在自己的電腦／舊手機上，用 App 同一套回測引擎跑策略、自動下單。
// 只用 Node 內建模組（Node 18 以上）。用法：
//   node hexbot.js                 正常執行（模擬盤或 Bybit），手機 App 掃主控台的 QR 配對
//   node hexbot.js --no-tunnel     不開 Cloudflare 對外通道（只在區網／本機用）
//   node hexbot.js --replay 14     用最近 14 天歷史 K 線快轉測試（模擬盤，不連交易所，資料寫在 hexbot-data/replay/）
// 資料夾：程式旁邊的 hexbot-data/（config.json 設定、state.json 狀態、log.jsonl 紀錄、cache/ 快取）
// 交易所 API Key 只能寫在 config.json 或本機主控台（http://localhost:8787），遠端 API 改不到。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), vm = require('vm'), cp = require('child_process');

const VER = '1.0';
// 執行器版號：App 要靠新版執行器的功能時（例如 AI 查資產總覽）用它判斷電腦上的執行器是不是舊版，改到 App 依賴的行為就加 1
const BUILD = 164;
const APP = 'https://ziyaoyan1229-debug.github.io/coin-app/';
const SITE = (process.env.HEXBOT_SITE || APP).replace(/\/?$/, '/');     // 引擎來源（測試可改成本機網址）
const RAW = 'https://raw.githubusercontent.com/ziyaoyan1229-debug/coin-app/data/data/';
const RELAY_DEF = 'https://hexstack-push.hexstack-df20e2.workers.dev';   // 跟 App 一樣：先讀 data 分支 push.json，讀不到用這個
const H1 = 3600, D1 = 86400, HIST_DAYS = 1000, SIM_DAYS = 400;
const ORIGIN_OK = o => o === 'https://ziyaoyan1229-debug.github.io' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const ARG = (() => { const a = process.argv.slice(2), o = {}; for (let i = 0; i < a.length; i++) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a[i]); if (!m) continue; if (m[2] != null) o[m[1]] = m[2]; else if (a[i + 1] != null && !a[i + 1].startsWith('--')) o[m[1]] = a[++i]; else o[m[1]] = true; } return o; })();
if (ARG.version) { console.log(VER); process.exit(0); }
let SEA = false; try { SEA = require('node:sea').isSea(); } catch (e) {}
const HOME = SEA ? path.dirname(process.execPath) : __dirname;
const REPLAY = ARG.replay != null ? Math.max(2, Math.min(120, +ARG.replay || 14)) : 0;
const DIR0 = path.resolve(ARG.dir || process.env.HEXBOT_DIR || path.join(HOME, 'hexbot-data'));
const DIR = REPLAY ? path.join(DIR0, 'replay') : DIR0;
const F = { cfg: path.join(DIR, 'config.json'), st: path.join(DIR, 'state.json'), log: path.join(DIR, 'log.jsonl'), cache: path.join(DIR, 'cache') };

// ───────── 小工具 ─────────
let VNOW = null;   // 快轉測試用的虛擬時間（毫秒）
const now = () => VNOW != null ? VNOW : Date.now(), nowS = () => Math.floor(now() / 1000);
const rnd = n => crypto.randomBytes(n).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest('hex');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const tpe = t => new Date((t + 8 * 3600) * 1000).toISOString();          // 台北時間
const tpeDay = t => tpe(t).slice(0, 10), tpeHM = t => tpe(t).slice(5, 16).replace('T', ' ');
const r2 = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (x, d = 2) => (+x).toLocaleString('en-US', { maximumFractionDigits: d });
const fpx = x => !x ? '0' : x >= 100 ? fmt(x, 2) : x >= 1 ? fmt(x, 4) : (+x).toPrecision(4);
const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isCoin = s => typeof s === 'string' && /^[A-Z0-9]{2,12}$/.test(s);
async function fetchT(url, opt = {}, ms = 15000) { const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms); try { return await fetch(url, Object.assign({ signal: ac.signal }, opt)); } finally { clearTimeout(tm); } }
async function getJ(url, opt, ms) { const r = await fetchT(url, opt, ms); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
async function getT(url, ms) { const r = await fetchT(url, {}, ms); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }

fs.mkdirSync(F.cache, { recursive: true });
if (REPLAY && !ARG.keep) { for (const f of ['state.json', 'log.jsonl', 'config.json']) try { fs.unlinkSync(path.join(DIR, f)); } catch (e) {} }

// ───────── 設定 ─────────
// C.limOff[k]＝true：使用者在 App 關掉這條上限（預設全部開著）
const limOn = k => !(C.limOff && C.limOff[k]), effLev = () => limOn('maxLev') ? C.limits.maxLev : 20;
const LIM0 = { maxPosPct: 30, maxLev: 3, dayLossPct: 5, maxDDPct: 20 }, LIMR = { maxPosPct: [1, 1000], maxLev: [0.1, 20], dayLossPct: [0.1, 100], maxDDPct: [0.1, 100] };
function loadCfg() {
  const old = readJ(F.cfg, null);
  const c = Object.assign({ hostName: os.hostname(), token: rnd(32), hostId: rnd(8), port: 8787, exchange: 'bybit', testnet: true, apiKey: '', apiSecret: '', allowLive: false, limits: {}, startEquity: 1000, catchupPct: 0.5, tunnel: true, relay: '', funds: [] }, old || {});
  c.limits = Object.assign({}, LIM0, c.limits);
  if (REPLAY) Object.assign(c, { exchange: 'paper', tunnel: false, relay: '', port: +ARG.port || c.port });
  if (!old || JSON.stringify(old) !== JSON.stringify(c)) writeJ(F.cfg, c);
  return c;
}
const C = loadCfg(), FIRST = !fs.existsSync(F.st);
if (ARG.port) C.port = +ARG.port;
const saveCfg = () => writeJ(F.cfg, C);
const kHash = () => sha256(C.token);   // 給推播後端驗證用（後端只存這個，不存 token）

// ───────── 紀錄 ─────────
const LOGS = [];
(() => { try { const st = fs.statSync(F.log); if (st.size > 8e6) fs.renameSync(F.log, F.log.replace(/\.jsonl$/, '.1.jsonl')); } catch (e) {}
  try { for (const l of fs.readFileSync(F.log, 'utf8').trim().split('\n').slice(-2000)) if (l) LOGS.push(JSON.parse(l)); } catch (e) {} })();
const TYPE = { open: '開倉', close: '平倉', stop: '停損', tp: '停利', skip: '略過', pause: '暫停', resume: '恢復', halt: '煞車', error: '錯誤', info: '訊息', report: '報告' };
function log(type, o = {}) {
  const e = Object.assign({ t: nowS(), type }, o);
  for (const k of ['px', 'qty', 'pnl']) if (typeof e[k] === 'number') e[k] = +e[k].toPrecision(8);
  LOGS.push(e); if (LOGS.length > 3000) LOGS.splice(0, 1000);
  try { fs.appendFileSync(F.log, JSON.stringify(e) + '\n'); } catch (x) {}
  if (!REPLAY || !ARG.quiet) console.log(`[${tpeHM(e.t)}] ${TYPE[type] || type}${e.name ? ' ' + e.name : ''}${e.sym ? ' ' + e.sym : ''}${e.side ? (e.side > 0 ? ' 多' : ' 空') : ''}${e.qty ? ' ' + fmt(e.qty, 6) : ''}${e.px ? ' @' + fpx(e.px) : ''}${e.pnl ? ' 損益 ' + fmt(e.pnl) : ''}${e.text ? '　' + e.text : ''}`);
  return e;
}

// ───────── 狀態 ─────────
const S = Object.assign({ v: 1, startT: nowS(), nextId: 1, strategies: [], paper: null, acct: {}, report: { day: '' }, lastTickAt: 0, lastBar: 0 }, readJ(F.st, {}));
if (!S.paper) S.paper = { cash: C.startEquity, pos: {}, sl: {}, fees: 0, ev: [] };
// 模擬交易所：App「模擬盤」畫面的各家虛擬帳戶（預設四大交易所各 10,000 USDT），帳本 key＝'sim:<交易所>'
const SIM_EX = ['binance', 'okx', 'bybit', 'bitget', 'gate', 'kucoin', 'mexc', 'coinbase', 'kraken'];
const simNew = start => ({ start, cash: start, pos: {}, sl: {}, fees: 0, ev: [] });
if (!S.sims) S.sims = { binance: simNew(10000), okx: simNew(10000), bybit: simNew(10000), bitget: simNew(10000) };
const acct = L => S.acct[L] || (S.acct[L] = { start: 0, startT: nowS(), peak: 0, mdd: 0, dayKey: '', dayStart: 0, halt: null, lastSet: {}, offset: {}, stops: {}, setAt: {}, curve: [] });
let DIRTY = true; const save = () => { if (!DIRTY) return; DIRTY = false; try { writeJ(F.st, S); } catch (e) { console.log('存檔失敗', e.message); } };
const dirty = () => { DIRTY = true; };

// ───────── 引擎（從 index.html 取出，跟 App 同一套）─────────
const ENG = { ok: false, src: '', hash: '', at: 0, ctx: null, BEST: null, NAME: {}, simulate: null, igCalc: null };
function repoRoot() { const r = path.join(HOME, '..'); return !ARG.remote && fs.existsSync(path.join(r, 'index.html')) && fs.existsSync(path.join(r, 'assets')) ? r : null; }
const assetRefs = html => ['data', 'ign'].map(k => { const m = html.match(new RegExp(`<script src="(assets/${k}-\\w+\\.js)"`)); if (!m) throw new Error('index.html 找不到 ' + k + ' 資料檔'); return m[1]; });
async function engineFiles(force) {
  const R = repoRoot();
  if (R) { const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8'), [a, b] = assetRefs(html); return { html, data: fs.readFileSync(path.join(R, a), 'utf8'), ign: fs.readFileSync(path.join(R, b), 'utf8'), src: 'repo' }; }
  const d = path.join(F.cache, 'site'); fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
  const meta = readJ(path.join(d, 'meta.json'), {});
  if (force || !meta.at || nowS() - meta.at > D1 || REPLAY && !meta.refs) {
    try {
      const html = await getT(SITE + 'index.html', 30000), refs = assetRefs(html);
      for (const f of refs) if (!fs.existsSync(path.join(d, f))) { const t = await getT(SITE + f, 120000); fs.writeFileSync(path.join(d, f), t); }
      fs.writeFileSync(path.join(d, 'index.html'), html); writeJ(path.join(d, 'meta.json'), { at: nowS(), refs });
      for (const f of fs.readdirSync(path.join(d, 'assets'))) if (!refs.includes('assets/' + f)) fs.unlinkSync(path.join(d, 'assets', f));
      Object.assign(meta, { at: nowS(), refs });
    } catch (e) { if (!meta.refs) throw new Error('下載引擎失敗：' + e.message); console.log('下載引擎失敗，先用快取：', e.message); }
  }
  return { html: fs.readFileSync(path.join(d, 'index.html'), 'utf8'), data: fs.readFileSync(path.join(d, meta.refs[0]), 'utf8'), ign: fs.readFileSync(path.join(d, meta.refs[1]), 'utf8'), src: 'site' };
}
function loadEngine(f) {
  const ctx = vm.createContext({ console });
  vm.runInContext('var window = globalThis;', ctx);
  vm.runInContext(f.data, ctx, { filename: 'data.js' }); vm.runInContext(f.ign, ctx, { filename: 'ign.js' });
  const html = f.html, m = html.match(/<script>\/\/ 策略回測引擎[\s\S]*?<\/script>/);
  if (!m) throw new Error('index.html 找不到策略回測引擎');
  let eng = m[0].replace(/^<script>|<\/script>$/g, '');
  // 每個 run* 結束時把權益函數 E 和停損交出來：用 E 對價格微分得到期末部位（各策略記部位的方式不一樣，這樣最通用）
  const n = (eng.match(/return summary\(final,/g) || []).length;
  if (n < 8) throw new Error('引擎格式不符（summary 只有 ' + n + ' 個）');
  const T = v => `typeof ${v} !== 'undefined' ? ${v} : 0`;
  eng = eng.replace(/return summary\(final,/g, `return (root.__FIN && root.__FIN({ E, liq, stop: ${T('stop')}, wStop: ${T('wStop')}, tpPx: ${T('tpPx')}, units: ${T('units')}, avg: ${T('avg')}, s: ${T('s')} })), summary(final,`);
  vm.runInContext(eng, ctx, { filename: 'engine.js' });
  vm.runInContext('var E = Engine;', ctx);
  const bi = html.indexOf('const BEST={'); let k = bi + 11, dep = 0;
  if (bi < 0) throw new Error('index.html 找不到 BEST');
  for (; k < html.length; k++) { if (html[k] === '{') dep++; else if (html[k] === '}' && --dep === 0) break; }
  // 策略 7（knifeB）、8（my）的預設參數寫在字面量後面的 BEST.xx=… 單行裡，一起帶進來
  const bestX = html.slice(k + 1, html.indexOf('for(const st in BEST)for(const k in BEST[st])', k)).split('\n').filter(l => /^(BEST\.|Object\.assign\(BEST)/.test(l)).join('\n');
  const BEST = vm.runInContext('(()=>{var BEST=' + html.slice(bi + 11, k + 1) + ';\n' + bestX + '\nreturn BEST})()', ctx);
  for (const st in BEST) for (const s in BEST[st]) { const b = BEST[st][s]; if (!('slip' in b)) b.slip = true; if (!('comp' in b)) b.comp = true; }
  vm.runInContext(html.match(/const DDCUT=[^\n]*\n/)[0].replace(/^const /, 'var ').replace(/,KSC=/, ';var KSC=') + html.match(/function fwP\(p\)\{[^\n]*\n[^\n]*\}/)[0], ctx);
  const simulate = vm.runInContext('(' + html.match(/function simulate\(st,sym,t0,t1,p\)\{[^\n]*\}/)[0] + ')', ctx);
  const ig = html.match(/function igCalc\(g,d,i0,K\)\{[^\n]*(?:\n[ \t][^\n]*)*/);
  const NAME = {}; for (const x of html.matchAll(/<option value="(\w+)">(\d+)\.\s*([^<]+)<\/option>/g)) if (BEST[x[1]]) NAME[x[1]] = x[3].trim();
  Object.assign(ENG, { ok: true, src: f.src, hash: sha256(html).slice(0, 12), at: nowS(), ctx, BEST, NAME, simulate, igCalc: ig ? vm.runInContext('(' + ig[0] + ')', ctx) : null });
  buildMaster();
}
const COST = () => ENG.ctx.Engine.COST;
const slipOf = (sym, stop) => { const c = COST(); sym = String(sym).split('.')[0]; return (stop ? c.stopSlip : c.slip) * (sym === 'BTC' || sym === 'ETH' ? 1 : 2.5); };

// ───────── K 線：內建資料 + 之後抓的 1h K（主檔 MK），每次算策略時切一段給引擎 ─────────
const MK = {}, IG = {}, K5 = {};
const kFile = s => path.join(F.cache, `k1h-${s}.json`), k5File = s => path.join(F.cache, `k5-${s}.json`);
function buildMaster() {
  const D = ENG.ctx.DATA;
  for (const s of Object.keys(MK)) delete MK[s];
  for (const s of ['BTC', 'ETH']) {
    const d = D[s]; if (!d || !d.dc) continue;
    const n = d.n, m = { t0: d.t0, sc: d.sc, n0: n, O: new Array(n), H: new Array(n), L: new Array(n), C: new Array(n), V: new Array(n), F: {} };
    let c = d.c0; for (let i = 0; i < n; i++) { c += d.dc[i]; m.C[i] = c / d.sc; m.O[i] = (c + d.o[i]) / d.sc; m.H[i] = (c + d.h[i]) / d.sc; m.L[i] = (c + d.l[i]) / d.sc; m.V[i] = d.v[i]; }
    for (const k in d.f) m.F[k] = d.f[k] / 1e6;
    m.n = n; MK[s] = m;
    const g = ENG.ctx.IGND && ENG.ctx.IGND[s]; if (g) IG[s] = { th: g.th, ms: g.ms.slice(), ev: Object.assign({}, g.ev), n0: g.ms.length };
  }
  for (const f of fs.readdirSync(F.cache)) { const x = /^k1h-(\w+)\.json$/.exec(f); if (x) { const j = readJ(path.join(F.cache, f), null); if (j && j.rows) addBars(x[1], j.rows, j.fund, true); } }
}
const mEnd = s => MK[s] ? MK[s].t0 + MK[s].n * H1 : 0;   // 主檔最後一根的結束時間
// 接上新的 1h K（[t秒,o,h,l,c,v]）；缺的小時用前一根收盤補平（最多補 48 根）
function addBars(sym, rows, fund, quiet) {
  rows = rows.filter(r => r && isFinite(r[4]) && r[0] + H1 <= nowS()).sort((a, b) => a[0] - b[0]);
  if (!rows.length) return 0;
  let m = MK[sym];
  if (!m) { m = MK[sym] = { t0: rows[0][0], sc: 1, n0: 0, n: 0, O: [], H: [], L: [], C: [], V: [], F: {} }; }
  let add = 0;
  for (const r of rows) {
    const e = mEnd(sym); if (r[0] < e) continue;
    if (r[0] > e) { if (!m.n || r[0] - e > 48 * H1) { if (!m.n) { m.t0 = r[0]; } else break; } else { const c = m.C[m.n - 1]; for (let t = e; t < r[0]; t += H1) { m.O.push(c); m.H.push(c); m.L.push(c); m.C.push(c); m.V.push(0); m.n++; } } }
    m.O.push(+r[1]); m.H.push(+r[2]); m.L.push(+r[3]); m.C.push(+r[4]); m.V.push(+r[5] || 0); m.n++; add++;
  }
  if (fund) for (const k in fund) { const i = Math.round((+k - m.t0) / H1); if (i >= m.n0 && i < m.n) m.F[i] = fund[k]; }
  if (!m.n0 || m.sc === 1) { const mx = Math.max(...m.H.slice(-2000)); m.sc = 10 ** Math.max(0, 6 - Math.floor(Math.log10(mx || 1))); }
  if (add && !quiet) persistBars(sym);
  return add;
}
function persistBars(sym) {
  const m = MK[sym]; if (!m) return; const i0 = Math.max(m.n0, m.n - (m.n0 ? 1e9 : HIST_DAYS * 24 + 48)), rows = [], fund = {};
  for (let i = i0; i < m.n; i++) rows.push([m.t0 + i * H1, m.O[i], m.H[i], m.L[i], m.C[i], m.V[i]]);
  for (const k in m.F) if (+k >= i0) fund[m.t0 + k * H1] = m.F[k];
  try { writeJ(kFile(sym), { rows, fund }); } catch (e) {}
}
// 引擎看到的資料：到 tEnd 為止、往前 HIST_DAYS 天（同格式 DATA），點火資料也跟著切
function setViews(tEnd) {
  const D = ENG.ctx.DATA, G = ENG.ctx.IGND || (ENG.ctx.IGND = {});
  for (const s in MK) {
    const m = MK[s], iE = Math.min(m.n, Math.floor((tEnd - m.t0) / H1)), i0 = Math.max(0, iE - HIST_DAYS * 24), sc = m.sc;
    const d = { t0: m.t0 + i0 * H1, n: Math.max(0, iE - i0), sc, c0: 0, dc: [], o: [], h: [], l: [], v: [], f: {} };
    let pc = 0;
    for (let i = i0; i < iE; i++) { const c = Math.round(m.C[i] * sc); d.dc.push(c - pc); pc = c; d.o.push(Math.round(m.O[i] * sc) - c); d.h.push(Math.round(m.H[i] * sc) - c); d.l.push(Math.round(m.L[i] * sc) - c); d.v.push(m.V[i]); }
    for (const k in m.F) if (+k >= i0 && +k < iE) d.f[k - i0] = Math.round(m.F[k] * 1e6);
    D[s] = d;
    const g = IG[s];
    if (g) { const ev = {}; for (const k in g.ev) if (+k >= i0 && +k < iE) ev[k - i0] = g.ev[k]; G[s] = { th: g.th, ms: g.ms.slice(i0, iE), ev }; }
  }
  ENG.ctx.Engine.__clear();
}
// 抓 1h K：Binance 永續 → Bybit → data 分支 15 分 K（只有 BTC／ETH）
async function binance1h(sym, from) {
  let out = [];
  for (let k = 0; k < 20 && from + H1 <= nowS(); k++) {
    const j = await getJ(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=1h&startTime=${from * 1000}&limit=1500`);
    if (!Array.isArray(j) || !j.length) break;
    out = out.concat(j.map(r => [r[0] / 1000, +r[1], +r[2], +r[3], +r[4], +r[5]]));
    if (j.length < 1500) break; from = j[j.length - 1][0] / 1000 + H1;
  }
  return out;
}
async function bybit1h(sym, from) {
  let out = [];
  for (let k = 0; k < 30 && from + H1 <= nowS(); k++) {
    const end = from + 999 * H1;
    const j = await getJ(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}USDT&interval=60&start=${from * 1000}&end=${end * 1000}&limit=1000`);
    const L = j && j.result && j.result.list; if (!L || !L.length) break;
    out = out.concat(L.map(r => [+r[0] / 1000, +r[1], +r[2], +r[3], +r[4], +r[5]]).reverse());
    from = end + H1;
  }
  return out;
}
async function ghRows(sym) {
  if (sym !== 'BTC' && sym !== 'ETH') return [];
  const t = await getT(`${RAW}${sym}USDT_15m.csv`, 30000), H = new Map();
  for (const ln of t.trim().split('\n').slice(1)) { const a = ln.split(','), ts = +a[0] / 1000; if (!isFinite(ts)) continue; const h = Math.floor(ts / H1) * H1;
    let x = H.get(h); if (!x) { x = [h, +a[1], +a[2], +a[3], +a[4], 0, 0, ts]; H.set(h, x); } else if (ts < x[7]) { x[1] = +a[1]; x[7] = ts; } x[2] = Math.max(x[2], +a[2]); x[3] = Math.min(x[3], +a[3]); if (ts >= x[7]) x[4] = +a[4]; x[5] += +a[5]; x[6]++; }
  return [...H.values()].filter(x => x[6] === 4).sort((a, b) => a[0] - b[0]).map(x => x.slice(0, 6));
}
const DSRC = {};
async function refreshBars(sym) {
  const from = MK[sym] ? mEnd(sym) : Math.floor(nowS() / H1) * H1 - HIST_DAYS * D1;
  if (from + H1 > nowS()) return true;
  let rows = [], src = '';
  for (const [nm, f] of [['binance', binance1h], ['bybit', bybit1h], ['github', ghRows]]) {
    try { rows = await f(sym, from); if (rows.length) { src = nm; break; } } catch (e) {}
  }
  if (!rows.length) return false;
  let fund = null;
  if (src === 'binance') try { const j = await getJ(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}USDT&startTime=${(from - 8 * H1) * 1000}&limit=1000`); fund = {}; for (const x of j) fund[Math.floor(x.fundingTime / 3600000) * H1] = +x.fundingRate; } catch (e) {}
  addBars(sym, rows, fund); DSRC[sym] = src;
  return true;
}
// 策略 8 的 5 分點火：Binance 5 分 K（不通就用 data 分支最近 3 天），存起來慢慢累積
async function refreshIgn(sym) {
  const g = IG[sym], m = MK[sym]; if (!g || !m || !ENG.igCalc) return;
  const K = K5[sym] || (K5[sym] = readJ(k5File(sym), { T: [], H: [], L: [], C: [], V: [] }));
  const last = K.T.length ? K.T[K.T.length - 1] : m.t0 + g.n0 * H1 - 300 * 300;
  let rows = [];
  try { for (let f = last + 300, k = 0; k < 20 && f + 300 <= nowS(); k++) { const j = await getJ(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=5m&startTime=${f * 1000}&limit=1500`); if (!j.length) break; rows = rows.concat(j.map(r => [r[0] / 1000, +r[2], +r[3], +r[4], +r[5]])); if (j.length < 1500) break; f = j[j.length - 1][0] / 1000 + 300; } } catch (e) {}
  if (!rows.length) try { const t = await getT(`${RAW}${sym}USDT_5m.csv`); rows = t.trim().split('\n').slice(1).map(l => { const a = l.split(','); return [+a[0] / 1000, +a[2], +a[3], +a[4], +a[5]]; }); } catch (e) {}
  for (const r of rows) if (r[0] + 300 <= nowS() && (!K.T.length || r[0] > K.T[K.T.length - 1])) { K.T.push(r[0]); K.H.push(r[1]); K.L.push(r[2]); K.C.push(r[3]); K.V.push(r[4]); }
  const cut = K.T.length - 40 * 288; if (cut > 0) for (const k of ['T', 'H', 'L', 'C', 'V']) K[k].splice(0, cut);
  try { writeJ(k5File(sym), K); } catch (e) {}
  if (K.T.length > 300) try { ENG.igCalc(g, { t0: m.t0, n: m.n }, g.n0, K); } catch (e) { log('error', { text: '點火資料計算失敗：' + e.message }); }
}

// ───────── 價格 ─────────
const PX = {};
// 交易所層級的部位代號：BTC＝永續合約、BTC.S＝現貨、BTC.M＝槓桿（全倉借貸）
const MKT = { fut: '', spot: '.S', mrg: '.M' }, MKT_NAME = { fut: '永續合約', spot: '現貨', mrg: '槓桿' };
const mktOf = g => MKT[g && g.mkt] != null ? g.mkt : 'fut';
const xk = g => g.sym + MKT[mktOf(g)];
const baseOf = k => String(k).split('.')[0];
const mktK = k => /\.S$/.test(k) ? 'spot' : /\.M$/.test(k) ? 'mrg' : 'fut';
const MRG_LEV = 3;     // 槓桿（借貸）帳戶的最大倍數：各家全倉槓桿最保守的上限
const SPOT_FEE = 0.001;
const px = s => { s = baseOf(s); return PX[s] && PX[s].px || (MK[s] ? MK[s].C[MK[s].n - 1] : 0); };
let ghPx = { at: 0, v: {} };
async function refreshPrices(syms) {
  for (const s of syms) {
    let v = 0;
    try { v = +(await getJ(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${s}USDT`, {}, 8000)).price; } catch (e) {}
    if (!v) try { v = +(await getJ(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}USDT`, {}, 8000)).result.list[0].lastPrice; } catch (e) {}
    if (!v && (s === 'BTC' || s === 'ETH')) {
      if (nowS() - ghPx.at > 300) { ghPx.at = nowS(); for (const x of ['BTC', 'ETH']) try { const t = (await getT(`${RAW}${x}USDT_15m.csv`)).trim(); ghPx.v[x] = +t.slice(t.lastIndexOf('\n') + 1).split(',')[4]; } catch (e) {} }
      v = ghPx.v[s] || 0;
    }
    if (v > 0) PX[s] = { px: v, t: nowS() };
  }
}

// ───────── 交易所 ─────────
// 模擬盤：虛擬帳戶，用最新價 ± 引擎滑價成交、扣手續費；交易所層級的停損／停利每分鐘用價格檢查
class PaperExchange {
  constructor(s) { this.s = s; this.name = 'paper'; this.slipMul = 1; }
  async price(sym) { return px(sym); }
  async getEquity() { let e = this.s.cash; for (const [k, p] of Object.entries(this.s.pos)) if (p.q) e += p.q * (px(k) - p.avg); return e; }
  async getPositions() { return Object.entries(this.s.pos).filter(([, p]) => p.q).map(([sym, p]) => { const mark = px(sym) || p.avg, sl = this.s.sl[sym] || {}; return { sym, side: sgn(p.q), qty: Math.abs(p.q), entry: p.avg, stop: sl.stop || 0, tp: sl.tp || 0, mark, upnl: p.q * (mark - p.avg) }; }); }
  async position(sym) { return (this.s.pos[sym] || {}).q || 0; }
  async round(sym, q) { return Math.floor(q * 1e8) / 1e8; }
  async minQty(sym) { return 1 / (px(sym) || 1); }   // 名目 1 USDT
  async marketOrder(sym, side, qty, reduceOnly, kind) {
    const p0 = px(sym); if (!p0) throw new Error('沒有 ' + sym + ' 價格');
    const cur = this.s.pos[sym] || { q: 0, avg: 0 }; let q = qty;
    if (reduceOnly) q = sgn(cur.q) === -side ? Math.min(q, Math.abs(cur.q)) : 0;
    if (!(q > 0)) return { qty: 0, px: p0, fee: 0 };
    const fill = p0 * (1 + side * slipOf(sym, kind === 'stop') * this.slipMul), fee = q * fill * feeOf(sym);
    const nq = cur.q + side * q;
    if (cur.q && sgn(cur.q) !== side) { const red = Math.min(q, Math.abs(cur.q)); this.s.cash += sgn(cur.q) * red * (fill - cur.avg); if (Math.abs(nq) > 1e-12 && sgn(nq) === side) cur.avg = fill; }
    else cur.avg = cur.q ? (cur.avg * Math.abs(cur.q) + fill * q) / (Math.abs(cur.q) + q) : fill;
    cur.q = Math.abs(nq) < 1e-12 ? 0 : nq; this.s.cash -= fee; this.s.fees += fee;
    if (cur.q) this.s.pos[sym] = cur; else { delete this.s.pos[sym]; delete this.s.sl[sym]; }
    return { qty: q, px: fill, fee };
  }
  async setStop(sym, stop, tp) { if (stop || tp) this.s.sl[sym] = { stop: stop || 0, tp: tp || 0 }; else delete this.s.sl[sym]; }
  async closeAll() { for (const [sym, p] of Object.entries(this.s.pos)) if (p.q) await this.marketOrder(sym, -sgn(p.q), Math.abs(p.q), true); }
  // 每分鐘：交易所層級的停損／停利（price 可傳區間高低點）
  async checkStops(hiLo) {
    for (const [sym, sl] of Object.entries(this.s.sl)) {
      const p = this.s.pos[sym]; if (!p || !p.q) continue;
      const s = sgn(p.q), [hi, lo] = hiLo && hiLo[sym] || [px(sym), px(sym)], adv = s > 0 ? lo : hi, fav = s > 0 ? hi : lo;
      const hitS = sl.stop && (s > 0 ? adv <= sl.stop : adv >= sl.stop), hitT = !hitS && sl.tp && (s > 0 ? fav >= sl.tp : fav <= sl.tp);
      if (!hitS && !hitT) continue;
      const lvl = hitS ? sl.stop : sl.tp, fill = lvl * (1 - s * (hitS ? slipOf(sym, true) : 0)), q = Math.abs(p.q), fee = q * fill * feeOf(sym);
      this.s.cash += s * q * (fill - p.avg) - fee; this.s.fees += fee; delete this.s.pos[sym]; delete this.s.sl[sym];
      this.s.ev.push({ t: nowS(), sym, kind: hitS ? 'stop' : 'tp', px: fill, qty: q, fee });
      if (this.s.ev.length > 50) this.s.ev.splice(0, 10);
    }
  }
  async stopFills(sym, since) { return this.s.ev.filter(e => e.sym === sym && e.t >= since); }
  // 槓桿帳戶的借款利息（每小時扣一次）：做空借的是幣、做多超過權益的部分借 USDT
  interest(h) {
    let lg = 0, out = 0;
    for (const [k, p] of Object.entries(this.s.pos)) if (mktK(k) === 'mrg' && p.q) { const n = Math.abs(p.q) * px(k); if (p.q < 0) out += n; else lg += n; }
    out += Math.max(0, lg - Math.max(0, this.s.cash)); if (!(out > 0)) return 0;
    const fee = out * MRG_RATE * h; this.s.cash -= fee; this.s.fees += fee; return fee;
  }
}
const MRG_RATE = 0.1 / 8760;    // 模擬盤借款年利率約 10%
const feeOf = k => mktK(k) === 'fut' ? COST().fee : SPOT_FEE;

// Bybit v5（USDT 永續，單向持倉）。照官方 v5 文件寫的，**還沒有在真的帳戶上測過**（liveTested:false）。
// 簽名：HMAC-SHA256(timestamp + apiKey + recvWindow + (GET 的 query 字串 | POST 的 JSON body))
class BybitExchange {
  constructor(c) { this.key = c.apiKey; this.sec = c.apiSecret; this.base = c.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com'; this.recv = '5000'; this.off = 0; this.inst = {}; this.levOk = {}; this.name = 'bybit'; this.maxLev = c.limits.maxLev; this.ready = false; }
  async req(method, p, params, signed = true) {
    const ts = String(Date.now() + this.off);
    const qs = method === 'GET' ? new URLSearchParams(params || {}).toString() : '', body = method === 'GET' ? '' : JSON.stringify(params || {});
    const h = { 'Content-Type': 'application/json' };
    if (signed) Object.assign(h, { 'X-BAPI-API-KEY': this.key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': this.recv, 'X-BAPI-SIGN': hmac(this.sec, ts + this.key + this.recv + (method === 'GET' ? qs : body)) });
    const r = await fetchT(this.base + p + (qs ? '?' + qs : ''), { method, headers: h, body: method === 'GET' ? undefined : body }, 15000);
    const j = await r.json().catch(() => ({ retCode: -1, retMsg: 'HTTP ' + r.status }));
    if (j.retCode !== 0) { const e = new Error(`Bybit ${j.retCode} ${j.retMsg}`); e.code = j.retCode; throw e; }
    return j.result;
  }
  async init() {
    if (this.ready) return;
    try { const t = await this.req('GET', '/v5/market/time', {}, false); this.off = +t.timeSecond * 1000 - Date.now(); } catch (e) {}
    try { await this.req('POST', '/v5/position/switch-mode', { category: 'linear', coin: 'USDT', mode: 0 }); } catch (e) { if (e.code !== 110025) console.log('切單向持倉：', e.message); }
    this.ready = true;
  }
  async price(sym) { const r = await this.req('GET', '/v5/market/tickers', { category: 'linear', symbol: sym + 'USDT' }, false); return +r.list[0].lastPrice; }
  async getEquity() {
    await this.init();
    for (const accountType of ['UNIFIED', 'CONTRACT']) {
      try { const r = await this.req('GET', '/v5/account/wallet-balance', { accountType }); const a = r.list && r.list[0]; if (!a) continue;
        if (a.totalEquity !== '' && a.totalEquity != null && accountType === 'UNIFIED') return +a.totalEquity;
        const u = (a.coin || []).find(c => c.coin === 'USDT'); if (u) return +u.equity;
      } catch (e) { if (accountType === 'CONTRACT') throw e; }
    }
    throw new Error('讀不到 Bybit 權益');
  }
  async getPositions() {
    const r = await this.req('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    return (r.list || []).filter(x => +x.size > 0).map(x => ({ sym: x.symbol.replace(/USDT$/, ''), side: x.side === 'Buy' ? 1 : -1, qty: +x.size, entry: +x.avgPrice, stop: +x.stopLoss || 0, tp: +x.takeProfit || 0, mark: +x.markPrice, upnl: +x.unrealisedPnl }));
  }
  async position(sym) { const r = await this.req('GET', '/v5/position/list', { category: 'linear', symbol: sym + 'USDT' }); const x = (r.list || [])[0]; return x && +x.size ? (x.side === 'Buy' ? 1 : -1) * +x.size : 0; }
  async instrument(sym) {
    if (this.inst[sym]) return this.inst[sym];
    const r = await this.req('GET', '/v5/market/instruments-info', { category: 'linear', symbol: sym + 'USDT' }, false), x = r.list && r.list[0];
    if (!x) throw new Error('Bybit 沒有 ' + sym + 'USDT 永續');
    return (this.inst[sym] = { step: +x.lotSizeFilter.qtyStep, min: +x.lotSizeFilter.minOrderQty, tick: +x.priceFilter.tickSize });
  }
  async round(sym, q) { const i = await this.instrument(sym), d = (String(i.step).split('.')[1] || '').length; return +(Math.floor(q / i.step + 1e-9) * i.step).toFixed(d); }
  async minQty(sym) { return (await this.instrument(sym)).min; }
  async lev(sym) {
    if (this.levOk[sym]) return; const l = String(Math.max(1, Math.ceil(this.maxLev)));
    try { await this.req('POST', '/v5/position/set-leverage', { category: 'linear', symbol: sym + 'USDT', buyLeverage: l, sellLeverage: l }); } catch (e) { if (e.code !== 110043) throw e; }
    this.levOk[sym] = 1;
  }
  async marketOrder(sym, side, qty, reduceOnly) {
    await this.init(); const q = await this.round(sym, qty); if (!(q > 0)) return { qty: 0, px: 0, fee: 0 };
    if (!reduceOnly) await this.lev(sym);
    const o = await this.req('POST', '/v5/order/create', { category: 'linear', symbol: sym + 'USDT', side: side > 0 ? 'Buy' : 'Sell', orderType: 'Market', qty: String(q), reduceOnly: !!reduceOnly, positionIdx: 0, orderLinkId: 'hx' + Date.now().toString(36) + rnd(3) });
    for (let k = 0; k < 8; k++) {
      await sleep(500);
      for (const ep of ['/v5/order/realtime', '/v5/order/history']) {
        try { const r = await this.req('GET', ep, { category: 'linear', orderId: o.orderId }), x = r.list && r.list[0];
          if (x && (x.orderStatus === 'Filled' || x.orderStatus === 'PartiallyFilledCanceled' || x.orderStatus === 'Cancelled' && +x.cumExecQty > 0)) return { qty: +x.cumExecQty, px: +x.avgPrice, fee: +x.cumExecFee || 0 };
          if (x && (x.orderStatus === 'Rejected' || x.orderStatus === 'Cancelled')) throw new Error('Bybit 訂單 ' + x.orderStatus + ' ' + (x.rejectReason || ''));
        } catch (e) { if (/訂單/.test(e.message)) throw e; }
      }
    }
    throw new Error('Bybit 下單後查不到成交（orderId ' + o.orderId + '）');
  }
  async setStop(sym, stop, tp) {
    const i = await this.instrument(sym), d = (String(i.tick).split('.')[1] || '').length, f = v => v ? (Math.round(v / i.tick) * i.tick).toFixed(d) : '0';
    try { await this.req('POST', '/v5/position/trading-stop', { category: 'linear', symbol: sym + 'USDT', tpslMode: 'Full', positionIdx: 0, stopLoss: f(stop), takeProfit: f(tp), slTriggerBy: 'LastPrice', tpTriggerBy: 'LastPrice' }); }
    catch (e) { if (e.code !== 34040 && e.code !== 10001) throw e; }   // 34040＝沒變；10001＝沒有持倉
  }
  async closeAll() { for (const p of await this.getPositions()) await this.marketOrder(p.sym, -p.side, p.qty, true); }
  async stopFills(sym, since) {
    const r = await this.req('GET', '/v5/execution/list', { category: 'linear', symbol: sym + 'USDT', startTime: String(since * 1000), limit: '50' });
    return (r.list || []).filter(x => /StopLoss|TakeProfit|TrailingStop/.test(x.stopOrderType || '')).map(x => ({ t: Math.floor(+x.execTime / 1000), kind: /TakeProfit/.test(x.stopOrderType) ? 'tp' : 'stop', px: +x.execPrice, qty: +x.execQty, fee: +x.execFee || 0 }));
  }
}

// ── 其他交易所實盤（USDT 永續、單向持倉、全倉），介面跟 BybitExchange 一樣。照 2026-10 官方文件寫的，**還沒有在真的帳戶上測過**，請先用模擬交易／測試網 ──
const dec = x => { const t = String(x), m = t.match(/e-(\d+)$/); return m ? +m[1] + (t.split('e')[0].split('.')[1] || '').length : (t.split('.')[1] || '').length; };   // 1e-8 這種科學記號也要算對
const floorTo = (q, step) => +(Math.floor(q / step + 1e-9) * step).toFixed(dec(step));
const tickTo = (v, tick) => (Math.round(v / tick) * tick).toFixed(dec(tick));
const cid = () => 'hx' + Date.now().toString(36) + rnd(3);
async function waitFill(get, name, id) {
  for (let k = 0; k < 10; k++) { await sleep(500); let r = null; try { r = await get(); } catch (e) { if (e.final) throw e; } if (r) return r; }
  throw new Error(name + ' 下單後查不到成交（' + id + '）');
}
const finalErr = m => Object.assign(new Error(m), { final: true });

// 幣安 USDⓈ-M。簽名：HMAC-SHA256(query 字串) 轉 hex，參數一律放 query。測試網（模擬交易）是 demo-fapi.binance.com，要用模擬交易建的金鑰
// 停損停利：2025-12 起舊的 STOP_MARKET 下單介面不收（-4120），改用 Algo 條件單 /fapi/v1/algoOrder（closePosition＝整個部位）
class BinanceExchange {
  constructor(c) { this.key = c.apiKey; this.sec = c.apiSecret; this.base = c.testnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com'; this.off = 0; this.inst = null; this.levOk = {}; this.name = 'binance'; this.maxLev = c.limits.maxLev; this.ready = false; }
  async req(method, p, params = {}, signed = true, base = this.base) {
    const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    if (signed) { q.set('timestamp', String(Date.now() + this.off)); q.set('recvWindow', '5000'); q.set('signature', hmac(this.sec, q.toString())); }
    const qs = q.toString(), r = await fetchT(base + p + (qs ? '?' + qs : ''), { method, headers: signed ? { 'X-MBX-APIKEY': this.key } : {} }, 15000);
    const j = await r.json().catch(() => ({ code: -1, msg: 'HTTP ' + r.status }));
    if (!r.ok || j && typeof j.code === 'number' && j.code < 0) { const e = new Error(`幣安 ${j.code} ${j.msg || 'HTTP ' + r.status}`); e.code = j.code; throw e; }
    return j;
  }
  async init() {
    if (this.ready) return;
    try { this.off = +(await this.req('GET', '/fapi/v1/time', {}, false)).serverTime - Date.now(); } catch (e) {}
    try { await this.req('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: 'false' }); } catch (e) { if (e.code !== -4059) console.log('幣安切單向持倉：', e.message); }
    this.ready = true;
  }
  async price(sym) { return +(await this.req('GET', '/fapi/v1/ticker/price', { symbol: sym + 'USDT' }, false)).price; }
  async getEquity() {
    await this.init(); const a = await this.req('GET', '/fapi/v3/account'), u = (a.assets || []).find(x => x.asset === 'USDT');
    if (u) return +u.marginBalance; if (a.totalMarginBalance != null) return +a.totalMarginBalance; throw new Error('讀不到幣安合約權益');
  }
  async algos(sym) { const r = await this.req('GET', '/fapi/v1/openAlgoOrders', sym ? { symbol: sym + 'USDT' } : {}); return Array.isArray(r) ? r : r.orders || r.rows || []; }
  async getPositions() {
    const r = await this.req('GET', '/fapi/v3/positionRisk'); let al = []; try { al = await this.algos(); } catch (e) {}
    return (r || []).filter(x => +x.positionAmt && /USDT$/.test(x.symbol)).map(x => { const o = al.filter(a => a.symbol === x.symbol), f = t => +((o.find(a => (a.orderType || a.type) === t) || {}).triggerPrice || 0);
      return { sym: x.symbol.replace(/USDT$/, ''), side: +x.positionAmt > 0 ? 1 : -1, qty: Math.abs(+x.positionAmt), entry: +x.entryPrice, stop: f('STOP_MARKET'), tp: f('TAKE_PROFIT_MARKET'), mark: +x.markPrice, upnl: +x.unRealizedProfit }; });
  }
  async position(sym) { const r = await this.req('GET', '/fapi/v3/positionRisk', { symbol: sym + 'USDT' }); return (r || []).reduce((a, x) => a + (+x.positionAmt || 0), 0); }
  async instrument(sym) {
    if (!this.inst) { const r = await this.req('GET', '/fapi/v1/exchangeInfo', {}, false); this.inst = {}; for (const s of r.symbols || []) this.inst[s.symbol] = s; }
    const s = this.inst[sym + 'USDT']; if (!s || s.contractType !== 'PERPETUAL') throw new Error('幣安沒有 ' + sym + 'USDT 永續');
    const F = t => (s.filters || []).find(f => f.filterType === t) || {}, lot = F('MARKET_LOT_SIZE').stepSize ? F('MARKET_LOT_SIZE') : F('LOT_SIZE');
    return { step: +lot.stepSize, min: +lot.minQty, tick: +F('PRICE_FILTER').tickSize };
  }
  async round(sym, q) { return floorTo(q, (await this.instrument(sym)).step); }
  async minQty(sym) { return (await this.instrument(sym)).min; }
  async lev(sym) {
    if (this.levOk[sym]) return;
    try { await this.req('POST', '/fapi/v1/marginType', { symbol: sym + 'USDT', marginType: 'CROSSED' }); } catch (e) { if (e.code !== -4046) console.log('幣安改全倉：', e.message); }
    await this.req('POST', '/fapi/v1/leverage', { symbol: sym + 'USDT', leverage: Math.max(1, Math.ceil(this.maxLev)) });
    this.levOk[sym] = 1;
  }
  async marketOrder(sym, side, qty, reduceOnly) {
    await this.init(); const q = await this.round(sym, qty); if (!(q > 0)) return { qty: 0, px: 0, fee: 0 };
    if (!reduceOnly) await this.lev(sym);
    const s = sym + 'USDT', o = await this.req('POST', '/fapi/v1/order', { symbol: s, side: side > 0 ? 'BUY' : 'SELL', type: 'MARKET', quantity: q, reduceOnly: reduceOnly ? 'true' : undefined, newClientOrderId: cid(), newOrderRespType: 'RESULT' });
    const fee = async () => { try { const t = await this.req('GET', '/fapi/v1/userTrades', { symbol: s, orderId: o.orderId }); return (t || []).reduce((a, x) => a + (x.commissionAsset === 'USDT' ? +x.commission : 0), 0); } catch (e) { return 0; } };
    const done = async x => x.status === 'FILLED' || ['CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(x.status) && +x.executedQty > 0 ? { qty: +x.executedQty, px: +x.avgPrice, fee: await fee() } : ['REJECTED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(x.status) ? Promise.reject(finalErr('幣安訂單 ' + x.status)) : null;
    const first = await done(o); if (first) return first;
    return waitFill(async () => done(await this.req('GET', '/fapi/v1/order', { symbol: s, orderId: o.orderId })), '幣安', o.orderId);
  }
  // 先掛新的條件單，再撤舊的（中間不會有沒保護的空窗）
  async setStop(sym, stop, tp) {
    const s = sym + 'USDT', i = await this.instrument(sym); let old = []; try { old = await this.algos(sym); } catch (e) {}
    const p = stop || tp ? await this.position(sym) : 0;
    if (p) for (const [t, v] of [['STOP_MARKET', stop], ['TAKE_PROFIT_MARKET', tp]]) if (v) await this.req('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: s, side: p > 0 ? 'SELL' : 'BUY', type: t, triggerPrice: tickTo(v, i.tick), closePosition: 'true', workingType: 'CONTRACT_PRICE', clientAlgoId: cid() });
    for (const a of old) try { await this.req('DELETE', '/fapi/v1/algoOrder', { algoId: a.algoId }); } catch (e) {}
  }
  async closeAll() { for (const p of await this.getPositions()) await this.marketOrder(p.sym, -p.side, p.qty, true); }
  async stopFills(sym, since) {
    const s = sym + 'USDT', r = await this.req('GET', '/fapi/v1/allAlgoOrders', { symbol: s, startTime: since * 1000 }), al = (Array.isArray(r) ? r : r.orders || r.rows || []).filter(a => a.actualOrderId && +a.actualOrderId > 0);
    if (!al.length) return [];
    const t = await this.req('GET', '/fapi/v1/userTrades', { symbol: s, startTime: since * 1000 }), out = [];
    for (const a of al) { const f = (t || []).filter(x => String(x.orderId) === String(a.actualOrderId)); if (!f.length) continue; const q = f.reduce((z, x) => z + +x.qty, 0);
      out.push({ t: Math.floor(Math.max(...f.map(x => +x.time)) / 1000), kind: (a.orderType || a.type) === 'TAKE_PROFIT_MARKET' ? 'tp' : 'stop', px: f.reduce((z, x) => z + x.qty * x.price, 0) / q, qty: q, fee: f.reduce((z, x) => z + (x.commissionAsset === 'USDT' ? +x.commission : 0), 0) }); }
    return out;
  }
}

// OKX v5（BTC-USDT-SWAP）。簽名：base64(HMAC-SHA256(時間 ISO + 方法 + 路徑含 query + body))，要 Passphrase。模擬交易加 header x-simulated-trading: 1，用模擬交易建的金鑰
// 數量單位是「張」：幣數＝張數 × ctVal。整個部位的停損停利只能掛一張（oco 或 conditional），所以先撤舊的再掛新的
class OkxExchange {
  constructor(c) { this.key = c.apiKey; this.sec = c.apiSecret; this.pass = c.apiPass || ''; this.demo = !!c.testnet; this.base = 'https://www.okx.com'; this.off = 0; this.inst = {}; this.levOk = {}; this.name = 'okx'; this.maxLev = c.limits.maxLev; this.ready = false; }
  async req(method, p, params = {}, signed = true) {
    const qs = method === 'GET' ? new URLSearchParams(params).toString() : '', path = p + (qs ? '?' + qs : ''), body = method === 'GET' ? '' : JSON.stringify(params), ts = new Date(Date.now() + this.off).toISOString();
    const h = { 'Content-Type': 'application/json' }; if (this.demo) h['x-simulated-trading'] = '1';
    if (signed) Object.assign(h, { 'OK-ACCESS-KEY': this.key, 'OK-ACCESS-SIGN': crypto.createHmac('sha256', this.sec).update(ts + method + path + body).digest('base64'), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': this.pass });
    const r = await fetchT(this.base + path, { method, headers: h, body: method === 'GET' ? undefined : body }, 15000);
    const j = await r.json().catch(() => ({ code: '-1', msg: 'HTTP ' + r.status })), d0 = (j.data || [])[0];
    if (j.code !== '0' || d0 && d0.sCode && d0.sCode !== '0') { const c = d0 && d0.sCode && d0.sCode !== '0' ? d0.sCode : j.code, e = new Error(`OKX ${c} ${d0 && d0.sMsg || j.msg || ''}`.trim()); e.code = c; throw e; }
    return j.data || [];
  }
  id(sym) { return sym + '-USDT-SWAP'; }
  async init() {
    if (this.ready) return;
    try { this.off = +(await this.req('GET', '/api/v5/public/time', {}, false))[0].ts - Date.now(); } catch (e) {}
    try { const c = (await this.req('GET', '/api/v5/account/config'))[0]; if (c && c.posMode !== 'net_mode') await this.req('POST', '/api/v5/account/set-position-mode', { posMode: 'net_mode' }); } catch (e) { console.log('OKX 切單向持倉：', e.message); }
    this.ready = true;
  }
  async price(sym) { return +(await this.req('GET', '/api/v5/market/ticker', { instId: this.id(sym) }, false))[0].last; }
  async getEquity() {
    await this.init(); const a = (await this.req('GET', '/api/v5/account/balance', { ccy: 'USDT' }))[0] || {}, u = (a.details || []).find(x => x.ccy === 'USDT');
    if (u && u.eq !== '') return +u.eq; if (a.totalEq) return +a.totalEq; throw new Error('讀不到 OKX 權益');
  }
  async instrument(sym) {
    if (this.inst[sym]) return this.inst[sym];
    const x = (await this.req('GET', '/api/v5/public/instruments', { instType: 'SWAP', instId: this.id(sym) }, false))[0];
    if (!x) throw new Error('OKX 沒有 ' + this.id(sym));
    const ct = +x.ctVal * (+x.ctMult || 1), lot = +x.lotSz;
    return (this.inst[sym] = { step: +(lot * ct).toPrecision(12), min: +(+x.minSz * ct).toPrecision(12), tick: +x.tickSz, ct, lot });
  }
  async round(sym, q) { const i = await this.instrument(sym); return +(floorTo(q / i.ct, i.lot) * i.ct).toPrecision(12); }
  async minQty(sym) { return (await this.instrument(sym)).min; }
  async rawPos(sym) { return this.req('GET', '/api/v5/account/positions', Object.assign({ instType: 'SWAP' }, sym ? { instId: this.id(sym) } : {})); }
  async getPositions() {
    const out = [];
    for (const x of await this.rawPos()) { if (!/-USDT-SWAP$/.test(x.instId) || !+x.pos) continue; const sym = x.instId.replace(/-USDT-SWAP$/, ''), i = await this.instrument(sym), al = (x.closeOrderAlgo || [])[0] || {};
      out.push({ sym, side: +x.pos > 0 ? 1 : -1, qty: Math.abs(+x.pos) * i.ct, entry: +x.avgPx, stop: +al.slTriggerPx || 0, tp: +al.tpTriggerPx || 0, mark: +x.markPx, upnl: +x.upl }); }
    return out;
  }
  async position(sym) { const i = await this.instrument(sym); return (await this.rawPos(sym)).reduce((a, x) => a + (+x.pos || 0), 0) * i.ct; }
  async lev(sym) { if (this.levOk[sym]) return; await this.req('POST', '/api/v5/account/set-leverage', { instId: this.id(sym), lever: String(Math.max(1, Math.ceil(this.maxLev))), mgnMode: 'cross' }); this.levOk[sym] = 1; }
  async marketOrder(sym, side, qty, reduceOnly) {
    await this.init(); const i = await this.instrument(sym), sz = floorTo(qty / i.ct, i.lot); if (!(sz > 0)) return { qty: 0, px: 0, fee: 0 };
    if (!reduceOnly) await this.lev(sym);
    const o = (await this.req('POST', '/api/v5/trade/order', Object.assign({ instId: this.id(sym), tdMode: 'cross', side: side > 0 ? 'buy' : 'sell', ordType: 'market', sz: String(sz), clOrdId: cid() }, reduceOnly ? { reduceOnly: true } : {})))[0];
    return waitFill(async () => { const x = (await this.req('GET', '/api/v5/trade/order', { instId: this.id(sym), ordId: o.ordId }))[0];
      if (!x) return null; const f = +x.accFillSz;
      if (x.state === 'filled' || /canceled/.test(x.state) && f > 0) return { qty: f * i.ct, px: +x.avgPx, fee: Math.abs(+x.fee || 0) };
      if (/canceled/.test(x.state)) throw finalErr('OKX 訂單已取消'); return null; }, 'OKX', o.ordId);
  }
  async setStop(sym, stop, tp) {
    const id = this.id(sym), i = await this.instrument(sym), old = [];
    for (const t of ['oco', 'conditional']) try { old.push(...(await this.req('GET', '/api/v5/trade/orders-algo-pending', { ordType: t, instId: id })).map(a => ({ algoId: a.algoId, instId: id }))); } catch (e) {}
    if (old.length) await this.req('POST', '/api/v5/trade/cancel-algos', old.slice(0, 10));
    const p = stop || tp ? await this.position(sym) : 0; if (!p) return;
    const b = { instId: id, tdMode: 'cross', side: p > 0 ? 'sell' : 'buy', ordType: stop && tp ? 'oco' : 'conditional', closeFraction: '1', reduceOnly: true, cxlOnClosePos: true, algoClOrdId: cid() };
    if (stop) Object.assign(b, { slTriggerPx: tickTo(stop, i.tick), slOrdPx: '-1', slTriggerPxType: 'last' });
    if (tp) Object.assign(b, { tpTriggerPx: tickTo(tp, i.tick), tpOrdPx: '-1', tpTriggerPxType: 'last' });
    await this.req('POST', '/api/v5/trade/order-algo', b);
  }
  async closeAll() { for (const p of await this.getPositions()) await this.marketOrder(p.sym, -p.side, p.qty, true); }
  async stopFills(sym, since) {
    const id = this.id(sym), i = await this.instrument(sym), out = [];
    for (const t of ['oco', 'conditional']) {
      let r = []; try { r = await this.req('GET', '/api/v5/trade/orders-algo-history', { ordType: t, state: 'effective', instId: id }); } catch (e) { continue; }
      for (const a of r) { const tt = Math.floor(+(a.triggerTime || a.uTime || 0) / 1000); if (tt < since) continue; let fee = 0, px = +a.actualPx || 0, q = +a.actualSz || 0;
        for (const oid of a.ordIdList || []) try { const x = (await this.req('GET', '/api/v5/trade/order', { instId: id, ordId: oid }))[0]; if (x) { fee += Math.abs(+x.fee || 0); if (+x.avgPx) px = +x.avgPx; if (+x.accFillSz) q = +x.accFillSz; } } catch (e) {}
        if (q > 0) out.push({ t: tt, kind: a.actualSide === 'tp' ? 'tp' : 'stop', px, qty: q * i.ct, fee }); }
    }
    return out;
  }
}

// Bitget v2 合約（USDT-FUTURES，Classic 帳戶）。簽名：base64(HMAC-SHA256(毫秒時間 + 方法 + 路徑 + ?query + body))，要 Passphrase。模擬交易加 header paptrading: 1，用模擬交易建的金鑰
class BitgetExchange {
  constructor(c) { this.key = c.apiKey; this.sec = c.apiSecret; this.pass = c.apiPass || ''; this.demo = !!c.testnet; this.base = 'https://api.bitget.com'; this.off = 0; this.inst = {}; this.levOk = {}; this.name = 'bitget'; this.maxLev = c.limits.maxLev; this.ready = false; this.PT = 'USDT-FUTURES'; }
  async req(method, p, params = {}, signed = true) {
    const qs = method === 'GET' ? new URLSearchParams(params).toString() : '', body = method === 'GET' ? '' : JSON.stringify(params), ts = String(Date.now() + this.off);
    const h = { 'Content-Type': 'application/json', locale: 'en-US' }; if (this.demo) h.paptrading = '1';
    if (signed) Object.assign(h, { 'ACCESS-KEY': this.key, 'ACCESS-SIGN': crypto.createHmac('sha256', this.sec).update(ts + method + p + (qs ? '?' + qs : '') + body).digest('base64'), 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': this.pass });
    const r = await fetchT(this.base + p + (qs ? '?' + qs : ''), { method, headers: h, body: method === 'GET' ? undefined : body }, 15000);
    const j = await r.json().catch(() => ({ code: '-1', msg: 'HTTP ' + r.status }));
    if (j.code !== '00000') { const e = new Error(`Bitget ${j.code} ${j.msg || ''}`.trim()); e.code = j.code; throw e; }
    return j.data;
  }
  async init() {
    if (this.ready) return;
    try { this.off = +(await this.req('GET', '/api/v2/public/time', {}, false)).serverTime - Date.now(); } catch (e) {}
    try { await this.req('POST', '/api/v2/mix/account/set-position-mode', { productType: this.PT, posMode: 'one_way_mode' }); } catch (e) { console.log('Bitget 切單向持倉：', e.message); }
    this.ready = true;
  }
  async price(sym) { return +(await this.req('GET', '/api/v2/mix/market/ticker', { symbol: sym + 'USDT', productType: this.PT }, false))[0].lastPr; }
  async getEquity() {
    await this.init(); const u = (await this.req('GET', '/api/v2/mix/account/accounts', { productType: this.PT }) || []).find(x => x.marginCoin === 'USDT');
    if (u) return +(u.accountEquity || u.usdtEquity); throw new Error('讀不到 Bitget 合約權益');
  }
  async instrument(sym) {
    if (this.inst[sym]) return this.inst[sym];
    const x = (await this.req('GET', '/api/v2/mix/market/contracts', { productType: this.PT, symbol: sym + 'USDT' }, false) || [])[0];
    if (!x) throw new Error('Bitget 沒有 ' + sym + 'USDT 永續');
    const step = +x.sizeMultiplier || 10 ** -(+x.volumePlace || 0);
    return (this.inst[sym] = { step, min: Math.max(+x.minTradeNum || 0, step), tick: +((+x.priceEndStep || 1) * 10 ** -(+x.pricePlace || 0)).toPrecision(12) });
  }
  async round(sym, q) { return floorTo(q, (await this.instrument(sym)).step); }
  async minQty(sym) { return (await this.instrument(sym)).min; }
  async rawPos() { return (await this.req('GET', '/api/v2/mix/position/all-position', { productType: this.PT, marginCoin: 'USDT' })) || []; }
  sideOf(x) { return /^(long|buy)$/.test(x.holdSide) ? 1 : -1; }
  async getPositions() { return (await this.rawPos()).filter(x => +x.total > 0).map(x => ({ sym: x.symbol.replace(/USDT$/, ''), side: this.sideOf(x), qty: +x.total, entry: +x.openPriceAvg, stop: +x.stopLoss || 0, tp: +x.takeProfit || 0, mark: +x.markPrice, upnl: +x.unrealizedPL, hold: x.holdSide })); }
  async position(sym) { return (await this.getPositions()).filter(p => p.sym === sym).reduce((a, p) => a + p.side * p.qty, 0); }
  async lev(sym) {
    if (this.levOk[sym]) return; const b = { symbol: sym + 'USDT', productType: this.PT, marginCoin: 'USDT' };
    try { await this.req('POST', '/api/v2/mix/account/set-margin-mode', Object.assign({ marginMode: 'crossed' }, b)); } catch (e) { console.log('Bitget 改全倉：', e.message); }
    await this.req('POST', '/api/v2/mix/account/set-leverage', Object.assign({ leverage: String(Math.max(1, Math.ceil(this.maxLev))) }, b));
    this.levOk[sym] = 1;
  }
  async marketOrder(sym, side, qty, reduceOnly) {
    await this.init(); const q = await this.round(sym, qty); if (!(q > 0)) return { qty: 0, px: 0, fee: 0 };
    if (!reduceOnly) await this.lev(sym);
    const c = cid(); await this.req('POST', '/api/v2/mix/order/place-order', { symbol: sym + 'USDT', productType: this.PT, marginMode: 'crossed', marginCoin: 'USDT', size: String(q), side: side > 0 ? 'buy' : 'sell', orderType: 'market', reduceOnly: reduceOnly ? 'YES' : 'NO', clientOid: c });
    return waitFill(async () => { const x = await this.req('GET', '/api/v2/mix/order/detail', { symbol: sym + 'USDT', productType: this.PT, clientOid: c });
      if (!x) return null; const f = +x.baseVolume;
      if (x.state === 'filled' || x.state === 'canceled' && f > 0) return { qty: f, px: +x.priceAvg, fee: Math.abs(+x.fee || 0) };
      if (x.state === 'canceled') throw finalErr('Bitget 訂單已取消'); return null; }, 'Bitget', c);
  }
  async setStop(sym, stop, tp) {
    const b = { symbol: sym + 'USDT', productType: this.PT, marginCoin: 'USDT' }, i = await this.instrument(sym);
    for (const planType of ['pos_loss', 'pos_profit']) try { await this.req('POST', '/api/v2/mix/order/cancel-plan-order', Object.assign({ planType }, b)); } catch (e) {}
    if (!stop && !tp) return;
    const p = (await this.getPositions()).find(x => x.sym === sym); if (!p) return;
    const o = Object.assign({ holdSide: p.hold }, b);
    if (stop) Object.assign(o, { stopLossTriggerPrice: tickTo(stop, i.tick), stopLossTriggerType: 'fill_price' });
    if (tp) Object.assign(o, { stopSurplusTriggerPrice: tickTo(tp, i.tick), stopSurplusTriggerType: 'fill_price' });
    await this.req('POST', '/api/v2/mix/order/place-pos-tpsl', o);
  }
  async closeAll() { for (const p of await this.getPositions()) await this.marketOrder(p.sym, -p.side, p.qty, true); }
  async stopFills(sym, since) {
    const d = await this.req('GET', '/api/v2/mix/order/orders-plan-history', { planType: 'profit_loss', productType: this.PT, symbol: sym + 'USDT', startTime: String(since * 1000), endTime: String(Date.now()), planStatus: 'executed' }), out = [];
    for (const a of (d && d.entrustedList) || []) { if (!a.executeOrderId) continue;
      try { const x = await this.req('GET', '/api/v2/mix/order/detail', { symbol: sym + 'USDT', productType: this.PT, orderId: a.executeOrderId }); if (!x || !(+x.baseVolume > 0)) continue;
        out.push({ t: Math.floor(+(x.uTime || a.uTime || Date.now()) / 1000), kind: /profit/.test(a.planType) ? 'tp' : 'stop', px: +x.priceAvg, qty: +x.baseVolume, fee: Math.abs(+x.fee || 0) }); } catch (e) {} }
    return out;
  }
}
// ───────── 現貨（BTC.S）、槓桿（BTC.M，全倉借貸、自動借還）─────────
// 部位代號帶 .S／.M 的呼叫轉給 SPOT[交易所]；部位＝帳戶裡這個幣的淨數量（槓桿＝持有−借款−利息，負的是放空）
// 停損停利沒有掛在交易所，由執行器每分鐘檢查。照官方文件寫的，**還沒有在真的帳戶上測過**
const liveMk = () => { const o = { spot: new Set(), mrg: new Set() }; for (const g of S.strategies) if (g.led === 'live' && mktOf(g) !== 'fut' && (g.enabled || g.pos)) o[mktOf(g)].add(g.sym); return o; };
const SLIP_IOC = 0.005;   // 沒辦法用幣的數量下市價買單的交易所，改掛 ±0.5% 的立即成交限價單（IOC）
const feeUsd = (fee, coin, b, p) => Math.abs(+fee || 0) * (coin && coin !== 'USDT' && coin === b ? p : 1);
const SPOT = {
  bybit: {
    async price(M, b) { return +(await this.req('GET', '/v5/market/tickers', { category: 'spot', symbol: b + 'USDT' }, false)).list[0].lastPrice; },
    async inst(M, b) { const x = (await this.req('GET', '/v5/market/instruments-info', { category: 'spot', symbol: b + 'USDT' }, false)).list[0]; if (!x) throw new Error('Bybit 沒有現貨 ' + b + 'USDT');
      if (M === 'mrg' && x.marginTrading && !/both|utaOnly/.test(x.marginTrading)) throw finalErr('Bybit 的 ' + b + ' 不能槓桿交易');
      const l = x.lotSizeFilter || {}, step = +l.basePrecision; return { step, min: Math.max(step, +l.minOrderQty || 0), minNot: +l.minOrderAmt || 5, tick: +(x.priceFilter || {}).tickSize || 0.01 }; },
    async pos(M, b) { const r = await this.req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: b }), c = ((r.list && r.list[0] || {}).coin || []).find(x => x.coin === b); if (!c) return 0;
      return +c.walletBalance - (+c.spotBorrow || 0) - (M === 'mrg' ? +c.accruedInterest || 0 : 0); },
    async setup(M) { if (M !== 'mrg') return;
      try { await this.req('POST', '/v5/spot-margin-trade/switch-mode', { spotMarginMode: '1' }); } catch (e) { throw finalErr('Bybit 現貨槓桿還沒開通（要先在 Bybit App 完成槓桿問答）：' + e.message); }
      try { await this.req('POST', '/v5/spot-margin-trade/set-leverage', { leverage: String(MRG_LEV) }); } catch (e) { console.log('Bybit 設槓桿倍數：', e.message); }
      try { await this.req('POST', '/v5/spot-margin-trade/set-auto-repay-mode', { autoRepayMode: '1' }); } catch (e) { console.log('Bybit 自動還款：', e.message); } },
    async order(M, b, side, q, p) {
      const o = await this.req('POST', '/v5/order/create', { category: 'spot', symbol: b + 'USDT', side: side > 0 ? 'Buy' : 'Sell', orderType: 'Market', qty: String(q), marketUnit: 'baseCoin', isLeverage: M === 'mrg' ? 1 : 0, orderLinkId: cid() });
      return waitFill(async () => { for (const ep of ['/v5/order/realtime', '/v5/order/history']) { const x = ((await this.req('GET', ep, { category: 'spot', orderId: o.orderId })).list || [])[0];
        if (x && /Filled|Cancel|Reject/.test(x.orderStatus) && x.orderStatus !== 'PartiallyFilled') { if (!(+x.cumExecQty > 0)) throw finalErr('Bybit 下單沒成交：' + (x.rejectReason || x.orderStatus));
          const fd = x.cumFeeDetail || {}, fee = Object.entries(fd).reduce((a, [c, v]) => a + feeUsd(v, c, b, +x.avgPrice), 0); return { qty: +x.cumExecQty, px: +x.avgPrice, fee }; } } return null; }, 'Bybit', o.orderId); },
    async eq() { return 0; }   // 統一帳戶的總權益本來就含現貨、借款
  },
  binance: {
    sb() { return this.base.includes('demo') ? 'https://demo-api.binance.com' : 'https://api.binance.com'; },
    async price(M, b) { return +(await this.req('GET', '/api/v3/ticker/price', { symbol: b + 'USDT' }, false, SPOT.binance.sb.call(this))).price; },
    async inst(M, b) { const x = ((await this.req('GET', '/api/v3/exchangeInfo', { symbol: b + 'USDT' }, false, SPOT.binance.sb.call(this))).symbols || [])[0]; if (!x) throw new Error('幣安沒有現貨 ' + b + 'USDT');
      const F = t => (x.filters || []).find(f => f.filterType === t) || {}, ls = F('LOT_SIZE'), ms = F('MARKET_LOT_SIZE'), step = +ms.stepSize > 0 ? +ms.stepSize : +ls.stepSize;
      return { step, min: Math.max(+ls.minQty || 0, +ms.minQty || 0, step), minNot: +(F('NOTIONAL').minNotional || F('MIN_NOTIONAL').minNotional) || 5, tick: +F('PRICE_FILTER').tickSize || 0.01 }; },
    async pos(M, b) { if (M === 'mrg') { const a = ((await this.req('GET', '/sapi/v1/margin/account', {}, true, SPOT.binance.sb.call(this))).userAssets || []).find(x => x.asset === b); return a ? +a.netAsset : 0; }
      const a = ((await this.req('GET', '/api/v3/account', { omitZeroBalances: 'true' }, true, SPOT.binance.sb.call(this))).balances || []).find(x => x.asset === b); return a ? +a.free + +a.locked : 0; },
    async setup(M) { if (M === 'mrg' && this.base.includes('demo')) throw finalErr('幣安模擬交易沒有槓桿（借貸）帳戶，槓桿只能在正式網用'); },
    async order(M, b, side, q) {
      const P = { symbol: b + 'USDT', side: side > 0 ? 'BUY' : 'SELL', type: 'MARKET', quantity: String(q), newClientOrderId: cid(), newOrderRespType: 'FULL' };
      if (M === 'mrg') Object.assign(P, { isIsolated: 'FALSE', sideEffectType: 'AUTO_BORROW_REPAY' });
      const x = await this.req('POST', M === 'mrg' ? '/sapi/v1/margin/order' : '/api/v3/order', P, true, SPOT.binance.sb.call(this)), n = +x.executedQty;
      if (!(n > 0)) throw finalErr('幣安下單沒成交：' + x.status);
      const avg = +x.cummulativeQuoteQty / n; return { qty: n, px: avg, fee: (x.fills || []).reduce((a, f) => a + (f.commissionAsset === 'BNB' ? 0 : feeUsd(f.commission, f.commissionAsset, b, avg)), 0) }; },
    async eq(U) { let e = 0, sb = SPOT.binance.sb.call(this);
      if (U.spot.size) for (const x of (await this.req('GET', '/api/v3/account', { omitZeroBalances: 'true' }, true, sb)).balances || []) { const n = +x.free + +x.locked; if (x.asset === 'USDT') e += n; else if (U.spot.has(x.asset)) e += n * (px(x.asset) || await SPOT.binance.price.call(this, 'spot', x.asset)); }
      if (U.mrg.size) { const a = await this.req('GET', '/sapi/v1/margin/account', {}, true, sb); e += +a.totalNetAssetOfBtc * (px('BTC') || await SPOT.binance.price.call(this, 'mrg', 'BTC')); }
      return e; }
  },
  okx: {
    async price(M, b) { return +(await this.req('GET', '/api/v5/market/ticker', { instId: b + '-USDT' }, false))[0].last; },
    async inst(M, b) { const x = (await this.req('GET', '/api/v5/public/instruments', { instType: 'SPOT', instId: b + '-USDT' }, false))[0]; if (!x) throw new Error('OKX 沒有現貨 ' + b + '-USDT');
      return { step: +x.lotSz, min: Math.max(+x.minSz, +x.lotSz), minNot: 1, tick: +x.tickSz }; },
    async pos(M, b) { const d = (((await this.req('GET', '/api/v5/account/balance', { ccy: b }))[0] || {}).details || []).find(x => x.ccy === b); return d ? +(d.eq !== '' ? d.eq : d.cashBal) : 0; },
    async setup(M) { if (M !== 'mrg') return; const c = (await this.req('GET', '/api/v5/account/config'))[0] || {};
      if (!['3', '4'].includes(String(c.acctLv))) throw finalErr('OKX 槓桿要先把帳戶模式改成「跨幣種保證金」或「組合保證金」（OKX App › 交易設定 › 帳戶模式）');
      try { await this.req('POST', '/api/v5/account/set-auto-loan', { autoLoan: true }); } catch (e) { console.log('OKX 自動借幣：', e.message); } },
    async order(M, b, side, q, p, I) {
      const B = { instId: b + '-USDT', side: side > 0 ? 'buy' : 'sell', sz: String(q), clOrdId: cid() };
      if (M === 'spot') Object.assign(B, { tdMode: 'cash', ordType: 'market', tgtCcy: 'base_ccy', banAmend: true });
      else { const t = (await this.req('GET', '/api/v5/market/ticker', { instId: b + '-USDT' }, false))[0], ref = side > 0 ? +t.askPx || +t.last : +t.bidPx || +t.last; Object.assign(B, { tdMode: 'cross', ordType: 'ioc', px: tickTo(ref * (1 + side * SLIP_IOC), I.tick) }); }
      const o = (await this.req('POST', '/api/v5/trade/order', B))[0];
      return waitFill(async () => { const x = (await this.req('GET', '/api/v5/trade/order', { instId: b + '-USDT', ordId: o.ordId }))[0];
        if (!x || !/filled|canceled|mmp_canceled/.test(x.state) || x.state === 'partially_filled') return null; if (!(+x.accFillSz > 0)) throw finalErr('OKX 下單沒成交：' + x.state);
        return { qty: +x.accFillSz, px: +x.avgPx, fee: feeUsd(x.fee, x.feeCcy, b, +x.avgPx) }; }, 'OKX', o.ordId); },
    async eq(U) { const cs = [...new Set([...U.spot, ...U.mrg])]; if (!cs.length) return 0; let e = 0;
      for (const d of ((await this.req('GET', '/api/v5/account/balance', { ccy: cs.join(',') }))[0] || {}).details || []) if (cs.includes(d.ccy)) e += +(d.eqUsd || 0) || +d.eq * (px(d.ccy) || 0);
      return e; }
  },
  bitget: {
    async tk(b) { return (await this.req('GET', '/api/v2/spot/market/tickers', { symbol: b + 'USDT' }, false))[0]; },
    async price(M, b) { return +(await SPOT.bitget.tk.call(this, b)).lastPr; },
    async inst(M, b) { const x = (await this.req('GET', '/api/v2/spot/public/symbols', { symbol: b + 'USDT' }, false) || [])[0]; if (!x) throw new Error('Bitget 沒有現貨 ' + b + 'USDT');
      const step = +Math.pow(10, -(+x.quantityPrecision || 0)).toFixed(+x.quantityPrecision || 0); return { step, min: step, minNot: +x.minTradeUSDT || 1, tick: +Math.pow(10, -(+x.pricePrecision || 0)).toFixed(+x.pricePrecision || 0) }; },
    async pos(M, b) { if (M === 'mrg') { const a = (await this.req('GET', '/api/v2/margin/crossed/account/assets', { coin: b }) || []).find(x => x.coin === b); return a ? +a.net : 0; }
      const a = (await this.req('GET', '/api/v2/spot/account/assets', { coin: b }) || []).find(x => String(x.coin).toUpperCase() === b); return a ? +a.available + +(a.frozen || 0) + +(a.locked || 0) : 0; },
    async setup() {},
    async order(M, b, side, q, p, I) {
      const t = await SPOT.bitget.tk.call(this, b), ref = side > 0 ? +t.askPr || +t.lastPr : +t.bidPr || +t.lastPr, lim = tickTo(ref * (1 + side * SLIP_IOC), I.tick), id = cid(), t0 = Date.now() - 60000;
      // 市價買單只能填 USDT 金額，所以買賣都用 ±0.5% 的 IOC 限價單，數量照幣算
      if (M === 'spot') { const o = await this.req('POST', '/api/v2/spot/trade/place-order', { symbol: b + 'USDT', side: side > 0 ? 'buy' : 'sell', orderType: 'limit', force: 'ioc', price: lim, size: String(q), clientOid: id });
        return waitFill(async () => { const x = (await this.req('GET', '/api/v2/spot/trade/orderInfo', { orderId: o.orderId }) || [])[0];
          if (!x || !/filled|cancelled/.test(x.status) || x.status === 'partially_filled') return null; if (!(+x.baseVolume > 0)) throw finalErr('Bitget 下單沒成交：' + x.status);
          let fee = 0; try { const f = JSON.parse(x.feeDetail || '{}'); fee = f.newFees ? feeUsd(f.newFees.t, side > 0 ? b : 'USDT', b, +x.priceAvg) : Object.entries(f).reduce((a, [c, v]) => a + feeUsd(v && v.totalFee, c, b, +x.priceAvg), 0); } catch (e) {}
          return { qty: +x.baseVolume, px: +x.priceAvg, fee: fee || +x.baseVolume * +x.priceAvg * SPOT_FEE }; }, 'Bitget', o.orderId); }
      const o = await this.req('POST', '/api/v2/margin/crossed/place-order', { symbol: b + 'USDT', side: side > 0 ? 'buy' : 'sell', orderType: 'limit', force: 'ioc', loanType: 'autoLoanAndRepay', price: lim, baseSize: String(q), clientOid: id });
      return waitFill(async () => { const x = ((await this.req('GET', '/api/v2/margin/crossed/history-orders', { symbol: b + 'USDT', startTime: String(t0), orderId: o.orderId }) || {}).orderList || [])[0];
        if (!x || !/filled|cancelled/.test(x.status) || x.status === 'partially_filled') return null; if (!(+x.size > 0)) throw finalErr('Bitget 下單沒成交：' + x.status);
        return { qty: +x.size, px: +x.priceAvg, fee: +x.size * +x.priceAvg * SPOT_FEE }; }, 'Bitget', o.orderId); },
    async eq(U) { let e = 0;
      if (U.spot.size) for (const a of await this.req('GET', '/api/v2/spot/account/assets', {}) || []) { const c = String(a.coin).toUpperCase(), n = +a.available + +(a.frozen || 0) + +(a.locked || 0); if (c === 'USDT') e += n; else if (U.spot.has(c)) e += n * (px(c) || 0); }
      if (U.mrg.size) for (const a of await this.req('GET', '/api/v2/margin/crossed/account/assets', {}) || []) { const c = String(a.coin).toUpperCase(); if (c === 'USDT') e += +a.net; else e += +a.net * (px(c) || 0); }
      return e; }
  }
};
// 把 SPOT 接到四家交易所的類別上：.S／.M 的部位走現貨、槓桿，其他照舊（永續合約）
for (const [k, Cls] of Object.entries({ bybit: BybitExchange, binance: BinanceExchange, okx: OkxExchange, bitget: BitgetExchange })) {
  const X = SPOT[k], P = Cls.prototype, o = {}; for (const m of ['price', 'instrument', 'round', 'minQty', 'position', 'marketOrder', 'setStop', 'stopFills', 'getEquity', 'getPositions']) o[m] = P[m];
  P.spotOk = true;
  P.sInst = async function (M, b) { const c = this.sinst || (this.sinst = {}), key = M + b; return c[key] || (c[key] = await X.inst.call(this, M, b)); };
  P.price = function (sym, ...a) { const M = mktK(sym); return M === 'fut' ? o.price.call(this, sym, ...a) : X.price.call(this, M, baseOf(sym)); };
  P.instrument = async function (sym) { const M = mktK(sym); return M === 'fut' ? o.instrument.call(this, sym) : this.sInst(M, baseOf(sym)); };
  P.round = async function (sym, q) { const M = mktK(sym); return M === 'fut' ? o.round.call(this, sym, q) : floorTo(q, (await this.sInst(M, baseOf(sym))).step); };
  P.minQty = async function (sym) { const M = mktK(sym); if (M === 'fut') return o.minQty.call(this, sym); const i = await this.sInst(M, baseOf(sym)), p = px(sym) || await this.price(sym); return Math.max(i.min, i.minNot * 1.05 / p); };
  P.position = async function (sym) { const M = mktK(sym); if (M === 'fut') return o.position.call(this, sym); await this.init(); const i = await this.sInst(M, baseOf(sym)), n = await X.pos.call(this, M, baseOf(sym)), p = px(sym) || 1; return Math.abs(n) < Math.max(i.step / 2, i.minNot * 0.5 / p) ? 0 : n; };   // 賣不掉的零頭（不到最小金額一半）當 0
  P.marketOrder = async function (sym, side, qty, reduceOnly) { const M = mktK(sym); if (M === 'fut') return o.marketOrder.call(this, sym, side, qty, reduceOnly);
    await this.init(); const b = baseOf(sym), I = await this.sInst(M, b);
    if (!(this.sset || (this.sset = {}))[M]) { await X.setup.call(this, M); this.sset[M] = 1; }
    if (reduceOnly || M === 'spot' && side < 0) { const h = await X.pos.call(this, M, b); qty = sgn(h) === -side ? Math.min(qty, Math.abs(h)) : M === 'spot' ? 0 : qty; if (M === 'mrg' && side > 0 && reduceOnly && qty >= Math.abs(h) - 1e-12) qty = Math.abs(h) * (1 + SPOT_FEE * 1.2); }   // 現貨賣不能超過手上的幣；槓桿回補空單多買一點抵手續費（手續費扣幣），免得留下欠款零頭
    const q = floorTo(qty, I.step), p = px(sym) || await this.price(sym); if (!(q > 0) || q * p < I.minNot) return { qty: 0, px: 0, fee: 0 };
    return X.order.call(this, M, b, side, q, p, I); };
  P.setStop = async function (sym, ...a) { return mktK(sym) === 'fut' ? o.setStop.call(this, sym, ...a) : undefined; };
  P.stopFills = async function (sym, since) { return mktK(sym) === 'fut' ? o.stopFills.call(this, sym, since) : []; };
  P.getEquity = async function () { const e = await o.getEquity.call(this), U = liveMk(); return U.spot.size || U.mrg.size ? e + await X.eq.call(this, U) : e; };
  P.getPositions = async function () { const out = await o.getPositions.call(this), U = liveMk();
    for (const M of ['spot', 'mrg']) for (const b of U[M]) { const key = b + MKT[M]; try { const n = await this.position(key); if (n) { const g = S.strategies.find(g => g.led === 'live' && xk(g) === key && g.pos), mark = px(b); out.push({ sym: key, side: sgn(n), qty: Math.abs(n), entry: g ? g.pos.entry : mark, stop: g ? g.pos.stop || 0 : 0, tp: g ? g.pos.tp || 0 : 0, mark, upnl: g ? n * (mark - g.pos.entry) : 0 }); } } catch (e) {} }
    return out; };
}
const LIVE_EX = { bybit: BybitExchange, binance: BinanceExchange, okx: OkxExchange, bitget: BitgetExchange };
const LIVE_NAME = { bybit: 'Bybit', binance: '幣安', okx: 'OKX', bitget: 'Bitget' };
const LIVE_PASS = { okx: 1, bitget: 1 };

// ───────── 資產總覽（唯讀）─────────
// 只讀餘額與持倉，不下單。手機把「唯讀金鑰」傳來，這裡先向交易所確認金鑰真的是唯讀（有交易或提現權限就拒收、不存），通過才存進 config.json。
// 其他交易所用下面共用的 FX_READ。**各家讀取都還沒在真的帳戶上測過。**
const STABLE = new Set(['USDT', 'USDC', 'USD', 'FDUSD', 'DAI']);
async function bybitFunds(a) {
  const ex = new BybitExchange({ apiKey: a.apiKey, apiSecret: a.apiSecret, testnet: !!a.testnet, limits: C.limits });
  const info = await ex.req('GET', '/v5/user/query-api', {});
  if (info.readOnly !== 1 && !a.trade) throw new HErr(400, '這把 Bybit 金鑰有交易或提現權限，不是唯讀。請另外建一把只勾「讀取」的金鑰。');
  const out = { total_usd: 0, assets: [], positions: [], notes: [], master: typeof info.isMaster === 'boolean' ? info.isMaster : undefined, uid: info.userID != null ? String(info.userID) : undefined };
  const px = {}, price = async c => { if (STABLE.has(c)) return 1; if (px[c] == null) { try { px[c] = +(await ex.req('GET', '/v5/market/tickers', { category: 'spot', symbol: c + 'USDT' }, false)).list[0].lastPrice; } catch (e) { px[c] = 0; } } return px[c]; };
  // 統一帳戶之外，舊版統一帳戶與經典帳戶的幣本位合約在 CONTRACT（反向合約帳戶），兩個都讀
  let got = false, uta = false;
  for (const accountType of ['UNIFIED', 'CONTRACT']) {
    try {
      const r = await ex.req('GET', '/v5/account/wallet-balance', { accountType }), w = r.list && r.list[0]; if (!w) continue;
      for (const c of w.coin || []) { const n = +c.walletBalance; if (!(n > 0)) continue; out.assets.push({ coin: c.coin, amount: n, usd: c.usdValue !== '' && c.usdValue != null ? +c.usdValue : n * await price(c.coin), acct: accountType === 'UNIFIED' ? '統一帳戶' : uta && !STABLE.has(c.coin) ? '幣本位合約' : '合約帳戶' }); }
      got = true; if (accountType === 'UNIFIED') uta = true;
    } catch (e) { if (accountType === 'CONTRACT' && !uta) out.notes.push('統一／合約帳戶讀取失敗：' + e.message); }
  }
  try {
    const r = await ex.req('GET', '/v5/asset/transfer/query-account-coins-balance', { accountType: 'FUND' });
    for (const c of r.balance || []) { const n = +c.walletBalance; if (n > 0) out.assets.push({ coin: c.coin, amount: n, usd: n * await price(c.coin), acct: '資金帳戶' }); }
    got = true;
  } catch (e) { out.notes.push('資金帳戶讀取失敗：' + e.message); }
  if (!got) throw new HErr(502, '讀不到 Bybit 餘額：' + out.notes.join('；'));
  try {
    const r = await ex.req('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    out.positions = (r.list || []).filter(x => +x.size > 0).map(x => ({ symbol: x.symbol, side: x.side === 'Buy' ? 'long' : 'short', contracts: +x.size, entry: +x.avgPrice, mark: +x.markPrice, liq: +x.liqPrice || null, leverage: +x.leverage || null, margin_mode: x.tradeMode === 1 ? 'isolated' : 'cross', upnl: +x.unrealisedPnl }));
  } catch (e) { out.notes.push('持倉讀取失敗：' + e.message); }
  try { const r = await ex.req('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDC' }); for (const x of (r.list || []).filter(x => +x.size > 0)) out.positions.push({ symbol: x.symbol, side: x.side === 'Buy' ? 'long' : 'short', contracts: +x.size, entry: +x.avgPrice, mark: +x.markPrice, liq: +x.liqPrice || null, leverage: +x.leverage || null, margin_mode: x.tradeMode === 1 ? 'isolated' : 'cross', upnl: +x.unrealisedPnl }); } catch (e) {}
  // 幣本位（反向）合約持倉：未實現損益是幣計價，換成美元
  try {
    const r = await ex.req('GET', '/v5/position/list', { category: 'inverse' });
    for (const x of (r.list || []).filter(x => +x.size > 0)) out.positions.push({ symbol: x.symbol, side: x.side === 'Buy' ? 'long' : 'short', contracts: +x.size, entry: +x.avgPrice, mark: +x.markPrice, liq: +x.liqPrice || null, leverage: +x.leverage || null, margin_mode: x.tradeMode === 1 ? 'isolated' : 'cross', upnl: (+x.unrealisedPnl || 0) * await price(String(x.symbol).replace(/USD.*$/, '')), coinM: true });
  } catch (e) { out.notes.push('幣本位持倉讀取失敗：' + e.message); }
  out.total_usd = out.assets.reduce((t, x) => t + (x.usd || 0), 0);
  return out;
}
// ── 其他交易所唯讀查詢（OKX、幣安、Bitget、Gate、MEXC、KuCoin、Coinbase、Kraken）。手機版 index.html 與 HexStack executor/hexbot.js 共用同一份，改一邊要同步另一邊 ──
// 每家：host（main／fut 合約）、time（對時）、ok／data（拆回應）、sign（簽名）。H＝{ hmac, sha, jwt } 由各環境提供。只讀餘額與持倉，不下單。
const FX_ST = ['USDT', 'USDC', 'USD', 'FDUSD', 'DAI'];
const fxB64u = s => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fxHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const FXS = {
  okx: { name: 'OKX', pass: true, host: { main: 'https://www.okx.com' }, time: ['/api/v5/public/time', d => +d[0].ts],
    ok: j => j.code === '0', data: j => j.data,
    sign: async (a, p, qs, t, H) => { const ts = new Date(t).toISOString(); return { qs, h: { 'OK-ACCESS-KEY': a.key, 'OK-ACCESS-SIGN': await H.hmac('SHA-256', 'b64', a.secret, ts + 'GET' + p + (qs ? '?' + qs : '')), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': a.pass || '' } }; } },
  binance: { name: '幣安', host: { main: 'https://api.binance.com', fut: 'https://fapi.binance.com', dfut: 'https://dapi.binance.com' }, time: ['/api/v3/time', d => +d.serverTime],
    ok: j => !(typeof j.code === 'number' && j.code < 0), data: j => j,
    sign: async (a, p, qs, t, H) => { qs += (qs ? '&' : '') + 'timestamp=' + t + '&recvWindow=10000'; return { qs: qs + '&signature=' + await H.hmac('SHA-256', 'hex', a.secret, qs), h: { 'X-MBX-APIKEY': a.key } }; } },
  bitget: { name: 'Bitget', pass: true, host: { main: 'https://api.bitget.com' }, time: ['/api/v2/public/time', d => +d.serverTime],
    ok: j => j.code === '00000', data: j => j.data,
    sign: async (a, p, qs, t, H) => ({ qs, h: { 'ACCESS-KEY': a.key, 'ACCESS-SIGN': await H.hmac('SHA-256', 'b64', a.secret, t + 'GET' + p + (qs ? '?' + qs : '')), 'ACCESS-TIMESTAMP': String(t), 'ACCESS-PASSPHRASE': a.pass || '', locale: 'en-US' } }) },
  gate: { name: 'Gate', host: { main: 'https://api.gateio.ws' }, time: ['/api/v4/spot/time', d => +d.server_time],
    ok: j => !(j.label && j.message), data: j => j,
    // 簽名字串：方法\n路徑\n查詢\nSHA512(空 body)\n秒級時間
    sign: async (a, p, qs, t, H) => { const ts = String(Math.floor(t / 1000)); return { qs, h: { KEY: a.key, Timestamp: ts, SIGN: await H.hmac('SHA-512', 'hex', a.secret, 'GET\n' + p + '\n' + qs + '\ncf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e\n' + ts) } }; } },
  mexc: { name: 'MEXC', host: { main: 'https://api.mexc.com', fut: 'https://contract.mexc.com' }, time: ['/api/v3/time', d => +d.serverTime],
    ok: j => !(j.success === false || (j.msg && j.code != null && +j.code !== 0)), data: j => j.success === true ? j.data : j,
    sign: async (a, p, qs, t, H) => {
      if (p.startsWith('/api/v1/')) return { qs, h: { ApiKey: a.key, 'Request-Time': String(t), Signature: await H.hmac('SHA-256', 'hex', a.secret, a.key + t + qs) } };
      qs += (qs ? '&' : '') + 'timestamp=' + t + '&recvWindow=10000'; return { qs: qs + '&signature=' + await H.hmac('SHA-256', 'hex', a.secret, qs), h: { 'X-MEXC-APIKEY': a.key } }; } },
  kucoin: { name: 'KuCoin', pass: true, host: { main: 'https://api.kucoin.com', fut: 'https://api-futures.kucoin.com' }, time: ['/api/v1/timestamp', d => +d],
    ok: j => j.code === '200000', data: j => j.data,
    sign: async (a, p, qs, t, H) => ({ qs, h: { 'KC-API-KEY': a.key, 'KC-API-SIGN': await H.hmac('SHA-256', 'b64', a.secret, t + 'GET' + p + (qs ? '?' + qs : '')), 'KC-API-TIMESTAMP': String(t), 'KC-API-PASSPHRASE': await H.hmac('SHA-256', 'b64', a.secret, a.pass || ''), 'KC-API-KEY-VERSION': '2' } }) },
  // Coinbase Advanced（CDP 金鑰）：每次請求簽一個 2 分鐘的 JWT。金鑰可能是 ECDSA（PEM）或 Ed25519（base64）
  coinbase: { name: 'Coinbase', host: { main: 'https://api.coinbase.com' }, time: ['/api/v3/brokerage/time', d => +d.epochMillis],
    ok: j => !j.error, data: j => j,
    sign: async (a, p, qs, t, H) => {
      const ed = !/BEGIN/.test(a.secret), s = Math.floor(t / 1000), msg = fxB64u(JSON.stringify({ alg: ed ? 'EdDSA' : 'ES256', kid: a.key, nonce: fxHex(16), typ: 'JWT' })) + '.' + fxB64u(JSON.stringify({ sub: a.key, iss: 'cdp', nbf: s, exp: s + 120, uri: 'GET api.coinbase.com' + p }));
      return { qs, h: { Authorization: 'Bearer ' + msg + '.' + await H.jwt(a.secret, msg) } }; } },
  // Kraken：私有介面只收 POST（body 只有 nonce）。API-Sign＝HMAC-SHA512(base64 解碼的 Secret, 路徑 + SHA256(nonce + body))
  kraken: { name: 'Kraken', host: { main: 'https://api.kraken.com' }, time: ['/0/public/Time', d => d.unixtime * 1000],
    ok: j => !(j.error && j.error.length), data: j => j.result,
    sign: async (a, p, qs, t, H) => {
      const nonce = String(t * 1000 + Math.floor(Math.random() * 1000)), body = 'nonce=' + nonce, path = new TextEncoder().encode(p), d = await H.sha('SHA-256', nonce + body), m = new Uint8Array(path.length + d.length); m.set(path); m.set(d, path.length);
      return { qs, body, h: { 'API-Key': a.key, 'API-Sign': await H.hmac('SHA-512', 'b64', Uint8Array.from(atob(a.secret), c => c.charCodeAt(0)), m) } }; } },
};
const fxOut = () => ({ total_usd: 0, assets: [], positions: [], notes: [] });
const fxPrice = get => { const px = {}; return async c => { c = String(c).toUpperCase(); if (FX_ST.includes(c)) return 1; if (px[c] == null) { try { px[c] = +(await get(c)) || 0; } catch (e) { px[c] = 0; } } return px[c]; }; };
// 讀取：rq(路徑, 參數, 要簽名?, 'main'|'fut')；rw() 丟出「不是唯讀」。Gate、MEXC 沒有查金鑰權限的介面，只能靠使用者建立時只勾讀取。
const FX_READ = {
  async okx(rq, rw) {
    const cfg = (await rq('/api/v5/account/config', {}))[0] || {}; if (String(cfg.perm || '').split(',').some(x => x && x !== 'read_only')) rw();
    const out = fxOut(); if (cfg.uid && cfg.mainUid) out.master = cfg.uid === cfg.mainUid;
    const price = fxPrice(async c => (await rq('/api/v5/market/ticker', { instId: c + '-USDT' }, false))[0].last);
    for (const d of ((await rq('/api/v5/account/balance', {}))[0] || {}).details || []) { const n = +d.eq; if (n > 0) out.assets.push({ coin: d.ccy, amount: n, usd: d.eqUsd !== '' && d.eqUsd != null ? +d.eqUsd : n * await price(d.ccy), acct: '交易帳戶' }); }
    try { for (const d of await rq('/api/v5/asset/balances', {})) { const n = +d.bal; if (n > 0) out.assets.push({ coin: d.ccy, amount: n, usd: n * await price(d.ccy), acct: '資金帳戶' }); } } catch (e) { out.notes.push('資金帳戶讀取失敗：' + e.message); }
    try { out.positions = (await rq('/api/v5/account/positions', {})).filter(x => +x.pos).map(x => ({ symbol: x.instId, side: x.posSide === 'short' || (x.posSide === 'net' && +x.pos < 0) ? 'short' : 'long', contracts: Math.abs(+x.pos), entry: +x.avgPx, mark: +x.markPx, liq: +x.liqPx || null, leverage: +x.lever || null, margin_mode: x.mgnMode === 'isolated' ? 'isolated' : 'cross', upnl: +x.upl || 0 })); } catch (e) { out.notes.push('持倉讀取失敗：' + e.message); }
    return out;
  },
  async binance(rq, rw) {
    const pm = await rq('/sapi/v1/account/apiRestrictions', {}); if (Object.keys(pm).some(k => /^(enable|permits)/.test(k) && !/^enable(Reading|FixReadOnly)$/.test(k) && pm[k] === true)) rw();
    const out = fxOut(), price = fxPrice(async c => (await rq('/api/v3/ticker/price', { symbol: c + 'USDT' }, false)).price), base = c => /^LD../.test(c) && c !== 'LDO' ? c.slice(2) : c;
    for (const x of (await rq('/api/v3/account', { omitZeroBalances: 'true' })).balances || []) { const n = +x.free + +x.locked; if (n > 0) out.assets.push({ coin: x.asset, amount: n, usd: n * await price(base(x.asset)), acct: '現貨帳戶' }); }
    try {
      for (const x of await rq('/fapi/v2/balance', {}, true, 'fut')) { const n = +x.balance; if (n > 0) out.assets.push({ coin: x.asset, amount: n, usd: n * await price(x.asset), acct: 'U 本位合約' }); }
      out.positions = (await rq('/fapi/v2/positionRisk', {}, true, 'fut')).filter(x => +x.positionAmt).map(x => ({ symbol: x.symbol, side: +x.positionAmt > 0 ? 'long' : 'short', contracts: Math.abs(+x.positionAmt), entry: +x.entryPrice, mark: +x.markPrice, liq: +x.liquidationPrice || null, leverage: +x.leverage || null, margin_mode: x.marginType === 'isolated' ? 'isolated' : 'cross', upnl: +x.unRealizedProfit || 0 }));
    } catch (e) { out.notes.push('合約帳戶讀取失敗：' + e.message); }
    // 幣本位合約（dapi）：餘額是幣，持倉 upnl 也是幣計價
    try {
      for (const x of await rq('/dapi/v1/balance', {}, true, 'dfut')) { const n = +x.balance + (+x.crossUnPnl || 0); if (n > 0) out.assets.push({ coin: x.asset, amount: n, usd: n * await price(x.asset), acct: '幣本位合約' }); }
      for (const x of await rq('/dapi/v1/positionRisk', {}, true, 'dfut')) if (+x.positionAmt) { const c = String(x.symbol).replace(/USD_.*$/, ''); out.positions.push({ symbol: x.symbol, side: +x.positionAmt > 0 ? 'long' : 'short', contracts: Math.abs(+x.positionAmt), entry: +x.entryPrice, mark: +x.markPrice, liq: +x.liquidationPrice || null, leverage: +x.leverage || null, margin_mode: x.marginType === 'isolated' ? 'isolated' : 'cross', upnl: (+x.unRealizedProfit || 0) * await price(c), coinM: true }); }
    } catch (e) { if (!/-2015|permission|not.*open/i.test(e.message)) out.notes.push('幣本位合約讀取失敗：' + e.message); }
    // 資金錢包、理財等其他錢包只拿得到 BTC 計價總額
    try { const btc = await price('BTC'); for (const x of await rq('/sapi/v1/asset/wallet/balance', {})) { const n = +x.balance; if (n > 0 && !/^Spot$|^USD.-M Futures$/.test(x.walletName)) out.assets.push({ coin: 'BTC（約當）', amount: n, usd: n * btc, acct: x.walletName }); } } catch (e) {}
    return out;
  },
  async bitget(rq, rw) {
    const i = await rq('/api/v2/spot/account/info', {}); if (!Array.isArray(i.authorities)) throw new Error('讀不到金鑰權限，無法確認是唯讀'); if (i.authorities.some(x => !/r$/.test(x))) rw();
    const out = fxOut(), price = fxPrice(async c => (await rq('/api/v2/spot/market/tickers', { symbol: c + 'USDT' }, false))[0].lastPr);
    for (const x of await rq('/api/v2/spot/account/assets', {})) { const n = +x.available + +x.frozen + +x.locked, c = String(x.coin).toUpperCase(); if (n > 0) out.assets.push({ coin: c, amount: n, usd: n * await price(c), acct: '現貨帳戶' }); }
    try {
      for (const x of await rq('/api/v2/mix/account/accounts', { productType: 'USDT-FUTURES' })) { const n = +x.accountEquity; if (n > 0) out.assets.push({ coin: x.marginCoin, amount: n, usd: +x.usdtEquity || n * await price(x.marginCoin), acct: 'U 本位合約' }); }
      out.positions = (await rq('/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES', marginCoin: 'USDT' })).filter(x => +x.total).map(x => ({ symbol: x.symbol, side: x.holdSide === 'short' ? 'short' : 'long', contracts: +x.total, entry: +x.openPriceAvg, mark: +x.markPrice, liq: +x.liquidationPrice > 0 ? +x.liquidationPrice : null, leverage: +x.leverage || null, margin_mode: x.marginMode === 'isolated' ? 'isolated' : 'cross', upnl: +x.unrealizedPL || 0 }));
    } catch (e) { out.notes.push('合約帳戶讀取失敗：' + e.message); }
    try {
      for (const x of await rq('/api/v2/mix/account/accounts', { productType: 'COIN-FUTURES' })) { const n = +x.accountEquity; if (n > 0) out.assets.push({ coin: x.marginCoin, amount: n, usd: +x.usdtEquity || n * await price(x.marginCoin), acct: '幣本位合約' }); }
      for (const x of await rq('/api/v2/mix/position/all-position', { productType: 'COIN-FUTURES' })) if (+x.total) out.positions.push({ symbol: x.symbol, side: x.holdSide === 'short' ? 'short' : 'long', contracts: +x.total, entry: +x.openPriceAvg, mark: +x.markPrice, liq: +x.liquidationPrice > 0 ? +x.liquidationPrice : null, leverage: +x.leverage || null, margin_mode: x.marginMode === 'isolated' ? 'isolated' : 'cross', upnl: (+x.unrealizedPL || 0) * await price(x.marginCoin), coinM: true });
    } catch (e) { out.notes.push('幣本位合約讀取失敗：' + e.message); }
    try {
      for (const x of await rq('/api/v2/mix/account/accounts', { productType: 'USDC-FUTURES' })) { const n = +x.accountEquity; if (n > 0) out.assets.push({ coin: x.marginCoin, amount: n, usd: +x.usdtEquity || n, acct: 'USDC 合約' }); }
      for (const x of await rq('/api/v2/mix/position/all-position', { productType: 'USDC-FUTURES' })) if (+x.total) out.positions.push({ symbol: x.symbol, side: x.holdSide === 'short' ? 'short' : 'long', contracts: +x.total, entry: +x.openPriceAvg, mark: +x.markPrice, liq: +x.liquidationPrice > 0 ? +x.liquidationPrice : null, leverage: +x.leverage || null, margin_mode: x.marginMode === 'isolated' ? 'isolated' : 'cross', upnl: +x.unrealizedPL || 0 });
    } catch (e) {}
    // 槓桿帳戶（全倉、逐倉）：用淨資產＝總額−借款−利息
    const mg = (x, nm) => { const t = +x.totalAmount || 0, n = x.net != null && x.net !== '' ? +x.net : t - (+x.borrow || 0) - (+x.interest || 0); return { t, n, nm }; };
    for (const [p, nm] of [['/api/v2/margin/crossed/account/assets', '全倉槓桿'], ['/api/v2/margin/isolated/account/assets', '逐倉槓桿']]) {
      try { for (const x of await rq(p, {}) || []) { const m = mg(x, nm), c = String(x.coin).toUpperCase(); if (m.t > 0 || m.n !== 0) out.assets.push({ coin: c, amount: m.n, usd: m.n * await price(c), acct: nm + (x.symbol ? '・' + x.symbol : '') }); } }
      catch (e) { if (!/40054|not.*open|未开通|No margin/i.test(e.message)) out.notes.push(nm + '帳戶讀取失敗：' + e.message); }
    }
    return out;
  },
  async gate(rq) {
    const out = fxOut(), price = fxPrice(async c => (await rq('/api/v4/spot/tickers', { currency_pair: c + '_USDT' }, false))[0].last);
    for (const x of await rq('/api/v4/spot/accounts', {})) { const n = +x.available + +x.locked; if (n > 0) out.assets.push({ coin: x.currency, amount: n, usd: n * await price(x.currency), acct: '現貨帳戶' }); }
    try {
      const f = await rq('/api/v4/futures/usdt/accounts', {}), n = +f.total + (+f.unrealised_pnl || 0); if (n > 0) out.assets.push({ coin: 'USDT', amount: n, usd: n, acct: 'U 本位合約' });
      out.positions = (await rq('/api/v4/futures/usdt/positions', {})).filter(x => +x.size).map(x => ({ symbol: x.contract, side: +x.size > 0 ? 'long' : 'short', contracts: Math.abs(+x.size), entry: +x.entry_price, mark: +x.mark_price, liq: +x.liq_price || null, leverage: +x.leverage || +x.cross_leverage_limit || null, margin_mode: +x.leverage ? 'isolated' : 'cross', upnl: +x.unrealised_pnl || 0 }));
    } catch (e) { out.notes.push('合約帳戶讀取失敗：' + e.message); }
    // BTC 結算（幣本位）合約
    try {
      const f = await rq('/api/v4/futures/btc/accounts', {}), n = +f.total + (+f.unrealised_pnl || 0), bp = await price('BTC'); if (n > 0) out.assets.push({ coin: 'BTC', amount: n, usd: n * bp, acct: '幣本位合約' });
      for (const x of await rq('/api/v4/futures/btc/positions', {})) if (+x.size) out.positions.push({ symbol: x.contract, side: +x.size > 0 ? 'long' : 'short', contracts: Math.abs(+x.size), entry: +x.entry_price, mark: +x.mark_price, liq: +x.liq_price || null, leverage: +x.leverage || +x.cross_leverage_limit || null, margin_mode: +x.leverage ? 'isolated' : 'cross', upnl: (+x.unrealised_pnl || 0) * bp, coinM: true });
    } catch (e) { if (!/USER_NOT_FOUND|not found/i.test(e.message)) out.notes.push('幣本位合約讀取失敗：' + e.message); }
    return out;
  },
  async mexc(rq) {
    const out = fxOut(), price = fxPrice(async c => (await rq('/api/v3/ticker/price', { symbol: c + 'USDT' }, false)).price);
    for (const x of (await rq('/api/v3/account', {})).balances || []) { const n = +x.free + +x.locked; if (n > 0) out.assets.push({ coin: x.asset, amount: n, usd: n * await price(x.asset), acct: '現貨帳戶' }); }
    try {
      for (const x of await rq('/api/v1/private/account/assets', {}, true, 'fut')) { const n = +x.equity; if (n > 0) out.assets.push({ coin: x.currency, amount: n, usd: n * await price(x.currency), acct: '合約帳戶' }); }
      out.positions = (await rq('/api/v1/private/position/open_positions', {}, true, 'fut')).filter(x => +x.holdVol).map(x => ({ symbol: x.symbol, side: x.positionType === 1 ? 'long' : 'short', contracts: +x.holdVol, entry: +x.holdAvgPrice, mark: null, liq: +x.liquidatePrice || null, leverage: +x.leverage || null, margin_mode: x.openType === 1 ? 'isolated' : 'cross', upnl: null }));
    } catch (e) { out.notes.push('合約帳戶讀取失敗：' + e.message); }
    return out;
  },
  async kucoin(rq, rw) {
    const k = await rq('/api/v1/user/api-key', {}); if (String(k.permission || '').split(',').some(x => x.trim() && x.trim() !== 'General')) rw();
    const out = fxOut(), price = fxPrice(async c => (await rq('/api/v1/market/orderbook/level1', { symbol: c + '-USDT' }, false)).price), AC = { main: '資金帳戶', trade: '現貨帳戶', margin: '槓桿帳戶', isolated: '逐倉槓桿' };
    for (const x of await rq('/api/v1/accounts', {})) { const n = +x.balance; if (n > 0) out.assets.push({ coin: x.currency, amount: n, usd: n * await price(x.currency), acct: AC[x.type] || x.type }); }
    try {
      const f = await rq('/api/v1/account-overview', { currency: 'USDT' }, true, 'fut'), n = +f.accountEquity; if (n > 0) out.assets.push({ coin: 'USDT', amount: n, usd: n, acct: 'U 本位合約' });
      try { const b = await rq('/api/v1/account-overview', { currency: 'XBT' }, true, 'fut'), m = +b.accountEquity; if (m > 0) out.assets.push({ coin: 'BTC', amount: m, usd: m * await price('BTC'), acct: '幣本位合約' }); } catch (e) {}
      out.positions = (await rq('/api/v1/positions', {}, true, 'fut')).filter(x => +x.currentQty).map(x => ({ symbol: x.symbol, side: +x.currentQty > 0 ? 'long' : 'short', contracts: Math.abs(+x.currentQty), entry: +x.avgEntryPrice, mark: +x.markPrice, liq: +x.liquidationPrice || null, leverage: +x.realLeverage || +x.leverage || null, margin_mode: x.crossMode ? 'cross' : 'isolated', upnl: +x.unrealisedPnl || 0 }));
    } catch (e) { out.notes.push('合約帳戶讀取失敗：' + e.message); }
    return out;
  },
  async coinbase(rq, rw) {
    const k = await rq('/api/v3/brokerage/key_permissions', {}); if (k.can_trade || k.can_transfer) rw();
    const out = fxOut(), price = fxPrice(async c => ((await rq('/api/v3/brokerage/market/products', { product_ids: c + '-USD' }, false)).products || [])[0].price);
    for (const x of (await rq('/api/v3/brokerage/accounts', { limit: '250' })).accounts || []) { const n = +((x.available_balance || {}).value || 0) + +((x.hold || {}).value || 0); if (n > 0) out.assets.push({ coin: x.currency, amount: n, usd: n * await price(x.currency), acct: x.type === 'ACCOUNT_TYPE_FIAT' ? '法幣' : '錢包' }); }
    return out;
  },
  async kraken(rq) {
    const out = fxOut(), price = fxPrice(async c => Object.values(await rq('/0/public/Ticker', { pair: c + 'USD' }, false))[0].c[0]);
    // Kraken 幣名：XXBT＝BTC、ZUSD＝USD；.F／.S／.M／.B 結尾是理財
    const M = { XBT: 'BTC', XXBT: 'BTC', XXDG: 'DOGE', XDG: 'DOGE' }, nm = c => { c = c.replace(/\.[A-Z]$/, ''); return M[c] || (/^[XZ][A-Z]{3}$/.test(c) ? c.slice(1) : c); };
    for (const [k, v] of Object.entries(await rq('/0/private/Balance', {}))) { const n = +v, c = nm(k); if (n > 0) out.assets.push({ coin: c, amount: n, usd: n * await price(c), acct: /\.[A-Z]$/.test(k) ? '理財' : '現貨帳戶' }); }
    return out;
  },
};
const FX_OFF = {};
// send(ex, net, path, qs, headers, body) → { status, j }；有 body 就用 POST（Kraken）：手機經推播後端 /x 轉送，HexStack 直接連交易所
async function fxReq(ex, a, p, params, signed, net, send, H) {
  const S = FXS[ex], P = params || {}; let qs = new URLSearchParams(Object.keys(P).sort().map(k => [k, P[k]])).toString(), h = {}, body;
  if (signed !== false) {
    if (FX_OFF[ex] == null) { try { FX_OFF[ex] = S.time[1](await fxReq(ex, a, S.time[0], {}, false, 'main', send, H)) - Date.now(); } catch (e) {} if (!isFinite(FX_OFF[ex])) FX_OFF[ex] = 0; }
    ({ qs, h, body } = await S.sign(a, p, qs, Date.now() + FX_OFF[ex], H));
  }
  const { status, j } = await send(ex, net || 'main', p, qs, h, body);
  if (status >= 400 || !j || !S.ok(j)) throw new Error(S.name + ' ' + ((j && (j.msg || j.message || j.error || j.code)) || 'HTTP ' + status));
  return S.data(j);
}
async function fxRead(ex, a, send, H, rw) { const out = await FX_READ[ex]((p, q, s, n) => fxReq(ex, a, p, q, s, n, send, H), rw); out.total_usd = out.assets.reduce((t, x) => t + (x.usd || 0), 0); return out; }
const FX_H = {
  hmac: async (alg, enc, k, m) => crypto.createHmac(alg.replace('-', '').toLowerCase(), k).update(m).digest(enc === 'b64' ? 'base64' : 'hex'),
  sha: async (alg, m) => new Uint8Array(crypto.createHash(alg.replace('-', '').toLowerCase()).update(m).digest()),
  jwt: async (sec, msg) => {
    sec = sec.replace(/\\n/g, '\n'); const ed = !/BEGIN/.test(sec);
    const pm = sec.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END/); if (pm) sec = `-----BEGIN ${pm[1]}-----\n${pm[2].replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END ${pm[1]}-----\n`; // 手機貼上會吃掉換行，重新排回 PEM
    const key = ed ? crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(sec, 'base64').subarray(0, 32)]), format: 'der', type: 'pkcs8' }) : crypto.createPrivateKey(sec);
    return crypto.sign(ed ? null : 'sha256', Buffer.from(msg), ed ? key : { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  },
};
const fxSend = async (ex, net, p, qs, h, body) => { const r = await fetchT(FXS[ex].host[net] + p + (qs ? '?' + qs : ''), body ? { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, h), body } : { headers: h }, 15000); return { status: r.status, j: await r.json().catch(() => null) }; };
const fxFunds = ex => a => fxRead(ex, { key: a.apiKey, secret: a.apiSecret, pass: a.passphrase }, fxSend, FX_H, a.trade ? () => {} : () => { throw new HErr(400, `這把 ${FXS[ex].name} 金鑰有交易或提現權限，不是唯讀。請另外建一把只勾「讀取」的金鑰。`); });
const FUND_EX = { bybit: { name: 'Bybit', read: bybitFunds } };
for (const k of Object.keys(FXS)) FUND_EX[k] = { name: FXS[k].name, pass: !!FXS[k].pass, read: fxFunds(k) };
const FUND_CACHE = {};
const fundList = () => (C.funds || []).map(a => ({ id: a.id, name: a.name, exchange: a.exchange, testnet: !!a.testnet, keyTail: a.apiKey.slice(-4), inTotal: a.inTotal !== false }));
// 下單用的金鑰也能算進資產總覽（tradeInTotal）：用同一個讀取函式，但不檢查唯讀（它本來就有交易權限）；其他交易所的模擬交易金鑰查不到正式網，改用下單介面讀合約權益和持倉
const liveRead = async () => { const X = LED.live, eq = await X.getEquity(), ps = await X.getPositions().catch(() => []);
  return { total_usd: eq, assets: [{ coin: 'USDT', amount: eq, usd: eq, acct: C.testnet ? '合約帳戶（模擬交易）' : '合約帳戶' }], positions: ps.map(x => ({ symbol: x.sym + 'USDT', side: x.side > 0 ? 'long' : 'short', contracts: x.qty, entry: x.entry, mark: x.mark, upnl: x.upnl })), notes: [] }; };
const tradeAcct = () => liveReady() && C.tradeInTotal !== false ? { id: 'trade', name: C.tradeName || LIVE_NAME[C.exchange] + '・下單用', exchange: C.exchange, testnet: !!C.testnet, apiKey: C.apiKey, apiSecret: C.apiSecret, passphrase: C.apiPass, trade: true, read: C.exchange !== 'bybit' && C.testnet ? liveRead : null } : null;
async function fundsAll(force) {
  const now = Date.now(), res = [], T = tradeAcct();
  for (const a of (T ? [T] : []).concat((C.funds || []).filter(x => x.inTotal !== false))) {
    const c = FUND_CACHE[a.id];
    if (!force && c && now - c.at < 60000) { res.push(c.v); continue; }
    let v;
    try { v = Object.assign({ id: a.id, name: a.name, exchange: a.exchange, ok: true }, await (a.read || FUND_EX[a.exchange].read)(a)); }
    catch (e) { v = { id: a.id, name: a.name, exchange: a.exchange, ok: false, total_usd: 0, assets: [], positions: [], notes: [e.message] }; }
    FUND_CACHE[a.id] = { at: now, v }; res.push(v);
  }
  return { updated_at: new Date().toISOString(), total_usd: res.reduce((t, x) => t + (x.total_usd || 0), 0), accounts: res };
}
async function fundAdd(d) {
  const ex = FUND_EX[d.exchange]; if (!ex) throw new HErr(400, '目前只支援：' + Object.keys(FUND_EX).join('、'));
  const a = { id: 'f' + rnd(6), name: String(d.name || ex.name).trim().slice(0, 30) || ex.name, exchange: d.exchange, testnet: d.testnet === true, inTotal: d.inTotal !== false, apiKey: String(d.apiKey || '').trim().slice(0, 100), apiSecret: String(d.apiSecret || '').trim().slice(0, 600) };
  if (!a.apiKey || !a.apiSecret) throw new HErr(400, '要填 API Key 和 Secret');
  if (ex.pass) { a.passphrase = String(d.passphrase || '').slice(0, 100); if (!a.passphrase) throw new HErr(400, `${ex.name} 還要填 Passphrase（建立金鑰時自己設的密碼）`); }
  if (d.exchange !== 'bybit') a.testnet = false;
  if ((C.funds || []).some(x => x.exchange === a.exchange && x.apiKey === a.apiKey)) throw new HErr(400, '這把金鑰已經加過了');
  let r; try { r = await ex.read(a); } catch (e) { if (e instanceof HErr) throw e; throw new HErr(400, '金鑰驗證失敗：' + e.message); }
  // 同一個 Bybit 帳戶已經用下單金鑰算進總資產，再加唯讀金鑰會重複算
  if (a.exchange === 'bybit' && r.uid && liveReady() && C.tradeInTotal !== false && !!C.testnet === a.testnet) {
    let tu = null; try { tu = String((await new BybitExchange({ apiKey: C.apiKey, apiSecret: C.apiSecret, testnet: !!C.testnet, limits: C.limits }).req('GET', '/v5/user/query-api', {})).userID); } catch (e) {}
    if (tu && tu === r.uid) throw new HErr(400, '這個 Bybit 帳戶已經用下單金鑰算進總資產了，不用再加唯讀金鑰（加了會重複計算）。');
  }
  (C.funds = C.funds || []).push(a); saveCfg(); FUND_CACHE[a.id] = { at: Date.now(), v: Object.assign({ id: a.id, name: a.name, exchange: a.exchange, ok: true }, r) };
  log('info', { text: `資產總覽新增 ${a.name}（唯讀金鑰 …${a.apiKey.slice(-4)}）` });
  return { ok: true, id: a.id, total_usd: r.total_usd };
}
const LED = { paper: new PaperExchange(S.paper), live: null };
for (const k of Object.keys(S.sims)) LED['sim:' + k] = new PaperExchange(S.sims[k]);
const LEDS = () => Object.keys(LED).filter(L => LED[L]);
const isPaperL = L => LED[L] instanceof PaperExchange;
const liveReady = () => !!LIVE_EX[C.exchange] && !!C.apiKey && !!C.apiSecret && (!LIVE_PASS[C.exchange] || !!C.apiPass);
const liveName = () => (LIVE_NAME[C.exchange] || C.exchange) + (C.testnet ? (C.exchange === 'bybit' ? ' 測試網' : ' 模擬交易') : ' 正式帳戶');
function setupLive() { LED.live = liveReady() ? new LIVE_EX[C.exchange](C) : null; if (LED.live) LED.live.maxLev = effLev(); }
setupLive();
const mainL = () => LED.live ? 'live' : 'paper';
// g.led：在哪個帳本跑（'sim:<交易所>' 或 'live'）；舊策略沒有 g.led，照 mode 走試跑帳本／實盤
const ledOf = g => g.led ? (g.led === 'live' ? (LED.live ? 'live' : 'paper') : LED[g.led] ? g.led : 'paper') : g.mode === 'live' && LED.live ? 'live' : 'paper';
// C.paperOnly＝App 上的「模擬盤」總開關（預設開）：開著時實盤帳本的策略一律不動作，不下真單
if (C.paperOnly === undefined) { C.paperOnly = !S.strategies.some(g => g.mode === 'live' && g.pos); saveCfg(); }
const blocked = g => g.led === 'live' && !LED.live || ledOf(g) === 'live' && C.paperOnly === true;
const liveAllowed = () => liveReady() && (C.testnet || C.allowLive === true);   // 測試網不用 allowLive；正式網一定要 allowLive

// ───────── 策略 ─────────
const posQ = g => g.pos ? g.pos.side * g.pos.qty : 0;
const activeSyms = () => [...new Set([...S.strategies.filter(g => g.enabled).map(g => g.sym), ...Object.keys(S.paper.pos), ...Object.values(S.sims).flatMap(x => Object.keys(x.pos))].map(baseOf))];
function cleanP(p) {
  const q = {};
  for (const [a, v] of Object.entries(p && typeof p === 'object' ? p : {}).slice(0, 100)) if (/^\w{1,20}$/.test(a) && (typeof v === 'number' && isFinite(v) || typeof v === 'boolean' || typeof v === 'string' && (v.length <= 40 || a === 'rules' && v.length <= 3000))) q[a] = v;
  delete q.capital; return q;
}
function fullP(g) { const B = ENG.BEST[g.st] || {}, o = Object.assign({}, B[g.sym] || B.BTC || {}, g.p, { capital: 1000 }); const M = mktOf(g); if (M === 'fut') return o;
  // 現貨：只做多、1 倍、沒有資金費率；槓桿：最多 MRG_LEV 倍、沒有資金費率（改付借款利息）
  if ('funding' in o) o.funding = false; if (M === 'spot' && 'dir' in o) o.dir = 'long';
  const cap = M === 'spot' ? 1 : MRG_LEV; for (const k of ['lev', 'maxLev', 'rollLev']) if (+o[k] > cap) o[k] = cap;
  return o; }
// 跑一次策略回測，回傳期末部位：side、ratio（名目÷策略權益，帶正負）、停損、停利、造成這個部位的訊號
function runSim(st, sym, t0, t1, p) { let fin = null; ENG.ctx.__FIN = x => { fin = x; }; try { return { r: ENG.simulate(st, sym, t0, t1, p), fin }; } finally { ENG.ctx.__FIN = null; } }
function target(g, T) {
  const { r, fin } = runSim(g.st, g.sym, T - SIM_DAYS * D1, T, fullP(g));
  const b = ENG.ctx.Engine.load(g.sym), c = b.C[b.n - 1];
  let q = 0, eq = 0;
  if (fin && !r.liq && !fin.liq) { eq = fin.E(c); const d = c * 1e-3; q = (fin.E(c + d) - fin.E(c - d)) / (2 * d); if (!(eq > 0) || Math.abs(q * c) < eq * 1e-4) q = 0; }
  const side = sgn(q), ratio = eq > 0 ? q * c / eq : 0;
  let stop = 0, tp = 0;
  if (side) {
    const us = Array.isArray(fin.units) ? fin.units.map(u => u.stop).filter(x => x > 0) : [];
    stop = us.length ? (side > 0 ? Math.min(...us) : Math.max(...us)) : fin.stop || fin.wStop || 0;   // 分批進場取最遠的停損當保護
    if (stop && (side > 0 ? stop >= c : stop <= c)) stop = 0;
    tp = fin.tpPx || 0; const P = fullP(g);
    if (!tp && g.st === 'cus' && +P.tp > 0 && fin.avg) tp = fin.avg * (1 + side * P.tp / 100);
    if (tp && (side > 0 ? tp <= c : tp >= c)) tp = 0;
  }
  const mk = r.marks || []; let sig = null;
  if (side) for (let i = mk.length - 1; i >= 0; i--) { const m = mk[i]; if (m.type === 'entry' || m.type === 'add') { if ((m.side || 1) === side) sig = m; break; } if (m.type === 'exit' || m.type === 'liq') break; }
  const lm = mk[mk.length - 1] || null;
  return { side, ratio, stop, tp, c, sigT: sig ? sig.t : 0, sigPx: sig ? sig.px : 0, sigText: sig ? sig.text : '', lastMark: lm && { t: lm.t, type: lm.type, text: lm.text || '' } };
}
const stName = g => g.name || (ENG.NAME[g.st] || g.st) + ' ' + g.sym;
const lg = (type, g, o) => log(type, Object.assign({ sid: g.id, name: stName(g), sym: g.sym, led: ledOf(g) }, o));

// 把一筆成交記到策略帳本（不動交易所）
function book(g, dq, fillPx, fee, ref, kind, text) {
  const h0 = posQ(g);
  if (h0 && sgn(h0 + dq) === -sgn(h0)) {   // 反手：拆成先平倉、再開新倉
    const f = Math.abs(h0) / Math.abs(dq); book(g, -h0, fillPx, fee * f, ref, kind === 'open' ? 'close' : kind, text);
    return book(g, dq + h0, fillPx, fee * (1 - f), ref, 'open', text);
  }
  const p = g.pos || { side: 0, qty: 0, entry: 0, stop: 0, tp: 0, t: nowS(), fees: 0, pnl: 0 }, held = p.side * p.qty, nq = held + dq;
  let pnl = 0;
  if (held && sgn(dq) !== sgn(held)) {
    const red = Math.min(Math.abs(dq), Math.abs(held)); pnl = sgn(held) * red * (fillPx - p.entry);
    if (Math.abs(nq) > 1e-12 && sgn(nq) !== sgn(held)) { p.entry = fillPx; p.t = nowS(); p.pnl = 0; p.fees = 0; }
  } else p.entry = held ? (p.entry * Math.abs(held) + fillPx * Math.abs(dq)) / Math.abs(nq) : fillPx;
  p.pnl += pnl - fee; p.fees += fee; g.real = (g.real || 0) + pnl - fee; g.feeSum = (g.feeSum || 0) + fee;
  (g.fills || (g.fills = [])).push({ t: nowS(), q: dq, px: fillPx, ref: ref || 0, fee, kind });
  if (g.fills.length > 400) g.fills.splice(0, 100);
  const type = kind === 'stop' || kind === 'tp' ? kind : Math.abs(nq) > Math.abs(held) + 1e-12 ? 'open' : 'close';
  if (Math.abs(nq) < 1e-12) { (g.trades || (g.trades = [])).push({ t0: p.t, t1: nowS(), side: sgn(held), pnl: p.pnl, entry: p.entry, exit: fillPx }); if (g.trades.length > 300) g.trades.splice(0, 50); g.pos = null; }
  else { p.side = sgn(nq); p.qty = Math.abs(nq); g.pos = p; }
  const e = lg(type, g, { side: sgn(dq) * (type === 'open' ? 1 : -1), px: fillPx, qty: Math.abs(dq), pnl: type === 'open' ? 0 : pnl - fee, text });
  if (ledOf(g) === 'live') notify(`${TYPE[type]}｜${stName(g)}`, `${dq > 0 ? '買' : '賣'} ${fmt(Math.abs(dq), 6)} ${g.sym} @ ${fpx(fillPx)}${text ? '　' + text : ''}`);
  dirty(); return e;
}

// 對交易所下單，讓「策略帳本合計＋手動部位」＝ 實際部位；deltas：[{g, dq, kind, text, ref}]
async function execute(L, sym, deltas) {
  const X = LED[L], A = acct(L); if (!X) return false;
  const actual = await X.position(sym), before = deltas.map(d => posQ(d.g));
  if (!(await guard(L, sym, actual))) return false;
  deltas = deltas.filter((d, i) => Math.abs(posQ(d.g) - before[i]) < 1e-12);   // 對帳時交易所停損剛好觸發、帳本已經記掉了，這筆就不要再記一次
  let want = S.strategies.filter(g => ledOf(g) === L && xk(g) === sym).reduce((a, g) => a + posQ(g), 0) + deltas.reduce((a, d) => a + d.dq, 0) + (A.offset[sym] || 0);
  const M = mktK(sym); if (M === 'spot') want = Math.max(0, want);   // 現貨不能放空
  let diff = want - actual, fills = [], err = null;
  if (M !== 'fut' && want && sgn(want) === sgn(actual) && Math.abs(diff) < 0.005 * Math.abs(want)) diff = 0;   // 現貨手續費從幣裡扣，差 0.5% 內不補單
  try {
    const mq = await X.minQty(sym);
    if (Math.abs(diff) >= mq * 0.999) {
      if (actual && sgn(want) !== sgn(actual)) { fills.push(await X.marketOrder(sym, -sgn(actual), Math.abs(actual), true, deltas[0] && deltas[0].kind)); diff = want; }
      if (Math.abs(diff) >= mq * 0.999 && want) fills.push(await X.marketOrder(sym, sgn(diff), Math.abs(diff), Math.abs(want) < Math.abs(actual) && sgn(want) === sgn(actual), deltas[0] && deltas[0].kind));
    }
  } catch (e) { err = e; }
  const fq = fills.reduce((a, f) => a + f.qty, 0), fpx_ = fq ? fills.reduce((a, f) => a + f.qty * f.px, 0) / fq : await X.price(sym), feeR = fq ? fills.reduce((a, f) => a + f.fee, 0) / (fq * fpx_) : 0;
  if (err && !fq) { log('error', { sym, led: L, text: '下單失敗：' + err.message }); notifyErr('下單失敗：' + err.message); A.lastSet[sym] = await X.position(sym).catch(() => actual); return false; }
  for (const d of deltas) if (d.dq) book(d.g, d.dq, fpx_, Math.abs(d.dq) * fpx_ * (feeR || COST().fee * (fq ? 1 : 0)), d.ref, d.kind, d.text);
  A.lastSet[sym] = await X.position(sym); A.setAt[sym] = nowS();
  await protect(L, sym); dirty(); return true;
}
// 交易所層級的保護停損：同一個幣的策略都同方向時，取最遠的停損；只有一個策略時連停利一起設
async function protect(L, sym) {
  const X = LED[L], A = acct(L), gs = S.strategies.filter(g => ledOf(g) === L && xk(g) === sym && g.pos);
  let stop = 0, tp = 0;
  if (gs.length && gs.every(g => g.pos.side === gs[0].pos.side) && !(A.offset[sym])) {
    const s = gs[0].pos.side, ss = gs.map(g => g.pos.stop || 0);
    if (ss.every(x => x > 0)) stop = s > 0 ? Math.min(...ss) : Math.max(...ss);
    if (gs.length === 1) tp = gs[0].pos.tp || 0;
  }
  const k = stop + '|' + tp; if (A.stops[sym] === k) return;
  try { await X.setStop(sym, stop, tp); A.stops[sym] = k; } catch (e) { log('error', { sym, led: L, text: '設停損失敗：' + e.message }); }
}
// 對帳：實際部位跟上次設定不一樣，而且不是自己的停損單觸發 → 有人手動操作，暫停這個幣的策略，不跟使用者對打
async function guard(L, sym, actual) {
  const X = LED[L], A = acct(L), gs = S.strategies.filter(g => ledOf(g) === L && xk(g) === sym);
  if (!(sym in A.lastSet)) { A.lastSet[sym] = actual; const ours = gs.reduce((a, g) => a + posQ(g), 0); A.offset[sym] = actual - ours; if (Math.abs(actual - ours) > 1e-9) log('info', { sym, led: L, text: `交易所原本就有 ${fmt(actual - ours, 6)} 的部位，當成手動部位不去動它` }); dirty(); return true; }
  const last = A.lastSet[sym], tol = Math.max(1e-9, Math.abs(last) * (mktK(sym) === 'fut' ? 1e-6 : 2e-3), L === 'live' ? (await X.instrument(sym).catch(() => ({ step: 0 }))).step / 2 : 0);
  if (Math.abs(actual - last) <= tol) return true;
  // 自己設的停損／停利單觸發？
  let ev = []; try { ev = await X.stopFills(sym, (A.setAt[sym] || 0) - 5); } catch (e) {}
  if (ev.length && Math.abs(actual) < Math.abs(last) && sgn(actual) !== -sgn(last)) {
    const e = ev[ev.length - 1], gone = Math.abs(last) - Math.abs(actual);
    let left = gone;
    for (const g of gs.filter(g => g.pos && g.pos.side === sgn(last))) { if (left <= 1e-12) break; const q = Math.min(left, g.pos.qty); left -= q; book(g, -g.pos.side * q, e.px, q * e.px * COST().fee, g.pos.stop || e.px, e.kind, '交易所' + (e.kind === 'stop' ? '停損' : '停利') + '單觸發'); }
    if (isPaperL(L)) X.s.ev = X.s.ev.filter(x => x.sym !== sym);
    A.lastSet[sym] = actual; A.setAt[sym] = nowS(); A.stops[sym] = ''; dirty(); return true;
  }
  const paused = [];
  for (const g of gs) if (g.state !== 'paused' || g.pauseKind !== 'manual') { g.state = 'paused'; g.pauseKind = 'manual'; g.pauseReason = '偵測到手動操作'; paused.push(stName(g)); }
  A.lastSet[sym] = actual; A.manual = A.manual || {}; A.manual[sym] = nowS(); dirty();
  const txt = `${sym} 實際部位 ${fmt(actual, 6)}，上次設定 ${fmt(last, 6)}，判斷有人手動操作；已暫停 ${paused.join('、') || '（沒有策略）'}，不會去改回來`;
  log('pause', { sym, led: L, text: txt }); notify('⚠️ 偵測到手動操作', txt);
  return false;
}
// 手動暫停後恢復：手動改過的部分當成使用者的部位（offset），這個幣的策略帳本歸零（照當時價格結算），之後遇到新訊號再進場
async function adopt(L, sym) {
  const X = LED[L], A = acct(L), actual = await X.position(sym), p = await X.price(sym);
  for (const g of S.strategies.filter(g => ledOf(g) === L && xk(g) === sym && g.pos)) { const q = posQ(g); g.pos.qty = Math.abs(q); book(g, -q, p, 0, p, 'close', '手動接手，帳本歸零（不動交易所）'); }
  A.offset[sym] = actual; A.lastSet[sym] = actual; A.setAt[sym] = nowS(); A.stops[sym] = ''; if (A.manual) delete A.manual[sym]; dirty();
}

// ───────── 每小時：照回測算目標部位、對帳下單 ─────────
async function hourTick(T) {
  if (!ENG.ok) return;
  setViews(T);
  // 模擬盤的槓桿（借貸）利息：每小時扣一次，按名目分攤到有槓桿部位的策略
  for (const L of LEDS()) if (isPaperL(L)) {
    const X = LED[L], h = X.s.intT ? Math.min(24, (T - X.s.intT) / H1) : 0; X.s.intT = T; if (!(h > 0)) continue;
    const fee = X.interest(h), gm = S.strategies.filter(g => ledOf(g) === L && g.pos && mktOf(g) === 'mrg'), tot = gm.reduce((a, g) => a + g.pos.qty, 0) && gm.reduce((a, g) => a + g.pos.qty * px(g.sym), 0);
    if (fee > 0 && tot > 0) for (const g of gm) { const f_ = fee * g.pos.qty * px(g.sym) / tot; g.real = (g.real || 0) - f_; g.feeSum = (g.feeSum || 0) + f_; g.pos.pnl -= f_; }
  }
  const gs = S.strategies.filter(g => g.enabled && (g.lastBar || 0) < T);
  if (!gs.length) return;
  const eqs = {}; for (const L of LEDS()) try { eqs[L] = await LED[L].getEquity(); } catch (e) { log('error', { led: L, text: '讀權益失敗：' + e.message }); }
  const plans = [];
  for (const g of gs) {
    const L = ledOf(g), eq = eqs[L]; if (!(eq > 0)) continue;
    if (g.state === 'paused' && g.pauseKind === 'manual' || blocked(g)) { g.lastBar = T; continue; }
    let tg; try { tg = target(g, T); } catch (e) { lg('error', g, { text: '回測計算失敗：' + e.message }); continue; }
    const M = mktOf(g);
    if (M === 'spot' && tg.side < 0) tg = Object.assign({}, tg, { side: 0, ratio: 0, stop: 0, tp: 0, sigT: 0, sigText: '', lastMark: tg.lastMark && tg.lastMark.type === 'entry' ? null : tg.lastMark });   // 現貨只做多：空單訊號當空手
    const P = await LED[L].price(xk(g)) || tg.c; if (!P) continue;
    const held = posQ(g), lim = C.limits, inc = g.state !== 'paused' && !acct(L).halt;
    let wAbs = Math.abs(tg.ratio) * g.alloc * eq / P;
    if (limOn('maxPosPct')) wAbs = Math.min(wAbs, lim.maxPosPct / 100 * eq / P);                       // 單一策略名目 ≤ 權益 × maxPosPct%
    if (M !== 'fut') wAbs = Math.min(wAbs, g.alloc * eq / P * (M === 'spot' ? 1 : MRG_LEV));   // 現貨 1 倍、槓桿最多 MRG_LEV 倍
    g.tg = { side: tg.side, ratio: r2(tg.ratio, 3), stop: tg.stop, tp: tg.tp, sigT: tg.sigT, sigPx: tg.sigPx, at: T };
    const newMark = tg.lastMark && tg.lastMark.t > (g.lastBar || 0) - H1 && tg.lastMark.t > (g.markT || 0);
    let want = held, kind = '', text = '';
    const fresh = tg.sigT >= T - H1;
    const entryOk = (from0) => {   // 斷線補單規則：不是最新那根的訊號，現價離訊號價 ≤ catchupPct 才進
      if (fresh) return true;
      const dev = Math.abs(P - tg.sigPx) / tg.sigPx * 100, key = tg.sigT + '|' + tg.side;
      if (dev <= C.catchupPct) { text = `補單：訊號在 ${tpeHM(tg.sigT)}（${fpx(tg.sigPx)}），現價差 ${dev.toFixed(2)}%`; return true; }
      if (g.skipKey !== key) {
        g.skipKey = key;
        const offline = g.lastBar && tg.sigT > g.lastBar, why = offline ? '主機離線期間的' + (from0 ? '進場' : '加倉') + '訊號' : g.lastBar ? '沒跟上的訊號' : '策略加入時已在持倉中的訊號';
        const counted = !!offline || !!g.lastBar && tg.sigT > Math.max(g.start || 0, g.driftFrom || 0);   // 執行器自己暫停期間的訊號不算偏離
        (g.skips || (g.skips = [])).push({ t: T, offline: !!offline, counted }); if (g.skips.length > 100) g.skips.splice(0, 20);
        lg('skip', g, { side: tg.side, px: P, text: `${why}（${tpeHM(tg.sigT)} @ ${fpx(tg.sigPx)}），現價差 ${dev.toFixed(2)}% > ${C.catchupPct}%，不追` });
      }
      return false;
    };
    if (!tg.side) { if (held) { want = 0; kind = tg.lastMark && (tg.lastMark.type === 'stop' || tg.lastMark.type === 'tp') ? tg.lastMark.type : 'close'; text = tg.lastMark ? tg.lastMark.text : '出場'; } }
    else if (held && sgn(held) !== tg.side) { want = 0; kind = 'close'; text = '反手：' + (tg.lastMark ? tg.lastMark.text : ''); if (inc && entryOk(true)) { want = tg.side * wAbs; text += '，改' + (tg.side > 0 ? '做多' : '做空'); } }
    else if (!held) { if (inc && entryOk(true)) { want = tg.side * wAbs; kind = 'open'; text = text || tg.sigText || '進場'; } }
    else {
      const gap = wAbs - Math.abs(held);
      if (Math.abs(gap) < 0.05 * Math.abs(held)) { /* 差不到 5% 不動，免得來回小單 */ }
      else if (gap < 0 && (newMark || -gap > 0.25 * Math.abs(held))) { want = tg.side * wAbs; kind = newMark && (tg.lastMark.type === 'stop' || tg.lastMark.type === 'tp') ? tg.lastMark.type : 'close'; text = newMark ? tg.lastMark.text : '照回測調整（減倉）'; }
      else if (gap > 0 && inc && (newMark && (tg.lastMark.type === 'add' || tg.lastMark.type === 'entry') || gap > 0.25 * Math.abs(held)) && entryOk(false)) { want = tg.side * wAbs; kind = 'open'; text = text || (newMark ? '加倉：' + tg.lastMark.text : '照回測調整（加倉）'); }
    }
    if (tg.lastMark) g.markT = Math.max(g.markT || 0, tg.lastMark.t);
    plans.push({ g, L, P, want, held, kind, text, ref: tg.c, tg });
  }
  // 帳戶總槓桿 ≤ maxLev：只縮加倉的部分
  for (const L of LEDS()) {
    const ps = plans.filter(x => x.L === L), eq = eqs[L]; if (!ps.length || !(eq > 0)) continue;
    const other = S.strategies.filter(g => ledOf(g) === L && !ps.some(x => x.g === g)).reduce((a, g) => a + Math.abs(posQ(g)) * px(g.sym), 0);
    const gross = other + ps.reduce((a, x) => a + Math.abs(x.want) * x.P, 0), cap = C.limits.maxLev * eq;
    if (limOn('maxLev') && gross > cap) { const incs = ps.filter(x => Math.abs(x.want) > Math.abs(x.held) && sgn(x.want) === sgn(x.held || x.want)), extra = incs.reduce((a, x) => a + (Math.abs(x.want) - (sgn(x.held) === sgn(x.want) ? Math.abs(x.held) : 0)) * x.P, 0), over = gross - cap;
      const f = extra > 0 ? Math.max(0, 1 - over / extra) : 1;
      for (const x of incs) { const base = sgn(x.held) === sgn(x.want) ? Math.abs(x.held) : 0; x.want = sgn(x.want) * (base + (Math.abs(x.want) - base) * f); x.text += `（總槓桿上限 ${C.limits.maxLev} 倍，縮到 ${Math.round(f * 100)}%）`; }
    }
  }
  // 依幣別一次下單
  const by = {};
  for (const x of plans) { x.g.lastBar = T; if (Math.abs(x.want - x.held) > 1e-12 * Math.max(1, Math.abs(x.held))) (by[x.L + '|' + xk(x.g)] || (by[x.L + '|' + xk(x.g)] = [])).push(x); else if (x.g.pos && x.tg.side === x.g.pos.side) { x.g.pos.stop = x.tg.stop; x.g.pos.tp = x.tg.tp; } }
  for (const [k, xs] of Object.entries(by)) {
    const [L, sym] = k.split('|');
    const ds = xs.map(x => ({ g: x.g, dq: x.want - x.held, kind: x.kind || (Math.abs(x.want) > Math.abs(x.held) ? 'open' : 'close'), text: x.text, ref: x.ref }));
    const ok = await execute(L, sym, ds);
    if (ok) for (const x of xs) if (x.g.pos) { x.g.pos.stop = x.tg.stop; x.g.pos.tp = x.tg.tp; }
    if (ok) await protect(L, sym);
  }
  for (const L of LEDS()) for (const sym of new Set(S.strategies.filter(g => ledOf(g) === L && g.pos).map(xk))) await protect(L, sym);
  // 策略權益曲線
  for (const g of S.strategies.filter(g => g.enabled)) { const e = stratEq(g); (g.curve || (g.curve = [])).push([T, r2(e)]); thin(g.curve); }
  S.lastBar = Math.max(S.lastBar, T); S.lastTickAt = nowS(); dirty();
  driftCheck();
}
const thin = a => { if (a.length > 6000) { const h = a.splice(0, 3000); a.unshift(...h.filter((x, i) => i % 4 === 0)); } };
const stratEq = g => (g.base || 0) + (g.real || 0) + (g.pos ? g.pos.side * g.pos.qty * (px(g.sym) - g.pos.entry) : 0);

// ───────── 每分鐘：策略停損停利、對帳、帳戶煞車、報告、心跳 ─────────
async function stopChecks() {
  for (const g of S.strategies) {
    if (!g.pos || !g.enabled || g.pauseKind === 'manual' && g.state === 'paused') continue;
    const L = ledOf(g), P = await LED[L].price(xk(g)).catch(() => 0); if (!P) continue;
    const s = g.pos.side, hitS = g.pos.stop && (s > 0 ? P <= g.pos.stop : P >= g.pos.stop), hitT = !hitS && g.pos.tp && (s > 0 ? P >= g.pos.tp : P <= g.pos.tp);
    if (hitS || hitT) await execute(L, xk(g), [{ g, dq: -posQ(g), kind: hitS ? 'stop' : 'tp', ref: hitS ? g.pos.stop : g.pos.tp, text: hitS ? `價格 ${fpx(P)} 碰到停損 ${fpx(g.pos.stop)}` : `價格 ${fpx(P)} 碰到停利 ${fpx(g.pos.tp)}` }]);
  }
}
async function watch() {
  for (const L of LEDS()) { const X = LED[L]; const A = acct(L);
    const syms = new Set([...Object.keys(A.lastSet), ...S.strategies.filter(g => ledOf(g) === L && g.pos).map(xk)]);
    for (const sym of syms) { try { await guard(L, sym, await X.position(sym)); } catch (e) {} }
  }
}
async function account() {
  for (const L of LEDS()) {
    const X = LED[L]; const A = acct(L);
    let eq; try { eq = await X.getEquity(); } catch (e) { continue; }
    if (!A.start) { A.start = eq; A.startT = nowS(); A.peak = eq; }
    const dk = tpeDay(nowS()); if (A.dayKey !== dk) { A.prevDay = { key: A.dayKey, start: A.dayStart, end: eq }; A.dayKey = dk; A.dayStart = eq; }
    A.eq = eq; A.peak = Math.max(A.peak || eq, eq); const dd = A.peak > 0 ? 1 - eq / A.peak : 0; A.dd = dd; A.mdd = Math.max(A.mdd || 0, dd);
    const t = nowS(); if (!A.curve.length || t - A.curve[A.curve.length - 1][0] >= H1) { A.curve.push([t, r2(eq)]); thin(A.curve); }
    // 防爆倉：總槓桿超過上限 1.5 倍就按比例降倉
    const gs = S.strategies.filter(g => ledOf(g) === L && g.pos), gross = gs.reduce((a, g) => a + g.pos.qty * px(g.sym), 0);
    if (limOn('maxLev') && eq > 0 && gross > C.limits.maxLev * 1.5 * eq) {
      const f = C.limits.maxLev / (gross / eq);
      for (const sym of new Set(gs.map(xk))) await execute(L, sym, gs.filter(g => xk(g) === sym).map(g => ({ g, dq: -posQ(g) * (1 - f), kind: 'close', text: `總槓桿 ${(gross / eq).toFixed(1)} 倍超過上限，自動降倉` })));
    }
    if (A.halt) continue;
    const dayPct = A.dayStart > 0 ? (eq / A.dayStart - 1) * 100 : 0;
    if (limOn('maxDDPct') && dd * 100 >= C.limits.maxDDPct) { await halt(L, `回撤 ${(dd * 100).toFixed(1)}% 達上限 ${C.limits.maxDDPct}%，全部平倉並暫停`, true, '回撤上限'); }
    else if (limOn('dayLossPct') && -dayPct >= C.limits.dayLossPct) { await halt(L, `今日虧損 ${(-dayPct).toFixed(1)}% 達上限 ${C.limits.dayLossPct}%，暫停所有策略`, false, '單日虧損上限'); }
  }
}
async function halt(L, reason, close, short) {
  const A = acct(L); A.halt = { reason, t: nowS() };
  for (const g of S.strategies.filter(g => ledOf(g) === L && g.enabled)) if (g.state !== 'paused') { g.state = 'paused'; g.pauseKind = 'halt'; g.pauseReason = short; }
  if (close) await closeLedger(L, short);
  log('halt', { led: L, text: reason }); notify('🛑 帳戶煞車', reason); dirty();
}
async function closeLedger(L, why) {
  for (const sym of new Set(S.strategies.filter(g => ledOf(g) === L && g.pos).map(xk)))
    await execute(L, sym, S.strategies.filter(g => ledOf(g) === L && g.pos && xk(g) === sym && !(g.state === 'paused' && g.pauseKind === 'manual')).map(g => ({ g, dq: -posQ(g), kind: 'close', text: why })));
}
// 偏離回測：平均滑價 > 回測 3 倍（至少 3 筆成交），或漏單／略過 ≥ 2 筆 → 暫停
function driftCheck() {
  for (const g of S.strategies.filter(g => g.enabled && g.state !== 'paused')) {
    const t0 = Math.max(g.start || 0, g.driftFrom || 0), sl = slipStat(g, t0), miss = (g.skips || []).filter(x => x.counted && x.t >= t0).length;
    let why = '';
    if (sl.n >= 3 && sl.avg > 3 * sl.assumed) why = `滑價為回測 ${(sl.avg / sl.assumed).toFixed(1)} 倍`;
    else if (miss >= 2) why = `漏單／略過 ${miss} 筆`;
    if (why) { g.state = 'paused'; g.pauseKind = 'drift'; g.pauseReason = '偏離回測'; lg('pause', g, { text: '偏離回測：' + why }); notify('⚠️ 策略偏離回測已暫停', stName(g) + '：' + why); dirty(); }
  }
}
function slipStat(g, t0) {
  const fs_ = (g.fills || []).filter(f => f.t >= t0 && f.ref > 0 && f.kind !== 'stop' && f.kind !== 'tp').slice(-20);
  const v = fs_.map(f => sgn(f.q) * (f.px - f.ref) / f.ref);
  return { n: v.length, avg: v.length ? v.reduce((a, x) => a + x, 0) / v.length : 0, assumed: slipOf(g.sym) };
}

// ───────── 回顧：真實 vs 同期回測 ─────────
const RVC = {};
function review(g, days) {
  const T = S.lastBar || Math.floor(nowS() / H1) * H1, tS = g.start || g.trialStart || S.startT, t0 = days ? Math.max(tS, T - days * D1) : tS;
  const ck = g.id + '|' + days + '|' + T + '|' + (g.fills || []).length + '|' + g.alloc; if (RVC[ck]) return RVC[ck];
  const cv = (g.curve || []).filter(x => x[0] >= t0), eq0 = cv.length ? cv[0][1] : g.base || 1, eqN = stratEq(g);
  const curve = cv.concat([[nowS(), r2(eqN)]]);
  let pk = 0, mdd = 0; for (const [, e] of curve) { pk = Math.max(pk, e); mdd = Math.max(mdd, pk > 0 ? 1 - e / pk : 0); }
  const tr = (g.trades || []).filter(x => x.t1 >= t0), sl = slipStat(g, t0);
  const real = { ret: r2((eqN / eq0 - 1) * 100), trades: tr.length, win: tr.length ? r2(tr.filter(x => x.pnl > 0).length / tr.length * 100, 1) : 0, mdd: r2(mdd * 100), slip: r2(sl.avg * 100, 4), fills: sl.n, curve: down(curve) };
  let bt = { ret: 0, trades: 0, win: 0, mdd: 0, slip: r2(sl.assumed * 100, 4), curve: [] };
  if (ENG.ok && T - t0 >= H1) try {
    setViews(T);
    const { r } = runSim(g.st, g.sym, t0, T, Object.assign(fullP(g), { capital: eq0 }));
    const done = (r.trades || []).filter(x => x.why !== '期末持有中' && (x.ret != null || x.pnl != null));
    const cyc = r.cycles;
    const n = cyc ? cyc.length : done.length, w = cyc ? cyc.filter(x => x.pnl > 0).length : done.filter(x => (x.pnl != null ? x.pnl : x.ret) > 0).length;
    bt = { ret: r2((r.final / eq0 - 1) * 100), trades: n, win: n ? r2(w / n * 100, 1) : 0, mdd: r2(r.mdd * 100), slip: r2(sl.assumed * 100, 4), curve: down([[t0, eq0]].concat(r.eq.filter(x => x[0] >= t0).map(x => [x[0], r2(x[1])]))) };
  } catch (e) { bt.error = e.message; }
  const reasons = [], sk = (g.skips || []).filter(x => x.t >= t0), off = sk.filter(x => x.offline).length, oth = sk.filter(x => !x.offline && x.counted).length;
  if (off) reasons.push(`主機離線漏單 ${off} 筆`);
  if (oth) reasons.push(`補單價差過大略過 ${oth} 筆`);
  if (sl.n >= 3 && sl.avg > 3 * sl.assumed) reasons.push(`滑價為回測 ${(sl.avg / sl.assumed).toFixed(1)} 倍`);
  if (T - t0 >= 2 * D1 && Math.abs(real.ret - bt.ret) > 3 + 0.5 * Math.abs(bt.ret)) reasons.push(`報酬 ${real.ret}% 對回測 ${bt.ret}%`);
  if (Math.abs(real.trades - bt.trades) >= 2) reasons.push(`交易筆數 ${real.trades} 對回測 ${bt.trades}`);
  const out = { sid: g.id, name: stName(g), sym: g.sym, st: g.st, mode: g.mode, from: t0, real, bt, status: reasons.length ? 'drift' : 'ok', reasons };
  for (const k in RVC) if (k.startsWith(g.id + '|' + days + '|')) delete RVC[k];
  return (RVC[ck] = out);
}
const down = c => { if (c.length <= 200) return c; const k = Math.ceil(c.length / 200); return c.filter((x, i) => i % k === 0 || i === c.length - 1); };
const trialLeft = g => g.state === 'trial' || g.mode === 'paper' && !g.promoted ? Math.max(0, (g.trialStart + g.trialDays * D1 - nowS()) / D1) : 0;
function canPromote(g) {
  if (g.promoted || !g.enabled || g.state === 'paused') return { ok: false, why: g.promoted ? '已經轉正' : '策略暫停中' };
  if (trialLeft(g) > 0) return { ok: false, why: `試跑還剩 ${trialLeft(g).toFixed(1)} 天` };
  const rv = review(g, 0); if (rv.status !== 'ok') return { ok: false, why: '試跑結果偏離回測：' + rv.reasons.join('、') };
  if (!liveAllowed()) return { ok: false, why: liveReady() ? '正式網要先在 config.json 設 allowLive: true' : '還沒設定交易所 API Key（只能繼續模擬盤）' };
  return { ok: true, why: '' };
}

// ───────── 每日報告（台北 08:00）─────────
async function dailyReport() {
  const t = nowS(), L = mainL(), A = acct(L), eq = A.eq || 0, prev = (A.curve.find(x => x[0] >= t - D1) || [t, eq])[1];
  const lg24 = LOGS.filter(e => e.t >= t - D1), c = k => lg24.filter(e => e.type === k).length;
  const pnl = lg24.filter(e => e.pnl && e.type !== 'open').reduce((a, e) => a + e.pnl, 0);
  const anom = ['pause', 'skip', 'halt', 'error'].map(k => c(k) ? `${TYPE[k]} ${c(k)}` : '').filter(Boolean);
  const sts = S.strategies.filter(g => g.enabled).map(g => `${stName(g)}：${g.state === 'paused' ? '暫停（' + g.pauseReason + '）' : g.state === 'trial' ? `試跑（剩 ${trialLeft(g).toFixed(1)} 天）` : '執行中'}${g.pos ? `，${g.pos.side > 0 ? '多' : '空'} ${fmt(g.pos.qty, 6)}` : '，空手'}`);
  const body = [`權益 ${fmt(eq)} USDT（24 小時 ${r2(eq - prev) >= 0 ? '+' : ''}${fmt(r2(eq - prev))}／${prev ? ((eq / prev - 1) * 100).toFixed(2) : 0}%）；起始以來 ${A.start ? ((eq / A.start - 1) * 100).toFixed(2) : 0}%，最大回撤 ${((A.mdd || 0) * 100).toFixed(1)}%`,
    `過去 24 小時：開倉 ${c('open')}、平倉 ${c('close')}、停損 ${c('stop')}、停利 ${c('tp')}，已實現 ${r2(pnl) >= 0 ? '+' : ''}${fmt(r2(pnl))}`,
    `異常：${anom.length ? anom.join('、') : '無'}${A.halt ? '；帳戶煞車中：' + A.halt.reason : ''}`, ...sts].join('\n');
  const title = `📊 HexStack 每日報告（${tpeDay(t).slice(5).replace('-', '/')}${L === 'paper' ? '・模擬盤' : C.testnet ? '・測試網' : ''}）`;
  log('report', { led: L, text: title + '\n' + body });
  await notify(title, body, true);
}

// ───────── 推播後端（Cloudflare Worker）：登記通道網址、心跳、推通知 ─────────
const RELAY = { base: '', at: 0, ok: false, last: 0, err: '', sent: [] };
async function relayBase() {
  if (C.relay) return C.relay.replace(/\/+$/, '');
  if (!RELAY.base || nowS() - RELAY.at > 6 * H1) { RELAY.at = nowS(); try { RELAY.base = (await getJ(RAW + 'push.json')).url || RELAY_DEF; } catch (e) { RELAY.base = RELAY.base || RELAY_DEF; } }
  return RELAY.base;
}
async function relayPost(p, o) {
  if (REPLAY && !C.relay) return null;
  const b = await relayBase(), r = await fetchT(b + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }, 15000);
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;
}
async function heartbeat() {
  const ts = Date.now(), url = PUB.url || '', name = C.hostName.slice(0, 40);
  try { await relayPost('/host', { hostId: C.hostId, url, name, th: kHash(), ts, sig: hmac(kHash(), ['host', C.hostId, ts, url, name].join('\n')) }); RELAY.ok = true; RELAY.last = nowS(); RELAY.err = ''; }
  catch (e) { RELAY.ok = false; RELAY.err = e.message; }
}
async function notify(title, body, force) {
  const t = nowS(); RELAY.sent = RELAY.sent.filter(x => x > t - H1);
  if (!force && RELAY.sent.length >= 30) return;
  RELAY.sent.push(t);
  if (REPLAY && !C.relay) { if (!force) console.log('　　（推播）' + title + '：' + body.split('\n')[0]); return; }
  const ts = Date.now(); title = String(title).slice(0, 120); body = String(body).slice(0, 1500);
  try { await relayPost('/host/notify', { hostId: C.hostId, ts, title, body, sig: hmac(kHash(), ['notify', C.hostId, ts, title, body].join('\n')) }); } catch (e) { RELAY.err = '推播失敗：' + e.message; }
}
const ERRN = {}; function notifyErr(m) { const k = m.slice(0, 40); if (nowS() - (ERRN[k] || 0) < 6 * H1) return; ERRN[k] = nowS(); notify('❗ 執行器錯誤', m); }

// ───────── Cloudflare 快速通道（免帳號）：網址每次重開都會換，所以登記到推播後端 ─────────
const PUB = { url: '', proc: null, fails: 0, backoff: 10, err: '' };
const CFB = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
function which(b) { try { const r = cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', [b], { encoding: 'utf8' }); const p = (r.stdout || '').split(/\r?\n/)[0].trim(); return r.status === 0 && p ? p : null; } catch (e) { return null; } }
function cfAsset() {
  const a = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'amd64';
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
  if (process.platform === 'darwin') return `cloudflared-darwin-${a === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  return `cloudflared-linux-${a}`;   // Linux、Android（Termux）
}
async function cfBin() {
  const local = path.join(DIR, CFB); if (fs.existsSync(local)) return local;
  const w = which('cloudflared'); if (w) return w;
  const a = cfAsset(), url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + a;
  console.log('下載 cloudflared：' + url);
  const r = await fetchT(url, {}, 300000); if (!r.ok) throw new Error('下載 cloudflared 失敗 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer()), tmp = path.join(DIR, a + '.part');
  fs.writeFileSync(tmp, buf);
  if (a.endsWith('.tgz')) { const x = cp.spawnSync('tar', ['-xzf', tmp, '-C', DIR]); fs.unlinkSync(tmp); if (x.status !== 0 || !fs.existsSync(local)) throw new Error('解壓 cloudflared 失敗'); }
  else fs.renameSync(tmp, local);
  try { fs.chmodSync(local, 0o755); } catch (e) {}
  return local;
}
async function startTunnel() {
  if (PUB.proc) return;
  let bin; try { bin = await cfBin(); } catch (e) { PUB.err = e.message; log('error', { text: '對外通道：' + e.message }); setTimeout(startTunnel, 30 * 60000); return; }
  const p = cp.spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${C.port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  PUB.proc = p; PUB.err = '';
  const onData = d => { const m = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/.exec(String(d)); if (m && m[0] !== PUB.url) { PUB.url = m[0]; PUB.backoff = 10; log('info', { text: '對外網址：' + PUB.url }); heartbeat(); } };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', e => { PUB.err = e.message; });
  p.on('exit', code => { PUB.proc = null; PUB.url = ''; log('info', { text: `對外通道結束（${code}），${PUB.backoff} 秒後重開` }); heartbeat(); setTimeout(startTunnel, PUB.backoff * 1000); PUB.backoff = Math.min(300, PUB.backoff * 2); });
}
async function tunnelWatch() {   // 通道網址連不到 3 次就重開
  if (!PUB.proc || !PUB.url) return;
  try { const r = await fetchT(PUB.url + '/ping', {}, 15000); if (r.ok) { PUB.fails = 0; return; } } catch (e) {}
  if (++PUB.fails >= 3) { PUB.fails = 0; try { PUB.proc.kill(); } catch (e) {} }
}

// ───────── HTTP API ─────────
const isLocal = req => { const a = req.socket.remoteAddress || '', h = String(req.headers.host || '').replace(/:\d+$/, '');
  return /^(127\.|::1$|::ffff:127\.)/.test(a) && !req.headers['cf-connecting-ip'] && !req.headers['cf-ray'] && !req.headers['x-forwarded-for'] && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h); };
const authOk = req => { const a = Buffer.from(String(req.headers.authorization || '')), b = Buffer.from('Bearer ' + C.token); return a.length === b.length && crypto.timingSafeEqual(a, b); };
function body(req) { return new Promise((res, rej) => { let n = 0; const ch = []; req.on('data', d => { n += d.length; if (n > 262144) { rej(new Error('內容太大')); req.destroy(); } else ch.push(d); }); req.on('end', () => { try { res(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { rej(new Error('JSON 格式錯誤')); } }); req.on('error', rej); }); }
class HErr extends Error { constructor(st, m) { super(m); this.st = st; } }
const pairLink = () => APP + '#pair=' + Buffer.from(JSON.stringify({ u: PUB.url || '', k: C.token, h: C.hostId, n: C.hostName })).toString('base64url');

async function status() {
  const L = mainL(), A = acct(L), eq = A.eq != null ? A.eq : await LED[L].getEquity().catch(() => 0);
  const positions = [];
  for (const l of LEDS()) try { for (const p of await LED[l].getPositions()) positions.push({ sym: baseOf(p.sym), mkt: mktK(p.sym), side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, upnl: r2(p.upnl), mark: p.mark, led: l }); } catch (e) {}
  const strategies = S.strategies.map(g => { const rv = (() => { try { const r = review(g, 0); return { status: r.status, reasons: r.reasons }; } catch (e) { return { status: 'ok', reasons: [] }; } })();
    const P = px(g.sym), cp_ = canPromote(g);
    return { id: g.id, key: g.key || '', name: stName(g), st: g.st, sym: g.sym, mkt: mktOf(g), p: g.p, alloc: g.alloc, enabled: g.enabled, mode: g.mode, state: g.state, pauseReason: g.pauseReason || '', trialStart: g.trialStart, trialDays: g.trialDays, ledger: g.led || '', trialLeft: r2(trialLeft(g), 2), canPromote: cp_.ok, promoteWhy: cp_.why, led: ledOf(g),
      equity: r2(stratEq(g)), base: r2(g.base || 0), position: g.pos ? { side: g.pos.side, qty: g.pos.qty, entry: g.pos.entry, stop: g.pos.stop || 0, tp: g.pos.tp || 0, upnl: r2(g.pos.side * g.pos.qty * (P - g.pos.entry)) } : null, target: g.tg || null, lastBar: g.lastBar || 0, review: rv };
  });
  const cnt = k => S.strategies.filter(g => g.state === k).length;
  const out = { ver: VER, build: BUILD, hostId: C.hostId, hostName: C.hostName, exchange: C.exchange, testnet: !!C.testnet, liveTested: false, liveReady: liveReady(), liveExs: Object.keys(LIVE_EX), mkts: { paper: Object.keys(MKT), live: LIVE_EX[C.exchange] && LIVE_EX[C.exchange].prototype.spotOk ? Object.keys(MKT) : ['fut'] }, hasPass: !!C.apiPass, allowLive: C.allowLive === true, tradeInTotal: C.tradeInTotal !== false, paperOnly: C.paperOnly === true, funds: fundList(), fundEx: Object.keys(FUND_EX),
    mode: L === 'paper' ? 'paper' : C.testnet ? 'testnet' : 'live', counts: { trial: cnt('trial'), running: cnt('running'), paused: cnt('paused') },
    now: nowS(), lastTick: S.lastTickAt || 0, lastBar: S.lastBar || 0, equity: r2(eq), startEquity: r2(A.start || eq), startT: A.startT || S.startT,
    dayPnl: r2(eq - (A.dayStart || eq)), dayPct: r2(A.dayStart ? (eq / A.dayStart - 1) * 100 : 0), peak: r2(A.peak || eq), mdd: r2((A.mdd || 0) * 100), dd: r2((A.dd || 0) * 100),
    limits: C.limits, limitsOff: C.limOff || {}, catchupPct: C.catchupPct, halted: A.halt || null, strategies, positions, publicUrl: PUB.url || '', relay: { ok: RELAY.ok, last: RELAY.last, err: RELAY.err },
    engine: { ok: ENG.ok, src: ENG.src, ver: ENG.hash, at: ENG.at }, data: Object.fromEntries(Object.keys(MK).map(s => [s, { end: mEnd(s), src: DSRC[s] || 'builtin' }])) };
  out.sims = Object.entries(S.sims).map(([k, x]) => { const A = acct('sim:' + k), eq_ = A.eq != null ? A.eq : x.cash; return { k, led: 'sim:' + k, start: r2(x.start), equity: r2(eq_), dayStart: r2(A.dayStart || eq_), halted: A.halt || null }; });
  { const A = acct('live'); out.live = LED.live ? { equity: r2(A.eq || 0), start: r2(A.start || 0), dayStart: r2(A.dayStart || 0), halted: A.halt || null } : null; }
  if (L === 'live') { const P = acct('paper'); out.paper = { equity: r2(P.eq || 0), startEquity: r2(P.start || 0), mdd: r2((P.mdd || 0) * 100), halted: P.halt || null }; }
  return out;
}
function addStrategies(list) {
  if (!ENG.ok) throw new HErr(503, '引擎還沒載入，請稍候');
  const out = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, 20)) {
    if (!a || !ENG.BEST[a.st]) throw new HErr(400, '不認得的策略：' + (a && a.st));
    const sym = String(a.sym || '').toUpperCase(); if (!isCoin(sym)) throw new HErr(400, '幣種格式不對：' + a.sym);
    const alloc = +a.alloc; if (!(alloc > 0 && alloc <= 1)) throw new HErr(400, '資金比例要在 0～1 之間（例如 0.3）');
    const tot = S.strategies.filter(g => g.enabled && ledOf(g) === 'paper').reduce((x, g) => x + g.alloc, 0) + out.reduce((x, g) => x + g.alloc, 0) + alloc;
    if (tot > 1.0001) throw new HErr(400, `資金比例合計 ${r2(tot * 100, 0)}% 超過 100%`);
    if (a.st === 'cus' && !(a.p && a.p.rules)) throw new HErr(400, '自訂策略要帶規則（p.rules）');
    const L = 'paper', eq = acct(L).eq || S.paper.cash;
    const g = { id: 's' + (S.nextId++), mkt: MKT[a.mkt] != null ? a.mkt : 'fut', key: String(a.key || '').slice(0, 80), name: String(a.name || '').slice(0, 40) || (ENG.NAME[a.st] || a.st) + ' ' + sym, st: a.st, sym, p: cleanP(a.p), alloc, enabled: true, mode: 'paper', state: 'trial', pauseReason: '', trialStart: nowS(), trialDays: Math.max(0, Math.min(60, a.trialDays != null ? +a.trialDays : 7)), start: nowS(), base: alloc * eq, real: 0, fills: [], trades: [], curve: [], skips: [], lastBar: 0 };
    out.push(g);
  }
  for (const g of out) { S.strategies.push(g); lg('info', g, { text: `新增策略，資金比例 ${Math.round(g.alloc * 100)}%，先模擬盤試跑 ${g.trialDays} 天` }); }
  dirty(); return out;
}
async function closeStrat(g, why) { if (g.pos) await execute(ledOf(g), xk(g), [{ g, dq: -posQ(g), kind: 'close', text: why }]); }
async function resumeStrat(g, why) {
  if (g.pauseKind === 'manual') await adopt(ledOf(g), xk(g)).catch(e => log('error', { text: e.message }));
  g.state = g.promoted ? 'running' : 'trial'; g.pauseReason = ''; g.pauseKind = ''; g.skipKey = ''; g.driftFrom = nowS();   // 偏離檢查從恢復時重新算
  lg('resume', g, { text: why || '恢復執行' }); dirty();
}
// ── HexAI：策略顧問（第一版只讀、只建議，不下單、不改風控）──
// 模型走 OpenAI 相容介面（/chat/completions + tools）：預設 Groq 免費的 Qwen3.8-27B；本機 Ollama、Gemini、DeepSeek 也能接，設定在 config.json 的 ai
// Groq 免費額度每分鐘只有 8K token：工具結果、歷史都裁短，遇到 429 照 retry-after 等一下再試
const AI_DEF = { base: 'hexstack', model: 'auto', key: '' };
const aiLocal = b => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(b);
// 雲端（預設）：沒設自己的金鑰、也不是本機模型，就走 HexStack 雲端 AI（推播後端代轉，金鑰在後端，用戶不用填）；用執行器的金鑰簽章
const aiCloud = c => c.base === 'hexstack' || (!c.key && !aiLocal(c.base));
const aiSign = body => { const ts = Date.now(); return { 'x-hs-host': C.hostId, 'x-hs-ts': String(ts), 'x-hs-sig': hmac(kHash(), ['ai', C.hostId, ts, sha256(body)].join('\n')) }; };
const aiCfg = () => Object.assign({}, AI_DEF, C.ai || {});
// 一個資料來源只歸一個專家：行情、新聞只有 Scout 抓；回測只有 Echo 跑；Bridge 只派工、整合。out＝被別的 AI 呼叫時固定的回覆欄位
const AI_ROLES = {
  bridge: { name: 'AI.Bridge', job: '總管：聽懂使用者要什麼，派給對的專家（行情、回測自己不抓；系統狀態可以用 get_system_info 自己查），最後整合成一個答案，每個數字標明是哪位專家給的。問到開倉、下單時，先請 Echo 回測再請 Helm 寫草案（Helm 找 Vault 時 Vault 不能再找 Echo）。使用者要新增策略或調整風控上限時，整合專家意見後自己用 propose_strategy／propose_risk_limits 提出（App 會跳確認框，使用者按確認才會改）', tools: ['ask_agent', 'get_system_info', 'get_portfolio', 'propose_strategy', 'propose_risk_limits'], calls: ['scout', 'echo', 'forge', 'vault', 'helm', 'guide'] },
  scout: { name: 'AI.Scout', job: '市場情報：唯一的行情與新聞來源，說明盤勢、關鍵價位和風險事件。App 裡沒有的消息就用 web_search 上網查、用 read_webpage 讀內文，回答時附上來源網站和日期', tools: ['get_market_data', 'get_news', 'web_search', 'read_webpage'], out: '趨勢、波動、關鍵價位、重大消息、資料時間' },
  echo: { name: 'AI.Echo', job: '回測與復盤：唯一跑回測的人，誠實報告報酬、回撤、交易次數，並說明回測期間是漲是跌。使用者想把某組參數存起來時，用 propose_strategy 提出（App 會跳確認框，使用者按確認才會新增）', tools: ['list_strategies', 'run_backtest', 'get_backtest_records', 'get_my_strategies', 'get_strategy_review', 'propose_strategy'], out: '策略與參數、期間（期間漲跌）、報酬、最大回撤、交易數、爆倉、手續費、可信度提醒' },
  forge: { name: 'AI.Forge', job: '策略研發：根據目標提出 1～3 個策略或參數組合，自己不算績效，每個方案都要請 Echo 回測後才說。使用者想採用某個方案時，用 propose_strategy 提出新增到「我的策略」（新策略，或某個策略底下的新參數組；App 會跳確認框，使用者按確認才會新增，不要說已經加好）', tools: ['ask_agent', 'list_strategies', 'get_my_strategies', 'get_backtest_records', 'propose_strategy'], calls: ['echo', 'scout'], out: '每個候選方案：策略、改了哪些參數、Echo 的回測數字' },
  vault: { name: 'AI.Vault', job: '風控審核兼資產管家：所有建議的最後一道關，看帳戶、持倉、風控上限。使用者問資產、配置、幣本位或各交易所餘額時，用 get_portfolio 查資產總覽（每個帳戶、每個幣、配置比例）（需要時請 Echo 給歷史回撤），給「通過／警告／否決」。使用者想調整風險控管、或討論出新的上限時，用 propose_risk_limits 提出新值：App 會跳確認框，使用者按確認才會改（不要說已經改好）', tools: ['ask_agent', 'get_portfolio', 'get_account_balance', 'get_position', 'get_risk_rules', 'get_system_info', 'get_strategy_review', 'get_trade_log', 'propose_risk_limits'], calls: ['echo'], out: '結論（通過／警告／否決）、理由、建議倉位上限' },
  helm: { name: 'AI.Helm', job: '執行助手：把方案寫成「下單草案」，一定要先請 Vault 審核，絕不自己下單', tools: ['ask_agent', 'get_position', 'get_portfolio', 'list_strategies', 'get_my_strategies', 'get_system_info'], calls: ['vault', 'scout'], out: '下單草案：幣種、方向、數量或資金比例、槓桿、停損，以及 Vault 的結論' },
  guide: { name: 'AI.Guide', job: '客服：回答 HexStack App 怎麼用、遇到問題怎麼排除。只根據下面的 App 說明回答，說明裡沒有的就老實說不確定，請使用者在專案裡回報。不談行情和投資建議，那些請使用者去問 AI.Bridge', tools: ['get_system_info'] }
};
// 誰可以找誰（calls）：Bridge 找任何人；Forge 找 Echo、Scout；Vault 找 Echo；Helm 找 Vault、Scout。最多轉兩層（Bridge → Forge → Echo），不能找回自己或 Bridge
const AI_DEPTH = 2;
// AI.Guide 的 App 說明（改了介面記得一起更新）
const AI_GUIDE = `HexStack 幣策略 App 說明：
- 底部分頁：市場分析、策略分析、查看價格、開始交易、資產總覽、設定（電腦版在上方）。
- 市場分析：每天自動整理的盤勢摘要、重要行事曆和新聞。
- 策略分析：選內建策略和幣種跑回測（含手續費、滑價、資金費率），可以調參數；滿意的參數存成「我的策略」，同一個策略可以有好幾組參數（參數1、參數2…）。
- 查看價格：K 線圖，可以畫量尺、斜線、水平線、方框，點圖形可以刪除。
- 開始交易 › 訊號交易：「我的策略」出現進出場訊號時推播通知，自己決定要不要下單。
- HexAI 可以查系統資訊（版本、資料、交易所、風控）、App「我的策略」、「策略分析」的回測紀錄（存在手機上，從 App 開對話時會帶給 AI）、HexBOT 交易紀錄和策略回顧；查不到時會先問你要不要現在回測。
- 開始交易 › HexBOT：自動交易，由使用者自己電腦上的 HexStack 電腦版下單，手機掃 QR 碼配對後只負責看和控制。上方「模擬盤」開關：開著只跑模擬交易所（預設各 10,000 USDT，可自己改金額、新增或移除），關掉是實盤。首頁點交易所方塊 → 選策略 → 點參數 → ① 選交易方式（永續合約；現貨＝只做多、1 倍；槓桿＝全倉借貸、可做空、最多 3 倍、要付借款利息）② 選方向（做多／做空／雙向）③ 選幣種（打勾的是回測過的幣）→ 開始執行，開關前都會先確認。實盤要先在電腦上按「＋ 新增交易所」設定下單金鑰（Bybit、幣安、OKX、Bitget；OKX、Bitget 要填 Passphrase），可以先用測試網或模擬交易。「風險控管」分頁可以設安全上限（單筆部位、槓桿、日虧損、最大回撤），觸發會全部暫停；「全部停止並平倉」按兩次確認。
- 開始交易 › HexAI：AI 顧問。Bridge 是總管，Scout 看行情新聞（會上網查）、Echo 回測、Forge 想策略、Vault 風控、Helm 寫下單草案、Guide 是客服。AI 只給建議，不會下單；它要新增策略或改風控上限時會跳確認框，按確認才會改。每隻 AI 下面的「給它的資料」可以寫你的規則和偏好。預設用 HexStack 雲端 AI，不用設定金鑰；想用自己的金鑰或本機模型，到電腦版 HexAI 的模型設定改。
- 資產總覽：把各交易所帳戶的資產加總，看報酬率。在資產總覽按「＋ 加入」，用只勾「讀取」的唯讀金鑰加入。
- 設定：客服機器人、外觀（預設、深夜、白天，可以跟著日出日落自動切換）、通知設定、資料庫、資料狀態、語言、帳號同步（Google 登入後手機和電腦的我的策略、通知、外觀、資產紀錄會同步，交易所金鑰不會上傳）、更新到最新版（看不到新版時按這裡）。
- 安全：交易所金鑰只存在使用者自己的電腦上，建金鑰時只開「交易」權限，絕對不要開「提幣」，建議用子帳戶。真金下單一律由使用者自己操作。
- 常見問題：手機看不到新版 → 設定 › 更新到最新版；HexBOT 顯示離線 → 確認電腦上的 HexStack 有開著、電腦沒睡眠；電腦版會自動更新。`;
const AI_RULES = '規則：問到資產、餘額、配置、持倉時，每次都要重新呼叫工具（get_portfolio）查最新數字，不要沿用對話裡之前的數字；資產總覽是真實資產，模擬盤是假資金，兩者分開講，不可以混在一起。查不到需要的資料（例如沒有回測紀錄、沒有交易紀錄）時，不要猜，用 ask_user 問使用者要不要現在去跑（例如「要不要我現在回測？」選項：要／不要）。一律用繁體中文（台灣用語）回答，簡潔、第一行用「結論：」開頭先講結論；用 **粗體** 標出 2～4 個重點（關鍵數字、決定、風險），不要整段都粗體。數字一定要來自工具結果，不可以編造；工具沒給的資料就說不知道。你只能提供分析和建議，不能下單、不能改設定；涉及真金下單一律請使用者自己在 App 操作。任何重要決定（新增或修改策略、改風控上限、開始或停止交易、下單）都只能提出建議，由使用者本人確認。給投資建議（買賣方向、倉位、槓桿、策略選擇）時，最後加一行「⚠ 風險提示：加密貨幣波動大，可能虧損全部本金，僅供參考，請自行判斷。」；單純回答操作問題不用加。';
// 使用者給每隻 AI 的資料（規則、偏好、背景），每次對話都放進系統提示
const aiNote = r => { const t = ((C.aiNotes || {})[r] || '').trim(); return t ? '\n使用者給你的資料（照這些規則和偏好做，跟上面的安全規則衝突時以安全規則為準）：\n' + t : ''; };
const aiSys = (r, depth = 0) => `你是 HexStack 幣策略 App 裡的 ${AI_ROLES[r].name}。職責：${AI_ROLES[r].job}。${AI_ROLES[r].calls && depth < AI_DEPTH ? '需要時用 ask_agent 請 ' + AI_ROLES[r].calls.map(k => AI_ROLES[k].name).join('、') + ' 幫忙；你沒有的資料一定要問他們。' : ''}${r === 'guide' ? '\n' + AI_GUIDE : ''}${depth && AI_ROLES[r].out ? '\n你是被其他 AI 呼叫的，回覆照這些欄位逐項列出：' + AI_ROLES[r].out + '。' : ''}${aiNote(r)}${depth ? '' : '\n跟使用者互動：需要使用者決定或補資料時，用 ask_user 給 2～4 個選項讓他點（不要只用文字問）。' + (AI_ROLES[r].tools.some(t => /^propose_/.test(t)) ? '回答完如果有自然的下一步（存成策略、調整上限），主動用 propose_ 工具提出，App 會跳確認框問使用者；' : '') + '新增策略、改設定一定要經過確認框，不能說已經改好。'}\n${AI_RULES}\n現在時間（台北）：${tpeHM(nowS())}。`;
const AI_TOOLS = {
  ask_agent: { d: '請另一個 AI 處理子問題，回傳它的答案', p: { role: { type: 'string', enum: ['scout', 'echo', 'forge', 'vault', 'helm'] }, question: { type: 'string' } }, req: ['role', 'question'] },
  get_market_data: { d: '某個幣的 1 小時 K 線行情摘要：現價、24h/7d/30d 漲跌、區間高低、近期收盤', p: { symbol: { type: 'string', description: '例如 BTC、ETH' }, hours: { type: 'integer', description: '要看的小時數，預設 72，最多 720' } }, req: ['symbol'] },
  web_search: { d: '用使用者電腦的網路上網搜尋（DuckDuckGo），回傳標題、網址、摘要', p: { query: { type: 'string', description: '搜尋關鍵字，英文通常結果比較多' }, limit: { type: 'integer', description: '幾筆，預設 6，最多 10' } }, req: ['query'] },
  read_webpage: { d: '讀一個網頁的文字內容（web_search 找到的網址）', p: { url: { type: 'string' } }, req: ['url'] },
  get_news: { d: 'HexStack 市場分析頁的最新盤勢摘要、行事曆和新聞標題', p: { limit: { type: 'integer', description: '新聞則數，預設 5' } } },
  get_account_balance: { d: 'HexBOT 的模擬盤（假資金）權益和實盤下單帳戶狀態。不是使用者的真實資產，真實資產用 get_portfolio', p: {} },
  get_position: { d: 'HexBOT 自動交易的持倉和執行中的策略（只有 HexBOT 開的倉）。使用者在交易所自己開的倉、真實資產，用 get_portfolio', p: {} },
  get_system_info: { d: 'HexStack 系統資訊：電腦版和 App 版本、引擎、各幣資料到哪一天、下單交易所（測試網／正式網、模擬盤開關）、模擬帳戶、AI 模型、風控上限與哪些關掉了、策略數量', p: {} },
  get_my_strategies: { d: '使用者 App「我的策略」裡存的策略和參數組（名稱、策略代號、幣種、參數），以及哪些正在 HexBOT 執行', p: {} },
  get_backtest_records: { d: '使用者在 App「策略分析」跑過的回測紀錄（最新在前）：策略、幣種、期間、報酬、最大回撤、勝率、交易次數、參數。沒有紀錄時回傳空清單', p: { strategy: { type: 'string', description: '只看這個策略代號，可不給' }, symbol: { type: 'string', description: '只看這個幣，可不給' }, limit: { type: 'integer', description: '幾筆，預設 10，最多 40' } } },
  get_portfolio: { d: '資產總覽的完整內容：每個交易所帳戶（電腦和手機存的都有）的總資產、各幣種數量與美元價值、所在帳戶（現貨／U 本位／幣本位合約／資金帳戶等）、資產配置比例、合約持倉', p: {} },
  get_trade_log: { d: 'HexBOT 最近的交易與事件紀錄（開倉、平倉、停損、停利、暫停、錯誤）', p: { limit: { type: 'integer', description: '幾筆，預設 20，最多 80' }, symbol: { type: 'string', description: '只看這個幣，可不給' } } },
  get_strategy_review: { d: 'HexBOT 執行中策略的實際績效對回測（報酬、交易次數、勝率、回撤、滑價），和是否偏離回測', p: { days: { type: 'integer', description: '看最近幾天，0＝從開始執行算，預設 0' } } },
  get_risk_rules: { d: '目前的風控上限（單筆部位、槓桿、日虧損、最大回撤）和是否觸發停機', p: {} },
  ask_user: { d: '問使用者一個問題，給 2～4 個選項讓他點（他也可以自己打字）。呼叫後這一輪就結束，等使用者回答', p: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: '2～4 個簡短選項，每個 20 字內' } }, req: ['question', 'options'] },
  propose_strategy: { d: '提出新增到使用者的「我的策略」：新策略，或加在既有策略底下的一組參數。不會直接生效：App 會跳確認框給使用者，按確認才新增', p: { strategy: { type: 'string', description: 'list_strategies 給的代號' }, symbol: { type: 'string', description: '例如 BTC' }, params: { type: 'object', description: '跟預設不同的參數，沒給就用預設' }, name: { type: 'string', description: '策略名字（新策略用）或參數組名字，簡短' }, group: { type: 'string', description: '要加在哪個既有策略底下（使用者說的策略名字）；新策略就不給' }, reason: { type: 'string', description: '一句話：為什麼建議這組（附回測報酬、回撤）' } }, req: ['strategy', 'symbol'] },
  propose_risk_limits: { d: '提出新的風險控管上限（只給要改的欄位）。不會直接生效：App 會跳確認框給使用者，按確認才改', p: { maxPosPct: { type: 'number', description: '單一策略最大倉位，% 帳戶，1～1000' }, maxLev: { type: 'number', description: '最大槓桿（倍），0.1～20' }, dayLossPct: { type: 'number', description: '每日最大虧損 %，到了全部暫停，0.1～100' }, maxDDPct: { type: 'number', description: '總回撤上限 %，到了全部平倉，0.1～100' }, reason: { type: 'string', description: '一句話說明為什麼這樣改' } } },
  list_strategies: { d: 'App 內建的策略清單（代號、名稱）；給 strategy 代號時改回傳那個策略在指定幣種的預設參數', p: { strategy: { type: 'string', description: '要看預設參數的策略代號，不給就只列清單' }, symbol: { type: 'string', description: '預設 BTC' } } },
  run_backtest: { d: '用 HexStack 回測引擎（含手續費、滑價、資金費率）回測一個策略', p: { strategy: { type: 'string', description: 'list_strategies 給的代號' }, symbol: { type: 'string' }, days: { type: 'integer', description: '回測天數，預設 365，最多 1000' }, params: { type: 'object', description: '要覆蓋的參數，沒給就用預設' } }, req: ['strategy', 'symbol'] }
};
const symOk = s => { s = String(s || 'BTC').toUpperCase().replace(/USDT$/, ''); if (!MK[s]) throw new Error('沒有 ' + s + ' 的資料，可用：' + Object.keys(MK).join('、')); return s; };
let NEWS_C = { at: 0, d: null };
// 上網：用使用者自己電腦的網路，不用金鑰。只讀公開網頁，擋掉本機和區網位址
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8' };
const deH = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function pubUrl(u) { let x; try { x = new URL(String(u || '')); } catch (e) { throw new Error('網址不對'); } if (!/^https?:$/.test(x.protocol)) throw new Error('只能讀 http/https 網頁'); const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || /^f[cd]|^fe80/.test(h) || /^\d+$/.test(h)) throw new Error('不能讀本機或區網的網址'); return x.href; }
async function webSearch(q, n) {
  const one = async u => { const r = await fetchT(u, { headers: UA }, 15000), h = await r.text(), out = [];
    let m; for (const ch of h.split('class="result__a"').slice(1)) { if (out.length >= n) break; m = ch.match(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/); if (!m) continue; m[3] = (ch.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || [])[1]; let url = m[1].replace(/&amp;/g, '&'); const g = url.match(/[?&]uddg=([^&]+)/); if (g) url = decodeURIComponent(g[1]); if (url.startsWith('//')) url = 'https:' + url; if (/duckduckgo\.com\/y\.js/.test(url)) continue; out.push({ title: deH(m[2]), url, snippet: deH(m[3]).slice(0, 240) }); }
    if (!out.length) { const re2 = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>/g; while ((m = re2.exec(h)) && out.length < n) { let url = m[1].replace(/&amp;/g, '&'); const g = url.match(/[?&]uddg=([^&]+)/); if (g) url = decodeURIComponent(g[1]); if (url.startsWith('//')) url = 'https:' + url; out.push({ title: deH(m[2]), url, snippet: deH(m[3]).slice(0, 240) }); } }
    return out; };
  let r = await one('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q)).catch(() => []);
  if (!r.length) r = await one('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q)).catch(() => []);
  if (!r.length) throw new Error('搜尋沒有結果（可能是網路或搜尋網站暫時擋住），換個關鍵字再試');
  return r;
}
async function readPage(u) { const url = pubUrl(u), r = await fetchT(url, { headers: UA, redirect: 'follow' }, 20000); if (!r.ok) throw new Error('HTTP ' + r.status); pubUrl(r.url || url);
  const ct = r.headers.get('content-type') || ''; if (!/text|html|json|xml/.test(ct)) throw new Error('不是網頁（' + ct + '）');
  let h = (await r.text()).slice(0, 1500000); const title = deH((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]).slice(0, 160);
  h = h.replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|li|h[1-6]|tr|br|article|section)>/gi, '\n');
  const text = h.split('\n').map(deH).filter(l => l.length > 30).join('\n');
  return { url: r.url || url, title, text: text.slice(0, 2000), truncated: text.length > 2000 }; }
async function aiTool(name, a, depth, trace, from) {
  a = a && typeof a === 'object' ? a : {};
  if (name === 'ask_agent') { if (depth >= AI_DEPTH || !((AI_ROLES[from] || {}).calls || []).includes(a.role)) throw new Error('不能轉給 ' + (a.role || '') + '，請自己用工具處理'); return { role: a.role, answer: (await aiRun(a.role, [{ role: 'user', content: String(a.question || '').slice(0, 2000) }], depth + 1, trace)).text }; }
  if (name === 'get_market_data') {
    const s = symOk(a.symbol), m = MK[s], n = m.n, h = Math.max(6, Math.min(720, +a.hours || 72)), c = m.C[n - 1], at = k => m.C[Math.max(0, n - 1 - k)];
    const lo = Math.min(...m.L.slice(n - h, n)), hi = Math.max(...m.H.slice(n - h, n)), st = Math.max(1, Math.round(h / 24));
    const closes = []; for (let i = n - h; i < n; i += Math.max(st, Math.ceil(h / 24))) closes.push(+fpx(m.C[i]).replace(/,/g, ''));
    return { symbol: s, price: px(s) || c, lastBarTaipei: tpeHM(mEnd(s) - H1), chg24h: r2((c / at(24) - 1) * 100), chg7d: r2((c / at(168) - 1) * 100), chg30d: r2((c / at(720) - 1) * 100), [`high${h}h`]: hi, [`low${h}h`]: lo, closesEvery: Math.max(st, Math.ceil(h / 24)) + 'h', closes };
  }
  if (name === 'web_search') return { query: String(a.query || ''), results: await webSearch(String(a.query || '').slice(0, 200), Math.max(1, Math.min(10, +a.limit || 6))) };
  if (name === 'read_webpage') return await readPage(a.url);
  if (name === 'get_news') {
    if (!NEWS_C.d || nowS() - NEWS_C.at > 600) { NEWS_C = { at: nowS(), d: await getJ(SITE + 'news.json?t=' + nowS(), {}, 20000) }; }
    const d = NEWS_C.d, m = d.market || {};
    return { updated: m.updated, title: m.title, bias: m.bias, summary: String(m.body || '').slice(0, 900), calendar: (m.calendar || []).slice(0, 5), news: (d.news || []).slice(0, Math.max(1, Math.min(10, +a.limit || 5))).map(x => ({ time: x.ts, title: x.title, summary: String(x.summary || '').slice(0, 100), impact: x.impact })) };
  }
  if (name === 'get_portfolio') {
    const pc = await fundsAll(false).catch(e => ({ accounts: [], err: e.message })), ph = (APPCTX.funds || []).map(a => Object.assign({ where: '手機' }, a));
    const acc = pc.accounts.map(a => Object.assign({ where: '電腦' }, a)).concat(ph), tot = acc.reduce((t, a) => t + (a.total_usd || 0), 0), by = {};
    for (const a of acc) for (const x of a.assets || []) { const k = String(x.coin).replace(/（.*/, ''), o = by[k] || (by[k] = { coin: k, amount: 0, usd: 0, where: new Set() }); o.amount += +x.amount || 0; o.usd += +x.usd || 0; o.where.add(a.name + (x.acct ? '・' + x.acct : '')); }
    const pct = v => tot > 0 ? r2(v / tot * 100) : null;
    if (!acc.length) return { accounts: [], note: '資產總覽還沒有加入任何交易所帳戶（或 App 還沒回報手機上的帳戶）。可以請使用者到「資產總覽」加入唯讀金鑰' + (pc.err ? '；電腦讀取錯誤：' + pc.err : '') };
    // 順序：總額 → 各交易所比例 → 配置 → 全部持倉 → 各帳號；帳號多時後面可能被截掉，重要的放前面
    const exs = {}; for (const a of acc) exs[a.exchange] = (exs[a.exchange] || 0) + (a.total_usd || 0);
    const pos = []; for (const a of acc) for (const p of a.positions || []) pos.push({ account: a.name, exchange: a.exchange, symbol: p.symbol, side: p.side, contracts: p.contracts, entry: p.entry, mark: p.mark, liq: p.liq, leverage: p.leverage, upnlUsd: p.upnl != null ? r2(p.upnl) : null, coinMargined: !!p.coinM || undefined });
    return { note: '這是使用者真實交易所的資產（不是模擬盤），剛剛即時讀取', totalUsd: r2(tot), unrealizedPnlUsd: r2(pos.reduce((t, p) => t + (p.upnlUsd || 0), 0)), accountCount: acc.length, phoneDataAt: ph.length && APPCTX.fundsAt ? tpeHM(APPCTX.fundsAt) : null,
      byExchange: Object.entries(exs).sort((p, q) => q[1] - p[1]).map(([k, v]) => ({ exchange: k, usd: r2(v), pct: pct(v) })),
      allocation: Object.values(by).filter(o => o.usd > 0.5).sort((p, q) => q.usd - p.usd).slice(0, 15).map(o => ({ coin: o.coin, amount: +o.amount.toPrecision(8), usd: r2(o.usd), pct: pct(o.usd) })),
      positions: pos.slice(0, 40),
      accounts: acc.map(a => ({ name: a.name, exchange: a.exchange, storedOn: a.where, ok: a.ok !== false, totalUsd: r2(a.total_usd || 0), pct: pct(a.total_usd || 0), positions: (a.positions || []).length, topAssets: (a.assets || []).filter(x => (+x.usd || 0) > 0.5).sort((p, q) => (q.usd || 0) - (p.usd || 0)).slice(0, 6).map(x => ({ coin: x.coin, usd: r2(x.usd || 0), account: x.acct })), notes: (a.notes || []).slice(0, 2) })) };
  }
  if (name === 'get_account_balance') {
    const s = await status();
    return { note: '這裡只有 HexBOT 的模擬盤（假資金）和實盤下單帳戶。使用者在資產總覽掛的真實交易所資產、配置，一律用 get_portfolio 查，不要把這裡的數字當成真實資產', paperSimsFakeMoney: s.sims.map(x => ({ exchange: x.k, start: x.start, equity: x.equity })), live: s.live, paperOnly: s.paperOnly };
  }
  if (name === 'get_position') { const s = await status(); return { positions: s.positions, strategies: s.strategies.filter(g => g.enabled).map(g => ({ name: g.name, strategy: g.st, symbol: g.sym, ledger: g.led, state: g.state, alloc: g.alloc, equity: g.equity, position: g.position })) }; }
  if (name === 'get_risk_rules') { const s = await status(); return { limits: s.limits, off: Object.keys(s.limitsOff || {}), halted: s.halted, mdd: s.mdd, dd: s.dd, paperOnly: s.paperOnly }; }
  if (name === 'propose_strategy') { const st = String(a.strategy || ''), sy = symOk(a.symbol), B = ENG.BEST[st]; if (!B) throw new Error('沒有策略 ' + st + '，先用 list_strategies 查代號'); if (!B[sy]) throw new Error((ENG.NAME[st] || st) + ' 沒有 ' + sy + ' 的版本，可用：' + Object.keys(B).join('、'));
    const d = B[sy], ch = {}, cp = cleanP(a.params); for (const k in cp) if (k in d) ch[k] = cp[k];
    return { proposed: { strategy: st, stName: ENG.NAME[st] || st, symbol: sy, params: ch, name: String(a.name || '').slice(0, 30), group: String(a.group || '').slice(0, 40) }, reason: String(a.reason || '').slice(0, 200), note: '已跳確認框給使用者，按確認才會新增' }; }
  if (name === 'propose_risk_limits') { const o = {}; for (const k in LIMR) if (a[k] != null && a[k] !== '') { const v = +a[k]; if (!(v >= LIMR[k][0] && v <= LIMR[k][1])) throw new Error(`${k} 要在 ${LIMR[k][0]}～${LIMR[k][1]} 之間`); o[k] = v; } if (!Object.keys(o).length) throw new Error('至少要給一個要改的上限'); return { proposed: o, current: C.limits, reason: String(a.reason || '').slice(0, 200), note: '已跳確認框給使用者，按確認才會生效' }; }
  if (name === 'list_strategies') { const s = symOk(a.symbol), B = ENG.BEST[a.strategy]; if (B) return { strategy: a.strategy, name: ENG.NAME[a.strategy] || a.strategy, symbol: s, defaultParams: cleanP(B[s] || B.BTC || {}) }; return { strategies: Object.keys(ENG.BEST).map(k => ({ code: k, name: ENG.NAME[k] || k })) }; }
  if (name === 'get_system_info') { const s = await status(), A = APPCTX.app || {};
    return { hexstack: s.ver + ' build ' + BUILD, app: A.ver || '不知道（App 還沒回報）', engine: s.engine, data: s.data, exchange: s.exchange, testnet: s.testnet, liveReady: s.liveReady, allowLive: s.allowLive, paperOnly: s.paperOnly, mode: s.mode, sims: s.sims, live: s.live, ai: (() => { const c = aiCfg(); return { cloud: aiCloud(c), model: c.model }; })(), limits: s.limits, limitsOff: Object.keys(s.limitsOff || {}), halted: s.halted, counts: s.counts, strategiesRunning: s.strategies.filter(g => g.enabled).length, myStrategies: (APPCTX.mine || []).length, backtestRecords: (APPCTX.runs || []).length, appContextAt: APPCTX.at ? tpeHM(APPCTX.at) : null }; }
  if (name === 'get_my_strategies') { const on = S.strategies.filter(g => g.enabled); const mine = APPCTX.mine || [];
    return { count: mine.length, strategies: mine.map(m => Object.assign({}, m, { running: on.filter(g => String(g.key || '').split('@')[0] === m.key).map(g => ({ symbol: g.sym, market: MKT_NAME[mktOf(g)], ledger: g.led, state: g.state })) })), note: mine.length ? undefined : 'App 的「我的策略」是空的，或 App 還沒回報（要從 App 開對話才會帶上）' }; }
  if (name === 'get_backtest_records') { let L = APPCTX.runs || []; if (a.strategy) L = L.filter(x => x.strategy === a.strategy); if (a.symbol) L = L.filter(x => x.symbol === String(a.symbol).toUpperCase().replace(/USDT$/, ''));
    const n = Math.max(1, Math.min(40, +a.limit || 10)); return L.length ? { total: L.length, records: L.slice(0, n) } : { total: 0, records: [], note: '沒有符合的回測紀錄。先用 ask_user 問使用者要不要現在用 run_backtest 回測（給選項：要／不要），不要自己編數字' }; }
  if (name === 'get_trade_log') { const n = Math.max(1, Math.min(80, +a.limit || 20)), sy = a.symbol ? String(a.symbol).toUpperCase() : '';
    const L = LOGS.filter(e => e.type !== 'report' && (!sy || e.sym === sy)).slice(-n).reverse().map(e => ({ time: tpeHM(e.t), type: TYPE[e.type] || e.type, name: e.name, symbol: e.sym, side: e.side, price: e.px, qty: e.qty, pnl: e.pnl, text: e.text }));
    return L.length ? { records: L } : { records: [], note: 'HexBOT 還沒有交易紀錄' }; }
  if (name === 'get_strategy_review') { const d = Math.max(0, Math.min(365, +a.days || 0)), out = [];
    for (const g of S.strategies.filter(g => g.enabled)) { try { const r = review(g, d); out.push({ name: r.name, symbol: r.sym, market: MKT_NAME[mktOf(g)], real: Object.assign({}, r.real, { curve: undefined }), backtest: Object.assign({}, r.bt, { curve: undefined }), status: r.status === 'drift' ? '偏離回測' : '正常', reasons: r.reasons }); } catch (e) {} }
    return out.length ? { strategies: out } : { strategies: [], note: 'HexBOT 目前沒有執行中的策略' }; }
  if (name === 'run_backtest') {
    const st = String(a.strategy || ''), s = symOk(a.symbol); if (!ENG.BEST[st]) throw new Error('沒有策略 ' + st + '，先用 list_strategies 查代號');
    const days = Math.max(30, Math.min(1000, +a.days || 365)), T = mEnd(s), B = ENG.BEST[st];
    const p = Object.assign({}, B[s] || B.BTC || {}, cleanP(a.params), { capital: 1000 });
    const { r } = runSim(st, s, T - days * D1, T, p), tr = Array.isArray(r.trades) ? r.trades.length : +r.trades || 0, m = MK[s], c0 = m.C[Math.max(0, m.n - 1 - days * 24)];
    return { strategy: st, name: ENG.NAME[st] || st, symbol: s, days, marketChgPct: r2((m.C[m.n - 1] / c0 - 1) * 100), returnPct: r2((r.mult - 1) * 100), maxDrawdownPct: r2(Math.abs(r.mdd || 0) * (Math.abs(r.mdd || 0) <= 1 ? 100 : 1)), trades: tr, liquidated: !!r.liq, feesUsd: r2(r.fees || 0), fundingUsd: r2(r.fund || 0), changedParams: cleanP(a.params) };
  }
  throw new Error('沒有這個工具：' + name);
}
async function aiCall(msgs, tools, role) {
  const c = aiCfg(), cl = aiCloud(c), h = { 'content-type': 'application/json' }; if (c.key && !cl) h.authorization = 'Bearer ' + c.key;
  const url = cl ? (await relayBase()) + '/ai/chat/completions' : c.base.replace(/\/+$/, '') + '/chat/completions', where = cl ? 'HexStack 雲端 AI' : c.base;
  const b = { model: c.model, messages: msgs, temperature: 0.3, stream: false }; if (tools.length) b.tools = tools.map(n => ({ type: 'function', function: { name: n, description: AI_TOOLS[n].d, parameters: { type: 'object', properties: n === 'ask_agent' ? Object.assign({}, AI_TOOLS[n].p, { role: { type: 'string', enum: AI_ROLES[role].calls } }) : AI_TOOLS[n].p, required: AI_TOOLS[n].req || [] } } }));
  let r, t, j = null;
  for (let k = 0; ; k++) {
    const bs = JSON.stringify(b);
    try { r = await fetchT(url, { method: 'POST', headers: cl ? Object.assign({}, h, aiSign(bs)) : h, body: bs }, 300000); }
    catch (e) { throw new Error('連不到模型（' + where + '）：' + (e.name === 'AbortError' ? '逾時' : e.message) + (aiLocal(c.base) ? '。本機模型請先開 Ollama' : '')); }
    t = await r.text(); j = null; try { j = JSON.parse(t); } catch (e) {}
    if (![429, 503].includes(r.status) || k >= 4 || cl && (r.status === 503 || /今天/.test(t))) break;
    // 免費額度每分鐘用完：照伺服器說的秒數等（最多 60 秒）再試
    const m = /try again in ([\d.]+)(m?s)/i.exec(t), w = +r.headers.get('retry-after') || (m ? +m[1] / (m[2] === 'ms' ? 1000 : 1) : 10);
    await sleep(Math.min(60, Math.max(1, w)) * 1000 + 300);
  }
  if (cl && [403, 503].includes(r.status) || cl && r.status === 429 && /今天/.test(t)) throw new Error((j && j.error) === '執行器驗證失敗' ? '雲端 AI 還認不得這台電腦：執行器剛啟動要先登記，等一分鐘再問' : String(j && j.error || 'HTTP ' + r.status) + (r.status === 503 ? '。也可以在模型設定改用自己的金鑰或本機模型' : ''));
  if (r.status === 429) throw new Error('免費額度暫時用完了（每分鐘或每天的上限），請稍後再問');
  if (!r.ok) throw new Error('模型回應錯誤 HTTP ' + r.status + '：' + String(j && j.error && (j.error.message || j.error) || t).slice(0, 200));
  const m = j && j.choices && j.choices[0] && j.choices[0].message; if (!m) throw new Error('模型沒有回答');
  return m;
}
// 資產總覽的內容比較長，截太短 AI 會以為沒有資產
const clip = (o, n) => { const s = JSON.stringify(o); n = n || 2500; return s.length > n ? s.slice(0, n) + '…' : s; };
async function aiRun(role, hist, depth = 0, trace = []) {
  const R = AI_ROLES[role], msgs = [{ role: 'system', content: aiSys(role, depth) }, ...hist];
  let nag = role === 'helm' && depth < AI_DEPTH;   // Helm 給下單草案前一定要問過 Vault
  // 模型常常只用文字說「建議改成…」卻不呼叫 propose_，App 就不會跳確認框：使用者在談新增策略、改風控時，回答完再要求它用 propose_ 工具提出一次
  const PT = depth ? [] : R.tools.filter(n => /^propose_/.test(n)), want = PT.length && /存|新增|加入|建立|改|調整|設定|套用|上限|風控|槓桿|策略|參數/.test(String((hist.filter(x => x.role === 'user').pop() || {}).content || ''));
  let ask = !!want, only = false, keep = '';
  // 問到資產、持倉：不等模型自己決定，先把資產總覽的最新內容放進對話（模型常沿用舊答案或用錯工具）
  const lastU = String((hist.filter(x => x.role === 'user').pop() || {}).content || '');
  if (!depth && R.tools.includes('get_portfolio') && /資產|配置|持倉|倉位|艙位|部位|餘額|幣本位|總額|資金|多少錢|賺|賠|虧/.test(lastU)) {
    try { const pf = await aiTool('get_portfolio', {}, depth, trace, role); trace.push({ by: R.name, tool: 'get_portfolio', args: {}, ok: true });
      const L = msgs[msgs.length - 1]; if (L && L.role === 'user') L.content = String(L.content) + '\n\n（以下是系統附上的資料，不是使用者打的）系統剛剛即時查到的使用者真實資產（資產總覽，' + tpeHM(nowS()) + '）。回答資產、配置、持倉一律以這份為準，忽略對話裡之前的數字；模擬盤是另外的假資金，不要混進來：\n' + clip(pf, 12000); } catch (e) {}
  }
  for (let i = 0; i < 8; i++) {
    const T = only ? PT : [...R.tools.filter(n => n !== 'ask_agent' || depth < AI_DEPTH), ...(depth ? [] : ['ask_user'])], m = await aiCall(msgs, i < 7 ? T : [], role), calls = m.tool_calls || [];
    if (!calls.length && nag && i < 6 && /做多|做空|開倉|下單|槓桿|停損|草案/.test(m.content || '') && !trace.some(x => x.by === R.name && x.tool === 'ask_agent' && x.args && x.args.role === 'vault')) { nag = false; msgs.push({ role: 'assistant', content: m.content || '' }, { role: 'user', content: '（系統）給下單草案前一定要先用 ask_agent 請 vault 審核，把 Vault 的結論附在草案裡。' }); continue; }
    const clean = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!calls.length && ask && i < 7 && !trace.some(x => /^propose_/.test(x.tool) && x.ok)) { ask = false; only = true; keep = clean(m.content); msgs.push({ role: 'assistant', content: m.content || '' }, { role: 'user', content: '（系統）如果你上面的回答有具體要新增的策略或要調整的風控上限，現在就用 propose_ 工具提出（App 會跳確認框給使用者確認）；沒有具體可以提出的，只回「無」。' }); continue; }
    if (!calls.length) return { text: (only && keep ? keep : clean(m.content)) || '（模型沒有回答內容）', trace };
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
    for (const tc of calls) {
      const fn = tc.function || {}, nm = fn.name; let args = fn.arguments; try { args = typeof args === 'string' ? JSON.parse(args || '{}') : args || {}; } catch (e) { args = {}; }
      if (nm === 'ask_user' && !depth) { const q = String(args.question || '').slice(0, 300), o = (Array.isArray(args.options) ? args.options : []).map(x => String(x).slice(0, 40)).filter(Boolean).slice(0, 4); trace.push({ by: R.name, tool: nm, args: { question: q }, ok: true }); return { text: [String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), q].filter(Boolean).join('\n\n') || q, choices: o, trace }; }
      const step = { by: R.name, tool: nm, args, ok: true }; trace.push(step);
      let out; try { if (!R.tools.includes(nm) || nm === 'ask_user') throw new Error(R.name + ' 不能用 ' + nm); out = await aiTool(nm, args, depth, trace, role); } catch (e) { out = { error: e.message }; step.ok = false; step.err = e.message; }
      if (/^propose_/.test(nm) && step.ok) step.res = { kind: nm === 'propose_strategy' ? 'strat' : 'lim', by: R.name, proposed: out.proposed, reason: out.reason };
      msgs.push({ role: 'tool', tool_call_id: tc.id || nm, name: nm, content: clip(out, nm === 'get_portfolio' ? 12000 : 0) });
    }
  }
  return { text: '（查了太多次還沒結論，請把問題問得更具體一點）', trace };
}
// 對話存在 hexbot-data/ai.json：每個角色一串，最多留 40 則；工作是非同步的（本機模型可能要一兩分鐘，通道會逾時），App 輪詢 /api/ai/job
const F_AI = path.join(DIR, 'ai.json'), AIH = readJ(F_AI, {}), AIJ = {};
// App 開對話時順便帶上「我的策略」和回測紀錄（存在手機上），AI 才查得到；存檔，電腦版重開也還在
const F_CTX = path.join(DIR, 'appctx.json'); let APPCTX = readJ(F_CTX, {});
function setCtx(c) {
  if (!c || typeof c !== 'object') return; const j = JSON.stringify(c); if (j.length > 120000) return;
  const str = (v, n) => String(v == null ? '' : v).slice(0, n), num = v => isFinite(+v) ? +v : null;
  APPCTX = { at: nowS(), app: { ver: str(c.app && c.app.ver, 20) },
    mine: (Array.isArray(c.mine) ? c.mine : []).slice(0, 60).map(m => ({ key: str(m.key, 80), group: str(m.group, 40), set: str(m.set, 40), strategy: str(m.strategy, 20), name: str(m.name, 40), symbol: str(m.symbol, 12), params: cleanP(m.params) })),
    runs: (Array.isArray(c.runs) ? c.runs : []).slice(0, 60).map(x => ({ at: str(x.at, 20), strategy: str(x.strategy, 20), name: str(x.name, 40), symbol: str(x.symbol, 12), period: str(x.period, 40), capital: num(x.capital), returnPct: num(x.returnPct), maxDrawdownPct: num(x.maxDrawdownPct), winRate: str(x.winRate, 12), trades: num(x.trades), liquidated: !!x.liquidated, starred: !!x.starred, changedParams: Array.isArray(x.changedParams) ? x.changedParams.slice(0, 20).map(y => str(y, 60)) : [] })),
    // 只存在手機的交易所帳戶（電腦讀不到），App 讀到的餘額跟著對話送來
    funds: (Array.isArray(c.funds) ? c.funds : []).slice(0, 20).map(a => ({ name: str(a.name, 40), exchange: str(a.exchange, 12), ok: !!a.ok, total_usd: num(a.total_usd), assets: (Array.isArray(a.assets) ? a.assets : []).slice(0, 80).map(x => ({ coin: str(x.coin, 16), amount: num(x.amount), usd: num(x.usd), acct: str(x.acct, 30) })), positions: (Array.isArray(a.positions) ? a.positions : []).slice(0, 40).map(p => ({ symbol: str(p.symbol, 24), side: str(p.side, 6), contracts: num(p.contracts), entry: num(p.entry), mark: num(p.mark), liq: num(p.liq), leverage: num(p.leverage), upnl: num(p.upnl), coinM: !!p.coinM })), notes: (Array.isArray(a.notes) ? a.notes : []).slice(0, 5).map(y => str(y, 120)) })), fundsAt: num(c.fundsAt) };
  try { writeJ(F_CTX, APPCTX); } catch (e) {}
}
async function aiStart(role, text) {
  if (!AI_ROLES[role]) throw new HErr(400, '沒有這個 AI');
  text = String(text || '').trim().slice(0, 4000); if (!text) throw new HErr(400, '請輸入問題');
  if (Object.values(AIJ).some(j => !j.done)) throw new HErr(409, '上一個問題還在處理');
  const h = AIH[role] || (AIH[role] = []), id = rnd(6), job = AIJ[id] = { id, role, done: false, trace: [], text: '', error: '', t: nowS() };
  h.push({ role: 'user', content: text, t: nowS() });
  aiRun(role, h.slice(-10).map(x => ({ role: x.role, content: String(x.content).slice(0, 1500) })), 0, job.trace)
    .then(r => { job.text = r.text; const lp = job.trace.filter(x => x.res).map(x => x.res).slice(-3); if (lp.length) job.props = lp; const hp = [...new Set(job.trace.filter(x => x.tool === 'ask_agent' && x.ok && x.args && x.args.role).map(x => x.args.role))]; if (r.choices && r.choices.length) job.choices = r.choices; h.push(Object.assign({ role: 'assistant', content: r.text, t: nowS(), steps: job.trace.length }, lp.length ? { props: lp } : {}, hp.length ? { helpers: hp } : {}, r.choices && r.choices.length ? { choices: r.choices } : {})); })
    .catch(e => { job.error = e.message; h.pop(); })
    .finally(() => { job.done = true; if (h.length > 40) h.splice(0, h.length - 40); try { writeJ(F_AI, AIH); } catch (e) {} for (const k in AIJ) if (nowS() - AIJ[k].t > 3600) delete AIJ[k]; });
  return { id, build: BUILD };
}
async function aiTest() {
  const c = aiCfg(), h = {}; if (c.key) h.authorization = 'Bearer ' + c.key;
  if (aiCloud(c)) { try { const j = await getJ((await relayBase()) + '/ai/models', {}, 10000); return j.ready ? { ok: true, cloud: true, models: [], hasModel: true } : { ok: false, cloud: true, error: 'HexStack 雲端 AI 還沒開通，暫時請改用自己的金鑰或本機模型' }; } catch (e) { return { ok: false, cloud: true, error: '連不到 HexStack 雲端：' + e.message }; } }
  let models = []; try { const j = await getJ(c.base.replace(/\/+$/, '') + '/models', { headers: h }, 10000); models = (j.data || []).map(x => x.id).slice(0, 50); } catch (e) { return { ok: false, error: '連不到 ' + c.base + '：' + e.message }; }
  return { ok: true, models, hasModel: models.includes(c.model) };
}
async function aiApi(req, p, M, q) {
  if (p === '/api/ai/config' && M === 'GET') { const c = aiCfg(); return { base: c.base, model: c.model, hasKey: !!c.key, cloud: aiCloud(c), notes: C.aiNotes || {}, roles: Object.fromEntries(Object.entries(AI_ROLES).map(([k, r]) => [k, { name: r.name, job: r.job }])) }; }
  if (p === '/api/ai/history' && M === 'GET') { const r = q.get('role') || 'bridge'; return { role: r, messages: (AIH[r] || []).slice(-40) }; }
  if (p === '/api/ai/job' && M === 'GET') { const j = AIJ[q.get('id')]; if (!j) throw new HErr(404, '找不到這個問題'); return j; }
  if (p === '/api/ai/test' && M === 'GET') return aiTest();
  if (M !== 'POST') return null;
  const d = await body(req).catch(e => { throw new HErr(400, e.message); });
  if (p === '/api/ai/config') {
    const a = C.ai || (C.ai = {});
    if (typeof d.base === 'string') { const b = d.base.trim(); if (b !== 'hexstack' && !/^https?:\/\/[^\s]{3,200}$/.test(b)) throw new HErr(400, '模型網址要是 http(s):// 開頭'); a.base = b; }
    if (typeof d.model === 'string' && d.model.trim()) a.model = d.model.trim().slice(0, 100);
    if (typeof d.key === 'string' && d.key !== '••••') { if (d.key && !isLocal(req)) throw new HErr(403, 'API 金鑰只能在執行器這台電腦上設定'); a.key = d.key.trim().slice(0, 300); }
    saveCfg(); return Object.assign({ ok: true }, await aiTest());
  }
  if (p === '/api/ai/notes') { if (!AI_ROLES[d.role]) throw new HErr(400, '沒有這個 AI'); const n = C.aiNotes || (C.aiNotes = {}), t = String(d.text || '').trim().slice(0, 3000); if (t) n[d.role] = t; else delete n[d.role]; saveCfg(); return { ok: true, notes: n }; }
  if (p === '/api/ai/chat') { setCtx(d.ctx); return aiStart(d.role || 'bridge', d.text); }
  if (p === '/api/ai/clear') { delete AIH[d.role || 'bridge']; writeJ(F_AI, AIH); return { ok: true }; }
  throw new HErr(404, '沒有這個功能');
}
async function api(req, res, p) {
  const q = new URL(req.url, 'http://x').searchParams, M = req.method;
  if (p === '/api/status' && M === 'GET') return status();
  if (p === '/api/log' && M === 'GET') { const n = Math.max(1, Math.min(1000, +q.get('n') || 100)); return LOGS.slice(-n).reverse(); }
  if (p === '/api/review' && M === 'GET') { const d = [7, 30, 0].includes(+q.get('days')) ? +q.get('days') : 0; return S.strategies.map(g => { const r = review(g, d); return Object.assign({}, r); }); }
  if (p === '/api/funds' && M === 'GET') return Object.assign(await fundsAll(q.get('force') === '1'), { list: fundList(), supported: Object.keys(FUND_EX) });
  if (p.startsWith('/api/ai/')) { const r = await aiApi(req, p, M, q); if (r) return r; }
  if (M !== 'POST') throw new HErr(404, '沒有這個功能');
  const d = await body(req).catch(e => { throw new HErr(400, e.message); });
  const find = id => { const g = S.strategies.find(x => x.id === id); if (!g) throw new HErr(404, '找不到策略 ' + id); return g; };
  if (p === '/api/strategies') {
    if (d.add) addStrategies(d.add);
    else if (d.remove) { const g = find(d.remove); await closeStrat(g, '移除策略'); S.strategies = S.strategies.filter(x => x !== g); log('info', { sid: g.id, name: stName(g), text: '移除策略' }); }
    else if (d.id && 'enabled' in d) { const g = find(d.id); if (d.enabled && !g.enabled) { g.enabled = true; g.lastBar = 0; lg('resume', g, { text: '啟用' }); } if (d.enabled && g.state === 'paused') await resumeStrat(g, '手動恢復'); if (!d.enabled && g.enabled) { await closeStrat(g, '停用策略'); g.enabled = false; lg('pause', g, { text: '停用策略' }); } }
    else if (d.id && 'alloc' in d) { const g = find(d.id), a = +d.alloc; if (!(a > 0 && a <= 1)) throw new HErr(400, '資金比例要在 0～1 之間');
      const tot = S.strategies.filter(x => x !== g && x.enabled && ledOf(x) === ledOf(g)).reduce((s, x) => s + x.alloc, 0) + a; if (tot > 1.0001) throw new HErr(400, `資金比例合計 ${r2(tot * 100, 0)}% 超過 100%`);
      lg('info', g, { text: `資金比例 ${Math.round(g.alloc * 100)}% → ${Math.round(a * 100)}%，下一根 K 線調整部位` }); g.alloc = a; g.lastBar = Math.min(g.lastBar || 0, (S.lastBar || 0) - H1); }
    else throw new HErr(400, '看不懂的指令');
    dirty(); save(); return { ok: true, strategies: (await status()).strategies };
  }
  if (p === '/api/promote') {
    const g = find(d.id), c = canPromote(g); if (!c.ok) throw new HErr(409, '還不能轉正：' + c.why);
    if (LED.live) { await closeStrat(g, '轉實盤，模擬倉平掉'); g.mode = 'live'; g.base = g.alloc * (await LED.live.getEquity()); g.lastBar = 0; }
    g.promoted = true; g.state = 'running'; g.trialSummary = review(g, 0); g.start = nowS(); g.real = 0; g.fills = []; g.trades = []; g.curve = []; g.skips = [];
    if (!LED.live) g.base = stratEq(g);
    lg('resume', g, { text: LED.live ? `轉正：開始在 ${liveName()} 執行` : '轉正（沒有設定交易所，繼續用模擬盤）' }); dirty(); save();
    return { ok: true };
  }
  if (p === '/api/limits') {
    const R = LIMR;
    for (const k in d) { if (k === 'off') { const o = d.off && typeof d.off === 'object' ? d.off : {}; C.limOff = C.limOff || {}; for (const [a, v] of Object.entries(o)) { if (!R[a]) throw new HErr(400, '不認得的設定：' + a); if (v) C.limOff[a] = true; else delete C.limOff[a]; } continue; }
      if (k === 'catchupPct') { const v = +d[k]; if (!(v >= 0 && v <= 10)) throw new HErr(400, 'catchupPct 要在 0～10'); C.catchupPct = v; continue; }
      if (!R[k]) throw new HErr(400, '不認得的設定：' + k); const v = +d[k]; if (!(v >= R[k][0] && v <= R[k][1])) throw new HErr(400, `${k} 要在 ${R[k][0]}～${R[k][1]} 之間`); C.limits[k] = v; }
    saveCfg(); if (LED.live) LED.live.maxLev = effLev(); log('info', { text: '風控上限：' + JSON.stringify(C.limits) + (Object.keys(C.limOff || {}).length ? '，關閉：' + Object.keys(C.limOff).join('、') : '') }); return { ok: true, limits: C.limits, limitsOff: C.limOff || {}, catchupPct: C.catchupPct };
  }
  if (p === '/api/paperonly') {
    const on = d.on === true; if (!!C.paperOnly === on) return { ok: true, paperOnly: on };
    if (on) {
      // 交易所上還有策略的持倉就不切：開著時執行器不會再管實盤的倉位
      const held = S.strategies.filter(g => ledOf(g) === 'live' && g.pos);
      if (held.length) throw new HErr(409, `交易所上還有 ${held.length} 個策略的持倉，先把它們關掉（會平倉），再打開模擬盤`);
      C.paperOnly = true; saveCfg(); log('info', { text: '打開模擬盤：實盤的策略全部停止下單' });
    } else {
      C.paperOnly = false; saveCfg();
      for (const g of S.strategies.filter(g => ledOf(g) === 'live' && g.enabled)) g.lastBar = 0;
      log('info', { text: LED.live ? `關閉模擬盤：實盤的策略開始在 ${liveName()} 執行` : '關閉模擬盤（還沒設定下單金鑰，不會下真單）' });
    }
    dirty(); save(); return { ok: true, paperOnly: C.paperOnly === true };
  }
  // 新版 HexBOT：在某個帳本（模擬交易所或實盤）開／關一組「我的策略」參數；資金平均分給這個帳本裡開著的策略
  if (p === '/api/run') {
    const L = String(d.led || ''), key = String(d.key || '').slice(0, 80);
    if (!(L === 'live' || /^sim:\w+$/.test(L) && LED[L])) throw new HErr(400, '沒有這個帳戶');
    if (!key) throw new HErr(400, '缺少策略');
    let g = S.strategies.find(x => x.led === L && x.key === key);
    if (d.on) {
      if (L === 'live') { if (!liveAllowed()) throw new HErr(409, liveReady() ? '正式網要先允許實盤（allowLive）' : '還沒設定下單金鑰'); if (C.paperOnly) throw new HErr(409, '模擬盤開著，實盤策略不會下單；先關掉模擬盤'); }
      if (!g) {
        const a = d.strat || {}; if (!ENG.BEST[a.st]) throw new HErr(400, '不認得的策略：' + a.st);
        const sym = String(a.sym || '').toUpperCase(); if (!isCoin(sym)) throw new HErr(400, '幣種格式不對：' + a.sym);
        if (a.st === 'cus' && !(a.p && a.p.rules)) throw new HErr(400, '自訂策略要帶規則（p.rules）');
        const mkt = MKT[a.mkt] != null ? a.mkt : 'fut';
        if (L === 'live' && mkt !== 'fut' && !LED.live.spotOk) throw new HErr(409, liveName() + ' 實盤還不支援' + MKT_NAME[mkt]);
        // Bybit、OKX 是統一帳戶：同一個幣的現貨和槓桿是同一筆餘額，分不出來，不能同時跑
        if (L === 'live' && mkt !== 'fut' && ['bybit', 'okx'].includes(C.exchange) && S.strategies.some(x => x.led === 'live' && x.enabled && x.sym === sym && mktOf(x) !== 'fut' && mktOf(x) !== mkt)) throw new HErr(409, `${liveName()} 的現貨和槓桿共用同一個帳戶，${sym} 已經有${MKT_NAME[mkt === 'spot' ? 'mrg' : 'spot']}策略在跑，不能同時跑${MKT_NAME[mkt]}`);
        g = { id: 's' + (S.nextId++), key, led: L, mkt, name: String(a.name || '').slice(0, 40) || (ENG.NAME[a.st] || a.st) + ' ' + sym, st: a.st, sym, p: cleanP(a.p), alloc: 0, enabled: false, mode: L === 'live' ? 'live' : 'paper', promoted: true, state: 'running', pauseReason: '', trialStart: nowS(), trialDays: 0, start: nowS(), base: 0, real: 0, fills: [], trades: [], curve: [], skips: [] };
        S.strategies.push(g);
      } else if (d.strat && d.strat.p) g.p = cleanP(d.strat.p);
      if (!g.enabled) { g.enabled = true; g.state = 'running'; g.pauseKind = ''; g.pauseReason = ''; g.lastBar = 0; g.start = nowS(); g.driftFrom = nowS(); }
    } else if (g && g.enabled) { await closeStrat(g, '手動關閉'); g.enabled = false; }
    // 重新平均分配資金比例
    const on = S.strategies.filter(x => x.led === L && x.enabled), eq = await LED[ledOf(on[0] || { led: L })].getEquity().catch(() => 0);
    for (const x of on) { const a = 1 / on.length; if (Math.abs(a - x.alloc) > 1e-9) { if (!x.alloc) x.base = a * eq; x.alloc = a; x.lastBar = Math.min(x.lastBar || 0, (S.lastBar || 0) - H1); } }
    if (g) lg(d.on ? 'resume' : 'pause', g, { text: d.on ? `開始執行，資金比例 ${Math.round(g.alloc * 100)}%` : '關閉' });
    dirty(); save(); return { ok: true };
  }
  // 模擬交易所：新增／改起始金額（會平掉這個帳戶的模擬倉、重新計算）／移除
  if (p === '/api/sim') {
    const k = String(d.k || '').toLowerCase(); if (!SIM_EX.includes(k)) throw new HErr(400, '不支援的交易所');
    const L = 'sim:' + k, gs = S.strategies.filter(x => x.led === L);
    if (d.remove) { if (gs.some(x => x.enabled)) throw new HErr(409, '這個模擬帳戶還有策略在跑，先關掉'); delete S.sims[k]; delete LED[L]; delete S.acct[L]; S.strategies = S.strategies.filter(x => x.led !== L); dirty(); save(); return { ok: true }; }
    const st = +d.start; if (!(st >= 10 && st <= 1e9)) throw new HErr(400, '金額要在 10～1,000,000,000 之間');
    if (LED[L]) for (const g of gs) await closeStrat(g, '改模擬起始金額');
    S.sims[k] = simNew(st); LED[L] = new PaperExchange(S.sims[k]); delete S.acct[L];
    for (const g of gs) { g.pos = null; g.real = 0; g.base = g.alloc * st; g.curve = []; g.trades = []; g.fills = []; g.start = nowS(); if (g.enabled) g.lastBar = 0; }
    log('info', { text: `模擬帳戶 ${k}：起始金額 ${fmt(st)} USDT` }); dirty(); save(); return { ok: true };
  }
  if (p === '/api/stopall') {
    for (const L of LEDS()) { for (const g of S.strategies.filter(g => ledOf(g) === L && g.enabled)) { g.state = 'paused'; g.pauseKind = 'halt'; g.pauseReason = '手動全部停止'; } await closeLedger(L, '全部停止'); acct(L).halt = { reason: '手動全部停止', t: nowS() }; }
    log('halt', { text: '手動全部停止：平倉並暫停所有策略' }); notify('🛑 全部停止', '已平倉並暫停所有策略'); dirty(); save(); return { ok: true };
  }
  if (p === '/api/resume') {
    for (const L of LEDS()) { const A = acct(L); if (A.halt) { A.halt = null; A.peak = A.eq || A.peak; A.dayStart = A.eq || A.dayStart; } }
    for (const g of S.strategies.filter(g => g.state === 'paused' && g.pauseKind === 'halt')) await resumeStrat(g, '解除煞車');
    log('resume', { text: '解除帳戶煞車（回撤高點、今日起點重設為現在權益）' }); dirty(); save(); return { ok: true };
  }
  if (p === '/api/funds/add') return fundAdd(d);
  // 帳戶設定：要不要算進資產總覽、改名（id 'trade'＝下單用的 Bybit 金鑰）
  if (p === '/api/funds/set') {
    if (d.id === 'trade') { if ('inTotal' in d) C.tradeInTotal = d.inTotal !== false; if (typeof d.name === 'string' && d.name.trim()) C.tradeName = d.name.trim().slice(0, 30); saveCfg(); delete FUND_CACHE.trade; return { ok: true }; }
    const a = (C.funds || []).find(x => x.id === d.id); if (!a) throw new HErr(404, '找不到這個帳戶');
    if ('inTotal' in d) a.inTotal = d.inTotal !== false; if (typeof d.name === 'string' && d.name.trim()) a.name = d.name.trim().slice(0, 30);
    saveCfg(); delete FUND_CACHE[a.id]; return { ok: true };
  }
  if (p === '/api/funds/remove' && d.id === 'trade') { C.tradeInTotal = false; saveCfg(); delete FUND_CACHE.trade; return { ok: true }; }
  if (p === '/api/funds/remove') { const n = (C.funds || []).length; C.funds = (C.funds || []).filter(x => x.id !== d.id); if (C.funds.length === n) throw new HErr(404, '找不到這個帳戶'); delete FUND_CACHE[d.id]; saveCfg(); return { ok: true }; }
  throw new HErr(404, '沒有這個功能');
}
async function localApi(req, p) {
  const d = await body(req).catch(e => { throw new HErr(400, e.message); });
  if (p === '/local/config') {
    if ('exchange' in d) { if (d.exchange !== 'paper' && !LIVE_EX[d.exchange]) throw new HErr(400, '下單只支援：' + Object.values(LIVE_NAME).join('、'));
      // 換交易所前，實盤的策略要先平倉（不然舊交易所的部位會沒人管）
      if (d.exchange !== C.exchange && S.strategies.some(g => ledOf(g) === 'live' && g.pos)) throw new HErr(400, '實盤還有持倉，先把實盤策略停止平倉再換交易所');
      if (d.exchange !== C.exchange) { C.apiKey = ''; C.apiSecret = ''; C.apiPass = ''; }
      C.exchange = d.exchange; }
    if ('testnet' in d) C.testnet = !!d.testnet;
    if ('allowLive' in d) C.allowLive = d.allowLive === true;
    if ('tradeInTotal' in d) { C.tradeInTotal = d.tradeInTotal !== false; delete FUND_CACHE.trade; }
    if (typeof d.apiKey === 'string' && d.apiKey !== '••••') C.apiKey = d.apiKey.trim().slice(0, 100);
    if (typeof d.apiSecret === 'string' && d.apiSecret !== '••••') C.apiSecret = d.apiSecret.trim().slice(0, 200);
    if (typeof d.apiPass === 'string' && d.apiPass !== '••••') C.apiPass = d.apiPass.slice(0, 100);
    if (typeof d.hostName === 'string' && d.hostName.trim()) C.hostName = d.hostName.trim().slice(0, 40);
    saveCfg(); setupLive(); delete FUND_CACHE.trade;
    let test = '';
    if (LED.live) try { test = '連線成功，權益 ' + fmt(await LED.live.getEquity()) + ' USDT'; } catch (e) { test = '連線失敗：' + e.message; }
    log('info', { text: `交易所設定更新：${C.exchange === 'paper' ? '模擬盤' : liveName()}${test ? '，' + test : ''}` });
    return { ok: true, test };
  }
  throw new HErr(404, '沒有這個功能');
}
function server() {
  const srv = http.createServer(async (req, res) => {
    const o = req.headers.origin, H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (o && ORIGIN_OK(o)) Object.assign(H, { 'access-control-allow-origin': o, vary: 'Origin' });
    const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    const send = (st, d, h) => { res.writeHead(st, Object.assign({}, H, h)); res.end(typeof d === 'string' ? d : JSON.stringify(d)); };
    try {
      if (req.method === 'OPTIONS') {
        if (!o || !ORIGIN_OK(o)) return send(403, { error: '不允許的來源' });
        const h = { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' };
        if (req.headers['access-control-request-private-network']) h['access-control-allow-private-network'] = 'true';
        res.writeHead(204, Object.assign({}, H, h)); return res.end();
      }
      if (p === '/ping') return send(200, { ok: true });
      if (p === '/') { if (!isLocal(req)) return send(403, '主控台只能在執行器這台電腦上開：http://localhost:' + C.port, { 'content-type': 'text/plain; charset=utf-8' }); return send(200, consoleHtml(), { 'content-type': 'text/html; charset=utf-8' }); }
      if (p.startsWith('/api/') || p.startsWith('/local/')) {
        if (!authOk(req)) return send(401, { error: '未授權：配對碼不對' });
        if (p.startsWith('/local/') && (!isLocal(req) || req.method !== 'POST')) return send(403, { error: '交易所金鑰只能在執行器這台電腦上設定' });
        const r = p.startsWith('/local/') ? await localApi(req, p) : await api(req, res, p);
        return send(200, r);
      }
      return send(404, { error: '沒有這個頁面' });
    } catch (e) { if (!(e instanceof HErr)) log('error', { text: 'API：' + e.message }); return send(e.st || 500, { error: e.message }); }
  });
  srv.on('error', e => { console.log(e.code === 'EADDRINUSE' ? `埠 ${C.port} 已被佔用（是不是已經開了一個執行器？）` : '伺服器錯誤：' + e.message); process.exit(1); });
  srv.listen(C.port, '0.0.0.0', () => console.log(`主控台：http://localhost:${C.port}/`));
  return srv;
}
function consoleHtml() {
  const lan = Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address);
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HexStack 電腦版</title>
<style>:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f27;--mu:#667085;--line:#e3e6eb;--acc:#3b6cf6;--pos:#12a150;--neg:#d92d20}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1218;--card:#171b23;--fg:#e8ebf0;--mu:#8b93a3;--line:#2a3140;--acc:#6d93ff;--pos:#3ccf7a;--neg:#ff6b5e}}
:root[data-theme="dark"]{--bg:#0f1218;--card:#171b23;--fg:#e8ebf0;--mu:#8b93a3;--line:#2a3140;--acc:#6d93ff;--pos:#3ccf7a;--neg:#ff6b5e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 12px}h2{font-size:16px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 12px;overflow:hidden}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.k{color:var(--mu);font-size:12px}.v{font-size:18px;font-weight:600}
.pos{color:var(--pos)}.neg{color:var(--neg)}.mu{color:var(--mu);font-size:13px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}
.tw{overflow-x:auto}#qr{background:#fff;padding:10px;display:inline-block;border-radius:8px}code{word-break:break-all;font-size:12px}
input,select,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}button{background:var(--acc);color:#fff;border:0;cursor:pointer}
label{display:block;margin:6px 0}.row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}.warn{color:var(--neg)}</style></head><body><main>
<h1>HexStack 電腦版</h1>
<div class="card"><div class="grid" id="sum"></div><div class="mu" id="sub" style="margin-top:8px"></div></div>
<div class="card"><h2>配對手機</h2><div class="row"><div id="qr"></div><div style="flex:1;min-width:220px"><p class="mu">用手機相機掃 QR，或在 App「執行器」頁貼上配對碼。配對碼等於這台的密碼，不要給別人。</p>
<div class="k">配對碼</div><code id="code"></code><p><button id="cp">複製配對連結</button></p><div class="mu" id="pub"></div></div></div></div>
<div class="card"><h2>策略</h2><div class="tw"><table id="st"></table></div><p class="mu">策略從 App 加入。新策略先用模擬盤試跑，試跑期滿且沒有偏離回測才可以轉實盤。</p></div>
<div class="card"><h2>交易所設定（只能在這台電腦改）</h2>
<label>交易所 <select id="ex"><option value="paper">模擬盤（不下真單）</option><option value="bybit">Bybit USDT 永續</option><option value="binance">幣安 USDⓈ-M 永續</option><option value="okx">OKX USDT 永續</option><option value="bitget">Bitget USDT 永續</option></select></label>
<label><input type="checkbox" id="tn"> 測試網／模擬交易（建議先用這個；幣安、OKX、Bitget 要用模擬交易建的金鑰）</label>
<label>API Key <input id="ak" autocomplete="off" style="width:100%"></label><label>API Secret <input id="as" type="password" autocomplete="off" style="width:100%"></label><label>Passphrase（OKX、Bitget 才要）<input id="ap" type="password" autocomplete="off" style="width:100%"></label>
<label><input type="checkbox" id="al"> 允許正式網下單（allowLive）</label>
<p class="mu">API Key 只開「合約交易」，<b>不要開提幣</b>。各交易所下單介面都還沒在真的帳戶測過，請先用測試網／模擬交易。</p><button id="sv">儲存並測試連線</button> <span id="svm" class="mu"></span></div>
<div class="card"><h2>最新紀錄</h2><div class="tw"><table id="lg"></table></div></div>
<p class="mu">區網網址：${lan.map(a => `http://${a}:${C.port}`).join('、') || '—'}（手機同一個 Wi-Fi 時可用）</p>
</main><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>
const TK=${JSON.stringify(C.token)},H={authorization:'Bearer '+TK,'content-type':'application/json'},$=s=>document.querySelector(s),esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const f2=x=>(+x||0).toLocaleString('en-US',{maximumFractionDigits:2}),tm=t=>t?new Date(t*1000).toLocaleString('zh-TW',{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const TY=${JSON.stringify(TYPE)};let link='',qr=null;
async function j(u,o){const r=await fetch(u,Object.assign({headers:H},o));const d=await r.json();if(!r.ok)throw new Error(d.error||r.status);return d}
async function load(){try{const s=await j('/api/status');
$('#sum').innerHTML=[['模式',{paper:'模擬盤',testnet:'測試網／模擬交易',live:'正式網'}[s.mode]],['權益',f2(s.equity)+' USDT'],['今日',(s.dayPct>=0?'+':'')+s.dayPct+'%'],['最大回撤',s.mdd+'%'],['策略',s.strategies.length+' 個'],['上次執行',tm(s.lastTick)]].map(([k,v])=>'<div><div class="k">'+k+'</div><div class="v">'+esc(v)+'</div></div>').join('');
$('#sub').innerHTML=(s.halted?'<span class="warn">煞車中：'+esc(s.halted.reason)+'</span>　':'')+'引擎 '+esc(s.engine.src)+' '+esc(s.engine.ver)+'　推播後端 '+(s.relay.ok?'已連線':'未連線 '+esc(s.relay.err))+'　Bybit 介面 liveTested:false';
$('#pub').textContent=s.publicUrl?'對外網址：'+s.publicUrl:'對外通道還沒建立（App 會透過推播後端找這台）';
$('#st').innerHTML='<tr><th>名稱</th><th>幣</th><th>比例</th><th>狀態</th><th>部位</th><th></th></tr>'+s.strategies.map(g=>'<tr><td>'+esc(g.name)+'</td><td>'+g.sym+'</td><td>'+Math.round(g.alloc*100)+'%</td><td>'+({trial:'試跑',running:'執行中',paused:'暫停'}[g.state])+(g.pauseReason?'（'+esc(g.pauseReason)+'）':'')+(g.state==='trial'?' 剩 '+g.trialLeft+' 天':'')+(g.review.status==='drift'?' <span class="warn">偏離</span>':'')+'</td><td>'+(g.position?(g.position.side>0?'多 ':'空 ')+g.position.qty.toPrecision(4)+' @'+f2(g.position.entry):'空手')+'</td><td>'+(g.state==='paused'||!g.enabled?'<button data-on="'+g.id+'">恢復</button>':'<button data-off="'+g.id+'">停用</button>')+(g.canPromote?' <button data-pr="'+g.id+'">轉正</button>':'')+'</td></tr>').join('');
const lg=await j('/api/log?n=30');$('#lg').innerHTML=lg.map(e=>'<tr><td>'+tm(e.t)+'</td><td>'+(TY[e.type]||e.type)+'</td><td>'+esc(e.name||'')+' '+esc(e.sym||'')+'</td><td>'+esc(e.text||'').replace(/\\n/g,'<br>')+'</td></tr>').join('');
const pl=${JSON.stringify(APP)}+'#pair='+b64u(JSON.stringify({u:s.publicUrl||'',k:TK,h:s.hostId,n:s.hostName}));
if(pl!==link){link=pl;$('#code').textContent=pl.split('#pair=')[1];$('#qr').innerHTML='';try{qr=new QRCode($('#qr'),{text:pl,width:240,height:240,correctLevel:QRCode.CorrectLevel.L})}catch(e){$('#qr').textContent='QR 產生失敗，請用配對碼'}}
}catch(e){$('#sub').textContent='讀取失敗：'+e.message}}
function b64u(s){return btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
$('#cp').onclick=()=>navigator.clipboard.writeText(link).then(()=>$('#cp').textContent='已複製');
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;try{if(b.dataset.on)await j('/api/strategies',{method:'POST',body:JSON.stringify({id:b.dataset.on,enabled:true})});else if(b.dataset.off)await j('/api/strategies',{method:'POST',body:JSON.stringify({id:b.dataset.off,enabled:false})});else if(b.dataset.pr)await j('/api/promote',{method:'POST',body:JSON.stringify({id:b.dataset.pr})});else return;load()}catch(x){alert(x.message)}});
$('#ex').value=${JSON.stringify(C.exchange)};$('#tn').checked=${!!C.testnet};$('#al').checked=${C.allowLive === true};$('#ak').value=${JSON.stringify(C.apiKey ? '••••' : '')};$('#as').value=${JSON.stringify(C.apiSecret ? '••••' : '')};$('#ap').value=${JSON.stringify(C.apiPass ? '••••' : '')};
$('#sv').onclick=async()=>{$('#svm').textContent='測試中…';try{const r=await j('/local/config',{method:'POST',body:JSON.stringify({exchange:$('#ex').value,testnet:$('#tn').checked,allowLive:$('#al').checked,apiKey:$('#ak').value,apiSecret:$('#as').value,apiPass:$('#ap').value})});$('#svm').textContent='已儲存 '+(r.test||'')}catch(x){$('#svm').textContent=x.message}load()};
load();setInterval(load,10000);
</script></body></html>`;
}

// ───────── 主迴圈 ─────────
let BUSY = false, lastBars = 0, lastEngCheck = 0, lastHb = 0, waitLogged = 0;
async function dataReady(T) {
  const syms = [...new Set(S.strategies.filter(g => g.enabled).map(g => g.sym))];
  if (!REPLAY && nowS() - lastBars >= 60) { lastBars = nowS(); for (const s of syms) if (mEnd(s) < T) { await refreshBars(s); } if (S.strategies.some(g => g.enabled && g.st === 'my')) for (const s of ['BTC', 'ETH']) await refreshIgn(s).catch(() => {}); }
  const late = syms.filter(s => mEnd(s) < T);
  if (!late.length) return true;
  if (nowS() - T > 1800) { if (waitLogged !== T) { waitLogged = T; log('error', { text: `${late.join('、')} 最新 K 線還沒拿到（資料到 ${late.map(s => tpeHM(mEnd(s))).join('、')}），先用舊資料算` }); } return true; }
  return false;
}
async function minute() {
  if (BUSY) return; BUSY = true;
  try {
    if (!REPLAY && nowS() - lastEngCheck > H1) { lastEngCheck = nowS(); try { const f = await engineFiles(); if (sha256(f.html).slice(0, 12) !== ENG.hash) { loadEngine(f); log('info', { text: '引擎已更新到 ' + ENG.hash }); } } catch (e) { log('error', { text: '更新引擎失敗：' + e.message }); } }
    if (!REPLAY) await refreshPrices(activeSyms());
    await stopChecks();
    for (const L of LEDS()) if (isPaperL(L)) await LED[L].checkStops();
    await watch();
    await account();
    const T = Math.floor(nowS() / H1) * H1;
    if (nowS() - T >= 60 && S.strategies.some(g => g.enabled && (g.lastBar || 0) < T) && await dataReady(T)) await hourTick(T);
    const tk = tpeDay(nowS()), hr = +tpe(nowS()).slice(11, 13);
    if (hr >= 8 && S.report.day !== tk) { S.report.day = tk; dirty(); if (S.strategies.length || !REPLAY) await dailyReport(); }
    if (!REPLAY && nowS() - lastHb >= 300) { lastHb = nowS(); heartbeat(); tunnelWatch(); }
  } catch (e) { log('error', { text: '主迴圈：' + (e.stack || e.message).split('\n').slice(0, 2).join(' ') }); notifyErr(e.message); }
  finally { BUSY = false; save(); }
}

// ───────── 快轉測試（--replay 天數）：用歷史 1h K 一步一步跑，順便演練離線補單、手動操作、煞車、偏離暫停、每日報告 ─────────
async function replay() {
  for (const s of ['BTC', 'ETH']) { try { const add = addBars(s, await ghRows(s), null, true); console.log(s, '接上 data 分支', add, '根'); } catch (e) { console.log(s, 'data 分支抓不到，只用內建資料'); } }
  const end = Math.min(mEnd('BTC'), mEnd('ETH')), start = end - REPLAY * D1;
  console.log(`快轉：${tpeHM(start)} → ${tpeHM(end)}（台北時間），資料夾 ${DIR}`);
  VNOW = start * 1000;
  const L = ARG.strategies ? JSON.parse(ARG.strategies) : [{ name: '突破 BTC', st: 'brk', sym: 'BTC', alloc: 0.3, trialDays: 3 }, { name: '均線帶 ETH', st: 'rib', sym: 'ETH', alloc: 0.3 }, { name: '自訂均線 BTC', st: 'cus', sym: 'BTC', alloc: 0.2, p: ENG.BEST.cus.BTC }, { name: '海龜 ETH', st: 'tur', sym: 'ETH', alloc: 0.2 }];
  addStrategies(L);
  const path_ = (s, t) => { const m = MK[s], i = Math.floor((t - m.t0) / H1); if (i >= m.n) return m.C[m.n - 1]; const O = m.O[i], Hh = m.H[i], Ll = m.L[i], Cc = m.C[i], u = Math.max(0, (t - (m.t0 + i * H1)) / H1 * 3.3 - 0.3), a = Cc >= O ? [O, Ll, Hh, Cc] : [O, Hh, Ll, Cc], k = Math.min(2, Math.floor(u)); return a[k] + (a[k + 1] - a[k]) * (u - k); };
  const sc = ARG.scenario !== 'off', off0 = start + 2 * D1, off1 = start + 3.5 * D1;
  let manualDone = 0, resumeAt = 0, slipOn = 0, ddDone = 0, dayDone = 0, promTried = 0;
  const call = async (p, d) => { const fake = { method: d ? 'POST' : 'GET', url: p, headers: {}, on: (ev, f) => { if (ev === 'data' && d) f(Buffer.from(JSON.stringify(d))); if (ev === 'end') f(); } }; try { return await api(fake, null, p.split('?')[0]); } catch (e) { return { error: e.message }; } };
  for (let t = start; t <= end; t += 300) {
    VNOW = t * 1000;
    for (const s of Object.keys(MK)) PX[s] = { px: path_(s, t), t };
    // 交易所自己的停損每 5 分鐘都會檢查（就算執行器離線）
    await LED.paper.checkStops();
    if (sc && t >= off0 && t < off1) {
      if (t === off0) { log('info', { text: '【演練】主機離線 36 小時（交易所停損照常運作）' });
        for (const [sym, sl] of Object.entries(S.paper.sl)) { const q = (S.paper.pos[sym] || {}).q; if (q && sl.stop) { sl.stop = px(sym) * (1 - sgn(q) * 0.003); log('info', { sym, text: `【演練】把交易所停損單移到 ${fpx(sl.stop)}（現價 0.3% 內），測離線時停損觸發` }); } } }
      continue; }
    if (sc && t === off1) log('info', { text: '【演練】主機恢復上線' });
    await minute();
    if (!sc) continue;
    const pos = Object.entries(S.paper.pos).find(([, p]) => p.q);
    if (!manualDone && t >= start + 4 * D1 && pos && !BUSY) { manualDone = t; const [sym, p] = pos; log('info', { text: `【演練】使用者在交易所把 ${sym} 部位手動砍一半` }); p.q /= 2; S.paper.cash += 0; resumeAt = t + 6 * H1; }
    if (resumeAt && t >= resumeAt) { resumeAt = 0; for (const g of S.strategies.filter(g => g.pauseKind === 'manual')) { log('info', { text: '【演練】使用者在 App 按恢復：' + stName(g) }); await call('/api/strategies', { id: g.id, enabled: true }); } }
    if (!promTried && t >= start + 3.6 * D1) { promTried = 1; const g = S.strategies[0]; const r = await call('/api/promote', { id: g.id }); log('info', { text: '【演練】嘗試轉正 ' + stName(g) + '：' + (r.error || '成功') }); const g2 = S.strategies[1]; const r2_ = await call('/api/promote', { id: g2.id }); log('info', { text: '【演練】嘗試轉正 ' + stName(g2) + '：' + (r2_.error || '成功') }); }
    if (!slipOn && t >= start + 5 * D1) { slipOn = t; LED.paper.slipMul = 12; log('info', { text: '【演練】成交滑價變成 12 倍（測偏離暫停）' }); }
    if (slipOn && t >= slipOn + 2.5 * D1 && LED.paper.slipMul > 1) { LED.paper.slipMul = 1; log('info', { text: '【演練】滑價恢復正常' }); for (const g of S.strategies.filter(g => g.pauseKind === 'drift')) await call('/api/strategies', { id: g.id, enabled: true }); }
    if (!dayDone && t >= start + 8 * D1 && REPLAY >= 10) { dayDone = t; await call('/api/limits', { dayLossPct: 0.1 }); log('info', { text: '【演練】單日虧損上限調成 0.1%' }); }
    if (dayDone > 0 && acct('paper').halt && t >= dayDone) { dayDone = -t; }
    if (dayDone < 0 && t >= -dayDone + 3 * H1) { dayDone = -1e15; await call('/api/limits', { dayLossPct: 5 }); await call('/api/resume', {}); log('info', { text: '【演練】上限調回 5%，解除煞車' }); }
    if (!ddDone && t >= start + 10 * D1 && REPLAY >= 12) { const A = acct('paper'); ddDone = t; await call('/api/limits', { maxDDPct: Math.max(0.1, r2((A.dd || 0) * 100 + 0.1)) }); log('info', { text: '【演練】回撤上限調到目前回撤 +0.1%' }); }
    if (ddDone > 0 && acct('paper').halt && acct('paper').halt.reason.startsWith('回撤')) { ddDone = -1; await call('/api/limits', { maxDDPct: 20 }); await call('/api/resume', {}); log('info', { text: '【演練】回撤上限調回 20%，解除煞車' }); }
  }
  const st = await status(), rv = await call('/api/review?days=0');
  const cnt = {}; for (const e of LOGS) cnt[e.type] = (cnt[e.type] || 0) + 1;
  console.log('\n════ 快轉結束 ════\n紀錄筆數：', JSON.stringify(cnt));
  console.log('權益', st.equity, '起始', st.startEquity, '最大回撤%', st.mdd, '煞車', JSON.stringify(st.halted));
  for (const g of st.strategies) console.log(`  ${g.id} ${g.name} ${g.state}${g.pauseReason ? '（' + g.pauseReason + '）' : ''} 權益 ${g.equity} 部位 ${g.position ? JSON.stringify(g.position) : '空手'} 檢討 ${g.review.status} ${g.review.reasons.join('、')}`);
  for (const r of rv) console.log(`  回顧 ${r.name}：真實 報酬 ${r.real.ret}% ${r.real.trades} 筆 勝率 ${r.real.win}% 回撤 ${r.real.mdd}% 滑價 ${r.real.slip}%（${r.real.fills} 筆）｜回測 報酬 ${r.bt.ret}% ${r.bt.trades} 筆 勝率 ${r.bt.win}% 回撤 ${r.bt.mdd}% → ${r.status} ${r.reasons.join('、')}`);
  writeJ(path.join(DIR, 'replay-status.json'), st); writeJ(path.join(DIR, 'replay-review.json'), rv);
  save();
  if (ARG.serve) { VNOW = null; server(); console.log('快轉結果留著，HTTP 伺服器繼續開著（Ctrl+C 結束）'); }
}

// ───────── 啟動 ─────────
async function main() {
  console.log(`HexStack 電腦版 v${VER}${SEA ? '（單檔版）' : ''}　資料夾：${DIR}`);
  for (let k = 0; ; k++) { try { loadEngine(await engineFiles()); break; } catch (e) { console.log('載入引擎失敗：', e.message); if (REPLAY || k >= 30) throw e; await sleep(60000); } }
  console.log(`引擎 ${ENG.src} ${ENG.hash}，策略 ${Object.keys(ENG.NAME).length} 個`);
  if (REPLAY) return replay();
  if (FIRST) log('info', { text: `第一次啟動：模擬盤起始 ${C.startEquity} USDT。配對碼在主控台 http://localhost:${C.port}/` });
  if (LED.live) log('info', { text: `${liveName()}已設定（此介面還沒在真帳戶測過）` });
  server();
  lastHb = nowS();
  if (C.tunnel !== false && !ARG['no-tunnel']) startTunnel(); else heartbeat();
  if (FIRST && !ARG['no-open'] && process.platform !== 'android') { const u = `http://localhost:${C.port}/`; try { cp.spawn(process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', u] : [u], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (e) {} }
  await minute();
  setInterval(minute, 60000);
  const bye = () => { save(); if (PUB.proc) try { PUB.proc.kill(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
process.on('unhandledRejection', e => { try { log('error', { text: '未處理的錯誤：' + (e && e.message || e) }); } catch (x) {} });
main().catch(e => { console.log('啟動失敗：', e.stack || e.message); if (process.platform === 'win32' && SEA) setTimeout(() => process.exit(1), 60000); else process.exit(1); });
