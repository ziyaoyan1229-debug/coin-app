// HexStack 電腦版（Electron 外殼）
// 視窗直接開網站版 App（和手機同一套、自動更新、Google 登入同步）；背景內建執行器（executor/hexbot.js），
// 第一次打開會自動跟這台電腦的執行器配對，不用掃 QR。關掉視窗只是收到系統匣，執行器繼續跑；選單「結束」才會停。
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, powerSaveBlocker, utilityProcess, dialog, nativeImage } = require('electron');
const path = require('path'), fs = require('fs');

const SITE = process.env.HEXSTACK_SITE || 'https://ziyaoyan1229-debug.github.io/coin-app/';   // HEXSTACK_SITE：開發時指到本機網站測試
const REL = 'https://github.com/ziyaoyan1229-debug/coin-app/releases';
const DATA = path.join(app.getPath('userData'), 'hexbot-data');
const PREF = path.join(app.getPath('userData'), 'prefs.json');
const ICON = path.join(__dirname, 'icon.png');
const HEXBOT = app.isPackaged ? path.join(process.resourcesPath, 'hexbot.js') : path.join(__dirname, 'hexbot.js');

const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
let prefs = Object.assign({ awake: true, botOn: true }, readJ(PREF, {}));
const savePrefs = () => { try { fs.writeFileSync(PREF, JSON.stringify(prefs)); } catch (e) {} };

// Google 不讓內嵌瀏覽器登入：拿掉 UA 裡的 Electron／App 名字，看起來就是一般 Chrome
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|HexStack|hexstack-desktop)\/\S+/g, '');

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => showWin());

let win = null, tray = null, bot = null, botLog = [], quitting = false, blocker = null, restarts = 0;

// ── 執行器 ──
function startBot() {
  if (bot || !prefs.botOn) return;
  if (!fs.existsSync(HEXBOT)) { botLog.push('找不到執行器檔案'); return; }
  fs.mkdirSync(DATA, { recursive: true });
  bot = utilityProcess.fork(HEXBOT, ['--no-open', '--dir', DATA], { stdio: 'pipe', serviceName: 'HexStack 執行器' });
  const keep = d => { botLog.push(...String(d).split(/\r?\n/).filter(Boolean)); if (botLog.length > 300) botLog = botLog.slice(-300); };
  bot.stdout && bot.stdout.on('data', keep); bot.stderr && bot.stderr.on('data', keep);
  bot.on('exit', code => {
    bot = null; keep('執行器結束（' + code + '）');
    // 意外結束就自動重開（最多連續 5 次，間隔越拉越長）
    if (!quitting && prefs.botOn && restarts < 5) { restarts++; setTimeout(startBot, 5000 * restarts); }
    menu();
  });
  setTimeout(() => { restarts = 0; }, 120000);
  menu();
}
function stopBot() { if (bot) { try { bot.kill(); } catch (e) {} bot = null; } }

// 這台電腦執行器的配對資料（給網頁自動配對用）：通道網址用 localhost，同一台電腦最快也最穩
function pairInfo() {
  const c = readJ(path.join(DATA, 'config.json'), null);
  if (!c || !c.token) return null;
  return { u: 'http://localhost:' + (c.port || 8787), k: c.token, h: c.hostId, n: c.hostName || '這台電腦' };
}
ipcMain.on('hs:pair', e => { e.returnValue = prefs.botOn ? pairInfo() : null; });
ipcMain.on('hs:info', e => { e.returnValue = { ver: app.getVersion(), platform: process.platform, bot: !!bot, site: new URL(SITE).origin }; });
// 網頁連不上執行器時拿來顯示原因：有沒有開、有沒有在跑、最後幾行輸出
ipcMain.on('hs:status', e => { e.returnValue = { botOn: !!prefs.botOn, running: !!bot, cfg: !!pairInfo(), log: botLog.slice(-8) }; });
ipcMain.on('hs:console', () => openConsole());

