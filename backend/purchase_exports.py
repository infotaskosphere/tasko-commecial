"""
purchase_exports.py — turn Purchase Register rows into files an accountant can use.

  * build_tally_xml()        Tally "Import Data" XML (Purchase vouchers, optional ledger masters)
  * build_register_xlsx()    Full register workbook (Register · Tally Vouchers · Summary)
  * build_register_csv()     Flat CSV of the register

Everything here is pure (no database, no FastAPI) so it can be unit-tested with plain dicts.

Accounting convention used in the Tally voucher (this is how Tally stores a Purchase voucher):

    Party (supplier)       Cr   grand total        ISDEEMEDPOSITIVE = No ,  AMOUNT = +total
    Purchase ledger        Dr   taxable value      ISDEEMEDPOSITIVE = Yes,  AMOUNT = -taxable
    Input CGST / SGST /…   Dr   tax amounts        ISDEEMEDPOSITIVE = Yes,  AMOUNT = -tax
    Round Off              Dr or Cr by sign        (see _round_entry)

so the amounts in every voucher always sum to exactly 0.00.
"""

from __future__ import annotations

import csv
import re
import xml.etree.ElementTree as ET
from collections import OrderedDict, defaultdict
from datetime import date, datetime
from io import BytesIO, StringIO
from typing import Any, Dict, Iterable, List, Optional, Tuple

STANDARD_GST_RATES = (0.1, 0.25, 1.5, 3.0, 5.0, 12.0, 18.0, 28.0)

GST_STATE_NAMES = {
    "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
    "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu",
    "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
    "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh",
    "38": "Ladakh", "97": "Other Territory", "99": "Other Country",
}

DEFAULT_TALLY_OPTIONS: Dict[str, Any] = {
    "tally_company": "",                 # leave blank to import into whichever company is open in Tally
    "voucher_type": "Purchase",
    "purchase_ledger": "Purchases",
    "purchase_ledger_mode": "single",    # single | per_invoice (use the AI-classified expense head)
    "cgst_ledger": "Input CGST",
    "sgst_ledger": "Input SGST",
    "igst_ledger": "Input IGST",
    "cess_ledger": "Input Cess",
    "round_off_ledger": "Round Off",
    "rate_wise_ledgers": False,          # "Input CGST 9%" instead of "Input CGST"
    "voucher_number_mode": "invoice_no", # invoice_no | auto (let Tally number it)
    "bill_allocations": True,            # track the supplier bill in Tally's bill-wise outstanding
    "create_masters": True,              # also emit ledger masters (party, purchase, tax, round-off)
    "party_group": "Sundry Creditors",
    "narration": "Purchase from {supplier} - Bill No. {invoice_no} dt. {date}",
}

# ─────────────────────────────────────────────────────────── helpers


