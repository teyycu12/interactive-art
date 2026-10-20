# 素體換裝的部件

生圖 API 不能用時（額度用完、上游掛掉），參與者在手機上自己挑髮型、衣服、配件，
由生成服務在本機組出角色（`backend/dressup.py`）。組出來的是與生成角色同規格的三視圖，
場上不會混進另一種角色。生成服務本身也沒開時，手機只剩捏臉。

| 檔案 | 內容 |
|---|---|
| `manifest.json` | 素體清單（`bases`）、部件清單：分類、名稱、生成用的描述 |
| `raw/<id>.png` | 生圖模型在男生素體上「只加這一樣、塗成綠色」的三視圖原圖 |
| `raw/female/<id>.png` | 同上，女生素體（`base_female.png`） |
| `layers/`、`layers/female/` | 從原圖切出來的圖層，執行時只讀這裡（`dressup_build.py` 產生） |
| `_overview.png`、`_overview_female.png` | 每個部件穿在素體上的總覽，切完用來目視檢查（不進版控） |

手機進換裝先選「男生／女生」（`manifest.json` 的 `bases`，第一個是預設）。兩個素體的臉
逐格一樣，所以表情、眉毛、眼珠是共用的；衣服髮型則每個素體各畫一套。

## 加一個新造型

1. 在 `manifest.json` 的 `parts` 加一筆：
   ```json
   { "id": "hair_afro", "category": "hair", "label": "爆炸頭",
     "prompt": "a big round afro. Front: ... Profile: ... Back: ..." }
   ```
   - `category` 用既有的：`hair` `top` `outer` `bottom` `shoes` `acc`
   - `prompt` 寫英文，三個視角各長什麼樣都要講（側面、背面最容易被省略）
   - 頭髮加一句 `Hair is a flat pixel-art silhouette with two or three shade steps only`
   - 會露出腿的下身（短褲、裙子）要寫明腿是皮膚色，否則模型會留著長褲
   - 會蓋掉別的分類（洋裝蓋上衣）加 `"hides": ["top", "outer"]`
2. 生成原圖（每張約 US$0.07，每個素體各一張）：`python scripts/dressup_generate.py hair_afro`，
   女生素體再跑一次 `--base female`
3. 打開 `raw/hair_afro.png` 看：三個人的位置有沒有動、部件是不是全部綠色、其他地方有沒有被改。
   不滿意就改 prompt 再跑第 2 步。
4. 切圖層：`python scripts/dressup_build.py hair_afro`（女生加 `--base female`），看 `_overview*.png`。
   只在某個素體上畫好的部件，手機只在那個素體列出來
5. 重開生成服務。手機的換裝頁會自動多出這個選項，前端不必改。

## 加一個表情或眉毛（不花錢、不必生成）

臉的部件是 `manifest.json` 裡手寫的格子圖，不走生圖。在 `parts` 加一筆：

```json
{ "id": "expr_smirk", "category": "expression", "label": "壞笑",
  "stamp": { "front": { "mouth": ["", "..mmm.d.", ".....m.."] },
             "side":  { "mouth": ["", ".mmd"] } } }
```

- 一個字一格（8px），`.` 是不動。字的意思見 `face.ink`：`k` 睫毛黑、`m` 嘴線、`r` 嘴裡、
  `t` 舌頭、`w` 牙齒、`d` 皮膚陰影、`b` 眉毛（跟著選的眉色換）、`i` 眼珠（跟著選的眼珠顏色換）
- 位置見 `face.slots`：正面 `brow` `eye` 寫一次左右都畫（右邊自動翻），`brow_l` `eye_r` 只畫一邊；
  側面 `brow` `eye` `mouth`。寫了哪個位置，那個五官原本的樣子就先抹成皮膚
- 每一列要一樣長（左右翻靠字串反轉）；`""` 是空一列，用來往下挪
- 不必切圖、不必重跑什麼，**重開生成服務**就好。`pytest backend/tests/test_dressup.py`
  會檢查字有沒有寫錯、有沒有畫出臉外

## 加一個新素體（約 US$1.3）

1. `manifest.json` 的 `bases` 加一筆：`id`、`label`（手機上的字）、`image`、`prompt`（叫模型把第一個
   素體改成什麼樣子，**臉、位置、姿勢都不動**）。素體原本就有的東西跟男生不同時，寫
   `base_labels`（例如女生的「不選髮型」叫「中長髮」），並用 `edit_note` 提醒模型畫部件時怎麼對待它
   （女生：換髮型才換掉長髮，其他部件要原樣保留長髮——不寫的話畫後背包會把頭髮剪短）
2. 生成候選：`python scripts/dressup_generate.py --new-base <id> -n 2`，挑一張
3. `python scripts/dressup_make_base.py <id> docs/.../dressup/raw/<id>/_base_1.png`：縮放對齊到第一個素體的身高位置，
   再把臉的格子直接從第一個素體複製過來（模型畫的臉總會偏 3–5px、大小差 1%，表情眉毛會貼歪）。
   印出的臉部差異小於 1% 才算成功
4. `python scripts/dressup_generate.py --base <id> --missing` → 看過原圖 →
   `python scripts/dressup_build.py --base <id>` → 看 `_overview_<id>.png`
5. `pytest backend/tests/test_dressup.py`：會檢查兩個素體的臉一樣、站的位置一樣、每個部件都畫齊了

## 加一個新分類

（例如「耳環」想跟其他配件分開）要改程式：`backend/dressup.py` 的 `CATEGORY_CODE`、
`DRAW_ORDER`、`DEFAULT_COLORS`，以及 `manifest.json` 的 `categories`（`region` 是這個分類
在身上的高度範圍，0 頭頂、1 腳底，切圖層時只認這一段裡的變化）。

## 切法與為什麼

原圖與素體幾乎逐格相同（實測只差約 4px、半格），對齊後跟素體比，變了的格子就是部件帶來的：

- 綠色的格子 → 部件本體，組的時候換成參與者選的顏色（保留明暗）
- 變成皮膚色的格子（裙子底下的腿、無袖洋裝的手臂）→ 跟著參與者的膚色換
- 變成白色的格子 → 擦掉
- 其他變了的格子（描邊）→ 照原樣

素體本身的髮色、膚色、T 恤、長褲、鞋子也依顏色分區（`layers/_base_labels.png`），
沒換那一件時就直接把素體那件換色。眉毛、眼珠也是深棕，只認「連到頭頂」的那幾塊當頭髮；
長髮垂到耳朵以下、跟頭頂分開的那幾塊，只要不碰到臉的格子、夠大（`LOOSE_HAIR_MIN`）也算頭髮。

長髮素體換成短髮時，原本被頭髮蓋住的肩膀和背後要補上 T 恤（遮罩的 `L_TOP`），跟著選的上衣顏色換；
不補的話背上會留一塊灰白。
