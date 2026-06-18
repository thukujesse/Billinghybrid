#!/bin/bash
EF=/opt/jtm/app.env
LINE=$(grep -E '^DATABASE_URL=' "$EF" | head -1)
export DATABASE_URL="${LINE#DATABASE_URL=}"; DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"; export DATABASE_URL
cd /opt/jtm/app/api
echo "=== control DB ==="; npm run migrate 2>&1 | tail -4
echo "=== tenant DBs ==="; npx tsx src/db/migrateTenants.ts 2>&1 | tail -6
echo "=== verify column + FK ==="
psql "$DATABASE_URL" -t -A -c "SELECT column_name FROM information_schema.columns WHERE table_name='hotspot_purchases' AND column_name='collection_account_id';"
echo "=== restart jtm-app ==="; systemctl restart jtm-app; sleep 3; systemctl is-active jtm-app
echo "=== build web ==="; cd /opt/jtm/app/web && npm run build 2>&1 | tail -4
echo "=== restart jtm-web ==="; systemctl restart jtm-web; sleep 4; systemctl is-active jtm-web
