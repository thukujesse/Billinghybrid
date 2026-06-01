#!/bin/bash
# Install + configure FreeRADIUS on the VPS to read users/clients from the
# Render-hosted Postgres. Called from bootstrap.sh. Idempotent.
set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/thukujesse/Billinghybrid/main/vps}"
ENV_FILE=/opt/wg-manager/radius.env

if [ ! -f "$ENV_FILE" ]; then
  cat <<EOF >&2
[radius] /opt/wg-manager/radius.env not found.
Create it with the Render Postgres connection details (External Connection
String, broken into parts) before re-running. Example contents:

PGHOST=dpg-xxxx-a.oregon-postgres.render.com
PGPORT=5432
PGUSER=jtm_db_user
PGPASSWORD=...
PGDATABASE=jtm_db
EOF
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

echo "[radius 1/5] Installing freeradius + freeradius-postgresql..."
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
apt-get update -qq
apt-get install -y freeradius freeradius-postgresql postgresql-client >/dev/null

RADDB=/etc/freeradius/3.0

echo "[radius 2/5] Installing sql module config (substituted from radius.env)..."
curl -fsSL "$REPO_RAW/freeradius/sql.conf" -o /tmp/jtm-sql.conf
# Use sed with @VAR@ placeholders so FreeRADIUS's own ${...} config refs
# (like ${modconfdir} and ${thread[pool].start_servers}) survive the
# substitution. envsubst would have clobbered them.
sed \
  -e "s|@PGHOST@|${PGHOST}|g" \
  -e "s|@PGPORT@|${PGPORT}|g" \
  -e "s|@PGUSER@|${PGUSER}|g" \
  -e "s|@PGPASSWORD@|${PGPASSWORD}|g" \
  -e "s|@PGDATABASE@|${PGDATABASE}|g" \
  /tmp/jtm-sql.conf > "$RADDB/mods-available/sql"
rm /tmp/jtm-sql.conf

# Enable sql module.
ln -sf "$RADDB/mods-available/sql" "$RADDB/mods-enabled/sql"

echo "[radius 3/5] Wiring sql into default site (authorize, accounting, post-auth)..."
SITE="$RADDB/sites-available/default"
# Uncomment 'sql' references in the default site (commented out by default).
sed -i \
  -e 's|^#\(\s*\)sql$|\1sql|g' \
  "$SITE"
ln -sf "$RADDB/sites-available/default" "$RADDB/sites-enabled/default"

# Same for inner-tunnel (EAP/PEAP — harmless to enable here even if unused).
ITUNNEL="$RADDB/sites-available/inner-tunnel"
sed -i -e 's|^#\(\s*\)sql$|\1sql|g' "$ITUNNEL" || true

echo "[radius 4/5] Allow root user to test queries (avoid permission errors)..."
chgrp -R freerad "$RADDB" || true
chmod 640 "$RADDB/mods-available/sql"

echo "[radius 5/5] Opening UDP 1812 (auth) + UDP 1813 (acct) on ufw, restarting freeradius..."
if command -v ufw >/dev/null; then
  ufw allow from 10.66.0.0/16 to any port 1812 proto udp >/dev/null 2>&1 || true
  ufw allow from 10.66.0.0/16 to any port 1813 proto udp >/dev/null 2>&1 || true
fi
systemctl restart freeradius
systemctl enable freeradius >/dev/null
sleep 2
systemctl is-active freeradius && echo "[radius] freeradius is running."
echo
echo "Smoke-test from VPS:"
echo "  echo \"User-Name=ping,Cleartext-Password=ping\" | radclient -x 127.0.0.1 auth testing123"
echo "(Will return access-reject for a non-existent user — proves freeradius answers.)"
