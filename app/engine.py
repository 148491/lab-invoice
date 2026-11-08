"""Moteur de calcul de la facture mensuelle.

Reproduit la chaîne Excel d'origine :

1. Temps : timesheet Jira (+ saisies manuelles), chaque ligne rattachée à un
   LOT à partir de son epic (référentiel Roadmap). Les epics des catégories
   récurrentes (Agile, Support, CX) donnent un lot mensuel « NOM - MM/YY ».
2. Répartitions au prorata : certains collaborateurs (CTO, direction…) ne
   saisissent pas leur temps ; leur total d'heures du mois est réparti sur les
   lots au prorata des heures de l'équipe (mode « miroir » : même répartition qu'un autre).
3. Coût d'une ligne = coût employeur mensuel du collaborateur
   × heures de la ligne / total d'heures du collaborateur sur le mois.
4. Facture : coût salarial par lot (« PROJET SALAIRES »), puis
   (DAP + Frais généraux) répartis au prorata de ce coût (« DAP + OP. COST »),
   PRICE = somme des deux ; SUB TOTAL ; COST + (7 %) ; TOTAL.

Règle de clôture : un projet passé en production (ou abandonné) à une date
donnée ne peut plus recevoir d'heures sur un mois postérieur à cette date.
"""
from __future__ import annotations

import calendar
import json
import re
from collections import defaultdict
from datetime import date, timedelta

from . import db
from .names import Resolver

CLOSED_STATUSES = {"PRODUCTION", "ABANDONED"}


# --------------------------------------------------------------------------- dates
def month_first(month: str) -> date:
    y, m = map(int, month.split("-"))
    return date(y, m, 1)


def month_last(month: str) -> date:
    d = month_first(month)
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def month_suffix(month: str) -> str:
    d = month_first(month)
    return f"{d.month:02d}/{d.year % 100:02d}"


def working_days(month: str) -> int:
    """NETWORKDAYS.INTL(début, fin, 7) : week-end vendredi + samedi."""
    d, end, n = month_first(month), month_last(month), 0
    while d <= end:
        if d.weekday() not in (4, 5):
            n += 1
        d += timedelta(days=1)
    return n


def excel_serial(d: date) -> int:
    return (d - date(1899, 12, 30)).days


def parse_date(v) -> str | None:
    """Accepte datetime, 'jj/mm/aaaa', 'aaaa-mm-jj', '-' ; renvoie ISO ou None."""
    if v is None:
        return None
    if hasattr(v, "date") and callable(v.date):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    if not s or s in {"-", "—"}:
        return None
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s)
    if m:
        dd, mm, yy = map(int, m.groups())
        yy += 2000 if yy < 100 else 0
        return date(yy, mm, dd).isoformat()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return date(*map(int, m.groups())).isoformat()
    return None


def fr_date(iso: str | None) -> str:
    if not iso:
        return "-"
    y, m, d = iso.split("-")
    return f"{d}/{m}/{y}"


# --------------------------------------------------------------------------- epics / lots
def epic_key(epic: str | None) -> str:
    """'EPICS-194: SILO PAGES 2026' -> 'EPICS-194'."""
    if not epic:
        return ""
    s = str(epic).strip()
    m = re.match(r"^([A-Z][A-Z0-9]*-\d+)\s*:", s)
    return m.group(1) if m else s


def is_no_epic(epic: str | None) -> bool:
    return not epic or str(epic).strip().lower() in {"no epic", "none", "-", "(blank)", ""}


def section_for(lot: str, category: str = "", sub_category: str = "") -> str:
    """Les bug fixes / support sont regroupés dans le second bloc de la facture."""
    if (category or "").lower() == "support" or (sub_category or "").lower().startswith("support"):
        return "support"
    if re.search(r"\bBUGS?\b", lot or "", re.I):
        return "support"
    return "projet"


# --------------------------------------------------------------------------- calcul
def _issue(level: str, code: str, message: str, details=None, **extra) -> dict:
    return {"level": level, "code": code, "message": message, "details": details or [], **extra}


