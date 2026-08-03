# PersonaFlow · 數位轉譯角色空間互動系統

PersonaFlow 將參與者的全身影像轉譯為 LEGO 風格插畫角色，並透過 Boids 群聚演算法讓角色進入公共投影空間，形成集體共創畫面。

目前開發重點集中在 M1（攝影、人體與服裝特徵）及 M2（角色生成穩定度、品質與成本）。M3–M7 暫不新增業務功能，只維持 metadata 傳遞、Boids 與 renderer 的可擴充性。

> [!WARNING]
> **正式模式仍在研發嘗試中，尚未成功。** 目前 `brick_v2` 已完成合成幾何、資料契約、AI Atlas 規則、模組化髮型與部分服裝部件，但合成畫面的髮際線、部件接合和服裝輪廓仍在調整；尚未以新版管線重新完成真人 P01 材質生成，更未達到可展示或可宣稱與目標參考圖同等品質的程度。`brick_ai_texture` 是候選正式架構，不是已完成的正式功能。

## 目前研發判定

| 項目 | 判定 | 說明 |
|---|---|---|
| 攝影、站位與 CV | 可開發測試 | 可取得人體、服裝區域、顏色與有限體型資訊，現場門檻仍需校正 |
| `brick_v1` | 未達標 | 曾出現像素拼接、浮動貼紙、固定臉與物種割裂問題，不作為最終方向 |
| `brick_v2` 固定物種 | 進行中 | 已重建肩寬腰窄軀幹、C形手、鞋、關節、真實表面 UV 與共用動畫骨架 |
| 模組化 3D 髮型 A | 進行中 | 已選定並實作參數化髮殼、側髮、後髮、髮髻與馬尾；髮際線仍需視覺校正 |
| 服裝與體型 | 進行中 | 已加入受限體型參數與固定服裝幾何文法；裙裝、帽T、大衣等仍需逐類驗證 |
| AI 材質 Atlas | 尚待真人重測 | 新 validator 可拒絕完整衣服貼紙、背景與烘焙陰影，但尚未取得新版真人生成結果 |
| Three.js 單人／投影 | 技術串接完成、視覺未驗收 | 共用 `brick_v2` builder、走路與揮手骨架已接通，尚未通過最終外觀與多人效能驗收 |
| 正式對外展示 | **不可用** | 必須先通過合成視覺閘門、P01 手動生成、5人測試與盲評 |

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
| AI 角色生成 | `brick_ai_texture` 是研發主線但尚未成功；`full_character` 僅作研究比較，`body_sprite` 已退役 |
| 生成進度 | 後端回報接收、CV、生成、驗證、精修與完成等實際里程碑 |
| 本機審查 | 規則 validator 檢查透明背景、構圖、碎裂、左右腿與鞋等結構問題 |
| 生成歷史 | SQLite 保存每次 run／attempt、生成圖、耗時、token、成本與錯誤 |
| 人工審查 | 通過判定、四項 1–5 分評分及文字備註 |
| 角色風格架構 | 後端 generation registry＋前端 renderer registry；目前只註冊 LEGO |
| 群體互動 | Flask-SocketIO 傳遞角色狀態，Boids 控制投影角色移動 |

## 使用介面

- 主操作頁提供 AI 材質3D主模式與完整生圖比較模式；已退役模式仍可在歷史頁辨識。
- 攝影機預設關閉，可按按鈕自行啟用；也可直接使用「LOAD TEST PHOTO」上傳測試照片。
- 正式生成時顯示階段式進度條。百分比代表流程里程碑，不是模型內部的精確剩餘時間。
- 「生成歷史／成本」可檢視每次生圖、API request、耗時、token、費用與人工評分。

本機頁面：

- 主操作頁：<http://127.0.0.1:8000/index.html>
- 投影頁：<http://127.0.0.1:8000/projection.html>
- 生成歷史與成本：<http://127.0.0.1:8000/dev.html>
- 後端健康檢查：<http://127.0.0.1:5001/health>

## 生成模式

### 候選正式模式（尚未成功）：`brick_ai_texture`

- 目標是以固定原創 3D 積木幾何、骨架、材質與燈光統一物種。
- Pro image model 只生成臉、上衣與左右腿的固定 UV 材質。
- AI 材質通過版位、顏色與細節檢查後才套用到 Three.js 角色。
- 主操作頁直接使用 Three.js 讀取 `CharacterSpec` 與 AI Atlas，使用和投影牆一致的固定材質、相機及燈光。
- 3D 預覽完成後可保存透明 PNG 到同一筆生成歷史，不再以 p5.js CV 色塊冒充正式結果。
- 目前公開預設仍保留 `BRICK_CHARACTER_STYLE=brick_v1`，避免未驗收的 `brick_v2` 被誤當成成功結果。
- `brick_v2` 僅能在合成 fixture 與開發旗標下測試；真人結果需要專案負責人手動生成並確認。

