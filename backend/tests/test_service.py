"""生成服務的 HTTP 介面測試（整合計畫階段 1）。

真正的生圖需要外部 API 金鑰，測試裡一律替換掉 —— 這裡要驗的是
「服務把各步驟接起來的方式」，不是模型畫得好不好。
"""

import base64
import io
import os
import re

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
            assert body["textures"][part] == f"/assets/gen/{asset_id}/{part}.png"
            assert os.path.exists(tmp_path / asset_id / f"{part}.png")
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
            lambda *a, **k: {"ok": True, "body_png": _png_b64()},
        )

        def _boom(*a, **k):
            raise RuntimeError("disk full")

        monkeypatch.setattr(service, "slice_character", _boom)
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is False
        assert body["error"].startswith("slice_failed")
        assert "fallbackColors" in body

    def test_malformed_output_is_caught_before_slicing(self, client, monkeypatch):
        """解不開的生成結果由驗證攔下，不會一路帶到切片才炸。

        原本這種輸入是走到 slice_character 才失敗。接上 avatar_quality 之後
        validate_avatar_png 會先擋下來（decode_failed），錯誤碼因此不同 ——
        兩者都不擋人進場，但前者能給出重拍理由，後者只有一句切片失敗。
        """
        monkeypatch.setattr(
            service, "generate_full_character_png",
            lambda *a, **k: {"ok": True, "body_png": base64.b64encode(b"not-a-png").decode()},
        )
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is False
        assert body["error"] == "validation_failed"
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


class TestQualityLoop:
    """avatar_quality 的驗證與重生閉環。

    這段是整套流程唯一會擋下壞結果的地方。少了它，缺一條腿或沒有鞋子的角色
    會直接被切成三張貼圖上大螢幕 —— 沒有任何一處會發現。
    """

    def test_validation_failure_returns_guidance(self, client, monkeypatch):
        """驗證不過時要說出重拍理由，不能只丟一句生成失敗。"""
        monkeypatch.setattr(
            service, "generate_full_character_png",
            lambda *a, **k: {"ok": True, "body_png": _png_b64()},
        )
        monkeypatch.setattr(
            service, "validate_avatar_png",
            lambda *a, **k: {"passed": False, "errors": ["missing_bottom_left"], "warnings": []},
        )
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is False
        assert body["error"] == "validation_failed"
        assert body["guidance"], "必須帶重拍理由；沒有它參與者只能再拍一張一樣的照片"
        assert "fallbackColors" in body

    def test_no_retry_by_default(self, client, monkeypatch):
        """預設不重生 —— 每次重生都是一次付費呼叫。"""
        calls = []
        monkeypatch.delenv("GENERATION_MAX_RETRIES", raising=False)

        def _gen(*a, **k):
            calls.append(1)
            return {"ok": True, "body_png": _png_b64()}

        monkeypatch.setattr(service, "generate_full_character_png", _gen)
        monkeypatch.setattr(
            service, "validate_avatar_png",
            lambda *a, **k: {"passed": False, "errors": ["missing_bottom_left"], "warnings": []},
        )
        client.post("/generate", json={"image": _photo_b64()})
        assert len(calls) == 1

    def test_retry_carries_a_correction(self, client, monkeypatch):
        """開啟重生時，第二次必須帶修正指令。

        不帶指令的重試等於再擲一次同樣的骰子，卻要付第二次錢。
        """
        seen = []

        def _gen(rgb, poly, face, outfit, remove_bg=True, regions=None,
                 style_id="lego", correction=None, **k):
            seen.append(correction)
            return {"ok": True, "body_png": _png_b64()}

        monkeypatch.setenv("GENERATION_MAX_RETRIES", "1")
        monkeypatch.setattr(service, "generate_full_character_png", _gen)
        monkeypatch.setattr(
            service, "validate_avatar_png",
            lambda *a, **k: {"passed": False, "errors": ["missing_bottom_left"], "warnings": []},
        )
        client.post("/generate", json={"image": _photo_b64()})
        assert len(seen) == 2
        assert seen[0] is None
        assert seen[1], "重生必須帶修正指令"
        assert "legs" in seen[1] or "shoes" in seen[1]

    def test_paid_call_does_not_auto_retry_on_failure(self, client, monkeypatch):
        """熔斷器不得自行重試付費生圖。

        CircuitBreaker.call 預設 max_retries=1：生圖失敗會再打一次，多付一次錢，
        而且那次重試不帶任何修正指令，成功率與第一次相同。要不要重生應由驗證
        結果決定，不由熔斷器決定。
        """
        calls = []

        def _boom(*a, **k):
            calls.append(1)
            return {"ok": False, "error": "upstream_500"}

        monkeypatch.setattr(service, "generate_full_character_png", _boom)
        service._imagegen_breaker.reset()
        client.post("/generate", json={"image": _photo_b64()})
        assert len(calls) == 1, f"付費呼叫被執行了 {len(calls)} 次"


