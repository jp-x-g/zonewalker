#!/usr/bin/env bash
# Idempotent VPS deploy: run as root from the zonewalker clone directory.
#   sudo bash deploy/update_vps.sh
set -e
cd "$(dirname "$0")/.."
APP=/opt/room-map-gui
echo "== copying files =="
cp server.py "$APP/"
cp -r static "$APP/" 2>/dev/null || true
cp partition/F*.geojson "$APP/partition/"
mkdir -p "$APP/tools" && cp tools/*.py "$APP/tools/"
echo "== data migration (no-op if already done) =="
python3 "$APP/tools/migrate_f2f3_swap.py" "$APP/data" || true
chown -R mapgui:mapgui "$APP"
echo "== restarting =="
systemctl restart room-map-gui
sleep 1
systemctl is-active room-map-gui
echo "== verify =="
PW=$(cat "$APP/password.txt" 2>/dev/null || true)
curl -s -u "x:$PW" localhost:8177/api/floors | python3 -c "
import json, sys
d = json.load(sys.stdin)
for k, v in sorted(d.items()):
    print('story', k, '->', v['source'], len(v['geojson']['features']), 'features')
"
echo "== OK =="