# M3 交接說明（通訊與集中式狀態管理）

> **更新：2026-08-22** — `app.py` M3 埋點已全數合入 main（含 M1/M2 影像解碼改動），
> swarm_logic 已增強（邊界轉向、打招呼持續、有機漫遊），測試與啟動工具已補齊。
> 原始 diff 檔 `app.py.M3-pending.diff` 已歸檔（僅留作變更歷史參考）。

---

## 1. 已完成並已提交

### 第一輪（commit c0c4baa，分支 feature/m3-event-logging-stress）

| 檔案 | 內容 |
|------|------|
| `backend/event_logger.py` | 結構化 JSON lines 事件 log 落地（技術架構文件 5.3 節，原本 0%）。執行緒安全、自動移除影像欄位、每日輪替。 |
| `backend/stress_test.py` | 承載量壓測，模擬 N 角色同時在場，量測廣播頻率/抖動（第 6 節 ≥30）。 |
| `backend/analyze_log.py` | 從 log 算出第 6 節效能指標（生成延遲、CV/VLM 子流程、失敗率、承載量）。 |
| `backend/bench_generate.py` | 用預存照片自動連續觸發 `generate_avatar` 取生成延遲基準線。 |
| `INTERFACES.md` | 依實際程式碼重寫 5.2 節事件表 + payload 欄位 + VLM/CV 覆蓋規則。 |
| `requirements.txt` | 補齊實際相依（原本漏列 socketio/pillow-heif/google-generativeai 等）。 |
| `.gitignore` | 排除 `backend/logs/`、`*.jsonl`、暫存/診斷檔。 |
| `.env.example` | 記錄 `EVENT_LOG_ENABLED` / `GEN_MAX_CONCURRENT` 兩個 M3 env var。 |

### 第二輪（2026-08-22 合入 main）

| 檔案 | 內容 |
|------|------|
| `backend/app.py` | **M3 埋點全數合入**：disconnect 角色清理、get_swarm handler、生成併發閘門（semaphore）、全流程 log 埋點（connect/disconnect/join/leave/update/generate/encounter/summary）、avatar_progress 進度推送 |
| `backend/swarm_logic.py` | **Boids 增強**：邊界柔性轉向（不再瞬移穿牆）、有機漫遊微力、打招呼持續 1.5s（greeting_ticks）、相遇減速揮手 |
| `backend/event_logger.py` | 新增 `set_log_dir()` 支援測試時重定向 log 目錄 |
| `backend/tests/test_swarm_logic.py` | Boids 單元測試（邊界、漫遊、打招呼狀態機） |
| `backend/tests/test_event_logger.py` | 事件 log 單元測試（隱私遮除、JSONL 格式、Timer） |
| `backend/test_socket.py` | 重構為安全模組（缺少 python-socketio 時不崩潰） |
| `frontend/socket.js` | 後端連線位址改為動態偵測（支援 LAN 展示） |
| `frontend/projection.html` | 同上，投影牆亦改為動態連線 |
| `start.sh` | 一鍵啟動腳本（後端 + 前端 + LAN IP 顯示） |

### 實測基準數據（30 角色壓測）
```
30/30 角色成功加入（988 ms）
廣播頻率 : 9.45 Hz          (目標 ≈ 10 Hz)  ✅
廣播間隔 p50/p95/max : 106 / 114.8 / 137.6 ms
承載量 ≥ 30 : ✅ 通過
```

---

## 2. ✅ `backend/app.py` 改動已合入（原§2 已解決）

原本因 M1/M2 影像解碼改動交錯無法單獨提交的問題，已透過直接 apply diff 完整合入。
原始 diff 存於 `docs/m3/app.py.M3-pending.diff`（僅作歷史參考）。

---

## 3. 🔴 待辦（需要人工處理）

- [ ] **輪替 OpenRouter API key**。見 .env.example 說明。
- [ ] **跑一次生成延遲基準線**取得真數據（需真照片 + 少量 Gemini 額度）：
      ```bash
      bash start.sh --backend                     # 終端 A
      python3 backend/bench_generate.py --image 某張測試照.jpg --runs 5   # 終端 B
      python3 backend/analyze_log.py               # 看生成延遲 p50/p90
      ```

---

## 4. 工具速查

```bash
# 一鍵啟動（後端 + 前端靜態伺服器，自動偵測 LAN IP）
bash start.sh

# 僅後端
bash start.sh --backend

# 承載量壓測（先啟動後端）
python3 backend/stress_test.py --chars 30 --duration 8

# 跑單元測試
python3 -m unittest discover -s backend/tests -p "test_*.py" -v

# 從 log 算第 6 節效能指標
python3 backend/analyze_log.py            # 今天的 log
python3 backend/analyze_log.py --glob     # 合併所有 log

# 關閉事件 log（純渲染測試時）
EVENT_LOG_ENABLED=0 python3 backend/app.py
```

事件 log 位置：`backend/logs/events-YYYYMMDD.jsonl`（已 gitignore，不進版控）。
事件與 payload 規格見 [`INTERFACES.md`](../../INTERFACES.md)。
