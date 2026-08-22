# PersonaFlow · 數位轉譯角色空間互動系統

PersonaFlow 將參與者的全身影像轉譯為 LEGO 風格插畫角色，並透過 Boids 群聚演算法讓角色進入公共投影空間，形成集體共創畫面。

目前開發重點集中在 M1（攝影、人體與服裝特徵）及 M2（角色生成穩定度、品質與成本）。M3–M7 暫不新增業務功能，只維持 metadata 傳遞、Boids 與 renderer 的可擴充性。

> [!WARNING]
> **角色物種一致性尚未達成，不可對外展示。** 目前 `full_character` 能穩定產出構圖完整的角色，但不同人生成出來的畫風仍會漂移（線寬、明暗、五官畫法各不相同）。跨角色的物種一致性是現階段的核心研究問題，尚未解決。

## 架構轉向（2026-08）

固定 3D 幾何路線（`brick_ai_texture` / `brick_v1` / `brick_v2`）已**整條移除**。

移除原因：該路線要求影像模型產出貼在固定 UV 上的材質圖集，但實測輸出的軀幹與腿部格是「浮在白底上的服裝型錄插畫」——完整衣服外輪廓加背景，貼到 3D 模型上完全不能看。這不是 prompt 措辭問題，而是模型難以理解 UV 貼圖這個概念。

現行唯一路線是 `full_character`：模型一次畫出整隻角色，輸出即最終畫面，以 2D sprite 進入投影牆。

**代價**：固定網格原本免費保證「兩隻手、兩條腿、比例一致」，現在要靠 prompt 與結構驗證去爭取。

## 目前研發判定

| 項目 | 判定 | 說明 |
|---|---|---|
| 攝影、站位與 CV | 可開發測試 | 可取得人體、服裝區域、顏色與有限體型資訊，現場門檻仍需校正 |
| `full_character` 構圖完整度 | 大致可用 | 比例正確、五官乾淨；多肢與缺鞋由 validator＋重試處理 |
| **跨角色物種一致性** | **未解決（核心問題）** | 目前無風格參考圖，畫風只靠文字描述，因此必然漂移 |
| 個體特徵保真 | 部分 | 服裝顏色走 CV 量測；膚色髮色仍被量化成 6–8 個桶 |
| 物種漂移量測 | 建置中 | `style_fingerprint.fingerprint_spread` 是量化定義，正在接入生成管線 |
| 正式對外展示 | **不可用** | 必須先解決物種一致性並通過真人盲評 |

目前最重要的原則是：**測試通過只代表資料與程式契約沒有破壞，不代表角色視覺品質已成功。**

## 目前功能

| 功能 | 目前狀態 |
|---|---|
| 人體與全身站位偵測 | MediaPipe Pose／Segmentation；檢查肩、髖、膝、腳踝、腳跟與腳尖 |
| 拍攝品質閘門 | 全身入框、visibility、連續五幀穩定度與倒數期間持續驗證 |
| 攝影機隱私 | 預設關閉；按「開啟攝影機」後才請求權限並建立 MediaStream |
| 開發照片測試 | 可上傳本地照片，走與正式拍照相同的生成流程 |
| 服裝色彩 | OpenCV 取得上身、下身及手臂色彩；CV 是色彩基準 |
| 身高分級 | 固定攝影站下分類 `short / medium / tall`，只影響角色視覺比例與倍率 |
| AI 角色生成 | `full_character` 為唯一路線；`brick_ai_texture` 與 `body_sprite` 已退役 |
| 生成進度 | 後端回報接收、CV、生成、驗證、精修與完成等實際里程碑 |
| 本機審查 | 規則 validator 檢查透明背景、構圖、碎裂、左右腿與鞋等結構問題 |
| 生成歷史 | SQLite 保存每次 run／attempt、生成圖、耗時、token、成本與錯誤 |
| 人工審查 | 通過判定、四項 1–5 分評分及文字備註 |
| 角色風格架構 | 後端 generation registry＋前端 renderer registry；目前只註冊 LEGO |
| 群體互動 | Flask-SocketIO 傳遞角色狀態，Boids 控制投影角色移動 |

## 使用介面

