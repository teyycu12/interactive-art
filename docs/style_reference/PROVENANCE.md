# 風格參考圖集 — 來源與授權（樂高／皮克斯／像素三組共用）

> **2026-09-24：三組合併成這一份。** 原本每組各一份，但三組圖同一個來源、
> 同一份條款判定 —— 分三份的真正後果是「改了一份，另外兩份還停在舊判定」，
> 而那不會報錯，只會在被問起時拿出兩種說法。
> 三組同源這件事由專案擁有者於 2026-09-24 陳述並據此合併。
>
> **2026-08-25 判定變更：這些圖已納入版本控制。**
> 先前的結論是「不得推上公開 repo」，依據是 Elser ToS 5.2(i) 疑似禁止重製散布。
> 重讀原文後該依據不成立 —— 見下方〈授權狀態〉的「允許重製散布」列。
> 本專案用途為學術、非商業。
>
> **仍未解除的一項：浮水印。** 出貨檔已移除原始浮水印，那與 5.2(i) 無關，
> 是獨立的曝險，見〈殘留風險〉。

`scripts/check_reference_set.py` 在各組目錄內找不到 `PROVENANCE.md` 時，
會往上一層找這一份。所以合併之後每組仍然被逐檔檢查，不會靜默略過。

## 這些圖是什麼

各組 5–6 張全身參考圖，作為 `full_character` 生成時該風格的 **Image 4（風格 sheet）**。

| 目錄 | 風格 | 張數 |
|---|---|---|
| `2026q3_owner_curated/` | `lego`（樂高） | 5 |
| `2026q3_pixar_figma/` | `pixar`（皮克斯） | 6 |
| `2026q3_pixel_curated/` | `pixel`（像素） | 4 張三視圖＋1 張素體（另有 `_original/` 未加工檔；2026-10-15 前是 6 張單一正面） |

**這不是訓練資料。** 沒有任何權重被更新。這些圖是 **prompt-time 條件輸入**：
`backend/garment_gen.py` 的 `_build_style_reference_sheet()` 每次生成時把它們拼成
一張 sheet，連同訪客照片一起送往 OpenRouter → Google。也就是說，
**每一次生成都會把對應那一組圖傳輸給第三方服務**。

檔案是執行期資產：沒有它們，`_style_reference_sheet()` 會印出
`not found, sending without it` 並退回三張圖的送法，生成不會失敗，但物種統一
效果會消失，該風格的角色會各自漂移。

## 逐檔記錄

同名檔案（例如 `full_body_02_tailored_suit.png`）在多組中都有一張，構圖題材相同、
風格不同；來源與授權完全一致，因此共用一列。

