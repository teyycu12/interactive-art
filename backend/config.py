"""
PersonaFlow 集中式環境設定模組。
負責解析、驗證與型別轉換所有環境變數，提供單一型別安全的 Config 物件。
"""

import os
from dataclasses import dataclass
from typing import Any, Optional

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


def _get_str(key: str, default: str) -> str:
    """讀取字串設定；空字串視同未設定。

    os.environ.get(key, default) 在「變數存在但值為空」時會回傳空字串而非
    預設值。.env 裡留一行 KEY= 是很自然的寫法（範本補進去就是這個形狀），
    卻會把程式裡的預設值整個蓋掉 —— 實際發生過的後果是模型名稱變成空字串，
    以及 VISION_PORT 讓 int('') 直接把服務打掛。
    """
    val = os.environ.get(key)
    return default if val is None or val.strip() == "" else val.strip()


_DEV_SECRET = "personaflow-dev-secret"


def _get_origins(key: str, default: str) -> Any:
    """CORS 來源：'*' 直接放行，否則拆成來源清單。

    回傳 tuple 而非 list —— dataclass 不允許可變的預設值
    （ValueError: mutable default ... use default_factory）。
    呼叫端傳給 Flask-SocketIO 前再轉成 list。
    """
    raw = os.environ.get(key, default).strip()
    if raw == "*" or not raw:
        return "*"
    return tuple(o.strip() for o in raw.split(",") if o.strip())


@dataclass(frozen=True)
class AppConfig:
    # 服務監聽
    HOST: str = os.environ.get("HOST", "0.0.0.0")
    PORT: int = _get_int("PORT", 5001)
    # 預設 False：展場長時間運行不應開 debug（會洩漏 traceback 且效能較差）
    DEBUG: bool = _get_bool("DEBUG", False)
    # 未設定時退回開發用預設值並在啟動時警告（見 config 結尾）
    SECRET_KEY: str = os.environ.get("SECRET_KEY", "") or "personaflow-dev-secret"
    # "*" 或逗號分隔的來源清單；展場 LAN 事前無法列舉賓客 IP，故預設 "*"
    CORS_ALLOWED_ORIGINS: Any = _get_origins("CORS_ALLOWED_ORIGINS", "*")

    # M3 併發與蜂群設定
    GEN_MAX_CONCURRENT: int = max(1, _get_int("GEN_MAX_CONCURRENT", 2))
    MAX_SWARM_SIZE: int = max(10, _get_int("MAX_SWARM_SIZE", 300))
    MAX_BOTS_PER_INJECT: int = max(1, _get_int("MAX_BOTS_PER_INJECT", 100))
    AUTO_BOTS: int = max(0, _get_int("AUTO_BOTS", 0))
    EVENT_LOG_ENABLED: bool = _get_bool("EVENT_LOG_ENABLED", True)
    # 角色多久沒有更新就自動清場（秒）。0 表示不過期。
    # 角色已與連線脫鉤（見 handle_join_swarm），因此需要 TTL 作為回收機制。
    CHARACTER_TTL_SEC: int = max(0, _get_int("CHARACTER_TTL_SEC", 7200))

    # M2 生成模式與金鑰
    # full_character 是唯一還在線上的模式；body_sprite 與 brick_ai_texture 已退役，
    # app.py 會在付費呼叫前直接拒絕它們。預設值必須跟著改，否則沒設這個環境變數
    # 的人一啟動就落在被拒絕的模式上。
    # 用 _get_str 而非 os.environ.get：.env 裡留一行「GENERATION_MODE=」會產生
    # 空字串，直接讀會讓它覆寫掉這個預設值。
    GENERATION_MODE: str = _get_str("GENERATION_MODE", "full_character")
    GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY", "")
    OPENAI_API_KEY: str = os.environ.get("OPENAI_API_KEY", "")
    OUTFIT_GEN_MODEL: str = _get_str("OUTFIT_GEN_MODEL", "google/gemini-3.1-flash-image-preview")
    FULL_CHARACTER_MODEL: str = _get_str("FULL_CHARACTER_MODEL", "google/gemini-3-pro-image-preview")
    REFINE_CHARACTER_MODEL: Optional[str] = _get_str("REFINE_CHARACTER_MODEL", "") or None


# 全域單例
config = AppConfig()

if config.SECRET_KEY == _DEV_SECRET:
    print("[config] ⚠️  SECRET_KEY 使用開發預設值（此值已提交進版控）。"
          "正式展演請於 .env 設定 SECRET_KEY。")
