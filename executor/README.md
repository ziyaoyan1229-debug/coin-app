# HexStack 執行器（hexbot）

把 App 裡的策略放到自己的電腦或舊手機上 24 小時跑，到時間自動照回測引擎下單。
跟 App 用同一套回測引擎（自動跟著網站更新），手機 App 掃 QR 配對後就能看狀態、加策略、暫停。

> ⚠️ 自動交易有虧損風險。執行器預設是**模擬盤**；Bybit 介面照官方文件寫好了，但**還沒在真的帳戶上測過**，請一定先用測試網（testnet）。

## 下載

到 GitHub 的 Releases 頁面（標籤 `bot-v…`）下載：

| 電腦 | 檔案 |
|---|---|
| Windows | `hexbot.exe` |
| Mac（M1／M2／M3…） | `hexbot-macos-arm64.zip` |
| Mac（Intel） | `hexbot-macos-x64.zip` |
| Linux | `hexbot-linux-x64.tar.gz` |
| 已經裝了 Node.js 18 以上／Android 手機 | `hexbot.js`（或 `hexbot-js.zip`） |

建議放在一個自己的資料夾（例如「文件／HexStack」），執行器會在旁邊建 `hexbot-data` 資料夾存設定和紀錄。

## Windows

1. 雙擊 `hexbot.exe`。
2. 出現藍色「Windows 已保護您的電腦」：按 **其他資訊 → 仍要執行**（檔案沒有付費簽章才會這樣）。
3. 防火牆詢問時按「允許」（手機要在同一個 Wi-Fi 直接連才需要）。
4. 瀏覽器會自動打開主控台 `http://localhost:8787/`，上面有配對 QR。
5. 黑色視窗不要關；關掉就停止執行。

用 `hexbot.js` 的話：先到 <https://nodejs.org> 裝 LTS 版，把 `hexbot.js` 和 `啟動執行器.bat` 放在同一個資料夾，雙擊 bat。

## Mac

1. 解壓 zip，得到 `hexbot`。
2. 第一次：在 Finder 對 `hexbot` **按右鍵 → 打開 → 打開**。
   若還是被擋：「系統設定 → 隱私權與安全性」最下面按「強制打開」；或在「終端機」執行
   `xattr -dr com.apple.quarantine ~/Downloads/hexbot`（換成你放的位置）。
3. 終端機視窗不要關。打開瀏覽器 `http://localhost:8787/` 看主控台。

## 不要讓電腦睡著

螢幕可以關，但電腦不能睡眠，不然會漏單（App 會推「主機離線」通知）。

- **Windows**：設定 → 系統 → 電源 → 「螢幕關閉」可設 5 分鐘，「睡眠」設 **永不**（筆電要插電）。
- **Mac**：系統設定 → 電池（或能源）→ 開啟「顯示器關閉時防止自動進入睡眠」（筆電要接電源、蓋子不要闔上）。
  或在終端機用 `caffeinate -i ./hexbot` 來啟動。
- 斷網／睡眠回來後：離線期間出現的進場訊號，**現價離訊號價 0.5% 以內才補單**，超過就略過並記錄（可在 config.json 改 `catchupPct`）。交易所上的停損單照常有效。

## 配對手機

主控台有 QR：用手機相機掃，會打開 App 並自動配對；或複製「配對碼」貼到 App 的執行器頁。
配對碼等於這台主機的密碼，不要給別人。執行器會自動開一條 Cloudflare 免費通道（`*.trycloudflare.com`，第一次會自動下載 `cloudflared`），
通道網址每次重開都會換，App 會透過推播後端自動找到新網址。不想對外連線可用 `--no-tunnel`（手機就只能在同一個 Wi-Fi 用）。

## 接 Bybit（先用測試網）

1. 先到 <https://testnet.bybit.com> 註冊測試網帳號、領測試 USDT。
2. 帳號 → API → 建立新金鑰（系統產生）：
   - 權限只勾 **合約（Contract）交易／Orders、Positions**。
   - **不要勾提幣（Withdraw）**，也不要開轉帳。
   - 建議綁定 IP（家裡網路的對外 IP）。