- 主操作頁只提供 `full_character` 完整角色生成；已退役模式仍可在歷史頁辨識。
- 攝影機預設關閉，可按按鈕自行啟用；也可直接使用「LOAD TEST PHOTO」上傳測試照片。
- 正式生成時顯示階段式進度條。百分比代表流程里程碑，不是模型內部的精確剩餘時間。
- 「生成歷史／成本」可檢視每次生圖、API request、耗時、token、費用與人工評分。

本機頁面：

- 主操作頁：<http://127.0.0.1:8000/index.html>
- 投影頁：<http://127.0.0.1:8000/projection.html>
- 生成歷史與成本：<http://127.0.0.1:8000/dev.html>
- 後端健康檢查：<http://127.0.0.1:5001/health>

## 生成模式

### 唯一路線：`full_character`

- AI 一次產生完整角色（頭、髮、臉、身體、腿、鞋），輸出即最終畫面。
- 送三張圖給模型：訪客照片（WHO）、CV 特寫拼版（WHO 細節）、程式繪製的姿勢參考（幾何）。
- 結果經 `avatar_quality.py` 檢查透明背景、構圖、碎裂、左右腿與鞋；失敗回傳明確原因。
- 以 2D sprite 進入 Boids 投影牆。

**已知缺口**：目前**沒有任何風格參考圖**送進模型，畫風完全只靠 prompt 文字描述，這是跨角色物種漂移的直接原因。

### 已退役

| 模式 | 退役原因 |
|---|---|
| `brick_ai_texture` | 模型無法產出可用的 UV 材質圖集，輸出是服裝型錄插畫而非布料裁切 |
| `body_sprite` | 臉部固定、畫風拼接，不符合物種統一方向 |
| `full_character_refined` | 兩段式精修的成本與延遲不划算 |

新請求指定以上任一模式都會在付費呼叫前直接拒絕；舊歷史紀錄仍可在開發頁查看。

## 審查流程

審查分為「自動規則」與「人工判斷」，兩者分開保存，不互相覆蓋。

### 1. 自動規則 Validator

每次 AI attempt 完成後，`backend/avatar_quality.py` 會在本機檢查：

- 圖片能否解碼、是否存在有效前景。
- 前景是否佔全圖 5%–85%。
- 角色是否碰到畫布邊界。
- 最大連通區是否至少佔前景 75%，避免肢體嚴重碎裂。
- 畫面底部左右兩側是否都有內容，用來攔截缺腿／缺鞋。
- 上、下身 Lab 色差只記錄 warning，第一階段不作為硬性失敗。

生成圖若只是邊緣抗鋸齒像素，會先在本機加透明 margin，不會因此再次付費生圖。

完整角色模式若硬性失敗：

1. 將 validation code、中文原因與重拍建議送回前端。
2. 前端回到上傳／拍攝頁面。
2. 不自動重試，也不回退模式一。
3. 失敗生成圖仍保存於開發歷史，供開發者分析模型為何失敗。

### 2. 人工審查與多人盲評

開發者可在 `frontend/dev.html` 對每筆生成 run 填寫：

- `pass / fail / pending`
- 肢體完整度 1–5
- 服裝相似度 1–5
- 臉／髮型相似度 1–5
- 整體效果 1–5
- 自由文字備註

人工審查是跨模式比較的 ground truth。規則 validator 擅長判斷結構是否完整，但無法可靠判斷角色是否像本人、衣服版型是否正確或精修是否真的變好。

同一個 `frontend/dev.html` 也提供正式多人盲評：可用 `experiment_id`、`comparison_id`、`variant_id` 配對10位人物的不同生成方法，匯入 Firefly／Colab 等外部結果，並在提交前隱藏模型、variant、成本、耗時及自動分數。至少5位評分者完成單人與群體評分後，管理者才能解除匿名並查看品質／成本結果。

### 人工備註的用途

分數適合統計，備註則保存分數表達不了的具體現象，例如：

- 鞋子看起來像手，或手腳形狀混淆。
- 外套版型錯誤，但衣服顏色正確。
- 臉部完整，卻不像本人。
- 底圖較自然，精修後反而改壞髮型。
- 構圖完整，但 LEGO 風格不一致。

備註目前不會直接送入模型，也不會自動修改 prompt。它是後續分析與決策證據，避免因單一案例就反覆改動生成流程。

## 盲評實驗流程

操作順序：

