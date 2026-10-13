#!/bin/bash
# 多人同時生成的壓測：假的生圖上游 + 一份獨立的生成服務（:5077）+ N 個同時請求。
# 不花錢、不碰正在跑的 :5055、不寫生成帳本。背景見 docs/notes/GENERATION.md「多人同時生成」。
#
#   bash scripts/gen-burst/run.sh <人數> [假上游參數…]
#   bash scripts/gen-burst/run.sh 3 --latency 13 --max-inflight 1   # 上游一次只收一個
#   bash scripts/gen-burst/run.sh 5 --latency 13 --fail-every 3     # 每三次一次 502
#   bash scripts/gen-burst/run.sh 8 --latency 13 --max-inflight 2
#
# 假上游回傳的圖：GEN_BURST_PNG，或 backend/logs/generated/ 裡最新的一張生成結果。
set -u
D=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$D/../.." && pwd)
PY=${PYTHON:-python3}
USERS=${1:?usage: run.sh <users> [fake-upstream args]}; shift
PNG=${GEN_BURST_PNG:-$(ls -t "$REPO"/backend/logs/generated/*_full_character_0.png 2>/dev/null | head -1)}
[ -f "$PNG" ] || { echo "找不到可用的角色圖，請設 GEN_BURST_PNG"; exit 1; }
LOG=$(mktemp -d)

$PY -I "$D/fake_upstream.py" --png "$PNG" "$@" > "$LOG/fake.log" 2>&1 &
FAKE=$!
OPENAI_API_KEY=fake-key OPENAI_BASE_URL=http://127.0.0.1:5099/v1 VISION_PORT=5077 \
  DEV_HISTORY_ENABLED=0 FULL_MODE_VLM_ENABLED=0 $PY "$REPO/backend/service.py" > "$LOG/svc.log" 2>&1 &
SVC=$!
trap 'kill $FAKE $SVC 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:5077/health && break; sleep 0.5; done

echo "== $USERS 人同時生成（假上游：$*）"
$PY -I "$D/burst.py" 5077 "$USERS" "$PNG"
echo "  （服務 log：$LOG/svc.log）"
