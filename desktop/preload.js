// 在網頁載入前執行：讓網站知道自己在電腦版裡，並自動跟這台電腦的執行器配對
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('hs:info');
const ON_SITE = location.origin === 'https://ziyaoyan1229-debug.github.io' || location.origin === info.site;

// 自動配對：還沒配對過、或配對的就是這台電腦的執行器（更新網址）才寫入；配對到別台主機的不動。回傳現在有沒有配對到這台
function pair() {
  try {
    if (!ON_SITE) return false;
    const p = ipcRenderer.sendSync('hs:pair');
    if (!p) return false;
    let cur = null; try { cur = JSON.parse(localStorage.getItem('botHost')); } catch (e) {}
    if (cur && cur.h && cur.h !== p.h) return false;
    const next = Object.assign({}, cur || {}, p);
    if (JSON.stringify(next) !== JSON.stringify(cur)) localStorage.setItem('botHost', JSON.stringify(next));
    return true;
  } catch (e) { return false; }
}

contextBridge.exposeInMainWorld('hexDesktop', Object.assign({}, info, {
  openConsole: () => ipcRenderer.send('hs:console'),
  // 執行器比網頁晚好：網頁沒配對時會再呼叫 pair() 重試；status() 給畫面顯示沒連上的原因
  pair,
  status: () => ipcRenderer.sendSync('hs:status'),
  // Google 登入改在系統瀏覽器做，結果由 onLogin 交回：{ token, email } 或 { error }
  login: () => ipcRenderer.send('hs:login'),
  onLogin: cb => { ipcRenderer.removeAllListeners('hs:login-done'); ipcRenderer.on('hs:login-done', (e, j) => cb(j)); },
  // 新版：update() → { cur, v, auto }（v 空的＝已是最新）；installUpdate(onProg) 下載並安裝，onProg 收 0～1 的進度，失敗回 { error }
  update: () => ipcRenderer.invoke('hs:upd'),
  installUpdate: onProg => { ipcRenderer.removeAllListeners('hs:upd-prog'); if (onProg) ipcRenderer.on('hs:upd-prog', (e, p) => onProg(p)); return ipcRenderer.invoke('hs:upd-go'); }
}));

pair();
