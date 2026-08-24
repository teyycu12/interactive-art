import base64
import json
import os
from typing import Any, Dict

from google import genai
from google.genai import types

_API_KEY = os.environ.get("GEMINI_API_KEY")
if not _API_KEY:
    raise RuntimeError("GEMINI_API_KEY not set — add it to your .env file")
_client = genai.Client(api_key=_API_KEY)


def strip_json_fence(text: str) -> str:
    """把模型回應中的 markdown code fence 去掉，取出純 JSON。

    即使 prompt 明確要求不要加 fence，模型仍常常會加上 ```json ... ```。

    先前 analyze_outfit 與 analyze_face 各有一套實作，行為並不一致；
    analyze_face 那套用的是 text.lstrip("json") —— lstrip 的參數是「字元集合」
    而非前綴，語意上是錯的（只是多數輸入剛好看不出差別）。此處統一為一份，
    並改用明確的前綴移除。
    """
    if not text:
        return ""
    t = text.strip()

    if "```" in t:
        parts = t.split("```")
        # fence 之間的內容；沒有成對 fence 時退回原文
        t = parts[1] if len(parts) > 1 else parts[0]

    t = t.strip()
    # 去掉語言標籤（```json / ```JSON）
    for tag in ("json", "JSON"):
        if t.startswith(tag):
            t = t[len(tag):]
            break
    return t.strip()


def analyze_outfit(base64_image: str) -> Dict[str, Any]:
    """
    Sends the base64 image to Gemini 2.0 Flash to analyze the outfit components.
    Returns a parsed JSON dictionary.
    """
    try:
        # Decode base64 to bytes
        if base64_image.startswith("data:image"):
            base64_image = base64_image.split(",")[1]

        image_bytes = base64.b64decode(base64_image)
        image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")

        prompt = """
        You are a fashion analyst for a 2D avatar system.
        Analyze the clothing the person is wearing in the image and output a JSON object describing the outfit components.
        
        The JSON MUST have the following structure and use exactly these keys and specific values:
        {
            "outer": "blazer" | "denim_jacket" | "cardigan" | "none",
            "inner": "tshirt" | "vneck" | "button_up",
            "lower": "jeans" | "pleated_skirt" | "suit_pants" | "shorts",
            "inner_color": "#HEXCODE",
            "outer_color": "#HEXCODE" (or null if none),
            "lower_color": "#HEXCODE",
            "has_pattern": true | false
        }
        
        Make your best guess. For "inner", if they just have a t-shirt, choose "tshirt".
        For colors, provide the dominant hex code for that clothing part.
        If there is no outer layer, set "outer" to "none" and "outer_color" to null.
        Respond ONLY with the JSON object, no markdown formatting like ```json or other text.
        """

        response = _client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[prompt, image_part],
        )

        data = json.loads(strip_json_fence(response.text or ""))
        return {
            "ok": True,
            "outfit": data,
        }
    except Exception as e:
        print(f"[VLM Error] {e}")
        return {
            "ok": False,
            "error": str(e),
            "outfit": {
                "outer": "none",
                "inner": "tshirt",
                "lower": "jeans",
                "inner_color": "#FFFFFF",
                "outer_color": None,
                "lower_color": "#336699",
                "has_pattern": False,
            },
        }


def analyze_face(base64_image: str) -> Dict[str, Any]:
    """
    Use Gemini to classify hair style, hair color, skin tone, eye color,
    and facial hair — all via visual analysis (no color sampling).
    """
    _DEFAULTS = {
        "hair_style": "short_straight",
        "hair_color": "dark_brown",
        "skin_tone": "light",
        "eye_color": "brown",
        "has_beard": False,
        "beard_style": "none",
    }
    try:
        if base64_image.startswith("data:image"):
            base64_image = base64_image.split(",")[1]
        image_bytes = base64.b64decode(base64_image)
        image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")

        prompt = """Carefully analyze this person's appearance.
Return ONLY a JSON object with exactly these keys and values:
{
  "hair_style":  "short_straight" | "long_straight" | "curly" | "wavy" | "ponytail" | "bun" | "buzz_cut" | "bald",
  "hair_color":  "black" | "dark_brown" | "brown" | "light_brown" | "blonde" | "red" | "gray" | "white",
  "skin_tone":   "fair" | "light" | "medium" | "tan" | "brown" | "dark",
  "eye_color":   "dark_brown" | "brown" | "hazel" | "green" | "blue" | "gray",
  "has_beard":   true | false,
  "beard_style": "full_beard" | "mustache" | "stubble" | "none"
}

hair_style guide:
- short_straight: hair above shoulders, straight or slightly textured
- long_straight: hair at or below shoulders, straight
- curly: clearly curly or kinky texture
- wavy: wavy or loosely curled
- ponytail: tied behind the head
- bun: hair pinned up in a bun or updo
- buzz_cut: very close-cut, under 1 cm
- bald: no visible hair on top

skin_tone guide (judge by face, not lighting):
- fair: very pale, almost white
- light: light beige or peach (typical East/West European, light East Asian)
- medium: warm beige or light tan (Mediterranean, Latin, many East Asian)
- tan: golden or olive tan (many Southeast Asian, Middle Eastern, light African)
- brown: medium brown (South Asian, many African)
- dark: deep dark brown (West African, very dark South Indian)

Respond ONLY with the JSON object, no markdown fences."""

        response = _client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[prompt, image_part],
        )
        data = json.loads(strip_json_fence(response.text or ""))
        return {"ok": True, "face": {**_DEFAULTS, **data}}
    except Exception as e:
        print(f"[VLM face Error] {e}")
        return {"ok": False, "face": _DEFAULTS}

