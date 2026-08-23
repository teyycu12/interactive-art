# PersonaFlow（眾影鏈結）系統技術架構文件 (v2.0)

 文件版本：v2.0（2026-08 典範轉移重構版；基於 v1.1 收斂與架構升級）


 系統定位：實體活動場域的「雙層半自主」參與式互動與記憶結晶系統（Phygital Hybrid Installation）


 核心架構變更摘要：
1. 移除高延遲 CVAI 影像辨識：捨棄不穩定的相機拍照與純 AI 全圖生成，改為手機端結構化模組捏臉（Curated Component System）。


2. 引進雙層互動架構（Dual-Layer Architecture）：個人端手機作為控制器（Controller），現場大螢幕作為公共共享畫布（Public Canvas）。


3. 半自主共治狀態引擎（Shared Agency Engine）：實作「手動搖桿操縱（Active Agency）」與「Boids 群體自組織（Passive Swarm）」的動態權重平滑切換。


4. 手繪極簡手帳畫布風格（Minimalist Doodle Canvas）：全面整合 Open Peeps 向量語彙、`rough.js` 手繪幾何分區與程式化步態演算法。





---

## 1. 系統架構總覽 (System Architecture)

系統由四個核心層級構成，支援高併發、低延遲的多人即時空間互動：

```
+-----------------------------------------------------------------------+
 1. 個人控制層 (Client Controller - Mobile Web)                         
    - 模組化 SVG 捏臉引擎 (Open Peeps Tokenized Assembly)               
    - 虛擬搖桿模組 (Virtual Joystick) & 即時社交動作發送 (Emotes)         
+-----------------------------------┬-----------------------------------+
                                    │ WebSocket (JSON Payload  Event)
+-----------------------------------▼-----------------------------------+
 2. 通訊與狀態調度層 (Gateway & State Manager - Node.jsPython)          
    - 連線生命週期管理 (Session & Heartbeat)                           
    - 空間狀態快取 (RedisMemory State Matrix)                          
    - 雙模控制仲裁器 (Shared Agency Arbiter Active vs. Boids)        
+-----------------------------------┬-----------------------------------+
                                    │ Event Broadcast  State Synchronization
+-----------------------------------▼-----------------------------------+
 3. 公共渲染與群體動力層 (Public Canvas - p5.js  WebGL)                
    - 手繪幾何場景繪製 (rough.js + Open Doodles 靜態物件)               
    - 程式化彈跳步態引擎 (Procedural Bobbing & Squash-Stretch)          
    - Boids 群體動力學引擎 (Separation  Alignment  Cohesion)[cite 2]       
+-----------------------------------┬-----------------------------------+
                                    │ Snapshot & Hotspot Geometry Trigger
+-----------------------------------▼-----------------------------------+
 4. 記憶結晶層 (Memory Crystallization Engine - M6)                     
    - 社交熱區加權自動合照構圖演算法 (Auto-Composition Algorithm)[cite 1, 2] 
    - 高解析度紀念卡片渲染與 QR Code 動態分發管道[cite 1, 2]                   
+-----------------------------------------------------------------------+

```

---

## 2. 模組規格與技術實作細節

### 模組 M1：手機端結構化捏臉與輸入控制器 (Mobile Client)

 技術選型：HTML5 Canvas  SVG DOM、`nipplejs`（虛擬搖桿）、WebSocket Client。
 捏臉數據標準化（Avatar Config JSON）：
```json
{
  userId usr_8f9a2b,
  displayName 冠儀,
  avatarConfig {
    head head_curly_02,
    face face_smile_glasses,
    body body_hoodie_01,
    accentColor #E76F51,
    skinTone #F4A261
  }
}

```


 操控輸入發送規格：
 搖桿推動時，以 20 Hz（50ms 節流） 頻率向伺服器傳送正規化方向向量：
`{ type INPUT_MOVE, vector { x 0.707, y -0.707 }, intensity 0.85 }`
 點擊社交動作時，觸發即時事件：
