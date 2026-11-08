#!/usr/bin/env bash
# Installation de Lab Facturation sur un VPS Ubuntu 22.04+ / Debian 12+.
#
#   sudo bash deploy/install.sh                 → http://IP-DU-SERVEUR
#   sudo bash deploy/install.sh factu.exemple.com → https://factu.exemple.com (certificat automatique)
#
# Installe : environnement Python, service systemd, Caddy (HTTPS automatique), sauvegarde quotidienne.
# Rejouable : relancer le script met à jour la configuration sans toucher aux données.
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=lab-facturation
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "lancez le script en root : sudo bash deploy/install.sh $DOMAIN"
[ -f "$APP_DIR/app/main.py" ] || die "lancez le script depuis le dossier de l'application"
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "système non pris en charge (${PRETTY_NAME:-inconnu}) : Ubuntu ou Debian requis" ;; esac

say "Paquets système"
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=600"
$APT update -y -q
$APT install -y -q python3 python3-venv python3-pip git curl gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || die "Python 3.10 ou plus requis (Ubuntu 22.04+ / Debian 12+)"

say "Utilisateur et environnement Python"
id lab >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin lab
mkdir -p "$APP_DIR/data/backups"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
chown -R lab:lab "$APP_DIR/data"
chmod 750 "$APP_DIR/data"

say "Service systemd"
SECURE=0; [ -n "$DOMAIN" ] && SECURE=1
ENV_FILE=/etc/lab-facturation.env
[ -f "$ENV_FILE" ] || printf '# ANTHROPIC_API_KEY=sk-ant-...   (facultatif : rapprochement des noms par IA)\n' > "$ENV_FILE"
chmod 600 "$ENV_FILE"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Lab Facturation
After=network.target

[Service]
User=lab
WorkingDirectory=$APP_DIR
Environment=FACTU_DB=$APP_DIR/data/facturation.db
Environment=FACTU_SECURE_COOKIE=$SECURE
EnvironmentFile=-$ENV_FILE
ExecStart=$APP_DIR/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q $SERVICE
systemctl restart $SERVICE

say "Serveur web (Caddy)"
if ss -ltnp 2>/dev/null | grep -E ':(80|443) ' | grep -vq caddy; then
  die "les ports 80/443 sont déjà utilisés par un autre serveur web (nginx/apache ?).
L'application tourne sur 127.0.0.1:8000 : ajoutez un reverse proxy vers cette adresse dans votre serveur existant."
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  $APT update -y -q && $APT install -y -q caddy >/dev/null
fi
SITE="${DOMAIN:-:80}"
BLOCK="# lab-facturation
$SITE {
	encode gzip
	request_body {
		max_size 60MB
	}
	reverse_proxy 127.0.0.1:8000
}"
CF=/etc/caddy/Caddyfile
if [ ! -s "$CF" ] || grep -q '/usr/share/caddy' "$CF" || grep -q '^# lab-facturation' "$CF"; then
  # Caddyfile par défaut ou déjà le nôtre : on le remplace
  [ -s "$CF" ] && cp "$CF" "$CF.bak.$(date +%s)"
  printf '%s\n' "$BLOCK" > "$CF"
else
  # Caddyfile existant avec d'autres sites : on ajoute le nôtre
  cp "$CF" "$CF.bak.$(date +%s)"
  printf '\n%s\n' "$BLOCK" >> "$CF"
fi
caddy validate --config "$CF" --adapter caddyfile >/dev/null || die "configuration Caddy invalide (sauvegarde : $CF.bak.*)"
systemctl enable -q caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Pare-feu : ouverture des ports 80 et 443"
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "Sauvegarde quotidienne de la base (14 jours conservés)"
cat > /etc/cron.daily/lab-facturation-backup <<EOF
#!/bin/sh
cd "$APP_DIR" && sudo -u lab "$APP_DIR/.venv/bin/python" -c "
import sqlite3, datetime
src = sqlite3.connect('data/facturation.db')
dst = sqlite3.connect('data/backups/facturation-' + datetime.date.today().isoformat() + '.db')
src.backup(dst); dst.close(); src.close()"
find "$APP_DIR/data/backups" -name 'facturation-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/lab-facturation-backup

say "Vérification"
for i in $(seq 1 20); do curl -fs http://127.0.0.1:8000/api/auth/state >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:8000/api/auth/state >/dev/null || die "le service ne répond pas : journalctl -u $SERVICE -n 50"

if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"
else URL="http://$(curl -fs4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"; fi
printf '\n\033[1;32m✔ Lab Facturation est en ligne : %s\033[0m\n' "$URL"
printf '  Ouvrez cette adresse pour créer le compte administrateur.\n'
printf '  Mise à jour : sudo bash %s/deploy/update.sh\n' "$APP_DIR"
printf '  Journaux    : journalctl -u %s -f\n\n' "$SERVICE"
[ -z "$DOMAIN" ] && printf '  Conseil : avec un nom de domaine pointant vers ce serveur, relancez\n  sudo bash %s/deploy/install.sh votre.domaine.com  pour passer en HTTPS.\n\n' "$APP_DIR"
exit 0
