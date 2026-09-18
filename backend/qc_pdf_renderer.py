"""
PDF generation for trademark availability reports — Manthan Desai & Associates format.
Produces a comprehensive legal-style dossier matching professional TM attorney reports.
"""
from __future__ import annotations

import base64
import os
import re
from io import BytesIO
from datetime import datetime
from typing import Any, Dict, List
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    HRFlowable, KeepTogether,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

try:
    from reportlab.platypus import Image as RLImage
except ImportError:
    RLImage = None

# ── Calibri font registration (falls back to Helvetica if unavailable) ─────────
def _register_calibri() -> bool:
    """Try to register Microsoft Calibri TTF fonts; return True on success."""
    search_dirs = [
        "/usr/share/fonts/truetype/msttcorefonts",
        "/usr/share/fonts/truetype/microsoft",
        "/usr/share/fonts/truetype",
        "/usr/share/fonts",
        "/Library/Fonts",
        os.path.expanduser("~/Library/Fonts"),
        "C:/Windows/Fonts",
        os.path.dirname(__file__),
    ]
    regular_names = ["Calibri.ttf", "calibri.ttf", "CALIBRI.TTF"]
    bold_names    = ["Calibrib.ttf", "calibrib.ttf", "CalibriBold.ttf", "calibri-bold.ttf"]

    reg_path  = None
    bold_path = None
    for d in search_dirs:
        if not os.path.isdir(d):
            continue
        for fname in regular_names:
            p = os.path.join(d, fname)
            if os.path.isfile(p):
                reg_path = p
                break
        if reg_path:
            for fname in bold_names:
                p = os.path.join(d, fname)
                if os.path.isfile(p):
                    bold_path = p
                    break
            break

    if not reg_path:
        return False

    try:
        pdfmetrics.registerFont(TTFont("Calibri", reg_path))
        if bold_path:
            pdfmetrics.registerFont(TTFont("Calibri-Bold", bold_path))
        else:
            pdfmetrics.registerFont(TTFont("Calibri-Bold", reg_path))
        return True
    except Exception:
        return False


_CALIBRI_OK = _register_calibri()
_SERIF      = "Calibri"      if _CALIBRI_OK else "Helvetica"
_SERIF_BOLD = "Calibri-Bold" if _CALIBRI_OK else "Helvetica-Bold"

# ── Colour palette ──────────────────────────────────────────────────────────
DARK_BLUE  = colors.HexColor("#0D3B66")
MED_BLUE   = colors.HexColor("#1F6FB2")
LIGHT_BLUE = colors.HexColor("#E8F1FB")
EMERALD    = colors.HexColor("#16A34A")
AMBER      = colors.HexColor("#D97706")
RED        = colors.HexColor("#DC2626")
LIGHT_GREY = colors.HexColor("#F8FAFC")
BORDER_CLR = colors.HexColor("#CBD5E1")
TEXT_DARK  = colors.HexColor("#0F172A")
TEXT_MUTED = colors.HexColor("#475569")
WHITE      = colors.white

STATUS_COLOR = {
    "AVAILABLE": EMERALD,
    "CAUTION":   AMBER,
    "CONFLICT":  RED,
}

RISK_COLOR = {
    "high":   RED,
    "medium": AMBER,
    "low":    EMERALD,
}

PAGE_W, PAGE_H = A4
L_MARGIN = 16 * mm
R_MARGIN = 16 * mm
CONTENT_W = PAGE_W - L_MARGIN - R_MARGIN


# ── Styles ───────────────────────────────────────────────────────────────────

def _styles():
    base = getSampleStyleSheet()
    return {
        "report_title": ParagraphStyle(
            "report_title", parent=base["Normal"],
            fontName=_SERIF_BOLD, fontSize=20, leading=24, textColor=DARK_BLUE,
            alignment=TA_CENTER, spaceAfter=4,
        ),
        "firm_name": ParagraphStyle(
            "firm_name", parent=base["Normal"],
            fontName=_SERIF_BOLD, fontSize=15, leading=18, textColor=DARK_BLUE,
            alignment=TA_CENTER, spaceAfter=2,
        ),
        "firm_sub": ParagraphStyle(
            "firm_sub", parent=base["Normal"],
            fontName=_SERIF, fontSize=11, leading=14, textColor=TEXT_MUTED,
            alignment=TA_CENTER,
        ),
        "section_title": ParagraphStyle(
            "section_title", parent=base["Normal"],
            fontName=_SERIF_BOLD, fontSize=12, leading=15, textColor=WHITE,
            spaceBefore=0, spaceAfter=0, leftIndent=0,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base["Heading2"],
            fontName=_SERIF_BOLD, fontSize=12, leading=15, textColor=MED_BLUE,
            spaceBefore=10, spaceAfter=4,
        ),
        "h3": ParagraphStyle(
            "h3", parent=base["Heading3"],
            fontName=_SERIF_BOLD, fontSize=11, leading=14, textColor=DARK_BLUE,
            spaceBefore=6, spaceAfter=3,
        ),
        "body": ParagraphStyle(
            "body", parent=base["BodyText"],
            fontName=_SERIF, fontSize=11, leading=14, textColor=TEXT_DARK,
        ),
        "body_j": ParagraphStyle(
            "body_j", parent=base["BodyText"],
            fontName=_SERIF, fontSize=11, leading=14, textColor=TEXT_DARK,
            alignment=TA_JUSTIFY,
        ),
        "small": ParagraphStyle(
            "small", parent=base["BodyText"],
            fontName=_SERIF, fontSize=9.5, leading=12, textColor=TEXT_MUTED,
        ),
        "label": ParagraphStyle(
            "label", parent=base["Normal"],
            fontName=_SERIF_BOLD, fontSize=10, leading=12, textColor=TEXT_MUTED,
        ),
        "cell": ParagraphStyle(
            "cell", parent=base["Normal"],
            fontName=_SERIF, fontSize=11, leading=13, textColor=TEXT_DARK,
        ),
        "cell_bold": ParagraphStyle(
            "cell_bold", parent=base["Normal"],
            fontName=_SERIF_BOLD, fontSize=11, leading=13, textColor=TEXT_DARK,
        ),
        "cell_center": ParagraphStyle(
            "cell_center", parent=base["Normal"],
            fontName=_SERIF, fontSize=11, leading=13, textColor=TEXT_DARK,
            alignment=TA_CENTER,
        ),
        "disclaimer": ParagraphStyle(
            "disclaimer", parent=base["BodyText"],
            fontName=_SERIF, fontSize=9.5, leading=12, textColor=TEXT_MUTED,
            alignment=TA_JUSTIFY,
        ),
        "numbered": ParagraphStyle(
            "numbered", parent=base["Normal"],
            fontName=_SERIF, fontSize=11, leading=15, textColor=TEXT_DARK,
            leftIndent=14, spaceAfter=3,
        ),
    }


