# 數位轉譯角色空間互動系統──技術架構文件

- 版本：v1.1（2026-07-09，依現有程式碼校正）
- 改寫目的：定義系統模組邊界、資料流與模組間介面，作為分工開發與期末發表的技術基準文件
- 適用範圍：專題組員、指導教授
- 文件維護：每次架構決策變更後更新版本並記錄變更紀錄（第9節）
- **v1.1 校正說明**：v1.0 有多處與目前 repo（PersonaFlow, master 分支）現況不符，主要是「以為還沒做」跟「以為技術棧是 Node.js」這兩類落差。本版依實際程式碼（`backend/app.py`、`cv_module.py`、`vlm_module.py`、`face_module.py`、`swarm_logic.py`、`frontend/sketch.js`、`themes/lego.js`）逐項核對修正，變更處見第9節。

---

## 1. 系統定位與一句話

**即時生成式互動角色系統**，將實體空間中參與者的穿著視覺特徵，即時轉譯為專屬自身且共享的虛擬角色空間，透過群體互動與集體記憶生成（大合照）促進實體場合的社交連結。以宴會為主要設計場景，系統採事件式架構支援跨場合（迎新、展覽、企業活動）。

## 2. 設計原則

1. **即時優先，但目前尚無分級速度補償**：參與者拍照後必須等候 CV＋VLM 兩條處理鏈都完成才會拿到角色（見 M2），目前**沒有**「先極速上場、後續再精緻化」的分軌機制——這是 WP-A 要補的洞，不是已經做好的東西，v1.0 文件把它寫得像已有雛形，並不準確。
2. **模組化分層**：核心引擎（特徵擷取、渲染、行為模擬）與場景套件（美術風格、場地、活動主題）需分離。**現況：場景套件抽象化尚未實作**，目前只有單一硬編碼的 `themes/lego.js` 主題，透過 `sketch.js` 內 `ACTIVE_THEME = 'lego'` 選用，沒有場景資料夾／JSON 規格化的「套件」概念。
3. **降級可用（Graceful Degradation）**：AI生成失敗或延遲時，需fallback。**現況：`generate_avatar` 目前沒有 timeout/fallback 邏輯**——若 Gemini API 逾時或報錯，`avatar_generated` 事件會直接回傳 `{ok: false, error: ...}`，前端目前沒有處理這個失敗分支跳到樣板角色的流程。`process_frame`（即時預覽用的CV特徵擷取）本身有 fallback（沿用上一次成功結果，見 `app.py` 的 `_merge_fallback_payload`），但那是給即時預覽用，不是給正式生成角色用的降級。
4. **一切互動皆log**：所有事件（上場、移動、相遇、合照、掃碼）寫入結構化log。**現況：這一項完全沒有實作。** `backend/app.py` 目前沒有任何寫檔/ logging 到檔案的程式碼，只有零星 `print()`。這是本文件目前最大的落差——WP-C 的實測驗收標準要求「完整事件log一份」，但log落地機制還是0%，必須提前排入WP-A或WP-B優先序，否則9月沒東西可收。

## 3. 系統架構總覽

實際上是**單一 Python 服務**（Flask + Flask-SocketIO，用 eventlet 跑背景任務），沒有 Node.js。前端是純 p5.js + Socket.io-client，一支 `sketch.js`（互動主流程：拍照／自訂／加入群聚）＋ 一支 `projection.html`（投影牆渲染，接收 `update_positions` 廣播）。

```
                        實體空間（展場）
   [鏡頭/網路攝影機] ──▶ [互動端 sketch.js]      [投影牆 projection.html]
                              │  Socket.io                  ▲
                              ▼                              │ update_positions（廣播）
                    ┌────────────────────────────────────────┴───┐
                    │  backend/app.py                             │
                    │  Flask + Flask-SocketIO（eventlet）          │
                    │  單一 Python 進程，無 Node.js                │
                    │                                              │
                    │  process_frame ──▶ cv_module（即時預覽用）   │
                    │  generate_avatar ─▶ cv_module + vlm_module   │
                    │                     + face_module（並行執行）│
                    │  join_swarm / leave_swarm / update_character │
                    │  swarm_logic（Boids，背景 tick 每 0.1s）     │
                    └──────────────────────────────────────────────┘
```

M1（特徵擷取）跟 M2（AI/CV 生成）在程式碼裡並非獨立服務，而是 `app.py` 內同一個 Socket.io handler 呼叫的三個模組（`cv_module.get_clothing_features`、`vlm_module.analyze_outfit`/`analyze_face`、`face_module.get_face_features`），詳見4.1/4.2。

