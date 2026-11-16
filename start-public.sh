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

# Node 與 shell 都不讀 .env，自己撈這一個值。根目錄與 backend/ 的 .env 都找（backend/config.py 也是兩處都讀）
DOMAIN="${NGROK_DOMAIN:-}"
for envfile in "$ROOT_DIR/.env" "$ROOT_DIR/backend/.env"; do
  if [ -z "$DOMAIN" ] && [ -f "$envfile" ]; then
    DOMAIN=$(grep -E '^NGROK_DOMAIN=' "$envfile" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)
  fi
done
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

# 一個行程與它底下所有的子孫，從最底層殺起
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo -e "${RED}正在關閉...${NC}"
  if [ -n "$NGROK_PID" ]; then kill "$NGROK_PID" 2>/dev/null || true; fi
  # 先讓 start.sh 自己收：它知道監看迴圈底下真正的 node / python 是誰（見 start.sh 的 cleanup）。
  # 不能先 pkill -P 它的子行程 —— 那些是監看迴圈，殺了之後 node / python 變成孤兒，
  # 繼續佔住 :3000 / :5055，下次啟動就撞埠。5 秒內沒收完才整棵樹一起殺
  if [ -n "$START_PID" ]; then
    kill -TERM "$START_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$START_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$START_PID" 2>/dev/null; then kill_tree "$START_PID"; fi
  fi
  wait 2>/dev/null || true
  echo "已關閉。"
}
trap cleanup EXIT INT TERM

# 合照 QR 指向外網網址：測試的人不在這台電腦的區網裡，給區網位址他們掃了也打不開
export PUBLIC_HOST="https://${DOMAIN}"

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
