# 素體換裝的部件

生圖 API 不能用時（額度用完、上游掛掉），參與者在手機上自己挑髮型、衣服、配件，
由生成服務在本機組出角色（`backend/dressup.py`）。組出來的是與生成角色同規格的三視圖，
場上不會混進另一種角色。生成服務本身也沒開時，手機只剩捏臉。

| 檔案 | 內容 |
|---|---|
| `manifest.json` | 部件清單：分類、名稱、生成用的描述 |
| `raw/<id>.png` | 生圖模型在素體上「只加這一樣、塗成綠色」的三視圖原圖 |
| `layers/` | 從原圖切出來的圖層，執行時只讀這裡（`dressup_build.py` 產生） |
| `_overview.png` | 每個部件穿在素體上的總覽，切完用來目視檢查 |

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
2. 生成原圖（每張約 US$0.07）：`python scripts/dressup_generate.py hair_afro`
3. 打開 `raw/hair_afro.png` 看：三個人的位置有沒有動、部件是不是全部綠色、其他地方有沒有被改。
   不滿意就改 prompt 再跑第 2 步。
4. 切圖層：`python scripts/dressup_build.py hair_afro`，看 `_overview.png`
5. 重開生成服務。手機的換裝頁會自動多出這個選項，前端不必改。

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
沒換那一件時就直接把素體那件換色。眉毛、眼珠也是深棕，只認「連到頭頂」的那幾塊當頭髮。
