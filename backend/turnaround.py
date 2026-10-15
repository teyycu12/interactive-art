"""
三視圖切割：把一張「正面｜右側｜背面」並排的生成圖切成三張。

像素風一次生成三視圖（見 garment_gen 的 _PIXEL_PROMPT_TEMPLATE），省掉另外
兩次生圖呼叫，三張又出自同一次生成，衣服、髮型、顏色自然一致。

**必須在去背之前切。** _remove_white_background() 會丟掉不連在主體上的
孤島（_drop_detached_islands），三個人並排時另外兩個人就是孤島 —— 先去背
的話側面與背面會被整個刪掉，而且不會報錯。

切法：在白底上做每一欄的前景投影，三個人之間的白色欄就是切點。不用固定
的三等分：模型不保證三個人等寬、等距，固定切線會切到手或把鄰居的手肘帶進來。
"""

import base64
import io
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image as PILImage

# 比這個暗（任一通道）就算前景。背景要求是純白，但模型的白底常帶一點雜訊
WHITE_THRESHOLD = 235
# 一欄裡至少要有這麼多前景像素（以圖高為單位）才算「有東西」，擋掉零星雜點
COLUMN_MIN_RATIO = 0.004
# 兩段之間的空白窄於這個寬度（以圖寬為單位）就併成一段：同一個人手臂與
# 身體之間的縫不能被當成兩個人
MERGE_GAP_RATIO = 0.012
# 一段至少要這麼寬、這麼高才算一個人（以圖寬／圖高為單位）
MIN_WIDTH_RATIO = 0.04
MIN_HEIGHT_RATIO = 0.3
# 切下來的每一張左右多留的白邊（像素），去背與 normalize 都需要一點邊
PAD = 8

VIEW_ORDER = ("front", "side", "back")


def _decode(png_b64: str) -> PILImage.Image:
    if "," in png_b64[:64]:
        png_b64 = png_b64.split(",", 1)[1]
    return PILImage.open(io.BytesIO(base64.b64decode(png_b64))).convert("RGB")


def _encode(img: PILImage.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ── 清掉模型自作主張畫的「設定稿」裝飾 ──
#
# 實測（2026-10-14）模型把三視圖畫成設計稿：整張鋪格線、上下左右加黑框。
# 格線每一欄都有、黑框每一欄都有 —— 不清掉的話整張圖只會被當成「一個人」，
# 去背的 flood fill 也被格線擋住，整張設定稿原封不動當成角色上場。
# prompt 已經叫它不要畫（_PIXEL_PROMPT_TEMPLATE），這裡是第二道防線。

# 外框：從圖邊往內，這一列／欄有超過這個比例是近黑色就算框
FRAME_DARK_RATIO = 0.5
# 外框的顏色上限（三個通道都低於它）。模型畫的框是純黑 0，角色的描邊是深棕，
# 不能放太寬，否則框裡踩到的鞋子描邊也會被洗白
FRAME_DARK_MAX = 24
# 外框最多佔圖的這麼多（每一邊）。再寬就不是框，是角色本身
FRAME_MAX_RATIO = 0.15
# 格線：細（開運算的方塊抹得掉）且直（有一段這麼長的水平或垂直連續前景）
LINE_THICK_RATIO = 0.006   # 以圖高為單位，878px 高時約 5px；格線實測 1–2px
LINE_LONG_RATIO = 0.12


def _frame_extent(dark: np.ndarray, axis: int) -> Tuple[int, int]:
    """從兩端往內數有幾列（axis=1）或幾欄（axis=0）是外框。"""
    frac = dark.mean(axis=axis)
    limit = int(len(frac) * FRAME_MAX_RATIO)
    head = 0
    while head < limit and frac[head] > FRAME_DARK_RATIO:
        head += 1
    tail = 0
    while tail < limit and frac[len(frac) - 1 - tail] > FRAME_DARK_RATIO:
        tail += 1
    return head, tail


def clean_sheet(img: PILImage.Image) -> PILImage.Image:
    """把外框與格線洗成白色，角色本身不動。沒有框也沒有格線時原圖照回。"""
    import cv2  # 延後載入：只有三視圖才需要

    arr = np.asarray(img.convert("RGB")).copy()
    h, w = arr.shape[:2]

    # 外框：只洗近黑色像素，踩進框裡的鞋子保留
    dark = arr.max(axis=2) < FRAME_DARK_MAX
    top, bottom = _frame_extent(dark, axis=1)
    left, right = _frame_extent(dark, axis=0)
    band = np.zeros((h, w), dtype=bool)
    band[:top] = True
    band[h - bottom:] = True
    band[:, :left] = True
    band[:, w - right:] = True
    arr[band & dark] = 255

    # 格線：前景裡「細」且「直」的部分。角色本身的實心區塊開運算後還在，
    # 描邊貼著實心區塊所以也在；只有一兩像素粗、又拉得很長的線會被洗掉
    fg = (arr.min(axis=2) < WHITE_THRESHOLD).astype(np.uint8)
    # 核長一律奇數：OpenCV 的偶數核錨點偏一格，開運算後線的一端會殘留一像素
    k = max(3, int(round(h * LINE_THICK_RATIO))) | 1
    solid = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    long_ = max(k * 3, int(h * LINE_LONG_RATIO)) | 1
    lines = (cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((1, long_), np.uint8))
             | cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((long_, 1), np.uint8)))
    # 外擴一像素：格線旁邊有一圈反鋸齒的淡灰（比白底暗一點、又不夠暗到算前景），
    # 留著的話剛好擋住去背的 flood fill，兩腿之間整條白縫被當成「圍起來的白色衣物」
    erase = cv2.dilate(lines, np.ones((3, 3), np.uint8))
    arr[(erase > 0) & (solid == 0)] = 255
    # 格線在框裡留下的短刻度：落在框帶、又不屬於實心區塊的前景
    arr[band & (solid == 0) & (fg > 0)] = 255
    return PILImage.fromarray(arr, "RGB")