1. 建立實驗並將生成紀錄標記為 P01–P10 與對應 variant。
2. 匯入經同意的低解析度真人參考縮圖；縮圖會移除 EXIF 並存於 gitignored 本機目錄。
3. 匯入 Firefly／Scenario／Colab 外部結果及人工回報的耗時、成本與參數。
4. 建立並鎖定盲評批次；每位評分者的項目與候選組順序固定亂序。
4. 完成單人服裝／人物精緻度與10人群體物種一致性評分。
5. 至少5位評分者全部完成後，管理者結束批次並查看 variant、成本、P50／P95及品質分數。
6. 匯出 CSV／JSON；評測結束可刪除本批次所有真人縮圖而保留生成與評分資料。

最終評估不只看成功率，而是同時比較：

```text
結構通過率 × 人工品質分數 × 角色相似度 ÷ 平均成本與等待時間
```

## 生成歷史、成本與隱私

開發資料存放於 gitignored 的 `backend/logs/`：

```text
backend/logs/
├── generation_history.sqlite3  # run、attempt、review、token、cost
├── generated/                  # 每次 AI attempt 的生成 PNG
├── review_sources/             # 明確匯入的盲評縮圖，可按實驗刪除
└── m1_m2_metrics.jsonl         # 匿名流程指標，5 MB 輪替、保留 3 份
```

SQLite 每次 attempt 可記錄：

- mode、style、來源（upload／camera）及 stage
- 模型與 provider request id
- CV、VLM、generation 及總耗時
- prompt、completion、image、cached token
- OpenRouter response 的 `usage.cost` 與 upstream cost
- validation errors／warnings、retry 與最終狀態
- 生成結果 PNG 與人工審查

隱私原則：

- 正式生成不保存上傳／拍攝的原始照片。
- 盲評只保存使用者明確匯入、去 EXIF 且縮至 640px 的測試縮圖。
- 不保存原始照片 base64、landmarks、顏色或人物屬性。
- 可保存 AI 生成的角色 PNG，供開發比較。
- `backend/logs/` 不會提交至 Git。

## 生成進度里程碑

前端以 `generation_progress` Socket 事件顯示後端實際流程：

- 接收照片
- CV 人體／服裝特徵分析
- 角色或底圖生成
- 本機規則驗證
- 最後合成與完成

百分比是階段里程碑。單次 image API 內部沒有可取得的精確生成百分比，因此模型等待期間只顯示目前階段與持續活動提示，不偽造剩餘時間。

## 身高分級

身高是固定攝影站下的角色視覺分級，不是精確公分測量：

| Profile | 預設判定 | 顯示倍率 | 模式一軀幹 Y | 模式一腿部 Y |
|---|---:|---:|---:|---:|
| `short` | `< 0.72` | 0.90 | 0.96 | 0.90 |
| `medium` | `0.72–0.84` | 1.00 | 1.00 | 1.00 |
| `tall` | `> 0.84` | 1.10 | 1.02 | 1.12 |

正式展示前需依現場相機位置、焦距、站立距離與地面線重新校正門檻。

## 技術架構

| 層級 | 技術 | 職責 |
|---|---|---|
| 感知層 | Python、MediaPipe、OpenCV | 姿勢、人體遮罩、服裝色彩、臉部與局部區域 |
| 邏輯層 | Python、Flask、Flask-SocketIO | session 隔離、生成流程、驗證、歷史 API、Socket 通訊 |
| 生成層 | OpenRouter、OpenAI-compatible SDK | 完整角色一次生成 |
| 資料層 | SQLite、Rotating JSONL | 開發歷史、token／cost、人工審查及匿名 metrics |
| 主畫面 | JavaScript、p5.js、Socket.io | 攝影／上傳、進度條與角色預覽 |
| 投影頁 | JavaScript、p5.js | 2D sprite 群聚投影與 Boids 座標 |

後端使用 Flask-SocketIO 的 `threading` async mode。CV preview、VLM 與正式 image generation 使用不同 executor，避免即時預覽佇列阻塞正式生成。

## 目錄結構

