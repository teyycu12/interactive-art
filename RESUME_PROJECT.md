# PersonaFlow
## 即時外觀感知 × 風格角色合成系統
### Real-Time Appearance-to-Character Synthesis Pipeline

---

## 一句話定位

> 透過鏡頭擷取使用者的外觀資訊，以電腦視覺提取服裝色彩、以多模態 AI 識別穿著風格與臉部特徵，最終自動合成一個忠實還原當下穿著的 LEGO 風格數位角色。

---

## 專案背景

公共空間互動裝置專題。使用者站在鏡頭前，系統在不需要任何手動輸入的情況下，自動識別其服裝款式、顏色、臉部特徵，生成一個外觀與本人對應的數位分身角色。整套流程從拍照到角色呈現約 5–15 秒。

---

## 系統架構總覽

```
┌─────────────────────────────────────────────────────────────┐
│                     使用者端（瀏覽器）                         │
│                                                             │
│  Webcam → 影格壓縮 → Socket.io → [後端] → Socket.io → p5.js │
│                                               ↓             │
│                                    LEGO 角色即時渲染          │
└─────────────────────────────────────────────────────────────┘
        ↑ WebSocket (即時 100ms 骨架偵測 / 單次生成觸發)

┌─────────────────────────────────────────────────────────────┐
│                     後端（Python / Flask）                    │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │  cv_module   │   │  vlm_module  │   │  garment_gen   │  │
│  │ MediaPipe    │   │ Gemini 1.5   │   │ Gemini 2.5     │  │
│  │ 骨架偵測      │   │ Flash        │   │ Flash Image    │  │
│  │ K-Means 格柵 │   │ 服裝 + 臉部   │   │ 角色圖像生成    │  │
│  └──────────────┘   └──────────────┘   └────────────────┘  │
│  ┌──────────────┐                                           │
│  │  face_module │                                           │
│  │ MediaPipe    │                                           │
│  │ Face Mesh    │                                           │
│  │ 幾何特徵      │                                           │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心技術管線

整套系統分為四個階段，每個階段各自解決一個辨識問題：

---

### 階段一｜骨架感知與服裝色彩格柵

**問題**：如何在不裁切人體的情況下，精準擷取上衣與褲子各自的顏色？

使用 **MediaPipe PoseLandmarker** 偵測 33 個骨架關節點（肩膀、骨盆、膝蓋、踝關節），以關節座標計算上衣多邊形與下半身多邊形，在輪廓遮罩內執行顏色分析：

1. **輪廓遮罩建立**
   從肩 → 髖 → 膝關節座標計算 5 頂點（上衣）與 4 頂點（下半身）的凸多邊形，使用 `cv2.fillPoly` 生成 pixel-level 遮罩，邊緣各留 1–1.5% 內縮量避免背景污染

2. **K-Means 調色盤建立**
   對遮罩內所有像素執行 K-Means（k=5），建立服裝專屬調色盤；同步對調色盤進行飽和度強化（×1.35）消除打光色差，確保同色系衣物被合併至同一色票

3. **格柵中位數映射**
   將輪廓框格分割成 32×40（上衣）與 24×30（下半身）的格柵，每格以像素中位數映射至最近調色盤顏色（比均值更抗條紋邊緣雜訊）

4. **BFS 邊緣延伸**
   輪廓邊緣格因覆蓋率不足而標記為 inactive，以 BFS 4-way 擴散讓最近的 active 格傳播色彩，填補成完整矩形格柵

5. **服裝款式判斷**
   比較前臂像素色 vs. 上衣主色的 RGB 距離（< 50 → 長袖）、小腿像素色 vs. 下半身主色（< 50 → 長褲）

**輸出**：`cloth_grid`（32×40 色彩格柵）、`lower_grid`（24×30）、`upper_type`、`lower_type`、全身輪廓 `body_poly`

---

### 階段二｜多模態 AI 並行分析

**問題**：如何辨識服裝款式（T-shirt vs. 西裝外套）與臉部外觀（髮型、膚色）？純 CV 方法難以做到語意識別，因此引入兩支 VLM 呼叫。

兩支呼叫透過 `eventlet.spawn` **完全並行執行**，不互相阻塞：

#### 服裝語意分析（Gemini 1.5 Flash）
- 輸入：原始影格的 base64 JPEG
- 輸出：`{ inner, outer, lower, inner_color, outer_color, lower_color, has_pattern }`
- 款式標籤：`blazer / denim_jacket / cardigan / none`（外層）、`tshirt / vneck / button_up`（內搭）、`jeans / pleated_skirt / suit_pants / shorts`（下半身）
- VLM 判斷的長袖依據（外套類型）優先度高於 CV 像素距離啟發式演算法

#### 臉部外觀分析（Gemini 1.5 Flash）
- 輸入：原始影格的 base64 JPEG
- 輸出：髮型（8 種）、髮色（8 種）、膚色（6 階）、眼色（6 種）、鬍鬚有無與樣式
- 顏色輸出透過固定 hex 映射表轉換（而非直接信任 AI 的 hex 值），確保角色渲染一致性
- 提示詞工程：針對直髮 vs. 波浪、短髮 vs. 長髮設計詳細判斷準則，防止模型對東亞臉孔過度回傳 `short_straight`

#### 臉部幾何分析（MediaPipe FaceLandmarker）
- 使用 468 個臉部關鍵點計算臉型（寬高比 → oval / round / square）、眼型（開眼度 → almond / round / narrow）
- 眉毛距眼皮距離判斷眉型（thick / normal）
- Face Blendshapes 的 `mouthSmileLeft / Right` 分數驅動嘴型弧度

---

### 階段三｜AI 角色圖像生成

**問題**：如何生成一個外觀忠實對應使用者穿著的卡通角色圖像？

使用 **Gemini 2.5 Flash Image Preview**（經 OpenRouter 路由）進行 image-to-image 生成，支援三種模式：

#### `body_sprite` 模式
- 輸入：從 `body_poly` 裁切的 1024px 方形、加水平 30% padding 確保手臂不被截切
- 提示詞強制產出：頸部以下的 LEGO 人偶（無頭、無手掌、無腳），頭部由程式繪製後合成
- 適合需要程式控制臉部表情的場景

#### `full_character` 模式
- 單次呼叫生成完整 LEGO 人偶（頭→腳）
- 提示詞注入偵測到的外觀屬性（膚色、髮型、服裝顏色與款式），要求嚴格正面 T-pose
- 提示詞包含 300+ 字的負向描述，明確排除：多餘肢體、重複角色、文字浮水印、背景場景

#### `full_character_refined` 兩段式精修
- **第一段**：以 `full_character` 模式生成草稿（保留白底，白底作為第二段的佈局信號）
- **第二段**：以「原始照片 + 草稿」作為雙輸入，要求模型在保留草稿構圖的前提下精修細節（眼睛、眉毛、嘴型、輪廓線條）
- 若精修失敗，自動降級並對草稿執行背景移除後回傳

#### 背景移除（自行實作 BFS Flood-Fill）
非使用第三方去背函式庫，而是自行實作：
1. 從影像四角出發，BFS 4-way 擴散刪除「接觸邊緣的近白色像素」（容差 per-channel ±18）
2. 保留角色內部的白色細節（例如衣服上的 logo 或白色布料）
3. 在邊界環繞 2px 做 alpha 漸淡，消除程式繪製手臂與 AI sprite 交接處的硬邊
4. Tight-crop 剪除透明邊框，回傳最小外接框

---

### 階段四｜LEGO 角色即時渲染管線

**問題**：如何在沒有 AI 生成圖的情況下（或 AI 圖與程式繪製部位合成時）保持視覺品質？

所有渲染以 **p5.js + Canvas 2D API** 完成，支援三種渲染路徑：

#### 渲染路徑 A：純 AI Sprite（full_character 模式）
- 直接將 AI 生成的 PNG 填入角色高度（headTop → footBottom），保持原始長寬比
- 無需任何程式繪製

#### 渲染路徑 B：AI Sprite + 程式繪製部位（body_sprite 模式）
- AI sprite 僅覆蓋軀幹到腿部
- 頭部（含頸部、髮型）、手臂、手掌、腳掌由程式繪製
- 手臂顏色依偵測結果：`short_sleeve` → 膚色裸臂，`long_sleeve` → 上衣顏色
- 嘴型依微笑分數分三級（< 0.25 微笑、0.25–0.6 中笑、≥ 0.6 大笑）

#### 渲染路徑 C：純程式繪製 + 色彩格柵覆蓋（無 AI 圖 fallback）
色彩格柵渲染的五階段管線：
1. **髮色過濾** `_filterHairCells`：移除格柵中與髮色 RGB 距離 < 40 的格子，防止深色頭髮污染深色上衣（若上衣本身近似髮色則跳過此步驟）
2. **BFS 區域分群** `_clusterGrid`：以 RGB 距離閾值 22 的 BFS 區域生長合併相近色格，消除打光造成的漸層雜訊
3. **對比拉伸 + 飽和度提升** `_enhanceGrid`：luma 值拉伸至 0.32–0.82 範圍，HSL 飽和度 ×2.2，加入 ×1.18 攝影機欠曝補償係數
4. **雙軸對稱** `_makeSymmetric`：左右半格柵均值鏡像，讓條紋、格紋圖案在角色軀幹呈現乾淨的雙軸對稱
5. **Canvas clip-path 渲染**：以角色多邊形為 clip region，對格柵逐格 `fillRect`（+0.5px overlap 防止 hairline gap）

---

## 使用技術

| 層級 | 技術 |
|------|------|
| 後端框架 | Python · Flask · Flask-SocketIO · Eventlet（非同步 IO） |
| 電腦視覺 | OpenCV · MediaPipe PoseLandmarker · MediaPipe FaceLandmarker |
| 視覺語言模型 | Google Gemini 1.5 Flash（服裝 + 臉部語意分析） |
| 圖像生成 AI | Gemini 2.5 Flash Image Preview via OpenRouter |
| 前端 | p5.js · Canvas 2D API · Socket.io Client |
| 演算法 | K-Means 分群 · BFS 洪水填充 · 對比拉伸（luma） · HSL 飽和度 |
| 通訊 | WebSocket（Socket.io，強制非 polling 模式） |

---

## 可展示的圖（建議截圖清單）

以下圖片可用於 Portfolio、簡報或履歷附件，每張說明該展示什麼技術亮點：

---

### 圖 1｜即時骨架偵測畫面
**畫面內容**：鏡頭畫面 + 綠色骨架疊加（肩、肘、髖、膝、踝關節點連線）
**技術亮點**：MediaPipe PoseLandmarker 即時推論、關節點可視化
**拍攝方式**：使用者站在鏡頭前，按下「▶ START」後截圖，確保骨架線清晰可見

---

### 圖 2｜服裝色彩格柵預覽
**畫面內容**：鏡頭畫面右側的「即時色調」面板，顯示上半身 / 下半身兩個色塊與 HEX 值
**技術亮點**：K-Means 格柵取樣、輪廓遮罩過濾的即時輸出
**拍攝方式**：穿著有明顯色彩對比的上下衣（例如紅色上衣 + 藍色牛仔褲）截圖

---

### 圖 3｜AI 生成 LEGO 角色（body_sprite 模式）
**畫面內容**：CUSTOMIZE 頁面中的完整角色，AI 生成的軀幹 sprite 與程式繪製的頭部合成
**技術亮點**：AI sprite 與程式角色的無縫合成、BFS 背景移除效果
**拍攝方式**：生成後截取 CUSTOMIZE 頁面，包含角色與右側按鈕面板
**加分**：穿著有明顯紋路的衣服（格紋、條紋），展示布料細節被保留

---

### 圖 4｜AI 生成 LEGO 角色（full_character_refined 模式）
**畫面內容**：完整的 AI 生成 LEGO 人偶，頭到腳一體成型
**技術亮點**：兩段式精修管線、提示詞工程（髮型、膚色、服裝精確還原）
**拍攝方式**：同上，切換為 refined 模式後生成
**加分**：與原始照片並排對比，展示服裝顏色與髮型的還原度

---

### 圖 5｜原始照片 → LEGO 角色 對比圖
**畫面內容**：左：拍攝時的截圖，右：生成的 LEGO 角色
**技術亮點**：整條管線的最終成果，展示感知→轉譯的完整效果
**製作方式**：截取原始照片 + 截取最終角色，用任意圖片編輯工具拼排

---

### 圖 6｜色彩格柵渲染 Fallback 效果
**畫面內容**：無 AI 生成圖時，LEGO 角色身上覆蓋著細緻的色彩格柵（條紋 / 格紋清晰可見）
**技術亮點**：K-Means + BFS 分群 + 對比拉伸 + 雙軸對稱渲染管線
**拍攝方式**：穿著格紋或橫條紋上衣，在格柵渲染模式下截圖

---

### 圖 7｜系統流程圖（可手繪或用工具製作）
**建議內容**：
```
[鏡頭影格] → [MediaPipe 骨架] → [K-Means 格柵]
                                        ↓
                              [Gemini VLM 服裝分析]  ←→  [Gemini VLM 臉部分析]
                                        ↓
                              [Gemini 圖像生成]
                                        ↓
                              [BFS 背景移除]
                                        ↓
                              [p5.js LEGO 渲染]
