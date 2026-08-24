"""
Swarm 狀態快照持久化模組。

負責在伺服器關閉、崩潰或定期背景將 _swarm_chars 寫入磁碟 (JSON)，
並在伺服器重新啟動時自動還原，避免展場重新啟動時累積的訪客角色遺失。
"""

import json
import os
import tempfile
import time
from typing import Any, Dict, Optional

# 預設快照儲存路徑：backend/data/swarm_snapshot.json
_DEFAULT_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
_DEFAULT_SNAPSHOT_PATH = os.path.join(_DEFAULT_DATA_DIR, "swarm_snapshot.json")

# 快照中需排除的巨量二進位/base64欄位（避免快照過大）
_EXCLUDED_KEYS = {"image", "img", "img_str", "body_png", "frame", "base64"}


def _filter_char_data(char: Dict[str, Any]) -> Dict[str, Any]:
    """過濾單一角色字典中不必要的影像欄位，保留外觀屬性、座標、速度與狀態。"""
    filtered = {}
    for k, v in char.items():
        if k in _EXCLUDED_KEYS:
            continue
        filtered[k] = v
    return filtered


def save_snapshot(chars: Dict[str, Any], filepath: Optional[str] = None) -> bool:
    """
    將目前的 _swarm_chars 字典序列化儲存至快照檔案。
    採用 atomic write（先寫至暫存檔再 rename）避免寫入中途崩潰導致檔案損毀。
    """
    if filepath is None:
        filepath = _DEFAULT_SNAPSHOT_PATH

    data_dir = os.path.dirname(filepath)
    os.makedirs(data_dir, exist_ok=True)

    filtered_chars = {cid: _filter_char_data(c) for cid, c in chars.items()}
    payload = {
        "saved_at": time.time(),
        "char_count": len(filtered_chars),
        "characters": filtered_chars,
    }

    tmp_file = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=data_dir, delete=False, encoding="utf-8") as f:
            tmp_file = f.name
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, filepath)
        return True
    except Exception as e:
        print(f"[swarm_snapshot] Failed to save snapshot: {e}")
        if tmp_file and os.path.exists(tmp_file):
            try:
                os.remove(tmp_file)
            except Exception:
                pass
        return False


def load_snapshot(filepath: Optional[str] = None, max_age_seconds: float = 86400.0) -> Optional[Dict[str, Any]]:
    """
    從快照檔案載入角色字典。
    若快照時間距今超過 max_age_seconds（預設 24 小時），視為過期並忽略。
    """
    if filepath is None:
        filepath = _DEFAULT_SNAPSHOT_PATH

    if not os.path.exists(filepath):
        return None

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            payload = json.load(f)

        saved_at = payload.get("saved_at", 0)
        if time.time() - saved_at > max_age_seconds:
            print(f"[swarm_snapshot] Snapshot is older than {max_age_seconds}s. Ignoring.")
            return None

        chars = payload.get("characters", {})
        print(f"[swarm_snapshot] Successfully restored {len(chars)} characters from snapshot.")
        return chars
    except Exception as e:
        print(f"[swarm_snapshot] Failed to load snapshot: {e}")
        return None


def clear_snapshot(filepath: Optional[str] = None) -> bool:
    """手動清除快照檔案。"""
    if filepath is None:
        filepath = _DEFAULT_SNAPSHOT_PATH
    if os.path.exists(filepath):
        try:
            os.remove(filepath)
            return True
        except Exception as e:
            print(f"[swarm_snapshot] Failed to remove snapshot: {e}")
            return False
    return True
