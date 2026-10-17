# 常用指令

> 由 [CLAUDE.md](../../CLAUDE.md) 拆出。這裡是踩過的坑與當初的取捨理由 ——
> 動到相關程式碼之前先讀，多數條目都附了「不這樣做會怎樣」。


### 整合版（主線）

```bash
# 一次安裝
npm install
pip install -r requirements.txt requirements-dev.txt   # mediapipe 已釘 <1.0

# 啟動：一行帶起兩個行程
bash start.sh                      # 生成服務 :5055 + 互動層 :3000
                                   # 偵測到 certs/ 就自動走 HTTPS（相機需要），
                                   # 沒有憑證則以 HTTP 啟動並說明代價

# 正式場次：一定要帶場次名稱，事件紀錄才不會混進工程師測試（見 FIELD-OPS「事件紀錄」）
PIXELAIR_SESSION=live-1019 bash start.sh    # → data/events/live-1019.jsonl
PIXELAIR_SESSION=rehearsal-1017 bash start.sh   # 彩排：非 live 開頭一律標為 test

# 或分別啟動（除錯時比較好看 log）
npm start                          # 互動層，印出大螢幕/手機/主辦端三個網址
python backend/service.py          # 角色生成服務（127.0.0.1:5055）

# 現場要用手機相機就必須有 HTTPS（getUserMedia 的硬性要求）
bash scripts/make-cert.sh
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start

# 後端測試
pip install -r requirements-dev.txt
python -m pytest backend/tests

# 一個人也能把場域填滿，實際玩一輪（開發／調校用，現場請勿使用）
npm run bots -- --count 9          # 湊滿 10 人，自己佔 1 個
npm run bots -- --colors           # 每種色族各保證一隻（測顏色任務）

# 多人同時生成的壓測：假的生圖上游，不花錢、不碰 :5055、不寫帳本
bash scripts/gen-burst/run.sh 3 --latency 13 --max-inflight 1

# 人物匯入台：把過去生成過的角色放回場上，每個都能單獨操控
# （開發／調校用，現場請勿使用 —— 匯入的角色一樣佔 MAX_AGENTS 名額）
python scripts/asset_colors.py     # 先補色票，不跑的話顏色任務會依假色判定
# 然後開 http://localhost:3000/dev/ ，輸入主辦端通行密鑰

# 匯出／匯入單一角色：主辦端「系統 → 角色生成紀錄」每列有「圖檔」（去背 PNG）
# 與「角色檔」（.persona.json，內含貼圖與外觀設定）。角色檔換一台電腦還原：
python scripts/import_character.py character-xxxxxxxx.persona.json   # 已存在時加 --force
# 還原後同樣到人物匯入台放上場（格式見 backend/character_export.py）

# 測試
npm test                           # Node 單元測試（370 + wander 模式 5）
npm run test:wander                # 只跑漫遊模式那一組（PIXELAIR_IDLE_MOTION=wander）
npm run test:e2e                   # 端對端，會自行啟動伺服器（147）
pytest backend/                    # Python（423）

# 切片比例驗證（計畫書 §3.3 的 R1 驗收項）
python backend/validate_cuts.py --photos samples/photos/ --out samples/sprites/
python backend/validate_cuts.py --sprites samples/sprites/ --sheet report.png
```

