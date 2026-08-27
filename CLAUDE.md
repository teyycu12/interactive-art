# 數位轉譯角色空間互動系統 - Claude Code 專案說明

將實體穿著透過視覺識別數位化、轉譯為插畫角色，在公共空間中以群體演算法生成
集體共創視覺圖。已與 PersonaFlow2（Node.js 互動層）整合為單一展場作品。
依 v4.0 計畫書：**PF2 為主幹**，CV/VLM/生圖管線退為角色資產生成服務。

**校內實測期限：2026/9/30**

## 兩套系統並存，不要混淆

| | 整合版（主線） | 2D 備援（保留，不要刪） |
|---|---|---|
| 互動層 | `server/`（Node.js + ws） | `backend/app.py`（Flask + Socket.io） |
| 前端 | `public/`（controller / screen / host） | `frontend/`（p5.js + PixiJS） |
| 群聚 | `server/` 的 M2 α 仲裁 + Boids | `backend/swarm_logic.py` |
| 啟動 | `bash start.sh` | `bash start-2d.sh` |

備援版是「3D 若來不及仍能完成實測」的保險，整套測試都還在跑，**請勿刪除**。

## 技術架構

| 層級 | 技術 | 職責 |
|------|------|------|
| 感知層 | Python + MediaPipe / OpenCV | 服裝色調、輪廓、姿勢提取 |
| 生成層 | Python + Gemini / 生圖 API | 去背人偶圖生成、切片成三張貼圖 |
| 互動層 | Node.js + ws | α 仲裁共治、任務、配對、問答、計分、社交圖譜 |
| 渲染層 | Three.js 3D 場景 + Canvas2D 角色圖層 | 角色與場景呈現 |
| 輸出層 | Python + Pillow | 大合照生成、QR Code |

## 快速啟動

```bash
npm install && pip install -r requirements.txt requirements-dev.txt
bash start.sh          # 生成服務 :5055 + 互動層 :3000（偵測到 certs/ 自動走 HTTPS）
npm test               # Node 330+5    npm run test:e2e   # 端對端 126
pytest backend/        # Python 472    node --test frontend/tests/   # 2D 前端 4
```

完整指令（壓測機器人、切片驗證、憑證產生、關閉服務）見
[docs/notes/COMMANDS.md](docs/notes/COMMANDS.md) 與
[docs/notes/LOCAL-PREVIEW.md](docs/notes/LOCAL-PREVIEW.md)。

## 開發規範

- **Python** snake_case，回傳統一 JSON；**JavaScript** 類別用 PascalCase
- **Socket 事件**動詞_名詞（`update_positions`、`new_character`）
- **不要**在 `sketch.js` 寫業務邏輯，只放渲染

## 動手之前：先讀對應的那一份

這個專案有大量「不這樣做會出事，但不會報錯」的耦合與取捨。踩過的坑都記在
`docs/notes/`，**改到相關程式碼之前先讀該檔**，多數條目附了「不這樣做會怎樣」。

| 你要動的東西 | 先讀 |
|---|---|
| 專案佈局、某個檔案放哪 | [STRUCTURE.md](docs/notes/STRUCTURE.md) |
| Boids、M1–M3 里程碑 | [CONVENTIONS.md](docs/notes/CONVENTIONS.md) |
| 風格、VLM、切片、貼圖、手機同步 | [GENERATION.md](docs/notes/GENERATION.md) |
| 場館網路、TLS 憑證、生成耗時、震動 | [FIELD-OPS.md](docs/notes/FIELD-OPS.md) |
| `server/`、測試、`IDLE_MOTION`、人數上限 | [SERVER-AND-TESTS.md](docs/notes/SERVER-AND-TESTS.md) |
| 尋寶、COLOR_HUNT、分區、任何新玩法 | [INTERACTION-DESIGN.md](docs/notes/INTERACTION-DESIGN.md) |
| `backend/app.py`、`frontend/`、mediapipe | [LEGACY-2D.md](docs/notes/LEGACY-2D.md) |

其中三條最常被違反、後果也最貴：

1. **切片比例是跨語言耦合** —— `backend/slicer.py` 的 `CUTS` 與
   `shared/avatars.js` 的 `CV_CUTS` 必須完全一致，對不上時角色會脖子錯位或
   腿被壓扁，**而且兩邊都不會報錯**。
2. **前端相依一律由 node_modules 直出，不走 CDN** —— 展場網路不通時整個 3D
   背景會消失，而那是**本機永遠測不出來的故障**。
3. **新增玩法先問：通關路徑上有沒有一步必須跟另一個人講話？** 沒有的話，
   再好玩都會讓現場更安靜（普通尋寶已據此否決，見 INTERACTION-DESIGN）。

**掃描失敗一律降級，不擋人進場**：相機權限被拒、非安全情境、生成失敗、
生成服務未啟動 —— 全部退回捏臉。捏臉是刻意保留的備援路徑，**不要移除**。

其他文件：[docs/INTERFACES.md](docs/INTERFACES.md)（事件與 payload 規格）、
[docs/PRD.md](docs/PRD.md)、[docs/TECHNICAL_ARCHITECTURE.md](docs/TECHNICAL_ARCHITECTURE.md)。
