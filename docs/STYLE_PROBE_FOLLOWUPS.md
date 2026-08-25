# 待精修細節

背景：[`backend/style_probe.py`](../backend/style_probe.py) 把 [`backend/style_fingerprint.py`](../backend/style_fingerprint.py)
的 `fingerprint_spread` 接到實際生成的 `full_character` 角色圖上，用來量測一批角色之間的
畫風/物種漂移（commit `8391e79`）。這份文件從那裡的兩個量測細節問題開始，後來擴充成
`pivot-full-character` 主線上「已知、但刻意延後」的清單（第 1、2 點屬 style_probe，
第 3、4 點屬生成管線本身）。目前功能都可用，等主計畫執行完再回頭處理，不是現在的優先項。

---

## 1. 區域切割沒有處理「身型比例」差異

**現況**

`sprite_fingerprint()` 把一張角色圖切成 face / garment_torso / denim_leg / shoe 四塊，切法分兩種：

- **高矮（整體縮放）**：有正規化。先用 `_subject_mask` 量出這張圖裡角色**自己的**輪廓框，
  取得 `height = bottom - top`，切割線用 `style_base.landmarks_y` 的比例（例如
  `collar: 0.327`、`waist: 0.614`）去乘這個高度算出來。不管這個角色渲染出來多高，
  「領口」永遠落在自己輪廓的 32.7% 處。
- **胖瘦（寬度）**：有正規化。用 `_widest_dense_run` + `MIN_COLUMN_COVERAGE` 即時偵測輪廓
  在每個高度區間實際覆蓋的寬度，不是套固定比例，所以胖一點的角色量出來的區塊本來就會寬。

**核心問題**

縱向切割線的**比例數值本身**（領口在 32.7%、腰在 61.4%…）全部來自同一張參考圖
（`docs/style_reference/base_character.png`），對所有角色一視同仁地套用。等於假設每個生成
角色的軀幹／腿／頭**相對長度比例**都跟參考圖一樣，只有整體縮放和寬度不同——這是
`style_base.py` 文件註解裡明講的設計前提，不是遺漏。

風險是：如果某張生成圖結構有落差（例如腿被裁掉、身型比例明顯偏離參考圖），輪廓框會
跟著變形，切割線就會跟著位移，量到「看起來合理、但其實切到錯誤部位」的數字。目前唯一
的防線是靠 `avatar_quality.validate_avatar_png` 先擋掉結構不完整的圖，並沒有真的偵測
「這個角色的身型比例是否偏離參考圖」。

**可能方向（尚未評估優先序）**

- 讓 `validate_avatar_png` 順便回報量到的比例與參考值的偏差，超過門檻就標記 probe 結果
  不可信，而不是靜默接受。
- 或接受這是已知限制、寫進 `style_probe.py` 的 docstring 即可（目前 docstring 已經部分
  提到這個 failure mode，但沒有量化門檻）。

---

## 2. `directional_gradient` 分不清「打光陰影」跟「兩色服裝」

**現況**

