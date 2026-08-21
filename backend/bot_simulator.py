"""
蜂群模擬機器人注入器 (Bot Swarm Simulator)。

負責產生具備多樣化服飾顏色、髮型、五官與配件的虛擬角色，
並可一鍵注入或清除。在展場無人或進行壓力測試時維持畫面的豐富度。
"""

import random
import time
from typing import Any, Dict, List, Optional

# 精選調色盤（避免隨機產生刺眼灰暗雜色）
_SKIN_PALETTE = ["#FFE0BD", "#FFD0A8", "#F1C27D", "#E0AC69", "#C68642", "#8D5524", "#FEDB00"]
_HAIR_PALETTE = ["#090806", "#2C222B", "#4E433F", "#71635A", "#8B5A2B", "#B55239", "#E6BE8A", "#FFF5E1"]
_UPPER_PALETTE = [
    "#E63946", "#F4A261", "#E76F51", "#2A9D8F", "#264653",
    "#1D3557", "#457B9D", "#A8DADC", "#6D597A", "#B56576",
    "#3D5A80", "#EE6C4D", "#293241", "#588157", "#3A5A40"
]
_LOWER_PALETTE = [
    "#1F2421", "#212529", "#343A40", "#495057", "#1D3557",
    "#2B2D42", "#8D99AE", "#3D3A45", "#5C677D", "#023E8A"
]
_HAIR_STYLES = ["short_straight", "short_curly", "long_straight", "long_wavy", "ponytail", "buzz", "side_part"]
_ACCESSORY_CHOICES = ["glasses", "sunglasses", "hat", "cap", "none", "none", "none"]


def generate_random_bot(
    index: int = 0,
    *,
    width: float = 1920,
    height: float = 1080,
    palette: str = "random",
) -> Dict[str, Any]:
    """
    生成單隻結構完整、具隨機合理外觀的虛擬角色字典。
    """
    bot_id = f"bot_{int(time.time() * 1000) % 1000000}_{index}_{random.randint(100, 999)}"

    top_color = random.choice(_UPPER_PALETTE)
    bot_color = random.choice(_LOWER_PALETTE)
    skin_tone = random.choice(_SKIN_PALETTE)
    hair_color = random.choice(_HAIR_PALETTE)
    hair_style = random.choice(_HAIR_STYLES)
    acc = random.choice(_ACCESSORY_CHOICES)

    # 初始座標集中在中間 70% 區域，避免生成在邊界碰撞
    margin_x = width * 0.15
    margin_y = height * 0.15
    x = random.uniform(margin_x, width - margin_x)
    y = random.uniform(margin_y, height - margin_y)
    vx = random.uniform(-1.0, 1.0)
    vy = random.uniform(-1.0, 1.0)

    accessories = [acc] if acc != "none" else []

    return {
        "id": bot_id,
        "is_bot": True,
        "x": round(x, 1),
        "y": round(y, 1),
        "vx": round(vx, 3),
        "vy": round(vy, 3),
        "upper": {"hex": top_color},
        "lower": {"hex": bot_color},
        "arm": {"hex": top_color},
        "accessories": accessories,
        "outfit": {
            "inner_color": top_color,
            "lower_color": bot_color,
            "outer_color": top_color,
            "has_glasses": "glasses" in accessories or "sunglasses" in accessories,
        },
        "face": {
            "skin_tone": skin_tone,
            "hair_color": hair_color,
            "hair_style": hair_style,
            "eye_color": "#3B2314",
            "has_beard": random.random() < 0.15,
        },
        "character_mode": "body_sprite",
        "state": "ROAMING",
    }


def inject_bots(
    swarm_chars: Dict[str, Any],
    count: int = 10,
    *,
    width: float = 1920,
    height: float = 1080,
    palette: str = "random",
) -> List[str]:
    """
    產生 count 隻 bot 並加入傳入的 swarm_chars 字典。
    回傳新建立的 bot ID 清單。
    """
    created_ids = []
    for i in range(count):
        bot = generate_random_bot(i, width=width, height=height, palette=palette)
        swarm_chars[bot["id"]] = bot
        created_ids.append(bot["id"])
    return created_ids


def remove_bots(swarm_chars: Dict[str, Any]) -> int:
    """
    從 swarm_chars 移除所有機器人角色 (is_bot == True 或 id 以 bot_ 開頭)。
    回傳移除的數量。
    """
    bot_keys = [k for k, v in swarm_chars.items() if v.get("is_bot") or str(k).startswith("bot_")]
    for k in bot_keys:
        swarm_chars.pop(k, None)
    return len(bot_keys)
