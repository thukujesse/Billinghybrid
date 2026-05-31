#!/bin/bash
# JTM wg-manager + Caddy bootstrap. Idempotent — safe to re-run.
# Run as root on the VPS:
#   curl -fsSL https://raw.githubusercontent.com/thukujesse/Billinghybrid/main/vps/bootstrap.sh | sudo bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/thukujesse/Billinghybrid/main/vps"
DOMAIN="vpn.hubnetwifi.co.ke"

echo "[1/8] Installing python3 + caddy + helpers..."
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
apt-get update -qq
apt-get install -y python3 curl gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y caddy >/dev/null
fi

echo "[2/8] Installing wg-manager.py..."
install -d -m 755 /opt/wg-manager
curl -fsSL "$REPO_RAW/wg-manager.py" -o /opt/wg-manager/wg-manager.py
chmod 755 /opt/wg-manager/wg-manager.py

echo "[3/8] Bearer token..."
if [ ! -f /opt/wg-manager/wg-manager.env ]; then
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  cat > /opt/wg-manager/wg-manager.env <<EOF
WG_MANAGER_TOKEN=$TOKEN
WG_MANAGER_PORT=8080
WG_MANAGER_IFACE=wg0
EOF
  chmod 600 /opt/wg-manager/wg-manager.env
  TOKEN_STATUS="freshly generated below"
else
  TOKEN=$(grep ^WG_MANAGER_TOKEN= /opt/wg-manager/wg-manager.env | cut -d= -f2)
  TOKEN_STATUS="already exists, value shown below"
fi

echo "[4/8] systemd unit..."
curl -fsSL "$REPO_RAW/wg-manager.service" -o /etc/systemd/system/wg-manager.service

echo "[5/8] Caddyfile..."
curl -fsSL "$REPO_RAW/Caddyfile" -o /etc/caddy/Caddyfile

echo "[6/8] Firewall (ufw allow 80, 443)..."
if command -v ufw >/dev/null; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

echo "[7/8] Reloading systemd, starting services..."
systemctl daemon-reload
systemctl enable wg-manager caddy >/dev/null
systemctl restart wg-manager
systemctl restart caddy

echo "[8/8] Probing local wg-manager..."
sleep 2
LOCAL_PROBE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/peers || echo "fail")

echo
echo "================================================================"
echo "DONE."
echo
echo "WG_MANAGER_TOKEN ($TOKEN_STATUS):"
echo "  $TOKEN"
echo
echo "Set these on Render -> jtm-api -> Environment:"
echo "  WG_MANAGER_URL   = https://${DOMAIN}/wg"
echo "  WG_MANAGER_TOKEN = $TOKEN"
echo
echo "Local probe (should be 200): $LOCAL_PROBE"
echo
echo "Once Caddy has fetched the Let's Encrypt cert (~30s on first run),"
echo "test from outside:"
echo "  curl -H \"Authorization: Bearer $TOKEN\" https://${DOMAIN}/wg/peers"
echo "================================================================"
