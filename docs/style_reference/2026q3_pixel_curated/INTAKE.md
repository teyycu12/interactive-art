# 2026q3_pixel_curated — 要提供哪些圖

> **2026-09-24：六張圖已到位，像素風格已上線**，手機端選單上選得到。
> 這份文件從「要提供什麼」變成「這組圖是照什麼規格做的」——
> 重生或增補時仍以這裡為準。
>
> 實際到手的是 1344×768 橫式的「像素風插畫」（格距浮動、邊緣帶反鋸齒、
> 7000–22000 色），**六張全部沒通過閘門檢查**。
> 現在版控裡的是 `scripts/pixelize_reference.py` 洗過的版本：**畫面內容與原圖
> 逐像素相同**（平均差 0.57/255，差異只來自背景被壓成純白與角落暈影被清掉），
> ×2 最近鄰放大、置中到 1023×1533，六張全部 PASS。
>
> **兩次修正的教訓**：先整成 64 格 → 臉變馬賽克；改成 90 格（原圖自己的格距）
> → 仍然糊，因為原圖的格距是浮動的（一格 7.9~8.1px、每張偏移不同），
> 硬切成整數列必定混到隔壁格，實測邊緣密度從 0.056 掉到 0.045，
> 而且量化把綠眼睛換成了藍眼睛。**結論：這種來源的圖不要重新定格，也不要量化。**
> 未加工的原始檔留在 `_original/`，加工細節記在
> [../PROVENANCE.md](../PROVENANCE.md)（三組風格共用一份）。

## 這組圖是什麼（先看懂用途，規格才有意義）

生成一個角色時，模型一次收到四張圖：

| | 內容 | 權威範圍 |
|---|---|---|
| Image 1 | 參與者的照片 | **誰**：臉、膚色、髮色、身上實際穿什麼、什麼顏色 |
| Image 2 | 同一張照片的局部近拍 | 同上，只是細節 |
| Image 3 | `_canonical_pixel_pose()` 程式畫的幾何 | 站姿、身體部位數量 |
| **Image 4** | **這個目錄拼成的 sheet** | **怎麼畫**：格子多粗、幾階顏色、輪廓怎麼下、衣服怎麼構成 |

prompt 裡明文寫著「設計規則與這張 sheet 衝突時，**以 sheet 為準**」
（`_ROLE_STYLE_PIXEL`）。所以這幾張圖不是參考，是這個風格的定義本身 ——
**圖裡共同出現的東西，就會變成模型認定的「像素風格」**。六張都是同一種髮色，
髮色就會滲進去；六張的格子粗細不一致，輸出的格子就會每張都不一樣。

兩件必須先知道的事：

1. **每生成一次，這幾張圖就會被傳給第三方服務一次**（OpenRouter → Google）。
   所以來源與授權要寫進 `../PROVENANCE.md`（三組共用），不能事後補。
2. **這不是訓練資料**，沒有任何權重被更新；它是 prompt-time 的條件輸入。

## 要什麼風格的圖 —— 一句話版本

> **16-bit 遊戲的正面站立角色圖**（牧場物語 / Stardew Valley / 16-bit JRPG 那種），
> 純白背景、每個材質三到五階顏色，角色約 **90 格高**、**約 3 頭身**
> （頭含髮佔身高上三分之一）。邊緣用各材質自己的最暗階，**不是**描一圈統一黑線。

明確**不要**的幾種像素風：

| 不要 | 為什麼 |
|---|---|
| 8-bit 極簡小人（32 格以下） | 臉只剩兩點，認不出是本人，作品的核心體驗就沒了 |
| 等角視角（isometric）、斜 45° | 大螢幕是正交正面視角，斜的會和場景打架 |
| 高解析「偽像素」插畫（128 格以上） | 縮到投影機上只剩柔邊色塊，看不出是像素畫 |
| 照片直接套馬賽克濾鏡 | 格子裡是照片的雜色，不是手放的色塊；輪廓會糊 |
| 帶大量 dithering（1px 棋盤網點） | 縮小後會閃爍、糊成一片泥 |
| 側面、走路動畫的其中一格、四方向行走表 | sheet 會把「多視角」也一起教給模型 |

