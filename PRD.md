# PersonaFlow 數位轉譯角色空間互動系統

- 文件版本：v1.3
- 更新日期：2026-07-18
- 本階段範圍：持續優化 M1／M2；M3–M7 僅接受 metadata 保存、廣播與 renderer 接點
- 角色風格：活動層級固定使用 `lego`，本階段不製作第二風格

> 本文件以目前 repo 實作為準。M1／M2 的程式與 mock／規則測試已完成；身高門檻、真實生成品質與現場缺腳率仍需使用固定攝影站及實際生圖模型校正驗收。

## 1. 產品目標

PersonaFlow 將參與者的全身影像即時轉譯為共享虛擬空間中的角色。現階段先以開發端上傳照片反覆比較生成穩定度、耗時與成本；拍攝品質門檻待固定攝影站實測後再收斂。系統不建立原始照片資料庫，只保存生成結果與匿名技術資料。

本階段成功條件：

1. 拍照前能確認人物完整、雙腳入鏡且姿勢穩定。
2. 模式一不再出現 AI 手臂與程式化手臂重疊。
3. 模式二能偵測缺腳等結構問題；失敗時說明原因並要求重拍，不回退模式一。
4. 正式模式先建立固定 3D 角色，再套用通過驗證的 AI 高細節材質。
5. 三段身高只影響視覺比例／顯示倍率，不宣稱為精確公分測量。
6. 未來新增風格時不需改動 M1 schema 或既有 Socket 事件名稱。

## 2. 系統架構

系統是單一 Python 後端加兩個瀏覽器端 renderer：

```text
固定攝影站
  │
  ├─ process_frame ──> M1 即時 CV executor（每個 Socket 最多一個推論）
  │                       └─ 最新待處理影格覆蓋舊影格
  │
  └─ generate_avatar ─> M1 正式特徵 + VLM 語意
                          │
                          └─ M2 AI executor
                              ├─ brick_ai_texture
                              ├─ body_sprite
                              └─ full_character
                                  │
                                  └─ validator → success／needs_retake

Flask-SocketIO
  ├─ 互動主畫面：p5.js renderer registry
  └─ 投影頁：PixiJS renderer registry + Boids
```

- 後端：Flask、Flask-SocketIO（`threading` async mode）、MediaPipe、OpenCV、Pillow。
- 語意分析：正式／組合模式可使用 Gemini VLM；完整角色模式預設由生圖模型直接讀取原圖。
- 生圖：透過 OpenAI-compatible SDK 呼叫設定的 image-output model。
- 前端：p5.js 主畫面、PixiJS 投影頁、Socket.io client。
- 照片與局部裁切只存在記憶體，不寫入磁碟。

## 3. M1：拍攝品質、特徵與身高

### 3.1 拍攝品質閘門

互動畫面只顯示半透明頭部參考與畫面底部雙腳基準，不繪製全身站位框；即時指示與通關條件放在攝影畫面左側直式面板，避免遮住人物：

- 攝影機預設關閉；只有使用者按下「開啟攝影機」後才請求瀏覽器權限與建立 MediaStream。
- 頭部與腳部標記只提供站位參考，不要求 landmarks 對齊固定模板。
- 必要核心 landmarks：左右肩、髖與膝，visibility 至少 0.35。
- 左右腳各自只需腳踝、腳跟、腳尖其中一點 visibility 至少 0.20。
- 不限制軀幹必須位於畫面正中央，也不限制關節固定高度；只有真正碰到影像邊界、人物過小或骨架順序明顯錯誤時阻擋。
- 穩定條件：連續三幀的正規化 landmark 平均位移不超過 0.035。
- `capture_ready_raw=true` 即可開始三秒倒數；倒數期間容許短暫偵測抖動，結束時再確認穩定度。

`process_frame` 支援可選 `frame_id`。EMA、fallback、landmark history、穩定幀與最新待處理影格皆依 Socket session 隔離，斷線時清除。

