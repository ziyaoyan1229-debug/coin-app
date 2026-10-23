# HexStack 幣策略

BTC／ETH 策略回測與市場消息的手機網頁版（可加到主畫面）。

網址：https://ziyaoyan1229-debug.github.io/coin-app/

- `index.html`：主程式（約 330 KB）。原本由舊專案 `heap-strategy/app/mobile/build_mobile.py` 從桌面版 `ui.html` 產生，但最新版原始碼沒有搬過來，**現在直接改這個檔**。
- `assets/`：內建歷史資料（`data-*.js`、`ign-*.js`、`stk-*.js`）和圖表庫（`lwc-*.js`），檔名帶內容雜湊，手機快取後發新版不用重下載。內容有改就換新檔名，並同步改 `index.html` 的 `<script src>` 和 `sw.js` 的 `ASSETS`。
- 內建歷史資料：BTC／ETH 1 小時 K 到 2026-09-30、MSTR／MSTU 日線到 2026-10-09；之後的 K 線、資金費率和策略 8 的 5 分點火，開網頁時從 Binance 補上（只在瀏覽器裡，不寫回檔案）；Binance 連不到時改用 data 分支的 15 分 K。
- `news.json`：重大消息與市場分析，由財務部・投資組每 4 小時更新，改程式時不要動。
- `manifest.json`、`sw.js`、`icon-*.png`：加到主畫面與離線使用。**每次發版 `sw.js` 的 `coin-app-vNN` 要加 1**，手機才會換新版。
- 發布：main 推到 gh-pages 就上線。
- `.github/workflows/klines.yml`：每 15 分鐘把 BTC／ETH 的 15 分、5 分 K、模擬盤結果 `paper.json`（`scripts/paper.py`，規則在 `scripts/s03_live.py`：10/24 起規則 5 S-04＋S-07，S-03、S-01b 只記訊號）、市場分析歷史 `news_history.json`（`scripts/news_history.py`）寫到 `data` 分支。網站的模擬盤、過去分析分頁讀這裡。
