"""API HTTP + service de l'interface web.

Lancement : ``uvicorn app.main:app`` puis http://localhost:8000
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import ai, auth, bootstrap, db, engine, export, importers, review, sheets
from .names import Resolver

STATIC = Path(__file__).resolve().parent.parent / "static"
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
SECURE_COOKIE = os.environ.get("FACTU_SECURE_COOKIE", "0") == "1"

app = FastAPI(title="Lab Facturation", docs_url=None, redoc_url=None)
conn = db.ThreadLocalConnection()
db.init(conn)
current_user, require = auth.make_dependencies(lambda: conn)


def _emergency_admin_reset() -> None:
    """Secours « mot de passe administrateur oublié ».

    Si la variable d'environnement FACTU_RESET_ADMIN_PASSWORD est définie au démarrage, tous les
    comptes administrateurs reçoivent ce mot de passe (à changer à la connexion suivante) et sont
    réactivés. Retirez la variable une fois la connexion rétablie.
    """
    pw = os.environ.get("FACTU_RESET_ADMIN_PASSWORD", "").strip()
    if not pw:
        return
    admins = db.rows(conn, "SELECT id, username FROM users WHERE role='admin'")
    with db.tx(conn):
        for a in admins:
            conn.execute("UPDATE users SET password_hash=?, must_change=1, active=1 WHERE id=?",
                         (auth.hash_password(pw), a["id"]))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (a["id"],))
    db.audit(conn, {"username": "système"}, "compte.reinitialisation_admin", None,
             {"comptes": [a["username"] for a in admins]})
    print(f"[secours] mot de passe réinitialisé pour les administrateurs : "
          f"{', '.join(a['username'] for a in admins) or 'aucun'}", flush=True)


_emergency_admin_reset()

VIEW = Depends(require("view"))
TIME_ALL = Depends(require("time.all"))
COSTS = Depends(require("costs"))
INVOICE = Depends(require("invoice"))
REF = Depends(require("ref"))
USERS = Depends(require("users"))


def _month(m: str) -> str:
    if not MONTH_RE.match(m):
        raise HTTPException(400, "Mois attendu au format AAAA-MM")
    return m


def _editable(m: str) -> None:
    if db.get_month(conn, m, create=False)["status"] == "validated":
        raise HTTPException(409, "Mois validé : réouvrez-le pour le modifier.")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "SAMEORIGIN"
    resp.headers["Referrer-Policy"] = "same-origin"
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ================================================================== authentification
@app.get("/api/auth/state")
def auth_state(request: Request):
    n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    user = None
    try:
        user = auth.public_user(current_user(request))
    except HTTPException:
        pass
    return {"needs_setup": n == 0, "user": user, "ai": ai.enabled(), "ai_label": ai.label()}


def _set_cookie(resp: Response, token: str):
    resp.set_cookie(auth.COOKIE, token, httponly=True, samesite="lax", secure=SECURE_COOKIE,
                    max_age=auth.SESSION_DAYS * 86400, path="/")


@app.post("/api/auth/setup")
def auth_setup(response: Response, body: dict = Body(...)):
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        raise HTTPException(409, "Déjà initialisé")
    auth.check_password_strength(body.get("password"))
    username = (body.get("username") or "").strip()
    if not username:
        raise HTTPException(400, "Identifiant requis")
    with db.tx(conn):
        cur = conn.execute("INSERT INTO users(username, display_name, role, password_hash) VALUES (?,?,?,?)",
                           (username, body.get("display_name") or username, "admin", auth.hash_password(body["password"])))
    _set_cookie(response, auth.create_session(conn, cur.lastrowid))
    db.audit(conn, {"username": username}, "compte.initialisation")
    return {"ok": True}


@app.post("/api/auth/login")
def login(response: Response, body: dict = Body(...)):
    username = (body.get("username") or "").strip()
    if auth.throttled(username):
        raise HTTPException(429, "Trop de tentatives : réessayez dans quelques minutes.")
    r = conn.execute("SELECT * FROM users WHERE username = ? AND active = 1", (username,)).fetchone()
    if r is None or not auth.verify_password(body.get("password") or "", r["password_hash"]):
        auth.record_failure(username)
        raise HTTPException(401, "Identifiant ou mot de passe incorrect")
    _set_cookie(response, auth.create_session(conn, r["id"]))
    db.audit(conn, dict(r), "connexion")
    return {"user": auth.public_user(dict(r))}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(auth.COOKIE)
    if token:
        with db.tx(conn):
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))
    response.delete_cookie(auth.COOKIE, path="/")
    return {"ok": True}


@app.post("/api/auth/password")
def change_password(body: dict = Body(...), user=Depends(current_user)):
    if not auth.verify_password(body.get("current") or "", user["password_hash"]):
        raise HTTPException(400, "Mot de passe actuel incorrect")
    auth.check_password_strength(body.get("new"))
    with db.tx(conn):
        conn.execute("UPDATE users SET password_hash=?, must_change=0 WHERE id=?", (auth.hash_password(body["new"]), user["id"]))
    db.audit(conn, user, "compte.mot_de_passe")
    return {"ok": True}


# ================================================================== comptes
@app.get("/api/users")
def users_list(user=USERS):
    return {"users": [auth.public_user(u) for u in db.rows(conn, "SELECT * FROM users ORDER BY active DESC, display_name")],
            "roles": {k: {"label": v["label"], "perms": sorted(v["perms"])} for k, v in auth.ROLES.items()}}


@app.post("/api/users")
def users_upsert(body: dict = Body(...), user=USERS):
    role = body.get("role") or "collaborateur"
    if role not in auth.ROLES:
        raise HTTPException(400, "Rôle inconnu")
    collab = body.get("collaborator") or None
    if collab:
        r = Resolver(db.rows(conn, "SELECT * FROM collaborators"))
        if not r.known(collab):
            raise HTTPException(400, f"« {collab} » n'est pas dans le référentiel des collaborateurs.")
        collab = r(collab)
    with db.tx(conn):
        if body.get("id"):
            if body["id"] == user["id"] and (role != "admin" or not body.get("active", True)):
                raise HTTPException(400, "Vous ne pouvez pas retirer vos propres droits d'administrateur.")
            conn.execute("UPDATE users SET display_name=?, role=?, collaborator=?, active=? WHERE id=?",
                         (body.get("display_name") or "", role, collab, int(body.get("active", True)), body["id"]))
            if body.get("password"):
                auth.check_password_strength(body["password"])
                conn.execute("UPDATE users SET password_hash=?, must_change=1 WHERE id=?",
                             (auth.hash_password(body["password"]), body["id"]))
                conn.execute("DELETE FROM sessions WHERE user_id=?", (body["id"],))
        else:
            username = (body.get("username") or "").strip()
            if not re.match(r"^[\w.@-]{2,60}$", username):
                raise HTTPException(400, "Identifiant invalide (lettres, chiffres, . _ - @)")
            auth.check_password_strength(body.get("password"))
            try:
                conn.execute("INSERT INTO users(username, display_name, role, collaborator, password_hash, must_change) "
                             "VALUES (?,?,?,?,?,1)", (username, body.get("display_name") or username, role, collab,
                                                      auth.hash_password(body["password"])))
            except Exception:
                raise HTTPException(409, "Cet identifiant existe déjà")
    db.audit(conn, user, "compte.modification", None, {"compte": body.get("username") or body.get("id"), "role": role})
    return {"ok": True}


# ================================================================== réglages
@app.get("/api/settings")
def get_settings(user=Depends(current_user)):
    return db.settings(conn)


@app.put("/api/settings")
def put_settings(values: dict = Body(...), user=USERS):
    with db.tx(conn):
        for k, v in values.items():
            conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (k, v if isinstance(v, str) else json.dumps(v)))
    db.audit(conn, user, "parametres")
    return db.settings(conn)


# ================================================================== mois
@app.get("/api/months")
def list_months(user=VIEW):
    months = {r["month"] for r in conn.execute("SELECT month FROM months UNION SELECT DISTINCT month FROM entries")}
    out = []
    for m in sorted(months, reverse=True):
        mm = db.get_month(conn, m, create=False)
        snap = mm["snapshot"]
        out.append({
            "month": m, "status": mm["status"],
            "entries": conn.execute("SELECT COUNT(*) FROM entries WHERE month=?", (m,)).fetchone()[0],
            "costs": conn.execute("SELECT COUNT(*) FROM costs WHERE month=?", (m,)).fetchone()[0],
            "dap": mm["dap"], "frais_generaux": mm["frais_generaux"],
            "total": snap["invoice"]["total"]["price"] if snap else None,
            "salary": snap["invoice"]["subtotal"]["salary"] if snap else None,
            "lines": len(snap["invoice"]["lines"]) if snap else None,
        })
    return out


@app.get("/api/months/{month}")
def get_month(month: str, user=VIEW):
    return engine.result(conn, _month(month))


@app.put("/api/months/{month}")
def put_month(month: str, values: dict = Body(...), user=Depends(current_user)):
    _editable(_month(month))
    db.get_month(conn, month)
    groups = {"working_days": "time.all", "prorata": "time.all", "dap": "invoice", "frais_generaux": "invoice",
              "cost_plus": "invoice", "invoice_date": "invoice", "invoice_number": "invoice"}
    with db.tx(conn):
        for k, v in values.items():
            if k not in groups:
                continue
            if not auth.has(user, groups[k]):
                raise HTTPException(403, "Vous n'avez pas les droits pour modifier ce paramètre")
            if k == "prorata":
                v = json.dumps(v)
            if v == "":
                v = None
            conn.execute(f"UPDATE months SET {k}=? WHERE month=?", (v, month))
    db.audit(conn, user, "mois.parametres", month, values)
    return engine.compute(conn, month)


@app.post("/api/months/{month}/validate")
def validate_month(month: str, force: bool = False, user=INVOICE):
    _month(month)
    try:
        res = engine.validate(conn, month, force=force)
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.audit(conn, user, "facture.validation" + (".forcee" if force else ""), month,
             {"total": round(res["invoice"]["total"]["price"], 2)})
    return res


@app.post("/api/months/{month}/reopen")
def reopen_month(month: str, user=INVOICE):
    engine.reopen(conn, _month(month))
    db.audit(conn, user, "facture.reouverture", month)
    return engine.compute(conn, month)


@app.get("/api/months/{month}/invoice.xlsx")
def invoice_xlsx(month: str, user=VIEW):
    res = engine.result(conn, _month(month))
    data = export.invoice_workbook(res, db.settings(conn))
    d = res["invoice"]["date"].replace("-", "")
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="Facture-{month}-{d}.xlsx"'})


# ================================================================== temps : import avec aperçu
@app.post("/api/months/{month}/timesheet/preview")
async def timesheet_preview(month: str, file: UploadFile | None = File(None), text: str = Form(""), user=TIME_ALL):
    _editable(_month(month))
    if file is not None:
        try:
            parsed = importers.parse_timesheet_workbook(await file.read())
        except Exception as e:
            raise HTTPException(400, f"Fichier illisible : {e}")
        parsed["filename"] = file.filename
    else:
        parsed = {"details": importers.parse_timesheet_paste(text), "roadmap": [], "summaries": [], "month": None}
    if not parsed["details"]:
        raise HTTPException(400, "Aucune ligne de temps trouvée (colonnes User / Issue key / Issue summary / Epic / Time spent).")
    return review.preview_timesheet(conn, month, parsed)


@app.post("/api/months/{month}/timesheet/commit")
def timesheet_commit(month: str, body: dict = Body(...), user=TIME_ALL):
    _editable(_month(month))
    pending = review.load_pending(conn, body.get("token", ""), "timesheet", month)
    if pending is None:
        raise HTTPException(410, "Aperçu expiré : rechargez le fichier.")
    try:
        mapping = review.apply_decisions(conn, body.get("decisions") or {}, user)
    except ValueError as e:
        raise HTTPException(400, str(e))
    rep = importers.import_timesheet(conn, month, pending["parsed"], update_epics=body.get("update_epics", True),
                                     mapping=mapping)
    review.drop_pending(conn, body["token"])
    db.audit(conn, user, "temps.import", month, {"fichier": pending["parsed"].get("filename"), "lignes": rep["details"]})
    return rep


@app.get("/api/months/{month}/entries")
def list_entries(month: str, user=TIME_ALL):
    return db.rows(conn, "SELECT * FROM entries WHERE month=? ORDER BY collaborator, issue_key", (_month(month),))


@app.post("/api/months/{month}/entries")
def add_entry(month: str, e: dict = Body(...), user=TIME_ALL):
    _editable(_month(month))
    with db.tx(conn):
        cur = conn.execute(
            "INSERT INTO entries(month, collaborator, issue_key, summary, epic, lot, hours, source) VALUES (?,?,?,?,?,?,?,?)",
            (month, e.get("collaborator", ""), e.get("issue_key", ""), e.get("summary", "Ajout manuel"),
             e.get("epic", ""), e.get("lot", ""), float(e.get("hours") or 0), "manual"))
    db.audit(conn, user, "temps.ajout", month, e)
    return {"id": cur.lastrowid}


@app.patch("/api/entries/{entry_id}")
def patch_entry(entry_id: int, e: dict = Body(...), user=TIME_ALL):
    row = conn.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    _editable(row["month"])
    with db.tx(conn):
        for k in ("lot", "hours", "epic", "collaborator", "summary"):
            if k in e:
                conn.execute(f"UPDATE entries SET {k}=? WHERE id=?", (e[k], entry_id))
    db.audit(conn, user, "temps.correction", row["month"], {"id": entry_id, **e})
    return {"ok": True}


@app.post("/api/entries/bulk-lot")
def bulk_lot(payload: dict = Body(...), user=TIME_ALL):
    ids = [int(i) for i in payload.get("ids", [])]
    if not ids:
        return {"updated": 0}
    months = {r["month"] for r in conn.execute(
        f"SELECT DISTINCT month FROM entries WHERE id IN ({','.join('?' * len(ids))})", ids)}
    for m in months:
        _editable(m)
    with db.tx(conn):
        conn.executemany("UPDATE entries SET lot=? WHERE id=?", [(payload.get("lot", ""), i) for i in ids])
    db.audit(conn, user, "temps.affectation_lot", next(iter(months), None), {"lignes": len(ids), "lot": payload.get("lot")})
    return {"updated": len(ids)}


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: int, user=TIME_ALL):
    row = conn.execute("SELECT month FROM entries WHERE id=?", (entry_id,)).fetchone()
    if row:
        _editable(row["month"])
        with db.tx(conn):
            conn.execute("DELETE FROM entries WHERE id=?", (entry_id,))
        db.audit(conn, user, "temps.suppression", row["month"], {"id": entry_id})
    return {"ok": True}


# ================================================================== feuilles de temps (saisie par chacun)
def _sheet_access(user: dict, collaborator: str) -> str:
    r = Resolver(db.rows(conn, "SELECT * FROM collaborators"))
    if not r.known(collaborator):
        raise HTTPException(404, "Collaborateur inconnu")
    name = r(collaborator)
    if auth.has(user, "time.all"):
        return name
    if auth.has(user, "time.self") and user.get("collaborator") and r(user["collaborator"]) == name:
        return name
    raise HTTPException(403, "Vous ne pouvez saisir que vos propres temps")


@app.get("/api/months/{month}/sheets")
def sheets_overview(month: str, user=TIME_ALL):
    return sheets.overview(conn, _month(month))


@app.get("/api/lots/options")
def lot_options(month: str, user=Depends(current_user)):
    return sheets.options(conn, _month(month))


@app.get("/api/months/{month}/sheets/{collaborator}")
def sheet_get(month: str, collaborator: str, user=Depends(current_user)):
    return sheets.get_sheet(conn, _month(month), _sheet_access(user, collaborator))


@app.post("/api/months/{month}/sheets/{collaborator}/parse")
def sheet_parse(month: str, collaborator: str, body: dict = Body(...), user=Depends(current_user)):
    _sheet_access(user, collaborator)
    return sheets.parse_text(conn, _month(month), body.get("text", ""))


@app.put("/api/months/{month}/sheets/{collaborator}")
def sheet_put(month: str, collaborator: str, body: dict = Body(...), user=Depends(current_user)):
    name = _sheet_access(user, collaborator)
    _editable(_month(month))
    res = sheets.save_sheet(conn, month, name, body.get("rows") or [], bool(body.get("submit")), user)
    if not res["ok"]:
        raise HTTPException(422, {"message": "Certaines lignes ne sont pas valides", "errors": res["errors"]})
    return res


# ================================================================== coûts
@app.get("/api/months/{month}/costs")
def list_costs(month: str, user=COSTS):
    return db.rows(conn, "SELECT * FROM costs WHERE month=? ORDER BY collaborator, category", (_month(month),))


@app.post("/api/months/{month}/costs/preview")
async def costs_preview(month: str, file: UploadFile | None = File(None), text: str = Form(""), user=COSTS):
    _editable(_month(month))
    if file is not None:
        try:
            lines = importers.parse_costs_workbook(await file.read())
        except Exception as e:
            raise HTTPException(400, str(e))
    else:
        lines = importers.parse_costs_paste(text, month)
    if not any(l["month"] == month for l in lines):
        found = sorted({l["month"] for l in lines})
        raise HTTPException(400, f"Aucun coût pour {month} dans ces données" + (f" (mois trouvés : {', '.join(found[-6:])})." if found else "."))
    return review.preview_costs(conn, month, lines)


@app.post("/api/months/{month}/costs/commit")
def costs_commit(month: str, body: dict = Body(...), user=COSTS):
    _editable(_month(month))
    pending = review.load_pending(conn, body.get("token", ""), "costs", month)
    if pending is None:
        raise HTTPException(410, "Aperçu expiré : rechargez les données.")
    mapping = review.apply_decisions(conn, body.get("decisions") or {}, user)
    target = {month}
    if body.get("all_months"):
        validated = {r["month"] for r in conn.execute("SELECT month FROM months WHERE status='validated'")}
        target |= {l["month"] for l in pending["lines"]} - validated
    rep = importers.import_costs(conn, pending["lines"], target, mapping=mapping)
    review.drop_pending(conn, body["token"])
    db.audit(conn, user, "charges.import", month, {m: round(v["total"], 2) for m, v in rep.items()})
    return rep


@app.put("/api/months/{month}/costs/{collaborator}")
def set_cost(month: str, collaborator: str, payload: dict = Body(...), user=COSTS):
    _editable(_month(month))
    name = Resolver(db.rows(conn, "SELECT * FROM collaborators"))(collaborator)
    with db.tx(conn):
        conn.execute("DELETE FROM costs WHERE month=? AND collaborator=? COLLATE NOCASE", (month, name))
        if payload.get("amount") not in (None, ""):
            conn.execute("INSERT INTO costs(month, collaborator, category, amount) VALUES (?,?,?,?)",
                         (month, name, "Saisie", float(payload["amount"])))
    db.audit(conn, user, "charges.saisie", month, {"collaborateur": name})
    return {"ok": True}


@app.post("/api/months/{month}/costs/copy-previous")
def copy_previous_costs(month: str, user=COSTS):
    _editable(_month(month))
    prev = conn.execute("SELECT MAX(month) FROM costs WHERE month < ?", (month,)).fetchone()[0]
    if not prev:
        raise HTTPException(404, "Aucun mois précédent avec des coûts.")
    lines = db.rows(conn, "SELECT collaborator, category, amount FROM costs WHERE month=?", (prev,))
    importers.import_costs(conn, [{**l, "month": month} for l in lines], {month})
    db.audit(conn, user, "charges.copie", month, {"depuis": prev})
    return {"from": prev, "lines": len(lines)}


# ================================================================== référentiels
TABLES = {
    "collaborators": ("id", ["name", "role", "mode", "prorata_base", "mirror_of", "aliases", "active"]),
    "epics": ("epic_key", ["epic_key", "label", "lot_name", "status", "mel_date", "sub_category", "category"]),
    "projects": ("lot", ["lot", "status", "mel_date", "sub_category", "category"]),
}


def _table(name):
    if name not in TABLES:
        raise HTTPException(404)
    return TABLES[name]


@app.get("/api/ref/{table}")
def ref_list(table: str, user=Depends(current_user)):
    pk, _ = _table(table)
    if table != "collaborators" and not auth.has(user, "view"):
        raise HTTPException(403)
    order = {"collaborators": "active DESC, name", "epics": "status DESC, category, label",
             "projects": "COALESCE(mel_date, '9999') DESC, lot"}[table]
    return db.rows(conn, f"SELECT * FROM {table} ORDER BY {order}")


@app.post("/api/collaborators/check")
def collaborator_check(body: dict = Body(...), user=REF):
    """Avant de créer un collaborateur : existe-t-il déjà sous une autre graphie ?"""
    name = " ".join((body.get("name") or "").split())
    r = Resolver(db.rows(conn, "SELECT * FROM collaborators WHERE id != ?", (body.get("id") or 0,)))
    if r.known(name):
        return {"duplicate": r(name), "suggestions": []}
    sugg = r.suggest(name, threshold=0.72)
    if not sugg and ai.enabled():
        m = ai.match_names([name], r.names).get(name)
        sugg = [m] if m else []
    return {"duplicate": None, "suggestions": sugg}


@app.post("/api/ref/{table}")
def ref_upsert(table: str, item: dict = Body(...), user=REF):
    pk, cols = _table(table)
    data = {c: item.get(c) for c in cols if c in item}
    if "mel_date" in data:
        data["mel_date"] = engine.parse_date(data["mel_date"])
    if "status" in data and data["status"]:
        data["status"] = str(data["status"]).upper()
    if table == "epics" and not data.get("epic_key"):
        data["epic_key"] = engine.epic_key(data.get("label", ""))
    if table == "collaborators":
        if isinstance(data.get("aliases"), list):
            data["aliases"] = json.dumps(data["aliases"], ensure_ascii=False)
        if "name" in data:
            data["name"] = " ".join((data["name"] or "").split())
            if not data["name"]:
                raise HTTPException(400, "Nom requis")
            r = Resolver(db.rows(conn, "SELECT * FROM collaborators WHERE id != ?", (item.get("id") or 0,)))
            if r.known(data["name"]) and not item.get("force"):
                raise HTTPException(409, f"Ce collaborateur existe déjà : {r(data['name'])}")
    original = item.get("_original")
    try:
        with db.tx(conn):
            if original is not None or (pk == "id" and item.get("id")):
                ident = original if original is not None else item["id"]
                if table == "collaborators" and "name" in data:
                    old = conn.execute("SELECT name FROM collaborators WHERE id=?", (ident,)).fetchone()
                    if old and old["name"] != data["name"]:   # renommage : on garde l'ancien nom en alias
                        al = json.loads(data.get("aliases") or conn.execute(
                            "SELECT aliases FROM collaborators WHERE id=?", (ident,)).fetchone()["aliases"] or "[]")
                        data["aliases"] = json.dumps(sorted(set(al) | {old["name"]}), ensure_ascii=False)
                        conn.execute("UPDATE entries SET collaborator=? WHERE collaborator=?", (data["name"], old["name"]))
                        conn.execute("UPDATE users SET collaborator=? WHERE collaborator=?", (data["name"], old["name"]))
                sets = ", ".join(f"{c}=?" for c in data)
                conn.execute(f"UPDATE {table} SET {sets} WHERE {pk}=?", [*data.values(), ident])
            else:
                keys = ", ".join(data)
                conn.execute(f"INSERT INTO {table}({keys}) VALUES ({', '.join('?' * len(data))})", list(data.values()))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(409, f"Enregistrement impossible : {e}")
    db.audit(conn, user, f"referentiel.{table}", None, {k: v for k, v in data.items() if k != "aliases"})
    return {"ok": True}


@app.delete("/api/ref/{table}/{ident:path}")
def ref_delete(table: str, ident: str, user=REF):
    pk, _ = _table(table)
    with db.tx(conn):
        conn.execute(f"DELETE FROM {table} WHERE {pk}=?", (ident,))
    db.audit(conn, user, f"referentiel.{table}.suppression", None, {"id": ident})
    return {"ok": True}


@app.post("/api/import/facturation")
async def import_facturation(file: UploadFile = File(...), user=USERS):
    rep = importers.import_facturation_workbook(conn, await file.read(), with_entries=False)
    rep["months"] = sorted(rep["months"])
    db.audit(conn, user, "referentiel.import_excel", None, {"salaries": rep["collaborators"], "projets": rep["projects"]})
    return rep


@app.post("/api/import/bootstrap")
async def import_bootstrap(facturation: UploadFile = File(...), charges: UploadFile = File(...),
                           timesheet: UploadFile | None = File(None), history_from: str = Form("2025-01"),
                           user=USERS):
    """Reprise complète de l'existant depuis les trois classeurs Excel (rejouable)."""
    import io
    _month(history_from)
    try:
        rep = bootstrap.load(conn, io.BytesIO(await facturation.read()), io.BytesIO(await charges.read()),
                             io.BytesIO(await timesheet.read()) if timesheet is not None else None,
                             history_from=history_from, log=lambda *_: None)
    except Exception as e:
        raise HTTPException(400, f"Reprise impossible : {e}")
    db.audit(conn, user, "reprise.excel", None, {"factures": len(rep["months"]), "lignes": rep["entries"]})
    rep["markdown"] = bootstrap.markdown(rep)
    return rep


@app.get("/api/audit")
def audit_list(limit: int = 300, user=USERS):
    return db.rows(conn, "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (min(limit, 2000),))


@app.get("/api/search")
def search(q: str, user=Depends(current_user)):
    """Recherche globale (palette de commandes)."""
    q = q.strip()
    if len(q) < 2 or not auth.has(user, "view"):
        return []
    like = f"%{q}%"
    out = [{"type": "collaborateur", "label": r["name"], "sub": r["role"]} for r in
           db.rows(conn, "SELECT name, role FROM collaborators WHERE name LIKE ? OR aliases LIKE ? LIMIT 6", (like, like))]
    out += [{"type": "projet", "label": r["lot"], "sub": r["status"]} for r in
            db.rows(conn, "SELECT lot, status FROM projects WHERE lot LIKE ? ORDER BY COALESCE(mel_date,'9999') DESC LIMIT 8", (like,))]
    out += [{"type": "epic", "label": r["label"], "sub": r["category"]} for r in
            db.rows(conn, "SELECT label, category FROM epics WHERE label LIKE ? LIMIT 6", (like,))]
    return out


# ================================================================== interface
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