`clothing_features` 新增：

```json
{
  "frame_id": 42,
  "capture_quality": { "score": 1.0, "min_visibility": 0.91 },
  "capture_ready": true,
  "stability_count": 3,
  "stability_required": 3,
  "guidance_reason": "ready",
  "height_ratio": 0.81,
  "height_class": "medium"
}
```

即時面板分別顯示姿勢、左右腳、全身入鏡與穩定度，`guidance_reason` 會指出缺失的腳側、低可信關節或被裁切的畫面邊緣。

### 3.2 特徵與局部參考

- `body_poly` 已納入 landmarks 27–32，以腳踝、腳跟與腳尖決定人物底部。
- M1 產生 `full_body`、`face`、`upper_body`、`lower_body`、`feet` 正規化區域。
- M2 只在記憶體中使用這些區域建立臉／服裝／鞋部 detail sheet。
- 服裝色彩由 CV 的 `upper`、`lower`、`arm_color` 決定。
- VLM 不得覆蓋上身、下身與手臂色碼，只補服裝類型與人物語意。

### 3.3 身高分級

單眼影像無法自行區分「真人身高」與「人物距離相機遠近」。因此固定相機位置與焦距之外，現場地面必須設置固定腳印，讓所有人站在相同距離；畫面底部的腳位標記需與實體腳印對應。頭部標記只代表中等身高參考，不作為通關條件，不同身高者的頭可落在其上方或下方。

腳底落在校正基準容許範圍時，以最大人體 segmentation 連通區的頭頂至腳底高度除以校正高度得到 `height_ratio`。即時預覽取最近 15 個有效樣本的中位數，樣本突變超過 0.12 時視為新訪客並重新累積。腳底未對齊或 segmentation 無法提供有效身高時標記 `height_measurement_valid=false`、`height_class=null`，不使用預設 `medium`；攝影模式不得啟用拍照或進入正式生圖。

門檻由安裝環境設定：

- `HEIGHT_SHORT_MAX_RATIO=0.72`
- `HEIGHT_TALL_MIN_RATIO=0.84`

分類規則：

- `< short_max_ratio`：`short`
- `short_max_ratio` 至 `tall_min_ratio`（含邊界）：`medium`
- `> tall_min_ratio`：`tall`

| Profile | 顯示倍率 | 模式一軀幹 Y | 模式一腿部 Y |
|---|---:|---:|---:|
| `short` | 0.90 | 0.96 | 0.90 |
| `medium` | 1.00 | 1.00 | 1.00 |
| `tall` | 1.10 | 1.02 | 1.12 |

- 模式一套用顯示倍率與局部身體比例。
- 模式二、三只套用整體顯示倍率，不用 prompt 改變人體比例，也不做非等比拉伸。
- 主畫面最終倍率為既有繪圖倍率 × `display_scale`。
- 投影端最終倍率為既有透視倍率 × `display_scale`；Boids 座標與碰撞邏輯不變。
- 投影牆只接受 `height_measurement_valid=true` 且具有 `short / medium / tall` 的角色，後端依 `height_class` 重建可信 profile，不接受前端任意倍率。
- 這是視覺分級，不是實際身高測量。

## 4. M2：生成模式與舊版相容

公開操作頁以 `brick_ai_texture` 為主模式，並保留 `full_character` 作研究比較。`body_sprite` 因固定臉部與2D拼接品質不符合成果要求，公開入口與新生成請求均已停用；舊歷史仍可查閱。`full_character_refined` 不再出現在公開模式選擇。開發預設 `GENERATION_MAX_RETRIES=0`。

### 4.1 `body_sprite`

此管線已退役，下列內容只用於解讀舊歷史紀錄。

- 沿用程式化 LEGO 頭、手臂、手、鞋與 accessory anchors。
- AI 只生成軀幹與雙腿；prompt 明確禁止頭、手臂、手與鞋。
- 因 AI 與前端不再同時生成手臂，可消除重複肢體。
- 套用三種身高 profile 的軀幹／腿部比例。
- 舊紀錄可能包含格柵 fallback；此行為已退役，不再建立新結果。

