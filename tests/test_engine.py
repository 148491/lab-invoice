import io
import json
from pathlib import Path

import openpyxl
import pytest

from app import db, engine, importers
from app.names import Resolver, key

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.db")
    db.init(c)
    c.executemany("INSERT INTO collaborators(name, role, mode, prorata_base, mirror_of) VALUES (?,?,?,?,?)", [
        ("Alice Dev", "Developeur", "jira", "costed", None),
        ("Bob Dev", "Developeur", "jira", "costed", None),
        ("Carl Cx", "CX Developer", "jira", "costed", None),
        ("Nina Cto", "CTO", "prorata", "jira", None),
        ("Ivan Dir", "Direction", "prorata", "costed", None),
        ("Lea Dir", "Direction", "mirror", "costed", "Ivan Dir"),
    ])
    c.executemany("INSERT INTO epics(epic_key, label, lot_name, status, mel_date, category) VALUES (?,?,?,?,?,?)", [
        ("EPICS-1", "EPICS-1: SITE - BUG FIXES", "SITE - BUG FIXES", "IN PROGRESS", None, "Support"),
        ("EPICS-2", "EPICS-2: NOUVEAU PROJET", "NOUVEAU PROJET", "IN PROGRESS", None, "Project"),
        ("EPICS-3", "EPICS-3: VIEUX PROJET", "VIEUX PROJET", "PRODUCTION", "2026-08-31", "Project"),
        ("EPICS-4", "EPICS-4: CX - BUG FIXES", "CX - BUG FIXES", "IN PROGRESS", None, "CX"),
    ])
    c.commit()
    return c


def add(conn, month, who, epic, hours, source="jira", lot=""):
    conn.execute("INSERT INTO entries(month, collaborator, issue_key, epic, lot, hours, source) VALUES (?,?,?,?,?,?,?)",
                 (month, who, "MC-1", epic, lot, hours, source))
    conn.commit()


def cost(conn, month, who, amount):
    conn.execute("INSERT INTO costs(month, collaborator, category, amount) VALUES (?,?,?,?)", (month, who, "Salaire", amount))
    conn.commit()


def only_devs(conn):
    conn.execute("UPDATE collaborators SET active=0 WHERE mode IN ('prorata','mirror')")
    conn.commit()


# ------------------------------------------------------------------ calcul de la facture
def test_invoice_math(conn):
    only_devs(conn)
    m = "2026-10"
    add(conn, m, "Alice Dev", "EPICS-2: NOUVEAU PROJET", 30)
    add(conn, m, "Alice Dev", "EPICS-1: SITE - BUG FIXES", 10)
    add(conn, m, "Bob Dev", "EPICS-2: NOUVEAU PROJET", 20)
    cost(conn, m, "Alice Dev", 8000)
    cost(conn, m, "Bob Dev", 4000)
    db.get_month(conn, m)
    conn.execute("UPDATE months SET dap=1000, frais_generaux=2000, cost_plus=0.07 WHERE month=?", (m,))
    conn.commit()

    r = engine.compute(conn, m)
    assert not r["blocking"], r["issues"]
    lines = {l["lot"]: l for l in r["invoice"]["lines"]}
    # Alice : 75 % de 8000 sur le projet, 25 % sur le support ; Bob : 100 % de 4000
    assert lines["NOUVEAU PROJET"]["salary"] == pytest.approx(6000 + 4000)
    assert lines["SITE - BUG FIXES - 10/26"]["salary"] == pytest.approx(2000)
    assert lines["SITE - BUG FIXES - 10/26"]["section"] == "support"
    assert lines["SITE - BUG FIXES - 10/26"]["status"] == "PRODUCTION"
    assert lines["SITE - BUG FIXES - 10/26"]["date_label"] == "31/10/2026"
    # DAP + FG (3000) au prorata du coût salarial
    assert lines["NOUVEAU PROJET"]["overhead"] == pytest.approx(3000 * 10000 / 12000)
    assert lines["NOUVEAU PROJET"]["price"] == pytest.approx(10000 + 2500)
    inv = r["invoice"]
    assert inv["subtotal"]["price"] == pytest.approx(15000)
    assert inv["cost_plus"]["price"] == pytest.approx(1050)
    assert inv["total"]["price"] == pytest.approx(16050)
    assert inv["lines"][0]["section"] == "projet"
    # n° de facture par défaut = numéro de série Excel de la date (31/10/2026)
    assert inv["number"] == "46326"


