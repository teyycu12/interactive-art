"""素體換裝：生圖 API 不能用時，用預先畫好的部件在本機組角色。

幾個不這樣做會出事、但不會報錯的地方：
- 清單加了部件卻沒切圖層：手機選單上看不到它，沒人知道少了一個
- 眉毛、眼珠也是深棕色：跟著髮色換的話，金髮的人眉毛也是金的
- 無袖洋裝底下的 T 恤袖口：沒換成皮膚，肩膀上留兩塊灰
- 裙子底下露出的腿：照素體的膚色畫，要跟著參與者的膚色換
"""

import base64
import io

import cv2
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


@pytest.mark.parametrize("base_id", [b["id"] for b in dressup.bases()])
def test_every_part_in_the_manifest_has_its_raw_and_layers(base_id):
    """manifest 加了一筆、或加了一個素體，卻沒生成或沒切：catalog 會把它濾掉，手機上就是少一個選項。"""
    missing = []
    for part in dressup.load_manifest()["parts"]:
        if part["category"] in dressup.FACE_CATEGORIES:
            continue   # 臉是格子圖，沒有原圖與圖層
        for path in (dressup.raw_dir(base_id) / f"{part['id']}.png",
                     dressup.layer_dir(base_id) / f"{part['id']}.png",
                     dressup.layer_dir(base_id) / f"{part['id']}_mask.png"):
            if not path.exists():
                missing.append(path.name)
    assert not missing, f"{base_id} 素體缺：{missing}（見 dressup/README.md）"


def test_every_part_uses_a_known_category():
    known = {c["id"] for c in dressup.load_manifest()["categories"]}
    assert {p["category"] for p in dressup.load_manifest()["parts"]} <= known
    assert set(dressup.CATEGORY_CODE) | {"acc"} | set(dressup.FACE_CATEGORIES) == known, \
        "新分類要在 dressup.py 補上代碼與繪製順序"


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


# ── 臉：表情、眉毛、眼珠顏色（格子圖，不是生圖）──────────────────


def _face():
    return dressup.load_manifest()["face"]


def _slot_mask(feature=None):
    """所有五官 slot 的範圍（feature 給了就只算那一種）。"""
    mask = np.zeros((dressup.CANVAS[1], dressup.CANVAS[0]), dtype=bool)
    for slots in _face()["slots"].values():
        for slot in slots.values():
            if feature is None or slot.get("feature") == feature:
                x0, y0, x1, y1 = slot["clear"]
                mask[y0:y1, x0:x1] = True
    return mask


def test_face_stamps_only_use_known_ink_and_slots():
    """格子圖寫錯一個字或 slot 名稱：那一格默默不畫，手機上看起來就是「選了沒反應」。"""
    face = _face()
    names = {n for slots in face["slots"].values() for n in slots}
    names |= {s["pair"] for slots in face["slots"].values() for s in slots.values() if s.get("pair")}
    for part in dressup.load_manifest()["parts"]:
        if part["category"] not in ("expression", "brows"):
            continue
        for view_id, drawn in part["stamp"].items():
            assert view_id in face["slots"], part["id"]
            for slot_id, rows in drawn.items():
                assert slot_id in names, f"{part['id']}：沒有 {slot_id} 這個位置"
                assert set("".join(rows)) <= set(face["ink"]) | {"."}, part["id"]
                # 左右翻的那一邊靠字串反轉：每一列不等長，翻過去就錯位
                assert len({len(r) for r in rows if r}) <= 1, f"{part['id']} {slot_id} 每列要一樣長"


def test_eye_color_changes_only_the_irises():
    base = np.asarray(dressup.compose({})).astype(int)
    blue = np.asarray(dressup.compose({}, {"eyes": "#2E6FB5"})).astype(int)
    changed = np.abs(base - blue).sum(axis=2) > 0
    assert changed.sum() > 200, "換眼珠顏色沒有作用"
    assert not (changed & ~_slot_mask("eyes")).any(), "換眼珠顏色動到眼睛以外的地方"


