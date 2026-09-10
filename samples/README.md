# 驗證用樣本照片

`photos/` 是 `backend/validate_cuts.py` 的輸入樣本（計畫書 §3.3 的 R1 切片比例驗收）：

```bash
python backend/validate_cuts.py --photos samples/photos/ --out samples/sprites/
python backend/validate_cuts.py --sprites samples/sprites/ --sheet report.png
```

**這裡不是測試套件。** 三套真正的測試各自在別處，不要跟這個目錄混淆：

| 路徑 | 內容 | 指令 |
|---|---|---|
| `test/` | Node 單元測試 | `npm test` |
| `backend/tests/` | Python | `pytest backend/` |
| `scripts/e2e.mjs` | 端對端 | `npm run test:e2e` |

這個目錄原本叫 `tests/`，與上表第一項只差一個字母，改名即為此。
