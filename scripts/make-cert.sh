#!/usr/bin/env bash
#
# 產生現場用的 TLS 憑證。
#
# 為什麼需要：手機瀏覽器的 getUserMedia 要求安全情境，
# 在 http://192.168.x.x 上會直接拒絕相機權限，掃描進場等於不存在。
#
# 兩種做法，優先用 mkcert：
#   mkcert   會建立一個本機 CA 並簽發憑證。把該 CA 裝到手機上之後，
#            瀏覽器完全不會跳警告 —— 這是唯一不會嚇到參與者的做法。
#   openssl  自簽憑證。不需額外安裝，但手機第一次連線會跳安全警告，
#            必須手動點「繼續前往」。人多時這一步會卡住報到動線。
#
# 用法：bash scripts/make-cert.sh
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$CERT_DIR"

# 憑證必須涵蓋手機實際輸入的位址，否則即使信任了 CA 仍會因網域不符而失敗
LAN_IPS=$(node -e "
const os = require('node:os');
const ips = Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
process.stdout.write(ips.join(' '));
")

if [ -z "$LAN_IPS" ]; then
  echo "⚠️  偵測不到區網 IP，只會簽發 localhost 用的憑證。"
fi

echo "將簽發下列位址的憑證：localhost 127.0.0.1 $LAN_IPS"
echo

if command -v mkcert >/dev/null 2>&1; then
  echo "→ 使用 mkcert（手機安裝 CA 後不會跳警告）"
  mkcert -install
  # shellcheck disable=SC2086
  mkcert -cert-file "$CERT_DIR/cert.pem" -key-file "$CERT_DIR/key.pem" \
    localhost 127.0.0.1 ::1 $LAN_IPS
  echo
  echo "✅ 憑證已產生於 $CERT_DIR"
  echo
  echo "手機要免警告，需先安裝這台電腦的本機 CA："
  echo "  CA 檔案位置：$(mkcert -CAROOT)/rootCA.pem"
  echo "  把該檔案傳到手機並安裝信任（iOS 另需到「設定 → 一般 → 關於本機 → 憑證信任設定」開啟）"
else
  echo "→ 找不到 mkcert，改用 openssl 自簽（手機會跳一次安全警告）"
  echo "   建議改裝 mkcert：brew install mkcert"
  echo

  SAN="DNS:localhost,IP:127.0.0.1"
  for ip in ${LAN_IPS}; do SAN="${SAN},IP:$ip"; done

  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
    -subj "/CN=PersonaFlow" \
    -addext "subjectAltName=$SAN" 2>/dev/null

  echo "✅ 憑證已產生於 ${CERT_DIR}（自簽，手機首次連線需手動略過警告）"
fi

echo
echo "啟動方式："
echo "  TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start"
