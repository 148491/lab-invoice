"""Comptes, sessions et droits.

Rôles
-----
* ``admin``         : tout, y compris la gestion des comptes.
* ``finance``       : charges, CAPEX / frais généraux, factures et validation, référentiels, temps de tous.
* ``chef_projet``   : temps de tous (import, contrôle, corrections), référentiels ; consultation des factures.
* ``collaborateur`` : saisie de ses propres temps uniquement.

Les droits des rôles autres qu'administrateur sont modifiables (réglage ``role_perms``).
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request

# Catalogue des droits (clé, libellé, groupe). Les rôles hors administrateur sont modifiables
# depuis « Comptes & droits » ; la configuration est stockée dans le réglage ``role_perms``.
PERMS = [
    ("view", "Consulter les factures, le tableau de bord et les référentiels", "Factures"),
    ("invoice", "CAPEX / frais généraux, cost +, validation et réouverture des factures", "Factures"),
    ("costs", "Voir et saisir les salaires et charges employeur", "Factures"),
    ("time.self", "Saisir ses propres temps", "Temps"),
    ("time.all", "Importer, contrôler et corriger les temps de tous", "Temps"),
    ("ref", "Modifier les référentiels (projets, epics Jira, collaborateurs)", "Référentiels"),
    ("analytics", "Voir l'analyse des projets (montants par lot, domaine, run / build)", "Analyse"),
    ("analytics.people", "Analyse par personne : heures et coûts individuels, filtre équipe", "Analyse"),
    ("settings", "Paramètres, module IA et reprise des fichiers Excel", "Administration"),
    ("audit", "Consulter le journal des actions", "Administration"),
    ("users", "Gérer les comptes et les droits par rôle", "Administration"),
    ("impersonate", "Se connecter en tant qu'un autre compte (lecture seule)", "Administration"),
]
ALL_PERMS = {p for p, _, _ in PERMS}
ROLES = {
    "admin": {"label": "Administrateur", "perms": set(ALL_PERMS), "locked": True},
    "finance": {"label": "Finance", "perms": {"view", "invoice", "costs", "time.self", "time.all", "ref", "analytics",
                                              "analytics.people", "audit"}},
    "chef_projet": {"label": "Chef de projet", "perms": {"view", "time.self", "time.all", "ref", "analytics"}},
    "collaborateur": {"label": "Collaborateur", "perms": {"time.self"}},
}


def role_perms(conn) -> dict[str, set[str]]:
    """Droits effectifs de chaque rôle (défauts + personnalisation enregistrée)."""
    import json
    out = {k: set(v["perms"]) for k, v in ROLES.items()}
    r = conn.execute("SELECT value FROM settings WHERE key='role_perms'").fetchone()
    if r and r[0]:
        try:
            for k, perms in json.loads(r[0]).items():
                if k in out and not ROLES[k].get("locked"):
                    out[k] = set(perms) & ALL_PERMS
        except (ValueError, AttributeError):
            pass
    return out


def perms_of(conn, role: str) -> set[str]:
    rp = role_perms(conn)
    return rp.get(role, rp["collaborateur"])


IMPERSONATION_HOURS = 2
SESSION_DAYS = 14
COOKIE = "lab_session"
_ITER = 210_000
_failures: dict[str, list[float]] = {}


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, _ITER)
    return f"pbkdf2_sha256${_ITER}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, h = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(dk.hex(), h)
    except Exception:
        return False


def check_password_strength(pw: str) -> None:
    if len(pw or "") < 8:
        raise HTTPException(400, "Le mot de passe doit faire au moins 8 caractères.")


def throttled(username: str) -> bool:
    now = time.time()
    recent = [t for t in _failures.get(username.lower(), []) if now - t < 300]
    _failures[username.lower()] = recent
    return len(recent) >= 5


def record_failure(username: str) -> None:
    _failures.setdefault(username.lower(), []).append(time.time())


def create_session(conn, user_id: int, impersonator: int | None = None, return_token: str | None = None) -> str:
    token = secrets.token_urlsafe(32)
    life = timedelta(hours=IMPERSONATION_HOURS) if impersonator else timedelta(days=SESSION_DAYS)
    exp = (datetime.now(timezone.utc) + life).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("INSERT INTO sessions(token, user_id, expires_at, impersonator_id, return_token) VALUES (?,?,?,?,?)",
                 (token, user_id, exp, impersonator, return_token))
    if not impersonator:
        conn.execute("UPDATE users SET last_login = datetime('now') WHERE id = ?", (user_id,))
    conn.execute("DELETE FROM sessions WHERE expires_at < datetime('now')")
    conn.commit()
    return token


def public_user(u: dict, perms: set[str] | None = None) -> dict:
    role = ROLES.get(u["role"], ROLES["collaborateur"])
    perms = perms if perms is not None else u.get("_perms", role["perms"])
    return {"id": u["id"], "username": u["username"], "display_name": u["display_name"] or u["username"],
            "role": u["role"], "role_label": role["label"], "perms": sorted(perms),
            "impersonated_by": u.get("_impersonator"),
            "collaborator": u["collaborator"], "must_change": bool(u["must_change"]), "active": bool(u["active"]),
            "last_login": u.get("last_login")}


def make_dependencies(get_conn):
    def current_user(request: Request) -> dict:
        token = request.cookies.get(COOKIE) or request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token:
            raise HTTPException(401, "Connexion requise")
        conn = get_conn()
        r = conn.execute(
            "SELECT u.*, s.impersonator_id AS _imp_id, i.display_name AS _imp_name, i.username AS _imp_user "
            "FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users i ON i.id = s.impersonator_id "
            "WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1", (token,)).fetchone()
        if r is None:
            raise HTTPException(401, "Session expirée, reconnectez-vous")
        u = dict(r)
        imp = (u.pop("_imp_id"), u.pop("_imp_name"), u.pop("_imp_user"))
        u["_perms"] = perms_of(conn, u["role"])
        if imp[0]:
            u["_impersonator"] = {"id": imp[0], "display_name": imp[1] or imp[2], "username": imp[2]}
            # connexion « en tant que » : lecture seule
            if request.method not in ("GET", "HEAD") and request.url.path != "/api/auth/impersonate/stop":
                raise HTTPException(403, f"Lecture seule : vous voyez l'application comme {u['display_name'] or u['username']}. "
                                         "Revenez à votre compte pour modifier.")
        return u

    def require(*perms: str):
        def dep(user: dict = Depends(current_user)) -> dict:
            mine = user["_perms"]
            if not any(p in mine for p in perms):
                raise HTTPException(403, "Vous n'avez pas les droits pour cette action")
            return user
        return dep

    return current_user, require


def has(user: dict, perm: str) -> bool:
    return perm in user.get("_perms", ROLES.get(user["role"], ROLES["collaborateur"])["perms"])