# ── 手臂與身體之間被圍住的白縫 ──
#
# 去背是從圖邊往內 flood fill，被手臂與身體圍住的白縫走不到，原樣留成不透明
# 的白（白色衣物、白鞋靠同一條規則留下來，所以不能一律挖掉）。判定是縫：
#
# - 窄（每一列平均不超過幾格寬）而且直的比橫的長：縫沿著手臂。白色袖口是
#   橫的一條，不算；白上衣整件連成一大塊（淡灰的摺痕也算進「亮」），太寬，不算；
# - 在手臂的高度：眼睛的反光在上面、白鞋在下面；
# - 在手臂與身體之間：離這一列輪廓的外緣不太遠、也不貼著外緣。貼著外緣的
#   是手臂本身（袖子上的白條紋）。
#
# 試過要求「縫的左右兩邊都是深色描邊」：模型常讓縫直接貼著膚色或衣服色，
# 實測粉紅洋裝的縫大半過不了，已拿掉。
#
# 只給正面與背面：側面的手貼在身體前面，沒有這種縫。
#
# 試過「縫裡原本有格線就是背景」（模型在格線上蓋角色，白衣服裡不該有線）：
# 實測白上衣的摺痕、眼睛的描邊也是細直線，被當成格線，上衣挖出一堆洞、
# 眼睛的反光也被挖掉。已否決。
# 「縫」的顏色：亮、而且幾乎沒有顏色。不只看純白：縫裡常有沒洗乾淨的淡灰
# 格線，把一條縫隔成好幾小塊，每一塊旁邊都是淡灰而不是描邊。膚色、粉紅
# 衣服都有顏色（最大與最小通道差得多），不會被算進來
GAP_LIGHT_LUMA = 185
GAP_MAX_CHROMA = 30
GAP_ROWS = (0.34, 0.78)   # 以角色高為單位：肩膀到手
GAP_MAX_WIDTH_CELLS = 2.5
GAP_SIDE_RATIO = (0.08, 0.36)   # 離這一列輪廓外緣的距離（輪廓寬的比例）
GAP_MIN_ASPECT = 1.3            # 高 ÷ 平均寬
GAP_MIN_HEIGHT_CELLS = 1.2      # 比這矮的是雜點（裙子上的一小格淺灰），不是縫
CELLS_PER_FIGURE = 75     # 與 garment_gen.PIXEL_ART_GRID_HEIGHT 同值


