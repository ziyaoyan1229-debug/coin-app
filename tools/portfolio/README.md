# 我的資產：交易所餘額彙整

在你自己的電腦上抓 Bybit、OKX、幣安、Bitget 的餘額與合約持倉，加密後上傳到幣策略 App，手機打開「我的資產」頁輸入密碼看。

- 金鑰只存在這台電腦的 `.env`，不會上傳（`.gitignore` 已排除）。
- 上傳的只有 `portfolio.enc.json`，AES-256-GCM 加密，金鑰由你的密碼經 PBKDF2（60 萬次）推導。沒有密碼打不開。
- 為什麼不在雲端跑：Bybit、幣安會擋非台灣地區的連線，要用你的電腦（台灣 IP）抓。

## 第一次設定

1. **開唯讀金鑰**：每家交易所的 API 管理頁建立新金鑰，只勾「讀取／Read」，不要勾交易、提領、轉帳。能綁 IP 就綁你家的 IP。OKX、Bitget 建立時會要你設一組 passphrase，也要記下來。
2. **裝 Python**（3.10 以上）：<https://www.python.org/downloads/>，安裝時勾「Add python.exe to PATH」。
3. **把 coin-app 抓到電腦上**：`git clone https://github.com/ziyaoyan1229-debug/coin-app.git`，並確認這台電腦能 `git push`（GitHub Desktop 登入過就可以）。
4. **裝套件**：在 `coin-app\tools\portfolio` 資料夾開命令提示字元，跑 `pip install -r requirements.txt`。
5. **填設定**：把 `.env.example` 複製成 `.env`，填入金鑰、`PORTFOLIO_PASSWORD`（至少 12 位、不跟其他帳號共用）和 `REPO_DIR`。
6. **試跑**：`python fetch_portfolio.py --dry-run`，只印結果、不加密不上傳。確認四家都是 OK、金額對。
7. **正式跑一次**：`python fetch_portfolio.py`，會加密並上傳。手機打開 <https://ziyaoyan1229-debug.github.io/coin-app/portfolio.html>，輸入密碼。

## 每天自動跑（Windows）

工作排程器 → 建立基本工作 → 每天（例如 07:30）→ 啟動程式 → 選 `run_daily.bat`。電腦要開著才會跑；頁面顯示超過 30 小時沒更新時會提醒。

## 安全提醒

- 程式會檢查 Bybit、幣安的金鑰是不是唯讀，不是就拒絕執行。OKX、Bitget 查不到，要你建立時自己確認。
- 懷疑金鑰外洩：直接到交易所刪掉金鑰，立刻失效；再換一組 `PORTFOLIO_PASSWORD`。
- `portfolio_latest.json` 是明文結果，只留在這台電腦。
