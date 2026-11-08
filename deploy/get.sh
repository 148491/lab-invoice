#!/usr/bin/env bash
# Installation en une ligne :
#   curl -fsSL https://raw.githubusercontent.com/Office1480/Lab-Invoicing/main/deploy/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Office1480/Lab-Invoicing/main/deploy/get.sh | bash -s -- factu.mondomaine.com
set -euo pipefail
DIR=/opt/lab-facturation
REPO=https://github.com/Office1480/Lab-Invoicing.git
[ "$(id -u)" -eq 0 ] || { echo "Lancez en root."; exit 1; }
command -v git >/dev/null || { apt-get -o DPkg::Lock::Timeout=600 update -y -q && apt-get -o DPkg::Lock::Timeout=600 install -y -q git >/dev/null; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$DIR"; fi
bash "$DIR/deploy/install.sh" "${1:-}"