目前失敗證據包括：舊 atlas 曾把完整衣服輪廓與背景畫進 UV、模型像尺寸不合的貼紙、髮型與頭部接合不自然，以及裙殼曾錯誤疊在長褲幾何上。這些問題正在逐項改成可驗證的幾何與資料規則，不能只靠 prompt 修飾。

### 已退役：`body_sprite`

- 舊流程由 AI 生成軀幹與雙腿，再拼接程式化頭、手臂、手與鞋。
- 因臉部固定、畫風拼接且不符合物種統一研究方向，公開入口與新請求均已停用；舊紀錄保留。

### 實驗模式：`full_character`

- AI 一次產生完整角色，用來和正式 3D 材質模式比較細節與成本。
- 驗證失敗會回傳明確原因，不自動付費重生。

`body_sprite`、`brick_v1` 快速備援與 `full_character_refined` 完整＋精修已從公開模式移除；舊歷史紀錄仍可在開發頁查看。

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
3. 不自動重試，也不回退模式一。
4. 失敗生成圖仍保存於開發歷史，供開發者分析模型為何失敗。

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
5. 完成單人服裝／人物精緻度與10人群體物種一致性評分。
6. 至少5位評分者全部完成後，管理者結束批次並查看 variant、成本、P50／P95及品質分數。
7. 匯出 CSV／JSON；評測結束可刪除本批次所有真人縮圖而保留生成與評分資料。

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
| 生成層 | OpenRouter、OpenAI-compatible SDK | 候選 AI 臉部／服裝印刷 Atlas 與完整角色比較實驗 |
| 資料層 | SQLite、Rotating JSONL | 開發歷史、token／cost、人工審查及匿名 metrics |
| 主畫面 | JavaScript、p5.js、Three.js、Socket.io | 攝影／上傳、進度條與候選 3D 角色預覽 |
| 投影頁 | JavaScript、Three.js | 與單人預覽共用 `brick_v2` builder、材質、骨架、燈光及 Boids 座標 |

後端使用 Flask-SocketIO 的 `threading` async mode。CV preview、VLM 與正式 image generation 使用不同 executor，避免即時預覽佇列阻塞正式生成。

## 目錄結構

