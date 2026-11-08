"""Données des tableaux de bord d'analyse (factures validées uniquement)."""
from __future__ import annotations

import re

from . import db, engine

SUF = re.compile(r"\s*-\s*\d{2}/\d{2}$")


def domain(lot: str) -> str:
    """Domaine déduit du nom du lot (préfixe), en attendant un champ dédié dans les epics."""
    base = SUF.sub("", lot).strip()
    up = base.upper()
    for key, label in (("TRAVELSKI NIGHT EXPRESS", "TNE"), ("BOOKING FUNNEL", "BOOKING FUNNEL"), ("MIGDAL", "MIGDAL"),
                       ("CX", "CX"), ("TNE", "TNE"), ("ADYEN", "ADYEN"), ("YOONLY", "YOONLY"), ("WIDGET", "WIDGET"),
                       ("CMS", "CMS"), ("CSE", "CSE"), ("UX/UI", "UX/UI"), ("PROMO CODE", "PROMO CODE"),
                       ("EUROTOURS", "EUROTOURS"), ("FLIGHT", "FLIGHT"), ("SEO", "SEO"), ("SILO", "SILO"), ("RESORT", "RESORTS")):
        if up.startswith(key):
            return label
    if "FLIGHT PROJECT" in up:
        return "FLIGHT"
    return base.split(" - ")[0].strip()


def build(conn) -> dict:
    s = db.settings(conn)
    validated = [r["month"] for r in conn.execute("SELECT month FROM months WHERE status='validated' ORDER BY month")]
    months, lots, team = [], [], {}
    for mo in validated:
        inv = engine.result(conn, mo)["invoice"]
        months.append({"m": mo, "total": inv["total"]["price"], "salary": inv["subtotal"]["salary"],
                       "dap": inv["dap"], "fg": inv["frais_generaux"], "hours": sum(l["hours"] for l in inv["lines"]),
                       "lots": len(inv["lines"])})
        for l in inv["lines"]:
            kind = db.monthly_kind(l["lot"], s) or "Projet"
            lots.append({"m": mo, "lot": l["lot"], "base": SUF.sub("", l["lot"]).strip(), "kind": kind,
                         "dom": domain(l["lot"]), "price": round(l["price"], 2), "salary": round(l["salary"], 2),
                         "hours": round(l["hours"], 2),
                         "team": [[d["collaborator"], round(d["hours"], 1)] for d in l["detail"] if d["hours"] >= 0.05]})
            for d in l["detail"]:
                t = team.setdefault(d["collaborator"], {}).setdefault(mo, {})
                t[kind] = round(t.get(kind, 0) + d["hours"], 2)
    status = {}
    proj = {p["lot"]: (p["status"], p["mel_date"]) for p in db.rows(conn, "SELECT lot, status, mel_date FROM projects")}
    epics = {e["lot_name"]: (e["status"], e["mel_date"]) for e in db.rows(conn, "SELECT lot_name, status, mel_date FROM epics")}
    for x in lots:
        if x["kind"] == "Projet" and x["lot"] not in status:
            stt = proj.get(x["lot"]) or epics.get(x["lot"]) or ("IN PROGRESS", None)
            status[x["lot"]] = {"status": stt[0], "mel": stt[1]}
    return {"months": months, "lots": lots, "status": status, "currency": s.get("currency") or "",
            "team": [{"name": n, "hours": h} for n, h in team.items()]}
