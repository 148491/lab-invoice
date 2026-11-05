"""Export Excel de la facture (même mise en page que les onglets « FACT. PROJET »)."""
from __future__ import annotations

import io
from datetime import date

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .engine import fr_date

NUM = '#,##0.00'
PCT = '0.00%'
BOLD = Font(bold=True)
HEAD = PatternFill("solid", fgColor="1F3A5F")
SUBF = PatternFill("solid", fgColor="E8EEF5")
THIN = Side(style="thin", color="BFC9D6")


def _hdr(ws, row, values):
    for i, v in enumerate(values, start=2):
        c = ws.cell(row, i, v)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = HEAD
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def invoice_workbook(res: dict, settings: dict) -> bytes:
    inv = res["invoice"]
    wb = Workbook()
    ws = wb.active
    d = date.fromisoformat(inv["date"])
    ws.title = f"{d:%d%m%y} - FACT. PROJET"
    widths = {"A": 2, "B": 58, "C": 14, "D": 13, "E": 16, "F": 2, "G": 18, "H": 10, "I": 18}
    for k, v in widths.items():
        ws.column_dimensions[k].width = v

    ws["B1"] = "INVOICE"
    ws["B1"].font = Font(bold=True, size=20, color="1F3A5F")
    ws["B2"] = settings.get("issuer_name", "")
    ws["B2"].font = BOLD
    ws["D2"], ws["E2"] = "DATE :", d
    ws["E2"].number_format = "dd/mm/yyyy"
    ws["D3"], ws["E3"] = "INVOICE N° :", inv["number"]
    ws["D4"], ws["E4"] = "RÉF CLIENT :", settings.get("client_ref", "")
    ws["G3"], ws["H3"] = "DAP", inv["dap"]
    ws["G4"], ws["H4"] = "Frais Generaux", inv["frais_generaux"]
    ws["G5"], ws["H5"] = "TOTAL", inv["overhead"]
    for c in ("H3", "H4", "H5"):
        ws[c].number_format = NUM
    ws["G5"].font = ws["H5"].font = BOLD
    ws["B5"] = "INVOICED FOR"
    ws["B5"].font = BOLD
    ws["C6"] = "SENT TO :"
    addr = [settings.get("client_name", "")] + (settings.get("client_address", "") or "").split("\n")
    for i, line in enumerate(addr):
        ws.cell(6 + i + (1 if i else 0), 2, line)
        ws.cell(6 + i + (1 if i else 0), 5, line)
    ws.cell(10, 2, settings.get("client_id", ""))

    _hdr(ws, 11, ["PROJECTS", "STATUT", "DATE", "PRICE", None, "PROJET SALAIRES", "%", "DAP + OP. COST"])
    ws.row_dimensions[11].height = 28
    r = 12
    prev = None
    for l in inv["lines"]:
        if prev is not None and l["section"] != prev:
            r += 1           # ligne vide entre projets et support, comme l'original
        prev = l["section"]
        vals = [l["lot"], l["status"], l["date_label"], l["price"], None, l["salary"], l["pct"], l["overhead"]]
        for i, v in enumerate(vals, start=2):
            c = ws.cell(r, i, v)
            c.border = Border(bottom=THIN)
        for col in (5, 7, 9):
            ws.cell(r, col).number_format = NUM
        ws.cell(r, 8).number_format = PCT
        ws.cell(r, 3).alignment = ws.cell(r, 4).alignment = Alignment(horizontal="center")
        r += 1
    r += 2
    for label, key, rate in (("SUB TOTAL", "subtotal", None), ("COST +", "cost_plus", inv["cost_plus_rate"]),
                             ("TOTAL", "total", None)):
        ws.cell(r, 2, label).font = BOLD
        if rate is not None:
            ws.cell(r, 3, rate).number_format = "0%"
        for col, k in ((5, "price"), (7, "salary"), (9, "overhead")):
            c = ws.cell(r, col, inv[key][k])
            c.number_format = NUM
            c.font = BOLD
            c.fill = SUBF
        r += 1
    ws.cell(r, 2, settings.get("issuer_footer", "")).font = Font(italic=True, size=9, color="666666")
    ws.freeze_panes = "B12"
    ws.sheet_view.showGridLines = False
    ws.page_setup.fitToWidth = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True

    # --- détail lot x collaborateur (équivalent BDD - Time Sheet du mois)
    det = wb.create_sheet("Détail par lot")
    cols = ["Lot", "Section", "Statut", "Date MEL", "Collaborateur", "Heures", "Coût salarial",
            "% du coût total", "Quote-part DAP + FG", "Prix"]
    for i, h in enumerate(cols, start=1):
        c = det.cell(1, i, h)
        c.font, c.fill = Font(bold=True, color="FFFFFF"), HEAD
    tot = inv["subtotal"]["salary"] or 1
    rr = 2
    for l in inv["lines"]:
        for x in l["detail"]:
            share = x["cost"] / tot
            det.append([l["lot"], l["section"], l["status"], fr_date(l["mel_date"]) if l["status"] == "PRODUCTION" else "-",
                        x["collaborator"], x["hours"], x["cost"], share, inv["overhead"] * share,
                        x["cost"] + inv["overhead"] * share])
            rr += 1
    for row in det.iter_rows(min_row=2):
        for c in row[5:7] + row[8:10]:
            c.number_format = NUM
        row[7].number_format = PCT
    for i, w in enumerate([55, 10, 13, 12, 24, 10, 15, 12, 18, 15], start=1):
        det.column_dimensions[get_column_letter(i)].width = w
    det.auto_filter.ref = f"A1:J{max(rr - 1, 1)}"
    det.freeze_panes = "A2"

    # --- collaborateurs
    pp = wb.create_sheet("Collaborateurs")
    pp.append(["Collaborateur", "Rôle", "Mode", "Heures", "Coût employeur", "Coût / heure"])
    for c in pp[1]:
        c.font, c.fill = Font(bold=True, color="FFFFFF"), HEAD
    for p in res["people"]:
        pp.append([p["collaborator"], p["role"], p["mode"], p["hours"], p["cost"], p["cost_per_hour"]])
    for row in pp.iter_rows(min_row=2):
        for c in row[3:]:
            c.number_format = NUM
    for i, w in enumerate([26, 16, 10, 10, 16, 12], start=1):
        pp.column_dimensions[get_column_letter(i)].width = w

    # --- contrôles
    ck = wb.create_sheet("Contrôles")
    ck.append(["Niveau", "Contrôle", "Message"])
    for c in ck[1]:
        c.font, c.fill = Font(bold=True, color="FFFFFF"), HEAD
    for i in res["issues"]:
        ck.append([i["level"], i["code"], i["message"]])
    ck.column_dimensions["A"].width, ck.column_dimensions["B"].width, ck.column_dimensions["C"].width = 10, 22, 120

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