## 需要幾張、哪幾張

**六張全身圖**，放在這個目錄，檔名照下表（`full_body_` 前綴是硬性的，
`_build_style_reference_sheet()` 靠 `glob("full_body_*")` 抓檔案，前綴不對就整組
靜默不送；編號決定它們在 sheet 上的排列順序，因為那個 glob 的結果是排序過的）。

### 先看懂「統一物種」是靠什麼達成的

sheet 是六張圖**共同**的那些性質。所以規則只有一條：

> **想讓它統一的，六張要一模一樣；不想讓它滲進角色的，六張要差開。**

| | 六張必須**完全一致** | 六張必須**差開** |
|---|---|---|
| 是什麼 | 格子粗細（90 格）、頭身比（約 3 頭身）、每材質階數（3–5）、邊緣畫法（各材質自己的最暗階）、光向（左上前方）、陰影位置（形體下緣與外側的硬邊色塊）、取景（同一框、角色同高同置中）、站姿 | 髮色、髮型、膚色、體型、服裝件別與顏色、下身構成 |
| 不這樣會怎樣 | 格子粗細不一致 → 模型收到兩種格距，輸出每張格子大小都不同；光向不一致 → 亮部到處跑，角色像不同世界的人 | 六張同一髮色 → 那個髮色會滲進每個角色（樂高那組六張髮色全擠在 hue 16°–32°，是已記錄的問題）|

`_STYLE_SHEET_FIREWALL` 雖然明文禁止把 sheet 的顏色／髮型／配件帶進輸出，
但**重複六次的東西會贏過一句禁令**。差異不是為了好看，是為了讓禁令生效。

### 六張的人物設定

共同前提（六張都一樣）：正面站立，手臂約 15° 外張，雙手可見，雙腿間至少 2 格
白色間隙（03 例外），雙腳有鞋，角色高 90 格，光從左上前方來。

**比例是量出來的，不是挑的**（2026-09-24 量自這六張）：頭含髮到下巴 = 身高
**33%**（約 30 格），肩線 **37%**，腰 **62%**，鞋頂 **90%** —— 約 **3 頭身**，
頭幾乎和肩同寬。`backend/garment_gen.py` 的 prompt 與 `_canonical_pixel_pose()`
都照這組數字寫；三邊對不上時模型會自己選一邊，實測的結果是三邊都不聽，
直接畫成 7 頭身的寫實比例。

#### `full_body_01_tee_denim.png` — 基準張

| 項目 | 設定 |
|---|---|
| 體型 | 中等，肩寬 28 格 |
| 膚色 | `#F0C8A0`（淺暖） |
| 髮 | `#3A2A22` 黑褐，短髮貼頭，無瀏海 |
| 服裝 | 米白 T 恤 `#EDE6D6` ／ 牛仔褲 `#4A6A93` ／ 深灰運動鞋 `#3F4248` |
| 臉 | 兩格眼、一格嘴，無眉 |

**這張教**：最素的兩腿分離基準；以及**淺色衣服在純白背景上怎麼站住**——
靠一格輪廓加一階暗部，而不是把衣服調灰。少了這張，模型遇到白襯衫會把它畫成灰的。

#### `full_body_02_tailored_suit.png` — 深色疊層

| 項目 | 設定 |
|---|---|
| 體型 | 高瘦，肩寬 29 格，腿較長 |
| 膚色 | `#8A5A3B`（深） |
| 髮 | `#241C1A` 黑，極短平頭 |
| 服裝 | 炭灰西裝外套 `#35383F` ／ 白襯衫 `#E8E4DA` ／ 酒紅領帶 `#7A2E34` ／ 黑皮鞋 `#23242A` |
| 臉 | 兩格眼、一格嘴，下巴一排 `#241C1A` 鬍渣格 |

**這張教**：深色布料只用四階仍分得出翻領、襯衫、領帶；**深色衣服上的輪廓要比
布料再深一階**，否則輪廓整個消失（這是深色角色最常見的崩法）；臉部毛髮怎麼用
整格表示。六張裡只有這一張有鬍子。