def test_prorata_and_mirror(conn):
    m = "2026-10"
    add(conn, m, "Alice Dev", "EPICS-2: NOUVEAU PROJET", 60)
    add(conn, m, "Bob Dev", "EPICS-1: SITE - BUG FIXES", 20)
    add(conn, m, "Carl Cx", "EPICS-4: CX - BUG FIXES", 80)       # pas de coût : hors base « costed »
    add(conn, m, "Nina Cto", "EPICS-2: NOUVEAU PROJET", 99)       # ignoré : Nina est au prorata
    for who, a in (("Alice Dev", 6000), ("Bob Dev", 2000), ("Nina Cto", 16000), ("Ivan Dir", 1000), ("Lea Dir", 3000)):
        cost(conn, m, who, a)
    db.get_month(conn, m)
    conn.execute("UPDATE months SET prorata=? WHERE month=?", (json.dumps({"Nina Cto": {"holidays": 1}}), m))
    conn.commit()

    r = engine.compute(conn, m)
    assert not r["blocking"], r["issues"]
    info = {p["collaborator"]: p for p in r["prorata"]}
    assert info["Nina Cto"]["hours"] == pytest.approx((engine.working_days(m) - 1) * 7)
    assert info["Nina Cto"]["base_hours"] == pytest.approx(160)      # base Jira : toute l'équipe
    assert info["Ivan Dir"]["base_hours"] == pytest.approx(80)       # base « costed » : sans Carl
    lines = {l["lot"]: l for l in r["invoice"]["lines"]}
    by = lambda lot, who: next(d for d in lines[lot]["detail"] if d["collaborator"] == who)
    # Nina : 60/160 de son coût sur le projet, 80/160 sur CX (heures de Carl)
    assert by("NOUVEAU PROJET", "Nina Cto")["cost"] == pytest.approx(16000 * 60 / 160)
    assert by("CX - BUG FIXES - 10/26", "Nina Cto")["cost"] == pytest.approx(16000 * 80 / 160)
    # Ivan : 60/80 projet, 20/80 support, rien sur CX ; Lea : même répartition
    assert by("NOUVEAU PROJET", "Ivan Dir")["cost"] == pytest.approx(750)
    assert by("NOUVEAU PROJET", "Lea Dir")["cost"] == pytest.approx(2250)
    assert not any(d["collaborator"] == "Ivan Dir" for d in lines["CX - BUG FIXES - 10/26"]["detail"])
    assert r["stats"]["salary_allocated"] == pytest.approx(28000)
    assert any(i["code"] == "prorata_jira_ignored" for i in r["issues"])


def test_closed_project_rule(conn):
    only_devs(conn)
    cost(conn, "2026-10", "Alice Dev", 1000)
    add(conn, "2026-10", "Alice Dev", "EPICS-3: VIEUX PROJET", 5)           # en ligne depuis le 31/08
    r = engine.compute(conn, "2026-10")
    assert r["blocking"]
    assert [i for i in r["issues"] if i["code"] == "closed_project"][0]["lot"] == "VIEUX PROJET"

    # le mois de la mise en ligne reste autorisé
    cost(conn, "2026-08", "Alice Dev", 1000)
    add(conn, "2026-08", "Alice Dev", "EPICS-3: VIEUX PROJET", 5)
    assert not any(i["code"] == "closed_project" for i in engine.compute(conn, "2026-08")["issues"])

    # projet abandonné : interdit quelle que soit la date ; lot forcé à la main aussi contrôlé
    conn.execute("INSERT INTO projects(lot, status) VALUES ('PROJET MORT', 'ABANDONED')")
    add(conn, "2026-10", "Alice Dev", "", 2, lot="PROJET MORT")
    codes = [i.get("lot") for i in engine.compute(conn, "2026-10")["issues"] if i["code"] == "closed_project"]
    assert "PROJET MORT" in codes


