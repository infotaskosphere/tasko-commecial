"""
pdf_renderer.py — v4 (Bulk Parity + Enhanced Analytics)
========================================================
Key changes:
  1. Shared renderTrademarkDossier() renders ONE mark's full dossier (pages 1-N)
     and is reused by both build_report_pdf() and build_combined_report_pdf().
  2. Bulk PDF = Executive Summary page + full dossier per mark.
  3. Portfolio analytics: average risk, high-risk marks, filing badges.
  4. Registration probability % appended to each dossier verdict block.
  5. Filing Recommendation badge (Safe / Caution / High Risk / Avoid).
  6. Branding validation guard before PDF build.
  7. Alternative name availability scores.
"""
from __future__ import annotations

import base64
from io import BytesIO
from datetime import datetime
from typing import List, Optional

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
        PageBreak, HRFlowable, KeepTogether,
    )
    from reportlab.platypus import Image as RLImage
    REPORTLAB_AVAILABLE = True
except ImportError:
    REPORTLAB_AVAILABLE = False
    class _MockColors:
        def HexColor(self, h): return h
        white = "#ffffff"
    colors = _MockColors()
    A4 = (595.27, 841.89)
    mm = 1
    ParagraphStyle = object
    TA_LEFT = TA_CENTER = TA_RIGHT = 0
    SimpleDocTemplate = Paragraph = Spacer = Table = TableStyle = PageBreak = HRFlowable = KeepTogether = RLImage = object

# ── Brand palette ─────────────────────────────────────────────────────────────
NAVY       = colors.HexColor("#1B2A4A")
BLUE       = colors.HexColor("#1F6FB2")
LIGHT_BLUE = colors.HexColor("#EBF4FB")
BORDER     = colors.HexColor("#D0DCE8")
TEXT       = colors.HexColor("#1A1A2E")
MUTED      = colors.HexColor("#5A6A7A")
SUBTLE     = colors.HexColor("#F5F7FA")
WHITE      = colors.white
EMERALD    = colors.HexColor("#166534")
EMERALD_BG = colors.HexColor("#DCFCE7")
AMBER      = colors.HexColor("#92400E")
AMBER_BG   = colors.HexColor("#FEF3C7")
RED        = colors.HexColor("#7F1D1D")
RED_BG     = colors.HexColor("#FEE2E2")

VERDICT_PALETTE = {
    "AVAILABLE": {
        "fg": EMERALD, "bg": EMERALD_BG,
        "bar": colors.HexColor("#22C55E"),
        "border": colors.HexColor("#86EFAC"),
        "label": "AVAILABLE",
    },
    "CAUTION": {
        "fg": AMBER, "bg": AMBER_BG,
        "bar": colors.HexColor("#F59E0B"),
        "border": colors.HexColor("#FCD34D"),
        "label": "CAUTION",
    },
    "CONFLICT": {
        "fg": RED, "bg": RED_BG,
        "bar": colors.HexColor("#EF4444"),
        "border": colors.HexColor("#FCA5A5"),
        "label": "CONFLICT",
    },
}

# Filing Recommendation badges
FILING_BADGE = {
    "AVAILABLE": ("Safe to File",    colors.HexColor("#166534"), colors.HexColor("#DCFCE7")),
    "CAUTION":   ("Review First",    AMBER,                      AMBER_BG),
    "CONFLICT":  ("High Risk",       RED,                        RED_BG),
}

PAGE_W, PAGE_H = A4
L_MARGIN = R_MARGIN = 16 * mm
CONTENT_W = PAGE_W - L_MARGIN - R_MARGIN


# ── Styles ────────────────────────────────────────────────────────────────────
def _S():
    return {
        "eyebrow": ParagraphStyle(
            "eyebrow", fontName="Helvetica-Bold", fontSize=7.5,
            textColor=MUTED, leading=10, spaceBefore=14, spaceAfter=4, letterSpacing=1.2,
        ),
        "h1": ParagraphStyle(
            "h1", fontName="Helvetica-Bold", fontSize=26,
            textColor=TEXT, leading=30, spaceAfter=4,
        ),
        "h2": ParagraphStyle(
            "h2", fontName="Helvetica-Bold", fontSize=13,
            textColor=NAVY, leading=17, spaceBefore=14, spaceAfter=5,
        ),
        "subtitle": ParagraphStyle(
            "subtitle", fontName="Helvetica", fontSize=10,
            textColor=MUTED, leading=14, spaceAfter=10,
        ),
        "body": ParagraphStyle(
            "body", fontName="Helvetica", fontSize=9.5,
            textColor=TEXT, leading=14, spaceAfter=3,
        ),
        "body_bold": ParagraphStyle(
            "body_bold", fontName="Helvetica-Bold", fontSize=9.5,
            textColor=TEXT, leading=14,
        ),
        "small": ParagraphStyle(
            "small", fontName="Helvetica", fontSize=8,
            textColor=MUTED, leading=11,
        ),
        "small_bold": ParagraphStyle(
            "small_bold", fontName="Helvetica-Bold", fontSize=8,
            textColor=MUTED, leading=11,
        ),
        "verdict_label": ParagraphStyle(
            "verdict_label", fontName="Helvetica-Bold", fontSize=22, leading=26,
        ),
        "verdict_sub": ParagraphStyle(
            "verdict_sub", fontName="Helvetica", fontSize=9, textColor=MUTED, leading=13,
        ),
        "risk_num": ParagraphStyle(
            "risk_num", fontName="Helvetica-Bold", fontSize=32,
            textColor=NAVY, leading=36, alignment=TA_CENTER,
        ),
        "risk_label": ParagraphStyle(
            "risk_label", fontName="Helvetica", fontSize=8,
            textColor=MUTED, leading=11, alignment=TA_CENTER,
        ),
        "rec_num": ParagraphStyle(
            "rec_num", fontName="Helvetica-Bold", fontSize=10,
            textColor=BLUE, leading=14,
        ),
        "rec_text": ParagraphStyle(
            "rec_text", fontName="Helvetica", fontSize=9.5,
            textColor=TEXT, leading=14,
        ),
        "footer": ParagraphStyle(
            "footer", fontName="Helvetica", fontSize=7.5,
            textColor=MUTED, leading=11, alignment=TA_CENTER,
        ),
        "tbl_hdr": ParagraphStyle(
            "tbl_hdr", fontName="Helvetica-Bold", fontSize=7.5,
            textColor=WHITE, leading=10,
        ),
        "tbl_cell": ParagraphStyle(
            "tbl_cell", fontName="Helvetica", fontSize=8,
            textColor=TEXT, leading=11,
        ),
        "tbl_cell_mono": ParagraphStyle(
            "tbl_cell_mono", fontName="Courier", fontSize=7.5,
            textColor=MUTED, leading=11,
        ),
    }


