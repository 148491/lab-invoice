"""Lecture des fichiers sources (xlsx ou copier-coller).

* Timesheet - All Teams (export Jira « Details » + Roadmap + feuilles de synthèse)
* Charge Patronale - BDD (onglet DATAS : Mois / nom employe / catégorie / Cout NIS / Type)
* Facturation Paris (historique : MEP Dates, Config-Salariés, BDD - Time Sheet, factures)
"""
from __future__ import annotations

import io
import json
import re
import warnings
from collections import defaultdict
from datetime import date, datetime

import openpyxl

from . import db
from .engine import epic_key, month_first, parse_date
from .names import Resolver, norm

warnings.filterwarnings("ignore", module="openpyxl")


def _wb(src):
    if isinstance(src, (bytes, bytearray)):
        src = io.BytesIO(src)
    return openpyxl.load_workbook(src, read_only=True, data_only=True)


def _num(v) -> float:
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "").replace("\xa0", "").replace(" ", "").replace("₪", "").replace("€", "")
    if "," in s and "." in s:
        s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0


def _month_of(v) -> str | None:
    if isinstance(v, (datetime, date)):
        return f"{v.year:04d}-{v.month:02d}"
    s = str(v or "").strip()
    m = re.match(r"^(\d{4})-(\d{1,2})", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}"
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)          # jj/mm/aaaa
    if m:
        return f"{int(m.group(3)):04d}-{int(m.group(2)):02d}"
    m = re.match(r"^(\d{1,2})/(\d{2,4})$", s)                   # mm/aa
    if m:
        y = int(m.group(2))
        return f"{y + 2000 if y < 100 else y:04d}-{int(m.group(1)):02d}"
    return None


def _header_index(header, *names) -> int | None:
    h = [norm(x) for x in header]
    for n in names:
        if norm(n) in h:
            return h.index(norm(n))
    return None


# =========================================================================== TIMESHEET
def parse_timesheet_workbook(src) -> dict:
    wb = _wb(src)
    out = {"details": [], "roadmap": [], "summaries": [], "month": None}
    sheets = {ws.title.strip().lower(): ws for ws in wb.worksheets}

    # --- export Jira brut
    details = sheets.get("details") or wb.worksheets[0]
    rows = list(details.iter_rows(values_only=True))
    if rows:
        hdr = rows[0]
        iu = _header_index(hdr, "User", "Collaborator", "Utilisateur")
        ik = _header_index(hdr, "Issue key", "Key", "Ticket")
        isu = _header_index(hdr, "Issue summary", "Summary", "Résumé")
        ie = _header_index(hdr, "Epic", "Epic Link", "Parent")
        ih = _header_index(hdr, "Time spent (hours)", "Hours", "Heures", "Time spent")
        if iu is not None and ih is not None:
            for r in rows[1:]:
                if not r or r[iu] in (None, ""):
                    continue
                out["details"].append({
                    "collaborator": str(r[iu]).strip(),
                    "issue_key": str(r[ik] or "").strip() if ik is not None else "",
                    "summary": str(r[isu] or "").strip() if isu is not None else "",
                    "epic": str(r[ie] or "").strip() if ie is not None else "",
                    "hours": _num(r[ih]),
                })

    # --- référentiel des epics
    rm = sheets.get("roadmap_project_names")
    if rm is not None:
        rrows = list(rm.iter_rows(values_only=True))
        if rrows and len(rrows[0]) > 7:
            out["month"] = _month_of(rrows[0][7])
        for r in rrows[1:]:
            if not r or not r[0]:
                continue
            label = str(r[0]).strip()
            out["roadmap"].append({
                "epic_key": epic_key(label), "label": label,
                "lot_name": str(r[1] or label).strip(),
                "status": str(r[2] or "IN PROGRESS").strip().upper(),
                "mel_date": parse_date(r[3]),
                "sub_category": str(r[4] or "").strip(),
                "category": str(r[5] or "").strip(),
            })

    # --- feuilles de synthèse individuelles (Time_Tracking_Summary_<Prénom>)
    for title, ws in sheets.items():
        if not title.startswith("time_tracking_summary_"):
            continue
        srows = list(ws.iter_rows(values_only=True))
        holidays, who, items = 0.0, None, []
        for r in srows[:8]:
            if r and isinstance(r[0], str) and r[0].strip().lower().startswith("holidays"):
                holidays = _num(r[1])
        hdr_i = next((i for i, r in enumerate(srows) if r and str(r[0] or "").strip() == "Row Labels"), 7)
        hdr = srows[hdr_i] if len(srows) > hdr_i else ()
        ic = _header_index(hdr, "Collaborator") or 4
        iepic = _header_index(hdr, "EPIC Key & Name") or 7
        ip = _header_index(hdr, "Points") or 11
        for r in srows[hdr_i + 1:]:
            if not r or not r[0] or str(r[0]).strip().lower() == "grand total":
                continue
            who = who or (str(r[ic]).strip() if len(r) > ic and r[ic] else None)
            epic = r[iepic] if len(r) > iepic and r[iepic] else r[0]
            items.append({"epic": str(epic).strip(), "hours": _num(r[ip] if len(r) > ip else 0)})
        if who is None:
            who = ws.title.split("_")[-1]
        out["summaries"].append({"collaborator": who, "sheet": ws.title, "holidays": holidays, "rows": items})
    return out


