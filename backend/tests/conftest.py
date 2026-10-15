import pytest


@pytest.fixture(autouse=True)
def no_outbound_uploads(monkeypatch):
    """測試一律不上傳到公開圖床。

    `photo_composer.compose_group_photo()` 每次都會呼叫 `upload_photo()`，
    而它在 `IMGBB_API_KEY`（或 `IMGUR_CLIENT_ID`）存在時會真的把合成出來的
    圖片 POST 到公開圖床。開發者本機的 .env 通常設了那把金鑰，於是：

      - 跑一次合照測試就往 imgbb 丟十幾張圖，而且是**公開可存取的 URL**
      - 那些圖是測試用的合成畫面，但同一條路徑在正式執行時上傳的是
        參與者的合照 —— 測試與正式共用同一組憑證與同一個帳號配額
      - 測試因此依賴外部網路，離線時變慢、圖床故障時可能變成偶發失敗

    CI 上沒有金鑰所以一直看不出來（`_upload_imgbb` 直接 return None），
    這是典型的「只在開發者機器上發生」的副作用。

    這裡把兩個環境變數清掉即可 —— 不改動 `upload_photo` 本身，
    真正需要驗證上傳邏輯的測試仍可自行 monkeypatch。
    """
    monkeypatch.delenv("IMGBB_API_KEY", raising=False)
    monkeypatch.delenv("IMGUR_CLIENT_ID", raising=False)


@pytest.fixture(autouse=True)
def no_paid_image_calls(monkeypatch):
    """測試一律打不到付費的生圖 API。

    與上面的圖床同一類「只在開發者機器上發生」的副作用，而且這個會花錢：
    garment_gen 在呼叫當下才讀 OPENAI_API_KEY，開發機的 .env 設了真金鑰，
    於是任何一支忘了替換 generate_full_character_png 的 /generate 測試都會
    真的生一張圖（2026-10-13 就有一支，每跑一次套件付一次錢，測試照樣是綠的）。

    清掉金鑰並丟掉已快取的 client，漏替換的測試會拿到 openai_unavailable，
    而不是一張帳單。兩個模組名都要處理（見 GENERATION.md「雙重匯入路徑的陷阱」）。
    """
    import sys
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    for name in ("garment_gen", "backend.garment_gen"):
        mod = sys.modules.get(name)
        if mod is not None:
            monkeypatch.setattr(mod, "_client", None)


@pytest.fixture(autouse=True)
def isolate_history(tmp_path, monkeypatch):
    """生成紀錄一律導到暫存目錄。

    原本每跑一次就往正式的 backend/logs 寫十幾筆假紀錄，主辦端的「角色生成紀錄」
    與成功率會把它們當成真的現場失敗。這段原本只在 test_service.py 裡，
    後來的 test_turnaround.py 也打 /generate 卻不在它的範圍內，每跑一次又寫兩筆 ——
    所以放在 conftest，所有測試都套用。

    service 以 `from generation_history import ...` 匯入，pytest 底下
    `generation_history` 與 `backend.generation_history` 可能是兩個不同的模組物件
    （同 style_registry 的坑），兩個都改；不在這裡 import，是為了不讓每支測試都
    載入一次生成服務。
    """
    import sys
    for name in ("generation_history", "backend.generation_history"):
        mod = sys.modules.get(name)
        if mod is not None:
            monkeypatch.setattr(mod, "_DB_PATH", tmp_path / "history.sqlite3")
            monkeypatch.setattr(mod, "_OUTPUT_DIR", tmp_path / "history_generated")
            monkeypatch.setattr(mod, "_INPUT_DIR", tmp_path / "history_inputs")
