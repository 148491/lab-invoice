"""Documents d'une facture validée : liste des projets (Excel), facture (PDF) et brouillon de mail (.eml).

Le brouillon .eml porte l'en-tête « X-Unsent: 1 » : Outlook l'ouvre comme un nouveau message, prêt à
envoyer depuis la boîte de l'utilisateur, pièces jointes comprises. Aucun serveur de mail n'est utilisé.
"""
from __future__ import annotations

import io
import re
from datetime import date
from email.message import EmailMessage
from email.utils import formatdate, getaddresses

from fpdf import FPDF
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

SECTIONS = [("projet", "Projets & évolutions"), ("support", "Support & bug fixes")]
STATUS = {"PRODUCTION": "En ligne", "IN PROGRESS": "En cours", "ABANDONED": "Abandonné"}
MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
             "novembre", "décembre"]

DEFAULT_SUBJECT = "Facture n° {numero} – refacturation {mois}"
DEFAULT_BODY = """Bonjour,

Veuillez trouver ci-joint la facture n° {numero} du {date}, relative à la refacturation des prestations du mois de {mois}, pour un montant total de {total}.

Le détail des coûts par projet, avec la séparation entre projets et support / run, figure dans le fichier Excel joint.

Je reste à votre disposition pour toute question.

Bien cordialement,
{emetteur}"""


def month_label(month: str) -> str:
    y, m = month.split("-")
    return f"{MONTHS_FR[int(m) - 1]} {y}"


def money(v: float, currency: str = "") -> str:
    s = f"{v:,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} {currency}".strip()


def fr_date(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d:%d/%m/%Y}"


def file_base(res: dict) -> str:
    return f"Facture-{res['invoice']['number']}-{res['month']}"


def placeholders(res: dict, settings: dict) -> dict:
    inv = res["invoice"]
    return {"numero": inv["number"], "date": fr_date(inv["date"]), "mois": month_label(res["month"]),
            "total": money(inv["total"]["price"], settings.get("currency", "")),
            "client": settings.get("client_name", ""), "emetteur": settings.get("issuer_name", "")}


def render(template: str, values: dict) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: str(values.get(m.group(1), m.group(0))), template or "")


def _sections(inv: dict):
    for key, label in SECTIONS:
        lines = [l for l in inv["lines"] if l["section"] == key]
        if lines:
            yield label, lines


# ----------------------------------------------------------------------------- Excel des projets
def projects_workbook(res: dict, settings: dict) -> bytes:
    """Liste des lots telle qu'elle apparaît dans la facture, par section, avec sous-totaux."""
    inv, cur = res["invoice"], settings.get("currency", "")
    wb = Workbook()
    ws = wb.active
    ws.title = f"Projets {res['month']}"
    head = PatternFill("solid", fgColor="1F2433")
    sec = PatternFill("solid", fgColor="E9E8FC")
    tot = PatternFill("solid", fgColor="F1F2F6")
    num = '#,##0.00'
    ws["A1"] = f"Facture n° {inv['number']} du {fr_date(inv['date'])} – {month_label(res['month'])}"
    ws["A1"].font = Font(bold=True, size=13)
    ws["A2"] = f"{settings.get('issuer_name', '')} → {settings.get('client_name', '')}".strip(" →")
    ws["A2"].font = Font(color="666666")
    r = 4
    for j, h in enumerate(["Projet", "Section", "Statut", "Mise en ligne", f"Montant ({cur})" if cur else "Montant"], 1):
        c = ws.cell(r, j, h)
        c.font, c.fill = Font(bold=True, color="FFFFFF"), head
        c.alignment = Alignment(horizontal="right" if j == 5 else "left")
    for label, lines in _sections(inv):
        r += 1
        ws.cell(r, 1, f"{label} · {len(lines)} lots").font = Font(bold=True, color="3730A3")
        for j in range(1, 6):
            ws.cell(r, j).fill = sec
        for l in lines:
            r += 1
            ws.cell(r, 1, l["lot"])
            ws.cell(r, 2, label)
            ws.cell(r, 3, STATUS.get(l["status"], l["status"]))
            if l["status"] == "PRODUCTION" and l.get("mel_date"):
                c = ws.cell(r, 4, date.fromisoformat(l["mel_date"]))
                c.number_format = "dd/mm/yyyy"
            ws.cell(r, 5, round(l["price"], 2)).number_format = num
        r += 1
        ws.cell(r, 1, f"Total {label.lower()}").font = Font(bold=True)
        c = ws.cell(r, 5, round(sum(l["price"] for l in lines), 2))
        c.number_format, c.font = num, Font(bold=True)
        for j in range(1, 6):
            ws.cell(r, j).fill = tot
    r += 1
    for label, v, big in (("Sous-total", inv["subtotal"]["price"], False),
                          (f"Cost + {round(inv['cost_plus_rate'] * 100)} %", inv["cost_plus"]["price"], False),
                          ("Total facture", inv["total"]["price"], True)):
        r += 1
        ws.cell(r, 1, label).font = Font(bold=True, size=12 if big else 11)
        c = ws.cell(r, 5, round(v, 2))
        c.number_format, c.font = num, Font(bold=True, size=12 if big else 11)
    for j, w in enumerate([62, 24, 12, 14, 18], 1):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = "A5"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ----------------------------------------------------------------------------- PDF de la facture
