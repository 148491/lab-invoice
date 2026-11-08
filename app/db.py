"""Persistance SQLite.

Un seul fichier de base (par défaut ``data/facturation.db``) contient tout :
référentiels (collaborateurs, epics Jira, projets / dates de MEL), coûts
employeur, temps saisis et paramètres de chaque mois.
"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("FACTU_DB", Path(__file__).resolve().parent.parent / "data" / "facturation.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Collaborateurs et mode de saisie de leur temps
--   jira    : temps importés du timesheet Jira
--   manual  : temps saisis à la main par lot (ex. Product Owner)
--   prorata : total d'heures du mois réparti au prorata des heures de l'équipe (ex. CTO, direction)
--   mirror  : répartition identique à un autre collaborateur
CREATE TABLE IF NOT EXISTS collaborators (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role          TEXT DEFAULT '',
    mode          TEXT NOT NULL DEFAULT 'jira',
    prorata_base  TEXT NOT NULL DEFAULT 'costed',   -- 'jira' (heures Jira de l'équipe) | 'costed' (heures des salariés ayant un coût)
    mirror_of     TEXT DEFAULT NULL,
    aliases       TEXT NOT NULL DEFAULT '[]',
    active        INTEGER NOT NULL DEFAULT 1,
    entity        TEXT NOT NULL DEFAULT '',         -- entreprise de rattachement
    team          TEXT NOT NULL DEFAULT ''          -- équipe
);

-- Référentiel des epics Jira (onglet Roadmap_Project_Names)
CREATE TABLE IF NOT EXISTS epics (
    epic_key      TEXT PRIMARY KEY,                  -- ex. EPICS-194
    label         TEXT NOT NULL,                     -- ex. EPICS-194: SILO PAGES 2026
    lot_name      TEXT NOT NULL,                     -- nom facturé (colonne JIRA NAME)
    status        TEXT NOT NULL DEFAULT 'IN PROGRESS',
    mel_date      TEXT DEFAULT NULL,                 -- ISO yyyy-mm-dd
    sub_category  TEXT DEFAULT '',
    category      TEXT DEFAULT ''                    -- Project | Agile | Support | CX | ...
);

-- Base des projets / lots facturés (onglet MEP Dates)
CREATE TABLE IF NOT EXISTS projects (
    lot           TEXT PRIMARY KEY COLLATE NOCASE,
    status        TEXT NOT NULL DEFAULT 'IN PROGRESS',  -- IN PROGRESS | PRODUCTION | ABANDONED
    mel_date      TEXT DEFAULT NULL,
    sub_category  TEXT DEFAULT '',
    category      TEXT DEFAULT ''
);

-- Coûts employeur (Charge patronale - BDD / onglet DATAS), lignes brutes
CREATE TABLE IF NOT EXISTS costs (
    id            INTEGER PRIMARY KEY,
    month         TEXT NOT NULL,                     -- yyyy-mm
    collaborator  TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT '',
    amount        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_costs_month ON costs(month);

-- Temps passés (une ligne = un ticket / un lot pour un collaborateur)
CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY,
    month         TEXT NOT NULL,
    collaborator  TEXT NOT NULL,
    issue_key     TEXT DEFAULT '',
    summary       TEXT DEFAULT '',
    epic          TEXT DEFAULT '',
    lot           TEXT DEFAULT '',                   -- forcé à la main ; sinon calculé depuis l'epic
    hours         REAL NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'jira'       -- jira | manual | history
);
CREATE INDEX IF NOT EXISTS ix_entries_month ON entries(month);

-- Comptes utilisateurs et droits
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'collaborateur',   -- admin | finance | chef_projet | collaborateur
    collaborator  TEXT DEFAULT NULL,                       -- collaborateur rattaché (saisie de ses temps)
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    must_change   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login    TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL
);
-- Journal des actions
CREATE TABLE IF NOT EXISTS audit (
    id            INTEGER PRIMARY KEY,
    at            TEXT NOT NULL DEFAULT (datetime('now')),
    username      TEXT,
    action        TEXT NOT NULL,
    month         TEXT,
    detail        TEXT
);
-- Imports en attente de confirmation (aperçu avant écriture)
CREATE TABLE IF NOT EXISTS pending_imports (
    token         TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    month         TEXT NOT NULL,
    payload       TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Feuilles de temps déclarées par les collaborateurs
CREATE TABLE IF NOT EXISTS sheet_status (
    month         TEXT NOT NULL,
    collaborator  TEXT NOT NULL,
    submitted_at  TEXT,
    submitted_by  TEXT,
    PRIMARY KEY (month, collaborator)
);

-- Paramètres et état de chaque mois facturé
CREATE TABLE IF NOT EXISTS months (
    month           TEXT PRIMARY KEY,
    working_days    REAL,
    dap             REAL NOT NULL DEFAULT 0,          -- CAPEX : dotation aux amortissements
    frais_generaux  REAL NOT NULL DEFAULT 0,
    cost_plus       REAL NOT NULL DEFAULT 0.07,
    invoice_date    TEXT,
    invoice_number  TEXT,
    prorata         TEXT NOT NULL DEFAULT '{}',       -- {collaborateur: {holidays, hours}}
    status          TEXT NOT NULL DEFAULT 'draft',    -- draft | validated
    snapshot        TEXT                              -- facture figée (JSON) une fois validée
);
"""

