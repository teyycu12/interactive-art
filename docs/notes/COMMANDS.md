# 常用指令

> 由 [CLAUDE.md](../../CLAUDE.md) 拆出。這裡是踩過的坑與當初的取捨理由 ——
> 動到相關程式碼之前先讀，多數條目都附了「不這樣做會怎樣」。


### 整合版（主線）

```bash
# 一次安裝
npm install
pip install -r requirements.txt requirements-dev.txt   # mediapipe 已釘 <1.0，見 LEGACY-2D.md

# 啟動：一行帶起兩個行程
bash start.sh                      # 生成服務 :5055 + 互動層 :3000
                                   # 偵測到 certs/ 就自動走 HTTPS（相機需要），
                                   # 沒有憑證則以 HTTP 啟動並說明代價

# 或分別啟動（除錯時比較好看 log）
npm start                          # 互動層，印出大螢幕/手機/主辦端三個網址
python backend/service.py          # 角色生成服務（127.0.0.1:5055）

# 現場要用手機相機就必須有 HTTPS（getUserMedia 的硬性要求）
bash scripts/make-cert.sh
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start

# 後端啟動
python backend/app.py

# 前端啟動（在專案根目錄執行）
python -m http.server 8000 --directory frontend

# 後端測試
pip install -r requirements-dev.txt
python -m pytest backend/tests

# 一個人也能把場域填滿，實際玩一輪（開發／調校用，現場請勿使用）
npm run bots -- --count 9          # 湊滿 10 人，自己佔 1 個
npm run bots -- --colors           # 每種色族各保證一隻（測顏色任務）

# 測試
npm test                           # Node 單元測試（330 + wander 模式 5）
npm run test:wander                # 只跑漫遊模式那一組（PERSONAFLOW_IDLE_MOTION=wander）
npm run test:e2e                   # 端對端，會自行啟動伺服器（125）
pytest backend/                    # Python（236）

# 切片比例驗證（計畫書 §3.3 的 R1 驗收項）
python backend/validate_cuts.py --photos samples/photos/ --out samples/sprites/
python backend/validate_cuts.py --sprites samples/sprites/ --sheet report.png
```

### 2D 備援版

```bash
bash start-2d.sh                   # 後端 5001 + 前端 8080
python backend/e2e_smoke.py        # 煙霧測試（需後端已啟動）
node --test frontend/tests/        # 前端測試
```

> **埠號**：備援版後端佔用 5001，生成服務刻意改用 5055，兩者可並存。

---

