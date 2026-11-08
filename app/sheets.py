"""Feuilles de temps saisies dans l'application (par chacun, ou pour le compte d'un collaborateur)."""
from __future__ import annotations

import re
from difflib import get_close_matches

from . import db, engine, importers


def options(conn, month: str) -> list[dict]:
    """Lots sur lesquels on peut déclarer du temps ce mois-ci (epics et projets ouverts)."""
    first = engine.month_first(month).isoformat()
    out, seen = [], set()
    for e in db.rows(conn, "SELECT * FROM epics ORDER BY category, label"):
        # ouvert = en cours, ou mis en ligne pendant ce mois-ci (dernières heures possibles)
        open_ = e["status"] == "IN PROGRESS" or (e["status"] == "PRODUCTION" and e["mel_date"] and e["mel_date"] >= first)
        if not open_:
            continue
        out.append({"value": e["label"], "lot": e["lot_name"], "kind": "epic", "category": e["category"] or "",
                    "key": e["epic_key"]})
        seen.add(e["lot_name"].casefold())
    for p in db.rows(conn, "SELECT * FROM projects WHERE status='IN PROGRESS' ORDER BY lot"):
        if p["lot"].casefold() in seen or re.search(r" - \d{2}/\d{2}$", p["lot"]):
            continue
        out.append({"value": p["lot"], "lot": p["lot"], "kind": "projet", "category": p["category"] or "", "key": ""})
    return out


def resolve_label(conn, label: str, opts: list[dict] | None = None) -> dict:
    """Epic (« EPICS-2: … », « EPICS-2 »), nom de lot ou de projet → {epic, lot, display} ou suggestions."""
    lab = " ".join(str(label or "").split())
    if not lab:
        return {"ok": False, "error": "vide"}
    k = engine.epic_key(lab)
    e = conn.execute("SELECT * FROM epics WHERE epic_key = ? OR label = ? COLLATE NOCASE OR lot_name = ? COLLATE NOCASE",
                     (k, lab, lab)).fetchone()
    if e:
        return {"ok": True, "epic": e["label"], "lot": "", "display": e["label"]}
    p = conn.execute("SELECT * FROM projects WHERE lot = ? COLLATE NOCASE", (lab,)).fetchone()
    if p:
        return {"ok": True, "epic": "", "lot": p["lot"], "display": p["lot"]}
    opts = opts if opts is not None else options(conn, "9999-12")
    pool = {o["value"].casefold(): o["value"] for o in opts} | {o["lot"].casefold(): o["value"] for o in opts}
    sugg = get_close_matches(lab.casefold(), list(pool), n=3, cutoff=0.6)
    return {"ok": False, "error": "lot inconnu", "suggestions": list(dict.fromkeys(pool[s] for s in sugg))}


def parse_text(conn, month: str, text: str) -> list[dict]:
    """Collage libre : « lot ⇥ heures », « ticket ⇥ résumé ⇥ epic ⇥ heures » ou une ligne d'export Jira."""
    opts = options(conn, month)
    rows = []
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        parts = [x.strip() for x in re.split(r"\t|;", line)]
        parts = [x for x in parts if x != ""]
        if not parts or importers.norm(parts[0]) in {"user", "lot", "epic", "projet", "project"}:
            continue
        hours = importers._num(parts[-1]) if len(parts) > 1 else 0.0
        label = next((p for p in parts[:-1] if engine.epic_key(p) != p), None) or parts[-2 if len(parts) > 1 else 0]
        ticket = next((p for p in parts[:-1] if re.match(r"^[A-Z][A-Z0-9]+-\d+$", p)), "")
        summary = parts[1] if len(parts) >= 4 else ""
        r = resolve_label(conn, label, opts)
        rows.append({"label": r.get("display") or label, "hours": hours, "issue_key": ticket, "summary": summary,
                     "ok": r["ok"] and hours > 0, "error": None if r["ok"] else r["error"],
                     "suggestions": r.get("suggestions", []), "raw": line})
    return rows


