"""產生專題架構圖 SVG（風格比照使用者提供的參考圖）。"""
import sys

W, H = 1800, 2960
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
    add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" '
        f'text-anchor="{anchor}">{esc(s)}</text>')


def panel(y0, y1, title, x0=40, x1=1670):
    add(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" rx="20" fill="#f4f6f8" '
        f'stroke="#dde1e6" stroke-width="2.5"/>')
    letter, name = title
    text(x0 + 35, y0 + 58, letter, 36, "#24364b", 700, "start")
    text(x0 + 95, y0 + 58, name, 36, "#24364b", 700, "start")


def box(x, y, w, h, title, subs=(), fill="#ffffff", stroke=INK, dash=None, sw=2.6):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" '
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
    p = " ".join(f"{x},{y}" for x, y in pts)
    add(f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{sw}"{d}{mk}/>')


add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
    f'font-family="{FONT}">')
add("<defs>")
for k, c in (("a", INK), ("r", RED), ("g", GREEN), ("k", GRAY)):
    add(f'<marker id="m{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>')
add("</defs>")
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')

# ── A 輸入與路由 ───────────────────────────────────────────
panel(40, 430, ("A", "輸入與路由"))
box(72, 185, 275, 110, "參與者手機", ["拍照・選角色風格"])
add('<polygon points="445,240 600,150 755,240 600,330" fill="#fff" stroke="#3a3f47" stroke-width="2.6"/>')
text(600, 250, "進場路由", 30, TXT, 700)
line([(347, 240), (443, 240)])
box(1020, 95, 545, 105, "捏臉（備援）", ["不呼叫生成服務，像素角色四方向 × 三格步態"])
chip(1430, 95, "不可移除的備援路徑")
box(1020, 280, 545, 105, "站位引導", ["/preview 跨影格判定，站穩了才按快門"])
line([(707, 212), (765, 147), (1018, 147)])
text(890, 130, "相機被拒／服務未啟動", 21, "#333")
line([(707, 268), (765, 332), (1018, 332)])
text(890, 315, "相機可用", 21, "#333")
# 生成失敗退回捏臉
line([(1505, 280), (1505, 203)], RED, "8 6")
text(1490, 250, "生成失敗 → 帶取樣色退回捏臉", 22, RED, 700, "end")
# 直接進場（綠色旁路）
line([(1565, 147), (1745, 147), (1745, 1660), (1603, 1660)], GREEN, sw=3)
text(1580, 132, "直接進場", 23, GREEN, 700, "start")

# ── B 角色資產生成 ─────────────────────────────────────────
panel(460, 1000, ("B", "角色資產生成（backend/service.py）"))
line([(1292, 385), (1292, 555)], arrow=False)
line([(315, 555), (1395, 555)], arrow=False)
for cx in (315, 855, 1395):
    line([(cx, 555), (cx, 588)])
text(1120, 545, "平行執行", 21, "#333")
box(100, 590, 430, 145, "CV 特徵擷取", ["MediaPipe 骨架、臉部與服裝取樣色", "身高分級・部位區域"],
    fill="#ffffff")
box(640, 590, 430, 145, "VLM 語意辨識", ["Gemini 判讀服裝款式與髮型", "生圖已看過原圖，預設關閉"],
    dash="9 6")
chip(970, 590, "模型名不可寫死")
box(1180, 590, 430, 145, "風格註冊表", ["prompt・negative・姿勢參考・策展圖集", "選單由 /health 提供，不寫死"])
chip(1470, 590, "四件不可跨風格共用")
for cx, lab in ((315, "部位區域與取樣色"), (855, "語意欄位"), (1395, "風格四件套")):
    line([(cx, 735), (cx, 828)])
    text(cx + 14, 790, lab, 21, "#333", 400, "start")
box(100, 830, 1510, 100, "Prompt 組裝", ["原始照片＋部位裁切＋屬性文字＋風格參考圖"])
chip(1420, 830, "像素格數三方一致（90 格）")
text(75, 975, "CV 失敗不擋人：抓不到骨架退回中央預設框，抓不到顏色退回預設色", 21, "#555", 400, "start")

