# 踩坑筆記

由 [CLAUDE.md](../../CLAUDE.md) 拆出。那份現在是精簡索引，這裡放展開的內容。

拆開的理由：原本 935 行擠在一個檔案裡，實際要動某一塊時，得先滑過另外九塊
不相干的內容。現在按「你要動什麼」分檔，**改到相關程式碼之前先讀該檔**。

| 檔案 | 內容 |
|---|---|
| [STRUCTURE.md](STRUCTURE.md) | 完整目錄結構與每個檔案的職責 |
| [CONVENTIONS.md](CONVENTIONS.md) | Boids 群聚演算法、M1–M3 里程碑、開發規範 |
| [COMMANDS.md](COMMANDS.md) | 安裝、啟動、測試、壓測機器人、切片驗證 |
| [GENERATION.md](GENERATION.md) | 風格四件套、VLM、切片比例、貼圖傳輸、手機同步 |
| [FIELD-OPS.md](FIELD-OPS.md) | 場館網路、TLS 憑證與 DHCP、生成耗時、iOS 震動 |
| [SERVER-AND-TESTS.md](SERVER-AND-TESTS.md) | `server/` 結構、e2e 不穩定成因、`IDLE_MOTION`、人數上限、CDN |
| [INTERACTION-DESIGN.md](INTERACTION-DESIGN.md) | 玩法判準、尋寶先知模式、COLOR_HUNT、分區感知 |
| [UI-STYLING.md](UI-STYLING.md) | 顏色 token 的填色／文字之分、觸控範圍與視覺尺寸分離 |
| [LOCAL-PREVIEW.md](LOCAL-PREVIEW.md) | 本機開啟各頁面與依 PID 關閉服務 |

這些條目多半是「不這樣做會出事，但不會報錯」的耦合 —— 幾乎每一條都附了
當初的症狀與「不這樣做會怎樣」，那才是它們值得留著的原因。