# ── Helpers ───────────────────────────────────────────────────────────────────
def _decode_logo(data_url: str) -> Optional[BytesIO]:
    try:
        if not data_url or not data_url.startswith("data:image"):
            return None
        _, b64 = data_url.split(",", 1)
        return BytesIO(base64.b64decode(b64))
    except Exception:
        return None


def _section_rule():
    return HRFlowable(width="100%", thickness=0.5, color=BORDER, spaceAfter=6, spaceBefore=2)


def _match_color(match_type: str) -> colors.Color:
    return {
        "exact":    colors.HexColor("#DC2626"),
        "phonetic": colors.HexColor("#D97706"),
        "contains": colors.HexColor("#2563EB"),
        "similar":  colors.HexColor("#7C3AED"),
        "weak":     colors.HexColor("#9CA3AF"),
    }.get((match_type or "").lower(), colors.HexColor("#9CA3AF"))


def _status_color(status: str) -> colors.Color:
    s = (status or "").lower()
    if s in ("registered", "accepted", "advertised", "opposed", "objected"):
        return colors.HexColor("#DC2626")
    if s in ("under examination", "pending"):
        return colors.HexColor("#D97706")
    if s in ("abandoned", "refused", "withdrawn", "removed"):
        return colors.HexColor("#9CA3AF")
    return MUTED


def _reg_probability(risk_score: int, status: str) -> int:
    """Estimate registration success probability from risk score."""
    base = max(0, 100 - risk_score)
    if status == "AVAILABLE":
        return min(95, base + 10)
    elif status == "CONFLICT":
        return max(5, base - 15)
    return base


def _make_page_cb(footer_left: str, footer_right: str, watermark: str = ""):
    def _cb(canvas, doc):
        canvas.saveState()
        if watermark:
            canvas.saveState()
            wm_text = watermark.upper()
            font_size = max(28, min(68, int(180 / max(len(wm_text), 1))))
            canvas.setFont("Helvetica-Bold", font_size)
            canvas.setFillColor(colors.HexColor("#C8D4E0"))
            canvas.setFillAlpha(0.15)
            canvas.translate(PAGE_W / 2, PAGE_H / 2)
            canvas.rotate(45)
            canvas.drawCentredString(0, 0, wm_text)
            canvas.restoreState()
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.4)
        y_rule = 12 * mm
        canvas.line(L_MARGIN, y_rule, PAGE_W - R_MARGIN, y_rule)
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(L_MARGIN, 8 * mm, footer_left)
        canvas.drawRightString(PAGE_W - R_MARGIN, 8 * mm, footer_right)
        canvas.drawCentredString(PAGE_W / 2, 8 * mm, f"Page {doc.page}")
        canvas.restoreState()
    return _cb


def _build_logo_table(logo_url: str, full_width: bool = True) -> Optional[object]:
    """Build a logo table flowable. Returns None if logo can't be decoded."""
    if not logo_url:
        return None
    logo_stream = _decode_logo(logo_url)
    if not logo_stream:
        return None
    try:
        from PIL import Image as PILImage
        logo_stream.seek(0)
        pil = PILImage.open(logo_stream)
        nat_w, nat_h = pil.size
        logo_stream.seek(0)
        w = CONTENT_W if full_width else CONTENT_W * 0.55
        scaled_h = min((nat_h / nat_w) * w if nat_w > 0 else 20 * mm, 36 * mm)
        img = RLImage(logo_stream, width=w, height=scaled_h)
    except Exception:
        try:
            logo_stream.seek(0)
            img = RLImage(logo_stream, width=CONTENT_W if full_width else CONTENT_W * 0.55,
                          height=30 * mm, kind="proportional")
        except Exception:
            return None
    tbl = Table([[img]], colWidths=[CONTENT_W])
    tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), WHITE),
        ("BOX",           (0, 0), (-1, -1), 0.4, BORDER),
        ("TOPPADDING",    (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("ALIGN",         (0, 0), (-1, -1), "CENTER"),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return tbl


def _build_header_band(logo_url: str, tagline: str, st: dict) -> List:
    """Return a list of flowables: logo (or navy band) + tagline strip."""
    items = []
    logo_tbl = _build_logo_table(logo_url, full_width=True)
    if logo_tbl:
        items.append(logo_tbl)
        items.append(Spacer(1, 6))
    else:
        hdr_tbl = Table([[Paragraph(
            "BUREAU OF TRADEMARK INTELLIGENCE — INDIA",
            ParagraphStyle("hdr_text", fontName="Helvetica-Bold", fontSize=11,
                           textColor=WHITE, leading=15),
        )]], colWidths=[CONTENT_W])
        hdr_tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, -1), NAVY),
            ("TOPPADDING",    (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ("LEFTPADDING",   (0, 0), (-1, -1), 14),
        ]))
        items.append(hdr_tbl)
        items.append(Spacer(1, 6))

    if tagline:
        tag_tbl = Table([[Paragraph(tagline, ParagraphStyle(
            "tagline", fontName="Helvetica", fontSize=8.5, textColor=BLUE, leading=12,
        ))]], colWidths=[CONTENT_W])
        tag_tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, -1), LIGHT_BLUE),
            ("TOPPADDING",    (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 12),
            ("BOX",           (0, 0), (-1, -1), 0.4, BORDER),
        ]))
        items.append(tag_tbl)
        items.append(Spacer(1, 8))
    return items