# ── C 生圖、驗證與切片 ─────────────────────────────────────
panel(1030, 1560, ("C", "生圖、驗證與切片"))
line([(855, 930), (855, 1120), (207, 1120), (207, 1158)])
cs = [(72, "去背人偶生圖", "生圖 API・熔斷器保護"),
      (396, "去背與補白", "去白底、刪離散雜點"),
      (720, "結構驗證", "缺腿、出框、顏色偏離"),
      (1044, "切片", "head・torso・legs＋full"),
      (1368, "貼圖落地", "public/assets/gen")]
for i, (x, t, s) in enumerate(cs):
    fill, stroke = ("#e3f2ee", "#2f7d65") if i == 0 else ("#ffffff", INK)
    box(x, 1160, 270, 110, t, [s], fill=fill, stroke=stroke)
    if i < 4:
        line([(x + 270, 1215), (x + 322, 1215)])
chip(1179, 1160, "CUTS ≡ CV_CUTS")
chip(1503, 1160, "走 URL，不走 base64")
line([(855, 1270), (855, 1368)], RED, "8 6")
text(872, 1330, "未通過", 22, RED, 700, "start")
box(605, 1370, 500, 100, "帶修正指令重生", ["缺腿 → 要求雙腿完整；出框 → 置中留白"],
    fill="#fdf1e6", stroke=RED, dash="9 6")
line([(605, 1420), (207, 1420), (207, 1273)], RED, "8 6")
text(405, 1407, "下一次", 22, RED, 700)
line([(1105, 1420), (1250, 1420), (1250, 1598)], GRAY, "6 6")
text(1266, 1462, "仍未通過：", 21, "#555", 400, "start")
text(1266, 1490, "帶取樣色退回捏臉", 21, "#555", 400, "start")
line([(1503, 1270), (1503, 1598)], GREEN, sw=3)
text(1520, 1360, "通過", 23, GREEN, 700, "start")
text(75, 1530, "重生上限 0–1 次（預設 0）：生圖是全系統唯一花錢的呼叫。每次嘗試都寫入 SQLite 生成帳本", 21,
     "#555", 400, "start")

# ── 圖例 + 角色進場 ────────────────────────────────────────
add('<rect x="72" y="1608" width="52" height="30" rx="7" fill="#e3f2ee" stroke="#2f7d65" stroke-width="2.4"/>')
text(138, 1631, "青底＝核心機制", 22, PURPLE if False else "#2f5d50", 700, "start")
add(f'<rect x="72" y="1672" width="52" height="30" rx="15" fill="#fff" stroke="{PURPLE}" stroke-width="2.4"/>')
text(138, 1695, "紫框＝關鍵約束（違反時不報錯）", 22, PURPLE, 700, "start")
line([(500, 1623), (556, 1623)], RED, "8 6", arrow=False, sw=3)
text(570, 1631, "紅虛線＝失敗與重生", 22, RED, 700, "start")
line([(500, 1687), (556, 1687)], GREEN, arrow=False, sw=3)
text(570, 1695, "綠線＝通過／直接進場", 22, GREEN, 700, "start")
box(905, 1600, 695, 120, "角色進場", ["CLIENT_JOIN 驗證外觀・名冊廣播", "同場上限 30 人"])

# ── D 互動層 ──────────────────────────────────────────────
panel(1760, 2400, ("D", "互動層（server/・Node.js + ws）"))
line([(1252, 1720), (1252, 1848)])
text(1266, 1800, "名冊", 21, "#333", 400, "start")
box(72, 1850, 320, 120, "手機搖桿", ["首幀立即送出", "之後 20 Hz 節流"])
box(470, 1850, 580, 120, "α 仲裁共治", ["V = (1−α)·V_Boids + α·V_Manual", "接手 0.3 s 線性・放手 1.2 s 餘弦"],
    fill="#e3f2ee", stroke="#2f7d65")