#### `full_body_03_dress_drape.png` — 一體式下擺（**不可省**）

| 項目 | 設定 |
|---|---|
| 體型 | 中等偏小，肩寬 25 格 |
| 膚色 | `#D9A066`（中） |
| 髮 | `#6B4A2F` 暖棕，長直髮及胸，有瀏海 |
| 服裝 | 青綠洋裝 `#2E7A6B`，裙襬在 75% 高度 ／ 裙下小腿露膚 ／ 米色平底鞋 `#CDBBA0` |
| 臉 | 兩格眼、一格嘴 |

**這張教**：裙子是**一整塊、不縱切**，裙襬下面才是兩條小腿。prompt 第 5 條寫了
這件事，但寫的規則與看到的圖衝突時模型跟圖走 —— 六張全是長褲的話，穿洋裝的
參與者會拿到一條被切成兩半的裙子。另外教長髮：一塊剪影加一階亮部，不是一根根。

#### `full_body_04_layered_hoodie.png` — 三層疊穿＋眼鏡

| 項目 | 設定 |
|---|---|
| 體型 | 壯，肩寬 32 格 |
| 膚色 | `#F5D8B8`（最淺） |
| 髮 | `#C9A24B` 亞麻金，蓬鬆中長，蓋住部分額頭 |
| 服裝 | 芥黃連帽外套 `#C98A2E`（敞開）／ 內搭深藍 T `#2B3A55` ／ 灰工作褲 `#6E6A63` ／ 白運動鞋 `#E4E0D6` |
| 臉 | 眼鏡：橫過雙眼的一格深線，兩側各一格鏡腿 |

**這張教**：三層同時存在、各自保住自己的顏色、用一格暗線分開；帽子堆在肩上的
體積；眼鏡只用整格表示。

**六張裡只有這一張戴眼鏡**，這是刻意的取捨：現場戴眼鏡的人很多，模型需要看過
一次「眼鏡在這個格數下怎麼畫」，但放兩張以上就會開始幫沒戴眼鏡的人加眼鏡。

#### `full_body_05_shorts_bare_legs.png` — 大面積皮膚・最深膚色

| 項目 | 設定 |
|---|---|
| 體型 | 纖細，肩寬 25 格，腿較長 |
| 膚色 | `#6B3F2A`（最深） |
| 髮 | `#1F1A18` 黑捲髮，剪影比其他張寬 3~4 格 |
| 服裝 | 亮橘短袖 `#D9542B` ／ 卡其短褲 `#B6A17C` ／ 深棕鞋 `#5A4030` |
| 臉 | 兩格眼、一格嘴 |

**這張教**：皮膚成為大面積時的四階怎麼分；**深膚色的亮部不可以用白或米色**
（用 `#9A6446` 這類同色系的提亮），這是深膚色參與者最容易被畫壞的地方；
膝蓋、腳踝不畫細節。它同時負責把整組的膚色與髮型分布往外拉。

#### `full_body_06_long_coat.png` — 過膝長擺・淺色大面積

| 項目 | 設定 |
|---|---|
| 體型 | 中等偏高，肩寬 28 格 |
| 膚色 | `#C98F63` |
| 髮 | `#A9AAB0` 銀灰，綁成丸子（頭頂多出約 4 格） |
| 服裝 | 米白長大衣 `#D8CEBA`（下襬到 78% 高度）／ 內搭深綠 `#2F4636` ／ 黑窄褲 `#2A2B30` ／ 深棕靴 `#5A4030` |
| 臉 | 兩格眼、一格嘴 |

**這張教**：下襬長度介於洋裝與長褲之間的中間案例（大衣下面仍有兩條腿）；
淺色占滿整個軀幹時怎麼不糊成一片；綁起來的頭髮是另一種剪影。

### 這六張合起來的分布（檢查用）

- **膚色**：`#F5D8B8` → `#F0C8A0` → `#D9A066` → `#C98F63` → `#8A5A3B` → `#6B3F2A`，六階不重疊。
- **髮色**：黑褐、黑、暖棕、亞麻金、黑、銀灰。**兩張純黑是刻意的**（反映現場多數），
  但必須有金色與銀灰把色帶撐開，否則就重蹈樂高那組的覆轍。
