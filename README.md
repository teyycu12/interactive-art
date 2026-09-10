# PersonaFlow · 數位轉譯角色空間互動系統

將實體穿著透過視覺識別技術數位化，轉譯為樂高風格插畫角色，並透過群體演算法在公共空間中生成集體共創視覺圖。

---

## 📌 整合現況

本專案已與 **PersonaFlow2**（Node.js 互動層）整合為單一展場作品。
依 v4.0 計畫書決議：PF2 為主幹，本專案的 CV/VLM/生圖管線退為**角色資產生成服務**。

| | 位置 |
|---|---|
| 互動層 | `server/` — α 仲裁共治、任務、配對、問答、計分、社交圖譜 |
| 前端 | `public/` — 手機控制器 / 大螢幕 / 主辦端 |
| 生成服務 | `backend/service.py` — CV／VLM／生圖／切片（127.0.0.1:5055） |
| 啟動 | `bash start.sh` |
| 測試 | Node 339 單元 + 128 端對端 + Python 423 |

**參與者有兩條入場路徑**：拍照掃描生成角色，或模組捏臉。
掃描失敗（相機權限被拒、非 HTTPS、生成服務未啟動）一律降級回捏臉，不會擋人進場。

```bash
npm install && pip install -r requirements.txt
bash start.sh                 # 生成服務 :5055 + 互動層 :3000
```

> **現場要用手機相機必須有 HTTPS** —— `getUserMedia` 在 `http://192.168.x.x` 上會被瀏覽器直接拒絕。
> 執行 `bash scripts/make-cert.sh` 產生憑證後，以
> `TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start` 啟動。

本機頁面：

- 大螢幕：<http://localhost:3000/screen/>
- 手機控制：<http://localhost:3000/controller/>（現場請改用終端機印出的區網 IP）
- 主辦端控制台：<http://localhost:3000/host/>（需要終端機印出的通行密鑰）
- 生成服務健康檢查：<http://127.0.0.1:5055/health>

完整說明見 [CLAUDE.md](CLAUDE.md)（精簡索引）與 [docs/notes/](docs/notes/)（各主題的踩坑筆記）。

---

## 以下為角色生成管線說明

生成管線把參與者的全身影像轉譯為插畫角色，交給互動層（`server/`）在投影空間裡呈現。

目前開發重點集中在 M1（攝影、人體與服裝特徵）及 M2（角色生成穩定度、品質與成本）。

## ✨ 核心功能

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
| **跨角色物種一致性** | **未解決（核心問題）** | 已改為條件化於策展參考圖集，但尚未經真人視覺驗收 |
| 個體特徵保真 | 部分 | 服裝顏色走 CV 量測；膚色髮色仍被量化成 6–8 個桶 |
| 物種漂移量測 | 可用 | `style_probe.py` 已把 `fingerprint_spread` 接上真實輸出，數字需累積批量才有意義 |
| 正式對外展示 | **不可用** | 必須先解決物種一致性並通過真人視覺驗收 |

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
| 角色風格架構 | 後端 generation registry；目前註冊 LEGO 與 Pixar |
| 群體互動 | 互動層（`server/`）以 ws 傳遞角色狀態，Boids 控制投影角色移動 |

## 使用介面

- 手機控制器只提供 `full_character` 完整角色生成；已退役模式仍可在生成歷史辨識。
- 相機需要 HTTPS；權限被拒或生成失敗一律降級回捏臉，不會擋人進場。
- 生成期間顯示階段式進度。百分比代表流程里程碑，不是模型內部的精確剩餘時間。
- 主辦端控制台的「生成歷史」可檢視每次生圖、模型、耗時、token 與費用。

本機頁面（見本文最上方的整合現況）：

- 大螢幕：<http://localhost:3000/screen/>
- 手機控制：<http://localhost:3000/controller/>
- 主辦端控制台：<http://localhost:3000/host/>
- 生成服務健康檢查：<http://127.0.0.1:5055/health>

## 生成模式

### 唯一路線：`full_character`

- AI 一次產生完整角色（頭、髮、臉、身體、腿、鞋），輸出即最終畫面。
- 送三張圖給模型：訪客照片（WHO）、CV 特寫拼版（WHO 細節）、程式繪製的姿勢參考（幾何）。
- 結果經 `avatar_quality.py` 檢查透明背景、構圖、碎裂、左右腿與鞋；失敗回傳明確原因。
- 以 2D sprite 進入 Boids 投影牆。

