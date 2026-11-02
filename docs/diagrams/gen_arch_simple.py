"""產生專題架構圖 SVG（風格比照使用者提供的參考圖）。"""
import sys

W, H = 2175, 1800
K = (2135 - 40) / (1670 - 40)
FS = 1.08
X = lambda x: 40 + (x - 40) * K
INK = "#3a3f47"
TXT = "#1d2229"
SUB = "#4a4f57"
RED = "#c2410c"
GREEN = "#2e8b3e"
PURPLE = "#5b2bb5"
GRAY = "#7a8088"
FONT = "'Noto Sans TC','Microsoft JhengHei',sans-serif"

out = []
add = out.append


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, size=21, color=SUB, weight=400, anchor="middle"):
    x = X(x); size = round(size * FS, 1)
    add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" '
        f'text-anchor="{anchor}">{esc(s)}</text>')


def panel(y0, y1, title, x0=40, x1=1670):
    tx = x0
    x0, x1 = X(x0), X(x1)
    add(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" rx="20" fill="#f4f6f8" '
        f'stroke="#dde1e6" stroke-width="2.5"/>')
    letter, name = title
    text(tx + 35, y0 + 58, letter, 36, "#24364b", 700, "start")
    text(tx + 95, y0 + 58, name, 36, "#24364b", 700, "start")


def box(x, y, w, h, title, subs=(), fill="#ffffff", stroke=INK, dash=None, sw=2.6):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{X(x)}" y="{y}" width="{w*K}" height="{h}" rx="12" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="{sw}"{d}/>')
    cx = x + w / 2
    n = len(subs)
    # 標題與副標垂直置中
    block = 34 + n * 34
    ty = y + (h - block) / 2 + 28
    text(cx, ty, title, 29, TXT, 700)
    for i, s in enumerate(subs):
        text(cx, ty + 38 + i * 33, s, 21, SUB, 400)


def chip(cx, cy, s, filled=False):
    w = len(s) * 20 + sum(1 for ch in s if ord(ch) < 128) * -8 + 36
    fill, fg = (PURPLE, "#fff") if filled else ("#ffffff", PURPLE)
    add(f'<rect x="{cx-w/2}" y="{cy-17}" width="{w}" height="34" rx="17" fill="{fill}" '
        f'stroke="{PURPLE}" stroke-width="2.4"/>')
    text(cx, cy + 7, s, 19, fg, 700)


def line(pts, color=INK, dash=None, arrow=True, sw=2.6):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    m = {INK: "a", RED: "r", GREEN: "g", GRAY: "k"}[color]
    mk = f' marker-end="url(#m{m})"' if arrow else ""
    p = " ".join(f"{X(x)},{y}" for x, y in pts)
    add(f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{sw}"{d}{mk}/>')


add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
    f'font-family="{FONT}">')
add("<defs>")
for k, c in (("a", INK), ("r", RED), ("g", GREEN), ("k", GRAY)):
    add(f'<marker id="m{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>')
add("</defs>")
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
add('<g transform="translate(0,17)">')


# ── A 實體穿著 → 數位角色 ──────────────────────────────────
panel(40, 630, ("A", "實體穿著 → 數位角色"))
cs = [(72, "手機拍照", "站位引導・自動快門"),
      (396, "視覺特徵擷取", "骨架・服裝色・臉部"),
      (720, "風格化生成", "生圖模型＋風格參考"),
      (1044, "品質驗證", "缺腿・出框・色偏"),
      (1368, "切片成貼圖", "頭・身・腿三段")]
for i, (x, t, s) in enumerate(cs):
    fill, stroke = ("#e3f2ee", "#2f7d65") if i == 2 else ("#ffffff", INK)
    box(x, 150, 270, 110, t, [s], fill=fill, stroke=stroke)
    if i < 4:
        line([(x + 270, 205), (x + 322, 205)])