// ── Google 登入：Google 不讓 App 內嵌視窗登入，改開系統瀏覽器到網站的 desktop-login.html，
//    登入完那頁把結果導回 http://127.0.0.1:<臨時埠>/done，這裡收到再交給網頁 ──
let loginSrv = null;
ipcMain.on('hs:login', e => startLogin(e.sender));
function startLogin(wc) {
  const state = require('crypto').randomBytes(16).toString('hex');
  if (loginSrv) try { loginSrv.close(); } catch (x) {}
  const srv = loginSrv = require('http').createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/done' || u.searchParams.get('s') !== state) { res.writeHead(404); return res.end(); }
    const t = u.searchParams.get('t'), em = u.searchParams.get('e') || '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>HexStack</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#160b34;color:#efeaff;font:16px -apple-system,\'Microsoft JhengHei\',sans-serif;text-align:center"><div><h2>登入成功</h2><p style="opacity:.75">可以關掉這個分頁，回到 HexStack。</p></div></body>');
    if (!wc.isDestroyed()) wc.send('hs:login-done', t ? { token: t, email: em } : { error: '沒有拿到登入結果' });
    showWin(); setTimeout(() => { try { srv.close(); } catch (x) {} if (loginSrv === srv) loginSrv = null; }, 1000);
  });
  srv.listen(0, '127.0.0.1', () => shell.openExternal(SITE + 'desktop-login.html?p=' + srv.address().port + '&s=' + state));
  // 10 分鐘沒登入就收掉
  setTimeout(() => { try { srv.close(); } catch (x) {} if (loginSrv === srv) loginSrv = null; }, 600000);
}

