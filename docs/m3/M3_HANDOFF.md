# M3 交接說明（通訊與集中式狀態管理）

> 這份文件記錄 M3 這一輪的交付、**尚未提交的 `app.py` 改動**、以及需要協調 / 待辦的事項。
> 給組員對接用。對應 commit：`c0c4baa`（分支 `feature/m3-event-logging-stress`）。

---

## 1. 已完成並已提交（commit c0c4baa）

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

### 實測基準數據（30 角色壓測）
```
30/30 角色成功加入（988 ms）
廣播頻率 : 9.45 Hz          (目標 ≈ 10 Hz)  ✅
廣播間隔 p50/p95/max : 106 / 114.8 / 137.6 ms
承載量 ≥ 30 : ✅ 通過
```

---

## 2. ⚠️ 尚未提交的 `backend/app.py` 改動（需協調）

M3 的 app.py 埋點**已寫好並實測通過**，但**沒有**跟著上面的 commit 一起提交。

**原因**：`app.py` 在我開工前的工作區裡，已經混了別組（M1/M2）**未提交**的影像 decode / CV 改動
（robust HEIC 解碼、diagnostic dump、CV 並行化、body_poly fallback）。這些改動與我的 M3 埋點
**深度交錯在 `handle_generate_avatar` 的同一段連續程式碼**（例如 M3 的 `_cv_start` 量測就夾在
別組的 `fut_cv = _executor.submit(...)` 中間），無法在不動別組程式碼的前提下只抽出 M3 部分
而不破壞語法。

**完整 diff 存於**：[`docs/m3/app.py.M3-pending.diff`](./app.py.M3-pending.diff)

### M3 在 app.py 的改動清單（行號以目前工作區為準）

| 位置 | 改動 | 屬性 |
|------|------|------|
| 36–39 | `import log_event, Timer` | 純新增 |
| 120–128 | `_GEN_MAX_CONCURRENT` / `_gen_semaphore` / `_gen_waiting` 佇列狀態 | 純新增 |
| 177 | `handle_connect` 加 `log_event("connect")` | 加一行 |
| 185–195 | `handle_disconnect` 從 `pass` → 移除 `char_id == sid` 的角色 + log | 取代 |
| 259 | `_req_start` 生成延遲量測起點 | 加一行 |
| 263–266 | `_timings` dict + `_elapsed_ms()` | 純新增 |
| 271–286 | generate_avatar 併發閘門（semaphore acquire + 排隊 log） | 純新增，**包住既有邏輯** |
| 293 / 362 / 369 / 401–404 | `_vlm_start` / `_cv_start` / `cv_ms` / `vlm_ms` / VLM 成敗旗標 | **夾在別組 CV/VLM 呼叫中間** |
| 507–510 / 530–531 | 成功 / 失敗兩分支都 `log_event("avatar_generated", ...)` | 加數行 |
| 535 | `finally: _gen_semaphore.release()` | 加一行 |
| 568 / 580 / 596 / 606 | join / leave / update_character / get_swarm 的 log | 加數行 |
| 600–606 | **新增 `handle_get_swarm`**（原本後端缺這個 handler，投影牆 emit 了但沒人接） | 純新增 handler |
| 611–642 | `_swarm_background` tick 加相遇事件 `character_encounter` + `swarm_summary` 彙總 | 加數行 |

### 合入步驟（建議）
1. 請寫影像 decode / CV 那位組員**先把他 app.py 那部分 commit 掉**。
2. 之後 M3 的 app.py 改動就能乾淨地疊在上面 commit（衝突面小，多半是新增行）。
3. 若要現在就合，可直接把工作區現狀 commit（含別組未提交部分），但那會把別組未完成/未審查的
   改動掛在 M3 commit 下——不建議。

---

## 3. 🔴 待辦（需要人工處理）

- [ ] **輪替 OpenRouter API key**。開工前工作區的 `.env.example` 裡 `OPENAI_API_KEY` 被改成了
      一把**真 key**（我 commit 前已改回佔位符 `sk-or-v1-...`，未推進版控）。但這把 key 曾出現在
      本機、且早期 commit 歷史可能也含它——請到 OpenRouter 後台**撤銷並重發**，新 key 只放
      `.env`（已 gitignore），絕不放 `.env.example`。技術架構文件第 8 節列的資安風險。
- [ ] **跑一次生成延遲基準線**取得真數據（需真照片 + 少量 Gemini 額度）：
      ```bash
      .venv/bin/python backend/app.py            # 終端 A：啟動後端（先合入 §2 的 app.py）
      .venv/bin/python backend/bench_generate.py --image 某張測試照.jpg --runs 5   # 終端 B
      .venv/bin/python backend/analyze_log.py    # 看生成延遲 p50/p90 + CV/VLM 子流程 + 失敗率
      ```

---

## 4. 工具速查

```bash
# 承載量壓測（先啟動後端）
.venv/bin/python backend/stress_test.py --chars 30 --duration 8

# 生成延遲基準線
.venv/bin/python backend/bench_generate.py --image photo.jpg --runs 5 --mode body_sprite

# 從 log 算第 6 節效能指標
.venv/bin/python backend/analyze_log.py            # 今天的 log
.venv/bin/python backend/analyze_log.py --glob     # 合併所有 log

# 關閉事件 log（純渲染測試時）
EVENT_LOG_ENABLED=0 .venv/bin/python backend/app.py
```

事件 log 位置：`backend/logs/events-YYYYMMDD.jsonl`（已 gitignore，不進版控）。
事件與 payload 規格見 [`INTERFACES.md`](../../INTERFACES.md)。
