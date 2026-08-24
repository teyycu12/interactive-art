"""
大合照排版與合成引擎 (Photo Composer - M6 核心模組)。

負責接收現場在場所有角色的外觀特徵向量，進行智慧階梯式排版、
色彩平衡配置，並使用純 Python (Pillow) 無頭合成高解析度紀念合照 (PNG) 與 QR Code。
"""

import base64
import io
import math
import os
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    load_dotenv()
except ImportError:
    pass

try:
    import requests as _requests
except ImportError:
    _requests = None  # type: ignore

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None  # type: ignore
    ImageDraw = None  # type: ignore
    ImageFont = None  # type: ignore

try:
    import qrcode  # type: ignore
except ImportError:
    qrcode = None  # type: ignore


# --- 中文字型解析 ---
# Pillow 的預設點陣字型沒有中日韓字符，draw.text() 不指定 font 時，合照上的
# 中文標題、時間資訊與 QR 說明文字會全部變成豆腐框（□□□）。合照是賓客掃碼
# 帶回家的最終成品，文字不可讀等於這個功能沒做完，因此在此建立字型後備鏈。
_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",                      # macOS 現代預設
    "/System/Library/Fonts/STHeiti Medium.ttc",                # macOS 後備
    "/System/Library/Fonts/Hiragino Sans GB.ttc",              # macOS 後備
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",  # Debian/Ubuntu
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",            # 常見於精簡容器
    "C:\\Windows\\Fonts\\msjh.ttc",                          # Windows 微軟正黑
]
_font_cache: Dict[int, Any] = {}


def _cjk_font(size: int):
    """取得可顯示中文的字型；找不到時退回預設字型（會是豆腐框，但不會崩潰）。"""
    if ImageFont is None:
        return None
    if size in _font_cache:
        return _font_cache[size]

    font = None
    for path in _FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            font = ImageFont.truetype(path, size)
            break
        except Exception:
            continue

    if font is None:
        print("[photo_composer] 找不到中文字型，合照文字將顯示為豆腐框。"
              "Linux 請安裝 fonts-noto-cjk。")
        try:
            font = ImageFont.load_default()
        except Exception:
            return None

    _font_cache[size] = font
    return font


def _hex_to_rgb(hex_str: Optional[str], default: Tuple[int, int, int] = (200, 200, 200)) -> Tuple[int, int, int]:
    """將 Hex 顏色字串轉為 RGB tuple。"""
    if not hex_str or not isinstance(hex_str, str):
        return default
    s = hex_str.lstrip("#")
    if len(s) == 3:
        s = "".join([c * 2 for c in s])
    if len(s) != 6:
        return default
    try:
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except ValueError:
        return default


