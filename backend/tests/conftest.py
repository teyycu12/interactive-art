import pytest
from backend.app import app, socketio, _swarm_chars, _swarm_lock


@pytest.fixture(autouse=True)
def reset_swarm():
    """每個測試前後快照並還原 _swarm_chars，避免測試間全域狀態污染。"""
    with _swarm_lock:
        snapshot = dict(_swarm_chars)
    yield
    with _swarm_lock:
        _swarm_chars.clear()
        _swarm_chars.update(snapshot)


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
