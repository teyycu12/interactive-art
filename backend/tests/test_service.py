"""生成服務的 HTTP 介面測試（整合計畫階段 1）。

真正的生圖需要外部 API 金鑰，測試裡一律替換掉 —— 這裡要驗的是
「服務把各步驟接起來的方式」，不是模型畫得好不好。
"""

import base64
import io
import os

import numpy as np
import pytest
from PIL import Image as PILImage

import service
from backend.slicer import PARTS


def _png_b64(width=200, height=400):
    """一張最小的合成人偶圖，足以走完正規化與切片。"""
    arr = np.zeros((height, width, 4), dtype=np.uint8)
    arr[: height // 3, 60:140] = (74, 44, 26, 255)
    arr[height // 3: height * 2 // 3, 40:160] = (143, 160, 94, 255)
    arr[height * 2 // 3:, 60:140] = (183, 169, 138, 255)
    buf = io.BytesIO()
    PILImage.fromarray(arr, "RGBA").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _photo_b64():
    """一張純色 JPEG，用來走 decode_frame → CV 這段。"""
    buf = io.BytesIO()
    PILImage.new("RGB", (320, 480), (180, 140, 120)).save(buf, "JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "ASSET_DIR", str(tmp_path))
    service.app.config["TESTING"] = True
    return service.app.test_client()


class TestHealth:
    def test_reports_status(self, client):
        body = client.get("/health").get_json()
        assert body["ok"] is True
        assert "degraded" in body
        assert isinstance(body["degraded"], list)


class TestGenerateGuards:
    def test_missing_image_degrades_not_errors(self, client):
        """缺圖是使用者情境，不是伺服器故障 —— 必須回 200 + 降級色。"""
        r = client.post("/generate", json={})
        assert r.status_code == 200
        body = r.get_json()
        assert body["ok"] is False
        assert body["error"] == "no_image"
        assert set(body["fallbackColors"]) == {"skin", "hair", "torso", "legs"}

    def test_undecodable_image_degrades(self, client):
        body = client.post("/generate", json={"image": "data:image/png;base64,!!!!"}).get_json()
        assert body["ok"] is False
        assert "fallbackColors" in body

    def test_imagegen_unavailable_degrades(self, client, monkeypatch):
        monkeypatch.setattr(service, "generate_full_character_png", None)
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is False
        assert body["error"] == "imagegen_unavailable"
        assert "fallbackColors" in body


class TestGenerateSuccess:
    """把生圖替換成合成圖，驗證後半段（切片 → 落地 → 契約 4）確實接得起來。"""

    def test_returns_contract_and_writes_files(self, client, monkeypatch, tmp_path):
        monkeypatch.setattr(
            service, "generate_full_character_png",
            lambda *a, **k: {"ok": True, "body_png": _png_b64()},
        )
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()

        assert body["ok"] is True
        asset_id = body["assetId"]
        assert len(asset_id) == 32
        for part in PARTS:
            assert body["textures"][part] == f"/assets/gen/{asset_id}/{part}.webp"
            assert os.path.exists(tmp_path / asset_id / f"{part}.webp")
        assert set(body["fallbackColors"]) == {"skin", "hair", "torso", "legs"}
        assert body["elapsedMs"] >= 0

    def test_each_request_gets_its_own_asset_dir(self, client, monkeypatch):
        """兩位參與者的貼圖不可互相覆蓋。"""
        monkeypatch.setattr(
            service, "generate_full_character_png",
            lambda *a, **k: {"ok": True, "body_png": _png_b64()},
        )
        a = client.post("/generate", json={"image": _photo_b64()}).get_json()
        b = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert a["assetId"] != b["assetId"]

    def test_slice_failure_degrades(self, client, monkeypatch):
        """生圖成功但切片炸掉時，仍要讓參與者進得了場。"""
        monkeypatch.setattr(
            service, "generate_full_character_png",
            lambda *a, **k: {"ok": True, "body_png": base64.b64encode(b"not-a-png").decode()},
        )
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is False
        assert body["error"].startswith("slice_failed")
        assert "fallbackColors" in body


class TestDegradeContract:
    """任何未預期的例外都不得變成 HTML 500。

    手機端只解析 JSON —— 收到 HTML 500 時它只能顯示「連不上」，
    而不是照設計退回捏臉，參與者就卡在報到動線上了。
    """

    def test_unexpected_exception_still_returns_json(self, client, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("模擬未預期失敗")
        monkeypatch.setattr(service, "decode_frame", boom)

        r = client.post("/generate", json={"image": _photo_b64()})
        assert r.status_code == 200
        body = r.get_json()
        assert body["ok"] is False
        assert body["error"] == "internal_error"
        assert set(body["fallbackColors"]) == {"skin", "hair", "torso", "legs"}

    def test_cv_failure_does_not_abort_request(self, client, monkeypatch):
        """CV 抓不到特徵時仍要走完生成流程（退回中央預設框與預設色）。"""
        def boom(*a, **k):
            raise RuntimeError("MediaPipe 掛了")
        monkeypatch.setattr(service, "get_clothing_features", boom)
        monkeypatch.setattr(service, "get_face_features", boom)
        monkeypatch.setattr(
            service, "generate_full_character_png",
            lambda *a, **k: {"ok": True, "body_png": _png_b64()},
        )
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is True, "CV 失敗不該讓整個請求失敗"

    def test_worker_pool_fits_concurrent_requests(self):
        """每個請求要 4 個 slot；池子太小會讓第二個人一按拍照就逾時。"""
        assert service._executor._max_workers >= 8


class TestSampledColors:
    def test_prefers_cv_colors_over_defaults(self):
        colors = service._sampled_colors(
            {"upper": {"hex": "#123456"}, "lower": {"hex": "#654321"}},
            {"skin_tone": "#ABCDEF", "hair_color": "#FEDCBA"},
        )
        assert colors == {
            "torso": "#123456", "legs": "#654321",
            "skin": "#ABCDEF", "hair": "#FEDCBA",
        }

    def test_falls_back_when_cv_missing(self):
        assert service._sampled_colors({}, {}) == service.DEFAULT_COLORS

    def test_ignores_malformed_cv_values(self):
        colors = service._sampled_colors({"upper": "not-a-dict"}, {"skin_tone": 42})
        assert colors == service.DEFAULT_COLORS