def _draw_lego_character(
    char: Dict[str, Any],
    target_height: int = 240,
) -> Optional[Any]:
    """
    無頭繪製單隻 LEGO 風格角色影像（含透明背景）。
    若有 body_png 則優先使用並縮放；否則程式化繪製樂高頭部、身體、雙腿與五官。
    """
    if Image is None or ImageDraw is None:
        return None

    width = int(target_height * 0.65)
    char_img = Image.new("RGBA", (width, target_height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(char_img)


    # 1. 優先嘗試載入 AI 生成的 body_png
    body_b64 = char.get("body_png")
    if body_b64 and isinstance(body_b64, str):
        try:
            raw = body_b64.split(",")[1] if body_b64.startswith("data:image") else body_b64
            img_data = base64.b64decode(raw)
            with Image.open(io.BytesIO(img_data)) as pil_body:
                pil_body = pil_body.convert("RGBA")
                pil_body.thumbnail((width, target_height), Image.Resampling.LANCZOS)
                paste_x = (width - pil_body.width) // 2
                paste_y = (target_height - pil_body.height) // 2
                char_img.paste(pil_body, (paste_x, paste_y), pil_body)
                return char_img
        except Exception as e:
            print(f"[photo_composer] Failed to decode body_png, falling back to programmatic drawing: {e}")

    # 2. 程式化繪製標準 LEGO 人偶
    # 這些欄位在上游分析失敗時會是 None（鍵存在但值為 null），
    # 因此不能只靠 dict.get 的預設值，必須顯式正規化為空字典。
    outfit = char.get("outfit") or {}
    face = char.get("face") or {}
    upper = char.get("upper") or {}
    lower = char.get("lower") or {}

    top_color = _hex_to_rgb(outfit.get("inner_color") or upper.get("hex"), (220, 60, 60))
    bot_color = _hex_to_rgb(outfit.get("lower_color") or lower.get("hex"), (50, 70, 150))
    skin_color = _hex_to_rgb(face.get("skin_tone"), (254, 219, 0))  # 經典 LEGO 黃色或膚色
    hair_color = _hex_to_rgb(face.get("hair_color"), (60, 40, 20))

    cx = width // 2
    scale = target_height / 240.0

    # 陰影
    shadow_w = int(60 * scale)
    shadow_h = int(14 * scale)
    draw.ellipse(
        [cx - shadow_w // 2, target_height - shadow_h - 2, cx + shadow_w // 2, target_height - 2],
        fill=(0, 0, 0, 80),
    )

    # 雙腿 (Pants / Legs)
    leg_top = int(140 * scale)
    leg_w = int(22 * scale)
    leg_h = int(75 * scale)
    gap = int(4 * scale)
    # 左腿
    draw.rounded_rectangle(
        [cx - leg_w - gap // 2, leg_top, cx - gap // 2, leg_top + leg_h],
        radius=int(4 * scale),
        fill=bot_color,
        outline=(30, 30, 30, 200),
        width=int(2 * scale),
    )
    # 右腿
    draw.rounded_rectangle(
        [cx + gap // 2, leg_top, cx + leg_w + gap // 2, leg_top + leg_h],
        radius=int(4 * scale),
        fill=bot_color,
        outline=(30, 30, 30, 200),
        width=int(2 * scale),
    )
    # 髖部接合帶
    hip_h = int(15 * scale)
    draw.rounded_rectangle(
        [cx - leg_w - gap // 2, leg_top, cx + leg_w + gap // 2, leg_top + hip_h],
        radius=int(3 * scale),
        fill=bot_color,
        outline=(30, 30, 30, 200),
        width=int(2 * scale),
    )

    # 身體 (Torso) - 梯形
    torso_top = int(75 * scale)
    torso_bot = int(140 * scale)
    torso_top_w = int(24 * scale)
    torso_bot_w = int(28 * scale)
    torso_poly = [
        (cx - torso_top_w, torso_top),
        (cx + torso_top_w, torso_top),
        (cx + torso_bot_w, torso_bot),
        (cx - torso_bot_w, torso_bot),
    ]
    draw.polygon(torso_poly, fill=top_color, outline=(30, 30, 30, 200))

    # 手臂與手部 (Arms & Hands)
    arm_w = int(10 * scale)
    # 左手臂
    draw.line(
        [(cx - torso_top_w, torso_top + int(8 * scale)), (cx - torso_bot_w - int(12 * scale), torso_bot - int(10 * scale))],
        fill=top_color,
        width=arm_w,
    )
    # 左手掌 (LEGO 鉤手)
    hand_y = torso_bot - int(10 * scale)
    draw.ellipse(
        [cx - torso_bot_w - int(20 * scale), hand_y - int(6 * scale), cx - torso_bot_w - int(8 * scale), hand_y + int(6 * scale)],
        fill=skin_color,
        outline=(30, 30, 30, 200),
    )

    # 右手臂（打招呼揮手姿態或自然垂放）
    draw.line(
        [(cx + torso_top_w, torso_top + int(8 * scale)), (cx + torso_bot_w + int(14 * scale), torso_top + int(20 * scale))],
        fill=top_color,
        width=arm_w,
    )
    draw.ellipse(
        [cx + torso_bot_w + int(8 * scale), torso_top + int(14 * scale), cx + torso_bot_w + int(20 * scale), torso_top + int(26 * scale)],
        fill=skin_color,
        outline=(30, 30, 30, 200),
    )

    # 頭部 (Head) - 圓柱圓角方塊
    head_top = int(28 * scale)
    head_w = int(21 * scale)
    head_h = int(42 * scale)
    draw.rounded_rectangle(
        [cx - head_w, head_top, cx + head_w, head_top + head_h],
        radius=int(6 * scale),
        fill=skin_color,
        outline=(30, 30, 30, 200),
        width=int(2 * scale),
    )

    # 頭頂小凸起 (Stud)
    stud_w = int(10 * scale)
    stud_h = int(6 * scale)
    draw.rectangle(
        [cx - stud_w, head_top - stud_h + 1, cx + stud_w, head_top + 1],
        fill=skin_color,
        outline=(30, 30, 30, 200),
    )

    # 髮型 (Hair)
    hair_top = head_top - int(3 * scale)
    draw.rounded_rectangle(
        [cx - head_w - int(2 * scale), hair_top, cx + head_w + int(2 * scale), hair_top + int(16 * scale)],
        radius=int(6 * scale),
        fill=hair_color,
        outline=(20, 20, 20, 200),
    )

    # 五官 (Eyes & Smile)
    eye_y = head_top + int(18 * scale)
    eye_r = int(2.5 * scale)
    draw.ellipse([cx - int(8 * scale) - eye_r, eye_y - eye_r, cx - int(8 * scale) + eye_r, eye_y + eye_r], fill=(30, 30, 30))
    draw.ellipse([cx + int(8 * scale) - eye_r, eye_y - eye_r, cx + int(8 * scale) + eye_r, eye_y + eye_r], fill=(30, 30, 30))

    # 微笑
    smile_box = [cx - int(7 * scale), eye_y + int(3 * scale), cx + int(7 * scale), eye_y + int(13 * scale)]
    draw.arc(smile_box, start=20, end=160, fill=(30, 30, 30), width=int(2 * scale))

    return char_img


def _create_qr_image(url: str, size: int = 160) -> Image.Image:
    """生成 QR Code 圖片，若未安裝 qrcode 套件則產生簡潔標籤圖片。"""
    if qrcode is not None:
        try:
            qr = qrcode.QRCode(
                version=1,
                error_correction=qrcode.constants.ERROR_CORRECT_M,
                box_size=4,
                border=2,
            )
            qr.add_data(url)
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            return img.resize((size, size), Image.Resampling.NEAREST)
        except Exception as e:
            print(f"[photo_composer] QR code generation failed: {e}")

    # Fallback badge
    badge = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(badge)
    draw.rectangle([2, 2, size - 3, size - 3], outline=(60, 60, 60), width=2)
    draw.text((10, size // 2 - 10), "Scan for Photo", fill=(0, 0, 0), font=_cjk_font(14))
    return badge


def _upload_imgbb(image_bytes: bytes, name: str = "personaflow") -> Optional[str]:
    """上傳至 ImgBB（免費圖床）。需要 IMGBB_API_KEY 環境變數。"""
    api_key = os.environ.get("IMGBB_API_KEY", "").strip()
    if not api_key or _requests is None:
        return None
    try:
        resp = _requests.post(
            "https://api.imgbb.com/1/upload",
            data={
                "key": api_key,
                "image": base64.b64encode(image_bytes).decode("utf-8"),
                "name": name,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            url = resp.json().get("data", {}).get("url")
            if url:
                print(f"[photo_composer] ImgBB upload OK: {url}")
                return url
        print(f"[photo_composer] ImgBB upload failed: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"[photo_composer] ImgBB upload error: {e}")
    return None


def _upload_imgur(image_bytes: bytes, title: str = "PersonaFlow") -> Optional[str]:
    """上傳至 Imgur（匿名）。需要 IMGUR_CLIENT_ID 環境變數。"""
    client_id = os.environ.get("IMGUR_CLIENT_ID", "").strip()
    if not client_id or _requests is None:
        return None
    try:
        resp = _requests.post(
            "https://api.imgur.com/3/image",
            headers={"Authorization": f"Client-ID {client_id}"},
            data={
                "image": base64.b64encode(image_bytes).decode("utf-8"),
                "type": "base64",
                "title": title,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            link = resp.json().get("data", {}).get("link")
            if link:
                print(f"[photo_composer] Imgur upload OK: {link}")
                return link
        print(f"[photo_composer] Imgur upload failed: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"[photo_composer] Imgur upload error: {e}")
    return None


def upload_photo(image_bytes: bytes, photo_id: str = "personaflow") -> Optional[str]:
    """
    嘗試上傳合照到雲端圖床，回傳公開 URL。
    優先順序：ImgBB → Imgur。全部失敗則回傳 None（fallback 到 local URL）。
    """
    return (
        _upload_imgbb(image_bytes, name=photo_id)
        or _upload_imgur(image_bytes, title=f"PersonaFlow {photo_id}")
    )


def compose_group_photo(
    characters: List[Dict[str, Any]],
    *,
    width: int = 1920,
    height: int = 1080,
    title: str = "PersonaFlow · 集體記憶紀念大合照",
    photo_url_base: str = "http://127.0.0.1:5001/photos",
) -> Dict[str, Any]:
    """
    合成大合照主入口。
    回傳字典包含 ok, photo_id, photo_bytes, photo_b64, qr_b64, character_count。
    若 IMGUR_CLIENT_ID 有設定，會自動上傳至 Imgur 並把 QR Code 指向公開 URL。
    """
    if Image is None:
        return {"ok": False, "error": "Pillow (PIL) is not installed"}

    # 同一秒內連續觸發相同人數的合照會產生相同檔名並互相覆蓋，
    # 因此附加一段隨機碼確保 photo_id 唯一。
    timestamp = int(time.time())
    photo_id = f"photo_{timestamp}_{len(characters)}p_{uuid.uuid4().hex[:8]}"
    photo_url = f"{photo_url_base}/{photo_id}.png"

    # 1. 建立高畫質背景畫布 (漸層質感夜幕展場風格)
    canvas = Image.new("RGBA", (width, height), (20, 24, 40, 255))
    draw = ImageDraw.Draw(canvas)

    # 繪製舞臺地板與光暈
    stage_y = int(height * 0.75)
    for y in range(height):
        # 垂直漸層
        ratio = y / height
        r = int(18 + ratio * 20)
        g = int(22 + ratio * 25)
        b = int(45 + ratio * 35)
        draw.line([(0, y), (width, y)], fill=(r, g, b, 255))

    # 地板網格/光照
    draw.polygon([(0, stage_y), (width, stage_y), (width, height), (0, height)], fill=(12, 14, 25, 255))
    draw.line([(0, stage_y), (width, stage_y)], fill=(80, 110, 180, 180), width=3)

    # 2. 自動階梯式構圖排版
    total = len(characters)
    if total == 0:
        # 空合照提示
        draw.text((width // 2 - 150, height // 2), "目前尚無在場角色", fill=(200, 200, 200, 255), font=_cjk_font(28))
    else:
        # 決定行數 (Rows): 1~7 角色 1 行; 8~18 角色 2 行; 19~36 角色 3 行; 37+ 角色 4 行
        if total <= 7:
            num_rows = 1
        elif total <= 18:
            num_rows = 2
        elif total <= 36:
            num_rows = 3
        else:
            num_rows = 4

        # 分配每行的角色清單 (後排至前排)
        chars_per_row = math.ceil(total / num_rows)
        row_groups = []
        for r in range(num_rows):
            start_idx = r * chars_per_row
            end_idx = min((r + 1) * chars_per_row, total)
            if start_idx < end_idx:
                row_groups.append(characters[start_idx:end_idx])

        # 從最上排（後排，人物較小）繪製到最前排（人物較大，蓋在前面）
        for row_idx, group in enumerate(row_groups):
            # 後排 row_idx = 0; 前排 row_idx = len(row_groups)-1
            depth_ratio = row_idx / max(1, len(row_groups) - 1) if len(row_groups) > 1 else 1.0
            row_char_h = int(200 + depth_ratio * 90)  # 200px ~ 290px
            row_baseline_y = int(stage_y - 80 + row_idx * 75 + depth_ratio * 40)

            n_in_row = len(group)
            spacing = min(int(width * 0.85) // max(1, n_in_row), int(row_char_h * 0.9))
            total_row_w = (n_in_row - 1) * spacing
            start_x = (width - total_row_w) // 2

            for col_idx, c in enumerate(group):
                char_img = _draw_lego_character(c, target_height=row_char_h)
                paste_x = start_x + col_idx * spacing - char_img.width // 2
                paste_y = row_baseline_y - char_img.height
                canvas.paste(char_img, (paste_x, paste_y), char_img)

    # 3. 標題橫幅與紀念邊框
    # 頂部裝飾條
    draw.rectangle([0, 0, width, 90], fill=(10, 12, 22, 220))
    draw.line([(0, 90), (width, 90)], fill=(255, 215, 0, 160), width=2)
    # 標題文字
    draw.text((60, 26), title, fill=(255, 255, 255, 255), font=_cjk_font(26))
    date_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp))
    meta_text = f"時間：{date_str}   在場人數：{total} 人   ID：{photo_id}"
    draw.text((60, 58), meta_text, fill=(160, 180, 210, 255), font=_cjk_font(16))

    # 4. 右下角 QR Code 紀念印章
    qr_size = 140
    qr_img = _create_qr_image(photo_url, size=qr_size)
    qr_bg = Image.new("RGBA", (qr_size + 24, qr_size + 50), (255, 255, 255, 240))
    qr_draw = ImageDraw.Draw(qr_bg)
    qr_bg.paste(qr_img, (12, 10))
    qr_draw.text((16, qr_size + 16), "掃描下載合照", fill=(20, 20, 20, 255), font=_cjk_font(18))

    badge_x = width - qr_size - 60
    badge_y = height - qr_size - 80
    canvas.paste(qr_bg, (badge_x, badge_y), qr_bg)

    # 5. 輸出二進位與 Base64
    buf = io.BytesIO()
    canvas.convert("RGB").save(buf, format="PNG", optimize=True)
    photo_bytes = buf.getvalue()
    photo_b64 = "data:image/png;base64," + base64.b64encode(photo_bytes).decode("utf-8")

    # 5.5 嘗試上傳雲端圖床：成功則 QR 指向公網 URL，任何手機都能掃
    cloud_url = upload_photo(photo_bytes, photo_id=photo_id)
    if cloud_url:
        photo_url = cloud_url
        # 重新生成 QR Code 指向公開 URL，並重繪回畫布
        qr_img = _create_qr_image(cloud_url, size=qr_size)
        qr_bg.paste(qr_img, (12, 10))
        canvas.paste(qr_bg, (badge_x, badge_y), qr_bg)
        buf = io.BytesIO()
        canvas.convert("RGB").save(buf, format="PNG", optimize=True)
        photo_bytes = buf.getvalue()
        photo_b64 = "data:image/png;base64," + base64.b64encode(photo_bytes).decode("utf-8")

    qr_buf = io.BytesIO()
    qr_img.save(qr_buf, format="PNG")
    qr_b64 = "data:image/png;base64," + base64.b64encode(qr_buf.getvalue()).decode("utf-8")

    return {
        "ok": True,
        "photo_id": photo_id,
        "photo_url": photo_url,
        "photo_bytes": photo_bytes,
        "photo_b64": photo_b64,
        "qr_b64": qr_b64,
        "character_count": total,
        "timestamp": timestamp,
    }
