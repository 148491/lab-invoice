"""Comptes, sessions et droits.

Rôles
-----
* ``admin``         : tout, y compris la gestion des comptes.
* ``finance``       : charges, CAPEX / frais généraux, factures et validation, référentiels, temps de tous.
* ``chef_projet``   : temps de tous (import, contrôle, corrections), référentiels ; consultation des factures.
* ``collaborateur`` : saisie de ses propres temps uniquement.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request

ROLES = {
    "admin": {"label": "Administrateur", "perms": {"view", "time.self", "time.all", "costs", "invoice", "ref", "users"}},
    "finance": {"label": "Finance", "perms": {"view", "time.self", "time.all", "costs", "invoice", "ref"}},
    "chef_projet": {"label": "Chef de projet", "perms": {"view", "time.self", "time.all", "ref"}},
    "collaborateur": {"label": "Collaborateur", "perms": {"time.self"}},
}
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


def create_session(conn, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    exp = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)", (token, user_id, exp))
    conn.execute("UPDATE users SET last_login = datetime('now') WHERE id = ?", (user_id,))
    conn.execute("DELETE FROM sessions WHERE expires_at < datetime('now')")
    conn.commit()
    return token


def public_user(u: dict) -> dict:
    role = ROLES.get(u["role"], ROLES["collaborateur"])
    return {"id": u["id"], "username": u["username"], "display_name": u["display_name"] or u["username"],
            "role": u["role"], "role_label": role["label"], "perms": sorted(role["perms"]),
            "collaborator": u["collaborator"], "must_change": bool(u["must_change"]), "active": bool(u["active"]),
            "last_login": u.get("last_login")}


def make_dependencies(get_conn):
    def current_user(request: Request) -> dict:
        token = request.cookies.get(COOKIE) or request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token:
            raise HTTPException(401, "Connexion requise")
        conn = get_conn()
        r = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1", (token,)).fetchone()
        if r is None:
            raise HTTPException(401, "Session expirée, reconnectez-vous")
        return dict(r)

    def require(*perms: str):
        def dep(user: dict = Depends(current_user)) -> dict:
            mine = ROLES.get(user["role"], ROLES["collaborateur"])["perms"]
            if not any(p in mine for p in perms):
                raise HTTPException(403, "Vous n'avez pas les droits pour cette action")
            return user
        return dep

    return current_user, require


def has(user: dict, perm: str) -> bool:
    return perm in ROLES.get(user["role"], ROLES["collaborateur"])["perms"]