## 4. 模組定義與現況

> 現況標記：✅ 已驗證（穩定可用）｜🚧 開發中（部分能跑，未穩定/未整合）｜🔴 規劃中（尚未動工）

### M1 特徵擷取模組（實際上是三個並行模組）
- **職責**：從鏡頭影像中擷取穿著色彩分佈與臉部幾何特徵。
- **實際組成**（v1.0 文件只寫了一個模組，現況是三個檔案各司其職）：
  1. `cv_module.py`：MediaPipe **PoseLandmarker**（非文件原寫的分割模型）取雙肩／骨盆／雙膝等關節點，據此定義上身/下身取樣多邊形 ROI（上身32×40網格、下身24×30網格），對每格做K-Means（k=5）調色盤映射＋BFS邊緣延伸補洞，另外用肩到肘的取樣估手臂膚色/袖色。輸出是**網格化顏色資料**（`cloth_grid`／`lower_grid`／`arm_color`），不是單一主色調。
  2. `vlm_module.py`：呼叫 Gemini 1.5 Flash，分析外層/內層/下身的服裝類型與顏色分類（分類詞如 `dark_brown`、`blonde` 等，非直接RGB取樣）。
  3. `face_module.py`：MediaPipe估算臉型、眼型、眉型、微笑分數、唇色（幾何特徵，不含髮色——髮色由VLM分類決定）。
- **狀態**：✅ 三模組本身皆可跑且已整合進 `generate_avatar` 流程；🚧 網格細緻度（32×40）在部分服裝上可能偏雜訊，尚待調校（沿用既有已知問題，非新增）。

### M2 角色轉譯模組（本專題技術核心）
- **職責**：將 M1 輸出的特徵整合為單一參與者的虛擬角色外觀。
- **現況架構（與v1.0描述的「Track A模板 vs Track B AI生成＋30秒fallback」機制不同）**：
  目前**只有一條路徑**：`generate_avatar` 事件觸發後，`cv_module`（網格顏色）與 `vlm_module`（服裝類型分類＋臉部分類，透過 `eventlet.spawn` 並行送出兩支Gemini請求）**同步並行執行**，兩者都完成後才合併回傳 `avatar_generated`。前端在等待期間停在 `PROCESSING` 狀態，沒有中間可見的「快速角色先上場」畫面。
  - 「模板即時版（Track A）」與「AI精緻版（Track B）＋自動升級事件」都是**尚未實作**的規劃，WP-A要做的正是把現在這條單一同步流程，拆成先出模板／CV結果、AI結果好了再無縫替換＋補一個 `character:upgrade`（或依現有命名慣例改叫 `update_character`）式的升級事件。
  - 目前**沒有** timeout/fallback：Gemini呼叫失敗時整包直接回傳失敗，前端沒有接手處理。
- **狀態**：🚧 CV+VLM並行生成已可動、已整合進主流程；🔴 分軌上場、自動升級、逾時fallback三者均未開工——這是WP-A從0開始的範圍，不是「管線整合收尾」。
- **測量義涵不變**：本模組仍需輸出效能數據（生成延遲分佈、Gemini失敗率），但目前沒有任何落地log（見4.3的log落地缺口）。

### M3 通訊與集中式狀態管理
- **職責**：維護在場角色的即時狀態（位置、速度、GREETING/ROAMING狀態），以Socket.io在互動端與投影端之間廣播，並（規劃中）寫入結構化事件log。
- **技術**：**單一 Flask + Flask-SocketIO（eventlet）服務**，不是v1.0文件寫的「Node.js + Socket.io + Flask」雙棧架構。目前沒有Node.js程式碼存在於此repo中，M1/M2/M3全部跑在同一個Python進程裡（見第3節架構圖），不存在v1.0所述「避免重複造輪」的雙棧疑慮，因為根本沒有做成雙棧。
- **狀態**：✅ Socket.io連線與廣播（`update_positions` 每0.1秒tick）已驗證，多場demo可用；🔴 **事件log結構化落地＝0%，完全未實作**——`app.py`目前無任何寫檔/logging模組。這件事的優先序需要拉高，因為WP-C的9月實測驗收（完整事件log一份）完全卡在這裡。
- **待辦**：事件定義（第5.2節，需先依現有事件名重寫）、log落地、壓測（模擬30角色同時在場）。