`directional_gradient`（[`backend/style_normalizer.py:36-48`](../backend/style_normalizer.py#L36-L48)）
量的是「模糊後，畫面左右兩端／上下兩端的平均明度差多少」。這個量測方式只看明度變化的
形狀，不管造成變化的原因。

**核心問題**

打光造成的漸層跟「上半身白色、下半身黑色」這種兩色硬切服裝，在「平均明度從一端到
另一端有落差」這件事上長得幾乎一樣，導致 `garment_torso` / `denim_leg` / `shoe`
這幾個區域的 `directional_gradient` 數值，其實混雜了「打光陰影」跟「服裝配色」兩種
訊號，沒辦法單獨當成陰影一致性來解讀（`face` 區域因為皮膚只有一種材質，沒有這個問題）。

目前的處理方式是**明講不遮掩**：`cast_drift()` 會在回傳值附上
`directional_gradient_confound` 警告字串，`frontend/dev.html` 也會顯示，但沒有解決根本
的混淆。

**可能方向（尚未評估優先序，兩者可擇一或合併）**

- **比對色相/彩度是否同步跳動**：打光陰影只有明度（LAB 的 L 通道）平滑改變，同一塊布料
  的色相/彩度（a*、b* 通道）應該維持穩定；兩色拼接服裝則會在交界處讓 L、a*、b* 同時
  出現階梯狀跳動。可以在算 `directional_gradient` 時，同軸向多算一次 a*/b* 落差，
  兩者量級不一致就代表是服裝配色而非陰影，該筆數值應排除或另外標記。
- **復用舊的兩色偵測邏輯**：`241ea26`（拿掉固定幾何 3D 路徑）之前，`brick_v2_atlas` 會把
  兩色分明的色塊判定成服裝輪廓提示、跳過不量。可以只把「偵測兩色硬切」這部分邏輯抽出來
  用在 `style_probe` 的區域上，量測前先判斷是否為兩色分色，是的話跳過或標記
  `directional_gradient` 為不可信。

---

## 3. 身高只剩等比縮放，分部位縮放在 `full_character` 下已無法運作

**現況**

身高從量測到套用的完整路徑：

| 環節 | 事實 |
|---|---|
| [`backend/garment_gen.py:503`](../backend/garment_gen.py#L503) `_attr_lines()` | 只吐膚色／髮色／髮型／眼／鬍／表情／服裝，**沒有身高欄位** |
| `generate_full_character_png()` | 參數列**沒有 height** |
| [`backend/height_profiles.py:9`](../backend/height_profiles.py#L9) | 提供 `display_scale`／`torso_scale_y`／`leg_scale_y` 三個係數 |
| [`frontend/themes/lego.js:14-16`](../frontend/themes/lego.js#L14-L16) | 後兩者被 `renderMode === 'body_sprite'` 條件擋住 |
| commit `241ea26` | 該模式已退役，`full_character` 是唯一模式 |
| [`frontend/sketch.js:160`](../frontend/sketch.js#L160) | 實際只剩 `scale(scaleFactor * heightScale)` |

也就是說：圖生模型從來沒有被要求畫身高（這是對的，身高屬於管線事後套用的變數）；
但 `torso_scale_y`（0.96／1.00／1.02）與 `leg_scale_y`（0.90／1.00／1.12）在現行路徑裡
**恆等於 1，形同死碼**，只有 `display_scale`（0.90／1.00／1.10）以整隻等比縮放生效。

**核心問題**

分兩層，第二層才是真正卡住的地方。

其一，等比縮放是很粗糙的身高模型。真人的身高差主要落在腿長，等比放大會連頭圍和手一起
放大，高個子訪客拿到的是「放大版」而不是「長腿版」。`height_profiles.py` 當初把
`leg_scale_y` 的變化幅度（±10~12%）設得比 `torso_scale_y`（±2~4%）大得多，正是為了表達
這個不對稱，而現在這個設計意圖完全沒有出口。

其二，要在 `full_character` 下重新啟用分部位縮放，管線必須能在**生成出來的 sprite 上**
找到腿的起點（`style_base.landmarks_y.inseam` = 0.765）。但 Stage 4 參考圖組
`docs/style_reference/2026q3_owner_curated/` 量出來的橫斷面 run 數剖面顯示，五張裡有四張
的雙腿**是併攏的實心柱**，只在鞋子附近（約 96%）才分開：

```
01 ...1111111111111111111 211      02 ...1111111111111111 221
04 ...111111111111111 211          05 ...11111111111111111111 1
```

對照 `style_base` 記錄的 `leg_split_visible` = 0.770、`leg_gap` = 0.020（佔身寬 2%），
標準是下半身有約 23% 高度的**真實背景間隙**。差別是關鍵性的：**印刷接縫線 ≠ 背景間隙**，
後者用跟人物遮罩同一套方法就找得到，前者要另外做線偵測。腿併攏的 sprite，inseam 在
幾何上並不存在。

附帶一提，這也同時牴觸了 prompt 自己的 `MANDATORY LEGO DESIGN RULES #1`
（`a clear vertical gap between them`）與 `_canonical_lego_pose()` 畫的 24px 間隙——
等於 Image 3 與 Image 4 在這一點上互相矛盾。

這與本文件第 1 點是同一族的問題：第 1 點講的是「landmark 比例被假設對所有角色一致」，
這一點講的是「landmark 在 sprite 上根本量不到」。

**可能方向（尚未評估優先序）**

- **讓參考圖恢復腿間隙**（成本最低，今天就能做）：重生 `full_body_01/02/04/05`，在角色
  區塊加一句要求雙腿之間可見純白背景間隙直達鞋面。`full_body_03`（一體式洋裝）正當
  豁免——沒有腿部分割正是那一格存在的理由。今天不做任何事會壞掉，但這一步把未來的門留著。
- **在 sprite 上實際量 inseam 並回報**：用橫斷面 run 數（1→2 的轉折）偵測腿部分割位置，
  量到就回報其高度比例、量不到就標記「分部位縮放不可用」，而不是靜默套用錯誤的切割線。
  這可以跟第 1 點提的「`validate_avatar_png` 順便回報比例偏差」合併成同一件事做。
- **在生成前的姿勢參考圖（Image 3）上做身高比例，取代生成後偵測**：`_canonical_lego_pose()`
  （[`backend/garment_gen.py:151-169`](../backend/garment_gen.py#L151-L169)）現在是固定座標，
  不論訪客身高一律送同一張骨架圖當 Image 3。可以依這位訪客量到的 `height_class`，套用
  `height_profiles.py` 裡本來就存在、但在 `full_character` 下已死掉的 `torso_scale_y`／
  `leg_scale_y` 係數，畫出對應比例的骨架版本（例如 tall 版本腿部座標拉長 12%）再送進去。
  因為 prompt 明講「照抄 Image 3 的幾何」，比例差異會直接被模型學進輸出，不需要再對輸出
  sprite 做不可靠的事後偵測——等於把上面兩項要解決的問題，換到生成前就先解決掉，也讓
  `torso_scale_y`／`leg_scale_y` 這兩個現在的死碼重新有用途。
- **重新啟用分部位縮放**：拿掉 `lego.js` 的 `body_sprite` 閘門。但 `full_character` 交付的是
  一張平面 PNG 而非骨架，所以得先在量到的 inseam 位置把圖切兩段分別縮放，是實質改動，
  且完全依賴前一項的量測可靠度。若採用上一項「生成前就做比例」的方向，這一項多半就不需要了。
- **或者接受等比縮放是已知限制**：明確寫進 docstring，並把 `torso_scale_y`／`leg_scale_y`
  從 `height_profiles.py` 移除或標記為 deprecated。看起來還活著的死設定本身就是陷阱，
  比單純的限制更容易誤導後續開發。

---

## 4. 髮色不準：量測與渲染無法分辨是哪一層出錯

**現況**

`full_character` 模式下，髮色的完整路徑只有一條，沒有備援：

| 環節 | 事實 |
|---|---|
| [`backend/app.py:829-831`](../backend/app.py#L829-L831) | `FULL_MODE_VLM_ENABLED` 預設 `0`，`fut_face_vlm` 為 `None` |
| [`backend/app.py:894`](../backend/app.py#L894) | 因此 `vlm_face_result` 恆為 `{"ok": False, "error": "disabled_for_full_mode"}` |
| [`backend/app.py:939`](../backend/app.py#L939) | VLM 調色盤那段（`_HAIR_HEX` 八色）**從不執行** |
| [`backend/app.py:846`](../backend/app.py#L846) | 所以 `get_face_features(frame, max_width=480)` 是髮色的**唯一**來源 |
| [`backend/face_module.py:108-114`](../backend/face_module.py#L108-L114) | 進 MediaPipe 前先把畫面寬度壓到 480px |
| [`backend/face_module.py:188-193`](../backend/face_module.py#L188-L193) | 髮色取樣：額頭 landmark 往上 `face_h * 0.18`，radius 20 方框，**直接平均** |
| [`backend/app.py:950-962`](../backend/app.py#L950-L962) | 量到才寫入 `face_data` 並標記 `color_source = cv_measured` |
| [`backend/garment_gen.py:722`](../backend/garment_gen.py#L722)／[`745`](../backend/garment_gen.py#L745) | 有值印 `- Hair colour: #XXXXXX`；沒值整段消失，落到 `- (no extra attributes — infer from the photo)` |

`face_module` **不做頭髮分割**。它取一個固定偏移的方框然後平均，唯一的防呆是
「平均亮度 > 215 就改用 temple、radius 12 重取一次」。

**核心問題**

分三層，而從輸出圖**看不出來是哪一層壞掉**——這才是真正的問題，不是髮色本身。

- **(a) 偵測層**：全身照的臉在 480px 寬時可能只剩幾十像素，MediaPipe 直接回
  `no_face_detected`。此時髮色**從頭到尾沒有被量測過**，prompt 完全不提髮色，模型自由發揮。
  而且這個降級是**完全無聲的**：後端不警告、前端不顯示，看起來就只是「模型畫錯髮色」。
- **(b) 取樣層**：固定偏移的方框可能落在額頭、瀏海邊緣、背景或帽子上，平均出來的顏色
  **兩邊都不像**。亮度 > 215 的防線只擋得住「取到白背景」，擋不住「取到淺膚色額頭」或
  「取到深色背景」——後兩者算出來的 hex 看起來完全合理，卻是假的。
- **(c) 渲染層**：hex 正確，模型沒照做。只有排除 (a)(b) 之後，這一層才值得動。

[`scripts/check_hair_sampling.py`](../scripts/check_hair_sampling.py) 就是為了把這三層分開而寫的。
它包住 `face_module._sample_color` 去旁觀（不重算 landmark，所以不會跟正式程式碼分岔），
輸出 `spread`＝方框內每通道標準差：頭髮是單一材質，方框真的落在頭髮上就該均勻，
`spread` 高即代表這個平均值是混色、不是真實顏色。

**已知證據，以及它為什麼不足以下結論**

repo 裡唯一的照片是 `backend/logs/inputs/*.webp`，兩張都回 `no_face_detected`，
在原生尺寸與 `--max-width` 720/960/1280 下也一樣。**但不能據此推論正式路徑**：
[`backend/generation_history.py:269`](../backend/generation_history.py#L269) 存的是
`thumbnail((640, 640))` + WEBP quality 78 的縮圖，不是管線當下處理的 1024×1536／1488×2232 原幀。

這本身就是一個附帶發現：**log 沒有保留管線實際看到的東西**，導致事後無法重現任何
CV 層的問題。要定位 (a)/(b)/(c)，必須拿使用者上傳的**原始檔**重跑腳本。

**可能方向（尚未評估優先序）**

- **先分層定位**（前置，成本近乎零）：對原始上傳檔跑
  `python scripts/check_hair_sampling.py "原圖.jpg" --out hair_check/`，
  結果決定後面做哪一項。在這之前的任何修改都是猜的。
- **若是 (a)**：提高 `get_face_features` 的 `max_width`；或先用臉部偵測框裁切放大後再餵給
  landmarker（全身照臉小是結構性問題，單純提高全圖解析度既慢又不一定夠）。無論修不修，
  **偵測失敗都應該回報**——現在的靜默降級讓 (a) 偽裝成 (c)，是這一整條問題最貴的部分。
- **若是 (b)**：改用頭髮區域分割取代固定偏移；或成本更低的兩招——把 `_sample_color` 的
  平均改成**中位數**（對混入的額頭／背景像素遠比平均值穩健，改動極小），以及把腳本裡的
  `BLEND_SPREAD` 門檻搬進 `face_module`，`spread` 過高就視同量測失敗而非回傳一個假 hex。
- **若是 (c)**：才輪到 prompt 權重與參考圖。屆時可疑點是 Stage 4 參考圖組的髮色窄帶——
  `docs/style_reference/2026q3_owner_curated/` 五張的髮色全落在 hue 16°–32°、saturation ≥ 92，
  雖然 `_STYLE_SHEET_FIREWALL` 明文禁止髮色轉移，但單一色帶重複五次是否仍造成偏壓，
  需要用 A/B（送／不送 style sheet）實測，不能用推論的。
- **順帶修 log 的保真度**：`save_input_photo` 另存一份未縮圖的原始輸入（或至少提高上限），
  否則往後每一個 CV 層的問題都會遇到同樣的死路。

---

## 5. 臉部膚色與表情：量到的東西大半沒送進 prompt

**這一點與第 4 點同源**（都卡在 `get_face_features` 這個單點），但多了兩件第 4 點沒有的事：
一份量測證據，以及一個與髮色無關的獨立缺口。

### 5.1 量測證據

`backend/identity_fidelity.py`（commit `07fc6d3`）對歷史上 26 張成功輸出做了內容離散度量測，
以風格參考圖組導入時間（2026-08-22 17:08）切成前 12 / 後 14 兩組：

| 區域 | 特徵 | before | after | 方向 |
|---|---|---|---|---|
| garment_torso | 色相離散（環形） | 0.320 | 0.731 | ↑ 個體保留 |
| garment_torso | 彩度離散 | 0.702 | 1.015 | ↑ |
| denim_leg | 彩度離散 | 0.703 | 0.963 | ↑ |
| **face** | **彩度離散** | **0.686** | **0.146** | **↓ −79%** |
| face | 色相離散（環形） | 0.022 | 0.008 | ↓（本來就極小） |

服裝的個體差異全面上升——這是好結果。**只有臉部反向崩塌。**

色相離散本來就極小是正常的（人的膚色都落在同一個橘色系），**彩度崩塌才是訊號**。

**但這個數字有兩種解釋，數字本身分不出來**：

- (甲) 個體流失——膚色正在收斂到單一膚色。
- (乙) 風格收斂——舊的平塗 prompt 把皮膚畫得飽和度亂跳，新的光澤 prompt 畫得一致，
  這反而是 Stage 0 想要的效果。

能區分兩者的唯一判準是「輸出膚色有沒有跟著量到的訪客膚色走」。
`backend/reference_bleed.py` 的 `color_allegiance()` face 區判定正是為此而寫，
但**無法回溯執行**——訪客的 CV 量測色從未存進 `generation_history`。
要判定必須等新的 run 累積，或在量測落地時一併補存。

### 5.2 四個量到的臉部特徵從來沒進過 prompt

`face_module.get_face_features()` 回傳 8 個欄位，[`backend/app.py:951-961`](../backend/app.py#L951-L961)
把其中 5 個寫進 `face_data`。但 [`backend/garment_gen.py:714-745`](../backend/garment_gen.py#L714-L745)
的 `_attr_lines()` 只讀其中一部分：

| 欄位 | 有量測 | 寫進 face_data | **送進 prompt** |
|---|---|---|---|
| `skin_tone` | ✓ | ✓ | ✓ |
| `hair_color` | ✓ | ✓ | ✓ |
| `eye_color` | ✓ | ✓ | ✓ |
| `smile_score` | ✓ | ✓ | ✓（但被壓成二元，見 5.3） |
| `face_shape` | ✓ | ✓ | **✗** |
| `eye_shape` | ✓ | ✓ | **✗** |
| `eyebrow_style` | ✓ | ✓ | **✗** |
| `lip_color` | ✓ | ✓ | **✗** |

驗證方式：`grep -c` 這四個鍵在 `garment_gen.py` 中的出現次數皆為 **0**。

也就是說，MediaPipe 算出臉型（round／square／oval）、眼型（round／narrow／almond）、
眉型（thick／normal）與唇色之後，這些值被存進字典、隨 `face_data` 傳進
`generate_full_character_png()`，然後**在組 prompt 時被靜默丟棄**。
模型收到的臉部個體資訊只剩三個顏色加一個二元表情。

這是「看起來還活著的死路徑」，和第 3 點的 `torso_scale_y`／`leg_scale_y` 同一類陷阱：
從 `app.py` 讀起來像是有在用，要追到 `_attr_lines` 才會發現沒有。

### 5.3 表情被壓成兩個字

[`backend/garment_gen.py:730-732`](../backend/garment_gen.py#L730-L732)：

```python
if f.get("smile_score") is not None:
    smiling = "smiling" if float(f.get("smile_score", 0)) > 0.4 else "neutral expression"
    lines.append(f"- Expression: {smiling}")
```

連續的 0–1 blendshape 分數被 0.4 這個門檻壓成 **2 個桶**。

**這與 commit `4d0bd99` 已經否決過的做法是同一件事，而且更極端。**
那次拿掉的是把量到的膚色套進 6 色調色盤（髮色 8 色），理由是
「量化掉了角色本來要保留的個體差異」。表情現在是 **2 個桶**，比率更差，而且還在線上。

另外兩個獨立問題：

- **只看嘴角**。[`backend/face_module.py:210-216`](../backend/face_module.py#L210-L216) 取的是
  `max(mouthSmileLeft, mouthSmileRight)`。MediaPipe 的 blendshape 還有抬眉、瞇眼、張嘴、
  嘟嘴等數十項，全部沒用。結果是驚訝、皺眉、大笑、面無表情**都會變成同兩個字之一**。
- **0.4 沒有來源**。門檻沒有註解說明怎麼決定的，也沒有對照真人樣本校準過。

### 5.4 可行的解決方式（依成本排序，尚未評估優先序）

| # | 做法 | 成本 | 解決哪一段 | 風險／代價 |
|---|---|---|---|---|
| 1 | **先分層定位**：拿原始上傳檔跑 `scripts/check_hair_sampling.py`，確認 `get_face_features` 到底有沒有成功 | 近乎零 | 5.1 的前置 | 在這之前的任何修改都是猜的 |
| 2 | **偵測失敗要出聲**：`get_face_features` 回 `no_face_detected` 時回報並顯示，不要靜默降級 | 很低 | 5.1 (甲)(乙) 之外的第三種可能 | 無。目前靜默降級讓「沒量到」偽裝成「模型畫錯」，是整條問題最貴的部分 |
| 3 | **把 5.2 的四個欄位接進 `_attr_lines`** | 低（約 8 行） | 5.2 | 需確認 prompt 變長不會稀釋其他指令；建議做 A/B |
| 4 | **表情改送連續值或多級**，例如直接給 `smile_score` 數值或改 4–5 級描述 | 低 | 5.3 | 門檻仍需校準；但比 2 個桶難更差 |
| 5 | **表情改用多個 blendshape**，取前 N 高的類別組成描述 | 中 | 5.3 | 要決定哪些類別有意義，且 LEGO 臉本身表達力有限 |
| 6 | **一併補存訪客 CV 量測色進 `generation_history`**，讓 `color_allegiance` 對新 run 生效 | 中 | 5.1 的判定 | 存的是真人量測到的顏色，屬個資範疇，需與 `DEV_HISTORY_SAVE_INPUTS` 同級對待 |

**建議順序**：先做 1 和 2（在知道是哪一層壞掉之前，3–6 都可能是在修沒壞的東西），
再依 1 的結果決定要不要做 3–6。

> ⚠️ 5.1 的兩種解釋若最後證實是 (乙)（風格收斂、非個體流失），
> 則 5.2 和 5.3 仍然成立且仍值得修——它們是獨立的缺口，不依賴 5.1 的結論。

---

以上五點目前都只是記錄問題，尚未排入實作。等主計畫（`pivot-full-character` 分支）
的主要功能完成後,再回來決定要不要做、做哪一個方向。