def parse_timesheet_paste(text: str) -> list[dict]:
    """Colonnes : User, Issue key, Issue summary, Epic, Time spent (hours). En-tête facultatif."""
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        c = [x.strip() for x in line.split("\t")]
        if norm(c[0]) in {"user", "collaborator", "utilisateur"}:
            continue
        if len(c) < 2:
            continue
        if len(c) == 2:      # Collaborateur, heures (cas improbable)
            c = [c[0], "", "", "", c[1]]
        while len(c) < 5:
            c.insert(-1, "")
        out.append({"collaborator": c[0], "issue_key": c[1], "summary": c[2], "epic": c[3], "hours": _num(c[4])})
    return out


def upsert_epics(conn, roadmap: list[dict]) -> int:
    n = 0
    for e in roadmap:
        conn.execute(
            "INSERT INTO epics(epic_key, label, lot_name, status, mel_date, sub_category, category) "
            "VALUES (:epic_key, :label, :lot_name, :status, :mel_date, :sub_category, :category) "
            "ON CONFLICT(epic_key) DO UPDATE SET label=excluded.label, lot_name=excluded.lot_name, "
            "status=excluded.status, mel_date=excluded.mel_date, sub_category=excluded.sub_category, "
            "category=excluded.category", e)
        n += 1
    return n


def import_timesheet(conn, month: str, parsed: dict, update_epics: bool = True,
                     mapping: dict | None = None) -> dict:
    """Remplace les temps Jira (et manuels issus du fichier) du mois.
    ``mapping`` : {nom brut: nom canonique, ou None pour ignorer ses lignes}."""
    collabs = db.rows(conn, "SELECT * FROM collaborators")
    base_resolve = Resolver(collabs)
    mapping = mapping or {}

    def resolve(raw):
        return mapping[raw] if raw in mapping else base_resolve(raw)
    modes = {c["name"]: c["mode"] for c in collabs}
    report = {"details": 0, "epics": 0, "manual": {}, "holidays": {}, "file_month": parsed.get("month")}
    with db.tx(conn):
        if update_epics and parsed.get("roadmap"):
            report["epics"] = upsert_epics(conn, parsed["roadmap"])
        conn.execute("DELETE FROM entries WHERE month=? AND source='jira'", (month,))
        for d in parsed.get("details", []):
            who = resolve(d["collaborator"])
            if who is None:
                report.setdefault("ignored", 0)
                report["ignored"] += 1
                continue
            conn.execute(
                "INSERT INTO entries(month, collaborator, issue_key, summary, epic, hours, source) "
                "VALUES (?,?,?,?,?,?,'jira')",
                (month, who, d["issue_key"], d["summary"], d["epic"], d["hours"]))
            report["details"] += 1
        m = db.get_month(conn, month)
        prorata = m["prorata"]
        for s in parsed.get("summaries", []):
            who = resolve(s["collaborator"])
            if who is None:
                continue
            mode = modes.get(who)
            if mode == "manual":
                conn.execute("DELETE FROM entries WHERE month=? AND collaborator=? AND source='manual'", (month, who))
                for r in s["rows"]:
                    if r["hours"]:
                        conn.execute(
                            "INSERT INTO entries(month, collaborator, summary, epic, hours, source) "
                            "VALUES (?,?,?,?,?,'manual')", (month, who, "Feuille du timesheet", r["epic"], r["hours"]))
                report["manual"][who] = sum(r["hours"] for r in s["rows"])
            elif mode == "prorata":
                prorata.setdefault(who, {})["holidays"] = s["holidays"]
                report["holidays"][who] = s["holidays"]
        conn.execute("UPDATE months SET prorata=? WHERE month=?", (json.dumps(prorata), month))
    return report