### M4 虛擬空間與行為模組
- **職責**：投影端渲染，呈現所有參與者虛擬角色，以Boids演算法調控角色群體移動、相遇、行為。
- **技術**：p5.js，Boids（分離/對齊/凝聚三力，`backend/swarm_logic.py` 已實作：分離半徑80、對齊半徑150、凝聚半徑200，速度上限2.0）。角色距離 < 80px時，`swarm_logic.py` 直接在同一次tick內把該角色狀態標為 `"GREETING"`（否則`"ROAMING"`），**不是**透過獨立的 `character:encounter` 事件廣播——狀態已經內嵌在每次 `update_positions` 的payload裡。
- **場景套件規格**：v1.0描述的「一套場景 = 背景圖 + 邊界/退場定義JSON + 粒子密度參數 + 風格色票」**尚未實作**。現況是`frontend/themes/lego.js`一支寫死的LEGO角色繪製邏輯（含髮色濾除、BFS聚類、對比拉伸、飽和度增強、雙邊對稱鏡射等完整換色pipeline），透過`sketch.js`裡`ACTIVE_THEME`常數選用，新增主題＝在`themes/`加檔＋加script tag，但**沒有**場景（background/邊界/退場）層級的套件化，只有「角色美術風格」層級的可替換性。WP-B要做的「至少2套場景（宴會廳/校園）」是全新工作，不是現有系統的擴充。
- **狀態**：✅ 基本渲染、移動、GREETING狀態切換已可demo；🔴 場景套件抽象化（背景/邊界/退場JSON）未開工；🚧 Boids參數尚待依實際展場空間調校。

### M5 Dashboard管理模組
- **職責**：活動主辦端介面，在場角色數等、觸發合照、清除角色、系統健康呈現。
- **現況**：v1.0寫「基本畫面已demo」**言過其實**。目前`sketch.js`裡唯一相關的東西，是CUSTOMIZE畫面左上角一行文字標籤`"PERSONAFLOW: DIGITAL TWIN DASHBOARD"`，純粹是UI標題文字，**不是**功能性的管理面板——沒有角色數統計、沒有觸發合照按鈕、沒有清除角色功能、沒有系統健康度顯示（延遲/失敗率）。
- **狀態**：🔴 實質上尚未開工（僅有UI標題文字），優先級維持最低——現有功能夠用即可撐到期末，健康監控可不做。

### M6 群體記憶生成模組
- **職責**：
  1. 自動構圖演算法（依身高、新人/主視覺居中，依角色色彩分佈平衡構圖）
  2. AI合照式插畫生成
  3. QR下載機制
- **現況**：🔴 確認未開工，程式碼中無任何QR/合照相關實作（已搜尋repo確認）。與v1.0狀態標記一致，無需更正。
- **附註**：仍是委員第10點特別要求強化的模組，期末必須有現場可demo的完整流程。

### M7 實體實境互動機制（期末簡報亮點，呼應委員第7點）
- **職責**：連結虛擬事件回頭改變實體行為。
  - **v1 燈光/音效聯動廣播**（成本最低）：M6生成合照後的成品與QR，透過投影牆廣播明確的視覺訊號或音效。
  - **v2 相遇任務**：M4發出encounter事件後，投影牆顯示、兩位角色成為朋友──找到彼此並掃碼解鎖點數。
- **現況**：🔴 未開工。與v1.0狀態標記一致。**決策：期末以v1為承諾範圍，v2為衍生額外項目。**
- **附註**：v2依賴M4「獨立encounter事件」，但目前M4的相遇偵測是內嵌在`update_positions`裡的狀態欄位，若要做v2需要額外新增一個獨立事件（可沿用現有命名慣例叫`character_encounter`），這是v2的前置工作項，非既有基礎。

## 5. 模組間介面規格（分工開發的分界，統一後不再隨意更動）

### 5.1 角色特徵資料（M1→M2，實際payload格式）

v1.0文件裡的`{hair, top, bottom}`簡化schema與實際輸出不符。以下是`generate_avatar`實際透過`avatar_generated`事件回傳的資料形狀（依`app.py`第256-264行）：

