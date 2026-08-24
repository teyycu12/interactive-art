"""切片比例驗證工具的判準測試。

verdict() 是決策程式碼 —— 它的結論會決定要不要投入時間做偵測步驟，
所以門檻的行為必須被釘住，不能隨手改動。
"""

import numpy as np
import pytest
from PIL import Image as PILImage

from backend.slicer import CUTS, NORMALIZED_HEIGHT
from backend.validate_cuts import (
    MEAN_DRIFT_TOLERANCE,
    STD_BORDERLINE,
    STD_GOOD,
    _merge_parts,
    load_sprites,
    verdict,
)


def stats(shoulder_mean, shoulder_std, hip_mean, hip_std, samples=20):
    def block(m, s):
        return {"mean": m, "std": s, "min": m - s, "max": m + s}
    return {
        "samples": samples,
        "shoulder": block(shoulder_mean, shoulder_std),
        "hip": block(hip_mean, hip_std),
        "shoulders": [shoulder_mean] * samples,
        "hips": [hip_mean] * samples,
    }


# 與設定值對齊的平均，讓測試只針對標準差變化
ALIGNED_SHOULDER = CUTS["head"][1]
ALIGNED_HIP = CUTS["torso"][1]


class TestVerdict:
    def test_stable_samples_pass(self):
        s = stats(ALIGNED_SHOULDER, STD_GOOD / 2, ALIGNED_HIP, STD_GOOD / 2)
        assert verdict(s) == 0

    def test_borderline_spread_warns(self):
        spread = (STD_GOOD + STD_BORDERLINE) / 2
        s = stats(ALIGNED_SHOULDER, spread, ALIGNED_HIP, spread)
        assert verdict(s) == 1

    def test_high_spread_fails(self):
        s = stats(ALIGNED_SHOULDER, STD_BORDERLINE * 2, ALIGNED_HIP, STD_GOOD / 2)
        assert verdict(s) == 2

    def test_systematic_drift_fails_even_when_consistent(self):
        """每張都一致、但整體偏移 —— 只看標準差會漏掉這種情況。"""
        drifted = ALIGNED_SHOULDER + MEAN_DRIFT_TOLERANCE * 2
        s = stats(drifted, STD_GOOD / 10, ALIGNED_HIP, STD_GOOD / 10)
        assert verdict(s) == 2

    def test_too_few_samples_is_inconclusive(self):
        s = stats(ALIGNED_SHOULDER, 0.001, ALIGNED_HIP, 0.001, samples=1)
        assert verdict(s) == 1

    def test_thresholds_are_ordered(self):
        assert 0 < STD_GOOD < STD_BORDERLINE


class TestLoadSprites:
    def test_skips_fully_transparent_and_unreadable(self, tmp_path):
        PILImage.new("RGBA", (20, 20), (0, 0, 0, 0)).save(tmp_path / "blank.png")
        (tmp_path / "broken.png").write_bytes(b"not a png")
        solid = PILImage.new("RGBA", (20, 40), (120, 130, 90, 255))
        solid.save(tmp_path / "ok.png")

        loaded = load_sprites(str(tmp_path))
        assert [name for name, _ in loaded] == ["ok.png"]

    def test_empty_dir_returns_empty(self, tmp_path):
        assert load_sprites(str(tmp_path)) == []


class TestMergeParts:
    def test_roundtrip_restores_full_height(self, tmp_path):
        """三張貼圖疊回去的高度必須等於正規化高度，否則量測基準就歪了。"""
        for part, (top, bottom) in CUTS.items():
            h = round(bottom * NORMALIZED_HEIGHT) - round(top * NORMALIZED_HEIGHT)
            PILImage.new("RGBA", (200, h), (100, 100, 100, 255)).save(tmp_path / f"{part}.png")
        merged = _merge_parts(str(tmp_path))
        assert merged.size == (200, NORMALIZED_HEIGHT)
        assert np.asarray(merged)[:, :, 3].min() == 255
