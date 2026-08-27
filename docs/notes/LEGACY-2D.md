# 2D 備援版的已知限制

> 由 [CLAUDE.md](../../CLAUDE.md) 拆出。這裡是踩過的坑與當初的取捨理由 ——
> 動到相關程式碼之前先讀，多數條目都附了「不這樣做會怎樣」。


- p5.js 大量角色時注意 `draw()` 效能，角色超過 50 個考慮用 `createGraphics()` 分層
- MediaPipe 在低光源環境偵測率下降，展示時確保場地光源足夠

### ⚠️ mediapipe 必須釘在 1.0 以下

`requirements.txt` 已指定 `mediapipe>=0.10.35,<1.0`，**不要放寬這個限制**。

1.0.1 在 macOS arm64 上初始化 Metal 失敗，以 absl CHECK 直接 `abort()`
整個行程（Pose 與 FaceLandmarker 皆然）：

```
F0000 graph_service.h:139] Check failed: service_ Service is unavailable.
    @ -[DrishtiMetalHelper initWithCalculatorContext:]
```

那是 C++ 層的 abort，Python 的 `try/except` **完全攔不到** ——
展場第一個人拍照，後端連同所有已連線客戶端與投影牆一起死。
單元測試也測不到（它們不會真的載入 MediaPipe），只有 `e2e_smoke.py` 會發現。
- Socket.io 預設 polling 模式，需設定強制 WebSocket：`{ transports: ['websocket'] }`

### ⚠️ 不要改用 eventlet / gevent（實測結論）

本文件早期版本建議「Socket 用 `eventlet` 或 `gevent`，不要用預設 thread」。
**實測後確認不可行**，目前刻意維持 `async_mode="threading"`：

gevent monkey-patch 之下 MediaPipe 會直接死鎖，連 `patch_all(thread=False)`
（保留真實 OS 執行緒）也一樣：

```
gevent.exceptions.LoopExit: This operation would block forever
```

原因是 MediaPipe 的原生 C++ 執行緒與綠色執行緒排程互不相容。切換過去會讓
整個感知層停擺 —— 比 threading 模式的連線上限更糟。

**已知代價**：Werkzeug 開發伺服器 + threading 在約 50 條並行 WebSocket 連線
時會開始崩潰（伺服器 log 出現 WebSocket 幀被當成 HTTP 解析的 400 錯誤）。
目前的因應方式是**降低所需連線數**而非提高上限：角色 id 已與連線脫鉤，
賓客關掉分頁角色仍留在場上（見 docs/INTERFACES.md §4），因此同時在線數只取決於
「正在拍照的人 + 投影牆」，不隨賓客總數成長。

### ⚠️ 投影牆目前不使用後端座標

`swarm_logic.py` 的 Boids 結果會推送給 `sketch.js`，但 `projection.html`
跑的是自己的一套本地 Boids，並未採用 `char.x` / `char.y`。
開關 `USE_SERVER_POSITIONS` 預設關閉，開啟前需在真實場館網路量測廣播抖動。
詳見 GitHub issue #8。

---

