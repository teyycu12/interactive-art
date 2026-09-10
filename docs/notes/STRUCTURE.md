# 目錄結構

> 由 [CLAUDE.md](../../CLAUDE.md) 拆出。這裡是踩過的坑與當初的取捨理由 ——
> 動到相關程式碼之前先讀，多數條目都附了「不這樣做會怎樣」。

```
/PersonaFlow
├── /backend
│   ├── service.py                # ★ 角色資產生成 HTTP 服務（只綁 127.0.0.1:5055）
│   ├── slicer.py                 # ★ 生成圖正規化 + 切成 head/torso/legs 三張貼圖
│   ├── validate_cuts.py          # ★ 切片比例穩定度驗證工具
│   ├── config.py                 # 集中式環境設定（型別轉換與驗證，單一 config 物件）
│   ├── cv_module.py              # MediaPipe 人體、服裝色彩、區域與姿勢特徵
│   ├── face_module.py            # 本機臉部特徵
│   ├── vlm_module.py             # 雲端服裝、髮型與臉部語意辨識
│   ├── avatar_pipeline.py        # generate_avatar 的純資料處理（影像解碼、色表、特徵合併）
│   ├── garment_gen.py            # 完整角色生成流程與 prompt 模板
│   ├── style_registry.py         # 可擴充角色風格註冊表
│   ├── style_base.py             # 從參考圖量出的風格標準（數值化）
│   ├── style_fingerprint.py      # 風格指紋與跨角色物種漂移量測
│   ├── style_normalizer.py       # 方向性明暗量測與正規化
│   ├── style_probe.py            # 把指紋接到實際生成圖上的漂移量測
│   ├── reference_bleed.py        # 參考圖滲漏偵測
│   ├── identity_fidelity.py      # 個體特徵保真度量測
│   ├── avatar_quality.py         # 生成角色圖結構完整性驗證
│   ├── capture_quality.py        # 拍攝品質、站位與穩定度判定
│   ├── capture_session.py        # ★ 跨影格的可拍攝判定（站位引導的時序邏輯）
│   ├── detail_quality.py         # 最終畫面細節指標
│   ├── height_profiles.py        # short／medium／tall 身高校正
│   ├── photo_composer.py         # 大合照合成（LEGO 排版、QR Code、中文字型後備鏈）
│   ├── circuit_breaker.py        # 外部 API 熔斷器與退避重試
│   ├── generation_history.py     # SQLite 生成紀錄、Token、成本與快速審查
│   ├── metrics_logger.py         # 匿名流程指標與輪替紀錄
│   ├── event_logger.py           # 結構化事件 log 落地（JSON lines，隱私遮除影像）
│   ├── analyze_log.py            # 效能指標分析（延遲／失敗率）
│   ├── report_html.py            # HTML 效能報告產生器
│   ├── pytest.ini                # 測試設定（testpaths／pythonpath）
│   ├── /models                   # MediaPipe／分割模型資產
│   ├── /tests                    # pytest：CV、生成、規格、歷史與風格 registry
│   └── /logs                     # 執行期資料；gitignored，不提交版本庫
│       ├── generation_history.sqlite3
│       ├── /generated            # AI attempt 與最終角色快照
├── /server                       # ★ 整合版互動層（Node.js）
│   ├── index.js                  # Gateway：WebSocket 生命週期、30Hz 主迴圈、TLS 啟動
│   ├── httplayer.js              # ★ HTTP 層：靜態資源與生成服務代理（與場域狀態無關）
│   ├── arbiter.js                # α 權重仲裁與速度合成
│   ├── boids.js  state.js        # 群聚引擎與狀態矩陣
│   ├── missions.js  pairing.js  quiz.js  scores.js  socialgraph.js
│   ├── treasure.js               # ★ 尋寶（先知模式）：規則與冷熱判定
│   ├── certcheck.js              # ★ 啟動時比對憑證 SAN 與當下 LAN IP
│   └── persistence.js  scheduler.js  ratelimit.js  config.js
├── /shared                       # ★ 前後端共用的單一事實來源
│   ├── protocol.js               # 事件名、節流頻率、場域尺寸
│   ├── avatars.js                # 捏臉素材 + CV 角色驗證 + CV_CUTS 切片比例
│   ├── avatarSprite.js           # 角色圖組裝（整張圖優先，缺它才疊三張切片）
│   ├── character.js              # 角色與名牌繪製（大螢幕與控制器共用）
│   ├── capture-guidance.js       # 站位引導文案與指示燈判定
│   ├── colorFamily.js            # ★ 顏色分族（COLOR_HUNT 任務，三端共用）
│   ├── heat.js                   # ★ 尋寶冷熱等級與判定半徑（三端共用）
│   └── scene.js                  # 場景障礙物佈局
├── /public                       # ★ 前端
│   ├── controller/               # 手機端：拍照生成／捏臉（備援）、搖桿、任務
│   ├── screen/                   # 大螢幕
│   │   └── 3d/RoomScene.js       # three.js 房間場景
│   ├── host/                     # 主辦端控制台
│   └── assets/gen/               # 生成貼圖落地處（gitignored，每場重新產生）
├── /test                         # ★ Node 單元測試（node --test）
├── /samples                      # validate_cuts.py 的樣本照片（不是測試套件，見其 README）
├── /scripts
│   ├── e2e.mjs                   # ★ 端對端測試（會自行啟動伺服器）
│   ├── make-cert.sh              # ★ 現場用 TLS 憑證產生
│   ├── scene-preview.mjs         # ★ 場景離線預覽
│   └── ...                       # 參考圖集與髮色取樣的離線檢查工具
├── /docs
│   ├── INTERFACES.md             # 已移除的 2D 版 Socket.io 介面規格（僅存歷史）
│   ├── STYLE_BASE.md             # 基底風格標準與量測方法
│   ├── STYLE_PROBE_FOLLOWUPS.md  # 已知但刻意延後的量測與管線細節
│   ├── TECHNICAL_ARCHITECTURE.md # 技術架構文件
│   ├── TECH-PersonaFlow2.md      # ★ 整合版互動層技術說明
│   ├── README-PersonaFlow2.md    # ★ 整合版說明
│   ├── PRD.md                    # 產品需求與驗收定義（驗收條件仍寫在已退役模式上，待重寫）
│   ├── TechStack.md              # 技術選型
│   ├── /m3                       # M3 交接說明與效能報告
│   └── /style_reference          # 風格參考圖集（含圖檔，見 PROVENANCE.md）
├── /.github/workflows/ci.yml     # CI：npm test＋端對端＋後端 pytest
├── package.json                  # ★ Node 相依與指令
├── start.sh                      # 一鍵啟動腳本（生成服務 :5055 ＋ 互動層 :3000）
├── CLAUDE.md                     # 本檔：專案結構、規範與啟動方式
├── README.md                     # 安裝、設定、流程與使用說明
├── .env.example                  # 環境變數範本
├── requirements.txt              # Python 執行相依（mediapipe 已釘 <1.0）
└── requirements-dev.txt          # 測試相依（pytest）
```

> ★ 為整合後新增。文件已全數移入 `docs/`，根目錄只留 README 與本檔。

---