def test_each_eye_has_one_iris():
    """眼角那一格陰影跟眼珠亮部同色：也算進眼珠的話，藍眼的人眼角會發藍。"""
    import cv2

    labels = _labels()
    for slots in _face()["slots"].values():
        for slot in slots.values():
            if slot.get("feature") != "eyes":
                continue
            x0, y0, x1, y1 = slot["clear"]
            count, _ = cv2.connectedComponents((labels[y0:y1, x0:x1] == dressup.C_EYES).astype(np.uint8),
                                               connectivity=4)
            assert count - 1 == 1, f"眼睛 {slot['clear']} 的眼珠分成 {count - 1} 塊"


def test_expressions_and_brows_stay_on_the_face():
    base = np.asarray(dressup.compose({})).astype(int)
    for part in dressup.load_manifest()["parts"]:
        if part["category"] not in ("expression", "brows"):
            continue
        out = np.asarray(dressup.compose({part["category"]: part["id"]})).astype(int)
        changed = np.abs(base - out).sum(axis=2) > 0
        assert changed.any(), f"{part['id']} 畫上去跟素體一樣"
        assert not (changed & ~_slot_mask()).any(), f"{part['id']} 畫到五官以外的地方"


def test_closed_eyes_ignore_the_eye_color():
    """瞇眼笑的正面眼珠被抹掉：選什麼眼珠顏色，正面都一樣。"""
    front = (slice(0, dressup.CANVAS[1]), slice(0, 520))
    a = np.asarray(dressup.compose({"expression": "expr_joy"}, {"eyes": "#2E6FB5"}))[front]
    b = np.asarray(dressup.compose({"expression": "expr_joy"}, {"eyes": "#3E8E4F"}))[front]
    assert np.array_equal(a, b)


def test_brow_color_follows_the_choice_even_with_a_new_shape():
    labels_brow = _slot_mask("brows")
    light = np.asarray(dressup.compose({"brows": "brows_thick"}, {"brows": "#E6D3A3"})).astype(float)
    dark = np.asarray(dressup.compose({"brows": "brows_thick"}, {"brows": "#1E1A1C"})).astype(float)
    assert np.abs(light[labels_brow] - dark[labels_brow]).sum(axis=1).max() > 200


def test_face_request_is_cleaned_like_the_rest():
    sel, col = dressup.clean_request(
        {"expression": "expr_wink", "brows": "expr_joy", "eyes": "anything"},
        {"eyes": "#2E6FB5", "brows": "brown"},
    )
    assert sel == {"expression": "expr_wink", "acc": []}, "眉毛那格放了表情：分類對不上要丟掉"
    assert col == {"eyes": "#2E6FB5"}


def test_catalog_lists_the_face_tabs():
    cat = dressup.catalog()
    palettes = {c["id"]: c["palette"] for c in cat["categories"]}
    assert palettes["expression"] == "none" and palettes["eyes"] == "eye" and palettes["brows"] == "hair"
    assert not [p for p in cat["parts"] if p["category"] == "eyes"], "眼睛只換顏色，沒有款式"
    assert {"expression", "brows"} <= {p["category"] for p in cat["parts"]}


# ── 素體：男生、女生 ─────────────────────────────────────────


def _female():
    return next(b["id"] for b in dressup.bases()[1:])


def test_bases_share_the_face():
    """表情、眉毛、眼珠顏色是一套格子圖兩個素體共用：五官位置差一格，疊上去就歪了。"""
    ref = dressup.base_canvas()
    for b in dressup.bases()[1:]:
        img = dressup.base_canvas(base_id=b["id"])
        for slots in dressup.load_manifest()["face"]["slots"].values():
            for slot in slots.values():
                x0, y0, x1, y1 = slot["clear"]
                diff = np.abs(img[y0:y1, x0:x1].astype(int) - ref[y0:y1, x0:x1].astype(int)).sum(axis=2) > 60
                assert diff.mean() < 0.01, f"{b['id']} 的五官 {slot['clear']} 跟第一個素體差 {diff.mean():.0%}"