def test_missing_epic_and_unallocated_cost(conn):
    only_devs(conn)
    m = "2026-10"
    add(conn, m, "Alice Dev", "No epic", 3)
    add(conn, m, "Alice Dev", "EPICS-99: INCONNU", 3)
    cost(conn, m, "Alice Dev", 1000)
    cost(conn, m, "Bob Dev", 500)          # coût sans heure
    codes = {i["code"] for i in engine.compute(conn, m)["issues"] if i["level"] == "error"}
    assert {"no_epic", "unknown_epic", "cost_not_allocated"} <= codes


def test_validate_records_monthly_lots(conn):
    only_devs(conn)
    m = "2026-10"
    add(conn, m, "Alice Dev", "EPICS-1: SITE - BUG FIXES", 10)
    cost(conn, m, "Alice Dev", 1000)
    engine.validate(conn, m)
    p = conn.execute("SELECT * FROM projects WHERE lot='SITE - BUG FIXES - 10/26'").fetchone()
    assert p["status"] == "PRODUCTION" and p["mel_date"] == "2026-10-31"
    snap = engine.result(conn, m)
    assert snap["status"] == "validated"
    # une fois validée, la facture ne bouge plus même si les données changent
    cost(conn, m, "Alice Dev", 5000)
    assert engine.result(conn, m)["invoice"]["subtotal"]["salary"] == pytest.approx(1000)
    engine.reopen(conn, m)
    assert engine.result(conn, m)["invoice"]["subtotal"]["salary"] == pytest.approx(6000)


# ------------------------------------------------------------------ noms, dates
def test_name_resolution():
    r = Resolver([{"name": "Jérôme Martin", "aliases": "[]"}, {"name": "Marie Dupont", "aliases": "[]"}])
    assert r("jerome.martin") == "Jérôme Martin"
    assert r("DUPONT Marie") == "Marie Dupont"
    assert r("Marie DUPONT") == "Marie Dupont"
    assert r("Inconnu  Total") == "Inconnu Total"
    assert key("A  b") == key("B a")


def test_dates():
    assert engine.working_days("2026-10") == 21          # même valeur que l'onglet Roadmap
    assert engine.parse_date("30/09/2026") == "2026-09-30"
    assert engine.parse_date("-") is None
    assert engine.month_suffix("2026-01") == "01/26"


