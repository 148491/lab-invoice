#!/bin/sh
# Prépare le volume de données puis lance l'application avec un utilisateur non privilégié.
set -e
mkdir -p "$(dirname "${FACTU_DB:-/data/facturation.db}")"
chown -R lab:lab "$(dirname "${FACTU_DB:-/data/facturation.db}")" 2>/dev/null || true
exec setpriv --reuid=lab --regid=lab --init-groups \
  uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips='*'