```text
PersonaFlow/
├── backend/
│   ├── app.py                  # Flask、Socket、M1/M2 orchestration、進度事件
│   ├── cv_module.py            # 人體、服裝色彩、輪廓與局部區域
│   ├── face_module.py          # 本機臉部特徵
│   ├── vlm_module.py           # 可選 Gemini 語意分析
│   ├── garment_gen.py          # 完整角色生圖流程與 prompt 模板
│   ├── style_base.py           # 從參考圖量出的風格標準（數值化）
│   ├── style_fingerprint.py    # 風格指紋與跨角色漂移量測
│   ├── style_normalizer.py     # 方向性明暗量測與正規化
│   ├── avatar_quality.py       # 本機生成圖 validator
│   ├── capture_quality.py      # 拍攝站位與穩定度規則
│   ├── generation_history.py   # SQLite run／attempt／人工審查
│   ├── height_profiles.py      # short／medium／tall profiles
│   ├── metrics_logger.py       # 隱私保護 JSONL 指標
│   ├── style_registry.py       # 後端生成風格 registry
│   ├── swarm_logic.py          # Boids 群聚演算法
│   └── tests/                  # M1、M2、validator、history、registry 測試
├── frontend/
│   ├── index.html              # 主操作頁與生成模式選擇
│   ├── dev.html                # 生成歷史、成本、圖片比較與人工審查
│   ├── projection.html         # 投影頁（2D sprite 群聚）
│   ├── sketch.js               # p5.js 狀態、攝影、上傳、進度與渲染
│   ├── character.js            # Person 角色資料與渲染接點
│   ├── socket.js               # Socket.io client
│   └── themes/
│       ├── registry.js         # 前端 renderer registry
│       └── lego.js             # LEGO renderer
├── PRD.md
├── STYLE_BASE.md               # 基底風格標準（量測方法與數值）
├── EXTERNAL_AI_RESEARCH_BRIEF.md
├── AGENTS.md
├── TechStack.md
├── .env.example
└── requirements.txt
```

## 快速啟動

以下指令皆從專案根目錄執行。

### 1. 安裝依賴與環境設定

```powershell
pip install -r requirements.txt
Copy-Item .env.example backend\.env
```

在 `backend/.env` 填入 API key 與模型設定。不要提交 `.env`。

### 2. 啟動後端

```powershell
python backend/app.py
```

後端位於 `http://127.0.0.1:5001`。

### 3. 啟動前端

另開一個終端機：

```powershell
python -m http.server 8000 --directory frontend
```

開啟主操作頁：

```powershell
Start-Process 'http://127.0.0.1:8000/index.html'
```

要停止服務，回到各自終端機按 `Ctrl+C`。完整的啟動、開啟與依 PID 關閉方式請參考 `AGENTS.md`。

## 環境變數

| 變數 | 預設／範例 | 用途 |
|---|---|---|
| `OPENAI_API_KEY` | `sk-or-v1-...` | OpenRouter／OpenAI-compatible 金鑰 |
| `OPENAI_BASE_URL` | OpenRouter 自動判定 | 可選 API base URL |
| `FULL_CHARACTER_MODEL` | `google/gemini-3-pro-image-preview` | 完整角色生成模型 |
| `GENERATION_MODE` | `full_character` | 後端預設模式；目前唯一支援值 |
| `GENERATION_MAX_RETRIES` | `0` | 自動付費重試次數，開發預設關閉 |
| `FULL_MODE_VLM_ENABLED` | `0` | 是否額外呼叫服裝／臉部 VLM（模型已看過原始照片，預設關閉）|
| `GEMINI_API_KEY` | 空 | 可選語意分析 |
| `CHARACTER_STYLE` | `lego` | 活動層級統一角色風格 |
| `HEIGHT_SHORT_MAX_RATIO` | `0.72` | short／medium 分界 |
| `HEIGHT_TALL_MIN_RATIO` | `0.84` | medium／tall 分界 |
| `DEV_HISTORY_ENABLED` | `1` | 啟用 SQLite 生成歷史 |
| `DEV_HISTORY_SAVE_OUTPUTS` | `1` | 保存每次 AI attempt 的生成 PNG |
| `METRICS_ENABLED` | `1` | 啟用匿名 JSONL metrics |

只有支援 OpenAI-compatible chat completions 且能輸出 image modality 的模型可直接使用目前的 `garment_gen.py` 流程。需要 `/images/generations` 等不同 endpoint 的模型必須另做 provider adapter。

## Socket 事件

