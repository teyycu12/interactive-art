"""Generation-style registry.

A style is everything that differs between "the same person, rendered as a LEGO
minifigure" and "…rendered as a 3D animated-feature character": the prompt, the
negative clause, the pose reference the model is shown, and the curated style
sheet that is the primary authority on craft.

Those four have to travel together.  The reference sheet used to be selected by
the ``STYLE_REFERENCE_SET`` environment variable alone, independently of the
style -- which meant registering a second style silently paired it with the first
style's sheet.  The sheet is declared to the model as the highest authority on
finish and construction (``_ROLE_STYLE`` in :mod:`garment_gen`), so that pairing
does not fail loudly; it just generates a contradiction and lets the model settle
it.  ``reference_set`` lives on the style for that reason.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, FrozenSet, List, Mapping, Optional


@dataclass(frozen=True)
class GenerationStyle:
    style_id: str
    full_prompt_template: str
    supported_modes: FrozenSet[str]
    model_overrides: Mapping[str, str] = field(default_factory=dict)
    generation_params: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # 給參與者看的名字。手機端的風格選單直接用它，才不會把 style_id 露到畫面上。
    display_name: str = ""
    # docs/style_reference/<reference_set>/ ——空字串代表這個風格不送風格 sheet。
    reference_set: str = ""
    # 這個風格的 sheet 在 prompt 裡怎麼被描述。樂高講「塑膠如何反光」，
    # 皮克斯講「布料如何有厚度」，同一段文字套兩邊會自我矛盾。
    role_style_text: str = ""
    # 姿勢參考圖的產生器。樂高用梯形軀幹＋爪手的幾何，拿去餵皮克斯會把
    # 玩具比例一起帶進去，所以連它也必須隨風格換。
    pose_builder: Optional[Callable[[], Any]] = None


_STYLES: Dict[str, GenerationStyle] = {}

DEFAULT_STYLE_ID = "lego"


def register_style(style: GenerationStyle) -> None:
    _STYLES[style.style_id] = style


def has_style(style_id: Any) -> bool:
    """這個 id 是否真的註冊過。

    ``get_style`` 對未知 id 靜默退回樂高，那對生成路徑是正確的（現場不該因為
    一個字串錯掉就生不出角色），但對 API 邊界是錯的：手機端送錯風格會拿到
    樂高卻以為選到了別的。邊界要用這個先擋。
    """
    return isinstance(style_id, str) and style_id.strip().lower() in _STYLES


def list_styles() -> List[Dict[str, str]]:
    """已註冊的風格，供 /health 與手機端選單使用。"""
    return [
        {
            "id": style.style_id,
            "displayName": style.display_name or style.style_id,
            "referenceSet": style.reference_set,
        }
        for style in _STYLES.values()
    ]


def get_style(style_id: str) -> GenerationStyle:
    if style_id in _STYLES:
        return _STYLES[style_id]
    if DEFAULT_STYLE_ID not in _STYLES:
        raise RuntimeError("LEGO generation style has not been registered")
    return _STYLES[DEFAULT_STYLE_ID]


def get_event_style_id() -> str:
    requested = os.environ.get("CHARACTER_STYLE", DEFAULT_STYLE_ID).strip().lower()
    return requested if requested in _STYLES else DEFAULT_STYLE_ID


def resolve_style_id(requested: Any) -> str:
    """把一個外部來源的風格 id 收斂成一個確定註冊過的 id。

    參與者選的優先，選了沒註冊的（或什麼都沒選）就退回活動層級的預設。
    """
    if isinstance(requested, str) and requested.strip().lower() in _STYLES:
        return requested.strip().lower()
    return get_event_style_id()


# ─────────────────────────────────────────────────────────────────────────────
# 這個模組持有可變的全域狀態（_STYLES），因此絕不能同時存在兩份。
#
# 專案裡有兩種匯入路徑並存：`backend.style_registry`（garment_gen 走這條）與
# `style_registry`（service.py 走這條，因為它是以 `python backend/service.py`
# 啟動的，sys.path[0] 就是 backend/）。兩條路徑都成立的時候——pytest、或任何
# 把專案根目錄放進 sys.path 的環境——Python 會建立**兩個獨立的模組物件**，
# 各自帶一份空的 _STYLES。
#
# 後果是靜默的：garment_gen 把風格註冊進其中一份，service.py 從另一份查詢，
# 查到的永遠是空的，於是 resolve_style_id() 對每一個請求都回傳預設風格。
# 沒有例外、沒有錯誤訊息，_DEGRADED 也是空的 —— 現場只會看到「選了皮克斯
# 卻生出樂高」，而那看起來像模型的問題。
#
# 所以在這裡把兩個名字釘成同一個模組物件，先被匯入的那個贏。用 setdefault
# 而不是直接指派：另一個名字若已經在 sys.modules 裡，代表它才是先來的那個，
# 覆寫它會讓已經拿著舊物件的呼叫方繼續讀到舊的 _STYLES。
# ─────────────────────────────────────────────────────────────────────────────
import sys as _sys  # noqa: E402  （放在檔尾是刻意的，見上方說明）

_sys.modules.setdefault("style_registry", _sys.modules[__name__])
_sys.modules.setdefault("backend.style_registry", _sys.modules[__name__])