class TestHistoryIsNeverFatal:
    """帳本是觀測，不是流程的一部分 —— 它壞掉不得影響任何參與者。"""

    def test_history_failure_does_not_break_generation(self, client, monkeypatch):
        def _boom(*a, **k):
            raise RuntimeError("database is locked")

        monkeypatch.setattr(service, "start_run", _boom)
        monkeypatch.setattr(service, "finish_run", _boom)
        monkeypatch.setattr(service, "record_attempt", _boom)
        monkeypatch.setattr(service, "save_input_photo", _boom)
        monkeypatch.setattr(
            service, "generate_full_character_png",
            lambda *a, **k: {"ok": True, "body_png": _png_b64()},
        )
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is True
        for part in PARTS:
            assert part in body["textures"]


class TestPreview:
    """站位引導端點。這條路每秒被打數次，成本必須是零。"""

    def test_never_calls_a_paid_api(self, client, monkeypatch):
        """預覽只跑 CV —— 碰到任何付費呼叫就是設計壞了。"""
        def _boom(*a, **k):
            raise AssertionError("預覽不得呼叫付費 API")

        monkeypatch.setattr(service, "generate_full_character_png", _boom)
        monkeypatch.setattr(service, "analyze_outfit", _boom)
        monkeypatch.setattr(service, "analyze_face", _boom)
        r = client.post("/preview", json={"image": _photo_b64()})
        assert r.status_code == 200

    def test_assigns_a_session_id(self):
        """id 必須由伺服器配發：客戶端能自取的話，任何人都能猜到別人的
        session 並污染他的穩定度計數。"""
        from service import app as flask_app
        with flask_app.test_client() as c:
            body = c.post("/preview", json={"image": _photo_b64()}).get_json()
        assert re.fullmatch(r"[0-9a-f]{32}", body["sessionId"])

    def test_rejects_client_supplied_id_shape(self, client):
        """格式不對的 id 一律換發，不當成有效 session。"""
        body = client.post("/preview", json={"image": _photo_b64(),
                                             "sessionId": "../../etc/passwd"}).get_json()
        assert body["sessionId"] != "../../etc/passwd"
        assert re.fullmatch(r"[0-9a-f]{32}", body["sessionId"])

    def test_missing_image_is_not_an_error(self, client):
        r = client.post("/preview", json={})
        assert r.status_code == 200
        assert r.get_json()["ok"] is False

    def test_does_not_leak_landmarks_or_heavy_fields(self, client, monkeypatch):
        """landmarks 是可辨識的人體座標，而且每幀來回會吃掉現場的行動網路。"""
        monkeypatch.setattr(
            service, "get_clothing_features",
            lambda *a, **k: {
                "ok": True, "capture_ready_raw": True,
                "capture_quality": {"capture_checks": {}},
                "landmarks": [[0.1, 0.2, 0.9]] * 33,
                "cloth_grid": [[1, 2, 3]], "stencil": "x" * 1000,
                "body_poly": [[0, 0], [1, 1]], "regions": {"a": 1},
            },
        )
        body = client.post("/preview", json={"image": _photo_b64()}).get_json()
        for heavy in ("landmarks", "cloth_grid", "stencil", "body_poly", "regions"):
            assert heavy not in body, f"{heavy} 不該送到手機端"
        assert "stability_count" in body, "判定結果仍必須送出"