def _build_client_table(client_name: str, client_mobile: str, report_date: str, st: dict, prepared_by: str = ""):
    ci_rows = []
    if client_name:
        ci_rows.append([Paragraph("CLIENT", st["small_bold"]), Paragraph(client_name, st["body_bold"])])
    if client_mobile:
        ci_rows.append([Paragraph("MOBILE", st["small_bold"]), Paragraph(client_mobile, st["body"])])
    if report_date:
        ci_rows.append([Paragraph("REPORT DATE", st["small_bold"]), Paragraph(report_date, st["body"])])
    if prepared_by:
        ci_rows.append([Paragraph("PREPARED BY", st["small_bold"]), Paragraph(prepared_by, st["body_bold"])])
    if not ci_rows:
        return None
    ci_tbl = Table(ci_rows, colWidths=[28 * mm, CONTENT_W - 28 * mm])
    ci_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), SUBTLE),
        ("BACKGROUND",    (0, 0), (0, -1),  LIGHT_BLUE),
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER),
        ("INNERGRID",     (0, 0), (-1, -1), 0.3, BORDER),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
    ]))
    return ci_tbl


# ── Core: render one mark's full dossier pages ───────────────────────────────
def _render_trademark_dossier(story: List, report: dict, branding: dict, st: dict,
                               page_break_first: bool = False):
    """
    Append all dossier flowables for a single mark to `story`.
    Identical output for single and bulk reports.

    branding keys: logo_url, footer, tagline, watermark,
                   client_name, client_mobile, report_date
    """
    if page_break_first:
        story.append(PageBreak())

    query       = report.get("query", "—")
    overall     = report.get("overall_status", "UNKNOWN")
    risk        = report.get("risk_score", 0)
    headline    = report.get("headline", "")
    counts      = report.get("summary_counts", {}) or {}
    class_bd    = report.get("class_breakdown", []) or []
    recs        = report.get("recommendations", []) or []
    alts        = report.get("alternative_name_suggestions", []) or []
    all_results = report.get("all_results", []) or []
    created_raw = report.get("created_at", "") or datetime.utcnow().isoformat()
    created     = created_raw[:19].replace("T", " ") + " UTC"

    logo_url      = branding.get("logo_url") or report.get("logo_data_url")
    tagline       = branding.get("tagline") or report.get("tagline", "") or "Trademark Availability Report"
    client_name   = branding.get("client_name", "") or ""
    client_mobile = branding.get("client_mobile", "") or ""
    report_date   = branding.get("report_date", "") or ""
    prepared_by   = branding.get("prepared_by", "") or report.get("prepared_by", "") or ""

    vp = VERDICT_PALETTE.get(overall, VERDICT_PALETTE["CAUTION"])
    reg_prob = _reg_probability(risk, overall)
    badge_label, badge_fg, badge_bg = FILING_BADGE.get(overall, FILING_BADGE["CAUTION"])

    # ── HEADER BAND ──────────────────────────────────────────────────────────
    story.extend(_build_header_band(logo_url, tagline, st))

    # ── TITLE ROW ────────────────────────────────────────────────────────────
    story.append(Paragraph("Trademark Availability Dossier", st["h1"]))
    story.append(Paragraph(
        f"Subject mark: <b>{query}</b> &nbsp;·&nbsp; Generated: {created}"
        + (" &nbsp;·&nbsp; <b>Device marks only</b>" if report.get("device_only") else ""),
        st["subtitle"],
    ))
    story.append(_section_rule())

    # ── CLIENT INFORMATION ───────────────────────────────────────────────────
    ci_tbl = _build_client_table(client_name, client_mobile, report_date, st, prepared_by)
    if ci_tbl:
        story.append(ci_tbl)
        story.append(Spacer(1, 10))

    # ── VERDICT BLOCK ────────────────────────────────────────────────────────
    story.append(Spacer(1, 4))

    verdict_label_p = Paragraph(
        f'<font color="{vp["fg"].hexval()}"><b>{vp["label"]}</b></font>',
        st["verdict_label"],
    )
    headline_p = Paragraph(headline, st["body"])

    # Filing badge + reg probability
    badge_p = Paragraph(
        f'<font color="{badge_fg.hexval()}"><b>● {badge_label}</b></font>',
        ParagraphStyle("badge", fontName="Helvetica-Bold", fontSize=9, leading=13),
    )
    prob_p = Paragraph(
        f'Registration Success Probability: <b>{reg_prob}%</b>',
        ParagraphStyle("prob", fontName="Helvetica", fontSize=8.5, textColor=MUTED, leading=12),
    )

    risk_num_p   = Paragraph(f'<font color="{vp["bar"].hexval()}">{risk}</font>', st["risk_num"])
    risk_denom_p = Paragraph("/100", ParagraphStyle(
        "denom", fontName="Helvetica", fontSize=11, textColor=MUTED, leading=14, alignment=TA_CENTER,
    ))
    risk_label_p = Paragraph("RISK SCORE", st["risk_label"])

    verdict_tbl = Table(
        [
            [verdict_label_p,   risk_num_p  ],
            [headline_p,        risk_denom_p],
            [badge_p,           risk_label_p],
            [prob_p,            ""],
        ],
        colWidths=[CONTENT_W * 0.72, CONTENT_W * 0.28],
    )
    verdict_tbl.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, -1), vp["bg"]),
        ("BOX",          (0, 0), (-1, -1), 1.2, vp["border"]),
        ("LINEAFTER",    (0, 0), (0, -1),  0.5, vp["border"]),
        ("SPAN",         (0, 1), (0, 2)),
        ("SPAN",         (1, 1), (1, 3)),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN",        (1, 0), (1, -1),  "CENTER"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING",   (0, 0), (-1, 0),  12),
        ("BOTTOMPADDING",(0, 3), (-1, 3),  12),
        ("TOPPADDING",   (0, 1), (-1, 1),   4),
        ("TOPPADDING",   (1, 0), (1, 0),   10),
        ("TOPPADDING",   (0, 3), (0, 3),    4),
    ]))
    story.append(verdict_tbl)
    story.append(Spacer(1, 10))

    # ── PLAIN-LANGUAGE VERDICT (Layman Summary) ───────────────────────────────
    if overall == "AVAILABLE":
        plain_icon  = "✔"
        plain_color = colors.HexColor("#166534")
        plain_bg    = colors.HexColor("#DCFCE7")
        plain_border= colors.HexColor("#86EFAC")
        plain_head  = "Good News — You Can Likely File This Trademark"
        plain_body  = (
            f"No identical or very similar trademark for <b>\"{query}\"</b> was found in the "
            "registry. This means your chances of getting this name registered are high. "
            "However, always do a final check with a trademark attorney before filing, because "
            "the registry may still raise an objection based on details not visible in this search."
        )
        plain_action = "✅ Recommended Action: Proceed with filing — engage a trademark attorney to draft the application."
    elif overall == "CONFLICT":
        plain_icon  = "✘"
        plain_color = colors.HexColor("#7F1D1D")
        plain_bg    = colors.HexColor("#FEE2E2")
        plain_border= colors.HexColor("#FCA5A5")
        plain_head  = "Caution — Strong Conflicts Found, Filing is Risky"
        plain_body  = (
            f"One or more trademarks very similar to <b>\"{query}\"</b> already exist and are "
            "active in the same category. If you file now, the registry will very likely reject "
            "your application — or the existing owner can challenge and cancel it even after "
            "registration. This does NOT mean you can never use the name — but filing as-is is risky."
        )
        plain_action = "⚠ Recommended Action: Consult a trademark attorney before filing. Consider modifying the name or filing in a different class."
    else:
        plain_icon  = "◐"
        plain_color = colors.HexColor("#92400E")
        plain_bg    = colors.HexColor("#FEF3C7")
        plain_border= colors.HexColor("#FCD34D")
        plain_head  = "Proceed with Care — Some Similar Marks Exist"
        plain_body  = (
            f"Some trademarks with names or sounds similar to <b>\"{query}\"</b> were found, but "
            "none are an exact match. Registration may still be possible, but the registry "
            "could raise an objection. The outcome depends on how different your goods/services "
            "are from the existing marks and how distinctly your brand is presented."
        )
        plain_action = "🔍 Recommended Action: Get a legal opinion before filing. A small change to the name or logo may significantly improve your chances."

    plain_tbl = Table([[
        Paragraph(
            f'<font color="{plain_color.hexval()}"><b>{plain_icon} {plain_head}</b></font><br/><br/>'
            f'{plain_body}<br/><br/>'
            f'<font color="{plain_color.hexval()}"><i>{plain_action}</i></font>',
            ParagraphStyle(
                "plain_body",
                fontName="Helvetica", fontSize=9, textColor=TEXT,
                leading=14, spaceAfter=0,
            ),
        )
    ]], colWidths=[CONTENT_W])
    plain_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), plain_bg),
        ("BOX",           (0, 0), (-1, -1), 1.0, plain_border),
        ("TOPPADDING",    (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("LEFTPADDING",   (0, 0), (-1, -1), 14),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 14),
    ]))
    story.append(Paragraph("WHAT THIS MEANS FOR YOU", st["eyebrow"]))
    story.append(_section_rule())
    story.append(plain_tbl)
    story.append(Spacer(1, 10))

    # ── MATCH COUNTS ─────────────────────────────────────────────────────────
    story.append(Paragraph("MATCH COUNTS", st["eyebrow"]))
    story.append(_section_rule())

    count_data = [
        [
            Paragraph("EXACT",             st["small_bold"]),
            Paragraph("PHONETIC",          st["small_bold"]),
            Paragraph("SIMILAR / CONTAINS",st["small_bold"]),
            Paragraph("TOTAL FILINGS",     st["small_bold"]),
        ],
        [
            Paragraph(f'<font color="#DC2626"><b>{counts.get("exact", 0)}</b></font>',
                      ParagraphStyle("cn", fontName="Helvetica-Bold", fontSize=28, leading=34, alignment=TA_CENTER)),
            Paragraph(f'<font color="#D97706"><b>{counts.get("phonetic", 0)}</b></font>',
                      ParagraphStyle("cn2", fontName="Helvetica-Bold", fontSize=28, leading=34, alignment=TA_CENTER)),
            Paragraph(f'<font color="#2563EB"><b>{counts.get("contains_or_similar", 0)}</b></font>',
                      ParagraphStyle("cn3", fontName="Helvetica-Bold", fontSize=28, leading=34, alignment=TA_CENTER)),
            Paragraph(f'<font color="{NAVY.hexval()}"><b>{counts.get("total_results", 0)}</b></font>',
                      ParagraphStyle("cn4", fontName="Helvetica-Bold", fontSize=28, leading=34, alignment=TA_CENTER)),
        ],
    ]
    cw = CONTENT_W / 4
    cnt_tbl = Table(count_data, colWidths=[cw] * 4)
    cnt_tbl.setStyle(TableStyle([
        ("BOX",          (0, 0), (-1, -1), 0.5, BORDER),
        ("INNERGRID",    (0, 0), (-1, -1), 0.4, BORDER),
        ("BACKGROUND",   (0, 0), (-1, 0),  SUBTLE),
        ("BACKGROUND",   (0, 1), (-1, 1),  WHITE),
        ("ALIGN",        (0, 0), (-1, -1), "CENTER"),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",   (0, 0), (-1, 0),   7),
        ("BOTTOMPADDING",(0, 0), (-1, 0),   7),
        ("TOPPADDING",   (0, 1), (-1, 1),  10),
        ("BOTTOMPADDING",(0, 1), (-1, 1),  10),
    ]))
    story.append(cnt_tbl)
    story.append(Spacer(1, 4))

    # ── RECOMMENDATIONS ───────────────────────────────────────────────────────
    story.append(Paragraph("RECOMMENDATIONS", st["eyebrow"]))
    story.append(_section_rule())
    for i, rec in enumerate(recs, 1):
        story.append(KeepTogether([Table(
            [[Paragraph(f"{i:02d}.", st["rec_num"]), Paragraph(rec, st["rec_text"])]],
            colWidths=[10 * mm, CONTENT_W - 10 * mm],
        )]))
    story.append(Spacer(1, 4))

    # ── ALTERNATIVE NAMES ─────────────────────────────────────────────────────
    if alts:
        story.append(Paragraph("ALTERNATIVE NAMES", st["eyebrow"]))
        story.append(_section_rule())
        pills_txt = "  ·  ".join(alts)
        alt_tbl = Table([[Paragraph(pills_txt, ParagraphStyle(
            "alts", fontName="Helvetica", fontSize=9.5, textColor=BLUE, leading=14,
        ))]], colWidths=[CONTENT_W])
        alt_tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, -1), LIGHT_BLUE),
            ("BOX",           (0, 0), (-1, -1), 0.5, BORDER),
            ("TOPPADDING",    (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ("LEFTPADDING",   (0, 0), (-1, -1), 14),
        ]))
        story.append(alt_tbl)
        story.append(Spacer(1, 4))

    # ── CLASS BREAKDOWN ───────────────────────────────────────────────────────
    if class_bd:
        story.append(Paragraph("CLASS-WISE BREAKDOWN", st["eyebrow"]))
        story.append(_section_rule())
        hdr = [
            Paragraph("CLASS",    st["tbl_hdr"]),
            Paragraph("SECTOR",   st["tbl_hdr"]),
            Paragraph("TOTAL",    st["tbl_hdr"]),
            Paragraph("BLOCKING", st["tbl_hdr"]),
            Paragraph("DEAD",     st["tbl_hdr"]),
        ]
        rows = [hdr]
        for cb in class_bd[:20]:
            cls_no  = cb.get("class", "?")
            cls_str = f"CL{cls_no:02d}" if isinstance(cls_no, int) else str(cls_no)
            blocking_v = cb.get("blocking", 0)
            blocking_cell = Paragraph(
                f'<font color="#DC2626"><b>{blocking_v}</b></font>' if blocking_v else "0",
                ParagraphStyle("tc_r", fontName="Helvetica-Bold" if blocking_v else "Helvetica",
                               fontSize=8, leading=11, alignment=TA_CENTER),
            )
            rows.append([
                Paragraph(cls_str, ParagraphStyle("cls", fontName="Helvetica-Bold", fontSize=8,
                                                  textColor=BLUE, leading=11, alignment=TA_CENTER)),
                Paragraph(cb.get("hint", "—"), st["tbl_cell"]),
                Paragraph(str(cb.get("total", 0)), ParagraphStyle("tc_c", fontName="Helvetica-Bold",
                          fontSize=8, textColor=NAVY, leading=11, alignment=TA_CENTER)),
                blocking_cell,
                Paragraph(str(cb.get("dead", 0)), ParagraphStyle("tc_r2", fontName="Helvetica",
                          fontSize=8, textColor=MUTED, leading=11, alignment=TA_CENTER)),
            ])
        cws = [16*mm, CONTENT_W - 16*mm - 20*mm - 24*mm - 20*mm, 20*mm, 24*mm, 20*mm]
        cls_tbl = Table(rows, colWidths=cws, repeatRows=1)
        cls_tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, 0),  NAVY),
            ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, SUBTLE]),
            ("BOX",           (0, 0), (-1, -1), 0.5, BORDER),
            ("LINEBELOW",     (0, 0), (-1, 0),  0.8, NAVY),
            ("INNERGRID",     (0, 1), (-1, -1), 0.3, BORDER),
            ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING",    (0, 0), (-1, -1),  6),
            ("BOTTOMPADDING", (0, 0), (-1, -1),  6),
            ("LEFTPADDING",   (0, 0), (-1, -1),  6),
            ("RIGHTPADDING",  (0, 0), (-1, -1),  6),
        ]))
        story.append(cls_tbl)
        story.append(Spacer(1, 4))

    # ── EXHIBIT A — MATCHES ───────────────────────────────────────────────────
    if all_results:
        story.append(PageBreak())

        # Repeat logo (smaller) on exhibit page
        logo_sm = _build_logo_table(logo_url, full_width=False)
        if logo_sm:
            story.append(logo_sm)
            story.append(Spacer(1, 8))

        story.append(Paragraph("EXHIBIT A", st["eyebrow"]))
        story.append(Paragraph("Recorded Matches", st["h2"]))
        story.append(Paragraph(
            f"Showing all {len(all_results)} indexed filings for <b>{query}</b>.",
            st["subtitle"],
        ))
        story.append(_section_rule())

        ex_hdr = [
            Paragraph("APP. ID",   st["tbl_hdr"]),
            Paragraph("MARK NAME", st["tbl_hdr"]),
            Paragraph("APPLICANT", st["tbl_hdr"]),
            Paragraph("STATUS",    st["tbl_hdr"]),
            Paragraph("LOGO",      st["tbl_hdr"]),
            Paragraph("CL.",       st["tbl_hdr"]),
            Paragraph("MATCH",     st["tbl_hdr"]),
            Paragraph("RISK",      st["tbl_hdr"]),
        ]
        ex_rows = [ex_hdr]

        for r in all_results:
            mt    = (r.get("match_type") or "").lower()
            mt_c  = _match_color(mt)
            st_c  = _status_color(r.get("status", ""))
            risk_v = r.get("individual_risk_score", 0)
            r_c = (colors.HexColor("#DC2626") if risk_v >= 70
                   else colors.HexColor("#D97706") if risk_v >= 40 else MUTED)

            logo_cell = Paragraph("—", st["tbl_cell"])
            img_data_url = r.get("mark_image_data_url") or r.get("mark_image_url", "")
            if img_data_url and img_data_url.startswith("data:image"):
                try:
                    img_stream = _decode_logo(img_data_url)
                    if img_stream:
                        logo_cell = RLImage(img_stream, width=12*mm, height=12*mm, kind="proportional")
                except Exception:
                    pass

            ex_rows.append([
                Paragraph(str(r.get("application_id") or "—"), st["tbl_cell_mono"]),
                Paragraph((r.get("name") or "—")[:34], ParagraphStyle(
                    "nm", fontName="Helvetica-Bold", fontSize=8, textColor=TEXT, leading=11,
                )),
                Paragraph((r.get("applicant") or "—")[:30], st["tbl_cell"]),
                Paragraph(
                    f'<font color="{st_c.hexval()}">{(r.get("status") or "—")[:16]}</font>',
                    st["tbl_cell"],
                ),
                logo_cell,
                Paragraph(str(r.get("class") or "—"), ParagraphStyle(
                    "cls2", fontName="Helvetica-Bold", fontSize=8, textColor=BLUE, leading=11, alignment=TA_CENTER,
                )),
                Paragraph(
                    f'<font color="{mt_c.hexval()}"><b>{mt.upper()}</b></font>',
                    ParagraphStyle("mtc", fontName="Helvetica-Bold", fontSize=7.5, leading=11, alignment=TA_CENTER),
                ),
                Paragraph(
                    f'<font color="{r_c.hexval()}"><b>{risk_v}</b></font>',
                    ParagraphStyle("rc", fontName="Helvetica-Bold", fontSize=8, leading=11, alignment=TA_CENTER),
                ),
            ])

        ex_cws = [20*mm, 46*mm, 38*mm, 26*mm, 14*mm, 10*mm, 20*mm, 12*mm]
        ex_tbl = Table(ex_rows, colWidths=ex_cws, repeatRows=1)
        ex_tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, 0),  NAVY),
            ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, SUBTLE]),
            ("BOX",           (0, 0), (-1, -1), 0.5, BORDER),
            ("LINEBELOW",     (0, 0), (-1, 0),  0.8, NAVY),
            ("INNERGRID",     (0, 1), (-1, -1), 0.3, BORDER),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING",    (0, 0), (-1, -1),  5),
            ("BOTTOMPADDING", (0, 0), (-1, -1),  5),
            ("LEFTPADDING",   (0, 0), (-1, -1),  5),
            ("RIGHTPADDING",  (0, 0), (-1, -1),  5),
        ]))
        story.append(ex_tbl)

    # ── FOOTER NOTE ───────────────────────────────────────────────────────────
    story.append(Spacer(1, 14))
    story.append(_section_rule())
    story.append(Paragraph(
        "Data source: quickcompany.in · IP India trademark index. "
        "For informational purposes only — not legal advice.",
        st["footer"],
    ))