# =========================================================================== COÛTS
def parse_costs_workbook(src) -> list[dict]:
    wb = _wb(src)
    for ws in sorted(wb.worksheets, key=lambda w: w.title.strip().upper() != "DATAS"):
        rows = ws.iter_rows(values_only=True)
        for i, hdr in enumerate(rows):
            if i > 10:
                break
            if not hdr:
                continue
            im = _header_index(hdr, "Mois", "Month")
            iname = _header_index(hdr, "nom employe", "Collaborator", "Nom", "Employé", "Salarie")
            ia = _header_index(hdr, "Cout NIS", "Coût", "Cout", "Montant", "Amount", "Cost")
            if im is None or iname is None or ia is None:
                continue
            icat = _header_index(hdr, "catégorie", "categorie", "Category")
            it = _header_index(hdr, "Type")
            out = []
            for r in rows:
                if not r or r[iname] in (None, "") or r[im] in (None, ""):
                    continue
                if it is not None and r[it] and str(r[it]).strip().lower() not in ("real", "réel", "reel"):
                    continue
                mo = _month_of(r[im])
                if not mo:
                    continue
                out.append({"month": mo, "collaborator": str(r[iname]).strip(),
                            "category": str(r[icat] or "").strip() if icat is not None else "",
                            "amount": _num(r[ia])})
            return out
    raise ValueError("Aucun onglet avec les colonnes Mois / nom employe / Cout NIS trouvé.")


def parse_costs_paste(text: str, default_month: str) -> list[dict]:
    """Formats acceptés (séparateur tabulation ou point-virgule) :
    - Nom ; Montant
    - Nom ; Catégorie ; Montant
    - Mois ; Nom ; Catégorie ; Montant [; Type]   (copie directe de l'onglet DATAS)
    """
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        sep = "\t" if "\t" in line else ";"
        c = [x.strip() for x in line.split(sep)]
        c = [x for x in c if x != ""] if len(c) > 5 else c
        if norm(c[0]) in {"mois", "month", "nom", "nom employe", "collaborator"}:
            continue
        if len(c) >= 4 and _month_of(c[0]):
            if len(c) >= 5 and c[4] and c[4].strip().lower() not in ("real", "réel", "reel"):
                continue
            out.append({"month": _month_of(c[0]), "collaborator": c[1], "category": c[2], "amount": _num(c[3])})
        elif len(c) == 3:
            out.append({"month": default_month, "collaborator": c[0], "category": c[1], "amount": _num(c[2])})
        elif len(c) == 2:
            out.append({"month": default_month, "collaborator": c[0], "category": "Coût total", "amount": _num(c[1])})
    return out


