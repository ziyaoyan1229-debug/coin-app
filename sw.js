// 離線快取：主程式先用快取、背景更新；news.json 先抓網路
// assets/ 裡是內建資料與圖表程式庫，檔名帶內容雜湊，放在獨立的 coin-assets 快取，發新版不必重下載
const C='coin-app-v33',A='coin-assets',FILES=['./','index.html','manifest.json','icon-192.png','icon-512.png','icon-180.png','favicon.svg'],
  ASSETS=['assets/lwc-30895550.js','assets/data-9d38fe23.js','assets/ign-d73dc36d.js','assets/stk-f42bd546.js'];
self.addEventListener('install',e=>{e.waitUntil(Promise.all([
  caches.open(C).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:'reload'})))),
  caches.open(A).then(c=>Promise.all(ASSETS.map(f=>c.match(f).then(m=>m||c.add(f)))))]));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C&&k!==A).map(k=>caches.delete(k)))),
  caches.open(A).then(c=>c.keys().then(ks=>Promise.all(ks.filter(r=>!ASSETS.some(f=>r.url.endsWith(f))).map(r=>c.delete(r)))))]));self.clients.claim()});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.origin!==location.origin)return;
  if(u.pathname.endsWith('news.json')){e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request)));return}
  if(u.pathname.includes('/assets/')){e.respondWith(caches.open(A).then(c=>c.match(e.request).then(m=>m||fetch(e.request).then(r=>{if(r.ok)c.put(e.request,r.clone());return r}))));return}
  e.respondWith(caches.match(e.request).then(m=>{const f=fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r}).catch(()=>m);return m||f}))});