| 事件 | 方向 | 用途 |
|---|---|---|
| `process_frame` | 前端 → 後端 | M1 即時 CV 預覽，可附 `frame_id` |
| `clothing_features` | 後端 → 前端 | 色彩、landmarks、站位品質與身高 metadata |
| `generate_avatar` | 前端 → 後端 | 正式生成，包含 `request_id`、mode、source type |
| `generation_progress` | 後端 → 前端 | 真實流程里程碑與提示文字 |
| `avatar_generated` | 後端 → 前端 | 完整角色結果與 validation |
| `join_swarm` | 前端 → 後端 | 將角色加入投影牆 |
| `update_character` | 前端 → 後端 | 更新角色配件與 metadata |
| `update_positions` | 後端 → 前端 | 廣播 Boids 角色位置 |

## 測試

```powershell
python -m unittest discover -s backend\tests -v
```

目前自動測試涵蓋：

- M1 全身、visibility、腳尖出界、穩定度與 session 隔離。
- 三段身高臨界值。
- 生成圖透明背景、碰邊、碎裂、缺腿／缺鞋及白衣保護。
- 完整角色生成成功、失敗要求重拍且不自動付費重生。
- 已退役模式在付費呼叫前被拒絕；未知模式安全回退到 `full_character`。
- 真實進度里程碑事件。
- SQLite token／cost 聚合與人工審查。
- style registry 與 Socket metadata 保存。

目前共有 73 項測試。這些測試涵蓋程式契約、資料介面與錯誤阻擋；**不代表角色外觀已通過人工視覺驗收。**

## 已知限制與下一步

- **物種一致性未解決（核心問題）**：目前沒有任何風格參考圖送進模型，畫風只由 prompt 文字描述決定，不同人之間的線寬、明暗與五官畫法必然漂移。
- **畫風已定案為光澤 3D 渲染感**（2026-08）：`garment_gen.py` 的 ART STYLE GUIDELINES 原本要求「扁平向量、無漸層、無陰影」，與 `style_base.py` 量到的 0.21–0.24 立體明暗互相矛盾；現已改寫成材質光澤排序、正面柔光與「印刷不帶光向」三條規則，並由 `test_prompt_style_agreement.py` 鎖住。**效果仍待真人生成驗證。**
- **幾何一致性失去免費保證**：移除固定 3D 網格後，「兩隻手、兩條腿、比例一致」要靠 prompt 與 `avatar_quality.py` 的結構檢查去爭取；多肢問題會回來。
- **個體特徵部分流失**：服裝顏色走 CV 量測，但膚色髮色仍被 VLM 量化成 6–8 個桶，抹平個體差異。
- **漂移無法量測**：`fingerprint_spread` 已寫好但尚未接入生成管線，目前沒有數字能回答「這批角色有多不一致」。
- **效能瓶頸**：50／100人 FPS 尚未完成正式量測。
- 拍攝品質閘門與身高門檻仍需固定攝影站實測校正。
- 本機 validator 能判斷格式與部分結構，不能可靠判斷是否像本人或是否達到目標參考圖。

### 已完成（2026-08 轉向）

1. **刪除固定 3D 幾何路線**，`full_character` 成為唯一模式，以 2D sprite 進投影牆。
2. **定案畫風為光澤 3D 渲染感**，並把 prompt 與 `style_base.py` 對齊（`test_prompt_style_agreement.py` 鎖住）。
3. **物種漂移可量測**：`style_probe.py` 把 `fingerprint_spread` 接上真實輸出，已接進 SQLite、API 與 `dev.html`。
4. **膚色髮色改用 CV 量測值**，VLM 六色表降為 fallback。

### 下一階段順序

1. **參考圖條件化**：上傳同一畫風、不同角色的樂高風格參考圖，作為第四張輸入送進模型；同時加上抄襲偵測（第一輪只收 warning）。
2. **幾何防護**：補上肢體數量與比例一致性檢查，接進既有的修正重試迴圈。
3. **個體忠實度指標**：與物種漂移成對量測，避免一致性把個體差異吃掉。
4. 到需要真人生成時停止於 `USER_MANUAL_GENERATION_REQUIRED`，由專案負責人手動生成並提供結果；系統不得自行假設成功。
5. 結果納入 `dev.html` 盲評，至少5位評分者完成後比較物種一致性、個體可分辨度、成本與延遲。

更完整的產品規格與欄位定義請參考 [PRD.md](./PRD.md)，風格標準請參考 [STYLE_BASE.md](./STYLE_BASE.md)，開發操作請參考 [AGENTS.md](./AGENTS.md)。