- **下身構成**：分腿 4 張、一體式 1 張、過膝長擺 1 張 —— 對應 prompt 第 5 條的兩種分支。
- **明度**：淺色主調 2 張（01、06）、中間調 2 張（03、04）、深色 1 張（02）、高彩度 1 張（05）。
- **體型**：肩寬 25／25／28／28／29／32 格。**六張的總高都是 90 格**，
  差異只放在寬度與比例，不放在高度 —— 高度一變，sheet 就會教出不一致的格距。

### 顏色階數怎麼推（六張用同一條規則，才會像同一個物種）

每個材質三到五階，從底色推：

- **暗部**：明度 −22%，色相往藍紫移 8~12°，彩度 +6%（深色衣物可再加一階）
- **亮部**：明度 +14%，色相往黃移 6~10°，彩度 −8%
- **邊緣**：用**該材質自己的最暗階**，不是全圖同一支墨線 —— 牛仔褲外緣是深藍、
  棕髮外緣是深棕、裸手臂外緣是深膚色。整個角色最深的那一階維持在
  `#302A2D` 附近的暖深灰、不要純黑，角色才和大螢幕像素場景的墨色同一家族。

### 六張都不要出現的東西

手上拿著任何物件、帽子、背包、寵物、地面陰影、人物之間的互動、任何文字或簽名。
這些一旦在多張裡重複，就會變成「這個物種的一部分」。

## 六段可直接貼的生成 prompt

每段自足（共同風格條款已內嵌），一次生一張。**六段的共同段落一個字都不要改** ——
那段就是「統一物種」本身；只改人物設定那一句。

> **先知道這件事**：擴散模型很難一次交出合格的像素圖，交出來的通常是
> 「像素風插畫」——邊緣帶反鋸齒、格子大小不均。這幾段 prompt 是**起點不是終點**，
> 生完必須過一次後製：縮成 90 格高（最近鄰）→ 限制色數 → 以 ×15 最近鄰放大。
> Aseprite 手動修一輪最保險，六張大約一個下午。

共同的 negative（六段共用）：

```
anti-aliasing, soft edges, feathered edges, semi-transparent pixels, gradient,
blur, glow, drop shadow, dithering, checkerboard texture, noise, grain,
3D render, photograph, mosaic filter, smooth vector art, anime cel shading,
isometric view, side view, three-quarter view, walking animation strip,
multiple views, turnaround sheet, duplicate figures, background, floor,
ground shadow, contact shadow, text, watermark, signature, hat, bag,
held props, extra limbs, missing shoes
```

### 01 — 年輕女性・米白 T 恤＋牛仔褲（基準張）

```
16-bit game pixel art sprite of a young woman, full body, strict front view,
centered. Medium build, 20 pixels across the shoulders. Light warm skin #F0C8A0.
Short black-brown hair #3A2A22 cropped close to the head, no fringe. She wears a
plain off-white t-shirt #EDE6D6, blue jeans #4A6A93, and dark grey sneakers
#3F4248 that are one pixel wider than the legs. Face: two large eyes each with a visible white and a dark iris, a one-pixel
nose, a small mouth. The off-white shirt stays off-white:
it is separated from the white background by its own darkest edge tone and one
shadow step, never by graying the fabric.
The figure is exactly 90 pixels tall on ONE uniform pixel grid, every edge
aligned to the grid, hard-edged pixels with no anti-aliasing. It is about THREE
heads tall: the head including hair fills the top third of the figure and is
nearly as wide as the shoulders, the collar sits at 37% of total height, the
waist at 62%, the top of the shoes at 90%. NOT a realistic 6-to-8-head adult. Neutral stance:
arms about 15 degrees out from the sides, hands visible as blocks at the wrists,
legs straight with a clear 2-pixel vertical gap between them. Every part is bounded by a
one-pixel edge in THAT PART'S OWN darkest tone, never one uniform black contour
around the whole figure; the darkest tone anywhere stays a warm dark grey near
#302A2D rather than pure black. Three to five values per material: a base, one
or two shadow steps, one highlight step, and that edge tone. Single light source
from the upper left front; shadow is a hard grid-aligned band along the lower and
outer side of each form, never a gradient. Pure solid white #FFFFFF background,
no ground shadow, one single character, no text.
```

