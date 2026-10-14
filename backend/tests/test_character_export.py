"""匯出／匯入角色（主辦端「角色生成紀錄」的匯出按鈕）。

角色檔的用途是「程式可以直接跑」，所以這裡驗的是那條承諾：
外觀設定要通得過 shared/avatars.js 的 CV 驗證形狀、貼圖要能還原、
而來自別台電腦的角色檔不能決定寫到哪裡、寫進什麼。
"""

import base64
import io
import json
import os
import re

import pytest
from PIL import Image as PILImage

import service
from backend.character_export import (
    FORMAT,
    ExportError,
    build_bundle,
    image_png,
    load_or_sample_colors,
    restore_bundle,
)
from backend.slicer import slice_character
from backend.tests.test_slicer import make_figure, to_b64

ASSET_ID = "0123456789abcdef0123456789abcdef"
# 與 shared/avatars.js 的 TEXTURE_URL_RE 一字不差：角色檔的 textures 必須通過它
TEXTURE_URL_RE = re.compile(r"^/assets/gen/([0-9a-f]{32})/(head|torso|legs|full)\.webp$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def close_colors(a, b, tol=3):
    """重新取樣的顏色允許差幾個色階：貼圖是有損 WEBP，取樣來源不是生成當下那張 PNG。"""
    assert set(a) == set(b)
    for key in a:
        ca = [int(a[key][i:i + 2], 16) for i in (1, 3, 5)]
        cb = [int(b[key][i:i + 2], 16) for i in (1, 3, 5)]
        assert all(abs(x - y) <= tol for x, y in zip(ca, cb)), (key, a[key], b[key])
    return True


@pytest.fixture
def asset_root(tmp_path):
    slice_character(to_b64(make_figure()), str(tmp_path), ASSET_ID)
    return tmp_path


class TestBundle:
    def test_avatar_matches_client_join_shape(self, asset_root):
        bundle = build_bundle(str(asset_root), ASSET_ID)
        avatar = bundle["avatar"]
        assert bundle["format"] == FORMAT and bundle["version"] == 1
        assert avatar["source"] == "CV"
        assert set(avatar["textures"]) == {"head", "torso", "legs", "full"}
        for part, url in avatar["textures"].items():
            m = TEXTURE_URL_RE.match(url)
            assert m and m.group(1) == ASSET_ID and m.group(2) == part
        assert set(avatar["fallbackColors"]) == {"skin", "hair", "torso", "legs"}
        assert all(HEX_RE.match(v) for v in avatar["fallbackColors"].values())

    def test_files_are_embedded_so_another_machine_can_restore(self, asset_root):
        files = build_bundle(str(asset_root), ASSET_ID)["files"]
        assert {"head.webp", "torso.webp", "legs.webp", "full.webp", "preview.webp"} <= set(files)
        with PILImage.open(io.BytesIO(base64.b64decode(files["full.webp"]))) as img:
            assert img.format == "WEBP"

    def test_generation_metadata_is_carried_when_known(self, asset_root):
        run = {"created_at": 123.0, "model": "google/x", "style_id": "pixel", "mode": "full_character"}
        meta = build_bundle(str(asset_root), ASSET_ID, run)["generation"]
        assert meta == {"createdAt": 123.0, "model": "google/x", "styleId": "pixel", "mode": "full_character"}

    def test_slicing_now_persists_colors_json(self, asset_root):
        """生成當下就存顏色，匯出時不必重新取樣（也與回應裡的 fallbackColors 一致）。"""
        with open(asset_root / ASSET_ID / "colors.json", encoding="utf-8") as f:
            saved = json.load(f)
        assert build_bundle(str(asset_root), ASSET_ID)["avatar"]["fallbackColors"] == saved

    def test_old_assets_without_colors_are_resampled_and_cached(self, asset_root):
        colors_path = asset_root / ASSET_ID / "colors.json"
        expected = json.loads(colors_path.read_text(encoding="utf-8"))
        colors_path.unlink()
        assert close_colors(load_or_sample_colors(str(asset_root / ASSET_ID)), expected)
        assert colors_path.exists()

    def test_missing_texture_is_reported_not_silently_skipped(self, asset_root):
        os.remove(asset_root / ASSET_ID / "legs.webp")
        with pytest.raises(ExportError) as e:
            build_bundle(str(asset_root), ASSET_ID)
        assert e.value.code == "asset_incomplete"

    @pytest.mark.parametrize("bad", ["../etc", "ABC", "0123456789abcdef0123456789abcde/", ""])
    def test_asset_id_is_validated(self, asset_root, bad):
        with pytest.raises(ExportError) as e:
            build_bundle(str(asset_root), bad)
        assert e.value.code == "invalid_asset_id"

    def test_unknown_asset(self, asset_root):
        with pytest.raises(ExportError) as e:
            build_bundle(str(asset_root), "f" * 32)
        assert e.value.code == "asset_not_found"


class TestImage:
    def test_png_keeps_transparency(self, asset_root):
        with PILImage.open(io.BytesIO(image_png(str(asset_root), ASSET_ID))) as img:
            assert img.format == "PNG" and img.mode == "RGBA"
            assert img.getpixel((0, 0))[3] == 0

    def test_falls_back_to_full_when_no_preview(self, asset_root):
        os.remove(asset_root / ASSET_ID / "preview.webp")
        assert image_png(str(asset_root), ASSET_ID).startswith(b"\x89PNG")


class TestRestore:
    def test_round_trip(self, asset_root, tmp_path_factory):
        bundle = build_bundle(str(asset_root), ASSET_ID)
        target = tmp_path_factory.mktemp("other-machine")
        assert restore_bundle(bundle, str(target)) == ASSET_ID
        for name in ("head.webp", "torso.webp", "legs.webp", "full.webp", "preview.webp"):
            assert (target / ASSET_ID / name).read_bytes() == (asset_root / ASSET_ID / name).read_bytes()
        read = lambda root: json.loads((root / ASSET_ID / "colors.json").read_text(encoding="utf-8"))
        assert read(target) == read(asset_root)   # 顏色以角色檔帶的為準，不重新取樣

    def test_refuses_to_overwrite_unless_forced(self, asset_root):
        bundle = build_bundle(str(asset_root), ASSET_ID)
        with pytest.raises(ExportError) as e:
            restore_bundle(bundle, str(asset_root))
        assert e.value.code == "asset_exists"
        assert restore_bundle(bundle, str(asset_root), overwrite=True) == ASSET_ID

    def test_extra_file_names_are_ignored(self, asset_root, tmp_path_factory):
        """檔名走白名單：角色檔裡夾帶的路徑不能決定寫到哪裡。"""
        bundle = build_bundle(str(asset_root), ASSET_ID)
        bundle["files"]["../../evil.webp"] = bundle["files"]["full.webp"]
        target = tmp_path_factory.mktemp("other-machine")
        restore_bundle(bundle, str(target))
        assert not (target.parent / "evil.webp").exists()
        assert sorted(os.listdir(target)) == [ASSET_ID]

    def test_non_image_payload_is_rejected(self, asset_root, tmp_path_factory):
        bundle = build_bundle(str(asset_root), ASSET_ID)
        bundle["files"]["head.webp"] = base64.b64encode(b"<script>alert(1)</script>").decode()
        target = tmp_path_factory.mktemp("other-machine")
        with pytest.raises(ExportError) as e:
            restore_bundle(bundle, str(target))
        assert e.value.code == "bad_image"
        assert not (target / ASSET_ID).exists()

    @pytest.mark.parametrize("mutate,code", [
        (lambda b: b.update(format="something-else"), "not_a_character_file"),
        (lambda b: b.update(version=99), "unsupported_version"),
        (lambda b: b.update(assetId="../../x"), "invalid_asset_id"),
        (lambda b: b["files"].pop("torso.webp"), "asset_incomplete"),
    ])
    def test_malformed_bundles(self, asset_root, tmp_path_factory, mutate, code):
        bundle = build_bundle(str(asset_root), ASSET_ID)
        mutate(bundle)
        with pytest.raises(ExportError) as e:
            restore_bundle(bundle, str(tmp_path_factory.mktemp("other-machine")))
        assert e.value.code == code

    def test_bad_colors_are_resampled(self, asset_root, tmp_path_factory):
        bundle = build_bundle(str(asset_root), ASSET_ID)
        good = bundle["avatar"]["fallbackColors"]
        bundle["avatar"]["fallbackColors"] = {"skin": "red; background:url(x)"}
        target = tmp_path_factory.mktemp("other-machine")
        restore_bundle(bundle, str(target))
        assert close_colors(json.loads((target / ASSET_ID / "colors.json").read_text(encoding="utf-8")), good)


class TestEndpoints:
    @pytest.fixture
    def client(self, asset_root, monkeypatch):
        monkeypatch.setattr(service, "ASSET_DIR", str(asset_root))
        monkeypatch.setattr(service, "get_run", lambda rid: None)
        return service.app.test_client()

    def test_image_download(self, client):
        res = client.get(f"/api/dev/characters/{ASSET_ID}/image")
        assert res.status_code == 200 and res.mimetype == "image/png"
        assert "attachment" in res.headers["Content-Disposition"]

    def test_bundle_download(self, client):
        res = client.get(f"/api/dev/characters/{ASSET_ID}/bundle")
        assert res.status_code == 200
        assert res.get_json()["assetId"] == ASSET_ID
        assert res.headers["Content-Disposition"].endswith('.persona.json"')

    def test_unknown_asset_is_404(self, client):
        res = client.get(f"/api/dev/characters/{'f' * 32}/bundle")
        assert res.status_code == 404 and res.get_json()["error"] == "asset_not_found"
