"""Reprise de l'existant : charge les trois classeurs Excel et contrôle l'historique.

Utilisé par l'assistant « Reprise des fichiers Excel » (Paramètres) et par ``scripts/seed.py``.
Rejouable : l'historique importé précédemment est remplacé, les comptes et les saisies
faites dans l'application sont conservés.
"""
from __future__ import annotations

from . import db, engine, importers


def _months_before(month: str, n: int) -> str:
    y, m = map(int, month.split("-"))
    m -= n
    while m < 1:
        m += 12
        y -= 1
    return f"{y:04d}-{m:02d}"


def load(conn, facturation, charges, timesheet=None, history_from: str = "2025-01",
         draft_month: str | None = None, log=print) -> dict:
    # rejouable : on retire l'historique déjà repris et on réouvre les mois concernés
    with db.tx(conn):
        conn.execute("DELETE FROM entries WHERE source='history' AND month >= ?", (history_from,))
        conn.execute("UPDATE months SET status='draft', snapshot=NULL WHERE month >= ? AND status='validated'",
                     (history_from,))

    log("• Référentiel et historique (Facturation Paris)…")
    rep = importers.import_facturation_workbook(conn, facturation, history_from=history_from)
    log(f"  {rep['collaborators']} salariés, {rep['projects']} projets, {rep['entries']} lignes de temps, "
        f"{len(rep['months'])} factures")

    log("• Coûts employeur (Charge patronale)…")
    costs = importers.parse_costs_workbook(charges)
    cr = importers.import_costs(conn, costs)
    log(f"  {len(costs)} lignes sur {len(cr)} mois")
    since = _months_before(max(cr), 3) if cr else history_from
    off = importers.deactivate_inactive(conn, since)
    log(f"  {len(off)} anciens collaborateurs désactivés (aucune activité depuis {since})")

    ts = None
    if timesheet is not None:
        log("• Référentiel des epics (Roadmap du timesheet)…")
        ts = importers.parse_timesheet_workbook(timesheet)
        with db.tx(conn):
            importers.upsert_epics(conn, ts["roadmap"])
        log(f"  {len(ts['roadmap'])} epics")

    log("• Recalcul de l'historique et comparaison avec les factures Excel…")
    months = []
    for mo in sorted(rep["months"]):
        p = rep["months"][mo]
        res = engine.compute(conn, mo)
        inv = res["invoice"]
        calc = {l["lot"]: l["salary"] for l in inv["lines"]}
        exp = p["expected_lines"]
        d_sal = inv["subtotal"]["salary"] - p["expected_salary"]
        worst = max((abs(calc.get(k, 0) - v), k) for k, v in exp.items()) if exp else (0.0, "")
        status = "identique" if abs(d_sal) < 1 and worst[0] < 1 else "ecart"
        if p.get("broken"):
            status = "excel_casse"
        months.append({
            "month": mo, "sheet": p["sheet"], "status": status, "lines_excel": len(exp), "lines_calc": len(calc),
            "salary_excel": p["expected_salary"], "salary_calc": inv["subtotal"]["salary"], "salary_diff": d_sal,
            "total_excel": p["expected_total"], "total_calc": inv["total"]["price"],
            "worst_lot": worst[1], "worst_diff": worst[0],
            "missing": sorted(set(calc) - set(exp))[:6], "extra": sorted(set(exp) - set(calc))[:6],
            "negative": [x["collaborator"] for x in res["people"] if x["cost"] < 0],
        })
        engine.validate(conn, mo, force=True)
        log(f"  {mo}: {status} (écart salaires {d_sal:,.2f})")

    draft = draft_month or (ts or {}).get("month")
    if draft and draft not in rep["months"]:
        db.get_month(conn, draft)
        log(f"• Mois {draft} prêt : importez son timesheet depuis l'écran Temps")
    return {"collaborators": rep["collaborators"], "projects": rep["projects"], "entries": rep["entries"],
            "cost_lines": len(costs), "cost_months": len(cr), "deactivated": off,
            "epics": len(ts["roadmap"]) if ts else 0, "months": months, "draft_month": draft}


def markdown(report: dict) -> str:
    lines = ["# Contrôle de l'historique : recalcul vs factures Excel", "",
             "Chaque mois est recalculé à partir des temps de l'onglet *BDD - Time Sheet* et des coûts du "
             "fichier *Charge Patronale*, puis comparé à l'onglet facture correspondant.", "",
             "| Mois | Onglet | Lignes Excel / calculées | Salaires Excel | Salaires recalculés | Écart | "
             "Total Excel | Total recalculé | Verdict |", "|---|---|---|---:|---:|---:|---:|---:|---|"]
    verdict = {"identique": "✅ identique", "ecart": "⚠️ écart", "excel_casse": "➖ onglet Excel en erreur (#REF!)"}
    notes = []
    for m in report["months"]:
        lines.append(f"| {m['month']} | {m['sheet']} | {m['lines_excel']} / {m['lines_calc']} | {m['salary_excel']:,.2f} | "
                     f"{m['salary_calc']:,.2f} | {m['salary_diff']:,.2f} | {m['total_excel']:,.2f} | {m['total_calc']:,.2f} | "
                     f"{verdict[m['status']]} |".replace(",", " "))
        if m["status"] == "ecart":
            n = [f"**{m['month']}** : plus gros écart sur « {m['worst_lot']} » ({m['worst_diff']:,.2f})".replace(",", " ")]
            if m["missing"]:
                n.append("lots absents de la facture Excel : " + ", ".join(m["missing"]))
            if m["extra"]:
                n.append("lots de la facture Excel non retrouvés : " + ", ".join(m["extra"]))
            if m["negative"]:
                n.append("coût employeur négatif dans le fichier actuel : " + ", ".join(m["negative"]))
            notes.append("- " + " ; ".join(n))
    if notes:
        lines += ["", "## Détail des écarts", "", "Les écarts viennent des données sources modifiées après l'émission "
                  "de la facture, pas de la méthode de calcul.", "", *notes]
    return "\n".join(lines) + "\n"
