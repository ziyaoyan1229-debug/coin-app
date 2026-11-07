# K 線資料（自動產生）

由 main 的 .github/workflows/klines.yml 每 15 分鐘覆蓋，只有一個 commit。
欄位：open_time(ms, UTC), open, high, low, close, volume, taker_buy_base。來源 Binance 現貨 data-api.binance.vision，只含已收盤 K 棒。