def import_costs(conn, lines: list[dict], only_months: set[str] | None = None,
                 mapping: dict | None = None) -> dict:
    by_month = defaultdict(list)
    mapping = mapping or {}
    for l in lines:
        if only_months is None or l["month"] in only_months:
            if l["collaborator"] in mapping:
                if mapping[l["collaborator"]] is None:
                    continue
                l = {**l, "collaborator": mapping[l["collaborator"]]}
            by_month[l["month"]].append(l)
    with db.tx(conn):
        for mo, ls in by_month.items():
            conn.execute("DELETE FROM costs WHERE month=?", (mo,))
            conn.executemany("INSERT INTO costs(month, collaborator, category, amount) VALUES (?,?,?,?)",
                             [(mo, l["collaborator"], l["category"], l["amount"]) for l in ls])
    return {mo: {"lines": len(ls), "total": sum(l["amount"] for l in ls)} for mo, ls in sorted(by_month.items())}


# =========================================================================== HISTORIQUE (Facturation Paris)
# Mode de saisie par défaut selon le rôle (onglet Config-Salariés), modifiable ensuite :
#   CTO       : temps réparti au prorata des heures Jira de toute l'équipe
#   Direction : temps réparti au prorata des heures des salariés ayant un coût
#   Product Owner : saisie manuelle par lot
ROLE_MODES = {
    "cto": ("prorata", "jira", None),
    "direction": ("prorata", "costed", None),
    "product owner": ("manual", "costed", None),
}