def compute(conn, month: str) -> dict:
    s = db.settings(conn)
    params = db.get_month(conn, month)
    hpd = float(s.get("hours_per_day") or 7)
    monthly = lambda name: db.monthly_kind(name, s)  # noqa: E731
    wd = params["working_days"] if params["working_days"] is not None else working_days(month)
    first, last = month_first(month), month_last(month)
    suffix = month_suffix(month)

    collabs = db.rows(conn, "SELECT * FROM collaborators")
    resolve = Resolver(collabs)
    collab_by_name = {c["name"]: c for c in collabs}
    epics = {e["epic_key"]: e for e in db.rows(conn, "SELECT * FROM epics")}
    epics_by_label = {e["label"].strip().casefold(): e for e in epics.values()}
    projects = {p["lot"].casefold(): p for p in db.rows(conn, "SELECT * FROM projects")}

    issues: list[dict] = []

    # ---- coûts employeur du mois (somme de toutes les catégories)
    costs: dict[str, float] = defaultdict(float)
    cost_lines = db.rows(conn, "SELECT * FROM costs WHERE month = ?", (month,))
    for r in cost_lines:
        costs[resolve(r["collaborator"])] += r["amount"]

    # ---- temps saisis
    raw = db.rows(conn, "SELECT * FROM entries WHERE month = ? ORDER BY id", (month,))
    entries = []
    no_epic, unknown_epic, unknown_people, ignored_prorata = [], defaultdict(list), set(), defaultdict(float)
    for e in raw:
        name = resolve(e["collaborator"])
        c = collab_by_name.get(name)
        if c is None:
            unknown_people.add(name)
        elif c["mode"] in ("prorata", "mirror") and e["source"] != "history":
            # leur temps est recalculé au prorata : on ignore leurs worklogs Jira
            ignored_prorata[name] += e["hours"]
            continue
        lot, cat, sub, ep = e["lot"] or "", "", "", None
        if not lot:
            if is_no_epic(e["epic"]):
                no_epic.append(e)
            else:
                ep = epics.get(epic_key(e["epic"])) or epics_by_label.get(str(e["epic"]).strip().casefold())
                if ep is None:
                    unknown_epic[str(e["epic"]).strip()].append(e)
                else:
                    lot = ep["lot_name"] + (f" - {suffix}" if monthly(ep["lot_name"]) else "")
        if ep is None and e["epic"] and not is_no_epic(e["epic"]):
            ep = epics.get(epic_key(e["epic"]))
        if ep is not None:
            cat, sub = monthly(ep["lot_name"]) or ep["category"] or "", ep["sub_category"] or ""
        proj = projects.get(lot.casefold()) if lot else None
        if proj is not None and not cat:
            cat, sub = proj["category"] or "", proj["sub_category"] or ""
        entries.append({**e, "collaborator": name, "lot": lot, "category": cat, "sub_category": sub,
                        "epic_row": ep, "auto": not e["lot"]})

    if no_epic:
        issues.append(_issue(
            "error", "no_epic",
            f"{len(no_epic)} ligne(s) sans epic : à envoyer au chef de projet, ou affecter un lot à la main.",
            [{"id": e["id"], "collaborator": resolve(e["collaborator"]), "issue_key": e["issue_key"],
              "summary": e["summary"], "hours": e["hours"]} for e in no_epic]))
    for label, es in unknown_epic.items():
        issues.append(_issue(
            "error", "unknown_epic",
            f"Epic inconnue du référentiel : « {label} » ({sum(x['hours'] for x in es):.2f} h).",
            [{"id": e["id"], "collaborator": resolve(e["collaborator"]), "issue_key": e["issue_key"],
              "summary": e["summary"], "hours": e["hours"]} for e in es], epic=label))
    for name in sorted(unknown_people):
        issues.append(_issue("warning", "unknown_collaborator",
                             f"Collaborateur inconnu du référentiel : {name} (créé automatiquement en mode Jira à la validation)."))
    for name, h in ignored_prorata.items():
        issues.append(_issue("info", "prorata_jira_ignored",
                             f"{h:.2f} h Jira de {name} ignorées : son temps est réparti au prorata."))

    valid = [e for e in entries if e["lot"]]

    # ---- répartitions au prorata, puis miroirs
    generated: dict[str, list[dict]] = {}
    prorata_info = []
    already = {e["collaborator"] for e in valid}   # historique : répartition déjà faite
    for c in sorted(collabs, key=lambda c: c["name"]):
        if not c["active"] or c["mode"] != "prorata" or c["name"] in already:
            continue
        p = params["prorata"].get(c["name"], {})
        holidays = float(p.get("holidays") or 0)
        total = float(p["hours"]) if p.get("hours") not in (None, "") else max(wd - holidays, 0) * hpd
        base = defaultdict(float)
        for e in valid:
            ec = collab_by_name.get(e["collaborator"])
            if ec is not None and ec["mode"] in ("prorata", "mirror"):
                continue
            if c["prorata_base"] == "costed" and abs(costs.get(e["collaborator"], 0)) < 0.005:
                continue
            if c["prorata_base"] == "jira" and e["source"] != "jira":
                continue
            base[(e["lot"], e["category"], e["sub_category"])] += e["hours"]
        bt = sum(base.values())
        gen = []
        if bt > 0 and total > 0:
            for (lot, cat, sub), h in base.items():
                if h:
                    gen.append({"id": None, "month": month, "collaborator": c["name"], "issue_key": "",
                                "summary": "Répartition au prorata", "epic": "", "lot": lot,
                                "category": cat, "sub_category": sub, "hours": total * h / bt,
                                "source": "prorata", "auto": True})
        generated[c["name"]] = gen
        prorata_info.append({"collaborator": c["name"], "holidays": holidays, "hours": total,
                             "hours_override": p.get("hours"), "base": c["prorata_base"], "base_hours": bt,
                             "mode": "prorata"})
    for c in collabs:
        if c["active"] and c["mode"] == "mirror" and c["name"] not in already:
            src = generated.get(c["mirror_of"] or "", None)
            if src is None:
                src_entries = [e for e in valid if e["collaborator"] == c["mirror_of"]]
                src = src_entries
                if not src_entries:
                    issues.append(_issue("warning", "mirror_missing",
                                         f"{c['name']} reprend la répartition de « {c['mirror_of']} », qui n'a aucune heure ce mois-ci."))
            generated[c["name"]] = [{**e, "id": None, "collaborator": c["name"], "source": "prorata",
                                     "summary": f"Identique à {c['mirror_of']}"} for e in src]
            prorata_info.append({"collaborator": c["name"], "mode": "mirror", "mirror_of": c["mirror_of"],
                                 "hours": sum(e["hours"] for e in generated[c["name"]])})
    all_entries = valid + [e for g in generated.values() for e in g]

    # ---- coût de chaque ligne
    hours_by_collab = defaultdict(float)
    for e in all_entries:
        hours_by_collab[e["collaborator"]] += e["hours"]
    for e in all_entries:
        H = hours_by_collab[e["collaborator"]]
        e["cost"] = costs.get(e["collaborator"], 0.0) * e["hours"] / H if H else 0.0

    for info in prorata_info:
        agg = defaultdict(lambda: [0.0, 0.0])
        for e in generated.get(info["collaborator"], []):
            agg[e["lot"]][0] += e["hours"]
            agg[e["lot"]][1] += e["cost"]
        info["lots"] = sorted(({"lot": k, "hours": v[0], "cost": v[1]} for k, v in agg.items()), key=lambda x: -x["hours"])

    people = []
    names = set(hours_by_collab) | {n for n, v in costs.items() if abs(v) > 0.005}
    for n in sorted(names):
        c = collab_by_name.get(n, {})
        H, C = hours_by_collab.get(n, 0.0), costs.get(n, 0.0)
        people.append({"collaborator": n, "role": c.get("role", ""), "mode": c.get("mode", "jira"),
                       "hours": H, "cost": C, "allocated": C if H else 0.0,
                       "cost_per_hour": C / H if H else None, "expected_hours": wd * hpd})
        if H == 0 and abs(C) > 0.005:
            issues.append(_issue("error", "cost_not_allocated",
                                 f"Coût de {n} ({C:,.2f}) non réparti : aucune heure sur le mois.".replace(",", " "),
                                 collaborator=n))
        if C < 0:
            issues.append(_issue("warning", "negative_cost",
                                 f"Coût employeur négatif pour {n} ({C:,.2f}) : régularisation (miluim, provisions…) ? "
                                 "Il viendra en déduction des lots.".replace(",", " "), collaborator=n))
        if H > 0 and cost_lines and n not in costs and c.get("mode", "jira") == "jira":
            issues.append(_issue("info", "no_cost",
                                 f"Pas de coût employeur pour {n} ({H:.2f} h) : ses heures sont valorisées à 0.",
                                 collaborator=n))
    if not cost_lines:
        issues.append(_issue("error", "no_costs", "Aucun coût employeur chargé pour ce mois."))
    if not raw:
        issues.append(_issue("error", "no_timesheet", "Aucun temps importé pour ce mois."))

    # ---- règle de clôture : pas d'heures sur un projet déjà en ligne / abandonné
    closed = defaultdict(list)
    for e in valid:
        if e["source"] == "history":
            continue
        for ref, kind in ((projects.get(e["lot"].casefold()), "projet"), (e["epic_row"], "epic")):
            if ref and (ref["status"] or "").upper() in CLOSED_STATUSES:
                d = ref["mel_date"]
                if (ref["status"].upper() == "ABANDONED") or (d and d < first.isoformat()):
                    closed[(e["lot"], ref["status"].upper(), d, kind)].append(e)
                    break
    for (lot, status, d, kind), es in closed.items():
        label = "abandonné" if status == "ABANDONED" else f"en ligne depuis le {fr_date(d)}"
        issues.append(_issue(
            "error", "closed_project",
            f"« {lot} » est {label} : aucune heure ne peut y être passée en {suffix} "
            f"({sum(x['hours'] for x in es):.2f} h).",
            [{"id": x["id"], "collaborator": x["collaborator"], "issue_key": x["issue_key"],
              "summary": x["summary"], "hours": x["hours"]} for x in es], lot=lot))

    # ---- agrégation par lot
    lots: dict[str, dict] = {}
    for e in all_entries:
        L = lots.setdefault(e["lot"], {"lot": e["lot"], "category": e["category"], "sub_category": e["sub_category"],
                                       "hours": 0.0, "cost": 0.0, "by_collab": defaultdict(lambda: [0.0, 0.0])})
        L["hours"] += e["hours"]
        L["cost"] += e["cost"]
        L["category"] = L["category"] or e["category"]
        L["sub_category"] = L["sub_category"] or e["sub_category"]
        bc = L["by_collab"][e["collaborator"]]
        bc[0] += e["hours"]
        bc[1] += e["cost"]

    overhead = (params["dap"] or 0) + (params["frais_generaux"] or 0)
    salary_total = sum(L["cost"] for L in lots.values())
    lines = []
    for L in lots.values():
        if abs(L["cost"]) < 0.005:
            continue
        is_rec = L["lot"].endswith(f" - {suffix}")
        proj = projects.get(L["lot"].casefold())
        if is_rec:
            status, mel = "PRODUCTION", last.isoformat()
        elif proj:
            status, mel = proj["status"], proj["mel_date"]
        else:
            ep = next((e["epic_row"] for e in valid if e["lot"] == L["lot"] and e["epic_row"]), None)
            status, mel = (ep["status"], ep["mel_date"]) if ep else ("IN PROGRESS", None)
        pct = L["cost"] / salary_total if salary_total else 0
        oh = overhead * pct
        lines.append({
            "lot": L["lot"], "status": status, "mel_date": mel, "date_label": fr_date(mel) if status == "PRODUCTION" else "-",
            "category": L["category"], "section": section_for(L["lot"], L["category"], L["sub_category"]),
            "recurring": is_rec, "hours": L["hours"], "salary": L["cost"], "pct": pct, "overhead": oh,
            "price": L["cost"] + oh,
            "detail": sorted(({"collaborator": k, "hours": v[0], "cost": v[1]} for k, v in L["by_collab"].items()),
                             key=lambda x: -x["cost"]),
        })
    lines.sort(key=lambda x: (x["section"] != "projet", -x["salary"]))

    cp = params["cost_plus"] if params["cost_plus"] is not None else 0.07
    sub = {"price": sum(l["price"] for l in lines), "salary": sum(l["salary"] for l in lines),
           "overhead": sum(l["overhead"] for l in lines)}
    invoice_date = params["invoice_date"] or last.isoformat()
    invoice_number = params["invoice_number"] or str(excel_serial(date.fromisoformat(invoice_date)))
    invoice = {
        "date": invoice_date, "number": invoice_number, "dap": params["dap"] or 0,
        "frais_generaux": params["frais_generaux"] or 0, "overhead": overhead, "cost_plus_rate": cp,
        "lines": lines, "subtotal": sub,
        "cost_plus": {k: v * cp for k, v in sub.items()},
        "total": {k: v * (1 + cp) for k, v in sub.items()},
    }

    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda i: order[i["level"]])
    return {
        "month": month, "suffix": suffix, "status": params["status"], "working_days": wd,
        "working_days_default": working_days(month), "hours_per_day": hpd,
        "params": {k: params[k] for k in ("dap", "frais_generaux", "cost_plus", "invoice_date",
                                          "invoice_number", "prorata", "working_days")},
        "issues": issues, "blocking": any(i["level"] == "error" for i in issues),
        "people": people, "prorata": prorata_info, "invoice": invoice,
        "stats": {"entries": len(raw), "hours": sum(e["hours"] for e in all_entries),
                  "cost_total": sum(costs.values()), "salary_allocated": salary_total,
                  "lots": len(lines)},
    }


