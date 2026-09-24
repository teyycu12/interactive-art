# PersonaFlow 模組間介面規格（歷史文件）

> [!WARNING]
> **這份規格描述的是已移除的 2D 備援版（`backend/app.py` + `frontend/`）。**
> 該版本已於 2026-09-10 整套刪除，本文件所列的 Socket.io 事件與 payload
> **不再對應任何執行中的程式碼**，只保留作為研究與變更歷史的紀錄。
>
> 現行系統的事件規格見 `shared/protocol.js`（單一真相源）與
> [docs/TECH-PersonaFlow2.md](TECH-PersonaFlow2.md)。

> 本文件依 **實際程式碼**（`backend/app.py`）逐項核對後撰寫，取代技術架構文件 v1.1 第 5.2 節中
> 那些用冒號分隔、且程式碼裡不存在的假想事件名。分工開發時**以本文件為介面基準**，
> 別組要接 M3 的通訊層請照這裡的事件名與 payload 欄位。
>
> 命名慣例：一律 **`動詞_名詞` snake_case**（沿用 CLAUDE.md），不使用冒號格式。
> 維護者：M3。事件或欄位變更時，改程式碼的同時更新本文件。

---

## 1. Socket.io 事件總表

| 事件名 | 方向 | 觸發 handler | 用途 |
|--------|------|-------------|------|
| `connect` | Socket.io 內建 | `handle_connect` | 連線建立；若已有角色會立即回一次 `update_positions` |
| `disconnect` | Socket.io 內建 | `handle_disconnect` | 斷線；**不移除角色**，僅更新 `last_seen`（見 §4） |
| `process_frame` | 前端 → 後端 | `handle_process_frame` | 即時預覽用的 CV 特徵擷取（非正式生成） |
| `clothing_features` | 後端 → 前端 | — | 回應 `process_frame`，含 fallback 旗標 |
| `generate_avatar` | 前端 → 後端 | `handle_generate_avatar` | 觸發正式 CV+VLM+face 並行生成 |
| `avatar_progress` | 後端 → 前端 | — | 生成進度（stage/pct/detail），生成期間多次推送 |
| `avatar_generated` | 後端 → 前端 | — | 生成結果（含失敗分支 `{ok:false}`） |
| `join_swarm` | 前端 → 後端 | `handle_join_swarm` | 角色加入群聚場 |
| `swarm_joined` | 後端 → 前端 | — | 確認加入，回傳 `{id}` |
| `leave_swarm` | 前端 → 後端 | `handle_leave_swarm` | 角色主動離場 |
| `update_character` | 前端 → 後端 | `handle_update_character` | 更新既有角色欄位（配件等） |
| `get_swarm` | 前端 → 後端 | `handle_get_swarm` | 主動索取一次目前全體狀態（投影牆連上時用） |
| `update_positions` | 後端 → **所有端** | `_swarm_background` tick | 每 0.1s 廣播全體角色（含 GREETING/ROAMING 狀態） |

---

## 2. Payload 欄位規格

### `process_frame`（前端 → 後端）
```json
{ "image": "data:image/jpeg;base64,..." }
```

### `clothing_features`（後端 → 前端）
```json
{
  "ok": true,
  "upper": { "hex": "#RRGGBB" },
  "lower": { "hex": "#RRGGBB" },
  "arm_color": { "hex": "#RRGGBB" },
  "upper_type": "short_sleeve | long_sleeve",
  "lower_type": "shorts | long_pants",
  "landmarks": [...],
  "roi": {...},
  "cloth_grid": {...},
  "lower_grid": {...},
  "fallback": false,          // true = 本次 CV 失敗，沿用上一次成功結果
  "last_success_ts": 0.0,
  "ts": 0.0
}
```
> 失敗時 `ok:false` 且欄位為上一次成功值（見 `_merge_fallback_payload`）。此 fallback **只給即時預覽用**，不供正式生成角色。

### `generate_avatar`（前端 → 後端）
```json
{
  "image": "data:image/jpeg;base64,...",
  "mode": "body_sprite | full_character | full_character_refined"  // 可省，預設讀 .env GENERATION_MODE
}
```

### `avatar_progress`（後端 → 前端）
```json
{ "stage": "analyzing | generating | refining | finalizing", "pct": 0, "detail": "文字說明" }
```