### 02 — 成年男性・炭灰西裝（深膚色・疊層）

```
16-bit game pixel art sprite of an adult man, full body, strict front view,
centered. Tall slim build with long legs, 21 pixels across the shoulders. Deep
brown skin #8A5A3B. Very short black hair #241C1A, flat on top. He wears a
charcoal tailored suit jacket #35383F open over a white shirt #E8E4DA with a dark
red tie #7A2E34, matching charcoal trousers, and black leather shoes #23242A.
Face: two large eyes with visible whites, a small mouth, and a row of dark stubble pixels
along the jaw. Because the suit is already very dark, its edge tone is one step darker again
than the fabric so the silhouette never disappears.
The figure is exactly 90 pixels tall on ONE uniform pixel grid, every edge
aligned to the grid, hard-edged pixels with no anti-aliasing. It is about THREE
heads tall: the head including hair fills the top third of the figure and is
nearly as wide as the shoulders, the collar sits at 37% of total height, the
waist at 62%, the top of the shoes at 90%. NOT a realistic 6-to-8-head adult. Neutral stance:
arms about 15 degrees out from the sides, hands visible as blocks at the wrists,
legs straight with a clear 2-pixel vertical gap between them. Every part is bounded by a
one-pixel edge in THAT PART'S OWN darkest tone, never one uniform black contour
around the whole figure; the darkest tone anywhere stays a warm dark grey near
#302A2D rather than pure black. Three to five values per material: a base, one
or two shadow steps, one highlight step, and that edge tone. Single light source
from the upper left front; shadow is a hard grid-aligned band along the lower and
outer side of each form, never a gradient. Pure solid white #FFFFFF background,
no ground shadow, one single character, no text.
```

### 03 — 成年女性・青綠洋裝（一體式下擺，這張最關鍵）

```
16-bit game pixel art sprite of an adult woman, full body, strict front view,
centered. Small-to-medium build, 18 pixels across the shoulders. Medium tan skin
#D9A066. Long straight warm brown hair #6B4A2F falling to the chest with a
straight fringe, drawn as one flat silhouette with a single lighter step on top,
never individual strands. She wears a teal dress #2E7A6B which hangs as ONE
continuous unbroken block from the waist down to its hem at 75% of the figure
height, with NO vertical split and no separate legs inside it; her bare calves in
her own skin tone continue below the hem, ending in cream flat shoes #CDBBA0.
Face: two large eyes with visible whites and dark irises, a small nose and mouth.
The figure is exactly 90 pixels tall on ONE uniform pixel grid, every edge
aligned to the grid, hard-edged pixels with no anti-aliasing. It is about THREE
heads tall: the head including hair fills the top third of the figure and is
nearly as wide as the shoulders, the collar sits at 37% of total height, the
waist at 62%, the top of the shoes at 90%. NOT a realistic 6-to-8-head adult. Neutral stance:
arms about 15 degrees out from the sides, hands visible as blocks at the wrists.
Every part is bounded by a one-pixel edge in THAT PART'S OWN darkest tone, never
one uniform black contour around the whole figure; the darkest tone anywhere
stays a warm dark grey near #302A2D rather than pure black. Three to five values
per material: a base, one or two shadow steps, one highlight step, and that edge
tone. Single light source from the upper left front; shadow is a hard
grid-aligned band along the lower and outer side of each form, never a gradient.
Pure solid white #FFFFFF background, no ground shadow, one single character,
no text.
```

### 04 — 成年男性・連帽外套三層＋眼鏡

