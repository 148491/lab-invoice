import importlib
import io

import openpyxl
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def app_mod(tmp_path, monkeypatch):
    monkeypatch.setenv("FACTU_DB", str(tmp_path / "api.db"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from app import db, main
    importlib.reload(db)
    importlib.reload(main)
    return main


@pytest.fixture
def admin(app_mod):
    c = TestClient(app_mod.app)
    assert c.get("/api/auth/state").json()["needs_setup"] is True
    assert c.post("/api/auth/setup", json={"username": "admin", "password": "motdepasse1"}).status_code == 200
    return c


def login(app_mod, username, password):
    c = TestClient(app_mod.app)
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return c


def test_auth_and_permissions(app_mod, admin):
    anon = TestClient(app_mod.app)
    assert anon.get("/api/months").status_code == 401
    assert anon.post("/api/auth/login", json={"username": "admin", "password": "faux"}).status_code == 401

    admin.post("/api/ref/collaborators", json={"name": "Alice Dev", "mode": "manual"})
    admin.post("/api/ref/collaborators", json={"name": "Bob Dev", "mode": "jira"})
    admin.post("/api/ref/epics", json={"label": "EPICS-2: NOUVEAU PROJET", "lot_name": "NOUVEAU PROJET", "category": "Project"})
    assert admin.post("/api/users", json={"username": "alice", "display_name": "Alice", "role": "collaborateur",
                                          "collaborator": "alice DEV", "password": "provisoire1"}).status_code == 200
    alice = login(app_mod, "alice", "provisoire1")
    me = alice.get("/api/auth/state").json()["user"]
    assert me["collaborator"] == "Alice Dev" and me["must_change"] is True

    # un collaborateur ne voit ni factures ni coûts, ne saisit que pour lui-même
    assert alice.get("/api/months").status_code == 403
    assert alice.get("/api/months/2026-10/costs").status_code == 403
    assert alice.get("/api/months/2026-10/sheets/Bob Dev").status_code == 403
    r = alice.put("/api/months/2026-10/sheets/Alice Dev",
                  json={"rows": [{"label": "EPICS-2", "hours": "12,5"}, {"label": "PROJET INCONNU", "hours": 3}], "submit": True})
    assert r.status_code == 422 and r.json()["detail"]["errors"][0]["index"] == 1
    r = alice.put("/api/months/2026-10/sheets/Alice Dev", json={"rows": [{"label": "NOUVEAU PROJET", "hours": "12,5"}], "submit": True})
    assert r.json()["hours"] == 12.5
    sheet = alice.get("/api/months/2026-10/sheets/Alice Dev").json()
    assert sheet["submitted_at"] and sheet["manual"][0]["epic"] == "EPICS-2: NOUVEAU PROJET"
    assert admin.get("/api/months/2026-10/sheets").json()[0]["manual"] == 12.5

    assert alice.post("/api/auth/password", json={"current": "provisoire1", "new": "nouveau-mdp"}).status_code == 200
    login(app_mod, "alice", "nouveau-mdp")
    assert [a["action"] for a in admin.get("/api/audit").json()[:2]] == ["connexion", "compte.mot_de_passe"]


def test_duplicate_collaborator_detection(admin):
    admin.post("/api/ref/collaborators", json={"name": "Jérôme Martin"})
    assert admin.post("/api/ref/collaborators", json={"name": "MARTIN jerome"}).status_code == 409
    chk = admin.post("/api/collaborators/check", json={"name": "Jerome Martyn"}).json()
    assert chk["duplicate"] is None and chk["suggestions"][0]["name"] == "Jérôme Martin"


def test_full_month_flow_with_review(admin):
    c = admin
    c.post("/api/ref/collaborators", json={"name": "Alice Dev", "mode": "jira"})
    c.post("/api/ref/collaborators", json={"name": "Carl Absent", "mode": "jira"})
    c.post("/api/ref/epics", json={"label": "EPICS-2: NOUVEAU PROJET", "lot_name": "NOUVEAU PROJET", "category": "Project"})
    m = "2026-10"
    pv = c.post(f"/api/months/{m}/timesheet/preview",
                data={"text": "User\tIssue key\tIssue summary\tEpic\tTime spent (hours)\n"
                              "alice.dev\tMC-1\tTicket\tEPICS-2: NOUVEAU PROJET\t140\n"
                              "Bobby Newman\tMC-2\tSans epic\t\t2\n"}).json()
    people = {p["raw"]: p for p in pv["people"]}
    assert people["alice.dev"]["canonical"] == "Alice Dev" and people["alice.dev"]["hours_status"] == "ok"
    assert people["Bobby Newman"]["status"] == "unknown" and people["Bobby Newman"]["hours_status"] == "low"
    assert [x["name"] for x in pv["missing"]] == ["Carl Absent"]
    rep = c.post(f"/api/months/{m}/timesheet/commit",
                 json={"token": pv["token"], "decisions": {"Bobby Newman": {"action": "create", "name": "Bob Newman"}}}).json()
    assert rep["details"] == 2
    bob = next(x for x in c.get("/api/ref/collaborators").json() if x["name"] == "Bob Newman")
    assert "Bobby Newman" in bob["aliases"]

    cpv = c.post(f"/api/months/{m}/costs/preview", data={"text": "Alice Dev\t1200\nNewman Bob\t300"}).json()
    assert all(p["status"] == "known" for p in cpv["people"])
    c.post(f"/api/months/{m}/costs/commit", json={"token": cpv["token"], "decisions": {}})
    c.put(f"/api/months/{m}", json={"dap": 100, "frais_generaux": 200})

    res = c.get(f"/api/months/{m}").json()
    assert res["blocking"] and any(i["code"] == "no_epic" for i in res["issues"])
    assert c.post(f"/api/months/{m}/validate").status_code == 422
    bad = next(i for i in res["issues"] if i["code"] == "no_epic")
    c.post("/api/entries/bulk-lot", json={"ids": [d["id"] for d in bad["details"]], "lot": "NOUVEAU PROJET"})
    res = c.get(f"/api/months/{m}").json()
    assert not res["blocking"]
    assert res["invoice"]["subtotal"]["price"] == pytest.approx(1800)
    assert c.post(f"/api/months/{m}/validate").json()["status"] == "validated"
    assert c.put(f"/api/months/{m}", json={"dap": 1}).status_code == 409

    x = c.get(f"/api/months/{m}/invoice.xlsx")
    ws = openpyxl.load_workbook(io.BytesIO(x.content)).worksheets[0]
    assert ws["B12"].value == "NOUVEAU PROJET" and ws["E12"].value == pytest.approx(1800)
    assert c.get("/").status_code == 200


SAMPLES = __import__("pathlib").Path(__file__).resolve().parent.parent / "samples"


@pytest.mark.skipif(not (SAMPLES / "Facturation-Paris.xlsx").exists(), reason="fichiers réels absents")
def test_bootstrap_from_excel_files(admin):
    def up(name):
        return (SAMPLES / name).read_bytes()
    files = {"facturation": ("f.xlsx", up("Facturation-Paris.xlsx")), "charges": ("c.xlsx", up("Charge-Patronale_-_BDD.xlsx")),
             "timesheet": ("t.xlsx", up("Timesheet - All Teams - October 26.xlsx"))}
    for _ in range(2):   # rejouable sans doublons
        r = admin.post("/api/import/bootstrap", files=files, data={"history_from": "2026-08"})
        assert r.status_code == 200, r.text
        rep = r.json()
        assert {m["month"]: m["status"] for m in rep["months"]} == {"2026-08": "identique", "2026-09": "identique"}
        assert rep["draft_month"] == "2026-10"
    months = {m["month"]: m for m in admin.get("/api/months").json()}
    assert months["2026-09"]["status"] == "validated" and months["2026-10"]["status"] == "draft"
    assert months["2026-09"]["total"] == pytest.approx(370695.2084, abs=0.01)
