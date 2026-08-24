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
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_PORT=5001
FRONTEND_PORT=8080

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

start_backend() {
  echo -e "${GREEN}▶ 啟動後端${NC} (Flask-SocketIO on :${BACKEND_PORT})"
  echo -e "  LAN 連線位址：${BOLD}http://${LAN_IP}:${BACKEND_PORT}${NC}"
  echo ""
  python3 "$BACKEND_DIR/app.py" &
  BACKEND_PID=$!
  echo "[PID: $BACKEND_PID]"
}

start_frontend() {
  echo -e "${GREEN}▶ 啟動前端靜態伺服器${NC} (http://0.0.0.0:${FRONTEND_PORT})"
  echo -e "  互動端：${BOLD}http://${LAN_IP}:${FRONTEND_PORT}/index.html${NC}"
  echo -e "  投影牆：${BOLD}http://${LAN_IP}:${FRONTEND_PORT}/projection.html${NC}"
  echo ""
  python3 -m http.server ${FRONTEND_PORT} --directory "$FRONTEND_DIR" --bind 0.0.0.0 &
  FRONTEND_PID=$!
  echo "[PID: $FRONTEND_PID]"
}

cleanup() {
  echo ""
  echo -e "${RED}正在關閉...${NC}"
  [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
  wait 2>/dev/null
  echo "已關閉。"
}

trap cleanup EXIT INT TERM

banner
check_env

case "${1:-all}" in
  --backend)
    start_backend
    ;;
  --frontend)
    start_frontend
    ;;
  *)
    start_backend
    sleep 1
    start_frontend
    ;;
esac

echo ""
echo -e "${CYAN}按 Ctrl+C 結束所有服務${NC}"
wait