// ── 防止睡眠 ──
function applyAwake() {
  if (prefs.awake && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!prefs.awake && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
}

// ── 視窗 ──
function showWin() { if (!win) return createWin(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function createWin() {
  win = new BrowserWindow({
    width: 1180, height: 860, minWidth: 380, minHeight: 600, title: 'HexStack', icon: ICON, backgroundColor: '#160b34', show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(SITE);
  // 網站內的連結：Google 登入視窗留在 App 裡（登入要回傳結果），其他外部連結用預設瀏覽器開
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Google 不讓 App 內嵌視窗登入：任何 Google 登入視窗都改成在系統瀏覽器登入
    if (/^https:\/\/accounts\.google\.com\//.test(url)) { startLogin(win.webContents); return { action: 'deny' }; }
    if (url.startsWith(SITE)) { win.loadURL(url); return { action: 'deny' }; }
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(SITE)) { e.preventDefault(); if (/^https:\/\/accounts\.google\.com\//.test(url)) startLogin(win.webContents); else shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (e, code, desc, url, main) => {
    if (!main || code === -3) return;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#160b34;color:#efeaff;font:15px -apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;text-align:center"><div><h2>連不上網路</h2><p style="opacity:.75">HexStack 需要網路才能打開。執行器在背景照常運作。</p><button onclick="location.href='${SITE}'" style="margin-top:12px;padding:10px 22px;border-radius:999px;border:1px solid #c8a2ff66;background:#7a4cf033;color:#fff;font:inherit;cursor:pointer">重新連線</button></div></body>`));
  });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (process.platform === 'win32' && !prefs.trayTold && tray) { tray.displayBalloon({ title: 'HexStack 還在背景執行', content: '執行器會繼續跑。要完全關掉請在右下角圖示按右鍵 › 結束。', iconType: 'info' }); prefs.trayTold = true; savePrefs(); }
  });
  win.on('closed', () => { win = null; });
}

// 執行器主控台（設定交易所下單金鑰、看紀錄）：只在這台電腦上能開
function openConsole() {
  const c = readJ(path.join(DATA, 'config.json'), {});
  const w = new BrowserWindow({ width: 920, height: 800, title: 'HexStack 執行器主控台', icon: ICON, autoHideMenuBar: true, parent: win || undefined });
  w.loadURL('http://localhost:' + (c.port || 8787) + '/');
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showLog() {
  const w = new BrowserWindow({ width: 760, height: 560, title: '執行器紀錄', icon: ICON, autoHideMenuBar: true });
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<pre style="margin:0;padding:14px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap">' + esc(botLog.slice(-300).join('\n') || '（還沒有輸出）') + '</pre>'));
}

// ── 系統匣與選單 ──
function menu() {
  const login = app.getLoginItemSettings().openAtLogin;
  const items = [
    { label: '打開 HexStack', click: showWin },
    { label: '執行器主控台', click: openConsole, enabled: !!bot },
    { type: 'separator' },
    { label: bot ? '執行器：執行中' : '執行器：已停止', enabled: false },
    { label: '執行器', type: 'checkbox', checked: prefs.botOn, click: m => { prefs.botOn = m.checked; savePrefs(); restarts = 0; m.checked ? startBot() : stopBot(); menu(); } },
    { label: '防止電腦睡眠', type: 'checkbox', checked: prefs.awake, click: m => { prefs.awake = m.checked; savePrefs(); applyAwake(); } },
    { label: '開機自動啟動', type: 'checkbox', checked: login, click: m => { app.setLoginItemSettings({ openAtLogin: m.checked, openAsHidden: true, args: ['--hidden'] }); menu(); } },
    { label: '執行器紀錄', click: showLog },
    { type: 'separator' },
    { label: '檢查更新', click: () => checkUpdate(true) },
    { label: '版本 ' + app.getVersion(), enabled: false },
    { label: '結束 HexStack', click: () => { quitting = true; app.quit(); } }
  ];
  if (tray) { tray.setContextMenu(Menu.buildFromTemplate(items)); tray.setToolTip('HexStack' + (bot ? '（執行器執行中）' : '')); }
  if (process.platform === 'darwin') app.dock && app.dock.setMenu(Menu.buildFromTemplate(items.filter(x => x.label !== '結束 HexStack')));
}
function appMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'HexStack', submenu: [{ role: 'about', label: '關於 HexStack' }, { type: 'separator' }, { label: '執行器主控台', click: openConsole }, { label: '檢查更新', click: () => checkUpdate(true) }, { type: 'separator' }, { role: 'hide', label: '隱藏' }, { label: '結束 HexStack', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: '編輯', submenu: [{ role: 'undo', label: '復原' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪下' }, { role: 'copy', label: '拷貝' }, { role: 'paste', label: '貼上' }, { role: 'selectAll', label: '全選' }] },
    { label: '顯示', submenu: [{ role: 'reload', label: '重新載入' }, { role: 'resetZoom', label: '實際大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '縮小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全螢幕' }] },
    { label: '視窗', submenu: [{ role: 'minimize', label: '縮到最小' }, { role: 'close', label: '關閉視窗' }] }
  ]));
}

// ── 檢查新版：看 GitHub 上最新的 desktop-v*（每次打包都會發一版），有新版就跳通知；Windows 按「立即更新」會自己下載、安靜安裝、裝完自動重開。
//    網頁的開場畫面也會問（hs:upd），在那裡就能按更新；網頁問過就不再另外跳視窗 ──
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let updating = false, webAsked = 0, updProg = null;
async function findUpdate() {
  const r = await fetch('https://api.github.com/repos/ziyaoyan1229-debug/coin-app/releases?per_page=30', { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('查不到新版（HTTP ' + r.status + '）');
  const list = await r.json();
  const rel = list.filter(x => !x.prerelease && !x.draft && /^desktop-v\d+\.\d+\.\d+$/.test(x.tag_name)).map(x => Object.assign(x, { v: x.tag_name.replace(/^desktop-v/, '') }))
    .sort((a, b) => newer(a.v, b.v) ? -1 : newer(b.v, a.v) ? 1 : 0)[0];
  if (!rel || !newer(rel.v, app.getVersion())) return null;
  const exe = process.platform === 'win32' && (rel.assets || []).find(x => x.name === 'HexStack-Setup.exe');
  const notes = String(rel.body || '').split('\n').filter(l => /^\s*[-•]/.test(l) && !/Windows 已保護|簽章/.test(l)).slice(0, 6).join('\n');
  return { v: rel.v, exe, notes, url: rel.html_url };
}
async function checkUpdate(manual) {
  if (updating || (!manual && Date.now() - webAsked < 3600e3)) return;
  try {
    const u = await findUpdate();
    if (!u) { if (manual) dialog.showMessageBox({ type: 'info', buttons: ['好'], title: 'HexStack', message: '已經是最新版 ' + app.getVersion() }); return; }
    const { response } = await dialog.showMessageBox(win && win.isVisible() ? win : null, {
      type: 'info', buttons: u.exe ? ['立即更新', '稍後'] : ['下載新版', '稍後'], defaultId: 0, cancelId: 1, title: 'HexStack 有新版',
      message: 'HexStack 有新版 ' + u.v, detail: '目前 ' + app.getVersion() + '。' + (u.exe ? '按「立即更新」會自動下載並安裝，裝完自己重開，設定和執行器資料都會保留。' : '') + (u.notes ? '\n\n' + u.notes : '')
    });
    if (response !== 0) return;
    if (!u.exe) return shell.openExternal(u.url);
    await installUpdate(u.exe);
  } catch (e) { updating = false; if (win) win.setProgressBar(-1); if (manual) dialog.showMessageBox({ type: 'warning', buttons: ['好'], title: 'HexStack', message: '更新失敗', detail: e.message }); }
}
// 網頁問有沒有新版：{ cur, v, auto }（auto＝能在 App 裡直接裝）；沒新版 v 是空的
ipcMain.handle('hs:upd', async () => {
  webAsked = Date.now();
  try { const u = await findUpdate(); return { cur: app.getVersion(), v: u ? u.v : '', auto: !!(u && u.exe) }; } catch (e) { return { cur: app.getVersion(), v: '', error: e.message }; }
});
// 網頁按「立即更新」：下載進度用 hs:upd-prog 回報（0～1），裝的時候 App 會關掉再自己打開；失敗回 { error }
ipcMain.handle('hs:upd-go', async e => {
  if (updating) return { ok: true };
  try {
    const u = await findUpdate();
    if (!u) return { error: '已經是最新版' };
    if (!u.exe) { shell.openExternal(u.url); return { ok: true, opened: true }; }
    const wc = e.sender; updProg = p => { if (!wc.isDestroyed()) wc.send('hs:upd-prog', p); };
    await installUpdate(u.exe); return { ok: true };
  } catch (x) { updating = false; updProg = null; if (win) win.setProgressBar(-1); return { error: x.message }; }
});
async function installUpdate(asset) {
  updating = true;
  const f = path.join(app.getPath('temp'), 'HexStack-Setup-' + Date.now() + '.exe');
  const r = await fetch(asset.browser_download_url);
  if (!r.ok || !r.body) throw new Error('下載失敗（HTTP ' + r.status + '）');
  const total = +r.headers.get('content-length') || asset.size || 0, out = fs.createWriteStream(f);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length; out.write(Buffer.from(chunk));
    if (total) { const p = got / total; if (win) win.setProgressBar(p); if (updProg) updProg(p); if (tray) tray.setToolTip('HexStack 下載更新中 ' + Math.round(p * 100) + '%'); }
  }
  await new Promise((ok, no) => { out.on('error', no); out.end(ok); });
  if (total && got < total) throw new Error('下載不完整，請再試一次');
  if (win) win.setProgressBar(2);   // 不確定進度：安裝中
  // /S 安靜安裝，--force-run 裝完自動打開；先結束自己（含執行器），讓安裝程式能覆蓋檔案
  require('child_process').spawn(f, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  quitting = true; stopBot(); setTimeout(() => app.quit(), 300);
}

app.whenReady().then(async () => {
  // 網站有離線暫存（service worker）：電腦版每次打開先清掉，保證是最新版的網頁（登入資料、設定不受影響）
  try { await require('electron').session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }); } catch (e) {}
  appMenu();
  const img = nativeImage.createFromPath(ICON).resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(img); tray.on('click', showWin); tray.on('double-click', showWin);
  startBot(); applyAwake(); menu();
  // 第一次打開時執行器要先建好設定檔，網頁才能自動配對：最多等 8 秒
  if (!process.argv.includes('--hidden')) { const t0 = Date.now(); const go = () => (pairInfo() || !bot || Date.now() - t0 > 8000) ? createWin() : setTimeout(go, 300); go(); }
  setTimeout(() => checkUpdate(false), 8000);
  setInterval(() => checkUpdate(false), 6 * 3600e3);
});
app.on('activate', showWin);
app.on('window-all-closed', e => { /* 留在系統匣，執行器繼續跑 */ });
app.on('before-quit', () => { quitting = true; stopBot(); });
