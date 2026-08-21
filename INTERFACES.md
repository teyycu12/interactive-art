# PersonaFlow 模組間介面規格（M3 維護）

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
| `disconnect` | Socket.io 內建 | `handle_disconnect` | 斷線；**只移除 `char_id == sid` 的角色**（見 §4） |
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
  "id": "字串id（省略則用 socket sid）",
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

- **角色 id 策略**：`join_swarm` 可自帶 `id`；未帶則用該連線的 socket `sid`。
- **斷線清理**：`disconnect` 只 `pop` `char_id == sid` 的角色——即「這條連線本人就是角色」的情況。
  投影牆等純觀測連線斷開，**不會**誤刪別人加入的角色。
- **重連**：前端 socket 重連後 sid 會變，後端已把舊角色移除；前端須用 `_lastJoinPayload` 重新 `join_swarm`（見 `frontend/socket.js`）。
- **狀態單一真相源**：`_swarm_chars`（`app.py`，`_swarm_lock` 保護）。所有讀寫都要持鎖。

---

## 5. 尚未實作、但已預留命名的事件（WP-B / M6 / M7）

| 規劃事件名 | 用途 | 依賴 |
|-----------|------|------|
| `trigger_photo` | 觸發大合照 | M6 |
| `photo_ready` | 合照完成（含 QR） | M6 |
| `character_encounter`（廣播版） | 相遇任務——已有 log，需加 emit 給前端 | M7 v2 |

> 新增事件一律沿用 `動詞_名詞` snake_case，並回來更新本文件。