**生成風格**：目前安裝兩種風格，參與者在拍照頁自行選擇（選單由 `/api/styles`
餵資料，沒選就用 `CHARACTER_STYLE` 的活動預設）：

| `style_id` | 顯示名 | 參考圖集 |
|---|---|---|
| `lego` | 樂高 | `2026q3_owner_curated` |
| `pixar` | 皮克斯 | `2026q3_pixar_figma` |

**風格參考圖**：除了上述三張，模型還會收到一張由該風格的參考圖集拼成的風格參考表
（`STYLE_REFERENCE_MODE=sheet`）。設為 `off` 可退回三張圖的送法做對照實驗。

> [!WARNING]
> 參考圖集**綁在風格上**（`style_registry.GenerationStyle.reference_set`），
> 不是綁在環境變數上。`STYLE_REFERENCE_SET` 現在是**全域覆寫**，設了它會把
> 所有風格壓到同一組圖 —— 而風格 sheet 在 prompt 裡被宣告為工藝的最高權威，
> 這種錯誤配對**不會失敗**，只會讓 prompt 與自己的參考圖互相矛盾，由模型自行
> 選一邊。`/health` 的 `degraded` 會列出被覆寫的風格。平常請留空。

> [!IMPORTANT]
> **參考圖集自 2026-08-25 起隨 repo 一起發布**（先前因授權判定不進版控）。
> 依據與殘留風險記在 `docs/style_reference/2026q3_owner_curated/PROVENANCE.md`；
> 那組圖是 Elser AI 生成的 Output，本專案以學術、非商業用途納入版控，
> **不是可自由再利用的素材**——要在本專案以外使用請自行確認授權。
>
> 圖集若缺席（自行刪除、或 `STYLE_REFERENCE_MODE=off`），程式**不會報錯**，
> 而是退回「不送參考圖」的生成方式 —— 畫風一致性會明顯變差，但看起來像是模型
> 變爛，不像是缺檔。兩個徵兆：啟動時的
> `[garment_gen] style reference set '<id>': not found, sending without it`，
> 以及生成服務 `/health` 的 `degraded` 會列出 `style_reference（…）`。
>
> 要換自己的圖集：在 `docs/style_reference/<你的 set_id>/` 放入 `full_body_*.png`
> （或 `.webp`），照 `PROVENANCE.md` 的格式逐檔記錄來源與授權，再把
> `backend/garment_gen.py` 底部該風格的 `register_style(...)` 的 `reference_set`
> 指向它（**不要**改用 `STYLE_REFERENCE_SET`，那是全域覆寫，見上方警告）。
> 放進去前可用
> `python scripts/check_reference_set.py docs/style_reference/<set_id>` 檢查。
>
> 要新增一種風格：在 `garment_gen.py` 加一份 prompt 模板、negative、
> `_ROLE_STYLE_*` 文字與姿勢參考，然後 `register_style()`。四樣東西必須成套 ——
> `backend/tests/test_style_registry.py` 有測試擋住任兩個風格共用其中任何一項。

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

### 2. 人工審查

> [!NOTE]
> **目前沒有填寫介面。** 審查表單原本在 2D 備援版的 `frontend/dev.html`，
> 該版本已於 2026-09-10 移除；同時移除的還有多人匿名盲評模組
> （`blind_review.py`）—— 該條研究流程已確定不再使用。
> `generation_history.py` 的 `save_review` 與 `generation_reviews` 資料表仍在，
> 是生成歷史查詢的一部分，但沒有頁面能寫入評分。

資料層支援的欄位：

- `pass / fail / pending`
- 肢體完整度 1–5
- 服裝相似度 1–5
- 臉／髮型相似度 1–5
- 整體效果 1–5
- 自由文字備註

人工審查是跨模式比較的 ground truth。規則 validator 擅長判斷結構是否完整，但無法可靠判斷角色是否像本人、衣服版型是否正確或精修是否真的變好。

### 人工備註的用途

分數適合統計，備註則保存分數表達不了的具體現象，例如：

- 鞋子看起來像手，或手腳形狀混淆。
- 外套版型錯誤，但衣服顏色正確。
- 臉部完整，卻不像本人。
- 底圖較自然，精修後反而改壞髮型。
- 構圖完整，但 LEGO 風格不一致。

備註目前不會直接送入模型，也不會自動修改 prompt。它是後續分析與決策證據，避免因單一案例就反覆改動生成流程。

## 生成歷史、成本與隱私

開發資料存放於 gitignored 的 `backend/logs/`：

