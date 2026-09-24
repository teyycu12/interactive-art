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