```json
{
  "ok": true,
  "outfit": {
    "outer_type": "jacket", "outer_color": "navy",
    "inner_type": "t_shirt", "inner_color": "#1e6e46",
    "lower_type": "pants", "lower_color": "#5b7a99"
  },
  "stencil": "...（CV產生的輪廓/遮罩資料，格式依cv_module實作）",
  "cloth_grid": { "...": "上身網格顏色資料（32×40，per-cell hex）" },
  "lower_grid": { "...": "下身網格顏色資料（24×30，per-cell hex）" },
  "arm_color": { "hex": "#c08040" },
  "face": {
    "face_shape": "oval", "eye_shape": "almond", "eyebrow_style": "straight",
    "smile_score": 0.62, "lip_color": "#a5453d",
    "hair_style": "short_straight", "hair_color": "#3B2314",
    "skin_tone": "#FFD0A8", "eye_color": "#7A4A28",
    "has_beard": false, "beard_style": "none"
  }
}
```
註：`outfit`裡的`*_color`實際上部分來自VLM分類詞映射、部分被`inner_color`/`lower_color`用CV的`hex`覆蓋（見`app.py`第226-229行），VLM與CV的欄位覆蓋規則要在WP-A整併時明確化並寫進這裡，目前是隱含在程式碼裡沒有文件化的行為。

### 5.2 Socket.io事件定義（M3為中樞，實際事件名，取代v1.0的命名）

v1.0表格裡的`character:spawn`、`character:upgrade`、`character:encounter`、`photo:trigger`、`photo:ready`、`system:health`**在程式碼中全部不存在**，是規劃階段的假想命名，且用了冒號分隔格式，跟CLAUDE.md自訂的「動詞_名詞」慣例本身就矛盾。以下是實際運作中的事件：

| 事件名 | 發送方→接收方 | payload重點 | 用途 |
|---|---|---|---|
| `process_frame` | 前端→後端 | base64影像 | 即時預覽（骨架/顏色preview），非正式生成 |
| `clothing_features` | 後端→前端 | CV特徵＋fallback旗標 | 回應`process_frame` |
| `generate_avatar` | 前端→後端 | base64影像 | 觸發正式CV+VLM+face並行生成 |
| `avatar_generated` | 後端→前端 | 見5.1完整角色資料 | 生成結果（含失敗分支`{ok:false}`） |
| `join_swarm` | 前端→後端 | 角色完整資料+初始座標 | 加入群聚場 |
| `swarm_joined` | 後端→前端 | 角色id | 確認加入 |
| `leave_swarm` | 前端→後端 | 角色id | 離開群聚場 |
| `update_character` | 前端→後端 | 角色id+要更新的欄位 | 自訂配件等更新 |
| `update_positions` | 後端→所有端（含投影牆） | 全體角色陣列（含GREETING/ROAMING狀態） | 每0.1秒tick廣播，取代v1.0的`character:encounter` |
| `get_swarm` | 前端→後端 | 無 | 主動要一次目前全體狀態 |
| `connect`/`disconnect` | Socket.io內建 | - | 連線管理，斷線時自動移除該角色 |

**尚未存在、但WP-B/M6/M7需要新增的事件**（規劃用，非現況）：合照觸發（可沿用命名慣例叫`trigger_photo`）、合照完成（`photo_ready`）、相遇任務用的獨立`character_encounter`。命名一律沿用CLAUDE.md「動詞_名詞snake_case」慣例，不要用冒號格式。

### 5.3 事件log格式（M3落地，實測數據來源）——**目前完全未實作**

規劃格式維持：JSON lines（每事件一行）：`{"ts": "...", "event": "join_swarm", "pid": "...", "latency_ms": 2140}`。**現況：`app.py`沒有任何寫檔邏輯，這不是「開發期沒空補」的狀態，是完全的0，必須排入WP-A或WP-B近期任務，否則WP-C的9月實測拿不到任何數據，整份期末報告的「一組誠實的技術數據」（任務分派文件第1節第3點）會直接開天窗。**

## 6. 效能量測設計（期末簡報的技術骨幹）

| 指標 | 定義 | 目標值 | 量測點 |
|---|---|---|---|
| 生成延遲 | 拍照完成→`avatar_generated`回傳 | 中位數 < 5s（**已依現況下修**，見下方說明） | `generate_avatar` handler |
| CV子流程延遲 | `generate_avatar`內cv_module執行時間 | < 1s | `cv_module.get_clothing_features` |
| VLM子流程延遲 | `generate_avatar`內兩支Gemini呼叫（並行） | 中位數 < 5s | `vlm_module.analyze_outfit`/`analyze_face` |
| 生成失敗率 | Gemini呼叫例外或逾時佔比 | < 15%（誠實記錄即可） | `vlm_module` |
| 併發承載量 | 同場穩定渲染角色數 | ≥ 30 | M4壓測 |
| 合照生成耗時 | 觸發→QR可掃 | < 60s | M6（尚未開工，無基準可測） |