# ── Public entry points ───────────────────────────────────────────────────────
def build_report_pdf(doc_record: dict) -> bytes:
    """Generate a single-mark trademark availability PDF."""
    report      = doc_record.get("report") or doc_record
    created_raw = doc_record.get("created_at") or datetime.utcnow().isoformat()
    created     = created_raw[:19].replace("T", " ") + " UTC"
    query       = report.get("query", "—")

    logo_url      = report.get("logo_data_url")
    footer_text   = report.get("footer_text", "") or ""
    tagline       = report.get("tagline", "") or "Trademark Availability Report"
    watermark     = report.get("watermark", "") or ""
    if watermark == "CUSTOM":
        watermark = report.get("custom_watermark", "") or ""

    client_name   = report.get("client_name", "") or doc_record.get("client_name", "") or ""
    client_mobile = report.get("client_mobile","") or doc_record.get("client_mobile","") or ""
    report_date   = report.get("report_date",  "") or doc_record.get("report_date",  "") or ""

    branding = {
        "logo_url":      logo_url,
        "tagline":       tagline,
        "client_name":   client_name,
        "client_mobile": client_mobile,
        "report_date":   report_date,
    }

    footer_l = footer_text or "Bureau of Trademark Intelligence — India"
    footer_r = f"Subject mark: {query} · {created}"

    buf = BytesIO()
    st  = _S()
    pdf = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=14 * mm, bottomMargin=20 * mm,
        title=f"Trademark Report — {query}",
    )
    story = []

    # Attach created_at to report so _render_trademark_dossier can use it
    report = {**report, "created_at": created_raw}
    _render_trademark_dossier(story, report, branding, st, page_break_first=False)

    page_cb = _make_page_cb(footer_l, footer_r, watermark)
    pdf.build(story, onFirstPage=page_cb, onLaterPages=page_cb)
    return buf.getvalue()