### `avatar_generated`（後端 → 前端）— 正式角色資料
```json
{
  "ok": true,
  "error": null,
  "outfit": {
    "outer": "jacket", "inner": "tshirt", "lower": "pants",
    "inner_color": "#RRGGBB",   // ⚠️ 被 CV hex 覆蓋，見 §3
    "lower_color": "#RRGGBB"    // ⚠️ 被 CV hex 覆蓋，見 §3
    // 註：projection.html 會讀 outfit.has_glasses 併入配件，屬選填欄位
  },
  "stencil": "...",             // CV 輪廓/遮罩
  "cloth_grid": {...},          // 上身網格顏色 (32×40 per-cell hex)
  "lower_grid": {...},          // 下身網格顏色 (24×30 per-cell hex)
  "face": {
    "face_shape": "oval", "eye_shape": "almond", "eyebrow_style": "straight",
    "smile_score": 0.62, "lip_color": "#RRGGBB",
    "hair_style": "short_straight", "hair_color": "#RRGGBB", "hair_color_name": "dark_brown",
    "skin_tone": "#RRGGBB", "skin_tone_name": "light",
    "eye_color": "#RRGGBB", "eye_color_name": "brown",
    "has_beard": false, "beard_style": "none"
  },
  "upper_type": "short_sleeve | long_sleeve",
  "lower_type": "shorts | long_pants",
  "body_png": "base64...",      // full_character 模式的整張 LEGO 人物圖
  "body_bbox": [x, y, w, h],
  "garment_source": "openai | grid",
  "character_mode": "body_sprite | full_character | full_character_refined"
}
```

### `join_swarm`（前端 → 後端）
```json
{
  "id": "字串id（省略則由後端配發 char_<uuid12>，不再使用 socket sid）",
  "x": 960, "y": 540,
  "upper": {...}, "lower": {...}, "arm_color": {...},
  "upper_type": "...", "lower_type": "...",
  "accessories": [...], "accessory": "none",
  "face": {...}, "outfit": {...},
  "body_png": "...", "body_bbox": [...],
  "character_mode": "body_sprite"
}
```

### `swarm_joined`（後端 → 前端）
```json
{ "id": "char_id" }
```

### `leave_swarm`（前端 → 後端）
```json
{ "id": "char_id" }
```

### `update_character`（前端 → 後端）
```json
{
  "id": "char_id",                     // 必填，缺少則忽略整個事件
  // 以下任意欄位，只有出現的才會被更新：
  "upper", "lower", "upper_type", "lower_type",
  "accessories", "accessory", "arm_color", "face", "outfit",
  "body_png", "body_bbox", "character_mode"
}
```

### `get_swarm`（前端 → 後端）
```json
{}   // 無 payload；後端立即回一次 update_positions
```

### `update_positions`（後端 → 所有端）— 每 0.1s tick 廣播
```json
{
  "characters": [
    {
      "id": "char_id",
      "x": 0.0, "y": 0.0,          // Boids 座標，範圍 0..1920 × 0..1080
      "vx": 0.0, "vy": 0.0,
      "state": "GREETING | ROAMING",  // 距離 < 80px 即 GREETING
      // ...以及該角色 join_swarm 時帶入的所有外觀欄位
    }
  ]
}
```
> **相遇偵測內嵌在 `state` 欄位裡**，不是獨立事件。若 M7 v2 需要獨立相遇事件，
> 目前沒有現成的 `character_encounter` 記錄可用，需另外設計。

### `trigger_photo`（前端 → 後端）— 觸發集體記憶大合照 (M6)
```json
{
  "room": "default"             // 可選，預設 "default"
}
```

### `photo_ready`（後端 → 廣播所有前端）— 大合照合成完成
```json
{
  "ok": true,
  "photo_id": "photo_1771720000_12p",
  "photo_url": "http://127.0.0.1:5001/photos/photo_1771720000_12p.png",
  "photo_b64": "data:image/png;base64,...",
  "qr_b64": "data:image/png;base64,...",
  "character_count": 12,
  "room": "default"
}
```

### `inject_bots`（前端/控制台 → 後端）— 模擬機器人注入
```json
{
  "count": 10,
  "room": "default"
}
```

### `remove_bots`（前端/控制台 → 後端）— 清除所有機器人
```json
{}
```

### `save_snapshot`（前端/控制台 → 後端）— 手動儲存快照
```json
{}
```
> 後端回傳 `snapshot_saved` `{ "ok": true }`。

---

## 3. VLM / CV 欄位覆蓋規則（原本隱含在程式碼、現正式文件化）

`avatar_generated.outfit` 的顏色欄位來源**混合** VLM 分類與 CV 取樣：