line([(1179, 260), (1179, 328)], RED, "8 6")
text(1194, 302, "未通過", 22, RED, 700, "start")
box(900, 330, 560, 95, "帶修正指令重生", ["依失敗類型改寫生成指令"], fill="#fdf1e6", stroke=RED, dash="9 6")
line([(900, 377), (855, 377), (855, 263)], RED, "8 6")
line([(1179, 425), (1179, 470), (603, 470)], GRAY, "6 6")
text(890, 460, "仍未通過", 21, "#555")
line([(207, 260), (207, 418)], RED, "8 6")
text(222, 345, "相機被拒", 22, RED, 700, "start")
box(72, 420, 528, 100, "捏臉備援", ["人人都能進場的降級路徑"])
text(650, 560, "降級設計：任何一步失敗都退回捏臉，不讓參與者被擋在門外", 21, "#555", 400, "start")
line([(336, 520), (336, 598), (1503, 598)], GREEN, arrow=False, sw=3)
text(1518, 330, "通過", 23, GREEN, 700, "start")

# ── B 雙層半自主共治 ──────────────────────────────────────
panel(660, 1140, ("B", "雙層半自主共治"))
line([(1503, 260), (1503, 768)], GREEN, sw=3)
text(1518, 742, "角色進場", 23, GREEN, 700, "start")
box(72, 770, 380, 130, "手機控制器", ["搖桿操控", "任務與問答"])
box(540, 770, 580, 130, "α 半自主共治仲裁", ["V = (1−α)·V群體 + α·V手動", "有人操控即接手，放手後平滑交還"],
    fill="#e3f2ee", stroke="#2f7d65")
box(1208, 770, 402, 130, "大螢幕公共畫布", ["3D 場景・像素角色", "全體參與者共享"])
line([(452, 835), (538, 835)])
text(495, 822, "操控", 20, "#333")
line([(1120, 835), (1206, 835)])
text(1163, 822, "速度", 20, "#333")
box(600, 990, 460, 110, "Boids 群體演算法", ["分離・對齊・凝聚・避障"])
line([(830, 990), (830, 902)])
text(845, 952, "群體向量", 20, "#333", 400, "start")

# ── C 社交任務與集體記憶 ──────────────────────────────────
panel(1170, 1680, ("C", "社交任務與集體記憶"))
games = [(72, "配對任務", "口頭索取對方配對碼"),
         (431, "即時問答", "全場同步作答"),
         (790, "先知尋寶", "只有一人看得到線索")]
for x, t, s in games:
    box(x, 1280, 330, 110, t, [s])
    line([(x + 165, 1390), (x + 165, 1430)], arrow=False)
line([(237, 1430), (1409, 1430), (1409, 1393)])
text(1265, 1420, "實體接觸", 20, "#333")
box(1208, 1280, 402, 110, "社交圖譜", ["每條邊＝一次面對面互動"])
line([(1409, 1280), (1409, 1045), (1062, 1045)], INK, "7 5")
text(1235, 1033, "認識的人傾向聚集", 20, "#333")
text(75, 1478, "設計原則：每個任務的通關路徑上，至少一步必須跟另一個人講話", 21, "#555", 400, "start")
ps = [(72, "主辦觸發合照", "活動收尾"),
      (460, "角色定位", "原地定住、面向鏡頭"),
      (848, "大合照合成", "依場上實際位置排版")]
for x, t, s in ps:
    box(x, 1530, 330, 110, t, [s])
    line([(x + 330, 1585), (x + 386, 1585)])
box(1236, 1530, 374, 110, "集體記憶大合照", ["QR Code 帶回家"], fill="#e7f5e9", stroke=GREEN, sw=3)

# ── 圖例 ──────────────────────────────────────────────────
add(f'<rect x="{X(72)}" y="1710" width="52" height="30" rx="7" fill="#e3f2ee" stroke="#2f7d65" stroke-width="2.4"/>')
text(138, 1733, "青底＝核心機制", 22, "#2f5d50", 700, "start")
line([(470, 1725), (526, 1725)], RED, "8 6", arrow=False, sw=3)
text(540, 1733, "紅虛線＝失敗與降級", 22, RED, 700, "start")
line([(860, 1725), (916, 1725)], GREEN, arrow=False, sw=3)
text(930, 1733, "綠線＝通過與進場", 22, GREEN, 700, "start")

add("</g>")
add("</svg>")
with open(sys.argv[1], "w", encoding="utf-8") as f:
    f.write("\n".join(out))
