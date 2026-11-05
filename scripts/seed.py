"""Initialise une base à partir des fichiers Excel existants (ligne de commande).

Usage :
    python -m scripts.seed --facturation Facturation-Paris.xlsx \
        --charges Charge-Patronale_-_BDD.xlsx \
        --timesheet "Timesheet - All Teams - October 26.xlsx" \
        [--from 2025-01] [--db data/facturation.db] [--accounts comptes.txt] [--keep]

Même traitement que l'assistant « Reprise des fichiers Excel » de l'écran Paramètres
(voir app/bootstrap.py). Par défaut la base est recréée ; --keep la conserve.
"""
from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import auth, bootstrap, db  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--facturation", required=True)
    ap.add_argument("--charges", required=True)
    ap.add_argument("--timesheet")
    ap.add_argument("--month", help="mois brouillon à préparer (par défaut : celui du timesheet)")
    ap.add_argument("--from", dest="history_from", default="2025-01")
    ap.add_argument("--db", default=str(db.DB_PATH))
    ap.add_argument("--report", default=str(ROOT / "docs" / "reconciliation.md"))
    ap.add_argument("--accounts", help="crée des comptes de démonstration et écrit leurs identifiants dans ce fichier")
    ap.add_argument("--keep", action="store_true", help="ne pas recréer la base")
    a = ap.parse_args(argv)

    path = Path(a.db)
    if path.exists() and not a.keep:
        path.unlink()
    conn = db.connect(path)
    db.init(conn)
    rep = bootstrap.load(conn, a.facturation, a.charges, a.timesheet, a.history_from, a.month)
    Path(a.report).parent.mkdir(parents=True, exist_ok=True)
    Path(a.report).write_text(bootstrap.markdown(rep), encoding="utf-8")
    print(f"• Rapport : {a.report}")

    if a.accounts:
        demo = [("admin", "Administrateur", "admin", None),
                ("finance", "Finance (démo)", "finance", None),
                ("chef", "Chef de projet (démo)", "chef_projet", None),
                ("collaborateur", "Collaborateur (démo)", "collaborateur",
                 next((r[0] for r in conn.execute("SELECT name FROM collaborators WHERE mode='manual' AND active=1")), None))]
        out = []
        with db.tx(conn):
            for username, name, role, collab in demo:
                pw = secrets.token_urlsafe(9)
                conn.execute("INSERT OR REPLACE INTO users(username, display_name, role, collaborator, password_hash) "
                             "VALUES (?,?,?,?,?)", (username, name, role, collab, auth.hash_password(pw)))
                out.append(f"{role:14} {username:20} {pw}")
        Path(a.accounts).write_text("\n".join(out) + "\n", encoding="utf-8")
        print(f"• {len(demo)} comptes créés → {a.accounts}")
    print("Terminé.")


if __name__ == "__main__":
    main()
