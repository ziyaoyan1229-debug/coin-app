@echo off
rem 給 Windows「工作排程器」每天呼叫用；結果記在 run.log
cd /d "%~dp0"
python fetch_portfolio.py >> run.log 2>&1