def get_sheet(conn, month: str, collaborator: str) -> dict:
    rows = db.rows(conn, "SELECT * FROM entries WHERE month=? AND collaborator=? COLLATE NOCASE ORDER BY source, id",
                   (month, collaborator))
    st = conn.execute("SELECT * FROM sheet_status WHERE month=? AND collaborator=?", (month, collaborator)).fetchone()
    s = db.settings(conn)
    m = db.get_month(conn, month, create=False)
    wd = m["working_days"] if m["working_days"] is not None else engine.working_days(month)
    return {
        "month": month, "collaborator": collaborator, "locked": m["status"] == "validated",
        "expected": wd * float(s.get("hours_per_day") or 7), "working_days": wd,
        "manual": [r for r in rows if r["source"] == "manual"],
        "jira": [r for r in rows if r["source"] == "jira"],
        "jira_hours": sum(r["hours"] for r in rows if r["source"] == "jira"),
        "submitted_at": st["submitted_at"] if st else None, "submitted_by": st["submitted_by"] if st else None,
    }


def save_sheet(conn, month: str, collaborator: str, rows: list[dict], submit: bool, user: dict) -> dict:
    opts = options(conn, month)
    clean, bad = [], []
    for i, r in enumerate(rows):
        h = importers._num(r.get("hours"))
        if not str(r.get("label") or "").strip() and not h:
            continue
        res = resolve_label(conn, r.get("label", ""), opts)
        if not res["ok"] or h <= 0:
            bad.append({"index": i, "label": r.get("label"), "error": res.get("error") or "heures manquantes",
                        "suggestions": res.get("suggestions", [])})
            continue
        clean.append((month, collaborator, r.get("issue_key") or "", (r.get("comment") or r.get("summary") or "").strip()[:300],
                      res["epic"], res["lot"], h))
    if bad:
        return {"ok": False, "errors": bad}
    with db.tx(conn):
        conn.execute("DELETE FROM entries WHERE month=? AND collaborator=? COLLATE NOCASE AND source='manual'",
                     (month, collaborator))
        conn.executemany("INSERT INTO entries(month, collaborator, issue_key, summary, epic, lot, hours, source) "
                         "VALUES (?,?,?,?,?,?,?,'manual')", clean)
        if submit:
            conn.execute("INSERT INTO sheet_status(month, collaborator, submitted_at, submitted_by) "
                         "VALUES (?,?,datetime('now'),?) ON CONFLICT(month, collaborator) DO UPDATE SET "
                         "submitted_at=excluded.submitted_at, submitted_by=excluded.submitted_by",
                         (month, collaborator, user["username"]))
    db.audit(conn, user, "temps.saisie" + (".soumise" if submit else ""), month,
             {"collaborateur": collaborator, "lignes": len(clean), "heures": sum(c[-1] for c in clean)})
    return {"ok": True, "lines": len(clean), "hours": sum(c[-1] for c in clean)}


def overview(conn, month: str) -> list[dict]:
    """Avancement des feuilles de temps du mois, par collaborateur."""
    s = db.settings(conn)
    m = db.get_month(conn, month, create=False)
    wd = m["working_days"] if m["working_days"] is not None else engine.working_days(month)
    expected = wd * float(s.get("hours_per_day") or 7)
    agg = {}
    for r in db.rows(conn, "SELECT collaborator, source, SUM(hours) h, COUNT(*) n FROM entries WHERE month=? "
                           "GROUP BY collaborator, source", (month,)):
        a = agg.setdefault(r["collaborator"].casefold(), {"jira": 0.0, "manual": 0.0, "history": 0.0})
        a[r["source"]] = a.get(r["source"], 0) + r["h"]
    st = {r["collaborator"].casefold(): r for r in db.rows(conn, "SELECT * FROM sheet_status WHERE month=?", (month,))}
    out = []
    for c in db.rows(conn, "SELECT * FROM collaborators WHERE active=1 ORDER BY name"):
        a = agg.get(c["name"].casefold(), {"jira": 0.0, "manual": 0.0, "history": 0.0})
        total = sum(a.values())
        out.append({"name": c["name"], "role": c["role"], "mode": c["mode"], "jira": a["jira"] + a.get("history", 0), "manual": a["manual"],
                    "total": total, "expected": expected,
                    "submitted_at": st.get(c["name"].casefold(), {}).get("submitted_at") if st.get(c["name"].casefold()) else None})
    return out