```
16-bit game pixel art sprite of an adult man, full body, strict front view,
centered. Stocky build, 23 pixels across the shoulders. Very light skin #F5D8B8.
Voluminous mid-length ash-blond hair #C9A24B covering part of the forehead. He
wears an open mustard hoodie #C98A2E over a navy t-shirt #2B3A55, grey work
trousers #6E6A63 and white sneakers #E4E0D6, with the hood bunched into a visible
mass on the shoulders. All three layers keep their own colour and each is
separated from the one beneath by a single darker pixel line, never a soft edge.
Face: two large eyes with visible whites, a small mouth, and glasses drawn as a
dark pixel line across both eyes with a single pixel temple on each side.
The figure is exactly 90 pixels tall on ONE uniform pixel grid, every edge
aligned to the grid, hard-edged pixels with no anti-aliasing. It is about THREE
heads tall: the head including hair fills the top third of the figure and is
nearly as wide as the shoulders, the collar sits at 37% of total height, the
waist at 62%, the top of the shoes at 90%. NOT a realistic 6-to-8-head adult. Neutral stance:
arms about 15 degrees out from the sides, hands visible as blocks at the wrists,
legs straight with a clear 2-pixel vertical gap between them. Every part is bounded by a
one-pixel edge in THAT PART'S OWN darkest tone, never one uniform black contour
around the whole figure; the darkest tone anywhere stays a warm dark grey near
#302A2D rather than pure black. Three to five values per material: a base, one
or two shadow steps, one highlight step, and that edge tone. Single light source
from the upper left front; shadow is a hard grid-aligned band along the lower and
outer side of each form, never a gradient. Pure solid white #FFFFFF background,
no ground shadow, one single character, no text.
```

### 05 — 成年男性・短袖短褲（最深膚色・大面積皮膚）

```
16-bit game pixel art sprite of an adult man, full body, strict front view,
centered. Slender build with long legs, 18 pixels across the shoulders. Deep
brown skin #6B3F2A. Black curly hair #1F1A18 whose silhouette is 2 to 3 pixels
wider than the head on each side. He wears a bright orange short-sleeve top
#D9542B, khaki shorts #B6A17C ending above the knee, and dark brown shoes
#5A4030, so his bare arms and bare legs are large uninterrupted areas of skin.
The skin highlight step is a warm same-family tone #9A6446 — never white, never
cream. No knee or ankle detail. Face: two large eyes with visible whites and dark irises, a small nose and mouth.
The figure is exactly 90 pixels tall on ONE uniform pixel grid, every edge
aligned to the grid, hard-edged pixels with no anti-aliasing. It is about THREE
heads tall: the head including hair fills the top third of the figure and is
nearly as wide as the shoulders, the collar sits at 37% of total height, the
waist at 62%, the top of the shoes at 90%. NOT a realistic 6-to-8-head adult. Neutral stance:
arms about 15 degrees out from the sides, hands visible as blocks at the wrists,
legs straight with a clear 2-pixel vertical gap between them. Every part is bounded by a
one-pixel edge in THAT PART'S OWN darkest tone, never one uniform black contour
around the whole figure; the darkest tone anywhere stays a warm dark grey near
#302A2D rather than pure black. Three to five values per material: a base, one
or two shadow steps, one highlight step, and that edge tone. Single light source
from the upper left front; shadow is a hard grid-aligned band along the lower and
outer side of each form, never a gradient. Pure solid white #FFFFFF background,
no ground shadow, one single character, no text.
```

### 06 — 成年女性・米白長大衣（過膝長擺・綁髮）

```
16-bit game pixel art sprite of an adult woman, full body, strict front view,
centered. Medium-tall build, 20 pixels across the shoulders. Medium warm skin
#C98F63. Silver-grey hair #A9AAB0 tied up in a bun that adds about 3 pixels above
the head, drawn as one flat silhouette with a single lighter step. She wears an
off-white long coat #D8CEBA hanging open over a dark green top #2F4636, with the
coat hem reaching 78% of the figure height; black slim trousers #2A2B30 continue
below that hem as two separate legs with a gap between them, ending in dark brown
boots #5A4030. Face: two large eyes with visible whites and dark irises, a small nose and mouth.
The figure is exactly 90 pixels tall on ONE uniform pixel grid, every edge
aligned to the grid, hard-edged pixels with no anti-aliasing. It is about THREE
heads tall: the head including hair fills the top third of the figure and is
nearly as wide as the shoulders, the collar sits at 37% of total height, the
waist at 62%, the top of the shoes at 90%. NOT a realistic 6-to-8-head adult. Neutral stance:
arms about 15 degrees out from the sides, hands visible as blocks at the wrists.
Every part is bounded by a one-pixel edge in THAT PART'S OWN darkest tone, never
one uniform black contour around the whole figure; the darkest tone anywhere
stays a warm dark grey near #302A2D rather than pure black. Three to five values
per material: a base, one or two shadow steps, one highlight step, and that edge
tone. Single light source from the upper left front; shadow is a hard
grid-aligned band along the lower and outer side of each form, never a gradient.
Pure solid white #FFFFFF background, no ground shadow, one single character,
no text.
```