`{ type INPUT_ACTION, action CHEERS  HEART  WAVE }`



---

### 模組 M2：半自主共治引擎 (Shared Agency Arbiter)

系統解決「現場掛機造成死寂」與「純自動無掌控感」的核心演算法。

```
[ 手機操控事件 (INPUT_MOVE) ] ───(重置閒置計時器)─── [ 進入主動控制態 (Active Control) ]
                                                              │
                                                        (閒置  3.0 秒)
                                                              ▼
[ Boids 群體計算向量 ] ─────────(線性插值 Lerp 平滑過渡)─── [ 進入湧現漫遊態 (Emergent Swarm) ][cite 1, 2]

```

 物理速度向量合成公式：

$$V_{text{final}} = (1 - alpha) cdot V_{text{Boids}} + alpha cdot V_{text{Manual}}$$



其中 $alpha in [0, 1]$ 為主動控制權重因子：
 當偵測到搖桿輸入時：$alpha$ 在 0.3 秒內線性平滑過渡至 $1.0$。
 當輸入中斷超過 3 秒時：$alpha$ 以餘弦衰減平滑過渡回 $0.0$，無縫回歸 Boids 漫遊。





---

### 模組 M3：大螢幕公共畫布渲染與程式化步態 (Public Canvas)

 技術選型：`p5.js`（向量渲染管線）+ `rough.js`（手繪筆觸引擎）。
 手繪風格場景管線：
 底色：米白低對比底色 (`#FAF8F5`) 搭配網格微點。
 功能分區：使用 `rough.js` 繪製帶有手繪顫線風格的幾何色塊（舞台區、暢飲區、聊天沙發區）。
 裝飾物件：預先載入 Open Doodles SVG 圖層（植栽、桌椅），作為物理剛體障礙物加入避障清單。




 程式化 2D 步態渲染（無逐格動畫成本）：
 垂直彈跳（Bobbing）：$Y_{text{offset}} = -leftvert{} sin(text{frameCount} times omega) rightvert{} times A$ （$A=6text{px}, omega=0.2$）
 左右擺動（Wobble）：$text{Rotation} = sin(text{frameCount} times frac{omega}{2}) times 5^{circ}$
 轉向鏡像：當 $V_x  0$ 時 $text{ScaleX} = 1$；當 $V_x  0$ 時 $text{ScaleX} = -1$。
 呼吸待機（Idle Breathing）：當處於靜止狀態時，垂直比例以正弦波在 $0.98 sim 1.02$ 緩慢縮放。


 動態投影（Dynamic Shadow）：腳底繪製半透明橢圓，當 $Y_{text{offset}}$ 增加時，陰影透明度與半徑同步按比例衰減。



---

### 模組 M4：M6 自動合照構圖演算法 (Auto-Composition Engine)

在活動結束或主辦端點擊「生成結晶」時觸發：

1. 控制權鎖定：伺服器向全端廣播 `EVENT_LOCK_STAGE`，角色平滑移向中央舞台。
2. 階梯分層排版演算法（Tiered Formation）：
 計算畫面上活躍度（Interaction Score）與連線時長。
 依據社交圖譜將互相按讚互動的角色分群靠攏。
 縱向採用階梯式分排（第一排採蹲姿低高度，後排依序錯開），確保無遮擋率達 95% 以上。


3. 結晶產出與分發：
 大螢幕觸發動態閃光與倒數計時音效。
 Canvas 自動匯出 $3840 times 2160$（4K）紀念圖檔，打上當日活動專屬手繪紀念框。


 圖檔上傳雲端儲存，生成短網址並推播至個人手機端展示下載。





---

