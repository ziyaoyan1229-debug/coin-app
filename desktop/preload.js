// 在網頁載入前執行：讓網站知道自己在電腦版裡，並自動跟這台電腦的執行器配對
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('hs:info');
contextBridge.exposeInMainWorld('hexDesktop', Object.assign({}, info, {
  openConsole: () => ipcRenderer.send('hs:console'),
  // Google 登入改在系統瀏覽器做，結果由 onLogin 交回：{ token, email } 或 { error }
  login: () => ipcRenderer.send('hs:login'),
  onLogin: cb => { ipcRenderer.removeAllListeners('hs:login-done'); ipcRenderer.on('hs:login-done', (e, j) => cb(j)); }
}));

// 自動配對：還沒配對過、或配對的就是這台電腦的執行器（更新網址）才寫入；配對到別台主機的不動
try {
  if (location.origin === 'https://ziyaoyan1229-debug.github.io') {
    const p = ipcRenderer.sendSync('hs:pair');
    if (p) {
      let cur = null; try { cur = JSON.parse(localStorage.getItem('botHost')); } catch (e) {}
      if (!cur || !cur.h || cur.h === p.h) {
        const next = Object.assign({}, cur || {}, p);
        if (JSON.stringify(next) !== JSON.stringify(cur)) localStorage.setItem('botHost', JSON.stringify(next));
      }
    }
  }
} catch (e) {}