| 檔案 | 來源 | 授權 | 屬於哪幾組 |
|---|---|---|---|
| full_body_01_plain_shorthair.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 樂高 |
| full_body_01_tee_denim.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 皮克斯 |
| full_body_02_tailored_suit.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 樂高、皮克斯 |
| full_body_03_dress_drape.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 樂高、皮克斯 |
| full_body_04_layered_jacket.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 樂高 |
| full_body_04_layered_hoodie.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 皮克斯 |
| full_body_05_volume_hair.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 樂高 |
| full_body_05_shorts_bare_legs.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 皮克斯 |
| full_body_06_long_coat.png | Elser AI 生成（免費帳號） | Elser ToS：非商業重製不在 5.2(i) 射程內 | 皮克斯 |
| turnaround_01.png | 專案提供的三視圖原圖 `_original/full_body_01.png`（2026-10-15），生成工具待補 |  | 像素 |
| turnaround_02.png | 專案提供的三視圖原圖 `_original/full_body_02.png`（2026-10-15），生成工具待補 |  | 像素 |
| turnaround_03.png | 專案提供的三視圖原圖 `_original/full_body_03.png`（2026-10-15），生成工具待補 |  | 像素 |
| turnaround_04.png | 專案提供的三視圖原圖 `_original/full_body_04.png`（2026-10-15），生成工具待補 |  | 像素 |
| pose_turnaround.png | Gemini 3.1 Flash Image（經 OpenRouter）依 turnaround_01–04 生成的素體，2026-10-15；原檔 `_original/base_body.png` |  | 像素（姿勢參考） |
| dressup/raw/*.png（17 張） | Gemini 3.1 Flash Image（OpenRouter）以素體 `pose_turnaround.png` 為底，一次加一個部件（2026-10-18，提示詞見 `dressup/manifest.json`） | 同素體 | 像素（素體換裝） |
| dressup/base_female.png | Gemini 3.1 Flash Image（OpenRouter）依 `pose_turnaround.png` 改成女生（2026-10-20，提示詞見 `manifest.json` 的 `bases`）；原檔 `dressup/raw/female/_base.png`。對齊到男生素體的位置，臉的格子從 `pose_turnaround.png` 複製（`scripts/dressup_make_base.py`） | 同素體 | 像素（素體換裝） |
| dressup/raw/female/*.png（17 張） | 同 `dressup/raw/*.png`，改以 `base_female.png` 為底（2026-10-20） | 同素體 | 像素（素體換裝） |

## 來源

| 項目 | 樂高（owner_curated） | 皮克斯（pixar_figma） | 像素（pixel_curated） |
|---|---|---|---|
| 取得方式 | 自行以 AI 生圖工具生成 | 同左 | 專案提供的三視圖；素體以 Gemini 3.1 Flash Image 照它們生成 |
| 來源工具 | Elser（Elser AI），免費帳號<br>https://www.elser.ai/zh-TW | 同左 | 三視圖：待補；素體：OpenRouter → Google |
| 取得日期 | 2026-08-22 | 2026 年 8–9 月 | 2026-10-15 |
| 原始檔規格 | 1344×768 WebP，橫式，EXIF/XMP 皆已無資料 | — | 1344×768 PNG，橫式三視圖（實測） |
| 出貨檔規格 | 576×864 PNG，直式單人 | PNG，直式單人 | 1536×864 PNG，三視圖，角色 636–665px 高（不縮放）|
| 加工 | 裁切為直式單人構圖、**移除浮水印** | 裁切為直式單人構圖 | 見〈像素組的後製〉 |
| 原始檔保留位置 | `2026q3_owner_curated/_original_watermarked/`（帶浮水印，5 張） | 未保留 | `2026q3_pixel_curated/_original/`（4 張＋素體原檔＋`layout.json`） |

> 檔案本身查不到任何來源線索——metadata 是空的。這幾欄只有專案擁有者能填。
> 皮克斯組的取得日期與原始檔規格仍是空的；下次動到那組時補上。

## 授權狀態

> 初版（2026-08-23）條款內容來自網頁擷取工具，屬二手摘要。
> **2026-08-25 由專案擁有者重讀 https://www.elser.ai/terms-of-service 原文**，
> 更正了 5.2(i) 的射程判讀（見下方該列）。其餘各列仍為初版的二手摘要，
> 若要據以做更高風險的決定，請先逐字核對。

| 權利 | 狀態 | 影響 |
|---|---|---|
| 授權條款名稱／URL | Elser AI Terms of Service — https://www.elser.ai/terms-of-service | — |
| 允許商業使用 | **是**（條款 4.4：「does not restrict the use of Outputs for commercial use」）。但同條款也授予 Elser 對 Input/Output 的永久、不可撤銷、免權利金授權（含訓練 AI 模型與行銷用途），是雙向授權，不是使用者獨佔 | 展覽若涉商業性質，此項風險較低 |
| **允許重製散布** | **判定變更（2026-08-25）：非商業重製不在 5.2(i) 射程內**。原文為「license, sell, rent, lease, transfer, assign, reproduce, distribute, host **or otherwise commercially exploit the Service** or any part of it」。`otherwise` 使前列動詞成為「商業利用」的例示，且受詞是 **the Service**（平台本身）而非 Output。本專案為學術、非商業用途。<br>**注意這是「移除一項禁止」而非「取得一項許可」** —— 條款仍未明文授權 Output 的重製散布，只是也未禁止。 | 已據此納入版本控制 |
| 允許公開展示產出 | 未找到明文禁止，商業使用條款隱含可公開展示，但沒有明文保障。重製散布那一項已於 2026-08-25 釐清，剩下的不確定性只有浮水印 | 決定能不能現場展出——風險低於散布，殘留項見〈殘留風險〉 |
| 允許傳輸給第三方 AI 服務 | 條款沒規範使用者把 Output 再傳給其他第三方服務；3.4 條要求使用者自行確保不侵犯第三方權利，風險由使用者承擔 | 每次生成都會發生，見上 |
| 要求標示出處 | 沒查到明文要求 | — |

## 殘留風險

**浮水印仍是未解的一項。** 樂高那組的原始檔帶浮水印、出貨檔已移除，這與 5.2(i)
讀法無關 —— 浮水印是權利主張最明確的形式，移除它在部分司法管轄區屬於獨立的問題，
不因「非商業」而免除。

採取的緩解措施：**帶浮水印的原始檔一併納入版本控制**
（`2026q3_owner_curated/_original_watermarked/`）。公開的是「原始素材 ＋ 明確標示為
衍生的工作檔」，而不是只有去浮水印的版本 —— 來源可被任何人驗證，不構成冒充自有
素材。這降低曝險但不消滅它。

像素組的原始檔（`2026q3_pixel_curated/_original/`）未見浮水印，同樣一併納入版控。

**這份文件不會讓散布變得合法。** 它記錄的是「依據什麼判定、由誰判定、還剩什麼風險」。
判定若被推翻，正確的動作是把檔案移出版控並更新這裡，不是修飾文字。

**目前結論**：發布到 GitHub —— 依上表已執行（學術、非商業）。
展覽現場展示 —— 風險低於散布，未見明文禁止。兩者共通的殘留風險是浮水印那一項。

## 像素組的後製

2026-10-15 換成三視圖那一組（前一組 6 張單一正面已整組移除，只在 git 歷史裡）。
原圖是 1344×768 的三視圖，排法各張不同（有的背面在最左、有的側面朝左），03 是灰底。

```bash
python scripts/prepare_turnaround_reference.py \
    docs/style_reference/2026q3_pixel_curated/_original \
    --out docs/style_reference/2026q3_pixel_curated
```

1. 背景（連到圖邊、亮而無色的像素，含灰底與角落暈影）壓成純白，零碎污點清掉
2. 依 `_original/layout.json` 標出每個人是哪一面，朝左的側面鏡像成朝右
3. 依「正面｜右側｜背面」重排到 1536×864，腳底同一條線、間距相同

**人物本身的像素沒有被更動，也沒有縮放**（四張原圖是同一個比例尺）。素體
（`pose_turnaround.png`）例外：它是另外生成的，以最近鄰縮放到 02 正面的高度。

不重新定格、不量化：前一組走過那兩條死路（重新定格把格子混糊、量化把綠眼睛換成藍眼睛），
這種「像素風插畫」來源的圖只能洗，不能重畫。

## 已知品質限制

### 樂高組（`docs/STYLE_PROBE_FOLLOWUPS.md` 已記錄）

1. **5 張裡有 4 張雙腿併攏成實心柱**，只在鞋子附近（約 96% 高度）才分開。
   這與 prompt 自己的 `MANDATORY LEGO DESIGN RULES #1`（雙腿間需有可見垂直間隙）
   及 `_canonical_lego_pose()` 畫的 24px 間隙直接衝突，也使分部位身高縮放
   在幾何上量不到 inseam。`full_body_03`（一體式洋裝）正當豁免。
2. **5 張髮色全落在 hue 16°–32°、saturation ≥ 92** 的窄帶。`_STYLE_SHEET_FIREWALL`
   雖明文禁止髮色轉移，但單一色帶重複 5 次是否造成偏壓，需要用
   `STYLE_REFERENCE_MODE=off` 做 A/B 實測，不能用推論的。

### 像素組（2026-10-15 那組三視圖）

1. **格距浮動、邊緣帶反鋸齒**：一格約 8.6px 上下，是生圖工具的像素風插畫，不是逐格手繪。
   刻意不重新定格（見上節）。
2. **沒有短褲、光腿的範例**：裙子那張（04）是蓬裙，腿幾乎被蓋住。參與者穿短褲、短裙時，
   大面積皮膚的色階只能靠 prompt；日後補圖時加一張。
3. **素體是生成的**：比例照參考圖，但只有一個體型。若實測發現壯的、瘦的參與者都被畫成
   同一個寬度，那是素體在起作用（身高與頭身比本來就要它定死）；寬度若需要保留差異，
   要在 prompt 裡另外講。

## 下載者須知

這些圖是本專案的執行期資產，**不是可自由再利用的素材**。
來源是 Elser AI（免費帳號）生成，見上方〈來源〉。本專案以學術、非商業用途納入版控，
並保留帶浮水印的原始檔以供驗證來源。

**若你要在本專案以外重複使用這些圖**，請自行回到 Elser 的條款確認你的用途 ——
本專案的判定只涵蓋本專案的用途，不是對你的授權。

## 若查不出來源

最乾淨的解法不是把這份文件寫模糊，而是**重生一組**：用有明確授權的工具自己產圖，
來源即為「我在 X 平台以 Y 帳號於 Z 日生成」，散布權利清楚，
並可順手修掉上面那幾項品質限制。像素那組更省事 —— 自己用 Aseprite 畫六張 90 格的
角色圖大約一到兩個下午，來源與授權從此完全乾淨。
