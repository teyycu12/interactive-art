import pytest
from backend.app import app, socketio, _swarm_chars, _swarm_lock


@pytest.fixture(autouse=True)
def reset_swarm():
    """每個測試都從空的 _swarm_chars 開始，結束後還原原本內容。

    必須「清空」而非只是還原：app.py 在 import 時會呼叫 load_snapshot()，
    把 backend/data/swarm_snapshot.json 的內容載入 _swarm_chars。該檔案是
    正式執行時持久化的產物，內容取決於上一次跑過什麼 —— 只做前後還原的話，
    測試等於繼承了上一次執行留下的角色，斷言絕對數量的測試就會無故失敗
    （實測：一次 e2e 壓測留下 210 隻 bot，之後 bot 測試全部掛掉）。
    """
    with _swarm_lock:
        saved = dict(_swarm_chars)
        _swarm_chars.clear()
    try:
        yield
    finally:
        with _swarm_lock:
            _swarm_chars.clear()
            _swarm_chars.update(saved)


@pytest.fixture
def socketio_client():
    """提供 Socket.IO 測試客戶端實例。"""
    client = socketio.test_client(app)
    yield client
    if client.is_connected():
        client.disconnect()


@pytest.fixture
def flask_client():
    """提供 Flask HTTP 測試客戶端實例。"""
    with app.test_client() as client:
        yield client