```text
backend/logs/
├── generation_history.sqlite3  # run、attempt、review、token、cost
├── generated/                  # 每次 AI attempt 的生成 PNG
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

- 每次生成會保存一份去 EXIF、縮至 640px 的輸入照片縮圖（`DEV_HISTORY_SAVE_INPUTS=0` 可關閉），供生成歷史頁對照輸入／輸出、檢查還原性。
- 不保存原始照片的 base64 全解析度檔、landmarks、顏色或人物屬性。
- 可保存 AI 生成的角色 PNG，供開發比較。
- `backend/logs/`（含輸入縮圖、生成結果與資料庫）不會提交至 Git。

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
| 生成服務 | Python、Flask（`backend/service.py`） | session 隔離、生成流程、驗證、歷史 API |
| 生成層 | OpenRouter、OpenAI-compatible SDK | 完整角色一次生成 |
| 資料層 | SQLite、Rotating JSONL | 開發歷史、token／cost、人工審查、匿名 metrics 與事件 log |
| 互動層 | Node.js、ws（`server/`） | α 仲裁共治、任務、配對、問答、計分、社交圖譜 |
| 前端 | JavaScript、Three.js、Canvas2D（`public/`） | 手機控制器、大螢幕投影、主辦端控制台 |

生成服務只綁 `127.0.0.1:5055`。CV preview、VLM 與正式 image generation 使用不同 executor，避免即時預覽佇列阻塞正式生成。

## 目錄結構

```text
PersonaFlow/
├── backend/
│   ├── service.py              # 角色資產生成 HTTP 服務（只綁 127.0.0.1:5055）
│   ├── slicer.py               # 生成圖正規化 + 切成 head/torso/legs 三張貼圖
│   ├── validate_cuts.py        # 切片比例穩定度驗證工具
│   ├── config.py               # 集中式環境設定（型別轉換與驗證）
│   ├── cv_module.py            # 人體、服裝色彩、輪廓與局部區域
│   ├── face_module.py          # 本機臉部特徵
│   ├── vlm_module.py           # 可選 Gemini 語意分析
│   ├── avatar_pipeline.py      # generate_avatar 的純資料處理（影像解碼、色表、特徵合併）
│   ├── garment_gen.py          # 完整角色生圖流程與 prompt 模板
│   ├── style_base.py           # 從參考圖量出的風格標準（數值化）
│   ├── style_fingerprint.py    # 風格指紋與跨角色漂移量測
│   ├── style_normalizer.py     # 方向性明暗量測與正規化
│   ├── style_probe.py          # 把指紋接到實際生成圖上的漂移量測
│   ├── reference_bleed.py      # 參考圖滲漏偵測
│   ├── identity_fidelity.py    # 個體特徵保真度量測
│   ├── avatar_quality.py       # 本機生成圖 validator
│   ├── capture_quality.py      # 拍攝站位與穩定度規則
│   ├── detail_quality.py       # 最終畫面細節指標
│   ├── generation_history.py   # SQLite run／attempt／人工審查
│   ├── height_profiles.py      # short／medium／tall profiles
│   ├── metrics_logger.py       # 隱私保護 JSONL 指標
│   ├── event_logger.py         # 結構化事件 log 落地（JSON lines）
│   ├── analyze_log.py          # 效能指標分析（延遲／失敗率）
│   ├── report_html.py          # HTML 效能報告產生器
│   ├── style_registry.py       # 後端生成風格 registry
│   ├── photo_composer.py       # 大合照合成（排版、QR、中文字型後備鏈）
│   ├── circuit_breaker.py      # 外部 API 熔斷器與退避重試
│   └── tests/                  # pytest：CV、生成、validator、history、registry
├── server/                     # 互動層（Node.js）：仲裁、任務、配對、問答、計分
├── shared/                     # 前後端共用：protocol.js、avatars.js（含 CV_CUTS）、scene.js
├── public/                     # 前端：controller／screen／host，assets/gen 為貼圖落地處
├── test/                       # Node 單元測試（node --test）
├── scripts/
│   ├── e2e.mjs                 # 端對端測試（會自行啟動伺服器）
│   ├── bots.mjs                # 壓測用虛擬參與者
│   ├── make-cert.sh            # 現場用 TLS 憑證產生
│   └── ...                     # 參考圖集與髮色取樣的離線檢查工具
├── docs/
│   ├── INTERFACES.md           # 事件與 payload 介面規格
│   ├── STYLE_BASE.md           # 基底風格標準（量測方法與數值）
│   ├── STYLE_PROBE_FOLLOWUPS.md# 已知但刻意延後的量測與管線細節
│   ├── TECHNICAL_ARCHITECTURE.md
│   ├── PRD.md                  # 產品需求與驗收定義
│   ├── TechStack.md            # 技術選型
│   ├── README-PersonaFlow2.md  # 互動層說明
│   ├── TECH-PersonaFlow2.md    # 互動層技術說明
│   ├── m3/                     # M3 交接文件與效能報告
│   ├── notes/                  # 各主題的踩坑筆記（由 CLAUDE.md 拆出）
│   └── style_reference/        # 風格參考圖集（含圖檔，見 PROVENANCE.md）
├── .github/workflows/ci.yml    # CI：npm test＋端對端＋後端 pytest
├── package.json                # 整合版 Node 相依與指令
├── start.sh                    # 一鍵啟動（生成服務 :5055 ＋ 互動層 :3000）
├── CLAUDE.md                   # 精簡索引：架構、快速啟動、規範，其餘導向 docs/notes/
├── .env.example
├── requirements.txt
└── requirements-dev.txt
```

## 快速啟動

以下指令皆從專案根目錄執行。

### 1. 安裝依賴與環境設定

```powershell
npm install
pip install -r requirements.txt
Copy-Item .env.example .env
```

在 `.env` 填入 API key 與模型設定。**不要提交 `.env`。**

放在 `backend/.env` 的設定同樣有效：`load_dotenv()` 會以 `backend/` 為起點
往上尋找，因此兩處都會被載入。兩處都有時，先載入的根目錄版本優先。

### 2. 一鍵啟動

```bash
bash start.sh                 # 生成服務 :5055 + 互動層 :3000
```

啟動後終端會印出區網 IP 與主辦端通行密鑰，現場手機／平板可直接用該 IP 連入。

### 3. 只啟動其中一邊

```bash
bash start.sh --vision        # 僅生成服務 :5055
bash start.sh --node          # 僅互動伺服器 :3000
```

> **現場要用手機相機必須有 HTTPS。** `start.sh` 偵測到 `certs/` 會自動走 HTTPS；
> 憑證由 `bash scripts/make-cert.sh` 產生。沒有憑證仍可完整展演，只是掃描進場
> 會退回捏臉。

要停止服務，回到各自終端機按 `Ctrl+C`。完整的啟動、開啟與依 PID 關閉方式請參考 [docs/notes/LOCAL-PREVIEW.md](./docs/notes/LOCAL-PREVIEW.md)。

---

## 環境變數

| 變數 | 預設／範例 | 用途 |
|---|---|---|
| `OPENAI_API_KEY` | `sk-or-v1-...` | OpenRouter／OpenAI-compatible 金鑰 |
| `OPENAI_BASE_URL` | OpenRouter 自動判定 | 可選 API base URL |
| `FULL_CHARACTER_MODEL` | `google/gemini-3-pro-image-preview` | 完整角色生成模型 |
| `GENERATION_MODE` | `full_character` | 後端預設模式；目前唯一支援值 |
| `GENERATION_MAX_RETRIES` | `0` | 自動付費重試次數，開發預設關閉 |
| `STYLE_REFERENCE_SET` | 空 | **全域覆寫**參考圖集；留空才會各風格用自己的那組 |
| `FULL_MODE_VLM_ENABLED` | `0` | 是否額外呼叫服裝／臉部 VLM（模型已看過原始照片，預設關閉）。開啟後每位參與者消耗 2 次 Gemini 請求，免費方案每模型每天上限 20 次 |
| `GEMINI_API_KEY` | 空 | 可選語意分析 |
| `VLM_MODEL` | `gemini-3.6-flash` | 服裝／臉部語意辨識模型；Google 讓舊 id 退役時要改這裡 |
| `CHARACTER_STYLE` | `lego` | 活動層級預設風格（`lego`／`pixar`）；參與者可在拍照頁改選 |
| `HEIGHT_SHORT_MAX_RATIO` | `0.72` | short／medium 分界 |
| `HEIGHT_TALL_MIN_RATIO` | `0.84` | medium／tall 分界 |
| `DEV_HISTORY_ENABLED` | `1` | 啟用 SQLite 生成歷史 |
| `DEV_HISTORY_SAVE_OUTPUTS` | `1` | 保存每次 AI attempt 的生成 PNG |
| `METRICS_ENABLED` | `1` | 啟用匿名 JSONL metrics |

只有支援 OpenAI-compatible chat completions 且能輸出 image modality 的模型可直接使用目前的 `garment_gen.py` 流程。需要 `/images/generations` 等不同 endpoint 的模型必須另做 provider adapter。

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

- Socket handler 契約：角色與連線脫鉤、重連認領同一角色、身高量測閘門。
- 事件 log 落地、併發寫入與隱私遮除。
- Boids 分房隔離、swarm 快照還原與大合照合成。

目前共有 299 項後端測試與 4 項前端測試。這些測試涵蓋程式契約、資料介面與錯誤阻擋；**不代表角色外觀已通過人工視覺驗收。**

## 已知限制與下一步

- **物種一致性未解決（核心問題）**：生成已條件化於策展參考圖集，但成效尚未經真人視覺驗收。參考圖集本身另有兩項已記錄的缺陷（4/5 張雙腿併攏、髮色集中於單一色帶），見該目錄的 `PROVENANCE.md`。
- **畫風已定案為光澤 3D 渲染感**（2026-08）：`garment_gen.py` 的 ART STYLE GUIDELINES 原本要求「扁平向量、無漸層、無陰影」，與 `style_base.py` 量到的 0.21–0.24 立體明暗互相矛盾；現已改寫成材質光澤排序、正面柔光與「印刷不帶光向」三條規則，並由 `test_prompt_style_agreement.py` 鎖住。**效果仍待真人生成驗證。**
- **幾何一致性失去免費保證**：移除固定 3D 網格後，「兩隻手、兩條腿、比例一致」要靠 prompt 與 `avatar_quality.py` 的結構檢查去爭取；多肢問題會回來。
- **個體特徵部分流失**：服裝顏色走 CV 量測，但膚色髮色仍被 VLM 量化成 6–8 個桶，抹平個體差異。
- **漂移數字尚未累積**：`style_probe.py` 已把 `fingerprint_spread` 接上真實輸出，但要有足夠批量的生成結果才能回答「這批角色有多不一致」。
- **效能瓶頸**：50／100人 FPS 尚未完成正式量測。
- 拍攝品質閘門與身高門檻仍需固定攝影站實測校正。
- 本機 validator 能判斷格式與部分結構，不能可靠判斷是否像本人或是否達到目標參考圖。

### 已完成（2026-08 轉向）

1. **刪除固定 3D 幾何路線**，`full_character` 成為唯一模式，以 2D sprite 進投影牆。
2. **定案畫風為光澤 3D 渲染感**，並把 prompt 與 `style_base.py` 對齊（`test_prompt_style_agreement.py` 鎖住）。
3. **物種漂移可量測**：`style_probe.py` 把 `fingerprint_spread` 接上真實輸出，已接進 SQLite 與生成服務 API。
4. **膚色髮色改用 CV 量測值**，VLM 六色表降為 fallback。

### 下一階段順序

1. **驗證參考圖條件化的成效**：參考圖與滲漏偵測（`reference_bleed.py`）都已實作，缺的是一批真人生成結果與視覺驗收。
2. **幾何防護**：補上肢體數量與比例一致性檢查，接進既有的修正重試迴圈。
3. **個體忠實度指標**：與物種漂移成對量測，避免一致性把個體差異吃掉。
4. 到需要真人生成時停止於 `USER_MANUAL_GENERATION_REQUIRED`，由專案負責人手動生成並提供結果；系統不得自行假設成功。
5. 由專案負責人直接檢視結果，比較物種一致性、個體可分辨度、成本與延遲。

完整的產品規格與欄位定義請參考 [docs/PRD.md](./docs/PRD.md)（**注意**：其驗收條件仍寫在已退役的 `brick_ai_texture` 與 `body_sprite` 上，尚未依現行架構重寫），風格標準請參考 [docs/STYLE_BASE.md](./docs/STYLE_BASE.md)，Socket 介面請參考 [docs/INTERFACES.md](./docs/INTERFACES.md)，已知但刻意延後的細節請參考 [docs/STYLE_PROBE_FOLLOWUPS.md](./docs/STYLE_PROBE_FOLLOWUPS.md)，開發操作請參考 [CLAUDE.md](./CLAUDE.md)。

### 已預留但尚未實作

- 角色骨架／IK 繫結（`Character.skeleton` 已預留欄位）
- 動畫狀態機（`Character.animState` 已預留欄位）
- 從生成圖反推 landmark 以套用骨架動畫
