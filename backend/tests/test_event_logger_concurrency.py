"""event_logger 的並發寫入測試。

log_event 會同時被多個來源呼叫：socket handler（每條連線一個執行緒）、
_swarm_background 背景迴圈、以及 ThreadPoolExecutor 的 worker。
這份 JSONL 正是效能報告的資料來源，毀損卻不自知是最糟的情況。

**這些測試涵蓋什麼、不涵蓋什麼（實測後修正的認知）**

原本以為它們能證明 `_lock` 有在防止「寫入交錯」。實測後確認**不能**：
把 log_event 的鎖拿掉，即使 12 條執行緒、每筆 256KB，仍然 480/480 行完整、
零毀損。原因是 CPython 的 BufferedWriter 本身在 GIL 之下就具備原子性。

`_lock` 真正保護的是 `_ensure_fh` 裡的檔案 handle 管理（它的 docstring 也
明說「呼叫端須持有 _lock」）：跨日輪替時會關閉舊 handle、重開新的，並改寫
兩個模組層級全域。沒有鎖的話兩條執行緒可能同時輪替 —— 重複關閉、handle
洩漏，或寫入已關閉的 handle。test_rotation_under_concurrency 針對的是這件事。

其餘測試守住的是可觀察的產出性質（不遺失、可解析、pid 唯一），
這些性質即使 CPython 的原子性保證改變，也仍然是我們要的。
"""
import glob
import json
import os
import shutil
import tempfile
import threading
import unittest

from backend.event_logger import log_event, set_log_dir


class TestEventLoggerConcurrency(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        set_log_dir(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _read_lines(self):
        lines = []
        for path in glob.glob(os.path.join(self.dir, "*.jsonl")):
            with open(path, encoding="utf-8") as fh:
                lines.extend(l for l in (x.strip() for x in fh) if l)
        return lines

    def test_concurrent_writes_produce_no_corrupt_lines(self):
        N_THREADS, PER_THREAD = 12, 60

        def worker(tid):
            for i in range(PER_THREAD):
                # 帶入較長的欄位，提高交錯時被察覺的機率
                log_event("avatar_generated", pid=f"t{tid}-{i}",
                          latency_ms=1234, mode="body_sprite",
                          note="x" * 200)

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(N_THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        lines = self._read_lines()
        self.assertEqual(len(lines), N_THREADS * PER_THREAD,
                         "行數不符 —— 有事件遺失或被寫成同一行")

        pids = set()
        for idx, line in enumerate(lines, 1):
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                self.fail(f"第 {idx} 行不是合法 JSON（寫入交錯）：{e}\n{line[:120]}")
            pids.add(rec["pid"])

        self.assertEqual(len(pids), N_THREADS * PER_THREAD,
                         "pid 不唯一 —— 有事件被覆蓋或重複")

    def test_every_line_is_a_single_complete_record(self):
        """每一行都必須剛好是一筆記錄：不可有半行，也不可兩筆黏在一起。"""
        def worker(tid):
            for i in range(40):
                log_event("swarm_summary", swarm_size=tid * 100 + i)

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        for line in self._read_lines():
            self.assertTrue(line.startswith("{") and line.endswith("}"),
                            f"行首尾不完整（交錯的徵兆）：{line[:120]}")
            self.assertEqual(line.count("\n"), 0)
            json.loads(line)   # 不可拋例外

    def test_concurrent_writes_are_all_parseable_by_analyze_log(self):
        """並發寫出的 log 必須能被 analyze_log 完整讀回，不觸發毀損提示。"""
        from backend.analyze_log import _load

        def worker(tid):
            for i in range(30):
                log_event("avatar_generated", pid=f"c{tid}-{i}",
                          ok=True, latency_ms=1000 + i)

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        paths = glob.glob(os.path.join(self.dir, "*.jsonl"))
        events = _load(paths)
        self.assertEqual(len(events), 6 * 30,
                         "analyze_log 讀回的事件數不符 —— 報告數字會因此失準")


    def test_rotation_under_concurrency(self):
        """跨日輪替與並發寫入同時發生時，不可遺失事件或寫入已關閉的 handle。

        這是 _lock 真正保護的競爭：_ensure_fh 會關閉舊 handle、開新檔並改寫
        兩個模組層級全域。此處讓日期在多執行緒寫入期間反覆翻動，逼出該路徑。
        """
        import backend.event_logger as el

        stop = threading.Event()

        def rotator():
            i = 0
            while not stop.is_set():
                with el._lock:
                    el._current_date_str = f"forced{i % 3}"
                i += 1

        def writer(tid):
            for i in range(80):
                log_event("avatar_generated", pid=f"r{tid}-{i}", latency_ms=i)

        rot = threading.Thread(target=rotator, daemon=True)
        rot.start()
        threads = [threading.Thread(target=writer, args=(t,)) for t in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        stop.set()
        rot.join(timeout=2)

        lines = self._read_lines()
        self.assertEqual(len(lines), 8 * 80,
                         "輪替期間有事件遺失 —— handle 管理未被正確保護")
        pids = set()
        for line in lines:
            pids.add(json.loads(line)["pid"])   # 不可拋例外
        self.assertEqual(len(pids), 8 * 80, "輪替期間有事件重複或被覆蓋")


if __name__ == "__main__":
    unittest.main()