### 4.2 `full_character`

生圖輸入包含：

1. 完整全身照。
2. 臉、上身、下身、鞋部的局部 detail sheet。
3. 單一人物、正面、兩腿與兩鞋清楚的中性 LEGO 姿勢參考。

生成後先加上本機透明邊界，再跑 validator，避免邊緣抗鋸齒雜點觸發昂貴重生。硬性失敗時回傳 validation code 與中文重拍提示，不回退 `body_sprite`。`height_profile` 不介入生圖，只在 renderer 顯示階段套用。

### 4.3 `brick_ai_texture`

1. 以 CV／VLM 建立固定幾何的 `CharacterSpec v2` 與受限 `body_shape`。
2. 立即送出 `stage=character_spec_base, is_final=false`。
3. Pro image model 同時接收真人照片、四格 UV guide 與固定 Style Anchor，生成臉、上衣、左腿、右腿材質。
4. 材質通過版位、色差、無烘焙光影、臉部細節、服裝忠實度與物種合規檢查後，送出 `stage=ai_texture, is_final=true`。
5. Three.js 只替換材質，不允許 AI 改變身體幾何、姿勢或肢體數量。
6. AI 失敗時回傳正式生成失敗並要求重試；pending 本機材質不得加入投影牆。
7. 主操作頁使用獨立 Three.js 預覽器渲染同一份 `CharacterSpec`，並直接保存3D透明 PNG；禁止再以 p5.js `cloth_grid` 快照代表正式結果。

`body_sprite`、`brick_v1` 與 `full_character_refined` 已從公開介面移除；舊紀錄仍保留原 mode 值以維持成本與評測追溯。

前端保存目前的 `request_id`，舊請求後到的事件會被忽略。

## 5. 本機規則 Validator

本階段不新增 VLM 審查服務。`avatar_quality.py` 提供可替換的本機 validator 介面。

硬性失敗：

- 無法解碼或沒有圖片。
- 前景為空。
- 前景佔全圖低於 5% 或高於 85%。
- 四周沒有至少 2 px 透明邊界／角色碰邊。
- 最大連通區低於總前景 75%。
- 底部 25% 的左側或右側內容低於總前景 1%。

上／下身與 M1 色彩的 Lab 色差只寫入 warning，不觸發 retry。透明度是前景判斷依據，因此白色衣服仍會被保留，不會被誤判成背景。

## 6. 角色風格擴充架構

### 6.1 後端生成 registry

活動使用環境設定 `CHARACTER_STYLE` 決定單一 `style_id`。一般 `generate_avatar` payload 不能覆寫活動風格。未知值一律回退 `lego`。

每個 generation style 定義：

- body prompt
- full-character prompt
- refine prompt
- negative prompt
- 支援的角色生成模式
- 後續可加入模型與生成參數覆寫

### 6.2 前端 renderer registry

主畫面透過 `PersonaFlowThemes.get(style_id)` 取得繪製入口、accessory anchors、支援模式與身高套用方式；投影頁有對應的 Pixi renderer registry。未知值都回退 LEGO。

本階段只有 `lego` 註冊項目。未來新增風格時需增加後端 prompt provider 與兩端 renderer，不修改 M1 特徵 schema 或 Socket 事件名稱。

## 7. 公開 Socket 介面

### 7.1 `generate_avatar`

```json
{
  "image": "data:image/jpeg;base64,...",
  "mode": "brick_ai_texture",
  "request_id": "client-generated-uuid"
}
```

`style_id` 由活動設定決定，不接受使用者任意覆寫。

### 7.2 `generation_progress`

後端依真實流程送出進度里程碑；前端只接受目前 `request_id`：

```json
{
  "request_id": "client-generated-uuid",
  "mode": "brick_ai_texture",
  "stage": "generating_texture",
  "percent": 78,
  "message": "AI 正在繪製臉部與服裝高細節材質"
}
```

