"""/compose 端點與資產路徑解析測試。

_asset_path 把互動層轉發過來的貼圖 URL 轉成本機路徑再讀檔。那個值
源頭是客戶端資料，若不做邊界檢查等於讓上游的任意字串決定要讀哪個檔案，
因此路徑逃逸的防護是這裡的重點，不是附帶項目。
"""

import base64
import io
import os

import numpy as np
import pytest
from PIL import Image as PILImage

import service


@pytest.fixture
def client():
    service.app.config["TESTING"] = True
    with service.app.test_client() as c:
        yield c


def _char(x=None, y=None, **kw):
    c = {"outfit": {"inner_color": "#3366CC", "lower_color": "#222222"},
         "face": {"skin_tone": "#F4C08A", "hair_color": "#4A2C1A"}}
    if x is not None:
        c["x"], c["y"] = x, y
    c.update(kw)
    return c


class TestAssetPath:
    """只有落在 ASSET_DIR 底下、真實存在的檔案才可以被讀。"""

    @pytest.mark.parametrize("bad", [
        None, "", 123, [],
        "/etc/passwd",                              # 絕對路徑
        "assets/gen/x/full.png",                    # 缺前導斜線
        "/assets/gen/../../../etc/passwd",          # 相對路徑逃逸
        "/assets/gen/../../.env",
        "/other/gen/x/full.png",                    # 前綴不符
    ])
    def test_rejects_unsafe_or_malformed(self, bad):
        assert service._asset_path(bad) is None

    def test_rejects_path_that_does_not_exist(self):
        assert service._asset_path("/assets/gen/nope/full.png") is None

    def test_accepts_real_file_under_asset_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "ASSET_DIR", str(tmp_path))
        d = tmp_path / "abc123"
        d.mkdir()
        (d / "full.png").write_bytes(b"x")
        got = service._asset_path("/assets/gen/abc123/full.png")
        assert got == str(d / "full.png")


class TestComposeEndpoint:
    def test_composes_with_positions(self, client):
        res = client.post("/compose", json={
            "characters": [_char(300, 200), _char(1500, 900)],
            "photoUrlBase": "http://x/p",
        })
        body = res.get_json()
        assert res.status_code == 200
        assert body["ok"] is True
        assert body["character_count"] == 2
        assert body["photo_b64"].startswith("data:image/png;base64,")

    def test_photo_bytes_is_stripped(self, client):
        """photo_bytes 是 bytes，留著會讓 jsonify 直接炸掉。"""
        res = client.post("/compose", json={"characters": [_char(100, 100)]})
        assert "photo_bytes" not in res.get_json()

    def test_empty_roster_still_ok(self, client):
        body = client.post("/compose", json={"characters": []}).get_json()
        assert body["ok"] is True
        assert body["character_count"] == 0

    @pytest.mark.parametrize("payload", [{}, {"characters": "x"}, {"characters": 5}])
    def test_rejects_bad_payload_with_200(self, client, payload):
        """契約：失敗一律 200 + ok:false，讓主辦端解得出 JSON。"""
        res = client.post("/compose", json=payload)
        assert res.status_code == 200
        assert res.get_json()["ok"] is False

    def test_unexpected_error_does_not_leak_500(self, client, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("boom")
        monkeypatch.setattr(service, "compose_group_photo", boom)
        res = client.post("/compose", json={"characters": [_char(1, 1)]})
        assert res.status_code == 200
        assert res.get_json() == {"ok": False, "error": "internal_error"}

    def test_reports_unavailable_when_composer_missing(self, client, monkeypatch):
        monkeypatch.setattr(service, "compose_group_photo", None)
        body = client.post("/compose", json={"characters": []}).get_json()
        assert body == {"ok": False, "error": "composer_unavailable"}

    def test_full_png_is_resolved_to_local_path(self, client, tmp_path, monkeypatch):
        """CV 角色的 fullPng 會被轉成本機路徑供 Pillow 直接讀。"""
        monkeypatch.setattr(service, "ASSET_DIR", str(tmp_path))
        d = tmp_path / "aid"
        d.mkdir()
        arr = np.zeros((80, 40, 4), dtype=np.uint8)
        arr[:, :] = (200, 50, 50, 255)
        PILImage.fromarray(arr, "RGBA").save(d / "full.png")

        seen = {}
        def spy(chars, **kw):
            seen["path"] = chars[0]["body_path"]
            return {"ok": True, "photo_id": "p", "photo_url": "u", "photo_bytes": b"",
                    "photo_b64": "d", "qr_b64": "q", "character_count": 1, "timestamp": 0}
        monkeypatch.setattr(service, "compose_group_photo", spy)

        client.post("/compose", json={
            "characters": [_char(10, 10, fullPng="/assets/gen/aid/full.png")]})
        assert seen["path"] == str(d / "full.png")
