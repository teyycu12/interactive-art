"""去背行為的回歸測試。

實測發現：生成出來的角色會頂著一大片白色背景出現在投影牆上，
torso 貼圖的不透明比例高達 99.4%。原因不是去背演算法本身，而是護盾遮罩：

  1. near_white = near_white & ~shield_mask 把護盾內的像素從「可走訪集合」
     移除，洪水填充只沿 near_white 前進，護盾因而成為一道牆，牆後的背景
     永遠到不了。護盾的用意是「別把這些像素挖成透明」，不是「別走過它們」。

  2. 更根本的問題：護盾依「輸入照片」的人體多邊形畫出，卻套用在「模型新
     生成的那張圖」上。兩張圖的構圖與比例毫無對應關係，實測預設中央框會
     蓋住生成圖的 35%，保護的幾乎全是背景。

白色衣物的保護改由連通性負責 —— 背景是連到畫面邊界的白，衣物上的白被
人偶包住，洪水填充本來就碰不到。

因此護盾參數保留但不再有任何作用（見 TestShieldDoesNotBlockTraversal 末段）。
"""

import base64
import io

import numpy as np
import pytest
from PIL import Image as I

from backend.garment_gen import _remove_white_background


def minifig(shirt=(40, 110, 180), w=400, h=520):
    """帶黑色輪廓線、手臂不觸邊的積木人偶，白底不透明。"""
    a = np.full((h, w, 4), 255, dtype=np.uint8)
    cx = w // 2

    def box(y0, y1, x0, x1, c, outline=(20, 20, 20)):
        a[y0:y1, x0:x1] = (*c, 255)
        a[y0:y0 + 4, x0:x1] = (*outline, 255)
        a[y1 - 4:y1, x0:x1] = (*outline, 255)
        a[y0:y1, x0:x0 + 4] = (*outline, 255)
        a[y0:y1, x1 - 4:x1] = (*outline, 255)

    box(30, 60, cx - 14, cx + 14, (230, 180, 130))     # 頸柱
    box(55, 165, cx - 58, cx + 58, (230, 180, 130))    # 頭
    box(165, 320, cx - 72, cx + 72, shirt)             # 軀幹
    box(180, 300, cx - 118, cx - 72, shirt)            # 左臂
    box(180, 300, cx + 72, cx + 118, shirt)            # 右臂
    box(300, 340, cx - 124, cx - 78, (235, 200, 40))   # 左手
    box(300, 340, cx + 78, cx + 124, (235, 200, 40))   # 右手
    box(320, 480, cx - 66, cx - 6, (35, 35, 35))       # 左腿
    box(320, 480, cx + 6, cx + 66, (35, 35, 35))       # 右腿
    return a


def alpha_of(arr, **kwargs):
    buf = io.BytesIO()
    I.fromarray(arr, "RGBA").save(buf, "PNG")
    out = _remove_white_background(base64.b64encode(buf.getvalue()).decode(), **kwargs)
    res = I.open(io.BytesIO(base64.b64decode(out))).convert("RGBA")
    return np.asarray(res)[:, :, 3]


class TestBackgroundIsRemoved:
    def test_corner_background_becomes_transparent(self):
        al = alpha_of(minifig())
        h, w = al.shape
        assert al[int(h * 0.05), int(w * 0.05)] == 0
        assert al[int(h * 0.05), int(w * 0.95)] == 0

    def test_figure_is_not_mostly_opaque(self):
        """回歸點：修復前生成的 torso 貼圖不透明比例高達 99.4%。"""
        al = alpha_of(minifig())
        assert (al > 200).mean() < 0.75

    def test_body_survives(self):
        al = alpha_of(minifig())
        h, w = al.shape
        assert al[int(h * 0.50), int(w * 0.50)] > 200, "軀幹不可被挖掉"
        assert al[int(h * 0.20), int(w * 0.50)] > 200, "頭部不可被挖掉"


class TestWhiteClothingSurvives:
    def test_white_shirt_is_preserved_by_connectivity(self):
        """白色衣物被人偶包住，連通性即可保住，不需要護盾。"""
        al = alpha_of(minifig(shirt=(255, 255, 255)))
        h, w = al.shape
        assert al[int(h * 0.50), int(w * 0.50)] > 200

    def test_white_shirt_case_still_removes_background(self):
        al = alpha_of(minifig(shirt=(255, 255, 255)))
        h, w = al.shape
        assert al[int(h * 0.05), int(w * 0.05)] == 0


class TestShieldDoesNotBlockTraversal:
    """護盾只能影響「挖不挖」，不能影響「走不走得過去」。"""

    def test_shield_over_background_still_lets_far_side_be_removed(self):
        arr = minifig()
        h, w = arr.shape[:2]
        # 一道橫貫整個寬度的護盾，把上下背景切開
        shield = np.zeros((h, w), dtype=bool)
        shield[int(h * 0.45):int(h * 0.55), :] = True

        al = alpha_of(arr, shield_mask=shield)
        # 護盾下方的角落背景仍必須被去掉 —— 修復前這裡會留著不透明
        assert al[int(al.shape[0] * 0.95), int(al.shape[1] * 0.05)] == 0

    def test_shield_is_ignored_entirely(self):
        """護盾完全不影響結果 —— 連「挖不挖」也不影響。

        本檔開頭那段診斷（護盾依輸入照片的人體多邊形畫出，卻套用在模型新生成
        的那張圖上）成立的話，結論不只是「別讓它擋住走訪」，而是它整個不該存在：

        護盾唯一的作用對象是「連得到畫面邊界的近白像素」，而那依定義就是背景。
        人偶本身既不近白、也連不到邊界，洪水填充本來就碰不到它，不需要保護。
        因此保留護盾等於保留背景 —— 正是 99.4% 不透明那個症狀。

        它的保護效益則要靠一個從輸入照片量出的遮罩，剛好蓋在生成圖上某件從
        輪廓缺口漏到邊界的白衣物，兩張圖沒有座標對應關係，這是巧合不是機制。

        對 20 張實際生成圖量測預設中央框（service.py 抓不到骨架時的退路）：
        覆蓋畫面 40.0%，其中屬於背景的比例平均 11.5%、最壞 65.3%。

        參數保留是為了相容既有呼叫端，行為上是 no-op。
        """
        arr = minifig()
        h, w = arr.shape[:2]
        shield = np.zeros((h, w), dtype=bool)
        shield[0:int(h * 0.15), 0:int(w * 0.15)] = True   # 蓋住左上角背景

        with_shield = alpha_of(arr, shield_mask=shield)
        without_shield = alpha_of(arr)
        assert np.array_equal(with_shield, without_shield), "護盾不得改變任何像素"
        assert with_shield[2, 2] == 0, "護盾蓋住的背景仍必須被挖掉"