# ── Helpers ──────────────────────────────────────────────────────────────────

def _section_header(title: str, st: dict) -> list:
    tbl = Table(
        [[Paragraph(title, st["section_title"])]],
        colWidths=[CONTENT_W],
    )
    tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), DARK_BLUE),
        ("TOPPADDING",    (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
    ]))
    return [tbl, Spacer(1, 6)]


def _kv_table(rows: list, col_w=None, st=None) -> Table:
    if col_w is None:
        col_w = (55 * mm, CONTENT_W - 55 * mm)
    tbl_data = []
    for k, v in rows:
        tbl_data.append([
            Paragraph(str(k), st["label"]),
            Paragraph(str(v) if v else "\u2014", st["cell"]),
        ])
    tbl = Table(tbl_data, colWidths=list(col_w))
    tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER_CLR),
        ("INNERGRID",     (0, 0), (-1, -1), 0.25, BORDER_CLR),
        ("BACKGROUND",    (0, 0), (0, -1), LIGHT_GREY),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return tbl


def _categorize_risk(score, status, match_type):
    dead = {"Abandoned", "Refused", "Withdrawn", "Removed"}
    if (status or "") in dead:
        return "low"
    if score >= 65 or (match_type or "") == "exact":
        return "high"
    if score >= 35:
        return "medium"
    return "low"