_TR = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", " ": " ",
                     " ": " ", "→": "->", "€": "EUR", "₪": "ILS"})


def _t(s) -> str:
    """Les polices PDF standard couvrent le latin-1 (accents français compris)."""
    return str(s or "").translate(_TR).encode("latin-1", "replace").decode("latin-1")


class _Doc(FPDF):
    def footer(self):
        if self.footer_text:
            self.set_y(-10)
            self.set_font("Helvetica", "", 7)
            self.set_text_color(130, 136, 155)
            self.cell(0, 4, _t(self.footer_text), align="C")


def invoice_pdf(res: dict, settings: dict) -> bytes:
    """Facture client (vue client), sur une page A4 quand le nombre de lignes le permet."""
    inv, cur = res["invoice"], settings.get("currency", "")
    pdf = _Doc(format="A4", unit="mm")
    pdf.footer_text = settings.get("issuer_footer", "")
    pdf.set_auto_page_break(False)
    pdf.set_margins(12, 12, 12)
    pdf.add_page()
    W = pdf.w - 24
    ink, faint, brand = (20, 26, 43), (124, 133, 159), (75, 69, 214)

    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(*brand)
    pdf.cell(W / 2, 10, "INVOICE")
    meta = [("DATE", fr_date(inv["date"])), ("INVOICE N°", inv["number"]), ("RÉF. CLIENT", settings.get("client_ref", ""))]
    y0 = pdf.get_y()
    for i, (k, v) in enumerate(meta):
        pdf.set_xy(12 + W - 62, y0 + i * 5)
        pdf.set_font("Helvetica", "", 7.5)
        pdf.set_text_color(*faint)
        pdf.cell(26, 5, _t(k))
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*ink)
        pdf.cell(36, 5, _t(v), align="R")
    pdf.set_xy(12, y0 + 10)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(W / 2, 5, _t(settings.get("issuer_name", "")))

    y = y0 + 18
    addr = _t(settings.get("client_address", "")).split("\n")
    for col, (lbl, extra) in enumerate((("INVOICED FOR", settings.get("client_id", "")), ("SENT TO", ""))):
        x = 12 + col * 62
        pdf.set_xy(x, y)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(*faint)
        pdf.cell(60, 4, lbl)
        pdf.set_xy(x, y + 4.5)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*ink)
        pdf.cell(60, 4.3, _t(settings.get("client_name", "")))
        pdf.set_font("Helvetica", "", 8.5)
        for i, a in enumerate(addr + ([_t(extra)] if extra else [])):
            pdf.set_xy(x, y + 8.8 + i * 4.1)
            if extra and i == len(addr):
                pdf.set_text_color(*faint)
            pdf.cell(60, 4.1, a)
        pdf.set_text_color(*ink)
    y += 9 + 4.1 * (len(addr) + 1) + 2

    # tableau : hauteur de ligne ajustée pour tenir sur une page (lisibilité minimale : lignes de 3 mm)
    blocks = list(_sections(inv))
    n_rows = sum(len(ls) + 1 for _, ls in blocks) + 3
    bottom = pdf.h - 14
    rh = max(3.0, min(5.2, (bottom - y - 6 - 2.5) / n_rows))
    fs = max(6.0, min(8.5, rh * 1.9))
    cols = [W - 72, 22, 24, 26]

    def header(yh):
        pdf.set_fill_color(*ink)
        pdf.set_text_color(255, 255, 255)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_xy(12, yh)
        for txt, w, al in zip(("PROJECTS", "STATUT", "DATE", "PRICE"), cols, ("L", "L", "L", "R")):
            pdf.cell(w, 6, f" {txt} " if al == "L" else f"{txt}  ", fill=True, align=al)
        return yh + 6

    y = header(y)

    def need(h):
        nonlocal y
        if y + h > bottom:
            pdf.add_page()
            y = header(12)

    for label, lines in blocks:
        need(rh)
        pdf.set_fill_color(233, 232, 252)
        pdf.set_text_color(55, 48, 163)
        pdf.set_font("Helvetica", "B", fs - 0.6)
        pdf.set_xy(12, y)
        pdf.cell(W, rh, _t(f" {label.upper()} · {len(lines)} LOTS"), fill=True)
        y += rh
        for l in lines:
            need(rh)
            pdf.set_xy(12, y)
            pdf.set_font("Helvetica", "", fs)
            pdf.set_text_color(*ink)
            lot = _t(l["lot"])
            if pdf.get_string_width(" " + lot) > cols[0] - 2:
                while len(lot) > 4 and pdf.get_string_width(" " + lot + "...") > cols[0] - 2:
                    lot = lot[:-1]
                lot = lot.rstrip() + "..."
            pdf.cell(cols[0], rh, " " + lot)
            live = l["status"] == "PRODUCTION"
            pdf.set_text_color(*((15, 138, 95) if live else (37, 99, 168)))
            pdf.set_font("Helvetica", "B", fs - 1)
            pdf.cell(cols[1], rh, _t(STATUS.get(l["status"], l["status"])))
            pdf.set_text_color(*ink)
            pdf.set_font("Helvetica", "", fs)
            pdf.cell(cols[2], rh, fr_date(l["mel_date"]) if live and l.get("mel_date") else "-")
            pdf.set_font("Helvetica", "B", fs)
            pdf.cell(cols[3], rh, money(l["price"]) + " ", align="R")
            y += rh
            pdf.set_draw_color(228, 231, 240)
            pdf.line(12, y, 12 + W, y)
    for label, v, big in (("Sub total", inv["subtotal"]["price"], False),
                          (f"Cost + {round(inv['cost_plus_rate'] * 100)} %", inv["cost_plus"]["price"], False),
                          ("Total", inv["total"]["price"], True)):
        h = rh + (1.5 if big else 0.4)
        need(h)
        pdf.set_xy(12, y)
        pdf.set_fill_color(*((233, 232, 252) if big else (241, 242, 246)))
        pdf.set_text_color(*(brand if big else ink))
        pdf.set_font("Helvetica", "B", fs + (2.5 if big else 0))
        pdf.cell(W - cols[3], h, " " + label, fill=True)
        pdf.cell(cols[3], h, money(v, cur if big else "") + " ", fill=True, align="R")
        y += h
    return bytes(pdf.output())


# ----------------------------------------------------------------------------- brouillon de mail
_ADDR = re.compile(r"^[^@\s<>,;\"']+@[^@\s<>,;\"']+\.[a-zA-Z]{2,}$")


def parse_addresses(raw: str) -> list[str]:
    """Adresses séparées par des virgules ou des points-virgules ; lève ValueError si l'une est invalide."""
    out = []
    for name, addr in getaddresses([(raw or "").replace(";", ",")]):
        if not addr:
            continue
        if not _ADDR.match(addr):
            raise ValueError(f"Adresse invalide : {addr}")
        if addr.lower() not in (a.lower() for a in out):
            out.append(addr)
    return out


def mail_eml(to: list[str], cc: list[str], subject: str, body: str, attachments: list[tuple[str, bytes, str]]) -> bytes:
    msg = EmailMessage()
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject.replace("\r", " ").replace("\n", " ")
    msg["Date"] = formatdate(localtime=True)
    msg["X-Unsent"] = "1"           # Outlook : ouvrir comme brouillon à envoyer
    msg.set_content(body)
    for name, data, mime in attachments:
        maintype, subtype = mime.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return msg.as_bytes()