```
**工具建議**：Figma、draw.io、或直接截取這份文件的架構圖區塊

---

## 推薦小標題（依使用情境）

| 情境 | 建議標題 |
|------|---------|
| 履歷條目 | PersonaFlow — 即時外觀感知角色合成系統 |
| Portfolio 標題 | Real-Time Appearance-to-Character Synthesis |
| 作品集副標 | 電腦視覺 × 生成式 AI × 即時渲染 |
| 簡報首頁 | 你的穿著，即是你的角色 |
| 英文 tagline | *"From what you wear to who you are — in real time."* |

---

## 履歷條目範本（中文版）

```
PersonaFlow — 即時外觀感知角色合成系統          2025
互動裝置專題 · 個人開發

• 使用 MediaPipe PoseLandmarker 從骨架關節點建立服裝輪廓多邊形，執行
  K-Means 分群與 BFS 邊緣延伸，輸出 32×40 高精度布料色彩格柵

• 以 eventlet.spawn 並行呼叫兩支 Gemini 1.5 Flash VLM，同步完成服裝
  語意識別（款式 + 顏色）與臉部外觀辨識（髮型 / 膚色 / 鬍鬚），
  結合 MediaPipe Face Mesh 關鍵點取得幾何特徵（臉型 / 眼型 / 微笑分數）

