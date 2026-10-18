"""素體換裝：生圖 API 不能用時，用預先畫好的部件在本機組角色。

幾個不這樣做會出事、但不會報錯的地方：
- 清單加了部件卻沒切圖層：手機選單上看不到它，沒人知道少了一個
- 眉毛、眼珠也是深棕色：跟著髮色換的話，金髮的人眉毛也是金的
- 無袖洋裝底下的 T 恤袖口：沒換成皮膚，肩膀上留兩塊灰
- 裙子底下露出的腿：照素體的膚色畫，要跟著參與者的膚色換
"""

import base64
import io

import numpy as np
import pytest
from PIL import Image as PILImage

import service
from backend import dressup
from backend.turnaround import find_figures

dressup_mod = dressup


def _luma(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _labels():
    return np.asarray(PILImage.open(dressup.LAYER_DIR / "_base_labels.png"))


def test_every_part_in_the_manifest_has_its_raw_and_layers():
    """manifest 加了一筆卻沒生成或沒切：catalog 會把它濾掉，手機上就是少一個選項。"""
    missing = []
    for part in dressup.load_manifest()["parts"]:
        for path in (dressup.RAW_DIR / f"{part['id']}.png",
                     dressup.LAYER_DIR / f"{part['id']}.png",
                     dressup.LAYER_DIR / f"{part['id']}_mask.png"):
            if not path.exists():
                missing.append(path.name)
    assert not missing, f"缺：{missing}（見 dressup/README.md）"


def test_every_part_uses_a_known_category():
    known = {c["id"] for c in dressup.load_manifest()["categories"]}
    assert {p["category"] for p in dressup.load_manifest()["parts"]} <= known
    assert set(dressup.CATEGORY_CODE) | {"acc"} == known, "新分類要在 dressup.py 補上代碼與繪製順序"


def test_catalog_has_no_prompts():
    """選單送到手機：生成用的 prompt 沒必要也不該外流。"""
    cat = dressup.catalog()
    assert cat["parts"] and all("prompt" not in p for p in cat["parts"])
    assert {c["id"] for c in cat["categories"]} >= {"hair", "top", "bottom", "acc"}


def test_request_keeps_only_known_parts_and_hex_colors():
    sel, col = dressup.clean_request(
        {"hair": "hair_long", "top": "bottom_skirt", "acc": ["acc_hat", "../etc", "hair_bun"]},
        {"hair": "#123456", "skin": "red", "acc": {"acc_hat": "#ABCDEF", "acc_scarf": "#000000"}},
    )
    assert sel == {"hair": "hair_long", "acc": ["acc_hat"]}, "部件要在清單裡、分類要對得上"
    assert col == {"hair": "#123456", "acc": {"acc_hat": "#ABCDEF"}}


def test_compose_gives_a_three_view_sheet():
    sheet = dressup.compose({"hair": "hair_long", "bottom": "bottom_skirt", "acc": ["acc_backpack"]})
    assert sheet.size == dressup.CANVAS
    assert len(find_figures(sheet)) == 3, "跟生成的三視圖同規格，後面的切圖才接得上"


def test_brows_and_eyes_are_not_hair():
    """素體的頭髮是每個人一整塊；眉毛、眼珠另成小塊的話，金髮的人眉毛也會變金。"""
    import cv2

    count, _ = cv2.connectedComponents((_labels() == dressup.C_HAIR).astype(np.uint8), connectivity=4)
    assert count - 1 == 3, f"頭髮分成 {count - 1} 塊（三個視角各一塊才對）"


def test_hair_color_follows_the_choice_but_brows_do_not():
    labels = _labels()
    light = np.asarray(dressup.compose({}, {"hair": "#E6D3A3"})).astype(float)
    dark = np.asarray(dressup.compose({}, {"hair": "#1E1A1C"})).astype(float)
    hair = labels == dressup.C_HAIR
    assert _luma(light[hair]).mean() > _luma(dark[hair]).mean() + 60
    # 眉毛、眼珠不在頭髮區：換髮色不動它們
    unchanged = (labels == dressup.C_FIXED)
    assert np.array_equal(light[unchanged], dark[unchanged])


def test_sleeveless_dress_leaves_no_grey_sleeves():
    """洋裝蓋掉上衣：素體 T 恤沒被蓋到的袖口要變成手臂，不能留兩塊灰。"""
    labels = _labels()
    out = np.asarray(dressup.compose({"bottom": "bottom_dress"}, {"skin": "#8D5524"})).astype(int)
    tee = out[labels == dressup.C_TOP]
    light_grey = (np.abs(tee - [205, 206, 210]).sum(axis=1) < 30)
    assert light_grey.sum() < len(tee) * 0.001, f"{light_grey.sum()} 格還是 T 恤的淺灰"


def test_bare_legs_under_a_skirt_follow_the_skin_tone():
    labels = _labels()
    legs = labels == dressup.C_BOTTOM   # 素體長褲的位置：裙擺以下這段變成腿
    pale = np.asarray(dressup.compose({"bottom": "bottom_skirt"}, {"skin": "#FFD9B8"})).astype(float)
    deep = np.asarray(dressup.compose({"bottom": "bottom_skirt"}, {"skin": "#5C3A21"})).astype(float)
    changed = np.abs(pale[legs] - deep[legs]).sum(axis=1) > 60
    assert changed.mean() > 0.2, "裙子底下的腿沒有跟著膚色換"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "ASSET_DIR", str(tmp_path))
    return service.app.test_client()


def test_catalog_endpoint(client):
    body = client.get("/dressup/catalog").get_json()
    assert body["ok"] and body["parts"]


def test_preview_is_just_the_front(client):
    body = client.post("/dressup", json={"preview": True, "selection": {"hair": "hair_bun"}}).get_json()
    assert body["ok"]
    img = PILImage.open(io.BytesIO(base64.b64decode(body["previewPng"].split(",", 1)[1])))
    assert img.height == service._DRESSUP_PREVIEW_HEIGHT
    assert img.width < img.height, "只有正面一個人"


def test_final_character_has_all_three_views(client):
    body = client.post("/dressup", json={
        "selection": {"hair": "hair_ponytail", "bottom": "bottom_shorts", "acc": ["acc_glasses"]},
        "colors": {"hair": "#B07A3E", "bottom": "#2F4C7A"},
    }).get_json()
    assert body["ok"] and body["source"] == "dressup"
    assert {"full", "side", "back"} <= set(body["textures"]), "走路、轉身要三面都有"


def test_garbage_request_still_makes_a_character(client):
    """手機送壞資料：不認得的全部忽略，照樣組出素體，不擋人進場。"""
    body = client.post("/dressup", json={"selection": "nope", "colors": [1, 2]}).get_json()
    assert body["ok"]