# ------------------------------------------------------------------ imports
def _timesheet_xlsx() -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Details"
    ws.append(["User", "Issue key", "Issue summary", "Epic", "Time spent (hours)"])
    ws.append(["alice dev", "MC-1", "Ticket", "EPICS-2: NOUVEAU PROJET", 4.5])
    rm = wb.create_sheet("Roadmap_Project_Names")
    rm.append(["Project", "JIRA NAME", "Status", "Date de MEL", "Sous Catégorie", "Catégorie", "From", "2026-10-01"])
    rm.append(["EPICS-5: AUTRE", "AUTRE", "IN PROGRESS", "-", "IF10", "Project"])
    for who, holidays, rows in (("Nina Cto", 2.5, []), ("Bob Dev", 0, [])):
        s = wb.create_sheet(f"Time_Tracking_Summary_{who.split()[0]}")
        s.append([f"Time tracking {who}"])
        s.append([])
        s.append(["Working Days (before holidays)", 21])
        s.append(["Holidays", holidays])
        s.append(["Working Days (after holidays)", 21 - holidays])
        s.append(["Total Points", 0])
        s.append([])
        s.append(["Row Labels", None, "Date", "Mois", "Collaborator", "Projects", "Sous Projet", "EPIC Key & Name",
                  "EPIC Key", "Catégorie", "LOT", "Points"])
        s.append(["EPICS-2: NOUVEAU PROJET", None, None, None, who, None, None, "EPICS-2: NOUVEAU PROJET",
                  "NOUVEAU PROJET", "Project", "NOUVEAU PROJET", 12])
        s.append(["Grand Total"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_import_timesheet_workbook(conn):
    conn.execute("UPDATE collaborators SET mode='manual' WHERE name='Bob Dev'")
    conn.commit()
    parsed = importers.parse_timesheet_workbook(_timesheet_xlsx())
    assert parsed["month"] == "2026-10"
    rep = importers.import_timesheet(conn, "2026-10", parsed)
    assert rep["details"] == 1 and rep["epics"] == 1
    assert rep["holidays"] == {"Nina Cto": 2.5}
    assert rep["manual"] == {"Bob Dev": 12}
    rows = db.rows(conn, "SELECT collaborator, hours, source FROM entries ORDER BY id")
    assert rows == [{"collaborator": "Alice Dev", "hours": 4.5, "source": "jira"},
                    {"collaborator": "Bob Dev", "hours": 12.0, "source": "manual"}]
    # réimporter remplace au lieu de doubler
    importers.import_timesheet(conn, "2026-10", parsed)
    assert conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 2


def test_costs_paste_formats():
    lines = importers.parse_costs_paste("Alice Dev\t8 000,50\nBob Dev;Salaire Brut;4000\n", "2026-10")
    assert lines[0] == {"month": "2026-10", "collaborator": "Alice Dev", "category": "Coût total", "amount": 8000.5}
    assert lines[1]["category"] == "Salaire Brut"
    datas = importers.parse_costs_paste("Mois\tnom employe\tcatégorie\tCout NIS\tType\n"
                                        "2026-09-01\tAlice Dev\tSalaire Brut\t1234.5\tReal\n"
                                        "2026-09-01\tAlice Dev\tBudget\t99\tBudget\n", "2026-10")
    assert datas == [{"month": "2026-09", "collaborator": "Alice Dev", "category": "Salaire Brut", "amount": 1234.5}]


# ------------------------------------------------------------------ données réelles (si présentes)
SAMPLES = ROOT / "samples"


@pytest.mark.skipif(not (SAMPLES / "Facturation-Paris.xlsx").exists(), reason="fichiers réels absents")
def test_real_september_2026_matches_excel(tmp_path):
    c = db.connect(tmp_path / "real.db")
    db.init(c)
    rep = importers.import_facturation_workbook(c, SAMPLES / "Facturation-Paris.xlsx", history_from="2026-08")
    importers.import_costs(c, importers.parse_costs_workbook(SAMPLES / "Charge-Patronale_-_BDD.xlsx"), {"2026-08", "2026-09"})
    for m in ("2026-08", "2026-09"):
        res = engine.compute(c, m)
        exp = rep["months"][m]
        assert res["invoice"]["subtotal"]["salary"] == pytest.approx(exp["expected_salary"], abs=0.01)
        assert res["invoice"]["total"]["price"] == pytest.approx(exp["expected_total"], abs=0.01)
        calc = {l["lot"]: l["salary"] for l in res["invoice"]["lines"]}
        for lot, v in exp["expected_lines"].items():
            assert calc[lot] == pytest.approx(v, abs=0.01), lot


def test_monthly_lots_by_name():
    s = {"monthly_keywords": db.DEFAULT_SETTINGS["monthly_keywords"]}
    assert db.monthly_kind("CSE - MINOR EVOLUTIONS", s) == "Agile"
    assert db.monthly_kind("CSE - BUG FIXES", s) == "Support"
    assert db.monthly_kind("IRESA - BUGS MANAGEMENT", s) == "Support"
    assert db.monthly_kind("CX - REUNIONS & PILOTAGE", s) == "Run"
    assert db.monthly_kind("FASTERIZE", s) == "Run"
    assert db.monthly_kind("CX - DIGITRIPS", s) is None
    assert db.monthly_kind("SILO PAGES 2026", s) is None



def _ai_reply(provider, payload):
    import httpx
    content = json.dumps(payload)
    if provider == "openai":
        return httpx.Response(200, json={"choices": [{"message": {"content": content, "refusal": None}}]})
    if provider == "google":
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": content}]}}]})
    return httpx.Response(200, json={"id": "msg_1", "type": "message", "role": "assistant", "model": "m",
                                      "content": [{"type": "text", "text": content}], "stop_reason": "end_turn",
                                      "usage": {"input_tokens": 1, "output_tokens": 1}})


@pytest.mark.parametrize("provider", ["openai", "google", "anthropic"])
def test_ai_providers(monkeypatch, provider):
    import httpx
    from app import ai
    seen = []
    answer = {"matches": [
        {"input": "jerome.martin", "match": "Jérôme Martin", "confidence": 0.95, "reason": "identifiant"},
        {"input": "Pirate", "match": "Pas dans la liste", "confidence": 0.9, "reason": "invention"}]}

    def handler(request):
        body = json.loads(request.content) if request.content else {}
        seen.append((request.url.path, body))
        # le niveau de raisonnement est refusé : l'appel doit être rejoué sans lui
        if "reasoning_effort" in body or "thinkingConfig" in body.get("generationConfig", {}) \
                or body.get("output_config", {}).get("effort"):
            return httpx.Response(400, json={"error": {"type": "invalid_request_error", "message": "unsupported"}})
        return _ai_reply(provider, answer)

    def mock(h):
        if provider == "anthropic":   # le SDK Anthropic peut utiliser httpx2 selon sa version
            try:
                import httpx2
                return monkeypatch.setattr(ai, "anthropic_transport", httpx2.MockTransport(
                    lambda r: _as(httpx2, h(r))))
            except ImportError:
                return monkeypatch.setattr(ai, "anthropic_transport", httpx.MockTransport(h))
        monkeypatch.setattr(ai, "transport", httpx.MockTransport(h))

    mock(handler)
    cfg = {"provider": provider, "key": "k", "model": "mon-modele", "effort": "high"}
    out = ai.match_names(["jerome.martin", "Pirate"], ["Jérôme Martin", "Marie Dupont"], cfg=cfg)
    assert out == {"jerome.martin": {"name": "Jérôme Martin", "score": 0.95, "reason": "IA : identifiant"}}
    assert len(seen) >= 2 and "mon-modele" in json.dumps(seen)
    # erreur fournisseur : pas d'exception, retour au rapprochement local
    mock(lambda r: httpx.Response(401, json={"error": {"message": "bad key"}}))
    assert ai.match_names(["x"], ["y"], cfg=cfg) == {}


def _as(mod, resp):
    """Convertit une réponse httpx en réponse du module HTTP du SDK."""
    return mod.Response(resp.status_code, content=resp.content, headers={"content-type": "application/json"})


def test_ai_list_models_filters(monkeypatch):
    import httpx
    from app import ai
    data = {"data": [{"id": "gpt-6.1", "created": 3}, {"id": "gpt-6", "created": 2}, {"id": "text-embedding-3", "created": 9},
                     {"id": "whisper-1", "created": 1}, {"id": "o5-mini", "created": 4}, {"id": "gpt-6-realtime", "created": 5}]}
    monkeypatch.setattr(ai, "transport", httpx.MockTransport(lambda r: httpx.Response(200, json=data)))
    assert [m["id"] for m in ai.list_models("openai", "k")] == ["o5-mini", "gpt-6.1", "gpt-6"]


def test_prorata_costed_fallback_and_manual_lots(conn):
    import json as _j
    m = "2026-10"
    add(conn, m, "Alice Dev", "EPICS-2: NOUVEAU PROJET", 60)
    add(conn, m, "Bob Dev", "EPICS-1: SITE - BUG FIXES", 20)
    cost(conn, "2026-09", "Alice Dev", 5000)       # charges d'octobre pas encore chargées
    cost(conn, "2026-09", "Bob Dev", 2000)
    r = engine.compute(conn, m)
    ivan = next(x for x in r["prorata"] if x["collaborator"] == "Ivan Dir")
    assert ivan["base_hours"] == pytest.approx(80) and ivan["costed_source"] == "2026-09"
    assert {l["lot"] for l in ivan["lots"]} == {"NOUVEAU PROJET", "SITE - BUG FIXES - 10/26"}

    # ajustement manuel : 10 h projet, 30 h support → 25 % / 75 % du coût d'Ivan
    cost(conn, m, "Alice Dev", 6000); cost(conn, m, "Bob Dev", 2000); cost(conn, m, "Ivan Dir", 1000)
    db.get_month(conn, m)
    conn.execute("UPDATE months SET prorata=? WHERE month=?",
                 (_j.dumps({"Ivan Dir": {"lots": {"NOUVEAU PROJET": 10, "SITE - BUG FIXES - 10/26": 30}}}), m))
    conn.commit()
    r = engine.compute(conn, m)
    ivan = next(x for x in r["prorata"] if x["collaborator"] == "Ivan Dir")
    assert ivan["manual"] and ivan["hours"] == pytest.approx(40)
    lines = {l["lot"]: l for l in r["invoice"]["lines"]}
    by = lambda lot: next(d for d in lines[lot]["detail"] if d["collaborator"] == "Ivan Dir")["cost"]
    assert by("NOUVEAU PROJET") == pytest.approx(250) and by("SITE - BUG FIXES - 10/26") == pytest.approx(750)