def _f(v: Any) -> float:
    try:
        return round(float(v or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def _s(v: Any) -> str:
    return "" if v is None else str(v).strip()


_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")


def xml_text(v: Any) -> str:
    """Text that is safe inside an XML element (control characters removed, whitespace collapsed)."""
    return re.sub(r"\s+", " ", _BAD_XML.sub("", _s(v))).strip()


def tally_date(iso: str) -> str:
    """'2026-09-26' → '20260926' (Tally's date format)."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", _s(iso))
    if m:
        return "".join(m.groups())
    return date.today().strftime("%Y%m%d")


def _fmt_date(iso: str) -> str:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", _s(iso))
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else _s(iso)


def state_name(gstin: str) -> str:
    code = _s(gstin)[:2]
    return GST_STATE_NAMES.get(code, "") if code.isdigit() else ""


def _amt(v: float) -> str:
    return f"{v:.2f}"


def _std_rate(tax: float, taxable: float, parts: int) -> Optional[float]:
    """The GST slab a single component (CGST/SGST = half rate; IGST = full) belongs to."""
    if taxable <= 0 or tax <= 0:
        return None
    rate = tax / taxable * 100 * parts
    for r in STANDARD_GST_RATES:
        if abs(rate - r) <= 0.2:
            return r
    return None


# ─────────────────────────────────────────────────────────── per-invoice accounting breakdown


def effective_tax_split(inv: Dict[str, Any]) -> Dict[str, Any]:
    """CGST / SGST / IGST / Cess for an invoice, even for older rows that only stored `total_gst`."""
    cg, sg, ig, ce = (_f(inv.get(k)) for k in ("cgst_amount", "sgst_amount", "igst_amount", "cess_amount"))
    total_gst = _f(inv.get("total_gst"))
    inferred = False
    if cg + sg + ig + ce <= 0.004 and total_gst > 0:
        inferred = True
        ss, bs = _s(inv.get("supplier_gstin"))[:2], _s(inv.get("buyer_gstin"))[:2]
        if ss.isdigit() and bs.isdigit() and ss != bs:
            ig = total_gst
        else:
            cg = round(total_gst / 2, 2)
            sg = round(total_gst - cg, 2)
    elif abs(cg + sg + ig + ce - total_gst) > 0.05 and total_gst > 0 and (cg + sg + ig + ce) > 0:
        # components disagree with the total: trust the components for accounting (they are what the bill printed)
        total_gst = round(cg + sg + ig + ce, 2)
    return {"cgst": cg, "sgst": sg, "igst": ig, "cess": ce, "total_gst": round(cg + sg + ig + ce, 2) or total_gst, "inferred": inferred}


def voucher_breakdown(inv: Dict[str, Any]) -> Dict[str, Any]:
    """Debit/credit figures that always balance: purchase = total − GST − round-off."""
    total = _f(inv.get("grand_total"))
    tax = effective_tax_split(inv)
    ro = _f(inv.get("round_off"))
    if abs(ro) > 1.0:
        ro = 0.0
    purchase = round(total - tax["total_gst"] - ro, 2)
    taxable = _f(inv.get("taxable_amount"))
    notes: List[str] = []
    if taxable > 0 and abs(purchase - taxable) > 1.0:
        notes.append(f"Taxable value {taxable:,.2f} does not add up with GST and total; purchase ledger posted as {purchase:,.2f}.")
    if tax["inferred"]:
        notes.append("CGST/SGST/IGST split was not stored on this bill; it was derived from the GSTINs.")
    return {"total": total, "purchase": purchase, "round_off": ro, **tax, "notes": notes}


def _issues_for(inv: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    label = f"{_s(inv.get('supplier_name')) or 'Unknown supplier'} / {_s(inv.get('invoice_no')) or 'no invoice no.'}"
    if not _s(inv.get("supplier_name")):
        out.append(f"{label}: supplier name missing - Tally needs a party ledger name.")
    if not _s(inv.get("invoice_no")):
        out.append(f"{label}: invoice number missing.")
    if not re.match(r"\d{4}-\d{2}-\d{2}", _s(inv.get("invoice_date"))):
        out.append(f"{label}: invoice date missing or not understood.")
    if _f(inv.get("grand_total")) <= 0:
        out.append(f"{label}: invoice total is zero.")
    if _s(inv.get("status")) == "cancelled":
        out.append(f"{label}: bill is cancelled.")
    out.extend(f"{label}: {n}" for n in voucher_breakdown(inv)["notes"])
    return out


# ─────────────────────────────────────────────────────────── Tally XML


def _sub(parent: ET.Element, tag: str, text: Optional[str] = None, **attrs: str) -> ET.Element:
    el = ET.SubElement(parent, tag, attrs)
    if text is not None:
        el.text = text
    return el


def _ledger_entry(voucher: ET.Element, name: str, amount: float, *, party: bool = False, bill_ref: str = "",
                  bill_alloc: bool = False) -> None:
    """amount is the Tally-signed figure: negative = debit, positive = credit."""
    le = _sub(voucher, "LEDGERENTRIES.LIST")
    _sub(le, "LEDGERNAME", xml_text(name))
    _sub(le, "ISDEEMEDPOSITIVE", "Yes" if amount < 0 else "No")
    if party:
        _sub(le, "ISPARTYLEDGER", "Yes")
    _sub(le, "AMOUNT", _amt(amount))
    if party and bill_alloc and bill_ref:
        ba = _sub(le, "BILLALLOCATIONS.LIST")
        _sub(ba, "NAME", xml_text(bill_ref))
        _sub(ba, "BILLTYPE", "New Ref")
        _sub(ba, "AMOUNT", _amt(amount))


def _tax_ledger_name(base: str, tax: float, taxable: float, parts: int, rate_wise: bool) -> str:
    if not rate_wise:
        return base
    r = _std_rate(tax, taxable, parts)
    if not r:
        return base
    r = r / parts            # CGST / SGST ledgers are named by their own rate (9%), IGST by the full rate (18%)
    return f"{base} {r:g}%"


def voucher_lines(inv: Dict[str, Any], opts: Dict[str, Any]) -> List[Tuple[str, float, str]]:
    """[(ledger_name, tally_signed_amount, role)] — the Dr/Cr lines of the voucher. Sum is always 0.00."""
    bd = voucher_breakdown(inv)
    party = xml_text(inv.get("supplier_name")) or "Unknown Supplier"
    purchase_ledger = opts["purchase_ledger"]
    if opts.get("purchase_ledger_mode") == "per_invoice" and _s(inv.get("expense_ledger_name")):
        purchase_ledger = xml_text(inv.get("expense_ledger_name"))
    rw = bool(opts.get("rate_wise_ledgers"))
    taxable = bd["purchase"]
    lines: List[Tuple[str, float, str]] = [(party, bd["total"], "party")]
    if bd["purchase"] != 0:
        lines.append((purchase_ledger, -bd["purchase"], "purchase"))
    for key, led_key, parts, role in (("cgst", "cgst_ledger", 2, "cgst"), ("sgst", "sgst_ledger", 2, "sgst"),
                                      ("igst", "igst_ledger", 1, "igst"), ("cess", "cess_ledger", 1, "cess")):
        if bd[key] > 0:
            lines.append((_tax_ledger_name(opts[led_key], bd[key], taxable, parts, rw and key != "cess"), -bd[key], role))
    if bd["round_off"] != 0:
        # round_off > 0 : the bill total is higher than taxable+GST  -> extra cost  -> Dr
        # round_off < 0 : the bill total is lower                    -> gain        -> Cr
        lines.append((opts["round_off_ledger"], -bd["round_off"], "round_off"))
    return lines


def _ledger_master(parent_el: ET.Element, name: str, parent_group: str, **extra: str) -> None:
    msg = _sub(parent_el, "TALLYMESSAGE", **{"xmlns:UDF": "TallyUDF"})
    led = _sub(msg, "LEDGER", NAME=xml_text(name), ACTION="Create")
    names = _sub(led, "LANGUAGENAME.LIST")
    _sub(_sub(names, "NAME.LIST", TYPE="String"), "NAME", xml_text(name))
    _sub(names, "LANGUAGEID", "1033")
    _sub(led, "PARENT", parent_group)
    for k, v in extra.items():
        if v != "":
            _sub(led, k.upper(), v)


def build_tally_xml(invoices: List[Dict[str, Any]], options: Optional[Dict[str, Any]] = None,
                    part: str = "all") -> Dict[str, Any]:
    """
    part = "all"      ledger masters (if opts.create_masters) + vouchers in one file
           "masters"  only the ledger masters  (import this first, then the vouchers)
           "vouchers" only the vouchers
    Returns {"xml", "voucher_count", "skipped", "warnings", "total", "masters"}.
    """
    opts = {**DEFAULT_TALLY_OPTIONS, **{k: v for k, v in (options or {}).items() if v is not None}}
    skipped: List[Dict[str, str]] = []
    warnings: List[str] = []
    usable: List[Dict[str, Any]] = []
    for inv in invoices:
        label = f"{_s(inv.get('supplier_name')) or '?'} / {_s(inv.get('invoice_no')) or '?'}"
        if _s(inv.get("status")) == "cancelled":
            skipped.append({"invoice": label, "reason": "cancelled"})
            continue
        if _f(inv.get("grand_total")) <= 0 or not _s(inv.get("supplier_name")):
            skipped.append({"invoice": label, "reason": "missing supplier name or total"})
            continue
        usable.append(inv)
        warnings.extend(n for n in voucher_breakdown(inv)["notes"])

    env = ET.Element("ENVELOPE")
    hdr = _sub(env, "HEADER")
    _sub(hdr, "TALLYREQUEST", "Import Data")
    body = _sub(env, "BODY")
    imp = _sub(body, "IMPORTDATA")
    rd = _sub(imp, "REQUESTDESC")
    _sub(rd, "REPORTNAME", "All Masters" if part == "masters" else "Vouchers")
    if _s(opts.get("tally_company")):
        sv = _sub(rd, "STATICVARIABLES")
        _sub(sv, "SVCURRENTCOMPANY", xml_text(opts["tally_company"]))
    data = _sub(imp, "REQUESTDATA")

    masters = 0
    want_masters = part == "masters" or (part == "all" and opts.get("create_masters"))
    if want_masters and usable:
        seen: "OrderedDict[str, None]" = OrderedDict()
        # tax + purchase + round-off ledgers actually used
        for inv in usable:
            for name, _amount, role in voucher_lines(inv, opts):
                if role == "party":
                    continue
                if name in seen:
                    continue
                seen[name] = None
                if role == "purchase":
                    _ledger_master(data, name, "Purchase Accounts")
                elif role in ("cgst", "sgst", "igst", "cess"):
                    duty = {"cgst": "Central Tax", "sgst": "State Tax", "igst": "Integrated Tax", "cess": "Cess"}[role]
                    _ledger_master(data, name, "Duties & Taxes", TAXTYPE="GST", GSTDUTYHEAD=duty)
                else:
                    _ledger_master(data, name, "Indirect Expenses")
                masters += 1
        parties: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        for inv in usable:
            nm = xml_text(inv.get("supplier_name"))
            if nm and nm not in parties:
                parties[nm] = inv
        for nm, inv in parties.items():
            g = _s(inv.get("supplier_gstin")).upper()
            is_gstin = bool(re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", g))
            _ledger_master(
                data, nm, opts["party_group"],
                GSTREGISTRATIONTYPE="Regular" if is_gstin else "Unregistered",
                PARTYGSTIN=g if is_gstin else "", LEDSTATENAME=state_name(g) if is_gstin else "",
                COUNTRYOFRESIDENCE="India" if is_gstin or not g else "",
                ISBILLWISEON="Yes" if opts.get("bill_allocations") else "No",
            )
            masters += 1

    grand = 0.0
    for inv in (usable if part != "masters" else []):
        msg = _sub(data, "TALLYMESSAGE", **{"xmlns:UDF": "TallyUDF"})
        v = _sub(msg, "VOUCHER", VCHTYPE=opts["voucher_type"], ACTION="Create", OBJVIEW="Accounting Voucher View")
        d = tally_date(inv.get("invoice_date"))
        inv_no = xml_text(inv.get("invoice_no"))
        party = xml_text(inv.get("supplier_name"))
        sg, bg = _s(inv.get("supplier_gstin")).upper(), _s(inv.get("buyer_gstin")).upper()
        _sub(v, "DATE", d)
        _sub(v, "EFFECTIVEDATE", d)
        _sub(v, "VOUCHERTYPENAME", opts["voucher_type"])
        if opts.get("voucher_number_mode") != "auto" and inv_no:
            _sub(v, "VOUCHERNUMBER", inv_no)
        if inv_no:
            _sub(v, "REFERENCE", inv_no)
            _sub(v, "REFERENCEDATE", d)
        _sub(v, "PARTYLEDGERNAME", party)
        _sub(v, "PARTYNAME", party)
        if re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", sg):
            _sub(v, "GSTREGISTRATIONTYPE", "Regular")
            _sub(v, "PARTYGSTIN", sg)
            if state_name(sg):
                _sub(v, "STATENAME", state_name(sg))
        else:
            _sub(v, "GSTREGISTRATIONTYPE", "Unregistered")
        pos = state_name(bg) or state_name(sg)
        if pos:
            _sub(v, "PLACEOFSUPPLY", pos)
        _sub(v, "COUNTRYOFRESIDENCE", "India")
        narr = str(opts["narration"]).format(
            supplier=party, invoice_no=inv_no, date=_fmt_date(inv.get("invoice_date")),
            company=xml_text(inv.get("company_name")), total=_amt(_f(inv.get("grand_total"))))
        _sub(v, "NARRATION", xml_text(narr))
        _sub(v, "PERSISTEDVIEW", "Accounting Voucher View")
        _sub(v, "ISINVOICE", "No")
        lines = voucher_lines(inv, opts)
        for name, amount, role in lines:
            _ledger_entry(v, name, amount, party=(role == "party"), bill_ref=inv_no,
                          bill_alloc=bool(opts.get("bill_allocations")))
        grand += _f(inv.get("grand_total"))

    ET.indent(env, space="  ")
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(env, encoding="unicode")
    return {"xml": xml, "voucher_count": len(usable), "skipped": skipped, "warnings": warnings,
            "total": round(grand, 2), "masters": masters}


# ─────────────────────────────────────────────────────────── Register rows (Excel / CSV)

REGISTER_COLUMNS: List[Tuple[str, str, float, str]] = [
    # (header, key, width, kind)  kind: text | date | money | int
    ("#", "_n", 5, "int"),
    ("Invoice Date", "invoice_date", 12, "date"),
    ("Invoice No.", "invoice_no", 20, "text"),
    ("Supplier", "supplier_name", 32, "text"),
    ("Supplier GSTIN", "supplier_gstin", 18, "text"),
    ("Buyer / Company", "company_name", 28, "text"),
    ("Buyer GSTIN", "buyer_gstin", 18, "text"),
    ("Place of Supply", "_pos", 16, "text"),
    ("Taxable Value", "taxable_amount", 14, "money"),
    ("CGST", "_cgst", 12, "money"),
    ("SGST", "_sgst", 12, "money"),
    ("IGST", "_igst", 12, "money"),
    ("Cess", "_cess", 10, "money"),
    ("Total GST", "_gst", 12, "money"),
    ("Round Off", "_round_off", 10, "money"),
    ("Invoice Total", "grand_total", 14, "money"),
    ("Paid", "amount_paid", 12, "money"),
    ("Balance Due", "amount_due", 14, "money"),
    ("Status", "status", 14, "text"),
    ("Expense Ledger", "expense_ledger_name", 22, "text"),
    ("Document", "_doctype", 14, "text"),
    ("Source", "_source", 12, "text"),
    ("Read Confidence %", "_conf", 10, "int"),
    ("Exported to Tally", "_tally", 18, "text"),
    ("Added On", "_added", 12, "date"),
    ("File", "file_name", 28, "text"),
]


def _row_values(n: int, inv: Dict[str, Any]) -> Dict[str, Any]:
    bd = voucher_breakdown(inv)
    src = _s(inv.get("source")) or ("manual" if not _s(inv.get("file_name")) else "upload")
    exported = _s(inv.get("tally_exported_at"))
    return {
        **inv, "_n": n, "_cgst": bd["cgst"], "_sgst": bd["sgst"], "_igst": bd["igst"], "_cess": bd["cess"],
        "_gst": bd["total_gst"], "_round_off": bd["round_off"],
        "_pos": state_name(_s(inv.get("buyer_gstin")) or _s(inv.get("supplier_gstin"))) or _s(inv.get("place_of_supply")),
        "_doctype": _s(inv.get("document_type")).replace("_", " ").title() or "Tax Invoice",
        "_source": {"gstr2b": "GSTR-2B"}.get(src, src.title()),
        "_conf": int(round(float(inv.get("parse_confidence") or 0) * 100)),
        "_tally": ("Yes - " + _fmt_date(exported[:10])) if exported else "No",
        "_added": _s(inv.get("created_at"))[:10],
    }


def _cell_value(row: Dict[str, Any], key: str, kind: str) -> Any:
    v = row.get(key)
    if kind == "money":
        return _f(v)
    if kind == "int":
        try:
            return int(v or 0)
        except (TypeError, ValueError):
            return 0
    if kind == "date":
        s = _s(v)[:10]
        try:
            return datetime.strptime(s, "%Y-%m-%d").date()
        except ValueError:
            return s
    return _s(v)


def build_register_csv(invoices: List[Dict[str, Any]]) -> bytes:
    buf = StringIO()
    w = csv.writer(buf)
    w.writerow([h for h, *_ in REGISTER_COLUMNS])
    for i, inv in enumerate(invoices, 1):
        row = _row_values(i, inv)
        out = []
        for _h, key, _w, kind in REGISTER_COLUMNS:
            val = _cell_value(row, key, kind)
            if isinstance(val, date):
                val = val.strftime("%d-%m-%Y")
            elif isinstance(val, float):
                val = f"{val:.2f}"
            out.append(val)
        w.writerow(out)
    return ("﻿" + buf.getvalue()).encode("utf-8")      # BOM so Excel opens it as UTF-8


def build_register_xlsx(invoices: List[Dict[str, Any]], meta: Optional[Dict[str, Any]] = None,
                        tally_options: Optional[Dict[str, Any]] = None) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    meta = meta or {}
    opts = {**DEFAULT_TALLY_OPTIONS, **(tally_options or {})}
    wb = Workbook()
    head_fill = PatternFill("solid", fgColor="1F3A5F")
    head_font = Font(bold=True, color="FFFFFF")
    thin = Side(style="thin", color="D0D5DD")
    box = Border(left=thin, right=thin, top=thin, bottom=thin)
    money_fmt = '#,##0.00;[Red]-#,##0.00'
    date_fmt = "DD-MMM-YYYY"

    # ── Sheet 1: Purchase Register ───────────────────────────────────────────
    ws = wb.active
    ws.title = "Purchase Register"
    title = meta.get("title") or "Purchase Register"
    ws["A1"] = title
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = meta.get("subtitle") or ""
    ws["A2"].font = Font(italic=True, color="555555")
    ws["A3"] = f"Generated {datetime.now().strftime('%d-%b-%Y %H:%M')}  ·  {len(invoices)} bill(s)"
    ws["A3"].font = Font(color="555555")
    hr = 5
    for c, (h, _k, width, _kind) in enumerate(REGISTER_COLUMNS, 1):
        cell = ws.cell(row=hr, column=c, value=h)
        cell.fill, cell.font, cell.border = head_fill, head_font, box
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(c)].width = width
    ws.row_dimensions[hr].height = 30
    money_cols = [c for c, (_h, _k, _w, kind) in enumerate(REGISTER_COLUMNS, 1) if kind == "money"]
    for i, inv in enumerate(invoices, 1):
        row = _row_values(i, inv)
        for c, (_h, key, _w, kind) in enumerate(REGISTER_COLUMNS, 1):
            cell = ws.cell(row=hr + i, column=c, value=_cell_value(row, key, kind))
            cell.border = box
            if kind == "money":
                cell.number_format = money_fmt
            elif kind == "date":
                cell.number_format = date_fmt
    last = hr + len(invoices)
    if invoices:
        tr = last + 1
        ws.cell(row=tr, column=4, value="TOTAL").font = Font(bold=True)
        for c in money_cols:
            L = get_column_letter(c)
            cell = ws.cell(row=tr, column=c, value=f"=SUBTOTAL(109,{L}{hr + 1}:{L}{last})")
            cell.font, cell.number_format, cell.border = Font(bold=True), money_fmt, box
        ws.auto_filter.ref = f"A{hr}:{get_column_letter(len(REGISTER_COLUMNS))}{last}"
    ws.freeze_panes = ws.cell(row=hr + 1, column=5)

    # ── Sheet 2: Tally Vouchers (flat Dr/Cr lines) ───────────────────────────
    wt = wb.create_sheet("Tally Vouchers")
    th = ["Date", "Voucher Type", "Voucher No.", "Supplier Ref. No.", "Ledger Name", "Debit", "Credit",
          "Party GSTIN", "Place of Supply", "Narration"]
    for c, h in enumerate(th, 1):
        cell = wt.cell(row=1, column=c, value=h)
        cell.fill, cell.font, cell.border = head_fill, head_font, box
        cell.alignment = Alignment(horizontal="center")
    for c, w in enumerate([12, 14, 20, 20, 34, 14, 14, 18, 16, 60], 1):
        wt.column_dimensions[get_column_letter(c)].width = w
    r = 2
    for inv in invoices:
        if _s(inv.get("status")) == "cancelled" or _f(inv.get("grand_total")) <= 0:
            continue
        d = _s(inv.get("invoice_date"))[:10]
        try:
            dval: Any = datetime.strptime(d, "%Y-%m-%d").date()
        except ValueError:
            dval = d
        narr = str(opts["narration"]).format(
            supplier=_s(inv.get("supplier_name")), invoice_no=_s(inv.get("invoice_no")), date=_fmt_date(d),
            company=_s(inv.get("company_name")), total=_amt(_f(inv.get("grand_total"))))
        for name, amount, role in voucher_lines(inv, opts):
            vals = [dval, opts["voucher_type"], _s(inv.get("invoice_no")), _s(inv.get("invoice_no")), name,
                    round(-amount, 2) if amount < 0 else None, round(amount, 2) if amount > 0 else None,
                    _s(inv.get("supplier_gstin")) if role == "party" else "",
                    state_name(_s(inv.get("buyer_gstin")) or _s(inv.get("supplier_gstin"))) if role == "party" else "",
                    narr if role == "party" else ""]
            for c, v in enumerate(vals, 1):
                cell = wt.cell(row=r, column=c, value=v)
                cell.border = box
                if c == 1:
                    cell.number_format = date_fmt
                if c in (6, 7):
                    cell.number_format = money_fmt
            r += 1
    wt.freeze_panes = "A2"
    if r > 2:
        wt.cell(row=r, column=5, value="TOTAL").font = Font(bold=True)
        for c in (6, 7):
            L = get_column_letter(c)
            cell = wt.cell(row=r, column=c, value=f"=SUM({L}2:{L}{r - 1})")
            cell.font, cell.number_format = Font(bold=True), money_fmt

    # ── Sheet 3: Summary ─────────────────────────────────────────────────────
    sm = wb.create_sheet("Summary")
    by_month: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    by_sup: Dict[Tuple[str, str], Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for inv in invoices:
        if _s(inv.get("status")) == "cancelled":
            continue
        bd = voucher_breakdown(inv)
        mk = _s(inv.get("invoice_date"))[:7] or "Unknown"
        for tgt in (by_month[mk], by_sup[(_s(inv.get("supplier_name")) or "Unknown", _s(inv.get("supplier_gstin")))]):
            tgt["count"] += 1
            tgt["taxable"] += bd["purchase"]
            tgt["cgst"] += bd["cgst"]; tgt["sgst"] += bd["sgst"]; tgt["igst"] += bd["igst"]; tgt["cess"] += bd["cess"]
            tgt["gst"] += bd["total_gst"]; tgt["total"] += bd["total"]
            tgt["paid"] += _f(inv.get("amount_paid")); tgt["due"] += _f(inv.get("amount_due"))

    def table(top: int, heading: str, first_cols: List[str], rows: List[Tuple[List[str], Dict[str, float]]]) -> int:
        sm.cell(row=top, column=1, value=heading).font = Font(bold=True, size=12)
        hdrs = first_cols + ["Bills", "Taxable", "CGST", "SGST", "IGST", "Cess", "Total GST", "Invoice Total", "Paid", "Due"]
        for c, h in enumerate(hdrs, 1):
            cell = sm.cell(row=top + 1, column=c, value=h)
            cell.fill, cell.font, cell.border = head_fill, head_font, box
        rr = top + 2
        tot: Dict[str, float] = defaultdict(float)
        for labels, v in rows:
            vals = labels + [int(v["count"]), v["taxable"], v["cgst"], v["sgst"], v["igst"], v["cess"], v["gst"], v["total"], v["paid"], v["due"]]
            for c, x in enumerate(vals, 1):
                cell = sm.cell(row=rr, column=c, value=round(x, 2) if isinstance(x, float) else x)
                cell.border = box
                if c > len(first_cols) + 1:
                    cell.number_format = money_fmt
            for k in v:
                tot[k] += v[k]
            rr += 1
        vals = ["TOTAL"] + [""] * (len(first_cols) - 1) + [int(tot["count"]), tot["taxable"], tot["cgst"], tot["sgst"], tot["igst"],
                                                           tot["cess"], tot["gst"], tot["total"], tot["paid"], tot["due"]]
        for c, x in enumerate(vals, 1):
            cell = sm.cell(row=rr, column=c, value=round(x, 2) if isinstance(x, float) else x)
            cell.font, cell.border = Font(bold=True), box
            if c > len(first_cols) + 1:
                cell.number_format = money_fmt
        return rr + 2

    nxt = table(1, "Month-wise", ["Month"], [([m], v) for m, v in sorted(by_month.items())])
    sup_rows = sorted(by_sup.items(), key=lambda kv: -kv[1]["total"])
    table(nxt, "Supplier-wise", ["Supplier", "GSTIN"], [([k[0], k[1]], v) for k, v in sup_rows])
    for c, w in enumerate([34, 18, 8, 14, 12, 12, 12, 10, 12, 14, 12, 12], 1):
        sm.column_dimensions[get_column_letter(c)].width = w

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ─────────────────────────────────────────────────────────── self-check used by tests


def check_tally_xml_balanced(xml: str) -> List[str]:
    """Parse generated XML and verify every voucher's amounts sum to zero. Returns a list of problems."""
    problems: List[str] = []
    root = ET.fromstring(xml.split("?>", 1)[1] if xml.startswith("<?xml") else xml)
    for v in root.iter("VOUCHER"):
        tot = round(sum(float(a.text) for a in v.findall("./LEDGERENTRIES.LIST/AMOUNT")), 2)
        if abs(tot) > 0.005:
            problems.append(f"voucher {v.findtext('VOUCHERNUMBER') or v.findtext('REFERENCE')} out of balance by {tot}")
        for le in v.findall("./LEDGERENTRIES.LIST"):
            amt = float(le.findtext("AMOUNT"))
            dp = le.findtext("ISDEEMEDPOSITIVE")
            if (amt < 0) != (dp == "Yes"):
                problems.append(f"sign/ISDEEMEDPOSITIVE mismatch on {le.findtext('LEDGERNAME')}")
    return problems
