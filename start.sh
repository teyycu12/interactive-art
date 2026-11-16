#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# PixelAir — 一鍵啟動
#
#   Node 互動層 :3000 + 生成服務 :5055
#   任一個行程異常結束會自動重啟（見 supervise）
#
# 用法：bash start.sh              （生成服務 + 互動伺服器）
#       bash start.sh --vision     （僅生成服務）
#       bash start.sh --node       （僅互動伺服器）
# ─────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
SERVER_DIR="$ROOT_DIR/server"
NODE_PORT="${PORT:-3000}"

# 每個服務目前那個行程的 PID 寫在這裡。監看迴圈是背景子 shell，變數傳不回來，
# 而收尾時要殺的是真正的 node / python —— 只殺監看迴圈的話它們會變成孤兒，繼續佔住 port
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pixelair.XXXXXX")"
STOP_FLAG="$RUN_DIR/stopping"

# 偵測本機 LAN IP（方便現場用手機/平板連入）
LAN_IP=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}' || echo "?")

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}╔════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║       PixelAir — 數位轉譯角色系統       ║${NC}"
  echo -e "${CYAN}${BOLD}╚════════════════════════════════════════════╝${NC}"
  echo ""
}

check_env() {
  # backend/config.py 兩個位置都會讀，放哪一個都可以
  if [ ! -f "$ROOT_DIR/.env" ] && [ ! -f "$BACKEND_DIR/.env" ]; then
    echo -e "${RED}⚠ 找不到 .env 檔案！${NC}"
    echo "  請複製 .env.example → .env 並填入 API 金鑰："
    echo "    cp .env.example .env"
    echo ""
  fi
}

# ─────────────────────────────────────────────────────────────────
# 監看迴圈：行程異常結束就重啟。
#
# 互動層遇到沒接住的例外會存快照後結束（server/index.js 的 handleCrash），
# 手機會自動重連並認領回原本的角色與分數 —— 前提是伺服器有回來。
# 沒有這個迴圈的話，要等有人走到電腦前重新執行 start.sh。
#
# 正常結束（exit 0，例如 shutdown）不重啟。剛啟動就掛掉（10 秒內）連續 5 次就放棄：
# 那是設定錯誤或 port 被佔住，重啟一百次也不會好，只會把真正的錯誤訊息洗掉。
# ─────────────────────────────────────────────────────────────────
supervise() {
  local name="$1"; shift
  local quick_fails=0
  while [ ! -f "$STOP_FLAG" ]; do
    local started=$SECONDS
    "$@" &
    local child=$!
    echo "$child" > "$RUN_DIR/$name.pid"
    local code=0
    wait "$child" || code=$?
    if [ -f "$STOP_FLAG" ]; then break; fi
    if [ "$code" -eq 0 ]; then
      echo -e "${YELLOW}  ${name} 已結束。${NC}"
      break
    fi
    if [ $((SECONDS - started)) -lt 10 ]; then
      quick_fails=$((quick_fails + 1))
    else
      quick_fails=0
    fi
    if [ "$quick_fails" -ge 5 ]; then
      echo -e "${RED}${BOLD}✗ ${name} 連續 5 次一啟動就結束（最後一次代碼 ${code}），不再重啟。${NC}"
      echo -e "${RED}  請看上面的錯誤訊息（常見：port 被佔住、.env 設定錯誤）。${NC}"
      break
    fi
    echo -e "${RED}${BOLD}⚠ ${name} 異常結束（代碼 ${code}），1 秒後自動重啟…${NC}"
    sleep 1
  done
}

start_vision() {
  echo -e "${GREEN}▶ 啟動 AI 生成服務${NC}（Python，只綁本機）"
  echo ""

  if [ -d "$ROOT_DIR/venv" ]; then
    # shellcheck disable=SC1091
    source "$ROOT_DIR/venv/bin/activate"
  fi

  supervise "生成服務" python3 "$BACKEND_DIR/service.py" &
}

start_node() {
  # 有憑證就自動走 HTTPS。手機的 getUserMedia 要求安全情境，
  # 在 http://192.168.x.x 上會直接拒絕相機 —— 拍照進場等於不存在。
  # 憑證產生：bash scripts/make-cert.sh
  local scheme="http"
  if [ -f "$ROOT_DIR/certs/cert.pem" ] && [ -f "$ROOT_DIR/certs/key.pem" ]; then
    export TLS_CERT="$ROOT_DIR/certs/cert.pem"
    export TLS_KEY="$ROOT_DIR/certs/key.pem"
    scheme="https"
  else
    # 不預設失敗，只是說清楚代價 —— 沒有憑證仍然可以完整展演（從相簿選、自己換裝）
    echo -e "${YELLOW}  ⚠ 找不到 certs/，將以 HTTP 啟動：手機無法使用相機，只能從相簿選照片或自己換裝。${NC}"
    echo -e "${YELLOW}    要啟用拍照：bash scripts/make-cert.sh${NC}"
  fi

  echo -e "${GREEN}▶ 啟動 Node.js 互動伺服器${NC} (${scheme}://0.0.0.0:${NODE_PORT})"
  echo -e "  手機控制器：${BOLD}${scheme}://${LAN_IP}:${NODE_PORT}/controller/${NC}"
  echo -e "  大螢幕：　　${BOLD}${scheme}://${LAN_IP}:${NODE_PORT}/screen/${NC}"
  echo ""
  supervise "互動伺服器" node "$SERVER_DIR/index.js" &
}

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo -e "${RED}正在關閉...${NC}"
  # 先立旗再殺：監看迴圈看到旗子就不會把剛被殺的行程又拉起來
  touch "$STOP_FLAG"
  for f in "$RUN_DIR"/*.pid; do
    if [ -f "$f" ]; then kill "$(cat "$f")" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
  rm -rf "$RUN_DIR"
  echo "已關閉。"
}

trap cleanup EXIT INT TERM

banner
check_env

case "${1:-all}" in
  --vision)
    start_vision
    ;;
  --node)
    start_node
    ;;
  *)
    start_vision
    sleep 1
    start_node
    ;;
esac

echo ""
echo -e "${CYAN}按 Ctrl+C 結束所有服務${NC}"
wait
