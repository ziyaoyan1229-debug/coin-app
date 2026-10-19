// HexStack 推播後端（Cloudflare Worker，免費方案）：收手機的推播訂閱，幫任何程式把通知推到 iPhone／Android／電腦。
// 由 .github/workflows/push.yml 自動部署；KV（SUBS）存訂閱與 VAPID 金鑰（第一次用到時自動產生），PUSH_KEY 是發送用密鑰（部署時設定）。
//   GET  /vapid                         → { key }：給 App 訂閱用的公鑰
//   POST /sub    { sub, cats, off, locks, names } → 登記或更新一台裝置（cats＝要收的類別，off＝策略信號裡關掉的策略，
//                locks＝{ 'st|sym|編號': 參數 } 我的策略的參數，names＝{ 同樣的 key: 使用者取的名字 }）
//   POST /unsub  { endpoint }            → 取消
//   GET  /locks  Authorization: Bearer <PUSH_KEY> → [{ h, st, sym, p }]：所有裝置鎖定的策略參數（不重複），給 sig_notify.js 照各自參數算信號
//   POST /test   { endpoint }            → 推一則測試通知給這台（App 通知頁的測試按鈕）
//   POST /send   Authorization: Bearer <PUSH_KEY>
//                { items: [{ title, body, url, cat, st, sym, lk, tag }] }  → 推給有開該類別的裝置；回 { sent, gone, failed }
//                策略信號：有 lk 的只推給鎖定那組參數的裝置；沒有 lk 的（預設參數），鎖定了同一個策略＋幣的裝置不推
//   GET  /stats  Authorization: Bearer <PUSH_KEY> → { subs }
// 其他程式要推通知：照 /send 的格式送一個 POST 就好（cat 不填＝所有裝置都收）。
// 執行器（executor/hexbot.js）：k＝sha256(配對 token) 的 hex，後端只存 k；第一次登記的 hostId 記住它的 k（先到先得），之後要用 k 做 HMAC 簽名。
//   POST /host        { hostId, url, name, th, ts, sig }   → 登記／心跳（每 5 分鐘）；sig＝HMAC-SHA256(k, "host\n"+hostId+"\n"+ts+"\n"+url+"\n"+name)
//   GET  /host?id=hostId&k=k                             → { url, name, lastSeen, online }：App 用來找執行器現在的網址（快速通道每次重開都會換）
//   POST /host/notify { hostId, ts, title, body, sig }   → 推給配對過這台主機的裝置；sig＝HMAC(k, "notify\n"+hostId+"\n"+ts+"\n"+title+"\n"+body)
//   POST /host/pair   { hostId, k, endpoint, off }        → App 把已訂閱推播的這台裝置綁到主機（off: true＝解除）
//   排程（每 5 分鐘）：超過 15 分鐘沒心跳 → 推「主機離線」；恢復心跳時推「主機恢復上線」
const SITE = 'https://ziyaoyan1229-debug.github.io/coin-app/';
const enc = new TextEncoder();
const b64u = buf => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const ub64 = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const json = (d, st = 200) => new Response(JSON.stringify(d), { status: st, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });
const S = crypto.subtle;

