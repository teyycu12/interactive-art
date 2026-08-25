import unittest
from backend.app import app, socketio, _swarm_chars, _swarm_lock


@unittest.skipIf(socketio is None or app is None, "Flask/SocketIO not installed in current environment")
class TestSocketIOHandlers(unittest.TestCase):
    # 投影牆的角色比例來自固定站位身高量測，因此 join_swarm 會擋掉沒量到的角色
    # （見 handle_join_swarm）。以下 payload 都必須帶上這兩個欄位才進得去。
    HEIGHT_OK = {"height_measurement_valid": True, "height_class": "medium"}

    def setUp(self):
        self.client = socketio.test_client(app)
        self.assertTrue(self.client.is_connected())

    def tearDown(self):
        if self.client.is_connected():
            self.client.disconnect()

    def test_connect_and_server_message(self):
        received = self.client.get_received()
        events = [msg["name"] for msg in received]
        self.assertIn("server_message", events)

    def test_join_swarm_and_swarm_joined(self):
        payload = {
            "id": "test_user_01",
            "x": 100.0,
            "y": 200.0,
            "upper": {"hex": "#FF0000"},
            "lower": {"hex": "#0000FF"},
            "room": "main_hall",
            **self.HEIGHT_OK,
        }
        self.client.emit("join_swarm", payload)
        received = self.client.get_received()
        joined_events = [msg for msg in received if msg["name"] == "swarm_joined"]
        self.assertEqual(len(joined_events), 1)
        self.assertEqual(joined_events[0]["args"][0]["id"], "test_user_01")
        self.assertEqual(joined_events[0]["args"][0]["room"], "main_hall")

        with _swarm_lock:
            self.assertIn("test_user_01", _swarm_chars)
            self.assertEqual(_swarm_chars["test_user_01"]["upper"]["hex"], "#FF0000")

    def test_join_swarm_rejects_missing_height_measurement(self):
        """沒有有效身高量測的角色不得進場。

        角色比例由固定站位的身高等級決定；沒量到就放行的話，牆上會出現以
        預設比例混進去的角色，而現場無從分辨那是量測失敗還是真實體型。
        """
        self.client.emit("join_swarm", {"id": "no_height_user", "x": 1, "y": 1})
        received = self.client.get_received()
        names = [msg["name"] for msg in received]
        self.assertIn("swarm_join_failed", names)
        self.assertNotIn("swarm_joined", names)
        failed = [m for m in received if m["name"] == "swarm_join_failed"][0]
        self.assertEqual(failed["args"][0]["error"], "valid_height_measurement_required")
        with _swarm_lock:
            self.assertNotIn("no_height_user", _swarm_chars)

    def test_get_swarm(self):
        self.client.emit("get_swarm", {"room": "default"})
        received = self.client.get_received()
        pos_events = [msg for msg in received if msg["name"] == "update_positions"]
        self.assertGreaterEqual(len(pos_events), 1)
        chars = pos_events[0]["args"][0]["characters"]
        self.assertIsInstance(chars, list)

    def test_update_character(self):
        with _swarm_lock:
            _swarm_chars["update_user"] = {"id": "update_user", "upper": {"hex": "#111111"}}

        self.client.emit("update_character", {"id": "update_user", "upper": {"hex": "#999999"}})
        with _swarm_lock:
            self.assertEqual(_swarm_chars["update_user"]["upper"]["hex"], "#999999")

    def test_leave_swarm(self):
        with _swarm_lock:
            _swarm_chars["leaving_user"] = {"id": "leaving_user"}

        self.client.emit("leave_swarm", {"id": "leaving_user"})
        with _swarm_lock:
            self.assertNotIn("leaving_user", _swarm_chars)

    def test_get_swarm_subscribes_to_room_broadcast(self):
        """純觀看端 emit get_swarm 後，必須收得到 room-scoped 的週期廣播。

        回歸測試：投影牆只 emit get_swarm、從不 join_swarm，因此原本不在任何
        room 裡。而 _swarm_background 的廣播是 socketio.emit(..., room=...)，
        導致投影牆在開頭兩次之後再也收不到更新，前端 watchdog 於是在連線
        完全正常的情況下永久亮紅燈。
        """
        self.client.emit("get_swarm", {"room": "default"})
        self.client.get_received()  # 清掉 get_swarm 自己的直接回覆

        # 模擬 _swarm_background 的 room-scoped 廣播
        socketio.emit("update_positions",
                      {"characters": [{"id": "probe", "x": 1.0, "y": 2.0}]},
                      room="default")

        received = self.client.get_received()
        pos_events = [msg for msg in received if msg["name"] == "update_positions"]
        self.assertGreaterEqual(
            len(pos_events), 1,
            "get_swarm 之後未收到 room-scoped 廣播 —— 觀看端沒有被加入 room",
        )
        self.assertEqual(pos_events[0]["args"][0]["characters"][0]["id"], "probe")

    def test_character_persists_after_disconnect(self):
        """賓客關掉分頁後，角色必須留在場上。

        回歸測試：角色 id 原本沿用 socket sid，handle_disconnect 會把
        sid 對應的角色 pop 掉 —— 賓客拍完照關分頁，作品就少一個人。
        這同時也是承載量問題：若角色綁在連線上，N 位賓客就需要 N 條長連線，
        而傳輸層約 50 條就會開始崩潰。
        """
        c = socketio.test_client(app)
        c.emit("join_swarm", {"x": 100, "y": 100,
                              "upper": {"hex": "#ABCDEF"},
                              "lower": {"hex": "#123456"},
                              **self.HEIGHT_OK})
        joined = [m for m in c.get_received() if m["name"] == "swarm_joined"]
        self.assertEqual(len(joined), 1)
        char_id = joined[0]["args"][0]["id"]

        with _swarm_lock:
            self.assertIn(char_id, _swarm_chars)

        c.disconnect()

        with _swarm_lock:
            self.assertIn(char_id, _swarm_chars,
                          "角色在連線中斷後消失了")

    def test_rejoin_with_same_id_does_not_duplicate(self):
        """帶著原本的 id 重新連線應認領同一個角色，而不是產生分身。"""
        c1 = socketio.test_client(app)
        c1.emit("join_swarm", {"x": 1, "y": 1, "upper": {"hex": "#111111"},
                               **self.HEIGHT_OK})
        char_id = [m for m in c1.get_received()
                   if m["name"] == "swarm_joined"][0]["args"][0]["id"]
        c1.disconnect()

        with _swarm_lock:
            before = len(_swarm_chars)

        c2 = socketio.test_client(app)
        c2.emit("join_swarm", {"id": char_id, "x": 2, "y": 2,
                               "upper": {"hex": "#222222"}, **self.HEIGHT_OK})
        c2.disconnect()

        with _swarm_lock:
            self.assertEqual(len(_swarm_chars), before, "重新連線產生了分身")
            self.assertEqual(_swarm_chars[char_id]["upper"]["hex"], "#222222")

    def test_inject_and_remove_bots_events(self):
        self.client.emit("inject_bots", {"count": 4, "room": "default"})
        with _swarm_lock:
            bots = [c for c in _swarm_chars.values() if c.get("is_bot") or c["id"].startswith("bot_")]
            self.assertEqual(len(bots), 4)

        self.client.emit("remove_bots", {})
        with _swarm_lock:
            bots = [c for c in _swarm_chars.values() if c.get("is_bot") or c["id"].startswith("bot_")]
            self.assertEqual(len(bots), 0)


if __name__ == "__main__":
    unittest.main()
