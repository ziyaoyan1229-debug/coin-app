// HexStack 推播後端（Cloudflare Worker，免費方案）：收手機的推播訂閱，幫任何程式把通知推到 iPhone／Android／電腦。
// 由 .github/workflows/push.yml 自動部署；KV（SUBS）存訂閱與 VAPID 金鑰（第一次用到時自動產生），PUSH_KEY 是發送用密鑰（部署時設定）。
//   GET  /vapid                         → { key }：給 App 訂閱用的公鑰
//   POST /sub    { sub, cats, off }      → 登記或更新一台裝置（cats＝要收的類別，off＝策略信號裡關掉的策略）
//   POST /unsub  { endpoint }            → 取消
//   POST /send   Authorization: Bearer <PUSH_KEY>
//                { items: [{ title, body, url, cat, st, tag }] }  → 推給有開該類別的裝置；回 { sent, gone, failed }
//   GET  /stats  Authorization: Bearer <PUSH_KEY> → { subs }
// 其他程式要推通知：照 /send 的格式送一個 POST 就好（cat 不填＝所有裝置都收）。
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
const idOf = async ep => 'sub:' + b64u(await S.digest('SHA-256', enc.encode(ep))).slice(0, 32);
const authed = (req, env) => env.PUSH_KEY && req.headers.get('authorization') === 'Bearer ' + env.PUSH_KEY;
async function allSubs(env) {
  const out = []; let cursor;
  do { const r = await env.SUBS.list({ prefix: 'sub:', cursor }); for (const k of r.keys) { const v = await env.SUBS.get(k.name, 'json'); if (v) out.push([k.name, v]); } cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', 'access-control-max-age': '86400' } });
    try {
      if (p === '/vapid') return json({ key: (await vapid(env)).pub });
      if (p === '/sub' && req.method === 'POST') {
        const d = await req.json(), s = d && d.sub;
        if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: 'bad subscription' }, 400);
        const rec = { sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, cats: d.cats || {}, off: d.off || {}, at: Date.now() };
        await env.SUBS.put(await idOf(s.endpoint), JSON.stringify(rec));
        return json({ ok: true });
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
            if (m.cat === 'sig' && m.st && r.off[m.st]) continue;
            try {
              const res = await pushOne(v, r.sub, { title: String(m.title || 'HexStack').slice(0, 120), body: String(m.body || '').slice(0, 1500), url: m.url || './#notify', tag: m.tag || undefined });
              if (res.status === 404 || res.status === 410) { await env.SUBS.delete(k); gone++; break; }
              if (res.ok) sent++; else failed++;
            } catch (e) { failed++; }
          }
        }
        return json({ sent, gone, failed, subs: subs.length });
      }
      if (p === '/stats') { if (!authed(req, env)) return json({ error: 'unauthorized' }, 401); return json({ subs: (await allSubs(env)).length }); }
      return json({ name: 'HexStack push', ok: true });
    } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  }
};