3. 在**執行器那台電腦**打開 `http://localhost:8787/`，「交易所設定」選 Bybit、勾測試網、貼上 Key 和 Secret，按「儲存並測試連線」。
   （API Key 只能在這台電腦的主控台或 `hexbot-data/config.json` 設定，手機和遠端改不到。）
4. 合約帳戶用**單向持倉**（執行器啟動時會自動切換）。執行器會把槓桿設成風控上限的倍數。
5. 測試網跑順了，要用正式帳戶：主控台取消勾「測試網」、換正式網的 Key，並勾「允許正式網下單」（config.json 的 `allowLive: true`）。

## 策略怎麼跑

- 每小時整點過 1 分鐘（1 小時 K 收完），每個策略用最近 400 天資料跑一次回測，看「現在應該持有多少部位」，跟目前部位比，差多少下多少。出場一定執行。
- **試跑期**：新加的策略先在模擬盤跑 7 天；期滿而且「真實 vs 回測」沒有偏離，才能在 App 按「轉正」到交易所執行。
- **手動操作保護**：每分鐘對帳，發現交易所部位被人改過（不是執行器下的單），就暫停這個幣的策略、推通知，不會跟你對打。按「恢復」後，你手動留下的部位執行器不會去動。
- **偏離回測自動暫停**：平均滑價超過回測假設 3 倍（至少 3 筆成交），或漏單／略過 2 筆以上，就暫停並通知。
- **帳戶煞車**（App 或 `config.json` 的 `limits` 可改）：
  - `maxPosPct` 單一策略部位名目價值 ≤ 權益的 30%
  - `maxLev` 帳戶總槓桿 ≤ 3 倍
  - `dayLossPct` 單日（台北時間）虧損 ≥ 5% → 暫停所有策略
  - `maxDDPct` 從高點回撤 ≥ 20% → 全部平倉並暫停
- 每天早上 8:00（台北）推一則每日報告。

## 舊 Android 手機當主機（Termux）

1. 從 **F-Droid** 安裝 Termux（Play 商店版太舊不要用）：<https://f-droid.org/packages/com.termux/>
2. 打開 Termux 輸入：
   ```
   pkg update && pkg install nodejs cloudflared
   termux-setup-storage
   curl -LO https://github.com/ziyaoyan1229-debug/coin-app/releases/latest/download/hexbot.js
   termux-wake-lock
   node hexbot.js
   ```
   （`cloudflared` 套件裝不起來也沒關係，執行器會自己下載。）
3. 手機設定 → 應用程式 → Termux → 電池 → **不限制／不要最佳化**；通知欄的 Termux 常駐通知不要滑掉。
4. 一直插著充電，放在 Wi-Fi 穩定的地方。可以把螢幕調暗、關掉其他 App。
5. 主控台：在同一支手機的瀏覽器開 `http://localhost:8787/`，用另一支手機掃 QR 配對（或複製配對碼）。

## 其他

- 資料夾 `hexbot-data/`：`config.json` 設定（含配對 token、API Key，**不要分享**）、`state.json` 狀態、`log.jsonl` 紀錄、`cache/` 快取（K 線、引擎、cloudflared）。
- 換電腦：把整個 `hexbot-data` 複製過去就好（配對不用重做）。
- 重新配對（換 token）：關掉執行器，刪掉 config.json 裡的 `token` 那一行再開。
- 參數：`--port 8787`、`--no-tunnel`、`--no-open`（不要自動開瀏覽器）、`--dir 資料夾`、`--replay 14`（用最近 14 天歷史資料快轉測試，不會下單，結果在 `hexbot-data/replay/`）。
- K 線來源：Binance 合約 → Bybit → GitHub data 分支（只有 BTC、ETH）。引擎從網站下載並每 24 小時檢查更新。
