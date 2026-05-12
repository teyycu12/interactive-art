import base64
import json
import os
import google.generativeai as genai
from typing import Dict, Any

# Ensure API Key is configured via environment variable, or fallback to the provided one.
_API_KEY = os.environ.get("GEMINI_API_KEY", "AIzaSyDS0VLIuy8iXOR7LUBXHaIsUQXESZLD8Qg")
genai.configure(api_key=_API_KEY)

def analyze_outfit(base64_image: str) -> Dict[str, Any]:
    """
    Sends the base64 image to Gemini 1.5 Flash to analyze the outfit components.
    Returns a parsed JSON dictionary.
    """
    try:
        # Use gemini-1.5-flash for fast multimodal processing
        model = genai.GenerativeModel("gemini-1.5-flash")
        
        # Decode base64 to bytes
        if base64_image.startswith("data:image"):
            base64_image = base64_image.split(",")[1]
        
        image_bytes = base64.b64decode(base64_image)
        
        # Prepare the payload for Gemini
        image_part = {
            "mime_type": "image/jpeg",
            "data": image_bytes
        }
        
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
        
        response = model.generate_content([prompt, image_part])
        
        text_resp = response.text.strip()
        # Clean up in case the model returns markdown code blocks despite instructions
        if text_resp.startswith("```json"):
            text_resp = text_resp[7:]
        if text_resp.startswith("```"):
            text_resp = text_resp[3:]
        if text_resp.endswith("```"):
            text_resp = text_resp[:-3]
            
        text_resp = text_resp.strip()
        
        data = json.loads(text_resp)
        return {
            "ok": True,
            "outfit": data
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
                "has_pattern": False
            }
        }


def analyze_face(base64_image: str) -> Dict[str, Any]:
    """
    Use Gemini to classify hair style, hair color, skin tone, eye color,
    and facial hair — all via visual analysis (no color sampling).
    """
    _DEFAULTS = {
        "hair_style":  "short_straight",
        "hair_color":  "dark_brown",
        "skin_tone":   "light",
        "eye_color":   "brown",
        "has_beard":   False,
        "beard_style": "none",
    }
    try:
        model = genai.GenerativeModel("gemini-1.5-flash")
        if base64_image.startswith("data:image"):
            base64_image = base64_image.split(",")[1]
        image_bytes = base64.b64decode(base64_image)
        image_part = {"mime_type": "image/jpeg", "data": image_bytes}

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

        response = model.generate_content([prompt, image_part])
        text = response.text.strip()
        if "```" in text:
            parts = text.split("```")
            text = parts[1] if len(parts) > 1 else parts[0]
            text = text.lstrip("json").strip()
        data = json.loads(text)
        return {"ok": True, "face": {**_DEFAULTS, **data}}
    except Exception as e:
        print(f"[VLM face Error] {e}")
        return {"ok": False, "face": _DEFAULTS}
