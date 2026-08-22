"""log 分析工具的測試。

analyze_log.py / report_html.py 產出的是要寫進報告的效能數字。
數字算錯，報告就錯 —— 而這兩個檔案先前都零測試。
"""
import json
import os
import tempfile
import unittest

from backend.analyze_log import _load, _pct, analyze


class TestPct(unittest.TestCase):
    """百分位計算 —— p50 / p90 是報告的主要指標。"""

    def test_empty_returns_none(self):
        self.assertIsNone(_pct([], 50))

    def test_single_value(self):
        self.assertEqual(_pct([42], 50), 42)
        self.assertEqual(_pct([42], 90), 42)
        self.assertEqual(_pct([42], 100), 42)

    def test_p100_is_max(self):
        self.assertEqual(_pct([5, 1, 9, 3], 100), 9)

    def test_p0_is_min(self):
        self.assertEqual(_pct([5, 1, 9, 3], 0), 1)

    def test_input_order_does_not_matter(self):
        """輸入未排序也要得到相同結果（函式內部會排序）。"""
        vals = [30, 10, 50, 20, 40]
        self.assertEqual(_pct(vals, 50), _pct(sorted(vals), 50))
        self.assertEqual(_pct(vals, 90), _pct(sorted(vals, reverse=True), 90))

    def test_does_not_mutate_input(self):
        vals = [3, 1, 2]
        _pct(vals, 50)
        self.assertEqual(vals, [3, 1, 2], "不該就地排序呼叫端的 list")

    def test_result_is_always_a_member_of_input(self):
        """此實作為 nearest-rank，回傳值必為原始樣本之一（非內插）。"""
        vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        for p in (0, 25, 50, 75, 90, 99, 100):
            self.assertIn(_pct(vals, p), vals)

    def test_monotonic_across_percentiles(self):
        vals = list(range(1, 101))
        seq = [_pct(vals, p) for p in (0, 10, 25, 50, 75, 90, 100)]
        self.assertEqual(seq, sorted(seq), "百分位遞增時結果不可倒退")

    def test_index_never_out_of_range(self):
        for n in range(1, 12):
            vals = list(range(n))
            for p in (0, 50, 99, 100):
                _pct(vals, p)   # 不可 IndexError


class TestLoad(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def _write(self, name, lines):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        return path

    def test_reads_jsonl(self):
        p = self._write("a.jsonl", [json.dumps({"event": "x", "n": i}) for i in range(3)])
        self.assertEqual(len(_load([p])), 3)

    def test_skips_blank_lines(self):
        p = self._write("b.jsonl", ['{"event":"a"}', "", "   ", '{"event":"b"}'])
        self.assertEqual(len(_load([p])), 2)

    def test_malformed_line_does_not_abort_the_rest(self):
        """單行毀損不可讓整份 log 讀不出來 —— 現場 log 可能被中斷寫入。"""
        p = self._write("c.jsonl", ['{"event":"a"}', "{not json", '{"event":"b"}'])
        ev = _load([p])
        self.assertEqual(len(ev), 2)
        self.assertEqual([e["event"] for e in ev], ["a", "b"])

    def test_missing_file_is_skipped_not_fatal(self):
        self.assertEqual(_load([os.path.join(self.dir, "nope.jsonl")]), [])

    def test_multiple_files_are_concatenated(self):
        p1 = self._write("d1.jsonl", ['{"event":"a"}'])
        p2 = self._write("d2.jsonl", ['{"event":"b"}'])
        self.assertEqual(len(_load([p1, p2])), 2)


class TestAnalyze(unittest.TestCase):
    """analyze() 會直接 print 報告；此處確認各種輸入都不會炸掉。"""

    def test_empty_events(self):
        analyze([])   # 不可拋例外

    def test_events_without_latency_fields(self):
        analyze([{"event": "avatar_generated", "ok": True}])

    def test_computes_failure_rate(self):
        events = [{"event": "avatar_generated", "ok": True,  "latency_ms": 100},
                  {"event": "avatar_generated", "ok": False, "latency_ms": 200},
                  {"event": "avatar_generated", "ok": True,  "latency_ms": 150}]
        analyze(events)   # 1/3 失敗；此處確認不炸

    def test_unknown_event_types_are_ignored(self):
        analyze([{"event": "something_new", "foo": "bar"}])


class TestReportHtmlSharesImplementation(unittest.TestCase):
    """report_html 與 analyze_log 必須共用同一份 _load / _pct，否則會漂移。

    先前兩邊各有一份，report_html 的版本會靜默吞掉格式錯誤的 log 行。
    """

    def test_same_function_objects(self):
        from backend import analyze_log, report_html
        self.assertIs(report_html._pct, analyze_log._pct)
        self.assertIs(report_html._load, analyze_log._load)


if __name__ == "__main__":
    unittest.main()
