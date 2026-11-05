"""Aperçu avant import : vérification des collaborateurs et des heures.

Avant d'écrire quoi que ce soit, on montre :
1. les noms du fichier inconnus du référentiel, avec des suggestions de rapprochement
   (algorithme local, puis IA si disponible) ;
2. les collaborateurs déclarés mais absents du fichier ;
3. les heures (ou montants) par collaborateur comparées au volume attendu du mois.
Les décisions de l'utilisateur (rattacher, créer, ignorer) sont ensuite appliquées.
"""
from __future__ import annotations

import json
import secrets
from collections import defaultdict

from . import ai, db, engine
from .names import Resolver, key


def _expected_hours(conn, month: str) -> float:
    s = db.settings(conn)
    m = db.get_month(conn, month, create=False)
    wd = m["working_days"] if m["working_days"] is not None else engine.working_days(month)
    return wd * float(s.get("hours_per_day") or 7)


def resolve_names(conn, raw_names: list[str]) -> dict[str, dict]:
    collabs = db.rows(conn, "SELECT * FROM collaborators WHERE active = 1")
    res = Resolver(db.rows(conn, "SELECT * FROM collaborators"))
    out, unknown = {}, []
    for raw in raw_names:
        if res.known(raw):
            out[raw] = {"status": "known", "canonical": res(raw), "suggestions": []}
        else:
            out[raw] = {"status": "unknown", "canonical": None, "suggestions": res.suggest(raw)}
            unknown.append(raw)
    if unknown:
        for raw, m in ai.match_names(unknown, [c["name"] for c in collabs]).items():
            sugg = [s for s in out[raw]["suggestions"] if s["name"] != m["name"]]
            out[raw]["suggestions"] = [m] + sugg[:2]
    for raw, v in out.items():
        if v["status"] == "unknown":
            best = v["suggestions"][0] if v["suggestions"] else None
            v["proposal"] = ({"action": "alias", "target": best["name"]} if best and best["score"] >= 0.8
                             else {"action": "create", "name": " ".join(raw.split()).title() if raw.islower() else " ".join(raw.split())})
    return out


def _store(conn, kind: str, month: str, payload: dict) -> str:
    token = secrets.token_urlsafe(16)
    conn.execute("DELETE FROM pending_imports WHERE created_at < datetime('now', '-1 day')")
    conn.execute("INSERT INTO pending_imports(token, kind, month, payload) VALUES (?,?,?,?)",
                 (token, kind, month, json.dumps(payload, default=str)))
    conn.commit()
    return token


def load_pending(conn, token: str, kind: str, month: str) -> dict | None:
    r = conn.execute("SELECT payload FROM pending_imports WHERE token=? AND kind=? AND month=?",
                     (token, kind, month)).fetchone()
    return json.loads(r["payload"]) if r else None


def drop_pending(conn, token: str) -> None:
    conn.execute("DELETE FROM pending_imports WHERE token=?", (token,))
    conn.commit()


# --------------------------------------------------------------------------- temps
def preview_timesheet(conn, month: str, parsed: dict) -> dict:
    s = db.settings(conn)
    tol = float(s.get("expected_tolerance") or 0.2)
    expected = _expected_hours(conn, month)
    hours = defaultdict(float)
    lines = defaultdict(int)
    no_epic = defaultdict(float)
    for d in parsed.get("details", []):
        hours[d["collaborator"]] += d["hours"]
        lines[d["collaborator"]] += 1
        if engine.is_no_epic(d["epic"]):
            no_epic[d["collaborator"]] += d["hours"]
    names = resolve_names(conn, sorted(hours))
    collabs = {c["name"]: c for c in db.rows(conn, "SELECT * FROM collaborators")}
    known_epics = {e["epic_key"] for e in db.rows(conn, "SELECT epic_key FROM epics")}
    known_epics |= {e["epic_key"] for e in parsed.get("roadmap", [])}
    unknown_epics = defaultdict(float)
    for d in parsed.get("details", []):
        if not engine.is_no_epic(d["epic"]) and engine.epic_key(d["epic"]) not in known_epics:
            unknown_epics[d["epic"]] += d["hours"]

    people = []
    merged = defaultdict(float)
    for raw, h in hours.items():
        n = names[raw]
        target = n["canonical"] or raw
        merged[target] += h
    for raw, h in sorted(hours.items(), key=lambda x: x[0].lower()):
        n = names[raw]
        c = collabs.get(n["canonical"] or "")
        mode = c["mode"] if c else None
        total = merged[n["canonical"] or raw]
        ratio = total / expected if expected else None
        if mode in ("prorata", "mirror"):
            st = "prorata"
        elif ratio is None:
            st = "ok"
        elif ratio < 1 - tol:
            st = "low"
        elif ratio > 1 + tol:
            st = "high"
        else:
            st = "ok"
        people.append({"raw": raw, **n, "hours": h, "lines": lines[raw], "no_epic_hours": no_epic.get(raw, 0),
                       "expected": expected, "ratio": ratio, "hours_status": st, "mode": mode,
                       "role": c["role"] if c else ""})
    present = {p["canonical"] for p in people if p["canonical"]}
    manual_people = {key(sm["collaborator"]) for sm in parsed.get("summaries", [])}
    missing = [{"name": c["name"], "role": c["role"], "mode": c["mode"]}
               for c in collabs.values()
               if c["active"] and c["mode"] == "jira" and c["name"] not in present]
    existing_self = {r["collaborator"]: r["h"] for r in db.rows(
        conn, "SELECT collaborator, SUM(hours) h FROM entries WHERE month=? AND source='manual' GROUP BY collaborator", (month,))}
    for m in missing:
        m["self_hours"] = existing_self.get(m["name"], 0)
    payload = {"parsed": parsed}
    token = _store(conn, "timesheet", month, payload)
    return {
        "token": token, "month": month, "file_month": parsed.get("month"),
        "month_mismatch": bool(parsed.get("month") and parsed["month"] != month),
        "expected_hours": expected, "tolerance": tol,
        "totals": {"lines": len(parsed.get("details", [])), "hours": sum(hours.values()), "people": len(hours),
                   "epics": len(parsed.get("roadmap", []))},
        "people": people, "missing": missing,
        "unknown_people": sum(1 for p in people if p["status"] == "unknown"),
        "unknown_epics": [{"epic": k, "hours": v} for k, v in sorted(unknown_epics.items(), key=lambda x: -x[1])],
        "no_epic_hours": sum(no_epic.values()),
        "summaries": [{"collaborator": sm["collaborator"], "holidays": sm["holidays"],
                       "hours": sum(r["hours"] for r in sm["rows"]),
                       "known": Resolver(list(collabs.values())).known(sm["collaborator"])}
                      for sm in parsed.get("summaries", [])],
        "manual_people": len(manual_people),
        "ai": ai.enabled(),
    }