def import_facturation_workbook(conn, src, history_from: str = "2025-01", with_entries: bool = True) -> dict:
    """Charge le référentiel (salariés, MEP Dates) et l'historique (BDD - Time Sheet, paramètres des factures)."""
    wb = _wb(src)
    rep = {"collaborators": 0, "projects": 0, "entries": 0, "months": {}}
    with db.tx(conn):
        # --- salariés
        if "Config-Salariés" in wb.sheetnames:
            seen, ci = set(), None
            for r in wb["Config-Salariés"].iter_rows(values_only=True):
                if not r:
                    continue
                if ci is None:
                    if any(str(v or "").strip().lower() in ("salarie", "salarié") for v in r):
                        ci = next(i for i, v in enumerate(r) if str(v or "").strip().lower() in ("salarie", "salarié"))
                    continue
                if len(r) <= ci or not r[ci]:
                    continue
                name = " ".join(str(r[ci]).split())
                k = " ".join(sorted(norm(name).split()))
                if k in seen:
                    continue
                seen.add(k)
                role = str(r[ci + 1] or "") if len(r) > ci + 1 else ""
                mode, base, mirror = ROLE_MODES.get(role.strip().lower(), ("jira", "costed", None))
                conn.execute(
                    "INSERT INTO collaborators(name, role, mode, prorata_base, mirror_of) VALUES (?,?,?,?,?) "
                    "ON CONFLICT(name) DO UPDATE SET role=excluded.role",
                    (name, role, mode, base, mirror))
                rep["collaborators"] += 1
        # --- base projets
        if "MEP Dates" in wb.sheetnames:
            for r in wb["MEP Dates"].iter_rows(min_row=2, values_only=True):
                if not r or not r[0]:
                    continue
                conn.execute(
                    "INSERT INTO projects(lot, status, mel_date, sub_category, category) VALUES (?,?,?,?,?) "
                    "ON CONFLICT(lot) DO UPDATE SET status=excluded.status, mel_date=excluded.mel_date, "
                    "sub_category=COALESCE(NULLIF(excluded.sub_category,''), sub_category), "
                    "category=COALESCE(NULLIF(excluded.category,''), category)",
                    (str(r[0]).strip(), str(r[1] or "IN PROGRESS").strip().upper(), parse_date(r[2]),
                     str(r[3] or "").strip() if len(r) > 3 else "", str(r[4] or "").strip() if len(r) > 4 else ""))
                rep["projects"] += 1
        # --- temps historiques
        if with_entries and "BDD - Time Sheet" in wb.sheetnames:
            for r in wb["BDD - Time Sheet"].iter_rows(min_row=2, values_only=True):
                if not r or not r[0] or not r[2]:
                    continue
                mo = _month_of(r[0])
                if not mo or mo < history_from:
                    continue
                conn.execute(
                    "INSERT INTO entries(month, collaborator, issue_key, summary, lot, hours, source) "
                    "VALUES (?,?,?,?,?,?,'history')",
                    (mo, str(r[2]).strip(), str(r[3] or ""), str(r[4] or ""), str(r[5] or "").strip(), _num(r[6])))
                rep["entries"] += 1
        # --- paramètres des factures (DAP, frais généraux, date, numéro, cost +)
        for name in wb.sheetnames:
            if "FACT. PROJET" not in name:
                continue
            rows = list(wb[name].iter_rows(values_only=True))
            if len(rows) < 12 or len(rows[2]) < 8 or len(rows[10]) < 9:
                continue      # anciens formats (2018-2019) : non repris
            lots = [r[1] for r in rows[11:] if r and isinstance(r[1], str)]
            sm = next((re.search(r" - (\d{2})/(\d{2})$", l) for l in lots if re.search(r" - (\d{2})/(\d{2})$", l)), None)
            if not sm:
                continue
            mo = f"20{sm.group(2)}-{sm.group(1)}"
            if "header" not in rep:   # en-tête de la facture la plus récente → paramètres
                g = lambda r, c: str(rows[r][c]).strip() if len(rows) > r and len(rows[r]) > c and rows[r][c] is not None else ""
                foot = next((str(r[1]) for r in rows if r and len(r) > 1 and isinstance(r[1], str) and r[1].lower().startswith("adresse")), "")
                rep["header"] = {"issuer_name": g(1, 1), "client_name": g(5, 1),
                                 "client_address": "\n".join(x for x in (g(7, 1), g(8, 1)) if x),
                                 "client_id": g(9, 1), "client_ref": g(3, 4), "issuer_footer": foot}
                for k, v in rep["header"].items():
                    if v:
                        conn.execute("UPDATE settings SET value=? WHERE key=? AND (value IS NULL OR value='')", (v, k))
            if mo < history_from or mo in rep["months"]:
                continue      # le premier onglet rencontré (le plus récent) l'emporte
            cp = next((r[2] for r in rows if r and len(r) > 2 and r[1] == "COST +"), 0.07)
            d = rows[1][4] if len(rows[1]) > 4 else None
            params = {"dap": _num(rows[2][7]), "frais_generaux": _num(rows[3][7]),
                      "cost_plus": _num(cp), "invoice_date": parse_date(d),
                      "invoice_number": str(rows[2][4]) if rows[2][4] is not None else None,
                      "sheet": name,
                      "broken": sum(1 for r in rows[11:] if r and len(r) > 4 and isinstance(r[4], str) and r[4].startswith("#")),
                      "expected_salary": _num(next((r[6] for r in rows if r and len(r) > 6 and r[1] == "SUB TOTAL"), 0)),
                      "expected_total": _num(next((r[4] for r in rows if r and len(r) > 4 and r[1] == "TOTAL"), 0)),
                      "expected_lines": {r[1]: _num(r[6]) for r in rows[11:]
                                         if r and isinstance(r[1], str) and len(r) > 6 and isinstance(r[6], (int, float))
                                         and r[1] not in ("SUB TOTAL", "COST +", "TOTAL")}}
            db.get_month(conn, mo)
            conn.execute("UPDATE months SET dap=?, frais_generaux=?, cost_plus=?, invoice_date=?, invoice_number=? "
                         "WHERE month=?", (params["dap"], params["frais_generaux"], params["cost_plus"],
                                          params["invoice_date"], params["invoice_number"], mo))
            rep["months"][mo] = params
    return rep


def deactivate_inactive(conn, since: str) -> list[str]:
    """Désactive les collaborateurs sans coût ni temps depuis ``since`` (anciens salariés)."""
    collabs = db.rows(conn, "SELECT * FROM collaborators")
    res = Resolver(collabs)
    recent = {res(r["collaborator"]) for r in db.rows(
        conn, "SELECT collaborator FROM costs WHERE month >= ? UNION SELECT collaborator FROM entries WHERE month >= ?",
        (since, since))}
    off = [c["name"] for c in collabs if c["active"] and c["name"] not in recent]
    with db.tx(conn):
        conn.executemany("UPDATE collaborators SET active = 0 WHERE name = ?", [(n,) for n in off])
    return off
