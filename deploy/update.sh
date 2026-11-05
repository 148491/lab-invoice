#!/usr/bin/env bash
# Met à jour Lab Facturation (code + dépendances) sans toucher aux données.
#   sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Lancez en root : sudo bash deploy/update.sh"; exit 1; }
cd "$APP_DIR"
git pull --ff-only
"$APP_DIR/.venv/bin/pip" install -q -r requirements.txt
systemctl restart lab-facturation
sleep 2
curl -fs http://127.0.0.1:8000/api/auth/state >/dev/null && echo "✔ Mise à jour terminée" \
  || { echo "Le service ne répond pas : journalctl -u lab-facturation -n 50"; exit 1; }