```text
PersonaFlow/
├── backend/
│   ├── app.py                  # Flask、Socket、M1/M2 orchestration、進度事件
│   ├── cv_module.py            # 人體、服裝色彩、輪廓與局部區域
│   ├── face_module.py          # 本機臉部特徵
│   ├── vlm_module.py           # 可選 Gemini 語意分析
│   ├── garment_gen.py          # body／full／refine 生圖流程
│   ├── ai_texture_gen.py        # 固定四格 AI 印刷 Atlas 生成、拆分與驗證
│   ├── brick_v2_spec.py         # brick_v2 物種、比例、UV、材質與接合規格
│   ├── brick_v2_atlas.py        # 拒絕衣服輪廓、背景污染與烘焙陰影
│   ├── brick_v2_garment.py      # 衣物語意轉固定服裝幾何文法
│   ├── character_spec.py        # CharacterSpec、受限體型與材質資料
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
│   ├── projection.html         # 投影頁
│   ├── projection3d.html       # Three.js 群體投影與 brick_v2 動畫
│   ├── brick-v2-model.js       # 共用 brick_v2 幾何、UV、髮型與服裝部件
│   ├── brick3d-preview.js      # 單人透明背景 Three.js 預覽
│   ├── brick-v2-fixture.html   # 不用真人／AI的合成體型與服裝視覺測試
│   ├── sketch.js               # p5.js 狀態、攝影、上傳、進度與渲染
│   ├── character.js            # Person 角色資料與渲染接點
│   ├── socket.js               # Socket.io client
│   └── themes/
│       ├── registry.js         # 前端 renderer registry
│       └── lego.js             # LEGO renderer
├── PRD.md
├── BRICK_V2_SPEC.md            # brick_v2 可執行視覺契約與開發閘門
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
| `OUTFIT_GEN_MODEL` | `google/gemini-3.1-flash-image-preview` | AI 組合角色模型 |
| `FULL_CHARACTER_MODEL` | `google/gemini-3-pro-image-preview` | 模式二完整角色模型 |
| `BRICK_TEXTURE_MODEL` | `google/gemini-3-pro-image-preview` | 正式模式固定 UV 材質模型 |
| `BRICK_CHARACTER_STYLE` | `brick_v1` | 新請求使用的固定幾何版本；`brick_v2` 尚未驗收，勿作正式展示 |
| `GENERATION_MODE` | `brick_ai_texture` | 後端預設模式；主頁可逐次選擇 |
| `GENERATION_MAX_RETRIES` | `0` | 自動付費重試次數，開發預設關閉 |
| `FULL_MODE_VLM_ENABLED` | `0` | 是否讓完整角色模式額外呼叫服裝／臉部 VLM |
| `GEMINI_API_KEY` | 空 | 正式／組合模式可選語意分析 |
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
| `avatar_generated` | 後端 → 前端 | 基礎／AI 材質／完整角色結果與 validation |
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
- 模式二成功、失敗要求重拍且不回退模式一。
- 被移除的舊模式會安全映射到正式模式，且不呼叫舊精修器。
- 真實進度里程碑事件。
- SQLite token／cost 聚合與人工審查。
- style registry 與 Socket metadata 保存。

目前共有 73 項測試。這些測試涵蓋程式契約、資料介面、錯誤阻擋與部分幾何選型；**不代表 3D 外觀已通過人工視覺驗收。**

## 已知限制與下一步

- **正式模式尚未成功**：目前不得以測試數量、API成功回應或合成 fixture 取代真人視覺驗收。
- **髮型瓶頸**：A方案以有限模組組合大量髮型，但髮際線、分線、瀏海與頭部交界仍容易像帽子；需先完成合成視角檢查，再測真人語意映射。
- **服裝瓶頸**：一張 torso 貼圖不能表達裙擺、帽兜、大衣厚度或無袖輪廓。現改用有限服裝幾何文法，但每一類附件仍需驗證正面、45度、側面及動畫碰撞。
- **體型瓶頸**：肩寬、軀幹寬深與肢體粗細只能作風格化相對差異；寬鬆衣物會干擾體型估算，因此服裝 fit 與 body shape 必須分開處理。
- **AI Atlas瓶頸**：模型容易把完整衣服、背景與方向性陰影畫入 UV。新版 validator 已能攔截部分錯誤，但能否穩定產出合格印刷仍缺真人生成證據。
- **人物精緻度瓶頸**：固定物種解決多手多腳與風格漂移，但臉、髮型、眼鏡、鬍鬚、領口、圖案與鞋款的個體辨識度仍未達標。
- **效能瓶頸**：模組化髮型與個人貼圖會增加 draw calls、記憶體與載入時間；50／100人 FPS 尚未完成正式量測。
- **視覺檢查工具限制**：目前主要以合成 fixture 與人工截圖迭代；沒有可連接的 Browser 分頁時，外觀不能只靠單元測試判定。
- 拍攝品質閘門與身高門檻仍需固定攝影站實測校正。
- 本機 validator 能判斷格式與部分結構，不能可靠判斷是否像本人或是否達到目標參考圖。

### 下一階段順序

1. 先讓合成 fixture 的一般、短褲、裙裝、帽T與大衣在正面／45度／側面沒有錯誤接縫、穿透或多餘部件。
2. 完成模組化髮型 A 的髮際線、短髮、長髮、捲髮、馬尾與髮髻視覺基準。
3. 將 `BRICK_CHARACTER_STYLE=brick_v2` 只開在開發環境，驗證 CharacterSpec → Atlas → Three.js → 生成歷史的完整鏈路。
4. 到需要真人 P01 AI 材質時停止於 `USER_MANUAL_GENERATION_REQUIRED`，由專案負責人手動生成並提供結果；系統不得自行假設成功。
5. P01通過後才擴至 P02，再進行5位真人、每人1張照片的服裝／髮型／體型測試。
6. 將結果納入 `dev.html` 生成歷史、成本與盲評，至少5位評分者完成後比較物種一致性、人物精緻度、成本與延遲。
7. 最後才評估開啟正式模式及50／100人投影效能；任何一項未達門檻都維持「研發中」。

更完整的產品規格與欄位定義請參考 [PRD.md](./PRD.md)，brick_v2 視覺契約請參考 [BRICK_V2_SPEC.md](./BRICK_V2_SPEC.md)，開發操作請參考 [AGENTS.md](./AGENTS.md)。