def test_bases_stand_where_the_first_one_stands():
    """三個人的位置、身高要一樣：前端切圖、大螢幕走路都照同一套比例。"""
    ref = find_figures(PILImage.fromarray(dressup.base_canvas()))
    for b in dressup.bases()[1:]:
        figs = find_figures(PILImage.fromarray(dressup.base_canvas(base_id=b["id"])))
        assert len(figs) == 3
        for (ax0, ax1, ay0, ay1), (bx0, bx1, by0, by1) in zip(ref, figs):
            assert abs(ay0 - by0) <= 3 and abs(ay1 - by1) <= 3, f"{b['id']} 身高跟第一個素體不同"


def test_long_hair_below_the_ears_is_hair():
    """女生素體披肩的長髮在正面被耳朵切開：耳朵以下那段也要跟著髮色換，不然金髮配一截棕髮。"""
    rgb = dressup.base_canvas(base_id=_female())
    labels = dressup.base_labels(rgb, dressup.load_manifest()["face"])
    x0, x1, y0, y1 = find_figures(PILImage.fromarray(rgb))[0]
    below_ears = (slice(y0 + int((y1 - y0) * 0.36), y0 + int((y1 - y0) * 0.48)), slice(x0, x1))
    a = rgb[below_ears].astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # 跟 base_labels 同一條髮色規則（臉的描邊紅多藍少超過 60，不算）
    hairish = (r > g) & (g >= b) & (r - b >= 6) & (r - b < 60) & (_luma(a.astype(float)) < 100)
    assert (labels[below_ears][hairish] == dressup.C_HAIR).mean() > 0.9


def test_tee_sides_are_not_trousers():
    """T 恤兩側那條深灰邊跟長褲同亮度：算成褲子的話，換紅褲子時 T 恤兩側也變紅。"""
    for b in dressup.bases():
        labels = dressup.base_labels(dressup.base_canvas(base_id=b["id"]), dressup.load_manifest()["face"])
        top = labels == dressup.C_TOP
        hem = np.where(top.any(axis=0), top.shape[0] - 1 - np.argmax(top[::-1], axis=0), -1)
        ys, xs = np.nonzero(labels == dressup.C_BOTTOM)
        assert not (ys <= hem[xs]).any(), f"{b['id']}：T 恤下擺以上有格子被算成褲子"


def test_short_hair_on_the_long_haired_base_shows_the_chosen_top():
    """女生素體換短髮：原本長髮蓋住的肩背露出 T 恤，要跟著選的上衣顏色，不能留成灰色。"""
    base_id = _female()
    if not dressup._usable({"id": "hair_short_curly", "category": "hair"}, base_id):
        pytest.skip("女生素體還沒有短捲髮")
    rgb = dressup.base_canvas(base_id=base_id)
    was_hair = dressup._base_label_map(base_id) == dressup.C_HAIR
    t = dressup._figure_rows(rgb.shape, find_figures(PILImage.fromarray(rgb)))
    out = np.asarray(dressup.compose({"hair": "hair_short_curly"}, {"top": "#C94F5C"}, base_id=base_id)).astype(int)
    zone = was_hair & (t >= 0.3) & (t < 0.8)
    px = out[zone]
    grey = (px.max(axis=1) - px.min(axis=1) <= 14) & (_luma(px.astype(float)) >= 150) & (px.min(axis=1) <= 236)
    assert grey.mean() < 0.02, f"肩背上還有 {grey.mean():.1%} 是 T 恤的灰"


PONYTAIL_LOOK = {"hair": "hair_ponytail", "outer": "top_hoodie", "acc": ["acc_backpack", "acc_crossbody"]}


def test_background_shut_in_by_a_ponytail_is_a_hole():
    """長髮換馬尾：馬尾、脖子、背包圍住的那塊背景要挖透明（去背從圖邊清，走不到），眼白不能挖。"""
    for base_id in [b["id"] for b in dressup.bases()]:
        img, holes = dressup.compose(PONYTAIL_LOOK, {}, base_id=base_id, with_holes=True)
        rgb = np.asarray(img)
        base = dressup.base_canvas(base_id=base_id)
        eye_whites = (base.min(axis=2) > dressup.WHITE) & ~dressup._base_outside(base_id)
        # 被圍住的白：連不到圖邊（去背清不到）、又不是眼白。部件本身一兩格的白色高光不算，只看成塊的
        shut_in = (rgb.min(axis=2) > dressup.WHITE) & ~dressup._outside(rgb) & ~eye_whites & ~holes
        _, _, stats, _ = cv2.connectedComponentsWithStats(shut_in.astype(np.uint8), connectivity=4)
        blobs = stats[1:, cv2.CC_STAT_AREA]
        assert (blobs < 60).all(), f"{base_id}：還有 {blobs.max()} 格一塊的白色背景沒挖掉"
        assert not (holes & eye_whites).any(), f"{base_id}：眼白被當成背景"