**說明**：v1.0文件把「即時上場延遲 < 3秒」設為M1入口到M4渲染的目標值，這個目標值是假設有Track A模板快速上場的前提下才合理。現況（M2只有單一同步CV+VLM流程，兩支Gemini請求並行但仍要等待網路往返）下，3秒內完成是不現實的目標，實測前應先用現有系統跑幾次取得基準線，再決定WP-A做完分軌後的正式目標值。**目標值仍是工程假設，實測後以真實數據取代——這一點沿用v1.0原文，仍然成立。**

## 7. 技術棧總表

| 層 | 技術 | 備註 |
|---|---|---|
| 特徵擷取 | Python, MediaPipe（PoseLandmarker任務API）, OpenCV | 在Flask-SocketIO事件handler內直接呼叫，非獨立API |
| AI生成 | Gemini 1.5 Flash（`google-generativeai`） | 用於服裝分類與臉部特徵分類，非影像生成；**API金鑰目前寫死在`vlm_module.py`原始碼中，見第8節風險** |
| 通訊/中樞/生成整合 | **Flask + Flask-SocketIO（eventlet）** | **單一Python服務，v1.0寫的Node.js從未存在於此repo，是規劃階段誤植** |
| 前端渲染 | p5.js + Socket.io-client | `sketch.js`（互動主流程）＋ `projection.html`（投影牆） |
| 資料 | 尚無落地機制 | 規劃中：JSON lines log，事後用pandas分析（見5.3） |

## 8. 風險與紓解

| 風險 | 影響 | 紓解 |
|---|---|---|
| Gemini API不穩/漲幅/斷流 | Track B（現況：唯一路徑）當機 | Fallback本來就是不談判的必要項，優先度上調（見4.2） |
| 現場網路品質差 | 全系統延遲 | 實測需自備行動熱點，本機部署為主，避免雲端呼叫的網速依賴 |
| Gemini呼叫延遲高、無分軌 | 使用者等待體驗差，M7demo流程卡頓 | WP-A補分軌與fallback，這是排期最前面的項目 |
| **`GEMINI_API_KEY`寫死在`vlm_module.py`原始碼並已提交進git** | **金鑰外洩、被盜用產生額外帳單、若repo公開等同金鑰公開** | **新增風險，需立即處理：改用環境變數/`.env`（`.gitignore`排除），並在GCP/Google AI Studio主控台輪替（撤銷）目前這把金鑰。`requirements.txt`也漏了`google-generativeai`，需要補上，否則其他人`pip install -r requirements.txt`裝不出可跑的環境。** |
| **事件log完全未落地** | **WP-C的9月實測拿不到任何數據，期末報告「一組誠實的技術數據」開天窗** | **新增風險，優先序拉高至WP-A或WP-B近期任務，不能等到9月才發現沒東西可收** |
| 深色/複雜衣著判斷失敗 | 角色失真 | confidence欄位目前VLM分類結果沒有回傳信心值，需與現有CV流程對齊（cv_module原本有confidence概念但VLM分類部分沒有），此為WP-A整併時要一併處理的落差 |
| 多人同時拍照造成單點瓶頸 | 佇列卡住 | M2目前是單一sid對應的同步流程（見`app.py`），尚無queue機制，人潮壓力測試前需先設計 |
| 拍攝隱私（照片） | 實測許可問題 | 現場公告、口頭同意、原始照片與特徵向量即刻分離（log只存JSON，不存影像）——此點沿用v1.0原文，`app.py`目前確實只在記憶體處理影像、不落地存檔，此原則現況成立 |

## 9. 變更紀錄

| 日期 | 版本 | 變更 | 決策人 |
|---|---|---|---|
| 2026-07-09 | v1.0 | 初版：模組邊界、介面規格、混合式生成管線定案 | 巫姓組員 |
| 2026-07-09 | v1.1 | 依現有程式碼校正：移除不存在的Node.js技術棧、改寫Socket.io事件表與JSON schema為實際格式、修正M1(三模組)/M2(單一同步流程非雙軌)/M3(log落地0%)/M4(無場景套件)/M5(僅UI標籤非真Dashboard)現況、新增API金鑰外洩與log未落地兩項風險 | 待組內確認 |