## 3. 通訊協定規格 (WebSocket Protocol)

 事件名稱 (Event)  發送端 $to$ 接收端  Payload 內容範例  說明 
 ---  ---  ---  --- 
 `CLIENT_JOIN`  Phone $to$ Server  `{ name 冠儀, avatar {...} }`  使用者捏臉完成登入 
 `INPUT_MOVE`  Phone $to$ Server  `{ vx 0.5, vy -0.8 }`  搖桿即時向量（節流 20Hz） 
 `INPUT_ACTION`  Phone $to$ Server  `{ action CHEERS }`  觸發頭頂動態氣泡與音效 
 `STAGE_SYNC`  Server $to$ Screen  `[ { id u1, x 120, y 300, state WALK }, ... ]`  空間狀態廣播 (30 FPS) 
 `TRIGGER_PHOTO`  Host $to$ Server  `{ theme CAMPUS_GALA_2026 }`  主辦端觸發大合照流程

 
 `PHOTO_READY`  Server $to$ Phone  `{ downloadUrl https..., cardId c_991 }`  推播合照與個人卡片下載

 

---

## 4. 研究論述與答辯策略 (WP-D 論述架構)

在書面報告與口頭答辯中，嚴禁將專案表述為「簡易小遊戲」或「素材拼貼」，應嚴格依循以下理論脈絡進行學術定位：

```
                        【三大核心理論支撐】
                        
1. 自我呈現理論 (Goffman, 1959)[cite 1]
   └── 結構化模組捏臉降低自我表露焦慮，提供具掌控感的「前台 (Front Stage)」數位分身[cite 1]。

2. 社會臨場感與混合空間理論 (Short et al., 1976; de Souza e Silva, 2006)[cite 1]
   └── 雙層架構打破個人螢幕封閉性，將手機操作轉譯為大螢幕共享實體，達成實體破冰[cite 1, 2]。

3. 集體記憶符號化理論 (Halbwachs, 1992)[cite 1]
   └── 空間互動透過 M6 自動構圖演算法固化為「紀念物（Artifact）」，完成記憶結晶[cite 1, 2]。

```

---

## 5. 工作包重構與驗收標準 (Work Packages v2.0)

 工作包  負責人  核心任務  驗收里程碑 
 ---  ---  ---  --- 
 WP-A 模組化捏臉與控制器  R1 (總召)  整合 Open Peeps SVG 模組、建置手機端 Web Controller、WebSocket 連線池與資料驗證。  825 前：手機端完成流暢 3 步捏臉，搖桿輸入延遲 $ 50text{ms}$。 
 WP-B 畫布渲染與共治引擎  R2 (前端) + R3 (後端)  `rough.js` 手繪場景繪製、程式化彈跳步態、手動Boids 權重平滑仲裁器、M6 自動合照排版。

  910 前：大螢幕穩定承載 30 個角色以 30 FPS 渲染，合照自動構圖 $ 5text{秒}$。

 
 WP-C 場域實測與數據收集  R5 (實測統籌)  實體活動場地對接、現場投影動線部署、發放問卷與行為 Log 收集。

  930 前：完成校內實測（$N ge 25$），產出包含操控時長、合照下載率之完整 Log。

 
 WP-D 理論論述與分析報告  R4 (文書研究)  競品定位矩陣、三大理論架構論述主筆、Likert 5 點量表問卷統計分析。

  1020 前：完成期末技術報告與答辯簡報定稿。

 

---

## 6. 風險管理與 Fallback 機制

1. 現場網路不穩／斷線：
 手機端若斷線超過 2 秒，大螢幕角色立即自動無縫轉入 Boids 漫遊狀態，頭頂顯示暫時離線符號，避免畫面卡死。




2. 多角色重疊遮擋（Occlusion Mitigation）：
 Boids 演算法內建 Separation 剛體避障半徑；合照構圖階段強制依 Y 軸高度與深度進行圖層排序（Z-indexing）。




3. 低階行動裝置效能支援：
 手機端 Controller 採用純 CSS  DOM 輕量化渲染，無 WebGL 負擔，確保各廠牌手機掃碼後可在 1 秒內即時載入。