def test_hoodie_fills_where_the_long_hair_was():
    """女生素體的外套原圖裡肩背被長髮蓋著沒畫到：換馬尾後那裡要是外套的顏色，不能露出白 T 恤。"""
    base_id = _female()
    rgb = dressup.base_canvas(base_id=base_id)
    was_hair = dressup._base_label_map(base_id) == dressup.C_HAIR
    t = dressup._figure_rows(rgb.shape, find_figures(PILImage.fromarray(rgb)))
    img, holes = dressup.compose({"hair": "hair_ponytail", "outer": "top_hoodie"},
                                 {"outer": "#2F6FD0", "top": "#F4F4F4"}, base_id=base_id, with_holes=True)
    px = np.asarray(img).astype(int)[was_hair & ~holes & (t >= 0.3) & (t < 0.8)]
    tee = (px.max(axis=1) - px.min(axis=1) <= 14) & (px.min(axis=1) >= 200)
    assert tee.mean() < 0.02, f"肩背上還有 {tee.mean():.1%} 是白 T 恤"


def test_preview_shows_only_the_front_figure():
    """側面那個人的馬尾、包包伸進正面預覽的框裡：要洗掉，不能在換裝頁右邊留一條。"""
    for base_id in [b["id"] for b in dressup.bases()]:
        img, _ = dressup.compose_front(PONYTAIL_LOOK, {}, base_id=base_id)
        assert len(find_figures(img)) == 1, base_id


def test_unknown_base_falls_back_to_the_first():
    """舊版手機不送 base：照以前用第一個素體（男生）。"""
    assert dressup.clean_base(None) == dressup.default_base()
    assert dressup.clean_base("../etc") == dressup.default_base()
    assert dressup.clean_base(_female()) == _female()


def test_catalog_lists_bases_and_where_each_part_is_drawn():
    cat = dressup.catalog()
    assert [b["id"] for b in cat["bases"]] == [b["id"] for b in dressup.bases()]
    clothes = [p for p in cat["parts"] if p["category"] not in dressup.FACE_CATEGORIES]
    assert clothes and all(p["bases"] for p in clothes)
    faces = [p for p in cat["parts"] if p["category"] in dressup.FACE_CATEGORIES]
    assert all(set(p["bases"]) == {b["id"] for b in dressup.bases()} for p in faces), "臉兩個素體共用"


def test_part_missing_on_a_base_is_ignored(monkeypatch):
    """某個素體還沒畫好的部件：手機送來也不能拿另一個素體的圖層硬疊（位置、身形都不同）。"""
    base_id = _female()
    real = dressup._usable
    monkeypatch.setattr(dressup, "_usable",
                        lambda part, b=None: False if part["id"] == "hair_bun" and b == base_id else real(part, b))
    sel, _ = dressup.clean_request({"hair": "hair_bun"}, {}, base_id)
    assert "hair" not in sel
    plain = np.asarray(dressup.compose({}, base_id=base_id))
    assert np.array_equal(np.asarray(dressup.compose({"hair": "hair_bun"}, base_id=base_id)), plain)


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


def test_final_female_character(client):
    body = client.post("/dressup", json={"base": _female(), "selection": {"hair": "hair_bun"}}).get_json()
    assert body["ok"] and {"full", "side", "back"} <= set(body["textures"])


def test_garbage_request_still_makes_a_character(client):
    """手機送壞資料：不認得的全部忽略，照樣組出素體，不擋人進場。"""
    body = client.post("/dressup", json={"selection": "nope", "colors": [1, 2]}).get_json()
    assert body["ok"]
