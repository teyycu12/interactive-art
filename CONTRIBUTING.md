# 組員工作規範

這份文件說明這個 repo 的開發規範。請在開始寫程式前讀完。

---

## 開發原則

**1. 每個模組要能獨立跑**
你的模組在沒有其他人的程式下也要能執行。用 mock 假資料驅動自己的模組，不要讓你的程式依賴別人的模組才能測試。

**2. 不要動別人的模組**
`modules/` 裡的每個檔案有明確負責人，沒有事先討論不要改別人的檔案。

**3. `config.py` 改動要先說**
這個檔案影響所有模組，改動前先在群組說一聲。

**4. 介面格式不能亂改**
`hand_tracker.py` 的 `get_hand_state()` 回傳格式是所有人的共同約定，一旦定了不能單方面修改。如果需要改，先開會討論。

---

## Git 工作流程

### 分支規則

```
main          ← 穩定版，只有整合測試過的程式才 merge 進來
dev           ← 開發主線，功能完成後從這裡 merge 到 main
feature/xxx   ← 每個人的工作分支
```

### 每個人的工作流程

```bash
# 1. 從 dev 開一個自己的分支
git checkout dev
git pull origin dev
git checkout -b feature/hand-tracker   # 分支命名：feature/你的模組名稱

# 2. 在自己的分支上開發
git add modules/hand_tracker.py
git commit -m "feat: 完成手部座標偵測與握拳判斷"

# 3. 推上去
git push origin feature/hand-tracker

# 4. 開 Pull Request 到 dev，讓 E 確認後 merge
```

### Commit 訊息格式

```
feat: 新增功能
fix: 修 bug
test: 新增或修改測試
docs: 更新文件
refactor: 重構，沒有改功能
```

範例：
```
feat: 完成 stroke_mapper 的速度到粗細映射
fix: 修正握拳判斷在低光源下誤判的問題
test: 新增 canvas 的獨立測試腳本
```

---

## 程式碼規範

### 檔案開頭一定要有說明

```python
"""
stroke_mapper.py
負責人：組員 C
功能：根據手部移動速度和 Z 軸深度，計算筆觸粗細與透明度
依賴：無（獨立模組，用 mock 資料測試）
"""
```

### Mock 資料放在 `if __name__ == "__main__":` 裡

```python
# 正確：獨立執行時用 mock 資料測試
if __name__ == "__main__":
    fake_speed = 300.0
    fake_z = 0.1
    result = compute_stroke(fake_speed, fake_z)
    print(result)
```

### 函式都要有型別提示和簡單說明

```python
def compute_stroke(speed: float, z: float) -> dict:
    """
    輸入移動速度和 Z 軸值，回傳筆觸參數。
    speed: 移動速度（px/s），正常範圍 50–800
    z: MediaPipe Z 值，範圍約 -0.3 ~ 0.3
    """
    ...
```

---

## 測試規範

每個人要在 `tests/` 資料夾寫一個測試腳本，命名為 `test_你的模組.py`。

測試腳本要能：
1. 不需要接 webcam 就能跑（用假資料）
2. 跑完後印出 PASS / FAIL
3. 測試邊界情況（速度為 0、速度超過上限等）

```python
# tests/test_stroke.py 範例架構
def test_normal_speed():
    result = compute_stroke(300.0, 0.0)
    assert 2 <= result["thickness"] <= 20, "粗細應在 2–20 範圍內"
    print("PASS: normal speed")

def test_zero_speed():
    result = compute_stroke(0.0, 0.0)
    assert result["thickness"] == 2, "速度為 0 時應為最細"
    print("PASS: zero speed")

if __name__ == "__main__":
    test_normal_speed()
    test_zero_speed()
    print("全部測試通過")
```

---

## 整合日（Day 4）規則

Day 4 由組員 E 負責整合，其他人的工作是：

1. 確保自己的模組在 `tests/` 測試腳本全部 PASS
2. 把分支 merge 到 `dev`（開 PR，E 審核後 merge）
3. 整合過程遇到問題隨時回應，不要讓 E 等超過 30 分鐘

---

## 遇到問題怎麼辦

**程式跑不起來**
先確認 `requirements.txt` 的套件都裝了，再確認 `config.py` 的設定是否正確。

**MediaPipe 安裝失敗**
```bash
pip install mediapipe --upgrade
# 如果還是失敗，試試：
pip install mediapipe==0.10.9
```

**webcam 找不到**
在 `config.py` 把 `CAM_INDEX` 從 `0` 改成 `1`，外接攝影機通常是 `1`。

**找不到路徑**
確認你是在 `interactive-art/` 這個資料夾下執行 `python main.py`，不是在子資料夾裡。