里程碑包含接收照片、CV 特徵分析、角色／材質生成、規則驗證與完成。百分比代表流程階段，不宣稱為模型內部的精確剩餘時間。

### 7.3 `avatar_generated`

```json
{
  "ok": true,
  "request_id": "client-generated-uuid",
  "stage": "base",
  "is_final": false,
  "character_mode": "brick_ai_texture",
  "body_png": "...",
  "validation": { "passed": true, "errors": [], "warnings": [] },
  "retry_count": 0,
  "fallback_used": false,
  "height_ratio": 0.86,
  "height_class": "tall",
  "height_profile": {
    "id": "tall", "display_scale": 1.1,
    "torso_scale_y": 1.02, "leg_scale_y": 1.12
  },
  "style_id": "lego"
}
```

既有 `outfit`、`face`、`arm_color`、`upper_type`、`lower_type`、`body_bbox` 等欄位維持相容；`cloth_grid` 與 `lower_grid` 已退出前端、Socket正式結果及群體資料流。

### 7.4 M3–M7 metadata 接點

`join_swarm`、`update_character`、`update_positions` 不改事件名稱，只透明保存與廣播：

- `height_class`
- `height_profile`
- `style_id`

M3–M7 本階段不新增其他業務功能。

## 8. 匿名 Metrics 與隱私

正式生成會寫入 `backend/logs/m1_m2_metrics.jsonl`，單檔上限 5 MB，輪替保留 3 份；`backend/logs/` 已加入 `.gitignore`。

只允許保存：

- 時間（不寫入 client `request_id`）
- mode、style、height class、stage
- 總耗時、CV／VLM／generation 分段耗時
- validation errors／warnings
- retry、fallback、status

禁止保存照片、base64、顏色、landmarks、服裝／臉部人物屬性。這份 log 只服務 M1／M2 品質比較，不代表 M3–M7 的完整活動事件 log。

### 8.1 開發端生成歷史與成本

`backend/logs/generation_history.sqlite3` 保存每次開發測試 run 與每次付費 image attempt：

- mode、來源（upload／camera）、狀態與 validation code
- 模型、階段、耗時、API request count
- prompt／completion／image／cached token
- OpenRouter 回應的實際 `usage.cost` 與 upstream cost
- retry、錯誤碼與中文重拍提示
- 每次 attempt 的生成 PNG，供正式材質與完整角色結果比較
- `height_class`、`height_ratio` 與 `height_measurement_valid`，區分有效量測、未校正與舊紀錄

開發頁 `frontend/dev.html` 顯示總成本、成功率、模式比較、每次 attempt、生成結果、外部結果匯入與多人盲評。正式生成的原始上傳照片與 base64 永遠不落地；只有使用者明確匯入的盲評照片會移除 EXIF、縮至640px並暫存在 `backend/logs/review_sources/`，且可按實驗批次刪除。

每筆具有有效身高與完整最終 PNG 的歷史紀錄提供「匯入角色」按鈕。匯入時裁掉透明空白、以 `history_sprite` 將完整角色 PNG 傳到投影牆，並套用該筆可信 height profile；舊紀錄或未校正資料不得匯入。投影 renderer 必須讀取 `body_png`，不可回退成只依服裝色碼重畫的程式化角色。

每筆 run 可填寫人工審查：通過／不通過、肢體完整度、服裝相似度、臉／髮型相似度、整體效果（各 1–5 分）與備註。人工評分不覆蓋規則 validator，而是作為比較不同模式品質與成本效益的 ground truth。

正式盲評另使用 `blind_review_sessions`、`blind_review_items`、`blind_review_responses` 與 `blind_group_responses`。評分完成前不得回傳 variant、模型、成本、耗時或自動分數；至少5位評分者完成全部單人與群體項目後才可揭露結果。

## 9. 測試與驗收

### 9.1 已完成的自動測試