def apply_decisions(conn, decisions: dict, user: dict | None = None) -> dict[str, str | None]:
    """decisions = {nom brut: {action: alias|create|ignore, target?, name?, role?, mode?}}.
    Renvoie {nom brut: nom canonique ou None (ignoré)}."""
    mapping = {}
    with db.tx(conn):
        for raw, d in decisions.items():
            act = d.get("action")
            if act == "ignore":
                mapping[raw] = None
            elif act == "alias":
                target = d["target"]
                r = conn.execute("SELECT id, aliases FROM collaborators WHERE name=?", (target,)).fetchone()
                if r is None:
                    raise ValueError(f"Collaborateur inconnu : {target}")
                al = json.loads(r["aliases"] or "[]")
                if key(raw) != key(target) and raw not in al:
                    al.append(raw)
                conn.execute("UPDATE collaborators SET aliases=? WHERE id=?", (json.dumps(al, ensure_ascii=False), r["id"]))
                mapping[raw] = target
            elif act == "create":
                name = " ".join((d.get("name") or raw).split())
                conn.execute("INSERT OR IGNORE INTO collaborators(name, role, mode) VALUES (?,?,?)",
                             (name, d.get("role") or "", d.get("mode") or "jira"))
                if key(name) != key(raw):
                    r = conn.execute("SELECT id, aliases FROM collaborators WHERE name=?", (name,)).fetchone()
                    al = json.loads(r["aliases"] or "[]") + [raw]
                    conn.execute("UPDATE collaborators SET aliases=? WHERE id=?", (json.dumps(al, ensure_ascii=False), r["id"]))
                mapping[raw] = name
    if decisions:
        db.audit(conn, user, "noms.rapprochement", None, {k: v for k, v in decisions.items()})
    return mapping


# --------------------------------------------------------------------------- coûts
def preview_costs(conn, month: str, lines: list[dict]) -> dict:
    by_raw = defaultdict(float)
    cats = defaultdict(list)
    months = defaultdict(float)
    for l in lines:
        months[l["month"]] += l["amount"]
        if l["month"] == month:
            by_raw[l["collaborator"]] += l["amount"]
            cats[l["collaborator"]].append({"category": l["category"], "amount": l["amount"]})
    names = resolve_names(conn, sorted(by_raw))
    hours = {r["collaborator"]: r["h"] for r in db.rows(
        conn, "SELECT collaborator, SUM(hours) h FROM entries WHERE month=? GROUP BY collaborator", (month,))}
    res = Resolver(db.rows(conn, "SELECT * FROM collaborators"))
    hours_c = defaultdict(float)
    for k, v in hours.items():
        hours_c[res(k)] += v
    prev = {r["collaborator"]: r["t"] for r in db.rows(
        conn, "SELECT collaborator, SUM(amount) t FROM costs WHERE month = (SELECT MAX(month) FROM costs WHERE month < ?) "
              "GROUP BY collaborator", (month,))}
    prev_c = defaultdict(float)
    for k, v in prev.items():
        prev_c[res(k)] += v
    people = []
    for raw, amount in sorted(by_raw.items(), key=lambda x: x[0].lower()):
        n = names[raw]
        c = n["canonical"]
        p = prev_c.get(c) if c else None
        people.append({"raw": raw, **n, "amount": amount, "categories": cats[raw],
                       "hours": hours_c.get(c, 0) if c else 0, "previous": p,
                       "variation": (amount - p) / abs(p) if p else None})
    present = {p["canonical"] for p in people if p["canonical"]}
    collabs = db.rows(conn, "SELECT * FROM collaborators WHERE active=1")
    no_cost = [{"name": c["name"], "hours": hours_c.get(c["name"], 0), "role": c["role"]}
               for c in collabs if c["name"] not in present and hours_c.get(c["name"], 0) > 0]
    token = _store(conn, "costs", month, {"lines": lines})
    return {"token": token, "month": month, "people": people, "total": sum(by_raw.values()),
            "other_months": {k: v for k, v in sorted(months.items()) if k != month},
            "unknown_people": sum(1 for p in people if p["status"] == "unknown"),
            "with_hours_no_cost": no_cost, "ai": ai.enabled()}