## 每張圖的硬規格

- [ ] **格線**：角色從髮頂到鞋底 **90 格**，六張一模一樣，不接受各自浮動。
      這個數字寫死在 `garment_gen.PIXEL_ART_GRID_HEIGHT`，改圖就要改那裡。
- [ ] **比例**：約 3 頭身 —— 頭含髮佔上三分之一（約 30 格）、肩線 37%、
      腰 62%、鞋頂 90%。六張一致，這是 sheet 教給模型的比例。
- [ ] **放大方式**：最近鄰（nearest neighbour）整數倍。這批用 **×2**
      → 角色在檔案裡約 1430px 高（原圖 713px）。
      倍率只要讓角色填滿畫框高度的 85~95% 即可；**不要用重新定格去湊格數**。
      **倍率必須是 3 的倍數**：拼 sheet 那一步會把整張縮成 1/3，一格 15px 會
      乾淨地變成 5px，一格 16px 會變成 5.33px 而在格線上產生灰邊。
      `scripts/check_reference_set.py` 要求角色至少 640px 高，960 有餘裕。
- [ ] **邊緣是硬的**：不可有反鋸齒、不可有半透明邊緣像素。
      （這不只是美感：`_remove_white_background()` 與 `slicer.alpha_bbox()`
      都假設邊緣是硬的，柔邊會在角色周圍留一圈白毛。）
- [ ] **背景純白 `#FFFFFF`**，完全均勻。無地板、無接觸陰影、無邊框、無文字、
      無浮水印、無簽名。
- [ ] **單人、全身、不裁切**。正面站立，手臂約 15° 外張，雙手看得見，
      **雙腿之間至少 2 格白色間隙**（洋裝那張正當例外），雙腳都有鞋，
      鞋比腿每邊寬一格。
- [ ] **調色**：每個材質三到五階（底色／一到兩階暗部／亮部／邊緣色）。相鄰的兩件衣服
      **明度**要差開，不能只差色相 —— 角色在大螢幕上只有一百多個裝置像素高，
      只差色相的兩塊會併成一塊。
- [ ] **邊緣**：每個部位用自己材質的最暗階當一格邊，**不要**整個角色描一圈
      統一黑線（那是另一種畫風，而且會把雙腿之間的 2 格間隙填掉）。
      全圖最深的那一階維持在 `#302A2D` 附近的暖深灰、不要純黑 —— 這支墨色刻意與
      `public/screen/scenes/pixelKit.js` 的 `INK` 相同，角色會站在像素廚房／
      辦公室前面，兩邊的黑不同調會像貼上去的。
- [ ] **陰影**是沿著形體下緣與外側的一條硬邊色塊，不是漸層。
- [ ] **格式 PNG**（`.webp` 品質 ≥95 也收）。**絕對不要 JPEG** ——
      壓縮方塊會直接汙染檢查腳本量的 `edge_density` 與 `local_contrast`。
- [ ] **畫面尺寸 1023 × 1533 px**（2:3 直式），角色置中。
      這個數字不是隨便選的：`_build_style_reference_sheet()` 會把每張縮到
      341×511 的格子裡，1023×1533 剛好是整數的 1/3，格線才不會在拼 sheet 的
      那一步被糊掉。1024×1536 會變成 0.333008 倍的非整數縮放。

### 為什麼是 90 格（以及為什麼不是 64）