• 設計三段式 AI 圖像生成管線（草稿 → 精修 → 降級回退），透過提示詞
  工程約束 Gemini 2.5 Flash Image 生成符合 LEGO 比例的數位角色

• 自行實作 BFS Flood-Fill 背景移除演算法（保留角色內部白色細節）與
  5 階段色彩管線（髮色過濾 → 分群 → 對比拉伸 → 飽和度強化 → 雙軸對稱）

技術：Python · Flask-SocketIO · OpenCV · MediaPipe · Gemini API · p5.js · Canvas 2D
```

---

## 履歷條目範本（英文版）

```
PersonaFlow — Real-Time Appearance-to-Character Synthesis      2025
Interactive Installation · Individual Project

• Built a clothing color grid pipeline using MediaPipe PoseLandmarker skeleton
  keypoints to derive garment polygons, followed by K-Means clustering (k=5)
  and BFS edge-fill to produce 32×40 cloth color grids with contour masking

• Parallelized two Gemini 1.5 Flash VLM calls via eventlet.spawn for concurrent
  outfit semantic recognition and facial feature classification (8 hair styles,
  6 skin tones); combined with MediaPipe Face Mesh for geometric features
  (face shape, eye shape, smile score via blendshapes)

• Engineered a three-pass AI image generation pipeline (draft → refine → fallback)
  using Gemini 2.5 Flash Image via OpenRouter with 300+ word negative prompts
  to constrain LEGO minifigure proportions and single-character output

• Implemented custom BFS flood-fill background removal (preserving interior
  white details) and a 5-stage color rendering pipeline (hair-cell filtering,
  BFS region clustering, contrast stretching, saturation boost, bilateral symmetry)

Stack: Python · Flask-SocketIO · OpenCV · MediaPipe · Gemini API · p5.js · Canvas 2D
```