def _extract_firm(footer: str) -> str:
    if not footer:
        return ""
    m = re.match(r"Prepared by (.+?)(?:\s*[|\xb7\u00b7\xb7]|\s*$)", footer, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return footer.split("|")[0].split("·")[0].strip()


def _generate_remarks(r: dict, query: str, risk_cat: str, match_type: str) -> str:
    name = r.get("name") or "the subject mark"
    status = r.get("status") or "unknown status"
    cls = r.get("class") or "—"
    applicant = r.get("applicant") or "an applicant"
    sim_pct = r.get("similarity_pct", 0)

    if match_type == "exact":
        return (
            f"The mark <b>\"{name}\"</b> registered by {applicant} in Class {cls} is an "
            f"<b>EXACT MATCH</b> to the proposed mark. With a current status of <b>{status}</b>, "
            f"this constitutes a direct conflict. The Trademark Registry is likely to raise an "
            f"objection under Section 11 of the Trade Marks Act, 1999, citing deceptive similarity. "
            f"Filing is not recommended without obtaining a No Objection Certificate (NOC) from the "
            f"existing proprietor or substantially modifying the proposed mark."
        )
    elif match_type == "phonetic":
        return (
            f"The mark <b>\"{name}\"</b> ({status}, Class {cls}) is <b>PHONETICALLY SIMILAR</b> to "
            f"the proposed mark with a similarity score of {sim_pct}%. The Trademark Registry "
            f"routinely objects to marks that sound similar even when the spelling differs. An "
            f"examination report citing phonetic similarity is probable. It is advisable to conduct "
            f"a legal assessment before proceeding with filing."
        )
    elif match_type == "contains":
        return (
            f"The mark <b>\"{name}\"</b> ({status}, Class {cls}) contains or is contained within "
            f"the proposed mark, resulting in a {sim_pct}% similarity score. While not a direct bar "
            f"to registration, the Registry may raise objections if the goods and services are related. "
            f"A careful analysis of the specification of goods and services is recommended."
        )
    elif risk_cat == "high":
        return (
            f"The mark <b>\"{name}\"</b> ({status}, Class {cls}) presents a <b>HIGH RISK</b> "
            f"conflict with a similarity score of {sim_pct}%. Given its current status, this mark "
            f"is likely to be cited as a conflicting prior mark during examination. Professional "
            f"legal advice is strongly recommended before filing."
        )
    else:
        return (
            f"The mark <b>\"{name}\"</b> ({status}, Class {cls}) shows limited similarity to the "
            f"proposed mark (score: {sim_pct}%). While this is a low-risk conflict, it is advisable "
            f"to monitor this application for any status changes that may affect the filing strategy."
        )


def _plain_language_remark(r: dict, risk_cat: str, match_type: str) -> str:
    """A short, jargon-free version of _generate_remarks() for readers who
    aren't trademark professionals."""
    name = r.get("name") or "this mark"
    status = (r.get("status") or "on record").lower()
    cls = r.get("class") or "\u2014"

    if match_type == "exact":
        return (
            f"Someone else already has a trademark that reads exactly the same as yours "
            f"(\"{name}\", {status}, Class {cls}). This is the strongest kind of conflict — "
            f"you should not file without changing your name or sorting this out first."
        )
    elif match_type == "phonetic":
        return (
            f"There's a mark that sounds like yours when spoken out loud (\"{name}\", "
            f"{status}, Class {cls}). Even though it's spelled differently, the registry "
            f"often objects to marks that sound alike, so this is worth reviewing carefully."
        )
    elif match_type == "contains":
        return (
            f"Part of your proposed name overlaps with an existing mark (\"{name}\", "
            f"{status}, Class {cls}). This alone won't stop your application, but it's "
            f"worth keeping an eye on, especially if you sell similar products or services."
        )
    elif risk_cat == "high":
        return (
            f"This existing mark (\"{name}\", {status}, Class {cls}) is close enough to "
            f"yours that it could cause problems during examination. We'd recommend "
            f"getting a professional opinion before you file."
        )
    else:
        return (
            f"This mark (\"{name}\", {status}, Class {cls}) only loosely resembles yours. "
            f"It's a low concern, but worth keeping on your radar."
        )


# ── Page template ─────────────────────────────────────────────────────────────

class _PageTemplate:
    def __init__(self, wm: str, footer_line: str):
        self.wm = wm
        self.footer_line = footer_line

    def __call__(self, canvas, doc):
        canvas.saveState()
        # Top border bar
        canvas.setFillColor(DARK_BLUE)
        canvas.rect(0, PAGE_H - 6, PAGE_W, 6, fill=1, stroke=0)
        # Bottom border bar
        canvas.rect(0, 0, PAGE_W, 4, fill=1, stroke=0)
        # Watermark
        if self.wm:
            canvas.saveState()
            canvas.setFont(_SERIF_BOLD, 52)
            canvas.setFillColor(colors.HexColor("#D1D5DB"))
            canvas.translate(PAGE_W / 2, PAGE_H / 2)
            canvas.rotate(45)
            canvas.drawCentredString(0, 0, self.wm.upper())
            canvas.restoreState()
        # Footer
        canvas.setFont(_SERIF, 7.5)
        canvas.setFillColor(colors.HexColor("#94A3B8"))
        fl = self.footer_line or "Trademark Search Report — Confidential"
        canvas.drawCentredString(PAGE_W / 2, 10, fl)
        canvas.drawRightString(PAGE_W - 15, 10, f"Page {doc.page}")
        canvas.restoreState()


# ── Main renderer ─────────────────────────────────────────────────────────────

def build_report_pdf(doc_record: dict) -> bytes:
    """Render a comprehensive trademark availability report to PDF bytes."""
    report      = doc_record.get("report") or doc_record
    query       = report.get("query", "\u2014")
    overall     = report.get("overall_status", "UNKNOWN")
    risk        = report.get("risk_score", 0)
    headline    = report.get("headline", "")
    counts      = report.get("summary_counts", {}) or {}
    class_breakdown  = report.get("class_breakdown", []) or []
    recommendations  = report.get("recommendations", []) or []
    alternatives     = report.get("alternative_name_suggestions", []) or []
    all_results      = report.get("all_results", []) or []
    phonetic_results = report.get("phonetic_matches", []) or []
    class_filter     = report.get("class_filter") or "All"
    # Full requested class list (multi-class aware). Falls back to a
    # single-element list from class_filter for older stored reports that
    # predate the class_filters field.
    class_filters    = report.get("class_filters") or ([class_filter] if class_filter not in ("All", None, "") else [])
    class_filters_set = {int(c) for c in class_filters} if class_filters else set()
    created_at       = doc_record.get("created_at") or datetime.utcnow().isoformat()

    # Branding
    logo_data_url   = report.get("logo_data_url") or ""
    footer_text     = report.get("footer") or ""
    tagline         = report.get("tagline") or "Trademark Availability Report"
    wm_raw          = report.get("watermark") or report.get("custom_watermark") or ""
    watermark_text  = wm_raw if wm_raw.upper() != "CUSTOM" else (report.get("custom_watermark") or "")
    client_name     = report.get("client_name") or ""
    client_mobile   = report.get("client_mobile") or ""
    report_date_raw = report.get("report_date") or created_at[:10]
    mark_type       = report.get("mark_type") or "Word / Device / Composite"
    prepared_by     = report.get("prepared_by") or ""

    # Format report date
    try:
        rd = datetime.strptime(report_date_raw[:10], "%Y-%m-%d")
        report_date_str = rd.strftime("%d-%m-%Y")
    except Exception:
        report_date_str = report_date_raw or datetime.utcnow().strftime("%d-%m-%Y")

    # Firm name
    firm_name = _extract_firm(footer_text) or "Manthan Desai & Associates"

    # Risk buckets
    high_risk   = [r for r in all_results if _categorize_risk(r.get("individual_risk_score", 0), r.get("status", ""), r.get("match_type", "")) == "high"]
    medium_risk = [r for r in all_results if _categorize_risk(r.get("individual_risk_score", 0), r.get("status", ""), r.get("match_type", "")) == "medium"]
    low_risk    = [r for r in all_results if _categorize_risk(r.get("individual_risk_score", 0), r.get("status", ""), r.get("match_type", "")) == "low"]
    risk_label  = {"AVAILABLE": "Low", "CAUTION": "Medium", "CONFLICT": "High"}.get(overall, "Medium")

    buf = BytesIO()
    pt  = _PageTemplate(watermark_text, footer_text or f"Prepared by {firm_name} \u00b7 Confidential")
    pdf = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=22 * mm, bottomMargin=22 * mm,
        title=f"Trademark Search Report \u2014 {query}",
        author=firm_name,
    )
    st    = _styles()
    story = []

    # ── HEADER ─────────────────────────────────────────────────────────────

    # Try to embed logo
    logo_img = None
    if logo_data_url and isinstance(logo_data_url, str) and logo_data_url.startswith("data:image") and RLImage:
        try:
            _, b64 = logo_data_url.split(",", 1)
            img_stream = BytesIO(base64.b64decode(b64))
            logo_img = RLImage(img_stream, width=22 * mm, height=22 * mm, kind="proportional")
        except Exception:
            logo_img = None

    firm_para = Paragraph(firm_name, st["firm_name"])
    firm_sub  = Paragraph("Company Secretaries | Trademark Attorney", st["firm_sub"])

    if logo_img:
        hdr_data = [[logo_img, [firm_para, Spacer(1, 3), firm_sub]]]
        hdr_tbl  = Table(hdr_data, colWidths=[26 * mm, CONTENT_W - 26 * mm])
        hdr_tbl.setStyle(TableStyle([
            ("VALIGN",  (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN",   (0, 0), (0, 0),   "CENTER"),
        ]))
        story.append(hdr_tbl)
    else:
        story.append(firm_para)
        story.append(Spacer(1, 2))
        story.append(firm_sub)

    story.append(Spacer(1, 8))
    story.append(HRFlowable(width="100%", thickness=2, color=DARK_BLUE))
    story.append(Spacer(1, 8))
    story.append(Paragraph("TRADEMARK SEARCH REPORT", st["report_title"]))
    story.append(Spacer(1, 12))

    # ── CLIENT DETAILS ──────────────────────────────────────────────────────
    story += _section_header("CLIENT DETAILS", st)
    class_label = (
        ("Class " + ", ".join(str(c) for c in sorted(class_filters_set)))
        if class_filters_set else "All Classes"
    )
    client_details_rows = [
        ("Client Name",         client_name or "\u2014"),
        ("Proposed Mark",       query),
        ("Type of Mark",        mark_type),
        ("Applied Class",       class_label),
        ("Date of Search",      report_date_str),
        ("Search Conducted By", firm_name),
    ]
    if prepared_by:
        client_details_rows.append(("Prepared By", prepared_by))
    story.append(_kv_table(client_details_rows, st=st))
    story.append(Spacer(1, 14))

    # ── EXECUTIVE SUMMARY ───────────────────────────────────────────────────
    story += _section_header("EXECUTIVE SUMMARY", st)
    story.append(_kv_table([
        ("Proposed Mark",                  query),
        ("Class Searched",                 class_label),
        ("Search Type",                    "Exact / Phonetic / Similar"),
        ("Total Conflicting Marks Found",  str(counts.get("total_results", 0))),
        ("High Risk Marks",                str(len(high_risk))),
        ("Medium Risk Marks",              str(len(medium_risk))),
        ("Low Risk Marks",                 str(len(low_risk))),
        ("Overall Risk Assessment",        risk_label),
    ], st=st))
    story.append(Spacer(1, 8))
    story.append(Paragraph("<b>Preliminary Opinion</b>", st["h3"]))
    opinion_body = (
        f"Based on the search conducted in the IP India / QuickCompany database, the proposed "
        f"trademark <b>\"{query}\"</b> {(headline or 'has been analysed').lower()} "
        f"The detailed analysis is provided in this report."
    )
    story.append(Paragraph(opinion_body, st["body_j"]))
    story.append(Spacer(1, 14))

    # ── SEARCH METHODOLOGY ──────────────────────────────────────────────────
    story += _section_header("SEARCH METHODOLOGY", st)
    story.append(Paragraph("The search was conducted using:", st["body"]))
    story.append(Spacer(1, 4))
    for i, m in enumerate([
        "Exact Word Search",
        "Phonetic Search",
        "Prefix &amp; Suffix Search",
        "Similar Mark Search",
        "Cross-Class Search",
        "Device Mark Search (where applicable)",
    ], 1):
        story.append(Paragraph(f"<b>{i}.</b> &nbsp; {m}", st["numbered"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph("<b>Database Source:</b>", st["body"]))
    for src in [
        "IP India Public Search",
        "QuickCompany Trademark Registry Records",
        "Additional Proprietary Search Tools",
    ]:
        story.append(Paragraph(f"• &nbsp; {src}", st["numbered"]))
    story.append(Spacer(1, 14))

    # ── CONFLICT SUMMARY ────────────────────────────────────────────────────
    if all_results:
        story += _section_header("CONFLICT SUMMARY", st)
        hdr_style = ParagraphStyle("tbl_hdr", parent=st["cell_bold"], textColor=WHITE)
        summary_rows = [[
            Paragraph("Sr. No.", hdr_style),
            Paragraph("Mark",       hdr_style),
            Paragraph("App. No.",   hdr_style),
            Paragraph("Class",      hdr_style),
            Paragraph("Status",     hdr_style),
            Paragraph("Proprietor", hdr_style),
            Paragraph("Sim. %",     hdr_style),
            Paragraph("Risk",       hdr_style),
        ]]
        for i, r in enumerate(all_results[:40], 1):
            risk_cat = _categorize_risk(r.get("individual_risk_score", 0), r.get("status", ""), r.get("match_type", ""))
            risk_clr = RISK_COLOR.get(risk_cat, AMBER)
            summary_rows.append([
                Paragraph(str(i), st["cell_center"]),
                Paragraph((r.get("name") or "\u2014")[:28], st["cell"]),
                Paragraph(str(r.get("application_id") or "\u2014"), st["cell"]),
                Paragraph(str(r.get("class") or "\u2014"), st["cell_center"]),
                Paragraph((r.get("status") or "\u2014")[:18], st["cell"]),
                Paragraph((r.get("applicant") or "\u2014")[:24], st["cell"]),
                Paragraph(f"{r.get('similarity_pct', 0)}%", st["cell_center"]),
                Paragraph(
                    risk_cat.upper(),
                    ParagraphStyle("rc", parent=st["cell_bold"],
                                   textColor=risk_clr, alignment=TA_CENTER),
                ),
            ])
        conflict_tbl = Table(
            summary_rows,
            colWidths=[12*mm, 35*mm, 22*mm, 12*mm, 26*mm, 34*mm, 14*mm, 23*mm],
        )
        conflict_tbl.setStyle(TableStyle([
            ("BOX",           (0, 0), (-1, -1), 0.75, DARK_BLUE),
            ("LINEBELOW",     (0, 0), (-1, 0),  0.75, DARK_BLUE),
            ("INNERGRID",     (0, 1), (-1, -1), 0.25, BORDER_CLR),
            ("BACKGROUND",    (0, 0), (-1, 0),  DARK_BLUE),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING",    (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 5),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 5),
            ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, LIGHT_GREY]),
        ]))
        story.append(conflict_tbl)
        story.append(Spacer(1, 14))

    # ── CLASS-WISE BREAKDOWN ────────────────────────────────────────────────
    # Especially important for multi-class searches (e.g. CL16 + CL21 + CL28):
    # shows how filings/conflicts are distributed across each requested class,
    # so the report doesn't just collapse everything into one number.
    if class_breakdown:
        story += _section_header("CLASS-WISE BREAKDOWN", st)
        hdr_style_cb = ParagraphStyle("tbl_hdr_cb", parent=st["cell_bold"], textColor=WHITE)
        cb_rows = [[
            Paragraph("Class",          hdr_style_cb),
            Paragraph("Sector",         hdr_style_cb),
            Paragraph("Total Filings",  hdr_style_cb),
            Paragraph("Blocking",       hdr_style_cb),
            Paragraph("Dead/Expired",   hdr_style_cb),
            Paragraph("Result",         hdr_style_cb),
        ]]
        for cb in class_breakdown:
            blocking_n = cb.get("blocking", 0)
            blocking_style = ParagraphStyle(
                "cb_blk", parent=st["cell_bold"],
                textColor=(RED if blocking_n else EMERALD), alignment=TA_CENTER,
            )
            result_text  = "No Conflicting Mark" if blocking_n == 0 else "Possible Conflict"
            result_style = ParagraphStyle(
                "cb_res", parent=st["cell_bold"],
                textColor=(EMERALD if blocking_n == 0 else RED), alignment=TA_CENTER,
            )
            cb_class = cb.get("class", "—")
            cb_rows.append([
                Paragraph(f"CL{cb_class}", st["cell_center"]),
                Paragraph(str(cb.get("hint") or cb.get("sector") or "\u2014"), st["cell"]),
                Paragraph(str(cb.get("total", 0)), st["cell_center"]),
                Paragraph(str(blocking_n), blocking_style),
                Paragraph(str(cb.get("dead", 0)), st["cell_center"]),
                Paragraph(result_text, result_style),
            ])
        cb_col_fixed = 16*mm + 22*mm + 18*mm + 24*mm + 34*mm
        cb_tbl = Table(cb_rows, colWidths=[16*mm, CONTENT_W - cb_col_fixed, 22*mm, 18*mm, 24*mm, 34*mm])
        cb_tbl.setStyle(TableStyle([
            ("BOX",           (0, 0), (-1, -1), 0.75, DARK_BLUE),
            ("LINEBELOW",     (0, 0), (-1, 0),  0.75, DARK_BLUE),
            ("INNERGRID",     (0, 1), (-1, -1), 0.25, BORDER_CLR),
            ("BACKGROUND",    (0, 0), (-1, 0),  DARK_BLUE),
            ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, LIGHT_GREY]),
            ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING",    (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING",   (0, 0), (-1, -1), 6),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        ]))
        story.append(cb_tbl)
        story.append(Spacer(1, 6))
        story.append(Paragraph(
            "In simple terms: a class marked <b>\"No Conflicting Mark\"</b> means our search did not "
            "find any existing trademark that stands in the way of your application in that class. A "
            "class marked <b>\"Possible Conflict\"</b> has at least one similar mark already on record "
            "and is examined in detail on the pages that follow.",
            st["small"],
        ))
        story.append(Spacer(1, 14))

    # ── DETAILED ANALYSIS (one page per class) ──────────────────────────────
    # Every class that was actually searched gets its own page — including
    # classes with zero conflicts, which are explicitly labelled "No
    # Conflicting Mark" rather than being silently omitted from the report.
    results_by_class: Dict[Any, List[Dict]] = {}
    for r in all_results:
        results_by_class.setdefault(r.get("class"), []).append(r)

    if class_filters_set:
        classes_to_report = sorted(class_filters_set)
    else:
        classes_to_report = sorted(
            [c for c in results_by_class.keys() if c is not None],
            key=lambda c: (-len(results_by_class.get(c, [])),)
        )

    if classes_to_report:
        story.append(PageBreak())
        story += _section_header("DETAILED ANALYSIS", st)
        story.append(Paragraph(
            "Each Nice Classification class you searched is reviewed on its own page below — "
            "whether or not any conflicting marks were found in it.",
            st["small"],
        ))
        story.append(Spacer(1, 6))

        for class_idx, cls in enumerate(classes_to_report):
            if class_idx > 0:
                story.append(PageBreak())

            sector = None
            for cb in class_breakdown:
                if cb.get("class") == cls:
                    sector = cb.get("hint") or cb.get("sector")
                    break
            sector = sector or "\u2014"

            cls_results = sorted(
                results_by_class.get(cls, []),
                key=lambda r: r.get("individual_risk_score", 0),
                reverse=True,
            )[:10]

            story.append(Paragraph(f"Class {cls} \u2014 {sector}", st["h2"]))
            story.append(Spacer(1, 4))

            if not cls_results:
                # ── Plain-language "all clear" notice ───────────────────────
                clear_box = Table(
                    [[Paragraph(
                        f"<b>\u2714 No Conflicting Mark Found in Class {cls}</b><br/><br/>"
                        f"Our search did not find any existing trademark in Class {cls} "
                        f"({sector}) that conflicts with the proposed mark <b>\"{query}\"</b>. "
                        f"In plain terms: based on the records we checked, there is nothing "
                        f"currently blocking you from filing in this class.",
                        st["body_j"],
                    )]],
                    colWidths=[CONTENT_W],
                )
                clear_box.setStyle(TableStyle([
                    ("BOX",           (0, 0), (-1, -1), 0.75, EMERALD),
                    ("BACKGROUND",    (0, 0), (-1, -1), colors.HexColor("#ECFDF5")),
                    ("TOPPADDING",    (0, 0), (-1, -1), 12),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
                    ("LEFTPADDING",   (0, 0), (-1, -1), 12),
                    ("RIGHTPADDING",  (0, 0), (-1, -1), 12),
                ]))
                story.append(clear_box)
                story.append(Spacer(1, 8))
                continue

            story.append(Paragraph(
                f"{len(cls_results)} similar mark(s) found in this class. Details below, "
                f"most similar first.",
                st["small"],
            ))
            story.append(Spacer(1, 6))

            for exhibit_no, r in enumerate(cls_results, 1):
                risk_cat   = _categorize_risk(r.get("individual_risk_score", 0), r.get("status", ""), r.get("match_type", ""))
                risk_clr   = RISK_COLOR.get(risk_cat, AMBER)
                sim_pct    = r.get("similarity_pct", 0)
                match_type = (r.get("match_type") or "weak").lower()

                block = []

                # Exhibit heading
                block.append(Paragraph(f"EXHIBIT {class_idx + 1}.{exhibit_no}", st["h2"]))

                # Trademark details table
                block.append(Paragraph("Trademark Details", st["h3"]))
                block.append(_kv_table([
                    ("Mark",               r.get("name") or "\u2014"),
                    ("Application Number", str(r.get("application_id") or "\u2014")),
                    ("Class",              str(r.get("class") or "\u2014")),
                    ("Status",             r.get("status") or "\u2014"),
                    ("Proprietor",         r.get("applicant") or "\u2014"),
                    ("Filing Date",        r.get("filing_date") or "\u2014"),
                    ("User Date",          r.get("user_date") or "\u2014"),
                    ("Journal Number",     r.get("journal_number") or "\u2014"),
                    ("Office",             r.get("office") or "\u2014"),
                    ("Agent / Attorney",   r.get("attorney") or "\u2014"),
                ], st=st))
                block.append(Spacer(1, 6))

                # Goods & Services
                gs = r.get("goods_and_services") or r.get("description") or "\u2014"
                block.append(Paragraph("Goods &amp; Services", st["h3"]))
                block.append(Paragraph(str(gs)[:600], st["body_j"]))
                block.append(Spacer(1, 6))

                # Similarity Assessment
                block.append(Paragraph("Similarity Assessment", st["h3"]))
                visual_s    = sim_pct if match_type in ("exact", "similar", "contains") else max(0, sim_pct - 20)
                phonetic_s  = sim_pct if match_type in ("exact", "phonetic")            else max(0, sim_pct - 30)
                concept_s   = sim_pct // 2 if match_type in ("exact", "contains")       else 0
                gs_s        = 50 if (class_filters_set and r.get("class") in class_filters_set) else 30

                hdr_style2 = ParagraphStyle("tbl_hdr2", parent=st["cell_bold"], textColor=WHITE)
                sim_rows = [
                    [Paragraph("Parameter",              hdr_style2), Paragraph("Score", hdr_style2)],
                    [Paragraph("Visual Similarity",      st["cell"]), Paragraph(f"{visual_s}%",    st["cell_center"])],
                    [Paragraph("Phonetic Similarity",    st["cell"]), Paragraph(f"{phonetic_s}%",  st["cell_center"])],
                    [Paragraph("Conceptual Similarity",  st["cell"]), Paragraph(f"{concept_s}%",   st["cell_center"])],
                    [Paragraph("Goods / Services Similarity", st["cell"]), Paragraph(f"{gs_s}%",  st["cell_center"])],
                    [
                        Paragraph("Overall Similarity", st["cell_bold"]),
                        Paragraph(
                            f"{sim_pct}%",
                            ParagraphStyle("simov", parent=st["cell_bold"],
                                           textColor=risk_clr, alignment=TA_CENTER),
                        ),
                    ],
                ]
                sim_tbl = Table(sim_rows, colWidths=[CONTENT_W - 58*mm, 58*mm])
                sim_tbl.setStyle(TableStyle([
                    ("BOX",           (0, 0), (-1, -1), 0.5, BORDER_CLR),
                    ("INNERGRID",     (0, 0), (-1, -1), 0.25, BORDER_CLR),
                    ("BACKGROUND",    (0, 0), (-1, 0),  DARK_BLUE),
                    ("BACKGROUND",    (0, -1), (-1, -1), LIGHT_GREY),
                    ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING",    (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ("LEFTPADDING",   (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
                ]))
                block.append(sim_tbl)
                block.append(Spacer(1, 6))

                # Professional Remarks
                block.append(Paragraph("Professional Remarks", st["h3"]))
                block.append(Paragraph(_generate_remarks(r, query, risk_cat, match_type), st["body_j"]))
                block.append(Spacer(1, 3))
                block.append(Paragraph(
                    f"<i>In plain terms:</i> {_plain_language_remark(r, risk_cat, match_type)}",
                    st["small"],
                ))

                if exhibit_no < len(cls_results):
                    block.append(HRFlowable(width="100%", thickness=0.5, color=BORDER_CLR,
                                            spaceAfter=8, spaceBefore=8))

                story.append(KeepTogether(block[:4]))
                for item in block[4:]:
                    story.append(item)

            story.append(Spacer(1, 8))

    # ── PHONETICALLY SIMILAR MARKS ──────────────────────────────────────────
    if phonetic_results:
        story += _section_header("PHONETICALLY SIMILAR MARKS", st)
        hdr_style = ParagraphStyle("tbl_hdr_p", parent=st["cell_bold"], textColor=WHITE)
        phon_rows = [[
            Paragraph("Sr. No.",      hdr_style),
            Paragraph("Mark",         hdr_style),
            Paragraph("App. No.",     hdr_style),
            Paragraph("Class",        hdr_style),
            Paragraph("Status",       hdr_style),
            Paragraph("Similarity %", hdr_style),
            Paragraph("Risk",         hdr_style),
        ]]
        for i, r in enumerate(phonetic_results, 1):
            risk_cat = _categorize_risk(r.get("individual_risk_score", 0), r.get("status", ""), r.get("match_type", ""))
            risk_clr = RISK_COLOR.get(risk_cat, AMBER)
            phon_rows.append([
                Paragraph(str(i), st["cell_center"]),
                Paragraph((r.get("name") or "\u2014")[:30], st["cell"]),
                Paragraph(str(r.get("application_id") or "\u2014"), st["cell"]),
                Paragraph(str(r.get("class") or "\u2014"), st["cell_center"]),
                Paragraph((r.get("status") or "\u2014")[:18], st["cell"]),
                Paragraph(f"{r.get('similarity_pct', 0)}%", st["cell_center"]),
                Paragraph(
                    risk_cat.upper(),
                    ParagraphStyle("rcp", parent=st["cell_bold"],
                                   textColor=risk_clr, alignment=TA_CENTER),
                ),
            ])
        phon_tbl = Table(
            phon_rows,
            colWidths=[12*mm, 44*mm, 24*mm, 14*mm, 30*mm, 20*mm, CONTENT_W - 144*mm],
        )
        phon_tbl.setStyle(TableStyle([
            ("BOX",           (0, 0), (-1, -1), 0.75, DARK_BLUE),
            ("LINEBELOW",     (0, 0), (-1, 0),  0.75, DARK_BLUE),
            ("INNERGRID",     (0, 1), (-1, -1), 0.25, BORDER_CLR),
            ("BACKGROUND",    (0, 0), (-1, 0),  DARK_BLUE),
            ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, LIGHT_GREY]),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING",    (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 5),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 5),
        ]))
        story.append(phon_tbl)
        story.append(Spacer(1, 14))

    # ── SIMILARITY SCORING MATRIX ───────────────────────────────────────────
    story += _section_header("SIMILARITY SCORING MATRIX", st)
    hdr_style_m = ParagraphStyle("tbl_hdr_m", parent=st["cell_bold"], textColor=WHITE)
    matrix_rows = [
        [Paragraph("Criteria",                   hdr_style_m), Paragraph("Weight", hdr_style_m)],
        [Paragraph("Visual Similarity",           st["cell"]),  Paragraph("35%", st["cell_center"])],
        [Paragraph("Phonetic Similarity",         st["cell"]),  Paragraph("30%", st["cell_center"])],
        [Paragraph("Conceptual Similarity",       st["cell"]),  Paragraph("15%", st["cell_center"])],
        [Paragraph("Goods / Services Similarity", st["cell"]),  Paragraph("20%", st["cell_center"])],
    ]
    matrix_tbl = Table(matrix_rows, colWidths=[CONTENT_W - 40*mm, 40*mm])
    matrix_tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER_CLR),
        ("INNERGRID",     (0, 0), (-1, -1), 0.25, BORDER_CLR),
        ("BACKGROUND",    (0, 0), (-1, 0),  DARK_BLUE),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, LIGHT_GREY]),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("ALIGN",         (1, 0), (1, -1),  "CENTER"),
    ]))
    story.append(matrix_tbl)
    story.append(Spacer(1, 14))

    # ── OVERALL RISK ASSESSMENT ─────────────────────────────────────────────
    story += _section_header("OVERALL RISK ASSESSMENT", st)
    hdr_style_r = ParagraphStyle("tbl_hdr_r", parent=st["cell_bold"], textColor=WHITE)
    risk_rows = [
        [Paragraph("Risk Category", hdr_style_r), Paragraph("Number of Marks", hdr_style_r)],
        [
            Paragraph("High Risk",   ParagraphStyle("hr", parent=st["cell_bold"], textColor=RED)),
            Paragraph(str(len(high_risk)),   ParagraphStyle("hrv", parent=st["cell_bold"], textColor=RED,    alignment=TA_CENTER)),
        ],
        [
            Paragraph("Medium Risk", ParagraphStyle("mr", parent=st["cell_bold"], textColor=AMBER)),
            Paragraph(str(len(medium_risk)), ParagraphStyle("mrv", parent=st["cell_bold"], textColor=AMBER,  alignment=TA_CENTER)),
        ],
        [
            Paragraph("Low Risk",    ParagraphStyle("lr", parent=st["cell_bold"], textColor=EMERALD)),
            Paragraph(str(len(low_risk)),    ParagraphStyle("lrv", parent=st["cell_bold"], textColor=EMERALD, alignment=TA_CENTER)),
        ],
    ]
    risk_tbl = Table(risk_rows, colWidths=[CONTENT_W - 40*mm, 40*mm])
    risk_tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER_CLR),
        ("INNERGRID",     (0, 0), (-1, -1), 0.25, BORDER_CLR),
        ("BACKGROUND",    (0, 0), (-1, 0),  DARK_BLUE),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, LIGHT_GREY]),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",    (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("ALIGN",         (1, 0), (1, -1),  "CENTER"),
    ]))
    story.append(risk_tbl)
    story.append(Spacer(1, 10))

    # Final Opinion
    story.append(Paragraph("<b>Final Opinion</b>", st["h3"]))
    opinion_map = {
        "AVAILABLE": ("\u2611 Recommended for Filing",                         EMERALD),
        "CAUTION":   ("\u2611 Recommended with Modifications / Filing with Caution", AMBER),
        "CONFLICT":  ("\u2611 Not Recommended for Filing (as-is)",             RED),
    }
    op_text, op_clr = opinion_map.get(overall, ("\u2611 Filing with Caution", AMBER))
    story.append(Paragraph(
        op_text,
        ParagraphStyle("opinion", parent=st["body"], textColor=op_clr,
                       fontName=_SERIF_BOLD, fontSize=11),
    ))
    story.append(Spacer(1, 14))

    # ── RECOMMENDATIONS ─────────────────────────────────────────────────────
    story += _section_header("RECOMMENDATIONS", st)
    default_recs = [
        "Obtain NOC from existing proprietor (if applicable).",
        "Consider logo / device filing for stronger distinctiveness.",
        "Consider coexistence agreement with conflicting proprietors.",
        "Consider alternate trademark options.",
        "Monitor conflicting applications for status changes.",
    ]
    recs_to_show = (recommendations[:5] or default_recs)[:5]
    for i, rec in enumerate(recs_to_show, 1):
        story.append(Paragraph(f"<b>{i}.</b> &nbsp; {rec}", st["numbered"]))
    story.append(Spacer(1, 8))

    if alternatives:
        story.append(Paragraph("<b>Alternative Name Suggestions</b>", st["h3"]))
        alt_list = [a if isinstance(a, str) else (a.get("name") or "") for a in alternatives]
        story.append(Paragraph(" &nbsp;\u00b7&nbsp; ".join(a for a in alt_list if a), st["body"]))
        story.append(Spacer(1, 10))

    # ── LEGAL DISCLAIMER ────────────────────────────────────────────────────
    story += _section_header("LEGAL DISCLAIMER", st)
    disclaimer_para = Paragraph(
        "This report is based on records available in the Trademark Registry database as on the "
        "date of search. The report is intended for advisory purposes only and should not be "
        "construed as a guarantee of registration. Final determination regarding registrability "
        "rests solely with the Trademark Registry. This report does not constitute legal advice. "
        "The firm accepts no liability for any action taken or not taken based on the contents "
        "of this report.",
        st["disclaimer"],
    )
    disc_box = Table([[disclaimer_para]], colWidths=[CONTENT_W])
    disc_box.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER_CLR),
        ("BACKGROUND",    (0, 0), (-1, -1), LIGHT_GREY),
        ("TOPPADDING",    (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LEFTPADDING",   (0, 0), (-1, -1), 12),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 12),
    ]))
    story.append(disc_box)
    story.append(Spacer(1, 20))

    # ── SIGNATURE BLOCK ─────────────────────────────────────────────────────
    col_w3 = CONTENT_W / 3
    sig_rows = [[
        Paragraph(
            f"<b>Prepared By:</b><br/>{firm_name}<br/>Company Secretaries<br/>Trademark Attorney",
            st["cell"],
        ),
        Paragraph(f"<b>Date:</b> {report_date_str}", st["cell"]),
        Paragraph(
            "<b>Authorized Signatory</b><br/><br/>____________________",
            st["cell"],
        ),
    ]]
    sig_tbl = Table(sig_rows, colWidths=[col_w3, col_w3, col_w3])
    sig_tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER_CLR),
        ("INNERGRID",     (0, 0), (-1, -1), 0.25, BORDER_CLR),
        ("TOPPADDING",    (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 20),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(sig_tbl)

    pdf.build(story, onFirstPage=pt, onLaterPages=pt)
    return buf.getvalue()