| 欄位 | 來源 | 說明 |
|------|------|------|
| `outfit.outer` / `outfit.inner` / `outfit.lower` | VLM 分類詞 | 服裝**類型**（jacket / tshirt / pants…） |
| `outfit.inner_color` | **CV hex 覆蓋** | 若 CV 有 `upper.hex`，覆蓋掉 VLM 的顏色分類詞 |
| `outfit.lower_color` | **CV hex 覆蓋** | 若 CV 有 `lower.hex`，覆蓋掉 VLM 的顏色分類詞 |
| `face.hair_color` / `skin_tone` / `eye_color` | VLM 分類詞 → hex 對照表 | 見 `app.py` 的 `_HAIR_HEX` / `_SKIN_HEX` / `_EYE_HEX` |
| `upper_type`（袖長） | VLM 語意優先，CV 補 | blazer/cardigan/denim_jacket/button_up → long_sleeve，否則用 CV 判斷 |

> **已知落差**：VLM 分類目前**不回傳 confidence**，CV 流程原有 confidence 概念但兩者未對齊。
> WP-A 整併時需補上信心值，作為深色/複雜衣著判斷失敗時的降級依據。

---

## 4. 連線生命週期與狀態一致性

- **角色 id 策略**：`join_swarm` 可自帶 `id`；未帶則由後端配發 `char_<uuid12>`。
  **id 刻意與連線 `sid` 脫鉤** —— 早期版本沿用 `sid`，導致賓客關掉分頁時角色隨之消失
  （共創畫面只留得住「當下還開著頁面的人」），且 N 位賓客就需要 N 條長連線。
- **斷線清理**：`disconnect` **不再移除任何角色**，僅更新 `last_seen`。
  賓客關掉分頁不代表離開現場，作品不該因此少一個人。
- **角色回收**：背景迴圈每 60 秒掃描一次，清除超過 `CHARACTER_TTL_SEC`
  （預設 7200 秒）未更新的角色。設為 0 可停用。快照還原時會補上 `last_seen`，
  否則缺該欄位的角色會被判定為「剛出現」而永不過期。
- **重新連線**：前端把 `swarm_joined` 回傳的 id 存進 `sessionStorage`，重連時帶回
  以認領同一角色，避免在牆上產生分身。
- **多房間分流**：`join_swarm` / `get_swarm` / `trigger_photo` 支援 `room` 參數，實現多螢幕或展區隔離。
  `get_swarm` 會將該連線加入指定 room（未指定則為 `default`）——
  純觀看端（投影牆、壓測觀測器）只 emit `get_swarm`、不 `join_swarm`，
  若不在此處加入 room，就收不到 `_swarm_background` 的 room-scoped 週期廣播。
- **快照持久化**：背景每 30 秒自動儲存 `backend/data/swarm_snapshot.json`，伺服器重啟自動還原。
- **狀態單一真相源**：`_swarm_chars`（`app.py`，`_swarm_lock` 保護）。所有讀寫都要持鎖。

---

## 5. 事件 log 落地（M3，供第 6 節效能量測）

所有事件寫入 `backend/logs/events-YYYYMMDD.jsonl`（每日輪替，JSON lines）。詳見 `backend/event_logger.py`。

| log 事件 | 關鍵欄位 | 用途 |
|----------|---------|------|
| `connect` / `disconnect` | `pid`, `removed_char` | 連線觀測 |
| `join_swarm` / `leave_swarm` | `pid`, `room`, `swarm_size` | 承載量觀測 |
| `update_character` | `pid`, `fields` | 更新記錄 |
| `get_swarm` | `pid`, `room`, `swarm_size` | — |
| `group_photo_composed` | `photo_id`, `count`, `room` | M6 大合照生成記錄 |
| `inject_bots` / `remove_bots` | `count`, `total`, `room` | Bot 模擬注入觀測 |
| `generate_queued` | `pid`, `ahead`, `mode` | 多人同拍時進入排隊（超過 `GEN_MAX_CONCURRENT`） |
| `avatar_generated` | `latency_ms`, `cv_ms`, `vlm_ms`, `generation_ms`, `queue_wait_ms`, `retry_count`, `ok`, `error` | **生成延遲分佈 + 失敗率 + 排隊等待**（第 6 節） |
| `character_encounter` | `pid`, `swarm_size` | 相遇（只記新進入 GREETING，已去重） |
| `swarm_summary` | `swarm_size`, `greeting_count` | 每 5s 一筆的承載量快照 |

> **隱私**：log 一律**不落地影像**——`image`/`body_png`/`cloth_grid` 等大型/影像欄位由 `event_logger._sanitize` 自動移除。

分析工具：`backend/analyze_log.py`（算出第 6 節指標表）｜壓測工具：`backend/stress_test.py`。

---

## 6. 尚未實作、但已預留命名的事件（M7）

| 規劃事件名 | 用途 | 依賴 |
|-----------|------|------|
| `character_encounter`（廣播版） | 相遇任務——已有 log，需加 emit 給前端 | M7 v2 |

> 新增事件一律沿用 `動詞_名詞` snake_case，並回來更新本文件。