def validate(conn, month: str, force: bool = False) -> dict:
    """Fige la facture et inscrit les lots mensuels comme livrés (MEP Dates)."""
    res = compute(conn, month)
    if res["blocking"] and not force:
        raise ValueError("Des contrôles bloquants restent à corriger.")
    last = month_last(month).isoformat()
    with db.tx(conn):
        for l in res["invoice"]["lines"]:
            if l["recurring"]:
                conn.execute(
                    "INSERT INTO projects(lot, status, mel_date, category, sub_category) VALUES (?,?,?,?,?) "
                    "ON CONFLICT(lot) DO UPDATE SET status='PRODUCTION', mel_date=excluded.mel_date",
                    (l["lot"], "PRODUCTION", last, l["category"], ""))
            else:
                conn.execute("INSERT OR IGNORE INTO projects(lot, status, mel_date, category) VALUES (?,?,?,?)",
                             (l["lot"], l["status"] or "IN PROGRESS", l["mel_date"], l["category"]))
        for p in res["people"]:
            conn.execute("INSERT OR IGNORE INTO collaborators(name, mode) VALUES (?, 'jira')", (p["collaborator"],))
        res["status"] = "validated"
        conn.execute("UPDATE months SET status='validated', snapshot=? WHERE month=?",
                     (json.dumps(res, default=str), month))
    return res


def reopen(conn, month: str) -> None:
    with db.tx(conn):
        conn.execute("UPDATE months SET status='draft', snapshot=NULL WHERE month=?", (month,))


def result(conn, month: str) -> dict:
    """Facture figée si le mois est validé, sinon calcul à la volée."""
    m = db.get_month(conn, month)
    if m["status"] == "validated" and m["snapshot"]:
        return {**m["snapshot"], "status": "validated"}
    return compute(conn, month)