box(1128, 1850, 482, 120, "場域狀態與主迴圈", ["30 Hz tick，STAGE_SYNC 只送座標", "名冊只在成員變動時廣播"])
line([(392, 1910), (468, 1910)])
text(431, 1898, "20 Hz", 19, "#333")
line([(1050, 1910), (1126, 1910)])
text(1089, 1898, "V_final", 19, "#333")
box(72, 2030, 368, 120, "社交圖譜", ["每條邊＝雙方確認的", "實體接觸"])
box(560, 2030, 400, 120, "Boids 群聚", ["分離・對齊・凝聚・避障"])
box(1128, 2030, 482, 120, "積分帳本", ["跨玩法累計，單一寫入點"])
line([(760, 2030), (760, 1972)])
text(775, 2010, "V_Boids", 19, "#333", 400, "start")
line([(440, 2090), (558, 2090)], INK, "7 5")
text(499, 2078, "凝聚偏置", 19, "#333")
games = [(72, "配對／COLOR_HUNT", ["口頭索取 4 位碼，對方確認"]),
         (461, "即時問答", ["正解不離開伺服器"]),
         (850, "尋寶（先知模式）", ["只有先知看得到冷熱"]),
         (1239, "轉場問卷", ["沒有正解，答案留成標籤"])]
for x, t, s in games:
    box(x, 2215, 369, 110, t, s)
line([(256, 2215), (256, 2152)])
line([(380, 2215), (380, 2182), (1369, 2182), (1369, 2152)])
for cx in (645, 1034):
    line([(cx, 2215), (cx, 2182)], arrow=False)
text(1200, 2176, "得分", 19, "#333")
text(75, 2372, "新玩法先問：通關路徑上有沒有一步必須跟另一個人講話？沒有的話會讓現場更安靜", 21, "#555", 400,
     "start")

# ── E 三端呈現與大合照 ─────────────────────────────────────
panel(2430, 2930, ("E", "三端呈現與大合照（public/）"))
line([(1610, 1910), (1645, 1910), (1645, 2505), (317, 2505)], arrow=False)
for cx, lab in ((317, "STAGE_SYNC 30 Hz"), (841, "CLIENT_SYNC 15 Hz"), (1365, "主辦端狀態")):
    line([(cx, 2505), (cx, 2538)])
    text(cx + 12, 2530, lab, 19, "#333", 400, "start")
box(72, 2540, 490, 120, "大螢幕", ["Three.js 3D 房間＋2D 像素主題", "新進場者頭頂箭頭 6 秒"])
box(596, 2540, 490, 120, "手機個人視角", ["自己與鄰居的相對座標", "不自行模擬，以伺服器 α 為準"])
box(1120, 2540, 490, 120, "主辦端控制台", ["出題、發任務、觸發合照", "生成歷史、token 與花費"])
line([(1365, 2660), (1365, 2697), (232, 2697), (232, 2733)])
text(1250, 2689, "觸發合照", 19, "#333")
ps = [(72, "鎖場定位", ["STAGED：定住、面向鏡頭"]),
      (452, "截取底圖", ["大螢幕當下畫面"]),
      (832, "大合照合成", ["依場上實際座標排版"])]
for x, t, s in ps:
    box(x, 2735, 320, 125, t, s)
    line([(x + 320, 2797), (x + 378, 2797)])
chip(232, 2860, "成敗都必須解鎖場域")
box(1212, 2735, 398, 125, "輸出大合照", ["合照 PNG ＋ QR Code 下載"], fill="#e7f5e9", stroke=GREEN, sw=3)
text(75, 2912, "截圖拿不到則由 Python 自繪舞台；捏臉角色沒有生成圖，由 photo_composer 程式化繪製", 21, "#555",
     400, "start")

add("</svg>")
with open(sys.argv[1], "w", encoding="utf-8") as f:
    f.write("\n".join(out))