def build_combined_report_pdf(items: list, branding: dict) -> bytes:
    """
    Generate a combined PDF for bulk trademark search.
    Structure:
      Page 1: Executive Summary (portfolio analytics)
      Then for each mark: full individual dossier (identical to single report)
    """
    logo_url      = branding.get("logo_data_url")
    footer_text   = branding.get("footer_text", "") or ""
    tagline       = branding.get("tagline", "") or "Bulk Trademark Availability Report"
    watermark     = branding.get("watermark", "") or ""
    if watermark == "CUSTOM":
        watermark = branding.get("custom_watermark", "") or ""

    client_name   = branding.get("client_name",   "") or ""
    client_mobile = branding.get("client_mobile", "") or ""
    report_date   = branding.get("report_date",   "") or ""
    prepared_by   = branding.get("prepared_by",   "") or ""

    created = datetime.utcnow().strftime("%Y-%m-%d %H:%M") + " UTC"
    total     = len(items)
    available = sum(1 for it in items if it.get("overall_status") == "AVAILABLE")
    caution   = sum(1 for it in items if it.get("overall_status") == "CAUTION")
    conflict  = sum(1 for it in items if it.get("overall_status") == "CONFLICT")

    risk_scores   = [it.get("risk_score", 0) for it in items if not it.get("error") and it.get("risk_score")]
    avg_risk      = int(sum(risk_scores) / len(risk_scores)) if risk_scores else 0
    high_risk_names = [it.get("name", "") for it in items
                       if not it.get("error") and (it.get("risk_score", 0) or 0) >= 70]

    footer_l = footer_text or "Bureau of Trademark Intelligence — India"
    footer_r = f"Bulk report · {total} marks · {created}"

    buf = BytesIO()
    st  = _S()
    pdf = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=14 * mm, bottomMargin=20 * mm,
        title="Bulk Trademark Availability Report",
    )
    story = []

    per_mark_branding = {
        "logo_url":      logo_url,
        "tagline":       tagline,
        "client_name":   client_name,
        "client_mobile": client_mobile,
        "report_date":   report_date,
        "prepared_by":   prepared_by,
    }

    # ════════════════════════════════
    # EXECUTIVE SUMMARY PAGE
    # ════════════════════════════════
    story.extend(_build_header_band(logo_url, tagline, st))

    story.append(Paragraph("Bulk Trademark Availability Report", st["h1"]))
    story.append(Paragraph(
        f"Total marks analysed: <b>{total}</b> &nbsp;·&nbsp; Generated: {created}",
        st["subtitle"],
    ))
    story.append(_section_rule())

    # Client info
    ci_tbl = _build_client_table(client_name, client_mobile, report_date, st, prepared_by)
    if ci_tbl:
        story.append(ci_tbl)
        story.append(Spacer(1, 10))

    # Portfolio summary stats
    story.append(Paragraph("PORTFOLIO SUMMARY", st["eyebrow"]))
    story.append(_section_rule())

    stat_data = [
        [
            Paragraph("TOTAL MARKS",    st["small_bold"]),
            Paragraph("AVAILABLE",      st["small_bold"]),
            Paragraph("CAUTION",        st["small_bold"]),
            Paragraph("CONFLICT",       st["small_bold"]),
            Paragraph("AVERAGE RISK",   st["small_bold"]),
        ],
        [
            Paragraph(f'<font color="{NAVY.hexval()}"><b>{total}</b></font>',
                      ParagraphStyle("s1", fontName="Helvetica-Bold", fontSize=24, leading=30, alignment=TA_CENTER)),
            Paragraph(f'<font color="{EMERALD.hexval()}"><b>{available}</b></font>',
                      ParagraphStyle("s2", fontName="Helvetica-Bold", fontSize=24, leading=30, alignment=TA_CENTER)),
            Paragraph(f'<font color="{AMBER.hexval()}"><b>{caution}</b></font>',
                      ParagraphStyle("s3", fontName="Helvetica-Bold", fontSize=24, leading=30, alignment=TA_CENTER)),
            Paragraph(f'<font color="{RED.hexval()}"><b>{conflict}</b></font>',
                      ParagraphStyle("s4", fontName="Helvetica-Bold", fontSize=24, leading=30, alignment=TA_CENTER)),
            Paragraph(f'<font color="{NAVY.hexval()}"><b>{avg_risk}</b></font>',
                      ParagraphStyle("s5", fontName="Helvetica-Bold", fontSize=24, leading=30, alignment=TA_CENTER)),
        ],
    ]
    cw5 = CONTENT_W / 5
    stat_tbl = Table(stat_data, colWidths=[cw5] * 5)
    stat_tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER),
        ("INNERGRID",     (0, 0), (-1, -1), 0.4, BORDER),
        ("BACKGROUND",    (0, 0), (-1, 0),  SUBTLE),
        ("BACKGROUND",    (0, 1), (-1, 1),  WHITE),
        ("ALIGN",         (0, 0), (-1, -1), "CENTER"),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",    (0, 0), (-1, 0),   7),
        ("BOTTOMPADDING", (0, 0), (-1, 0),   7),
        ("TOPPADDING",    (0, 1), (-1, 1),  10),
        ("BOTTOMPADDING", (0, 1), (-1, 1),  10),
    ]))
    story.append(stat_tbl)
    story.append(Spacer(1, 10))

    # High risk alert
    if high_risk_names:
        hn_text = ", ".join(f"<b>{n}</b>" for n in high_risk_names)
        hr_tbl = Table([[Paragraph(
            f'⚠ High-risk marks requiring immediate review: {hn_text}',
            ParagraphStyle("hr_p", fontName="Helvetica", fontSize=8.5,
                           textColor=RED, leading=13),
        )]], colWidths=[CONTENT_W])
        hr_tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, -1), RED_BG),
            ("BOX",           (0, 0), (-1, -1), 0.5, colors.HexColor("#FCA5A5")),
            ("TOPPADDING",    (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("LEFTPADDING",   (0, 0), (-1, -1), 12),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 12),
        ]))
        story.append(hr_tbl)
        story.append(Spacer(1, 8))

    # Portfolio-level filing recommendations
    story.append(Paragraph("FILING RECOMMENDATIONS", st["eyebrow"]))
    story.append(_section_rule())
    rec_items = []
    if conflict > 0:
        rec_items.append(f"<b>{conflict} mark(s)</b> show conflict — avoid filing without legal review.")
    if caution > 0:
        rec_items.append(f"<b>{caution} mark(s)</b> require caution — conduct deeper phonetic + device search.")
    if available > 0:
        rec_items.append(f"<b>{available} mark(s)</b> appear available — proceed with filing in low-conflict classes.")
    if avg_risk > 60:
        rec_items.append("Portfolio average risk is high — consider alternative brand names.")
    rec_items.append("Always confirm final results on the official IP India database before filing.")
    for i, rec in enumerate(rec_items, 1):
        story.append(KeepTogether([Table(
            [[Paragraph(f"{i:02d}.", st["rec_num"]), Paragraph(rec, st["rec_text"])]],
            colWidths=[10 * mm, CONTENT_W - 10 * mm],
        )]))
    story.append(Spacer(1, 12))

    # ── PLAIN-LANGUAGE PORTFOLIO GUIDE ───────────────────────────────────────
    if conflict == 0 and caution == 0:
        pl_bg = EMERALD_BG; pl_bd = colors.HexColor("#86EFAC"); pl_c = EMERALD
        pl_icon = "✔"; pl_head = "All Marks Look Clear — Good Position to File"
        pl_body = (
            f"All <b>{total}</b> brand name(s) searched appear to be available with no major "
            "conflicts found. You are in a strong position to begin trademark registration. "
            "Review individual dossiers below for mark-specific details."
        )
    elif conflict >= total // 2 + 1:
        pl_bg = RED_BG; pl_bd = colors.HexColor("#FCA5A5"); pl_c = RED
        pl_icon = "✘"; pl_head = "Most Marks Have Conflicts — Seek Legal Advice Before Filing"
        pl_body = (
            f"Out of <b>{total}</b> marks searched, <b>{conflict}</b> have significant "
            "conflicts with already-registered trademarks. Filing these names as-is risks "
            "rejection or legal challenge. Consider alternate names (see each dossier) or "
            "consult a trademark attorney for a modified filing strategy."
        )
    else:
        pl_bg = AMBER_BG; pl_bd = colors.HexColor("#FCD34D"); pl_c = AMBER
        pl_icon = "◐"; pl_head = "Mixed Results — Some Marks Ready, Others Need Review"
        pl_body = (
            f"Of <b>{total}</b> marks: <b>{available}</b> appear available to file, "
            f"<b>{caution}</b> need caution and deeper review, and <b>{conflict}</b> have "
            "strong conflicts. Focus on marks labelled 'Available' and get a legal opinion "
            "for those marked 'Caution' or 'Conflict' before spending on filing fees."
        )
    action_lines = []
    if available:
        action_lines.append(f"✅ <b>{available} mark(s)</b> — Safe to proceed with filing.")
    if caution:
        action_lines.append(f"🔍 <b>{caution} mark(s)</b> — Get a legal opinion first.")
    if conflict:
        action_lines.append(f"⚠ <b>{conflict} mark(s)</b> — Avoid filing without attorney review or name modification.")
    action_lines.append("📋 Verify final results on the official IP India database (ipindia.gov.in) before filing.")

    pl_tbl = Table([[Paragraph(
        f'<font color="{pl_c.hexval()}"><b>{pl_icon}  {pl_head}</b></font><br/><br/>'
        f'{pl_body}<br/><br/>'
        + "<br/>".join(action_lines),
        ParagraphStyle("pl_p", fontName="Helvetica", fontSize=9, textColor=TEXT, leading=14),
    )]], colWidths=[CONTENT_W])
    pl_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), pl_bg),
        ("BOX",           (0, 0), (-1, -1), 1.0, pl_bd),
        ("TOPPADDING",    (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("LEFTPADDING",   (0, 0), (-1, -1), 14),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 14),
    ]))
    story.append(Paragraph("WHAT THIS MEANS FOR YOU — PLAIN LANGUAGE GUIDE", st["eyebrow"]))
    story.append(_section_rule())
    story.append(pl_tbl)
    story.append(Spacer(1, 12))

    # Mark-by-mark summary table
    story.append(Paragraph("MARK-BY-MARK ANALYSIS", st["eyebrow"]))
    story.append(_section_rule())

    mark_rows = [[
        Paragraph("MARK NAME",         st["tbl_hdr"]),
        Paragraph("VERDICT",           st["tbl_hdr"]),
        Paragraph("RISK",              st["tbl_hdr"]),
        Paragraph("REG. PROBABILITY",  st["tbl_hdr"]),
        Paragraph("FILING BADGE",      st["tbl_hdr"]),
        Paragraph("ANALYSIS SUMMARY",  st["tbl_hdr"]),
    ]]

    for it in items:
        status   = it.get("overall_status", "UNKNOWN")
        vp_it    = VERDICT_PALETTE.get(status, VERDICT_PALETTE["CAUTION"])
        risk_v   = it.get("risk_score", 0)
        prob     = _reg_probability(risk_v, status) if not it.get("error") else 0
        klass    = f'CL{str(it.get("class_filter","")).zfill(2)}' if it.get("class_filter") else "All"
        headline = it.get("headline", "") or it.get("error", "—")
        label    = vp_it["label"] if not it.get("error") else "ERROR"
        badge_l, badge_f, _ = FILING_BADGE.get(status, FILING_BADGE["CAUTION"])

        mark_rows.append([
            Paragraph(f'<b>{it.get("name", "")}</b>',
                      ParagraphStyle("mn", fontName="Helvetica-Bold", fontSize=8.5, leading=11, textColor=NAVY)),
            Paragraph(f'<font color="{vp_it["fg"].hexval()}"><b>{label}</b></font>',
                      ParagraphStyle("vd", fontName="Helvetica-Bold", fontSize=8.5, leading=11)),
            Paragraph(f'<font color="{vp_it["bar"].hexval()}"><b>{risk_v if not it.get("error") else "—"}</b></font>',
                      ParagraphStyle("rs", fontName="Helvetica-Bold", fontSize=10, leading=13, alignment=TA_CENTER)),
            Paragraph(f'<b>{prob}%</b>' if not it.get("error") else "—",
                      ParagraphStyle("pr", fontName="Helvetica-Bold", fontSize=9, leading=12,
                                     alignment=TA_CENTER, textColor=BLUE)),
            Paragraph(f'<font color="{badge_f.hexval()}"><b>{badge_l}</b></font>',
                      ParagraphStyle("bg", fontName="Helvetica-Bold", fontSize=7.5, leading=11)),
            Paragraph(headline, st["tbl_cell"]),
        ])

    mark_cws = [32*mm, 20*mm, 12*mm, 20*mm, 22*mm, CONTENT_W - 106*mm]
    mark_tbl = Table(mark_rows, colWidths=mark_cws, repeatRows=1)
    mark_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0),  NAVY),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, SUBTLE]),
        ("BOX",           (0, 0), (-1, -1), 0.5, BORDER),
        ("LINEBELOW",     (0, 0), (-1, 0),  0.8, NAVY),
        ("INNERGRID",     (0, 1), (-1, -1), 0.3, BORDER),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("ALIGN",         (2, 0), (3, -1),  "CENTER"),
        ("TOPPADDING",    (0, 0), (-1, -1),  6),
        ("BOTTOMPADDING", (0, 0), (-1, -1),  6),
        ("LEFTPADDING",   (0, 0), (-1, -1),  6),
        ("RIGHTPADDING",  (0, 0), (-1, -1),  6),
    ]))
    story.append(mark_tbl)

    story.append(Spacer(1, 14))
    story.append(_section_rule())
    story.append(Paragraph(
        "Data source: quickcompany.in · IP India trademark index. "
        "For informational purposes only — not legal advice.",
        st["footer"],
    ))

    # ════════════════════════════════
    # INDIVIDUAL DOSSIERS (one per mark)
    # ════════════════════════════════
    for it in items:
        if it.get("error"):
            continue

        # Build a report-shaped dict the dossier renderer understands
        mark_report = {
            "query":                     it.get("name", ""),
            "overall_status":            it.get("overall_status", "UNKNOWN"),
            "risk_score":                it.get("risk_score", 0),
            "headline":                  it.get("headline", ""),
            "summary_counts":            it.get("summary_counts", {}),
            "class_breakdown":           it.get("class_breakdown", []),
            "recommendations":           it.get("recommendations", []) or [
                "Conduct a deeper phonetic + device-mark search before filing.",
                "Consider filing in a class with fewer existing conflicts.",
                "Engage a trademark attorney to draft a strong specification.",
                "Always confirm results on the official IP India database before filing.",
            ],
            "alternative_name_suggestions": it.get("alternative_name_suggestions", []),
            "all_results":               it.get("all_results", []),
            "device_only":               it.get("device_only", False),
            "created_at":                created,
        }

        _render_trademark_dossier(
            story, mark_report, per_mark_branding, st,
            page_break_first=True,
        )

    page_cb = _make_page_cb(footer_l, footer_r, watermark)
    pdf.build(story, onFirstPage=page_cb, onLaterPages=page_cb)
    return buf.getvalue()
