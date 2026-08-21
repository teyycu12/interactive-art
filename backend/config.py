"""
PersonaFlow 集中式環境設定模組。
負責解析、驗證與型別轉換所有環境變數，提供單一型別安全的 Config 物件。
"""

import os
from dataclasses import dataclass
from typing import Optional

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    load_dotenv()
except ImportError:
    pass


def _get_int(key: str, default: int) -> int:
    val = os.environ.get(key)
    if val is None or val.strip() == "":
        return default
    try:
        return int(val.strip())
    except ValueError:
        raise ValueError(f"環境變數 {key} 必須是整數，目前設定值為: '{val}'")


def _get_bool(key: str, default: bool) -> bool:
    val = os.environ.get(key)
    if val is None or val.strip() == "":
        return default
    return val.strip().lower() not in ("0", "false", "no", "off", "")


@dataclass(frozen=True)
class AppConfig:
    # 服務監聽
    HOST: str = os.environ.get("HOST", "0.0.0.0")
    PORT: int = _get_int("PORT", 5001)

    # M3 併發與蜂群設定
    GEN_MAX_CONCURRENT: int = max(1, _get_int("GEN_MAX_CONCURRENT", 2))
    MAX_SWARM_SIZE: int = max(10, _get_int("MAX_SWARM_SIZE", 300))
    MAX_BOTS_PER_INJECT: int = max(1, _get_int("MAX_BOTS_PER_INJECT", 100))
    AUTO_BOTS: int = max(0, _get_int("AUTO_BOTS", 0))
    EVENT_LOG_ENABLED: bool = _get_bool("EVENT_LOG_ENABLED", True)

    # M2 生成模式與金鑰
    GENERATION_MODE: str = os.environ.get("GENERATION_MODE", "body_sprite").strip()
    GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY", "")
    OPENAI_API_KEY: str = os.environ.get("OPENAI_API_KEY", "")
    OUTFIT_GEN_MODEL: str = os.environ.get("OUTFIT_GEN_MODEL", "google/gemini-3.1-flash-image-preview")
    FULL_CHARACTER_MODEL: str = os.environ.get("FULL_CHARACTER_MODEL", "google/gemini-3-pro-image-preview")
    REFINE_CHARACTER_MODEL: Optional[str] = os.environ.get("REFINE_CHARACTER_MODEL")


# 全域單例
config = AppConfig()
