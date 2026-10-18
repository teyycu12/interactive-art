#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# PixelAir — 對外網啟動（固定網址）
#
#   start.sh（生成服務 + 互動層）＋ ngrok 固定網域
#   測試人員用自己的 4G / 家裡 Wi-Fi 就能連，不必跟這台電腦同網路。
#
# 用法：bash start-public.sh
#
# 網域寫在 .env 的 NGROK_DOMAIN（到 https://dashboard.ngrok.com/domains
# 領一個免費固定網域）。這台電腦關機、睡眠或斷網時，網址就打不開。
# ─────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PORT=3000

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

# Node 與 shell 都不讀 .env，自己撈這一個值
DOMAIN="${NGROK_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f "$ROOT_DIR/.env" ]; then
  DOMAIN=$(grep -E '^NGROK_DOMAIN=' "$ROOT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
fi
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%/}"

if [ -z "$DOMAIN" ]; then
  echo -e "${RED}⚠ 沒有設定 NGROK_DOMAIN${NC}"
  echo "  1. 到 https://dashboard.ngrok.com/domains 按 Create Domain"
  echo "  2. 在 .env 加一行：NGROK_DOMAIN=你的網域.ngrok-free.app"
  exit 1
fi

if ! command -v ngrok >/dev/null 2>&1; then
  echo -e "${RED}⚠ 找不到 ngrok，請先安裝：brew install ngrok${NC}"
  exit 1
fi

# 有憑證時 start.sh 走 HTTPS，ngrok 要轉到同一個 scheme，否則會 502
UPSTREAM="http://localhost:${NODE_PORT}"
if [ -f "$ROOT_DIR/certs/cert.pem" ] && [ -f "$ROOT_DIR/certs/key.pem" ]; then
  UPSTREAM="https://localhost:${NODE_PORT}"
fi

cleanup() {
  echo ""
  echo -e "${RED}正在關閉...${NC}"
  [ -n "$NGROK_PID" ] && kill "$NGROK_PID" 2>/dev/null
  # 只殺 start.sh 本身時它的 trap 不一定來得及跑，生成服務與互動層會殘留佔住
  # :3000 / :5055，下次啟動就撞埠。直接連它的子行程一起收
  if [ -n "$START_PID" ]; then
    pkill -TERM -P "$START_PID" 2>/dev/null
    kill "$START_PID" 2>/dev/null
  fi
  wait 2>/dev/null
  echo "已關閉。"
}
trap cleanup EXIT INT TERM

bash "$ROOT_DIR/start.sh" &
START_PID=$!

# 等互動層真的在聽再開 ngrok，不然第一批連線會撞到 502
for _ in $(seq 1 30); do
  curl -sk -o /dev/null "$UPSTREAM/" && break
  sleep 1
done

ngrok http --url="$DOMAIN" "$UPSTREAM" --log=stdout --log-level=warn > "$ROOT_DIR/ngrok.log" 2>&1 &
NGROK_PID=$!
sleep 3
if ! kill -0 "$NGROK_PID" 2>/dev/null; then
  echo -e "${RED}⚠ ngrok 沒有啟動成功，訊息如下：${NC}"
  cat "$ROOT_DIR/ngrok.log"
  exit 1
fi

echo ""
echo -e "${CYAN}${BOLD}═══ 外網固定網址 ═══${NC}"
echo -e "  手機控制器：${BOLD}https://${DOMAIN}/controller/${NC}"
echo -e "  3D 投影牆：${BOLD}https://${DOMAIN}/screen/${NC}"
echo -e "${YELLOW}  第一次打開會有 ngrok 提醒頁，按 Visit Site 即可。${NC}"
echo ""
echo -e "${CYAN}按 Ctrl+C 結束所有服務${NC}"
wait
