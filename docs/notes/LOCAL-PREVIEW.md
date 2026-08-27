# 本機預覽：開啟與關閉

> 由 [CLAUDE.md](../../CLAUDE.md) 拆出。這裡是踩過的坑與當初的取捨理由 ——
> 動到相關程式碼之前先讀，多數條目都附了「不這樣做會怎樣」。


### 整合版（主線）

先照上方「常用指令 → 整合版（主線）」啟動兩個服務（`npm start` +
`python backend/service.py`，或 `bash start.sh` 一次帶起），服務就緒後開啟
三個角色各自的頁面：

```powershell
# 大螢幕
Start-Process 'http://localhost:3000/screen/'

# 手機控制（現場請改用終端機印出的區網 IP，例如 http://192.168.x.x:3000/controller/）
Start-Process 'http://localhost:3000/controller/'

# 主辦端控制台（需要終端機印出的通行密鑰）
Start-Process 'http://localhost:3000/host/'

# 生成服務健康檢查
Start-Process 'http://127.0.0.1:5055/health'
```

要關閉服務，回到執行 `npm start` 與 `python backend/service.py` 的終端機按
`Ctrl+C`。若終端機已關閉或行程卡住，可在新的 PowerShell 視窗查詢並停止：

```powershell
# 查詢目前監聽 3000（互動層）與 5055（生成服務）的程序
Get-NetTCPConnection -LocalPort 3000,5055 -State Listen |
  Select-Object LocalPort, OwningProcess

# 停止指定程序；將 <PID> 換成上方的 OwningProcess 數字
Stop-Process -Id <PID>
```

### 2D 備援版

以下是 2D 備援版（`backend/app.py` + `frontend/`）的本機操作，埠與整合版不同
（備援 5001／8000，整合版 3000／5055），可並存。

請在專案根目錄 `PersonaFlow` 開啟兩個終端機視窗，各自執行一個服務：

```powershell
# 終端機 A：後端（Socket.io / API）
python backend/app.py

# 終端機 B：前端靜態網站
python -m http.server 8000 --directory frontend
```

服務啟動後，可在終端機直接開啟頁面：

```powershell
# 主操作頁
Start-Process 'http://127.0.0.1:8000/index.html'

# 投影頁
Start-Process 'http://127.0.0.1:8000/projection.html'

# 開發端生成歷史／Token／成本
Start-Process 'http://127.0.0.1:8000/dev.html'

# 後端健康檢查
Start-Process 'http://127.0.0.1:5001/health'
```

要關閉服務時，回到各自正在執行服務的終端機並按 `Ctrl+C`。若終端機已關閉或服務卡住，可在新的 PowerShell 視窗查詢並停止對應連接埠：

```powershell
# 查詢目前監聽 5001（後端）與 8000（前端）的程序
Get-NetTCPConnection -LocalPort 5001,8000 -State Listen |
  Select-Object LocalPort, OwningProcess

# 停止指定程序；將 <PID> 換成上方的 OwningProcess 數字
Stop-Process -Id <PID>
```