def _enclosed_gaps(rgb: np.ndarray, side_view: bool) -> np.ndarray:
    """回傳應該挖成透明的像素（被圍住、又判定是背景的白色塊）。"""
    import cv2

    h, w = rgb.shape[:2]
    rgbi = rgb.astype(np.int16)
    luma = rgbi[..., 0] * 0.299 + rgbi[..., 1] * 0.587 + rgbi[..., 2] * 0.114
    chroma = rgbi.max(axis=2) - rgbi.min(axis=2)
    light = ((luma >= GAP_LIGHT_LUMA) & (chroma <= GAP_MAX_CHROMA)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(light, connectivity=4)
    fg = rgb.min(axis=2) < WHITE_THRESHOLD
    rows = np.nonzero(fg.any(axis=1))[0]
    if len(rows) == 0:
        return np.zeros((h, w), dtype=bool)
    fy0, fy1 = int(rows[0]), int(rows[-1])
    fh = max(1, fy1 - fy0 + 1)
    cell = fh / CELLS_PER_FIGURE

    out = np.zeros((h, w), dtype=bool)
    for i in range(1, n):
        x, y, cw, ch, _area = stats[i]
        if x == 0 or y == 0 or x + cw >= w or y + ch >= h:
            continue   # 碰到邊的是外面的背景，flood fill 會處理
        if side_view:
            continue
        comp = labels == i
        # 寬度看每一列的平均，不看外框：手臂是斜的，縫也斜，外框會比縫寬很多
        row_w = comp[y:y + ch].sum(axis=1)
        mean_w = row_w[row_w > 0].mean()
        if (mean_w > GAP_MAX_WIDTH_CELLS * cell or ch < GAP_MIN_ASPECT * mean_w
                or ch < GAP_MIN_HEIGHT_CELLS * cell):
            continue
        cy = (y + ch / 2 - fy0) / fh
        if not (GAP_ROWS[0] <= cy <= GAP_ROWS[1]):
            continue
        r = int(y + ch // 2)
        cols = np.nonzero(fg[r])[0]
        if len(cols) == 0:
            continue
        rx0, rx1 = cols[0], cols[-1]
        rw = max(1, rx1 - rx0)
        cx = x + cw / 2
        side = min(cx - rx0, rx1 - cx) / rw
        if GAP_SIDE_RATIO[0] <= side <= GAP_SIDE_RATIO[1]:
            out |= comp
    return out


def find_figures(img: PILImage.Image) -> List[Tuple[int, int, int, int]]:
    """白底上一個個的人，由左到右：[(x0, x1, y0, y1), ...]（x1、y1 不含）。"""
    arr = np.asarray(img.convert("RGB"))
    h, w = arr.shape[:2]
    fg = arr.min(axis=2) < WHITE_THRESHOLD
    has = fg.sum(axis=0) > max(2, int(h * COLUMN_MIN_RATIO))

    segments: List[List[int]] = []
    x = 0
    while x < w:
        if not has[x]:
            x += 1
            continue
        start = x
        while x < w and has[x]:
            x += 1
        if segments and start - segments[-1][1] < w * MERGE_GAP_RATIO:
            segments[-1][1] = x
        else:
            segments.append([start, x])

    figures = []
    for x0, x1 in segments:
        if x1 - x0 < w * MIN_WIDTH_RATIO:
            continue
        rows = np.nonzero(fg[:, x0:x1].any(axis=1))[0]
        if len(rows) == 0 or rows[-1] - rows[0] + 1 < h * MIN_HEIGHT_RATIO:
            continue
        figures.append((x0, x1, int(rows[0]), int(rows[-1]) + 1))
    return figures


def split_turnaround(png_b64: str) -> Tuple[Optional[dict], int]:
    """把三視圖切成 {"front", "side", "back"} 三張白底 PNG（base64）。

    回傳 (views, 找到幾個人)。找到的不是剛好三個時 views 只有 "front"：
    取最左邊那個（prompt 要求正面在最左），側面與背面從缺 —— 角色照樣
    進場，走到側面或背面時畫正面。不拿整張圖當正面：模型畫了兩個或四個人
    時，整張圖會變成一個「好幾個人黏在一起」的角色。
    一個人都找不到時回傳 (None, 0)，交給呼叫端照舊處理整張圖。

    每一張都是完整圖高、白底，左右切在人與人之間的白色欄：
    與正面同一個高度，normalize() 之後三張的比例尺相同，換面時角色不會忽大忽小。
    """
    img = clean_sheet(_decode(png_b64))
    w = img.width
    figures = find_figures(img)
    if not figures:
        return None, 0

    def crop(i: int) -> str:
        x0, x1, _, _ = figures[i]
        left = max(0, x0 - PAD)
        right = min(w, x1 + PAD)
        # 不越過鄰居：切在兩人之間空白的中點
        if i > 0:
            left = max(left, (figures[i - 1][1] + x0) // 2)
        if i + 1 < len(figures):
            right = min(right, (x1 + figures[i + 1][0]) // 2)
        box = (left, 0, right, img.height)
        rgb = np.asarray(img.crop(box))
        # 被圍住的白縫先挖成透明：_remove_white_background 會把透明當成背景
        # 保留下來（它只從圖邊 flood fill，走不到被圍住的縫）
        gaps = _enclosed_gaps(rgb, side_view=(i == 1 and len(figures) == 3))
        rgba = np.dstack([rgb, np.where(gaps, 0, 255).astype(np.uint8)])
        return _encode(PILImage.fromarray(rgba, "RGBA"))

    if len(figures) != 3:
        return {"front": crop(0)}, len(figures)
    return {name: crop(i) for i, name in enumerate(VIEW_ORDER)}, 3


# ── 側面整個人朝左 ──
#
# 實測（2026-10-15）模型偶爾把側面整個畫成朝左（臉、領帶、鞋尖都朝左），
# 參考圖與素體明明都朝右。大螢幕假設側面朝右（往左走時才鏡像），朝左的側面
# 往右走時就是倒著走 —— 現場回報「頭是反的」。
#
# 看臉：頭那一段裡，膚色（臉）偏在哪一邊，人就朝哪邊；後腦勺是頭髮。只看頭
# 不看腳：鞋子畫反是另一件事（下面的 fix_backward_feet），兩者要分開判斷。
FACE_ZONE = 0.42          # 頭：最上面這麼高（以角色高為單位，2.2 頭身的下巴約 45%）
FACE_OFFSET = 0.06        # 臉的中心偏離頭的中心這麼多（頭寬的比例）才算朝哪邊
FACE_MIN_PIXELS = 0.02    # 頭那一段裡膚色少於這個比例（光頭戴帽、全被頭髮蓋住）就不判斷


SKIN_TOL = 60             # 與正面膚色的三通道差總和（臉上的陰影比基準暗一階）
# 量膚色的那一段（以角色高為單位）。要落在臉上，不管角色畫成幾頭身：2.2 頭身
# 的臉約 12%~45%，模型偶爾畫成 4 頭身時臉只到 25% 左右。原本取 20%~42%，
# 4 頭身的角色量到的是米色上衣（2026-10-16 實測），下巴整個找錯
SKIN_SAMPLE = (0.12, 0.30)


def _decode_rgba(png_b64: str) -> PILImage.Image:
    """去背後的圖要留著透明度（_decode 是給切圖前的白底整張圖用的，會轉成 RGB）。"""
    if "," in png_b64[:64]:
        png_b64 = png_b64.split(",", 1)[1]
    return PILImage.open(io.BytesIO(base64.b64decode(png_b64))).convert("RGBA")


def _skin_like(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    luma = r * 0.299 + g * 0.587 + b * 0.114
    return (r > g) & (g >= b) & (r - b >= 30) & (luma >= 80)


def skin_tone(front_b64: str) -> Optional[Tuple[int, int, int]]:
    """正面臉上最常見的膚色：頭那一段、中間三成寬，量化後的眾數。

    側面判朝向要用它，不能只靠「看起來像膚色」：淺金、棕色的頭髮也是紅多藍少，
    整顆頭都像臉，判不出朝向（實測亞麻金捲髮那張參考圖）。"""
    arr = np.asarray(_decode_rgba(front_b64)).astype(np.int16)
    solid = arr[..., 3] > 128
    rows = np.where(solid.any(axis=1))[0]
    cols = np.where(solid.any(axis=0))[0]
    if rows.size == 0:
        return None
    h = rows[-1] - rows[0] + 1
    w = cols[-1] - cols[0] + 1
    y0, y1 = rows[0] + int(h * SKIN_SAMPLE[0]), rows[0] + int(h * SKIN_SAMPLE[1])
    x0, x1 = cols[0] + int(w * 0.35), cols[0] + int(w * 0.65)
    patch = arr[y0:y1, x0:x1]
    r, g, b = patch[..., 0], patch[..., 1], patch[..., 2]
    mask = (patch[..., 3] > 128) & _skin_like(r, g, b)
    if mask.sum() < 20:
        return None
    keys = (r[mask] >> 4) * 256 + (g[mask] >> 4) * 16 + (b[mask] >> 4)
    best = np.bincount(keys).argmax()
    pick = keys == best
    return tuple(int(c[mask][pick].mean()) for c in (r, g, b))


def face_right(png_b64: str, skin: Optional[Tuple[int, int, int]] = None) -> Tuple[str, bool]:
    """側面朝左時整張左右鏡像成朝右。回傳 (圖, 有沒有鏡像)。

    skin：正面量到的膚色（skin_tone）。沒有時退回「看起來像膚色」，頭髮是淺色
    時可能判不出來 —— 判不出來就不動，不會反過來把朝右的翻成朝左。"""
    img = _decode_rgba(png_b64)
    arr = np.asarray(img).astype(np.int16)
    solid = arr[..., 3] > 128
    rows = np.where(solid.any(axis=1))[0]
    if rows.size == 0:
        return png_b64, False
    top, bottom = rows[0], rows[-1]
    head = slice(top, top + int((bottom - top + 1) * FACE_ZONE))
    band = solid[head]
    cols = np.where(band.any(axis=0))[0]
    if cols.size == 0:
        return png_b64, False
    r, g, b = arr[head, :, 0], arr[head, :, 1], arr[head, :, 2]
    face = band & _skin_like(r, g, b)
    if skin is not None:
        face &= (np.abs(r - skin[0]) + np.abs(g - skin[1]) + np.abs(b - skin[2])) <= SKIN_TOL
    if face.sum() < band.sum() * FACE_MIN_PIXELS:
        return png_b64, False
    width = cols[-1] - cols[0] + 1
    centre = (cols[0] + cols[-1]) / 2
    face_x = np.nonzero(face)[1].mean()
    if face_x >= centre - width * FACE_OFFSET:
        return png_b64, False
    return _encode(img.transpose(PILImage.FLIP_LEFT_RIGHT)), True


# ── 側面的鞋子畫反 ──
#
# 實測（2026-10-14）模型畫側面時偶爾把鞋子畫反：人朝右，靴子的鞋尖朝左、
# 鞋跟朝右。整張圖鏡像不行（臉也會跟著反），只把腳踝以下左右翻過來。
#
# 只處理兩腿在側面疊成一條的情況：小腿只有一段，鞋尖往哪邊伸一看就知道。
# 兩腿分開站時兩隻腳前後錯開，分不出哪一隻反了，不動。
FOOT_ZONE = 0.07          # 腳掌：最底下這麼高（以角色高為單位）
SHIN_ZONE = (0.08, 0.16)  # 小腿：從底往上這一段
ANKLE_WIDTH_RATIO = 1.25  # 比小腿寬這麼多倍就是腳掌了
TOE_MARGIN = 0.5          # 往後伸的比往前伸的多出這麼多個小腿寬，才算畫反


def fix_backward_feet(png_b64: str) -> Tuple[str, bool]:
    """側面（朝右）的鞋子若畫反就把腳踝以下左右翻過來。回傳 (圖, 有沒有翻)。"""
    img = PILImage.open(io.BytesIO(base64.b64decode(png_b64))).convert("RGBA")
    arr = np.asarray(img).copy()
    solid = arr[..., 3] > 128
    rows = np.nonzero(solid.any(axis=1))[0]
    if len(rows) == 0:
        return png_b64, False
    y0, y1 = int(rows[0]), int(rows[-1])
    h = y1 - y0 + 1

    def runs(y):
        xs = np.nonzero(solid[y])[0]
        if len(xs) == 0:
            return []
        cuts = np.nonzero(np.diff(xs) > 1)[0]
        starts = np.concatenate([[xs[0]], xs[cuts + 1]])
        ends = np.concatenate([xs[cuts], [xs[-1]]])
        return [(int(a), int(b)) for a, b in zip(starts, ends) if b - a + 1 > h * 0.01]

    centers, widths = [], []
    for y in range(y1 - int(h * SHIN_ZONE[1]), y1 - int(h * SHIN_ZONE[0])):
        rs = runs(y)
        if len(rs) != 1:
            return png_b64, False      # 兩腿分開（或有東西擋著），不判斷
        centers.append((rs[0][0] + rs[0][1]) / 2)
        widths.append(rs[0][1] - rs[0][0] + 1)
    if not centers:
        return png_b64, False
    cx = float(np.median(centers))
    shin = float(np.median(widths))

    # 腳踝：從小腿往下，第一列明顯變寬的
    ankle = y1 - int(h * FOOT_ZONE)
    for y in range(y1 - int(h * SHIN_ZONE[0]), y1 + 1):
        rs = runs(y)
        if rs and max(b - a + 1 for a, b in rs) > shin * ANKLE_WIDTH_RATIO:
            ankle = y
            break
    feet = solid[ankle:y1 + 1]
    xs = np.nonzero(feet.any(axis=0))[0]
    back = cx - xs[0]     # 往後（左）伸多遠
    front = xs[-1] - cx   # 往前（右）伸多遠
    if back - front <= shin * TOE_MARGIN:
        return png_b64, False

    # 以小腿中線為軸翻轉腳踝以下；翻過去的鞋尖可能超出右邊界，先把圖加寬
    reach = int(np.ceil(max(back, front))) + 2
    need = int(np.ceil(cx + reach)) + 1 - arr.shape[1]
    if need > 0:
        arr = np.concatenate([arr, np.zeros((arr.shape[0], need, 4), dtype=arr.dtype)], axis=1)
    x_lo = max(0, int(np.floor(cx - reach)))
    x_hi = min(arr.shape[1] - 1, int(np.ceil(cx + reach)))
    band = arr[ankle:y1 + 1].copy()
    out = arr[ankle:y1 + 1]
    out[:, x_lo:x_hi + 1] = 0
    for x in range(x_lo, x_hi + 1):
        src = int(round(2 * cx - x))
        if 0 <= src < band.shape[1]:
            out[:, x] = band[:, src]
    buf = io.BytesIO()
    PILImage.fromarray(arr, "RGBA").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii"), True


# ── 壓回素體的頭身比 ──
#
# 素體、參考圖、prompt 三邊都說 2.2 頭身，模型還是常照真人照片的比例畫：同一批
# 角色下巴落在身高的 28%~42%（2026-10-16 量最近幾十個），站在一起個頭不一。
# 樂高、皮克斯沒有這問題，那兩種「物種」的身體模型早就背熟了；Q 版像素沒有
# 標準身材，生成這一步保證不了。現場 30 人同時生成、不重生，所以在這裡收：
# 頭不動，下巴以下整段垂直縮放，讓下巴落在素體的位置 —— 每個人都是同一個物種，
# 不看真人比例。只縮垂直：左右也縮的話長髮在下巴那一列會斷一截。
#
# 以後若做矮／中／高三種素體，換 target 就好（各量自己的素體）。
BASE_BODY_CHIN = 0.42      # 素體正面的下巴（以角色高為單位），用 chin_fraction 量的
SQUASH_RANGE = (0.5, 1.3)  # 縮放倍率上下限：再扁就是一團（下巴 0.2 的那種只收一部分）
SQUASH_MIN_CHANGE = 0.04   # 差不到這麼多就不動，省得每張都被重新取樣
FACE_NARROW = 0.6          # 臉的寬掉到最寬的這個比例以下，就是下巴以下（脖子）
FACE_GAP_CELLS = 1.5       # 比這短的窄段是眉毛、眼睛把臉切開，不是脖子


def chin_fraction(front_b64: str, skin: Optional[Tuple[int, int, int]] = None) -> Optional[float]:
    """正面的下巴在身高的哪裡（0 = 頭頂，1 = 鞋底）。量不到（臉被遮住、沒有膚色）回傳 None。

    臉 = 頭那一段裡最大一塊膚色。從它最寬的那列往下，左右跨度持續窄掉的地方就是
    下巴。用跨度不用格數：眼睛、眉毛在臉中間，格數會掉，跨度不會。"""
    import cv2

    arr = np.asarray(_decode_rgba(front_b64)).astype(np.int16)
    solid = arr[..., 3] > 128
    rows = np.where(solid.any(axis=1))[0]
    if rows.size == 0:
        return None
    top, bottom = int(rows[0]), int(rows[-1])
    h = bottom - top + 1
    if skin is None:
        skin = skin_tone(front_b64)
    if skin is None:
        return None
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    face = solid & _skin_like(r, g, b)
    face &= (np.abs(r - skin[0]) + np.abs(g - skin[1]) + np.abs(b - skin[2])) <= SKIN_TOL
    count, labels, stats, _ = cv2.connectedComponentsWithStats(face.astype(np.uint8), connectivity=4)
    head_end = top + int(h * 0.6)
    best = max(
        (i for i in range(1, count) if stats[i, cv2.CC_STAT_TOP] < head_end),
        key=lambda i: stats[i, cv2.CC_STAT_AREA], default=0,
    )
    if not best:
        return None
    comp = labels == best
    comp_rows = np.where(comp.any(axis=1))[0]
    y0, y1 = int(comp_rows[0]), int(comp_rows[-1])
    span = np.zeros(arr.shape[0])
    for y in range(y0, y1 + 1):
        xs = np.nonzero(comp[y])[0]
        if xs.size:
            span[y] = xs[-1] - xs[0] + 1
    widest = y0 + int(np.argmax(span[y0:y1 + 1]))
    narrow = span < span[widest] * FACE_NARROW
    gap = max(2, int(h / CELLS_PER_FIGURE * FACE_GAP_CELLS))
    y = widest
    while y <= y1:
        # 窄下去之後一直窄到臉的底，或窄了夠長一段：那就是脖子
        if narrow[y] and (narrow[y:y1 + 1].all() or narrow[y:min(y + gap, y1 + 1)].all()):
            break
        y += 1
    return (y - top) / h


def squash_below(png_b64: str, chin: float, scale: float) -> str:
    """下巴（以角色高為單位）以上不動，以下整段垂直縮放 scale 倍（最近鄰，像素格不糊）。"""
    arr = np.asarray(_decode_rgba(png_b64))
    rows = np.where((arr[..., 3] > 0).any(axis=1))[0]
    if rows.size == 0:
        return png_b64
    top, bottom = int(rows[0]), int(rows[-1])
    cut = top + int(round(chin * (bottom - top + 1)))
    body = arr[cut:bottom + 1]
    new_h = max(1, int(round(body.shape[0] * scale)))
    pick = np.minimum((np.arange(new_h) / scale).astype(int), body.shape[0] - 1)
    out = np.concatenate([arr[:cut], body[pick]], axis=0)
    return _encode(PILImage.fromarray(np.ascontiguousarray(out), "RGBA"))


def fit_base_body(
    views: dict, skin: Optional[Tuple[int, int, int]] = None, target: float = BASE_BODY_CHIN,
) -> Tuple[dict, Optional[float]]:
    """把三視圖（{"front", "side", "back"}，去背後）壓回素體的頭身比。

    回傳 (views, 縮放倍率)；量不到下巴或差不多時倍率為 None、圖不動。三面用正面
    量到的同一個下巴位置與倍率：三面同一次生成、同一個比例尺，分開量的話背面
    沒有臉，側面的臉只有半張。"""
    chin = chin_fraction(views["front"], skin)
    if chin is None or not 0 < chin < 1:
        return views, None
    scale = chin * (1 - target) / (target * (1 - chin))
    scale = min(max(scale, SQUASH_RANGE[0]), SQUASH_RANGE[1])
    if abs(scale - 1) < SQUASH_MIN_CHANGE:
        return views, None
    return {name: squash_below(png, chin, scale) for name, png in views.items()}, scale