- M1：完整人物、低 visibility、腳尖出界、位移、三段身高臨界值。
- Validator：空白、解碼失敗、碰邊、缺右下半部、碎裂、正常透明角色、白衣保護。
- M2 mock：正式模式 pending→AI 材質、材質失敗不得形成正式角色、舊模式相容與完整角色驗證失敗回傳重拍。
- 開發歷史：SQLite run／attempt、每次生成圖、token／cost 聚合、人工評分與原始照片不落地。
- 多人盲評：外部結果、匿名資料、五位完整評分者門檻、解除匿名與品質／成本統計。
- Registry／Socket：LEGO 載入、未知 style 回退、height/style metadata 保存與更新。

### 9.2 正式展示前現場驗收

- 固定攝影站校正 `short_max_ratio` 與 `tall_min_ratio`。
- 反覆進出站位框，確認拍照啟用與倒數取消提示。
- 確認三種 profile 在主畫面與投影端腳底視覺對齊。
- 用真實 image-output model 比較正式、組合與完整角色模式的耗時、缺腳率與細節。
- 正式模式確認幾何一致、AI 材質成功套用；完整角色模式作為細節比較基準。
- 檢查 JSONL／SQLite 不含原始照片、base64 或人物屬性。

本階段建立的是「生成實驗資料庫」，不是原始照片資料庫；也不進行第二角色風格開發。

## 10. 安裝設定

新增或重要的 `.env` 設定：

```dotenv
GENERATION_MODE=brick_ai_texture
CHARACTER_STYLE=lego
HEIGHT_SHORT_MAX_RATIO=0.72
HEIGHT_TALL_MIN_RATIO=0.84
OUTFIT_GEN_MODEL=google/gemini-3.1-flash-image-preview
FULL_CHARACTER_MODEL=google/gemini-3-pro-image-preview
BRICK_TEXTURE_MODEL=google/gemini-3-pro-image-preview
GENERATION_MAX_RETRIES=0
FULL_MODE_VLM_ENABLED=0
DEV_HISTORY_ENABLED=1
DEV_HISTORY_SAVE_OUTPUTS=1
```

必要套件已列入 `requirements.txt`，包括 Flask、Flask-SocketIO、MediaPipe、OpenCV、NumPy、Pillow、OpenAI SDK、python-dotenv 與 google-generativeai。

## 11. 已知限制與後續工作

1. 身高門檻是預設值，未經現場相機校正不能視為正式結果。
2. 規則 validator 能檢查結構與透明背景，但不能判斷角色語意是否「像本人」。介面保留日後接入語意審查的能力。
3. 開發預設不自動重試；需比較 retry 效益時才以環境設定啟用一次，並由 SQLite 記錄其成本。
4. 正式材質仍需真人同照片 A/B 驗證服裝與臉部相似度。
5. 快速備援與完整＋精修模式已移除，不再出現在操作介面或接受新請求。
6. 未來風格可擴充，但活動中所有角色必須共用同一 `style_id`。

## 12. 變更紀錄

| 日期 | 版本 | 變更 |
|---|---|---|
| 2026-07-09 | v1.1 | 依當時 repo 校正單一 Python 技術棧與模組現況。 |
| 2026-07-17 | v1.2 | 實作 M1 拍攝品質／session 隔離／身高分級，M2 三模式共用 validator／retry／fallback／漸進精修，新增 generation 與 renderer registry、匿名 metrics、metadata 透明傳遞及自動測試。 |
| 2026-07-18 | v1.3 | 上傳測試改為驗證失敗即說明並重拍，不回退模式一；模式三收斂為 Flash 底圖＋Pro 精修，加入 SQLite 生成歷史、OpenRouter token／實際成本與開發儀表板。 |
| 2026-07-26 | v1.4 | 正式模式改為固定 3D＋AI UV 材質；移除快速備援與完整＋精修公開模式，重排拍攝介面並加入細節 A/B 指標。 |