90 是**這六張原圖自己的格距**：原圖角色高約 713px、一格約 8px。取 90 等於
「只把邊緣變硬、把顏色收乾淨」，不重新詮釋它的細節。

先前設 64，理由是投影機：大螢幕上角色高約 `worldHeight * 57 * zoom` 邏輯單位，
在 1920×1080 投影機上只有 **130~170 個裝置像素**，64 格時一格約 2~3 個裝置像素，
最能看出「這是像素畫」。**實際做出來被否決了** —— 64 格把臉壓成馬賽克，
而這件作品的核心是參與者認得出那是自己。

取 90 的代價要知道：投影機上一格只剩 **1.5~1.9 個裝置像素**，遠看會比 64 格柔，
顆粒感主要靠手機確認頁成立（那裡角色有近 2000 個實際像素高）。
**兩邊都只能在真的投影機上判斷**，開發機視窗大、角色被放大，看不出差別。

## 材質近拍（`material_*.png`）：這組不需要

`_build_style_reference_sheet()` 只 glob `full_body_*`，所以 `material_*.png`
**根本不會被送給模型** —— 它只被 `scripts/check_reference_set.py` 讀來做品管。
像素風格的材質資訊本來就已經在全身圖的四階裡說完了，再放一組近拍只會多一份
要維護的檔案。要放也可以，但別指望它影響生成結果。

## 圖到手之後怎麼上線

```bash
# 1. 原始圖放進 _original/（檔名照上表）
# 2. 後製：只留主體（清掉角落暈影）、背景壓純白、×2 最近鄰放大置中
#    預設不重新定格也不量化 —— 那兩件事會把這種來源的圖糊掉，見腳本說明
python scripts/pixelize_reference.py     docs/style_reference/2026q3_pixel_curated/_original     --out docs/style_reference/2026q3_pixel_curated

# 3. 閘門檢查：解析度、JPEG 壓縮痕、雜散物件、背景純度、彼此的離散度
python scripts/check_reference_set.py docs/style_reference/2026q3_pixel_curated

# 3. 在 docs/style_reference/PROVENANCE.md 的逐檔表格補上新檔案，不可略過：
#    這幾張圖每次生成都會被送到第三方服務，而且會進版控

# 4. 刪掉 backend/garment_gen.py 裡 pixel 風格的 ready=False 那一行（已完成）

# 5. 測試（會檢查這個目錄有六張 1023x1533 的 PNG）
pytest backend/tests/test_style_registry.py backend/tests/test_service.py

# 6. 實拍驗證：至少三個人、其中一位穿洋裝或長大衣（待做）
bash start.sh
```

上線前最後一關是肉眼：**把生成的角色放到大螢幕的像素場景前面看**
（`public/screen/index.html?scene=kitchen`）。角色與背景的墨色、格子粗細、
飽和度若對不上，問題幾乎都在這幾張參考圖，不在 prompt。

## 還沒解決、圖到手後要一起決定的一件事

貼圖從生成到投影會經過兩次重新取樣，兩次都是**平滑**的：

1. `backend/slicer.py` 的 `normalize()` 用 LANCZOS 把角色縮放到 1024px 高。
   生成圖裡角色若不是 1024 的整數關係，格線會被插值成灰邊。
2. 大螢幕 `public/screen/screen.js` 設了 `imageSmoothingQuality = 'high'`，
   把 1024px 的貼圖縮到一百多像素時會再糊一次。

64 格時一格還有 2~3 個裝置像素，撐得住這兩道；**改成 90 格之後只剩 1.5~1.9 個**，
所以這一項從「先不改」升級成「投影驗收時要特別看」。
如果投影出來覺得「像低解析度的柔邊角色，不像像素畫」，正解是讓渲染端
知道這個角色是像素風格：`/generate` 回傳的 `styleId` 目前**沒有**被帶進
`pendingScanConfig`，所以大螢幕不知道該關掉平滑。要做的話是一整條
「styleId → avatar → 伺服器 → 大螢幕 → `imageSmoothingEnabled = false`」的
接線，屬於獨立一次改動，不要混進備圖這一步。
