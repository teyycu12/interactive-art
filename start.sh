#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# PersonaFlow 一鍵啟動腳本
# 用法：bash start.sh              （同時啟動後端 + 前端靜態伺服器）
#       bash start.sh --backend    （僅啟動後端）
#       bash start.sh --frontend   （僅啟動前端靜態伺服器）
# ─────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
SERVER_DIR="$ROOT_DIR/server"
VISION_PORT=5055
NODE_PORT=3000

# 偵測本機 LAN IP（方便現場用手機/平板連入）
LAN_IP=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}' || echo "?")

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}╔════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║       PersonaFlow — 數位轉譯角色系統       ║${NC}"
  echo -e "${CYAN}${BOLD}╚════════════════════════════════════════════╝${NC}"
  echo ""
}

check_env() {
  if [ ! -f "$ROOT_DIR/.env" ]; then
    echo -e "${RED}⚠ 找不到 .env 檔案！${NC}"
    echo "  請複製 .env.example → .env 並填入 API 金鑰："
    echo "    cp .env.example .env"
    echo ""
  fi
}

start_vision() {
  echo -e "${GREEN}▶ 啟動 AI 生成服務${NC} (Python Flask on :${VISION_PORT})"
  echo -e "  模型切換請至 .env 設定 OPENAI_API_KEY"
  echo ""
  
  if [ -d "$ROOT_DIR/venv" ]; then
    source "$ROOT_DIR/venv/bin/activate"
  fi
  
  python3 "$BACKEND_DIR/service.py" &
  VISION_PID=$!
  echo "[PID: $VISION_PID]"
}

start_node() {
  echo -e "${GREEN}▶ 啟動 Node.js 互動伺服器${NC} (http://0.0.0.0:${NODE_PORT})"
  echo -e "  手機控制器：${BOLD}http://${LAN_IP}:${NODE_PORT}/controller/index.html${NC}"
  echo -e "  3D 投影牆：${BOLD}http://${LAN_IP}:${NODE_PORT}/screen/index.html${NC}"
  echo ""
  node "$SERVER_DIR/index.js" &
  NODE_PID=$!
  echo "[PID: $NODE_PID]"
}

cleanup() {
  echo ""
  echo -e "${RED}正在關閉...${NC}"
  [ -n "$VISION_PID" ] && kill "$VISION_PID" 2>/dev/null
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null
  wait 2>/dev/null
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