DEFAULT_SETTINGS = {
    # Renseignés depuis le dernier onglet facture lors de la reprise Excel, ou dans Paramètres
    "issuer_name": "",
    "issuer_footer": "",
    "client_name": "",
    "client_address": "",
    "client_id": "",
    "client_ref": "",
    "currency": "ILS",
    "hours_per_day": "7",
    "default_cost_plus": "0.07",
    # Lots mensuels « NOM - MM/YY » : déterminés par le nom de l'epic (JIRA NAME).
    # Chaque type liste des mots-clés ; un nom qui en contient un est facturé mois par mois.
    "monthly_keywords": json.dumps({
        "Agile": ["MINOR EVOLUTION"],
        "Support": ["BUG"],
        "Run": ["REUNIONS & PILOTAGE", "INFRA & SERVICES", "CI/CD", "DOCUMENTATION", "CX - RUN", "FASTERIZE"],
    }, ensure_ascii=False),
    "expected_tolerance": "0.2",
    # Entité facturée : seuls ses collaborateurs (temps et coûts) entrent dans la facture ; vide = tous
    "billing_entity": "",
}


def monthly_kind(name: str | None, settings_: dict) -> str | None:
    """Type de lot mensuel (« Agile », « Support », « Run »…) d'après le nom, ou None pour un projet."""
    try:
        rules = json.loads(settings_.get("monthly_keywords") or "{}")
    except ValueError:
        rules = {}
    up = (name or "").upper()
    for kind, words in rules.items():
        if any(w.strip() and w.strip().upper() in up for w in words):
            return kind
    return None


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    p = Path(path or DB_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class ThreadLocalConnection:
    """Une connexion SQLite par thread (le serveur traite les requêtes en parallèle)."""

    def __init__(self, path: Path | str | None = None):
        import threading
        self._path = path
        self._local = threading.local()

    def _conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = self._local.conn = connect(self._path)
            c.execute("PRAGMA busy_timeout=10000")
        return c

    def __getattr__(self, name):
        return getattr(self._conn(), name)


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(collaborators)")}
    if "entity" not in cols:
        conn.execute("ALTER TABLE collaborators ADD COLUMN entity TEXT NOT NULL DEFAULT ''")
    if "team" not in cols:
        conn.execute("ALTER TABLE collaborators ADD COLUMN team TEXT NOT NULL DEFAULT ''")


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    _migrate(conn)
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
    conn.execute("DELETE FROM settings WHERE key = 'recurring_categories'")
    conn.commit()


def audit(conn: sqlite3.Connection, user: dict | None, action: str, month: str | None = None, detail=None) -> None:
    conn.execute("INSERT INTO audit(username, action, month, detail) VALUES (?,?,?,?)",
                 ((user or {}).get("username"), action, month,
                  detail if isinstance(detail, str) or detail is None else json.dumps(detail, ensure_ascii=False)))
    conn.commit()


@contextmanager
def tx(conn: sqlite3.Connection):
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def settings(conn: sqlite3.Connection) -> dict:
    return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}


def rows(conn: sqlite3.Connection, sql: str, params=()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, params)]


def get_month(conn: sqlite3.Connection, month: str, create: bool = True) -> dict:
    r = conn.execute("SELECT * FROM months WHERE month = ?", (month,)).fetchone()
    if r is None and not create:
        s = settings(conn)
        return {"month": month, "working_days": None, "dap": 0, "frais_generaux": 0,
                "cost_plus": float(s.get("default_cost_plus", 0.07)), "invoice_date": None,
                "invoice_number": None, "prorata": {}, "status": "draft", "snapshot": None}
    if r is None:
        s = settings(conn)
        conn.execute(
            "INSERT INTO months(month, cost_plus) VALUES (?, ?)",
            (month, float(s.get("default_cost_plus", 0.07))),
        )
        conn.commit()
        r = conn.execute("SELECT * FROM months WHERE month = ?", (month,)).fetchone()
    d = dict(r)
    d["prorata"] = json.loads(d["prorata"] or "{}")
    d["snapshot"] = json.loads(d["snapshot"]) if d["snapshot"] else None
    return d