async function hkdf(salt, ikm, info, len) {
  const k = await S.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await S.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
// RFC 8291（aes128gcm）加密推播內容
export async function encrypt(sub, text) {
  const uaPub = ub64(sub.keys.p256dh), auth = ub64(sub.keys.auth);
  const as = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await S.exportKey('raw', as.publicKey));
  const uaKey = await S.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await S.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await S.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
// VAPID：第一次用到時產生 P-256 金鑰，存在 KV（換金鑰會讓所有裝置要重新訂閱，所以只產生一次）
export async function vapid(env) {
  const v = await env.SUBS.get('vapid', 'json');
  if (v) return v;
  const k = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const n = { pub: b64u(await S.exportKey('raw', k.publicKey)), jwk: await S.exportKey('jwk', k.privateKey) };
  await env.SUBS.put('vapid', JSON.stringify(n));
  return n;
}
export async function vapidHeader(v, endpoint) {
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE })));
  const key = await S.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + c));
  return `vapid t=${h}.${c}.${b64u(sig)}, k=${v.pub}`;
}
export async function pushOne(v, sub, msg) {
  const body = await encrypt(sub, JSON.stringify(msg));
  return fetch(sub.endpoint, { method: 'POST', body, headers: { Authorization: await vapidHeader(v, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' } });
}
// 鎖定參數的代號：策略|幣|排序後的參數 做 SHA-256 取前 12 碼（App 用同一個算法）
export const canon = (st, sym, p) => st + '|' + sym + '|' + JSON.stringify(Object.keys(p).filter(k => k !== 'capital').sort().map(k => [k, p[k]]));
export const lockId = async (st, sym, p) => [...new Uint8Array(await S.digest('SHA-256', enc.encode(canon(st, sym, p))))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
async function cleanLocks(L) {
  const out = {}, h = {};
  for (const [k, p] of Object.entries(L && typeof L === 'object' ? L : {}).slice(0, 30)) {
    const m = /^(\w{1,12})\|(BTC|ETH)(\|\w{1,12})?$/.exec(k);   // 策略|幣|編號（同一個策略可以存好幾份）
    if (!m || !p || typeof p !== 'object') continue;
    const q = {};
    for (const [a, v] of Object.entries(p).slice(0, 80)) if (/^\w{1,20}$/.test(a) && (typeof v === 'number' && isFinite(v) || typeof v === 'boolean' || typeof v === 'string' && (v.length <= 20 || a === 'rules' && v.length <= 3000))) q[a] = v;   // rules＝自訂策略的積木（JSON 字串）
    out[k] = q; h[k] = await lockId(m[1], m[2], q);
  }
  return [out, h];
}
const idOf = async ep => 'sub:' + b64u(await S.digest('SHA-256', enc.encode(ep))).slice(0, 32);
const authed = (req, env) => env.PUSH_KEY && req.headers.get('authorization') === 'Bearer ' + env.PUSH_KEY;
async function allSubs(env) {
  const out = []; let cursor;
  do { const r = await env.SUBS.list({ prefix: 'sub:', cursor }); for (const k of r.keys) { const v = await env.SUBS.get(k.name, 'json'); if (v) out.push([k.name, v]); } cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}

// ───────── 執行器主機 ─────────
const hexOf = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function hmacHex(k, s) { const key = await S.importKey('raw', enc.encode(k), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return hexOf(await S.sign('HMAC', key, enc.encode(s))); }
const same = (a, b) => { a = String(a || ''); b = String(b || ''); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const HID = /^[0-9a-f]{16}$/, KH = /^[0-9a-f]{64}$/, OFF_MS = 15 * 60000;
const hostKey = id => 'host:' + id;
async function hostPush(env, h, msg) {
  const v = await vapid(env); let sent = 0;
  for (const k of (h.devs || []).slice()) {
    const r = await env.SUBS.get(k, 'json');
    if (!r) { h.devs = h.devs.filter(x => x !== k); h.dirty = 1; continue; }
    try { const res = await pushOne(v, r.sub, msg); if (res.status === 404 || res.status === 410) { await env.SUBS.delete(k); h.devs = h.devs.filter(x => x !== k); h.dirty = 1; } else if (res.ok) sent++; } catch (e) {}
  }
  return sent;
}
// 驗簽：時間差 5 分鐘內、ts 比上次大（防重放）
async function hostAuth(h, d, parts) { const ts = +d.ts; return h && KH.test(h.th) && Math.abs(Date.now() - ts) < 300000 && ts > (h.ts || 0) && same(d.sig, await hmacHex(h.th, parts.join('\n'))); }
async function hostCron(env) {
  const ids = (await env.SUBS.get('hosts', 'json')) || [], t = Date.now();
  for (const id of ids) {
    const h = await env.SUBS.get(hostKey(id), 'json'); if (!h || !h.devs || !h.devs.length) continue;
    if (!h.down && t - (h.seen || 0) > OFF_MS) {
      h.down = t; await hostPush(env, h, { title: '⚠️ 執行器主機離線', body: `「${h.name || id}」已經 ${Math.round((t - h.seen) / 60000)} 分鐘沒有回報。請檢查電腦是否睡眠、斷網或程式被關掉；交易所上的停損單仍然有效。`, url: './#bot', tag: 'hx-' + id });
      delete h.dirty; await env.SUBS.put(hostKey(id), JSON.stringify(h));
    }
  }
}

// 純手機版資金總覽：手機用自己的唯讀金鑰簽好請求，這裡只負責轉送（交易所不允許網頁直接連）。
// 看不到 Secret；只放行讀餘額／持倉／行情的網址，只轉 GET，不會下單或提領。
const XEX = {
  bybit: { hosts: { main: 'https://api.bybit.com', test: 'https://api-testnet.bybit.com' }, hdr: ['x-bapi-api-key', 'x-bapi-timestamp', 'x-bapi-recv-window', 'x-bapi-sign'],
    paths: ['/v5/market/time', '/v5/market/tickers', '/v5/user/query-api', '/v5/account/wallet-balance', '/v5/asset/transfer/query-account-coins-balance', '/v5/position/list'] },
};
async function xproxy(req, u) {
  const ex = XEX[u.searchParams.get('ex')], base = ex && ex.hosts[u.searchParams.get('net') === 'test' ? 'test' : 'main'], path = u.searchParams.get('path') || '', q = u.searchParams.get('q') || '';
  if (!base || !ex.paths.includes(path) || q.length > 500 || /[^\w=&.%-]/.test(q)) return json({ error: 'not allowed' }, 403);
  const h = {}; for (const k of ex.hdr) { const v = req.headers.get(k); if (v) h[k] = v.slice(0, 200); }
  const r = await fetch(base + path + (q ? '?' + q : ''), { headers: h });
  return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
}

export default {
  async scheduled(ev, env, ctx) { ctx.waitUntil(hostCron(env)); },
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-bapi-api-key,x-bapi-timestamp,x-bapi-recv-window,x-bapi-sign', 'access-control-max-age': '86400' } });
    try {
      if (p === '/x' && req.method === 'GET') return xproxy(req, u);
      if (p === '/vapid') return json({ key: (await vapid(env)).pub });
      if (p === '/sub' && req.method === 'POST') {
        const d = await req.json(), s = d && d.sub;
        if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: 'bad subscription' }, 400);
        const [locks, lockh] = await cleanLocks(d.locks), names = {};
        for (const k in lockh) if (d.names && typeof d.names[k] === 'string') names[k] = d.names[k].slice(0, 20);
        const rec = { sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, cats: d.cats || {}, off: d.off || {}, locks, lockh, names, at: Date.now() };
        await env.SUBS.put(await idOf(s.endpoint), JSON.stringify(rec));
        return json({ ok: true, lockh });
      }
      if (p === '/test' && req.method === 'POST') {   // App 的「發測試通知」：只推給已登記的這一台，20 秒最多一次
        const d = await req.json(), k = d && d.endpoint && await idOf(d.endpoint), r = k && await env.SUBS.get(k, 'json');
        if (!r) return json({ error: 'not subscribed' }, 404);
        if (Date.now() - (r.test || 0) < 20000) return json({ error: 'too soon' }, 429);
        r.test = Date.now(); await env.SUBS.put(k, JSON.stringify(r));
        const res = await pushOne(await vapid(env), r.sub, { title: '✅ HexStack 測試通知', body: '收到這則就代表背景推播正常，App 關著、鎖螢幕也收得到。', url: './#notify', tag: 'hs-test' });
        if (res.status === 404 || res.status === 410) { await env.SUBS.delete(k); return json({ error: 'gone' }, 410); }
        return json({ ok: res.ok, status: res.status });
      }
      if (p === '/unsub' && req.method === 'POST') { const d = await req.json(); if (d && d.endpoint) await env.SUBS.delete(await idOf(d.endpoint)); return json({ ok: true }); }
      if (p === '/send' && req.method === 'POST') {
        if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
        const d = await req.json(), items = (d.items || (d.title ? [d] : [])).slice(0, 20);
        const v = await vapid(env), subs = await allSubs(env);
        let sent = 0, gone = 0, failed = 0;
        for (const [k, r] of subs) {
          for (const m of items) {
            if (m.cat && !r.cats[m.cat]) continue;
            const lh = r.lockh || {}, mine = m.lk && Object.keys(lh).find(k => lh[k] === m.lk);
            if (m.lk ? !mine : m.cat === 'sig' && m.st && (r.off[m.st] || Object.keys(lh).some(k => k.startsWith(m.st + '|' + m.sym)))) continue;
            let body = String(m.body || '');
            if (mine && r.names && r.names[mine]) body = body.replace('🔒 我的策略', '🔒 我的策略：' + r.names[mine]);   // 換成使用者取的名字
            try {
              const res = await pushOne(v, r.sub, { title: String(m.title || 'HexStack').slice(0, 120), body: body.slice(0, 1500), url: m.url || './#notify', tag: m.tag || undefined });
              if (res.status === 404 || res.status === 410) { await env.SUBS.delete(k); gone++; break; }
              if (res.ok) sent++; else failed++;
            } catch (e) { failed++; }
          }
        }
        return json({ sent, gone, failed, subs: subs.length });
      }
      if (p === '/locks') {
        if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
        const u = new Map();
        for (const [, r] of await allSubs(env)) if (r.cats && r.cats.sig) for (const [k, h] of Object.entries(r.lockh || {})) if (!u.has(h)) { const [st, sym] = k.split('|'); u.set(h, { h, st, sym, p: r.locks[k] }); }
        return json([...u.values()]);
      }
      if (p === '/host' && req.method === 'POST') {   // 執行器登記／心跳
        const d = await req.json(), id = d && d.hostId;
        if (!HID.test(id || '') || !KH.test(d.th || '') || typeof d.url !== 'string' || d.url.length > 200 || d.url && !/^https:\/\/[\w.-]+(:\d+)?$/.test(d.url)) return json({ error: 'bad request' }, 400);
        const name = String(d.name || '').slice(0, 40), key = hostKey(id);
        let h = await env.SUBS.get(key, 'json'), isNew = false;
        if (!h) {   // 第一次：記住 th（先到先得）
          const ids = (await env.SUBS.get('hosts', 'json')) || [];
          if (ids.length >= 500) return json({ error: 'too many hosts' }, 429);
          h = { th: d.th, devs: [], ts: 0 }; isNew = true;
          if (!ids.includes(id)) { ids.push(id); await env.SUBS.put('hosts', JSON.stringify(ids)); }
        }
        if (!await hostAuth(h, d, ['host', id, d.ts, d.url, name])) return json({ error: 'bad signature' }, 403);
        const t = Date.now(), back = h.down;
        // 省 KV 寫入（免費方案每天 1000 次）：網址或名字沒變、上次寫入不到 9 分鐘、也不是剛恢復，就不寫
        const need = isNew || back || h.url !== d.url || h.name !== name || t - (h.seen || 0) > 9 * 60000;
        h.url = d.url; h.name = name; h.ts = +d.ts;
        if (back) { delete h.down; await hostPush(env, h, { title: '✅ 執行器主機恢復上線', body: `「${name || id}」又開始回報了。`, url: './#bot', tag: 'hx-' + id }); }
        if (need) { h.seen = t; delete h.dirty; await env.SUBS.put(key, JSON.stringify(h)); }
        return json({ ok: true, devs: (h.devs || []).length });
      }
      if (p === '/host' && req.method === 'GET') {   // App 找執行器網址
        const id = u.searchParams.get('id') || '', k = u.searchParams.get('k') || '';
        const h = HID.test(id) && await env.SUBS.get(hostKey(id), 'json');
        if (!h || !same(h.th, k)) return json({ error: 'not found' }, 404);
        return json({ url: h.url || '', name: h.name || '', lastSeen: h.seen || 0, online: !h.down && Date.now() - (h.seen || 0) < OFF_MS });
      }
      if (p === '/host/notify' && req.method === 'POST') {
        const d = await req.json(), id = d && d.hostId, h = HID.test(id || '') && await env.SUBS.get(hostKey(id), 'json');
        const title = String(d.title || '').slice(0, 120), body = String(d.body || '').slice(0, 1500);
        if (!h || !await hostAuth(h, d, ['notify', id, d.ts, d.title, d.body])) return json({ error: 'bad signature' }, 403);
        const hr = Math.floor(Date.now() / 3600000);
        if (h.nh !== hr) { h.nh = hr; h.nn = 0; }
        if (++h.nn > 40) return json({ error: 'too many' }, 429);   // 每小時最多 40 則
        h.ts = +d.ts;
        const sent = await hostPush(env, h, { title: title || 'HexStack 執行器', body, url: './#bot', tag: undefined });
        await env.SUBS.put(hostKey(id), JSON.stringify(h));
        return json({ ok: true, sent });
      }
      if (p === '/host/pair' && req.method === 'POST') {   // App 綁定這台裝置的推播到主機
        const d = await req.json(), id = d && d.hostId, h = HID.test(id || '') && await env.SUBS.get(hostKey(id), 'json');
        if (!h || !same(h.th, d.k)) return json({ error: 'not found' }, 404);
        const sk = d.endpoint && await idOf(String(d.endpoint));
        if (!sk || !await env.SUBS.get(sk)) return json({ error: 'not subscribed' }, 404);
        h.devs = (h.devs || []).filter(x => x !== sk); if (!d.off) h.devs.push(sk); h.devs = h.devs.slice(-10);
        await env.SUBS.put(hostKey(id), JSON.stringify(h));
        return json({ ok: true, devs: h.devs.length });
      }
      if (p === '/stats') { if (!authed(req, env)) return json({ error: 'unauthorized' }, 401); return json({ subs: (await allSubs(env)).length }); }
      return json({ name: 'HexStack push', ok: true });
    } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  }
};
