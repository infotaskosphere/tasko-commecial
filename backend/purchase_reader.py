"""
purchase_reader.py — accurate reading of vendor / purchase invoices.

Why this module exists
----------------------
The first version of the Purchase page read invoices with a handful of regexes
that took "the biggest number near a label" and "the first GSTIN in the file".
On real Indian invoices that goes wrong in predictable ways:

  * the buyer's GSTIN is printed before the supplier's → roles swapped
  * the HSN code, receipt number, phone number or IRN is picked up as the amount
  * "--- Page 1 ---" (our own page marker) ends up as the supplier name
  * the advance-adjusted balance / late-payment amount is taken as the total
  * a two-page invoice has its totals on page 2 and the parties on page 1

This module replaces that with a reconciliation-driven reader:

  1. TEXT LAYER   pdfplumber text → deterministic parser.
  2. OCR          scanned PDFs / images → local Tesseract when installed.
  3. AI VISION    Gemini / Groq (already configured for the AI Document Reader),
                  used only when the deterministic result cannot be proven.
  4. VALIDATION   every result is checked: taxable + GST + round-off must equal
                  the grand total, the grand total must match the amount in
                  words, GSTINs must pass the GST check-digit, supplier ≠ buyer…
                  Anything that fails is returned as a warning so the UI can
                  show an *editable preview* instead of silently saving wrong data.

Nothing in here touches the database; the caller passes in the list of known
parties (master companies + clients) and decides what to persist.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import shutil
import subprocess
import tempfile
from bisect import bisect_left, bisect_right
from datetime import date, datetime
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ═════════════════════════════════════════════════════════════════════════════
# Small helpers
# ═════════════════════════════════════════════════════════════════════════════

STANDARD_GST_RATES = (0.0, 0.1, 0.25, 1.5, 3.0, 5.0, 12.0, 18.0, 28.0)

_GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
GSTIN_RE = re.compile(r"(?<![A-Z0-9])\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z](?![A-Z0-9])")
# Foreign OIDAR suppliers (Anthropic, Google, Microsoft…) get "99xx<CCC>nnnnn<xxx>"
OIDAR_RE = re.compile(r"(?<![A-Z0-9])99\d{2}[A-Z]{3}\d{5}[A-Z]{3}(?![A-Z0-9])")
PAN_RE = re.compile(r"(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])")
_TOKEN15_RE = re.compile(r"(?<![A-Z0-9])[A-Z0-9]{15}(?![A-Z0-9])")

_TO_DIGIT = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "S": "5", "B": "8", "Z": "2", "G": "6", "T": "7"}
_TO_LETTER = {"0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G"}


def gstin_check_digit(first14: str) -> str:
    factor, total = 2, 0
    for ch in reversed(first14):
        cp = _GSTIN_CHARS.index(ch)
        d = factor * cp
        factor = 1 if factor == 2 else 2
        total += (d // 36) + (d % 36)
    return _GSTIN_CHARS[(36 - (total % 36)) % 36]


def gstin_is_valid(g: str) -> bool:
    """Format + official check-digit. Detects most OCR / typing errors."""
    g = (g or "").strip().upper()
    if not GSTIN_RE.fullmatch(g):
        return False
    try:
        return gstin_check_digit(g[:14]) == g[14]
    except ValueError:
        return False


def is_oidar_id(g: str) -> bool:
    return bool(OIDAR_RE.fullmatch((g or "").strip().upper()))


def repair_gstin(token: str) -> Optional[str]:
    """Try to repair an OCR-damaged 15-char GSTIN (O/0, I/1, S/5, B/8 …).
    Only returns a value whose check-digit is valid, so it can't invent one."""
    t = (token or "").strip().upper()
    if len(t) != 15 or not t.isalnum():
        return None
    # positions: 0-1 digit | 2-6 letter | 7-10 digit | 11 letter | 12 alnum | 13 'Z' | 14 alnum
    fixed = []
    for i, ch in enumerate(t):
        if i in (0, 1, 7, 8, 9, 10):
            fixed.append(ch if ch.isdigit() else _TO_DIGIT.get(ch, ch))
        elif i in (2, 3, 4, 5, 6, 11):
            fixed.append(ch if ch.isalpha() else _TO_LETTER.get(ch, ch))
        elif i == 13:
            fixed.append("Z")
        else:
            fixed.append(ch)
    cand = "".join(fixed)
    if gstin_is_valid(cand):
        return cand
    # last char may simply be the damaged check digit
    if GSTIN_RE.fullmatch(cand):
        try:
            repaired = cand[:14] + gstin_check_digit(cand[:14])
            if sum(1 for a, b in zip(repaired, t) if a != b) <= 2:
                return repaired
        except ValueError:
            pass
    return None


def to_num(value: Any, default: float = 0.0) -> float:
    """'1,23,456.50' / '₹ 2,033.05' / '-0.35' / 1200 → float."""
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    txt = str(value).strip()
    if not txt:
        return default
    neg = txt.startswith("-") or txt.startswith("−") or (txt.startswith("(") and txt.endswith(")"))
    txt = re.sub(r"[^\d.]", "", txt)
    if txt.count(".") > 1:
        head, _, tail = txt.rpartition(".")
        txt = head.replace(".", "") + "." + tail
    try:
        v = round(float(txt), 2)
        return -v if neg else v
    except ValueError:
        return default


def norm_name(s: str) -> str:
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"\b(?:m\s*/\s*s|messrs)\b\.?", " ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    stop = {"pvt", "private", "ltd", "limited", "llp", "inc", "co", "company", "the", "and", "p", "opc", "corp", "corporation"}
    toks = [t for t in s.split() if t not in stop and len(t) > 1]
    return " ".join(toks)


def name_similarity(a: str, b: str) -> float:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    jacc = inter / len(ta | tb)
    if ta <= tb or tb <= ta:
        jacc = max(jacc, 0.88)
    return round(jacc, 2)


def _clean_spaced_letters(text: str) -> str:
    """'S u b t o t a l' → 'Subtotal', 'T O T A L' → 'TOTAL' (letter-spaced print)."""
    def fix(m: "re.Match") -> str:
        return m.group(0).replace(" ", "")
    return re.sub(r"(?<![A-Za-z])(?:[A-Za-z] ){3,}[A-Za-z](?![A-Za-z])", fix, text)


def clean_text(text: str) -> str:
    t = (text or "").replace(" ", " ").replace("‑", "-").replace("–", "-").replace("—", "-")
    t = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", t)       # pdfplumber emits NUL for some word gaps
    t = re.sub(r"(?m)^\s*-{2,}\s*Page\s*\d+\s*-{2,}\s*$", "", t)
    t = t.replace("\r", "")
    t = re.sub(r"\(\s*(?:₹|`|Rs\.?|INR)\s*\)", " ", t)       # "Total (₹)" → "Total"
    t = _clean_spaced_letters(t)
    return t


# ═════════════════════════════════════════════════════════════════════════════
# Dates
# ═════════════════════════════════════════════════════════════════════════════

_MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}

_DATE_PATTERNS = [
    # 27/09/2026 · 27-09-26 · 27.09.2026
    ("dmy", re.compile(r"(?<![\d/.\-])(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})(?![\d/])")),
    # 27-Sep-2026 · 27-Sep-26 (2-digit year only with - or /) · 27 Sep 2026 (4-digit year with spaces)
    ("dMy", re.compile(r"(?<![\d])(\d{1,2})(?:[\-/.]|\s+)([A-Za-z]{3,9})\.?(?:[\-/.,]|\s+)(\d{4})(?!\d)")),
    ("dMy2", re.compile(r"(?<![\d])(\d{1,2})[\-/]([A-Za-z]{3,9})\.?[\-/](\d{2})(?!\d)")),
    # October 16, 2026 · Oct 16 2026
    ("Mdy", re.compile(r"(?<![A-Za-z])([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)")),
    # 2026-10-16
    ("ymd", re.compile(r"(?<![\d])(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?![\d])")),
]


def _mk_date(y: int, m: int, d: int) -> Optional[date]:
    if y < 100:
        y += 2000
    try:
        dt = date(y, m, d)
    except ValueError:
        return None
    return dt if 2000 <= dt.year <= 2100 else None


def find_dates(line: str) -> List[Tuple[int, int, date]]:
    """All dates in a line as (start, end, date)."""
    out: List[Tuple[int, int, date]] = []
    taken: List[Tuple[int, int]] = []
    for kind, rx in _DATE_PATTERNS:
        for m in rx.finditer(line):
            s, e = m.span()
            if any(not (e <= ts or s >= te) for ts, te in taken):
                continue
            dt: Optional[date] = None
            g = m.groups()
            try:
                if kind == "dmy":
                    d, mo, y = int(g[0]), int(g[1]), int(g[2])
                    if mo > 12 >= d:
                        d, mo = mo, d
                    dt = _mk_date(y, mo, d)
                elif kind in ("dMy", "dMy2"):
                    mo = _MONTHS.get(g[1][:3].lower())
                    if mo:
                        dt = _mk_date(int(g[2]), mo, int(g[0]))
                elif kind == "Mdy":
                    mo = _MONTHS.get(g[0][:3].lower())
                    if mo:
                        dt = _mk_date(int(g[2]), mo, int(g[1]))
                elif kind == "ymd":
                    dt = _mk_date(int(g[0]), int(g[1]), int(g[2]))
            except ValueError:
                dt = None
            if dt:
                out.append((s, e, dt))
                taken.append((s, e))
    out.sort()
    return out


def normalise_date(value: Any) -> str:
    """Anything date-like → YYYY-MM-DD ('' when it can't be understood)."""
    if not value:
        return ""
    s = str(value).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s
    hits = find_dates(s)
    return hits[0][2].isoformat() if hits else ""


# ═════════════════════════════════════════════════════════════════════════════
# Numbers: tokens, amount-in-words
# ═════════════════════════════════════════════════════════════════════════════

_NUM_RE = re.compile(
    r"(?<![\w.,/@\-])(?P<sign>[-−–]?)\s?(?:₹|Rs\.?|INR|`)?\s?"
    r"(?P<num>\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)"
    r"(?P<pct>\s?%)?(?![\w])"
)


def _blank_dates(line: str) -> str:
    """Replace every date in the line with spaces so day/month digits aren't read as money."""
    chars = list(line)
    for s, e, _ in find_dates(line):
        for i in range(s, e):
            chars[i] = " "
    return "".join(chars)


def money_tokens(line: str, allow_int: bool = False) -> List[Tuple[float, int, int, bool]]:
    """(value, start, end, is_decimal) for every money-looking number on a line,
    skipping percentages, dates, GSTIN/PAN/IRN fragments and (unless asked) plain integers."""
    work = _blank_dates(line)
    work = GSTIN_RE.sub(lambda m: " " * len(m.group(0)), work.upper()) if False else work
    res: List[Tuple[float, int, int, bool]] = []
    for m in _NUM_RE.finditer(work):
        if m.group("pct"):
            continue
        raw = m.group("num")
        is_dec = "." in raw or "," in raw
        if not is_dec and not allow_int:
            continue
        v = to_num(raw)
        if m.group("sign"):
            v = -v
        res.append((v, m.start(), m.end(), is_dec))
    return res


_ONES = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
_SCALES = {"hundred": 100, "thousand": 1000, "lakh": 100000, "lakhs": 100000, "lac": 100000, "lacs": 100000,
           "crore": 10000000, "crores": 10000000}


def words_to_number(words: str) -> Optional[float]:
    """'Eight Lakh Seventy Nine Thousand Three Hundred Twenty' → 879320.
    Understands 'X Rupees and Y Paise'. Returns None when it isn't a number in words."""
    w = (words or "").lower()
    w = re.sub(r"[^a-z ]", " ", w)
    w = re.sub(r"\b(?:only|rupees?|rs|inr|indian)\b", lambda m: " rupees " if m.group(0).startswith(("rupee", "rs", "inr")) else " ", w)

    def parse(chunk: str) -> Optional[int]:
        total, current, seen = 0, 0, False
        for tok in chunk.split():
            if tok == "and":
                continue
            if tok in _ONES:
                current += _ONES[tok]; seen = True
            elif tok in _TENS:
                current += _TENS[tok]; seen = True
            elif tok == "hundred":
                current = max(current, 1) * 100; seen = True
            elif tok in _SCALES:
                total += max(current, 1) * _SCALES[tok]; current = 0; seen = True
            else:
                return None
        return total + current if seen else None

    rupees_txt, paise_txt = w, ""
    if "paise" in w or "paisa" in w:
        head, _, tail = re.split(r"\brupees\b", w, maxsplit=1) + [""] if "rupees" in w else (w, "", "")
        # fall back to splitting on the word 'and' before paise
        m = re.match(r"(.*?)(?:\band\b)?\s*([a-z ]*?)\s*(?:paise|paisa)", tail or w)
        rupees_txt = head if "rupees" in w else ""
        paise_txt = m.group(2) if m else ""
    else:
        rupees_txt = w.replace("rupees", " ")
    r = parse(rupees_txt.replace("rupees", " ")) if rupees_txt.strip() else 0
    if r is None:
        return None
    p = parse(paise_txt) if paise_txt.strip() else 0
    if p is None:
        p = 0
    if r == 0 and p == 0:
        return None
    return float(r) + p / 100.0


_WORDS_LINE_RE = re.compile(
    r"(?i)(?:rupees|rs\.?|in\s*words|amount\s*in\s*words|total\s*(?:in\s*)?words)\s*(?:\(in words\))?\s*[:.\-]*\s*"
    r"((?:[A-Za-z\-,&]+\s+){1,18}?[A-Za-z\-]+)\s*(?:only|/-)"
)


def find_amount_in_words(text: str) -> Optional[float]:
    best = None
    for m in _WORDS_LINE_RE.finditer(text):
        v = words_to_number(m.group(1))
        if v and v >= 1:
            best = v if best is None else max(best, v)
    return best


# ═════════════════════════════════════════════════════════════════════════════
# Label tables for amounts
# ═════════════════════════════════════════════════════════════════════════════

# (key, regex, priority)  — higher priority = more trustworthy
_G_LABELS = [
    ("grand", r"grand\s*total", 10),
    ("inv_total", r"(?:total\s+invoice\s+(?:value|amount)|invoice\s+(?:total|value|amount))", 9),
    ("net_amount", r"net\s*(?:amount|payable|value)", 9),
    ("payable", r"(?:total\s+)?(?:amount|amt)\s+payable|payable\s+amount|amount\s+due(?!\s+after)", 8),
    ("total_rs", r"total\s*(?:rs\.?|inr|₹|rupees)(?![a-z])", 8),
    ("total_amount", r"total\s+(?:amount|amt)", 7),
    ("bill_amount", r"(?:bill|invoice)\s+amount", 7),
    ("amount_paid", r"amount\s+paid", 5),
    ("net_amt_col", r"net\s*amt", 4),
    ("total", r"(?<![a-z])total(?![a-z])", 3),
]
_T_LABELS = [
    ("taxable", r"taxable\s*(?:amt|amount|value|val)?", 10),
    ("assessable", r"assessable\s+value", 9),
    ("before_tax", r"(?:total\s+)?(?:amount|value)\s+before\s+tax|total\s+before\s+tax", 9),
    ("goods", r"(?:goods|basic)\s+(?:value|amount)", 6),
    ("subtotal", r"sub\s*-?\s*total", 5),
]
_C_LABELS = [
    ("cgst", r"c\s*[-.]?\s*gst", 10),
    ("sgst", r"s\s*[-.]?\s*gst|utgst", 10),
    ("igst", r"i\s*[-.]?\s*gst", 10),
    ("cess", r"cess", 6),
]
_X_LABELS = [
    ("total_gst", r"total\s*(?:gst|tax(?:es)?)(?:\s*amount)?|tax\s*amount|gst\s*amount|total\s+taxes?|taxes", 8),
]
_R_LABELS = [
    ("round", r"round(?:ed)?\s*[-.]?\s*off|r\s*\.\s*off|rounding(?:\s+off)?|round(?=\s*[:\-]?\s*[-+]?\d)", 8),
]
_D_LABELS = [
    ("discount", r"discount|less\s*:", 5),
]
_A_LABELS = [
    ("advance", r"advance(?:\s+(?:payment|paid|received))?", 8),
]
_ALL_LABELS = _G_LABELS + _T_LABELS + _C_LABELS + _X_LABELS + _R_LABELS + _D_LABELS + _A_LABELS
_LABEL_COMPILED = [(k, re.compile(rx, re.I), p) for k, rx, p in _ALL_LABELS]
_G_KEYS = {k for k, _, _ in _G_LABELS}
_G_EXCLUDE = re.compile(
    r"(?i)\b(?:due\s+after|after\s+due|late|previous|balance|advance|arrear|outstanding|credit\s*limit|"
    r"security|deposit|in\s*words|gst|tax|cgst|sgst|igst|taxable|sub\s*-?\s*total|qty|quantity|discount|"
    r"pcs|nos|kgs?)\b")


def _line_labels(line: str) -> List[Tuple[int, int, str, int]]:
    """Non-overlapping label hits on a line as (start, end, key, priority), left→right."""
    hits: List[Tuple[int, int, str, int]] = []
    for key, rx, prio in _LABEL_COMPILED:
        for m in rx.finditer(line):
            hits.append((m.start(), m.end(), key, prio))
    hits.sort(key=lambda h: (h[0], -h[3], -(h[1] - h[0])))
    chosen: List[Tuple[int, int, str, int]] = []
    last_end = -1
    for h in hits:
        if h[0] >= last_end:
            chosen.append(h)
            last_end = h[1]
    return chosen


def scan_labelled_amounts(lines: List[str]) -> Dict[str, List[Tuple[float, int, int]]]:
    """key → [(value, priority, line_index)] for every labelled amount on every line."""
    out: Dict[str, List[Tuple[float, int, int]]] = {}
    for li, line in enumerate(lines):
        labels = _line_labels(line)
        for idx, (s, e, key, prio) in enumerate(labels):
            nxt = labels[idx + 1][0] if idx + 1 < len(labels) else len(line)
            seg = line[e:nxt]
            allow_int = key in ("advance", "discount", "grand", "net_amount", "total", "total_rs", "inv_total",
                                "payable", "total_amount", "round", "taxable")
            toks = money_tokens(_blank_dates(line)[e:nxt], allow_int=allow_int)
            if key in _G_KEYS:
                if _G_EXCLUDE.search(line[:s] + " " + seg) and key not in ("grand", "net_amount", "inv_total", "total_rs"):
                    continue
                if key in ("grand", "net_amount", "inv_total", "total_rs") and re.search(r"(?i)due\s+after|late|advance", line):
                    continue
            if not toks:
                continue
            # table rows put the figure last ("Total : 11.00 3449.00 4069.82"); single labels use first
            if key in _G_KEYS:
                val = toks[-1][0]
            elif key == "round":
                val = toks[0][0]
            else:
                val = toks[0][0]
            out.setdefault(key, []).append((val, prio, li))
    return out


def amount_pool(lines: List[str]) -> List[float]:
    """Every decimal/comma-grouped number in the document (candidate amounts)."""
    pool: List[float] = []
    for line in lines:
        if re.search(r"(?i)\birn\b|a/c\s*no|account\s*no|ifsc|mobile|phone|pin\s*code|e-?way|ack\s*no|hsn", line):
            # keep the money in these lines but drop long digit runs by only taking decimals
            pass
        for v, s, e, is_dec in money_tokens(line):
            if is_dec and abs(v) < 1e9:
                pool.append(v)
    return pool


# ═════════════════════════════════════════════════════════════════════════════
# Reconciliation: find (taxable, GST, round-off, total) that add up
# ═════════════════════════════════════════════════════════════════════════════

def _near(vals: List[float], target: float, tol: float) -> bool:
    return any(abs(v - target) <= tol for v in vals)


def reconcile_amounts(lab: Dict[str, List[Tuple[float, int, int]]], pool: List[float],
                      words_val: Optional[float]) -> Dict[str, Any]:
    """
    Pick the combination  taxable + GST + round-off = grand total  that is best
    supported by labels, the amount in words, a standard GST rate and CGST==SGST.
    This is what makes "the HSN code / phone number / balance after advance"
    impossible to mistake for the invoice total.
    """
    pos_pool = sorted({round(v, 2) for v in pool if v > 0})
    pool_set = set(pos_pool)

    g_cands: Dict[float, int] = {}
    for key in _G_KEYS:
        for v, prio, _ in lab.get(key, []):
            if v > 0:
                g_cands[round(v, 2)] = max(g_cands.get(round(v, 2), 0), prio)
    if words_val:
        for v in pos_pool:
            if abs(v - words_val) <= 0.51:
                g_cands[v] = max(g_cands.get(v, 0), 6)
    if not g_cands:
        for v in sorted(pos_pool, reverse=True)[:6]:
            g_cands[v] = 1

    t_label = {round(v, 2): p for k in ("taxable", "assessable", "before_tax", "goods", "subtotal")
               for v, p, _ in lab.get(k, []) if v > 0}
    x_label = {round(v, 2) for k in ("total_gst",) for v, _, _ in lab.get(k, []) if v > 0}
    comp_vals = {k: [round(v, 2) for v, _, _ in lab.get(k, []) if v > 0] for k in ("cgst", "sgst", "igst", "cess")}
    comp_sum_labels = set()
    cg, sg, ig, ce = (comp_vals["cgst"], comp_vals["sgst"], comp_vals["igst"], comp_vals["cess"])
    for a in (cg or [0.0]):
        for b in (sg or [0.0]):
            for c in (ig or [0.0]):
                for d in (ce or [0.0]):
                    s = round(a + b + c + d, 2)
                    if s > 0:
                        comp_sum_labels.add(s)
    tax_evidence = bool(x_label or comp_sum_labels)

    x_cands = set(pos_pool) | {round(2 * v, 2) for v in pos_pool} | x_label | comp_sum_labels
    x_sorted = sorted(x_cands)
    t_vals = sorted(set(pos_pool) | set(t_label))

    best: Optional[Dict[str, Any]] = None
    for g, gprio in g_cands.items():
        w_score = 0.0
        if words_val:
            w_score = 6.0 if abs(g - words_val) <= 0.005 else (2.0 if abs(g - words_val) <= 0.51 else -3.0)
        for t in t_vals:
            if t > g + 1.0:
                break
            d = g - t
            lo, hi = bisect_left(x_sorted, d - 1.0 - 1e-6), bisect_right(x_sorted, d + 1.0 + 1e-6)
            xs = list(x_sorted[lo:hi])
            if abs(d) <= 1.0:
                xs.append(0.0)
            for x in xs:
                r = round(g - t - x, 2)
                if abs(r) > 1.0 + 1e-6:
                    continue
                s = gprio * 0.5 + w_score
                if t in t_label:
                    s += t_label[t] * 0.4
                if x == 0.0:
                    s += -5.0 if tax_evidence else 1.0
                    if t == g and not tax_evidence:
                        s += 0.5
                else:
                    if x in x_label or x in comp_sum_labels:
                        s += 3.0
                    if _near(list(pool_set), round(x / 2, 2), 0.011):
                        s += 2.0
                    rate = x / t * 100 if t > 0 else 999
                    if any(abs(rate - sr) <= 0.15 for sr in STANDARD_GST_RATES):
                        s += 3.0
                    elif rate > 30:
                        s -= 4.0
                    else:
                        s += 0.3
                if abs(r) <= 0.005:
                    s += 2.0
                elif abs(r) <= 0.51:
                    s += 1.0
                if any(abs(abs(v) - abs(r)) <= 0.011 for v, _, _ in lab.get("round", [])):
                    s += 1.5
                if best is None or s > best["score"]:
                    best = {"taxable": t, "gst": round(x, 2), "round_off": r, "grand_total": g, "score": round(s, 2)}

    if best and best["score"] >= 5.0:
        best["reconciled"] = True
        return best

    # Could not prove anything — fall back to labels, flagged as unreconciled.
    g = max(g_cands.items(), key=lambda kv: (kv[1], kv[0]))[0] if g_cands else 0.0
    t = max(t_label.items(), key=lambda kv: (kv[1], kv[0]))[0] if t_label else 0.0
    x = max(comp_sum_labels or x_label or {0.0})
    return {"taxable": t, "gst": round(x, 2), "round_off": round(g - t - x, 2) if (g and t) else 0.0,
            "grand_total": g, "score": best["score"] if best else 0.0, "reconciled": False}


# ═════════════════════════════════════════════════════════════════════════════
# Parties: GSTIN roles, names
# ═════════════════════════════════════════════════════════════════════════════

_BUYER_CUE = re.compile(
    r"(?i)(?:bill(?:ed)?\s*to|\bbuyer|\bm\s*/\s*s\b|\breceiver|\brecipient\s*(?:name|details)|\bcustomer|sold\s*to|"
    r"invoice\s*to|\bparty\s*(?:name|details)|details?\s+of\s+receiver)")
_CONSIGNEE_CUE = re.compile(
    r"(?i)(?:consignee|ship(?:ped)?\s*to|deliver(?:y|ed)?\s*(?:at|to|address)|place\s+of\s+delivery|dispatch(?:ed)?\s*to)")
_SUPPLIER_CUE = re.compile(
    r"(?i)(?:\bsupplier(?!['’]s\s+ref)|\bseller\b|\bvendor\b|registered\s+office|gst\s*reg(?:istration)?|"
    r"vat\s*registration|gstin\s+of\s+supplier)")
_BANK_CUE = re.compile(r"(?i)(?:ifsc|a/c\s*no|bank\s*name|bank\s*details|branch|beneficiary)")


def _gstin_hits(text: str) -> List[Dict[str, Any]]:
    """All GSTIN-looking tokens with position; OCR-damaged ones are repaired when the check-digit proves it."""
    up = text.upper()
    hits: List[Dict[str, Any]] = []
    seen_spans: List[Tuple[int, int]] = []
    for m in GSTIN_RE.finditer(up):
        hits.append({"gstin": m.group(0), "start": m.start(), "end": m.end(), "kind": "gstin", "repaired": False})
        seen_spans.append(m.span())
    for m in OIDAR_RE.finditer(up):
        hits.append({"gstin": m.group(0), "start": m.start(), "end": m.end(), "kind": "oidar", "repaired": False})
        seen_spans.append(m.span())
    for m in _TOKEN15_RE.finditer(up):
        if any(not (m.end() <= s or m.start() >= e) for s, e in seen_spans):
            continue
        if not re.match(r"\d{2}", m.group(0)):
            continue
        fixed = repair_gstin(m.group(0))
        if fixed:
            hits.append({"gstin": fixed, "start": m.start(), "end": m.end(), "kind": "gstin", "repaired": True})
    # A printed PAN pins down 10 of the 15 GSTIN characters. If no GSTIN carries that PAN but a
    # GSTIN-looking token near "GST No" is almost identical to PAN-derived candidates, take the one
    # whose check-digit is valid (OCR often turns "I" into "T" and drops/duplicates a character).
    import difflib
    found_pans = {h["gstin"][2:12] for h in hits if h["kind"] == "gstin" and gstin_is_valid(h["gstin"])}
    for pm in re.finditer(r"\bPAN(?:\s*(?:NO|NUMBER|CARD))?\b[^A-Z0-9]{0,12}([A-Z]{5}\d{4}[A-Z])", up):
        pan = pm.group(1)
        if pan in found_pans:
            continue
        for gm in re.finditer(r"GST(?:IN)?[^A-Z0-9\n]{0,12}(?:NO\.?[^A-Z0-9\n]{0,6})?(\d{2}[A-Z0-9]{10,16})", up):
            tok = gm.group(1)
            overlap = [h for h in hits if h["kind"] == "gstin" and not (gm.end(1) <= h["start"] or gm.start(1) >= h["end"])]
            if overlap and any(gstin_is_valid(h["gstin"]) for h in overlap):
                continue
            if not overlap and any(not (gm.end(1) <= s_ or gm.start(1) >= e_) for s_, e_ in seen_spans):
                continue
            best_c, best_r = None, 0.0
            for ent in "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                cand14 = tok[:2] + pan + ent + "Z"
                try:
                    cand = cand14 + gstin_check_digit(cand14)
                except ValueError:
                    continue
                ratio = difflib.SequenceMatcher(None, cand, tok).ratio()
                if ratio > best_r:
                    best_c, best_r = cand, ratio
            if best_c and best_r >= 0.82:
                for h in overlap:                      # the misread token is replaced, not duplicated
                    hits.remove(h)
                hits.append({"gstin": best_c, "start": gm.start(1), "end": gm.end(1), "kind": "gstin", "repaired": True})
                seen_spans.append((gm.start(1), gm.end(1)))
                found_pans.add(pan)
                break
    hits.sort(key=lambda h: h["start"])
    return hits


def classify_gstins(text: str, known_gstins: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """
    Decide which GSTIN is the supplier's, the buyer's and which belong to a
    consignee, by weighing evidence rather than trusting print order:
      · buyer cues ("Bill to", "M/s", "Detail of receiver"…)          → buyer
      · consignee cues ("Ship to", "Delivery at", "Consignee")          → consignee
      · PAN printed next to / matching the GSTIN                         → supplier
      · "GST Reg No", bank details, "Registered office" before it       → supplier
      · first GSTIN in the header with no buyer cue                      → supplier
      · matches one of our master companies / clients                    → buyer
    """
    known = {k.upper(): v for k, v in (known_gstins or {}).items() if k}
    hits = _gstin_hits(text)
    if not hits:
        return {"supplier": "", "buyer": "", "consignee": [], "all": [], "repaired": []}

    up = text.upper()
    pans_labelled = set()
    for m in re.finditer(r"\bPAN(?:\s*(?:NO|NUMBER|CARD))?\b[^A-Z0-9]{0,12}([A-Z]{5}\d{4}[A-Z])", up):
        pans_labelled.add(m.group(1))

    lines_before_first = {}
    agg: Dict[str, Dict[str, float]] = {}
    for idx, h in enumerate(hits):
        g = h["gstin"]
        a = agg.setdefault(g, {"S": 0.0, "B": 0.0, "C": 0.0, "first": idx == 0, "kind": h["kind"], "n": 0})
        a["n"] += 1
        prev_end = hits[idx - 1]["end"] if idx > 0 else 0
        ctx_start = max(prev_end, h["start"] - 380)
        ctx = text[ctx_start:h["start"]]
        near = text[max(prev_end, h["start"] - 140):h["start"]]
        s_ev = b_ev = c_ev = 0.0
        if h["kind"] == "oidar":
            s_ev += 4.0
        if _BUYER_CUE.search(near):
            b_ev += 2.0
        elif _BUYER_CUE.search(ctx):
            b_ev += 1.5
        if _CONSIGNEE_CUE.search(near):
            c_ev += 2.0
        elif _CONSIGNEE_CUE.search(ctx):
            c_ev += 1.0
        if _SUPPLIER_CUE.search(near):
            s_ev += 2.0
        if _BANK_CUE.search(ctx) and not _BUYER_CUE.search(near) and not _CONSIGNEE_CUE.search(near):
            s_ev += 1.0
        line_start = text.rfind("\n", 0, h["start"]) + 1
        header_zone = text[:h["start"]].count("\n") <= 14
        if idx == 0 and header_zone and not _BUYER_CUE.search(ctx) and not _CONSIGNEE_CUE.search(ctx):
            s_ev += 1.5
        if h["kind"] == "gstin" and g[2:12] in pans_labelled:
            s_ev += 2.0
        # keep strongest single occurrence per role
        a["S"] = max(a["S"], s_ev)
        a["B"] = max(a["B"], b_ev)
        a["C"] = max(a["C"], c_ev)
        if h["repaired"]:
            a["repaired"] = 1.0

    for g in agg:
        if g in known:
            agg[g]["B"] += 3.0
        # a GSTIN that is mostly "consignee" but also has a buyer cue is the buyer (ship-to == bill-to)
        if agg[g]["B"] >= agg[g]["C"]:
            agg[g]["C"] = 0.0

    names = list(agg)
    supplier = buyer = ""
    consignees: List[str] = []
    if len(names) == 1:
        only = names[0]
        if agg[only]["B"] > agg[only]["S"] or only in known:
            buyer = only
        else:
            supplier = only
    else:
        # supplier = strongest "issuer" evidence net of "billed party" evidence; ties -> earliest printed
        sup_pool = [g for g in names if not (agg[g]["C"] > agg[g]["B"] and agg[g]["S"] < 3)] or names
        supplier = max(sup_pool, key=lambda g: (agg[g]["S"] - agg[g]["B"], agg[g]["S"], -names.index(g)))
        rest = [g for g in names if g != supplier]
        if len(rest) == 1:
            r0 = rest[0]
            # the one other party is the buyer unless it only ever appears as a ship-to / delivery party
            if agg[r0]["B"] > 0 or agg[r0]["C"] <= 0 or r0 in known:
                buyer = r0
            else:
                consignees = [r0]
        else:
            buyer = max(rest, key=lambda g: (g in known, agg[g]["B"] - agg[g]["C"], agg[g]["B"], -rest.index(g)))
            consignees = [g for g in rest if g != buyer and agg[g]["C"] > 0]
    return {"supplier": supplier, "buyer": buyer, "consignee": consignees, "all": names,
            "repaired": [g for g in names if agg[g].get("repaired")],
            "scores": {g: {k: v for k, v in agg[g].items() if k in ("S", "B", "C")} for g in names}}


_STOP_FOR = {"more", "queries", "any", "further", "details", "information", "example", "your", "complaints", "the",
             "reference", "payment", "recipient", "receipient", "transporter", "supplier", "office", "customer",
             "invoice", "delivery", "all", "each", "this", "that", "enquiries", "inquiries", "kind", "attention",
             "tds", "gst", "bank", "cheque", "e", "refund", "in", "on", "queries:", "billing", "claims"}

_ADDRESS_WORDS = re.compile(
    r"(?i)\b(?:plot|shop|block|floor|road|rd\.?|street|st\.?|nagar|society|complex|near|nr\.?|opp\.?|gidc|industrial|"
    r"estate|survey|sector|phase|lane|chowk|mall|tower|building|bldg|apartment|district|taluka|pin|gujarat|"
    r"maharashtra|delhi|karnataka|tamil|india|surat|ahmedabad|mumbai|vadodara|rajkot|navsari|bharuch)\b")
_LETTERHEAD_NOISE = re.compile(
    r"(?i)^(?:tax\s*invoice|proforma\s*invoice|invoice|original(?:\s+(?:for|copy)\b.*)?|duplicate|triplicate|receipt|"
    r"bill\s+of\s+supply|credit\s*note|debit\s*note|shree|sri\b|om\b|jai\b|\W*$|\[|\*|page\s*\d+|mobile\s+services|"
    r"e-?invoice|subject\s+to|customer\s+copy)|"
    r"\b(?:gst(?:in)?|pan|phone|mobile|email|e-mail|cin|msme|udyam|udhyam|tel|fax|irn|ack|state\s*code|"
    r"vat\s*registration|reverse\s*charge|e-?way|transporter|vehicle|challan|bank|a/c|ifsc|date|invoice\s*no|bill\s*no)\b|"
    r"@|www\.|\.com\b")
_CUE_SPLIT = re.compile(
    r"(?i)\s+(?:bill\s*to|ship\s*to|invoice\s*(?:no|number|date)|bill\s*(?:no|number|date)|date\b|gst(?:in)?\b|buyer|"
    r"m\s*/\s*s\b|original|duplicate|triplicate|receipt\s*no)")
_COMPANY_WORDS = re.compile(
    r"(?i)\b(?:pvt|private|ltd|limited|llp|inc|pbc|corp|corporation|company|co\.?|enterprise[s]?|traders?|industries|"
    r"associates|agenc(?:y|ies)|hardware|paints?|forge|steel|pipes?|sons|brothers|bros|electricals?|solutions|services|"
    r"technolog(?:y|ies)|systems|infra\w*|constructions?|engineering|fabricat\w*|trading|stores?|mart|motors?)\b")


def _clean_name(s: str) -> str:
    s = re.sub(r"^[\s:;\-–—.,!|*\[\]]+", "", s or "")
    s = re.split(r"\s{3,}|\t|\|", s)[0]
    s = _CUE_SPLIT.split(s)[0]
    s = re.sub(r"\s+", " ", s).strip(" :-.,;|*[]!")
    return s[:90]


def _looks_like_name(s: str) -> bool:
    if not (3 <= len(s) <= 80):
        return False
    letters = sum(c.isalpha() for c in s)
    if letters / max(len(s), 1) < 0.6:
        return False
    if sum(c.isdigit() for c in s) > 4:
        return False
    if s.count(",") >= 2:
        return False
    return True


def find_supplier_name(lines: List[str], gstin_zone_lines: int = 18) -> Dict[str, str]:
    """Returns {'name': ..., 'source': 'signature'|'letterhead'|'label'|''}."""
    sig: List[str] = []
    sig_rx = re.compile(r"(?:^|\s)(?i:for)\s*[,:]?\s+([A-Z][A-Za-z0-9&.,'()\-/ ]{2,70})\s*$")
    for line in lines:
        m = sig_rx.search(line.strip())
        if not m:
            continue
        name = _clean_name(m.group(1))
        first = re.split(r"\W+", name.lower())[0] if name else ""
        if not name or first in _STOP_FOR or not _looks_like_name(name):
            continue
        sig.append(name)
    if sig:
        # most frequent, earliest on ties
        best = max(dict.fromkeys(sig), key=lambda n: (sig.count(n), -sig.index(n)))
        return {"name": best, "source": "signature"}

    for line in lines[:gstin_zone_lines]:
        cand = _clean_name(line)
        if not cand or _LETTERHEAD_NOISE.search(cand) or _ADDRESS_WORDS.search(cand):
            continue
        if not _looks_like_name(cand):
            continue
        if _COMPANY_WORDS.search(cand) or (cand.isupper() and len(cand.split()) >= 2) or re.match(r"^[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z&.]+)+$", cand):
            return {"name": cand, "source": "letterhead"}

    lab = re.compile(r"(?i)(?:supplier(?:['’]s)?\s*(?:name|ref\.?)?|seller|vendor|beneficiary\s*a/?c\s*name|a/?c\s*name|account\s*name)\s*[:.\-]*\s*(.+)")
    for line in lines:
        m = lab.search(line)
        if m:
            cand = _clean_name(m.group(1))
            if _looks_like_name(cand) and not _LETTERHEAD_NOISE.search(cand):
                return {"name": cand, "source": "label"}
    return {"name": "", "source": ""}


_BUYER_LABEL_RX = [
    re.compile(r"(?i)\bm\s*/\s*s\b\.?\s*[,:\-]*\s*(.*)$"),
    re.compile(r"(?i)\b(?:bill(?:ed)?\s*to|invoice\s*to|sold\s*to)\b\s*[:\-]*\s*(.*)$"),
    re.compile(r"(?i)\bbuyer\b(?!['’]s)\s*[:\-.]*\s*(.*)$"),
    re.compile(r"(?i)details?\s+of\s+receiver\s*[:\-]*\s*(.*)$"),
    re.compile(r"(?i)\b(?:receiver|customer|party)\s*(?:name)?\s*[:\-]\s*(.*)$"),
]
_NAME_TAIL = {"limited", "ltd", "pvt", "private", "llp", "inc", "company", "corporation", "enterprise", "enterprises"}


def find_buyer_name(lines: List[str], supplier_name: str = "") -> str:
    for rx in _BUYER_LABEL_RX:
        for i, line in enumerate(lines):
            m = rx.search(line)
            if not m:
                continue
            raw = m.group(1).strip()
            if re.match(r"(?i)name\s*:", raw):
                raw = re.sub(r"(?i)^name\s*:\s*", "", raw)
            if re.search(r"(?i)^\W*$", raw) and i + 1 < len(lines):
                raw = lines[i + 1]
            cand = _clean_name(re.split(r"(?i)\s+name\s*:", raw)[0])
            cand = re.split(r"(?i)\s+(?:book\s*no|challan|invoice|date|dated|dt\b|phone|mobile|state|gst)", cand)[0].strip(" :-.,")
            # name wrapped onto the next line ("…PRIVATE" / "LIMITED")
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if cand and nxt and nxt.lower().strip(". ") in _NAME_TAIL | {"pvt ltd", "private limited", "pvt. ltd."}:
                cand = f"{cand} {nxt}"
            if _looks_like_name(cand) and norm_name(cand) != norm_name(supplier_name):
                return cand
    return ""


def find_known_party_in_text(text: str, parties: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """If one of our master companies/clients is named in the document, return it."""
    norm_text = " " + " ".join(re.sub(r"[^a-z0-9 ]+", " ", text.lower().replace("&", " and ")).split()) + " "
    best, best_len = None, 0
    for p in parties or []:
        nm = norm_name(p.get("name") or "")
        if not nm or (len(nm.split()) < 2 and len(nm) < 7):
            continue
        if f" {nm} " in norm_text and len(nm) > best_len:
            best, best_len = p, len(nm)
    return best


# ═════════════════════════════════════════════════════════════════════════════
# Invoice number & date
# ═════════════════════════════════════════════════════════════════════════════

_INVNO_LABELS = [
    (r"tax\s*invoice\s*(?:no\.?|number|#)", 10),
    (r"invoice\s*(?:no\.?|number|num\.?|#)", 10),
    (r"inv\.?\s*(?:no\.?|number|#)", 8),
    (r"bill\s*(?:no\.?|number|#)", 9),
    (r"document\s*(?:no\.?|number)", 6),
    (r"voucher\s*(?:no\.?|number)", 5),
    (r"receipt\s*(?:no\.?|number)", 2),
]
_INVNO_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-/_.]{0,28}")
_INVNO_BAD = {"date", "dated", "dt", "no", "number", "gstin", "gst", "place", "of", "supply", "state", "code", "and", "the", "ref"}


def _valid_invno(tok: str) -> bool:
    t = tok.strip(".-/_ ")
    if not t or not any(c.isdigit() for c in t):
        return False
    if t.lower() in _INVNO_BAD:
        return False
    if find_dates(t) and re.fullmatch(r"[\d/.\-]+", t):
        return False
    if GSTIN_RE.fullmatch(t.upper()):
        return False
    return True


def find_invoice_no(lines: List[str]) -> Dict[str, Any]:
    best: Optional[Tuple[int, int, str]] = None  # (priority, -line, value)
    for li, line in enumerate(lines):
        for rx, prio in _INVNO_LABELS:
            for m in re.finditer(rx, line, re.I):
                before = line[max(0, m.start() - 12):m.start()].lower()
                if re.search(r"(?:challan|e-?way|order|quotation|credit\s*note|debit\s*note|irn|ack)\s*$", before):
                    continue
                rest = line[m.end():].lstrip(" :.-#=|\t")
                cand = None
                if rest and not re.match(r"(?i)^(?:date|dated|dt)\b", rest):
                    tm = _INVNO_TOKEN.match(rest)
                    if tm and _valid_invno(tm.group(0)):
                        cand = tm.group(0).strip(".-/_")
                        # Stripe-style "URP31ZN5 0005": letters+digits token followed by a short digit group
                        tail = rest[tm.end():].lstrip()
                        t2 = re.match(r"(\d{3,6})\b", tail)
                        if (t2 and len(cand) >= 6 and re.search(r"[A-Za-z]", cand) and re.search(r"\d", cand)
                                and not re.search(r"[/\-]", cand)):
                            cand = f"{cand} {t2.group(1)}"
                if cand is None:
                    # value printed on the next line (JC Fire Door: label | next line "JCFD/2026-27")
                    for nxt in lines[li + 1:li + 3]:
                        tm = _INVNO_TOKEN.match(nxt.strip())
                        if tm and _valid_invno(tm.group(0)) and not re.match(r"(?i)^(?:quotation|date|dated|gst|bank|supplier)", nxt.strip()):
                            cand = tm.group(0).strip(".-/_")
                            break
                if cand:
                    key = (prio, -li, cand)
                    if best is None or key[:2] > best[:2]:
                        best = key
    if best:
        return {"value": best[2], "confidence": 0.95 if best[0] >= 9 else 0.8}
    return {"value": "", "confidence": 0.0}


_DATE_LABEL_POS = [
    (r"invoice\s*date|date\s*of\s*invoice|tax\s*invoice\s*date", 10),
    (r"bill\s*date|date\s*of\s*bill", 9),
    (r"\bdated?\b|\bdt\b", 6),
    (r"date\s*paid|paid\s*on", 5),
    (r"\bdate\b", 4),
]
_DATE_LABEL_NEG = re.compile(
    r"(?i)(?:due|pay\s*by|period|challan|order|dispatch|valid|expiry|expires|e-?way|payment\s*via|from|\bto\b|next|"
    r"delivery|received|ack|irn)")


def find_invoice_date(lines: List[str]) -> Dict[str, Any]:
    cands: List[Tuple[float, int, date]] = []
    for li, line in enumerate(lines):
        hits = find_dates(line)
        for s, e, dt in hits:
            before = line[max(0, s - 36):s]
            after = line[e:e + 12]
            score = 1.0
            matched = False
            for rx, prio in _DATE_LABEL_POS:
                if re.search(rx, before, re.I):
                    score = float(prio)
                    matched = True
                    break
            if not matched and li > 0:
                prev = lines[li - 1][-40:]
                if re.search(r"invoice\s*date|bill\s*date", prev, re.I):
                    score = 7.0
            if _DATE_LABEL_NEG.search(before[-18:]):
                score -= 8.0
            if re.search(r"(?i)^\s*to\b", after) and re.search(r"(?i)period", line):
                score -= 6.0
            cands.append((score, -li, dt))
    if not cands:
        return {"value": "", "confidence": 0.0}
    cands.sort(key=lambda c: (c[0], c[1]), reverse=True)
    top = cands[0]
    if top[0] <= -3:
        return {"value": "", "confidence": 0.0}
    return {"value": top[2].isoformat(), "confidence": 0.95 if top[0] >= 9 else (0.8 if top[0] >= 5 else 0.5)}


# ═════════════════════════════════════════════════════════════════════════════
# The deterministic parser
# ═════════════════════════════════════════════════════════════════════════════

def _state_code(gstin: str) -> str:
    return gstin[:2] if gstin and gstin[:2].isdigit() else ""


def split_tax(total_gst: float, lab: Dict[str, List[Tuple[float, int, int]]], supplier_gstin: str,
              buyer_gstin: str, text: str) -> Dict[str, float]:
    cgst = max([v for v, _, _ in lab.get("cgst", []) if v > 0] or [0.0])
    sgst = max([v for v, _, _ in lab.get("sgst", []) if v > 0] or [0.0])
    igst = max([v for v, _, _ in lab.get("igst", []) if v > 0] or [0.0])
    cess = max([v for v, _, _ in lab.get("cess", []) if v > 0] or [0.0])
    if total_gst <= 0:
        return {"cgst": 0.0, "sgst": 0.0, "igst": 0.0, "cess": 0.0}
    if abs(cgst + sgst + igst + cess - total_gst) <= 0.05 and (cgst or sgst or igst):
        return {"cgst": cgst, "sgst": sgst, "igst": igst, "cess": cess}
    if abs(cgst + sgst + igst - total_gst) <= 0.05 and (cgst or sgst or igst):
        return {"cgst": cgst, "sgst": sgst, "igst": igst, "cess": 0.0}
    ss, bs = _state_code(supplier_gstin), _state_code(buyer_gstin)
    if ss and bs:
        intra = ss == bs
    elif re.search(r"(?i)\bigst\b", text) and not re.search(r"(?i)\b[cs]gst\b", text):
        intra = False
    else:
        intra = True
    if intra:
        half = round(total_gst / 2, 2)
        return {"cgst": half, "sgst": round(total_gst - half, 2), "igst": 0.0, "cess": 0.0}
    return {"cgst": 0.0, "sgst": 0.0, "igst": round(total_gst, 2), "cess": 0.0}


def detect_document_type(text: str) -> str:
    head = text[:600].lower()
    if re.search(r"proforma\s+invoice|pro-forma", head):
        return "proforma"
    if re.search(r"^\s*receipt\b", head) and "tax invoice" not in head[:80]:
        return "receipt"
    if re.search(r"credit\s*note", head):
        return "credit_note"
    if re.search(r"electricity|vij\s*company|energy\s*charge|meter\s*(?:no|reading)|mobile\s+services|postpaid|broadband", text[:2500], re.I):
        return "utility_bill"
    if re.search(r"bill\s+of\s+supply", head):
        return "bill_of_supply"
    return "tax_invoice"


def parse_invoice_text(text: str, known_parties: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Deterministic reader for a document whose text we already have (PDF text layer or OCR)."""
    text = clean_text(text)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    known_gstins = {p["gstin"]: p.get("name", "") for p in (known_parties or []) if p.get("gstin")}

    roles = classify_gstins(text, known_gstins)
    supplier_gstin, buyer_gstin = roles["supplier"], roles["buyer"]

    sup = find_supplier_name(lines)
    supplier_name = sup["name"]
    buyer_name = find_buyer_name(lines, supplier_name)
    kp = find_known_party_in_text(text, [p for p in (known_parties or []) if norm_name(p.get("name", "")) != norm_name(supplier_name)])
    if kp and (not buyer_name or name_similarity(buyer_name, kp["name"]) < 0.6):
        buyer_name = kp["name"]
    if kp and not buyer_gstin and kp.get("gstin") and kp["gstin"] in roles["all"]:
        buyer_gstin = kp["gstin"]
        if supplier_gstin == buyer_gstin:
            supplier_gstin = next((g for g in roles["all"] if g != buyer_gstin and g not in roles["consignee"]), "")

    inv = find_invoice_no(lines)
    dt = find_invoice_date(lines)

    lab = scan_labelled_amounts(lines)
    # strip HSN/SAC numbers before building the amount pool
    pool_lines = [re.sub(r"(?i)\b(?:hsn|sac)(?:\s*/\s*(?:sac|hsn))?(?:\s*code)?\s*[:.\-]*\s*\d{3,8}", " ", ln) for ln in lines]
    pool = amount_pool(pool_lines)
    words_val = find_amount_in_words(text)
    rec = reconcile_amounts(lab, pool, words_val)

    taxes = split_tax(rec["gst"], lab, supplier_gstin, buyer_gstin, text)
    advance = max([v for v, _, _ in lab.get("advance", []) if v > 0] or [0.0])
    advance_info: Optional[Dict[str, float]] = None
    if advance > 0 and rec["grand_total"] > 0:
        bal = round(rec["grand_total"] - advance, 2)
        if any(abs(bal - v) <= 0.011 for v in pool):
            advance_info = {"advance": advance, "balance": bal}

    fields_found = sum(bool(x) for x in (inv["value"], dt["value"], supplier_name, rec["grand_total"]))
    conf = 0.35 + 0.1 * fields_found + (0.2 if rec["reconciled"] else 0.0) + (0.05 if supplier_gstin else 0.0)
    if words_val and abs(rec["grand_total"] - words_val) <= 0.51:
        conf += 0.05
    conf = round(min(conf, 0.99), 2)

    return {
        "supplier_name": supplier_name,
        "supplier_name_source": sup["source"],
        "supplier_gstin": supplier_gstin,
        "buyer_name": buyer_name,
        "buyer_gstin": buyer_gstin,
        "consignee_gstins": roles["consignee"],
        "all_gstins": roles["all"],
        "repaired_gstins": roles["repaired"],
        "invoice_no": inv["value"],
        "invoice_date": dt["value"],
        "taxable_amount": rec["taxable"],
        "cgst_amount": taxes["cgst"],
        "sgst_amount": taxes["sgst"],
        "igst_amount": taxes["igst"],
        "cess_amount": taxes["cess"],
        "total_gst": rec["gst"],
        "round_off": rec["round_off"] if abs(rec["round_off"]) <= 1.0 else 0.0,
        "grand_total": rec["grand_total"],
        "amount_in_words_value": words_val,
        "reconciled": bool(rec["reconciled"]),
        "document_type": detect_document_type(text),
        "advance_info": advance_info,
        "field_confidence": {
            "invoice_no": inv["confidence"], "invoice_date": dt["confidence"],
            "amounts": 0.95 if rec["reconciled"] else 0.3,
            "supplier_name": {"signature": 0.95, "letterhead": 0.8, "label": 0.6}.get(sup["source"], 0.0),
        },
        "parse_confidence": conf,
        "raw_text_excerpt": text[:5000],
    }


# ═════════════════════════════════════════════════════════════════════════════
# Validation → warnings for the editable preview
# ═════════════════════════════════════════════════════════════════════════════

def _w(field: str, code: str, severity: str, message: str) -> Dict[str, str]:
    return {"field": field, "code": code, "severity": severity, "message": message}


def check_totals(r: Dict[str, Any]) -> Tuple[bool, float]:
    t, gst, ro, g = (to_num(r.get(k)) for k in ("taxable_amount", "total_gst", "round_off", "grand_total"))
    diff = round(g - (t + gst + ro), 2)
    return abs(diff) <= 1.0, diff


def validate_extraction(r: Dict[str, Any], today: Optional[date] = None) -> List[Dict[str, str]]:
    """Every problem a human should look at before the invoice is booked."""
    today = today or date.today()
    out: List[Dict[str, str]] = []
    if not (r.get("supplier_name") or "").strip():
        out.append(_w("supplier_name", "missing_supplier", "error", "Supplier name could not be read — type it in."))
    if not (r.get("invoice_no") or "").strip():
        out.append(_w("invoice_no", "missing_invoice_no", "error", "Invoice number could not be read — type it in."))
    d = r.get("invoice_date") or ""
    if not d:
        out.append(_w("invoice_date", "missing_date", "error", "Invoice date could not be read — pick it."))
    else:
        try:
            dd = date.fromisoformat(d)
            if (dd - today).days > 7:
                out.append(_w("invoice_date", "future_date", "warn", f"Invoice date {dd.strftime('%d-%b-%Y')} is in the future."))
            elif (today - dd).days > 365 * 3:
                out.append(_w("invoice_date", "old_date", "warn", f"Invoice date {dd.strftime('%d-%b-%Y')} is more than 3 years old."))
        except ValueError:
            out.append(_w("invoice_date", "bad_date", "error", "Invoice date is not a valid date."))

    g = to_num(r.get("grand_total"))
    if g <= 0:
        out.append(_w("grand_total", "missing_total", "error", "Grand total could not be read — enter the invoice total."))
    else:
        ok, diff = check_totals(r)
        if not ok:
            out.append(_w("grand_total", "totals_mismatch", "error",
                          f"Taxable + GST + round-off is off from the grand total by ₹{abs(diff):,.2f}. "
                          "One of these amounts was misread — compare with the document."))
        wv = r.get("amount_in_words_value")
        if wv and abs(g - float(wv)) > 0.51:
            out.append(_w("grand_total", "words_mismatch", "error",
                          f"Grand total ₹{g:,.2f} does not match the amount in words (₹{float(wv):,.2f})."))
    gst = to_num(r.get("total_gst"))
    comp = sum(to_num(r.get(k)) for k in ("cgst_amount", "sgst_amount", "igst_amount", "cess_amount"))
    if gst > 0 and abs(comp - gst) > 0.05:
        out.append(_w("total_gst", "gst_split_mismatch", "warn",
                      f"CGST+SGST+IGST+Cess (₹{comp:,.2f}) ≠ Total GST (₹{gst:,.2f})."))
    cg, sg, ig = (to_num(r.get(k)) for k in ("cgst_amount", "sgst_amount", "igst_amount"))
    if (cg or sg) and ig:
        out.append(_w("igst_amount", "mixed_gst", "warn", "Both IGST and CGST/SGST are filled — an invoice normally has one or the other."))
    if abs(cg - sg) > 0.02 and cg and sg:
        out.append(_w("sgst_amount", "cgst_sgst_unequal", "warn", "CGST and SGST amounts differ — they are normally equal."))
    t = to_num(r.get("taxable_amount"))
    if t > 0 and gst > 0:
        rate = gst / t * 100
        if not any(abs(rate - sr) <= 0.6 for sr in STANDARD_GST_RATES):
            out.append(_w("total_gst", "odd_rate", "info", f"GST works out to {rate:.1f}% of taxable value (mixed-rate bill or a misread amount)."))

    sg_, bg_ = (r.get("supplier_gstin") or "").upper(), (r.get("buyer_gstin") or "").upper()
    if sg_:
        if is_oidar_id(sg_):
            out.append(_w("supplier_gstin", "oidar", "info",
                          "Foreign (OIDAR) supplier registration. GST is usually shown as 0% — reverse charge may apply to you."))
        elif not GSTIN_RE.fullmatch(sg_):
            out.append(_w("supplier_gstin", "bad_gstin", "warn", "Supplier GSTIN is not a valid 15-character GSTIN."))
        elif not gstin_is_valid(sg_):
            out.append(_w("supplier_gstin", "gstin_checksum", "warn", "Supplier GSTIN fails the GST check-digit — a character was probably misread."))
    else:
        out.append(_w("supplier_gstin", "missing_supplier_gstin", "info", "No supplier GSTIN found (unregistered supplier, or not printed)."))
    if bg_ and not gstin_is_valid(bg_):
        out.append(_w("buyer_gstin", "gstin_checksum", "warn", "Buyer GSTIN fails the GST check-digit — a character was probably misread."))
    if sg_ and bg_ and sg_ == bg_:
        out.append(_w("buyer_gstin", "same_gstin", "error", "Supplier and buyer GSTIN are the same — one of them is wrong."))
    ss, bs = _state_code(sg_), _state_code(bg_)
    if ss and bs and gst > 0:
        if ss == bs and ig > 0 and not (cg or sg):
            out.append(_w("igst_amount", "intra_state_igst", "warn", "Supplier and buyer are in the same state but IGST is charged."))
        elif ss != bs and (cg or sg) and not ig:
            out.append(_w("cgst_amount", "inter_state_cgst", "warn", "Supplier and buyer are in different states but CGST/SGST is charged."))

    dt = r.get("document_type")
    if dt == "proforma":
        out.append(_w("document_type", "proforma", "warn", "This is a PROFORMA invoice, not a tax invoice — confirm it should be booked as a purchase."))
    elif dt == "receipt":
        out.append(_w("document_type", "receipt", "info", "This is a payment receipt / invoice from an online service."))
    adv = r.get("advance_info")
    if adv:
        out.append(_w("grand_total", "advance_adjusted", "info",
                      f"₹{adv['advance']:,.2f} advance was already adjusted on this invoice. The grand total is the full invoice value "
                      f"(₹{r.get('grand_total', 0):,.2f}); balance payable is ₹{adv['balance']:,.2f}."))
    for g_ in r.get("repaired_gstins") or []:
        out.append(_w("supplier_gstin", "gstin_repaired", "info", f"GSTIN {g_} was auto-corrected from a misread character (check-digit verified)."))
    return out


def review_needed(warnings: List[Dict[str, str]], confidence: float) -> bool:
    return any(w["severity"] == "error" for w in warnings) or confidence < 0.75


# ═════════════════════════════════════════════════════════════════════════════
# Pulling text / images out of the upload
# ═════════════════════════════════════════════════════════════════════════════

def extract_pdf_text(contents: bytes, max_pages: int = 12) -> Tuple[str, int]:
    try:
        import pdfplumber
    except Exception:
        return "", 0
    pages: List[str] = []
    n = 0
    try:
        with pdfplumber.open(BytesIO(contents)) as pdf:
            n = len(pdf.pages)
            idx = list(range(n))
            if n > 4:
                idx = [0, 1, 2, n - 1]
            for i in idx[:max_pages]:
                t = pdf.pages[i].extract_text() or ""
                if t.strip():
                    pages.append(t.strip())
    except Exception as e:  # pragma: no cover
        logger.warning("PDF text extraction failed: %s", e)
        return "", n
    text = "\n".join(pages)
    # a "text layer" made of (cid:12) glyph ids is as good as no text layer
    if text.count("(cid:") > 20 or sum(c.isalnum() for c in text) < 40:
        return "", n
    return text, n


def _jpeg(img: Any, quality: int = 88) -> bytes:
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _page_indexes(n: int, max_pages: int) -> List[int]:
    # long invoices: first pages + the last one (totals live there)
    return list(range(n)) if n <= max_pages else list(range(max_pages - 1)) + [n - 1]


def render_pages(contents: bytes, ext: str, max_pages: int = 4, resolution: int = 170) -> List[Tuple[bytes, str]]:
    """Pages as (jpeg_bytes, mime) for OCR / vision. Tries pdfplumber(pypdfium2) first, then pdf2image(poppler)."""
    out: List[Tuple[bytes, str]] = []
    try:
        from PIL import Image
    except Exception as e:  # pragma: no cover
        logger.warning("Pillow missing, cannot render pages: %s", e)
        return out
    if ext != "pdf":
        try:
            img = Image.open(BytesIO(contents))
            if max(img.size) > 2400:
                img.thumbnail((2400, 2400))
            out.append((_jpeg(img, 90), "image/jpeg"))
        except Exception as e:
            logger.warning("Could not open image upload: %s", e)
        return out
    try:
        import pdfplumber
        with pdfplumber.open(BytesIO(contents)) as pdf:
            for i in _page_indexes(len(pdf.pages), max_pages):
                out.append((_jpeg(pdf.pages[i].to_image(resolution=resolution).original), "image/jpeg"))
        if out:
            return out
    except Exception as e:
        logger.info("pdfplumber page rendering failed (%s) - trying pdf2image", e)
        out = []
    try:
        from pdf2image import convert_from_bytes, pdfinfo_from_bytes
        n = int(pdfinfo_from_bytes(contents).get("Pages", 1))
        for i in _page_indexes(n, max_pages):
            imgs = convert_from_bytes(contents, dpi=resolution, first_page=i + 1, last_page=i + 1)
            if imgs:
                out.append((_jpeg(imgs[0]), "image/jpeg"))
    except Exception as e:
        logger.warning("Rendering PDF pages failed: %s", e)
    return out


def tesseract_available() -> bool:
    return bool(shutil.which("tesseract"))


def _tesseract_page(jpeg: bytes) -> str:
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "page.jpg")
        with open(p, "wb") as fh:
            fh.write(jpeg)
        try:
            res = subprocess.run(["tesseract", p, "stdout", "--psm", "6", "-l", "eng"],
                                 capture_output=True, text=True, timeout=45)
            return res.stdout or ""
        except Exception as e:  # pragma: no cover
            logger.warning("tesseract failed: %s", e)
            return ""


_VOCAB = ("invoice", "bill", "total", "amount", "date", "gst", "gstin", "tax", "qty", "quantity", "rate", "hsn", "cgst",
          "sgst", "igst", "due", "payable", "charges", "description", "rupees", "supplier", "buyer", "state", "round")


def ocr_quality(text: str) -> int:
    """How many distinct invoice words survive in OCR text. Garbage OCR (Gujarati/Hindi scans, blurry photos)
    scores ~0-2; a readable English/Hindi-bilingual invoice scores 6+."""
    words = set(re.findall(r"[a-z]{3,}", (text or "").lower()))
    return sum(1 for v in _VOCAB if v in words)


async def ocr_pages(pages: List[Tuple[bytes, str]]) -> str:
    if not pages or not tesseract_available():
        return ""
    texts = await asyncio.gather(*[asyncio.to_thread(_tesseract_page, jpg) for jpg, _ in pages])
    return "\n".join(t.strip() for t in texts if t.strip())


# ═════════════════════════════════════════════════════════════════════════════
# AI vision (Gemini / Groq — reuses the AI Document Reader's providers)
# ═════════════════════════════════════════════════════════════════════════════

_AI_PROMPT = """You are an expert Indian GST accountant reading a SUPPLIER / PURCHASE invoice from the attached page images.
Return ONE JSON object and nothing else (no markdown fences, no commentary) with exactly these keys:
{
 "supplier_name": "", "supplier_gstin": "", "buyer_name": "", "buyer_gstin": "",
 "invoice_no": "", "invoice_date": "YYYY-MM-DD", "due_date": "YYYY-MM-DD or empty",
 "taxable_amount": 0, "cgst_amount": 0, "sgst_amount": 0, "igst_amount": 0, "cess_amount": 0,
 "total_gst": 0, "round_off": 0, "grand_total": 0,
 "amount_in_words": "", "document_type": "tax_invoice|proforma|receipt|utility_bill|credit_note|bill_of_supply",
 "place_of_supply": "", "currency": "INR", "confidence": 0.0, "uncertain_fields": []
}
RULES — follow them strictly:
1. supplier = the party that ISSUED the invoice (letterhead, "For <name>" signature, bank details, "GST No." in the header or footer).
   buyer = the party BILLED ("Bill to", "M/s.", "Buyer", "Detail of Receiver", "Name"). A consignee / "Ship to" / "Delivery at" party is NOT the buyer.
2. GSTINs: copy all 15 characters exactly; digits vs letters matter (0/O, 1/I, 5/S, 8/B). Leave "" if not printed. A foreign supplier registration like 9924USA29003OSI is fine as supplier_gstin.
3. invoice_no: exactly as printed, including prefixes, slashes and spaces (e.g. "26-27/KD/T1241", "JCFD/2026-27"). Never use the challan, order, quotation, IRN, e-way bill or receipt number. For electricity / telephone bills use the Bill No.
4. invoice_date: the invoice / bill date, not the due date, bill period, challan date or payment date. Indian dates are dd/mm/yyyy. Output ISO yyyy-mm-dd.
5. Amounts are plain numbers in rupees — no commas, no currency symbol. NEVER output a percentage or a rate as an amount.
   taxable_amount = value on which GST is charged (after discount, before GST).
   cgst_amount / sgst_amount / igst_amount / cess_amount = the tax AMOUNTS printed in rupees. total_gst = their sum (0 if the invoice shows 0% or no GST, e.g. electricity bills).
   round_off = the signed "Rounded off / R.OFF" value (e.g. -0.30).
   grand_total = the FINAL invoice value including GST and round-off — the figure that matches the amount in words.
   Do NOT use: an advance-adjusted balance, a late-payment amount ("amount due after due date"), arrears / previous balance, a sum of quantities, an HSN code, or a bank account number.
6. amount_in_words: copy the printed words verbatim ("" if none).
7. Multi-page invoice: line items may be on page 1 and totals on the last page — read ALL pages.
8. SELF-CHECK before answering: taxable_amount + total_gst + round_off must equal grand_total (±1). If it does not, re-read the numbers.
9. If a value is not on the document use "" (or 0 for amounts). Never guess. List any field you are unsure about in uncertain_fields.
"""


def ai_configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
                or os.environ.get("GOOGLE_AI_STUDIO_API_KEY") or os.environ.get("GROQ_API_KEY"))


def _extract_json_object(text: str) -> Dict[str, Any]:
    import json
    if not text:
        return {}
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I | re.S).strip()
    m = re.search(r"\{.*\}", cleaned, re.S)
    if m:
        cleaned = m.group(0)
    try:
        data = json.loads(cleaned)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def normalise_ai_result(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Make the model's JSON safe: numbers → floats, dates → ISO, GSTINs → upper + check."""
    if not raw:
        return {}
    r: Dict[str, Any] = {}
    for k in ("supplier_name", "buyer_name", "invoice_no", "place_of_supply", "currency", "document_type"):
        r[k] = str(raw.get(k) or "").strip()
    for k in ("supplier_gstin", "buyer_gstin"):
        g = re.sub(r"[^A-Za-z0-9]", "", str(raw.get(k) or "")).upper()
        if len(g) == 15 and not gstin_is_valid(g) and not is_oidar_id(g):
            g = repair_gstin(g) or g
        r[k] = g
    r["invoice_date"] = normalise_date(raw.get("invoice_date"))
    r["due_date"] = normalise_date(raw.get("due_date"))
    for k in ("taxable_amount", "cgst_amount", "sgst_amount", "igst_amount", "cess_amount", "total_gst", "round_off", "grand_total"):
        r[k] = to_num(raw.get(k))
    comp = round(r["cgst_amount"] + r["sgst_amount"] + r["igst_amount"] + r["cess_amount"], 2)
    if not r["total_gst"] and comp:
        r["total_gst"] = comp
    r["amount_in_words_value"] = words_to_number(str(raw.get("amount_in_words") or "")) if raw.get("amount_in_words") else None
    try:
        r["ai_confidence"] = float(raw.get("confidence") or 0)
    except (TypeError, ValueError):
        r["ai_confidence"] = 0.0
    r["uncertain_fields"] = [str(x) for x in (raw.get("uncertain_fields") or []) if x]
    if r["document_type"] not in ("tax_invoice", "proforma", "receipt", "utility_bill", "credit_note", "bill_of_supply"):
        r["document_type"] = "tax_invoice"
    r["all_gstins"] = [g for g in (r["supplier_gstin"], r["buyer_gstin"]) if g]
    return r


async def ai_extract(pages: List[Tuple[bytes, str]], known_parties: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """One vision call over all pages. Returns {} when no provider is configured or the call fails."""
    if not pages or not ai_configured():
        return {}
    prompt = _AI_PROMPT
    names = [p.get("name") for p in (known_parties or []) if p.get("name")][:12]
    if names:
        prompt += ("\nHINT: our own companies (usually the BUYER) include: " + "; ".join(names) +
                   ". Only use one of these as buyer_name if it is actually printed on the document.\n")
    try:
        from backend.ai_document_reader import _groq_vision, _groq_vision_multipage
        b64 = [(base64.b64encode(jpg).decode(), mime) for jpg, mime in pages]
        if len(b64) == 1:
            answer = await _groq_vision(b64[0][0], b64[0][1], prompt)
        else:
            answer = await _groq_vision_multipage(b64, prompt)
        return normalise_ai_result(_extract_json_object(answer))
    except Exception as e:
        logger.warning("Purchase invoice AI vision failed: %s", e)
        return {}


# ═════════════════════════════════════════════════════════════════════════════
# Merge text/OCR result with AI result
# ═════════════════════════════════════════════════════════════════════════════

_AMOUNT_KEYS = ("taxable_amount", "cgst_amount", "sgst_amount", "igst_amount", "cess_amount", "total_gst", "round_off", "grand_total")


def _ai_amounts_ok(r: Dict[str, Any]) -> bool:
    return to_num(r.get("grand_total")) > 0 and check_totals(r)[0]


def merge_results(primary: Optional[Dict[str, Any]], ai: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Prefer exact text; fill gaps and settle conflicts with whichever side passes the validators."""
    if not ai:
        return primary or {}
    if not primary:
        out = dict(ai)
        out["reconciled"] = _ai_amounts_ok(ai)
        out["parse_confidence"] = round(min(0.9, 0.55 + 0.35 * float(ai.get("ai_confidence") or 0.5)) * (1.0 if out["reconciled"] else 0.75), 2)
        out["field_confidence"] = {"amounts": 0.9 if out["reconciled"] else 0.4}
        out["supplier_name_source"] = "ai"
        return out

    out = dict(primary)
    notes: List[Dict[str, str]] = []

    # — amounts: take the side that adds up (and matches the amount in words)
    p_ok = bool(primary.get("reconciled"))
    a_ok = _ai_amounts_ok(ai)
    words = primary.get("amount_in_words_value") or ai.get("amount_in_words_value")
    use_ai_amounts = False
    if a_ok and not p_ok:
        use_ai_amounts = True
    elif a_ok and p_ok:
        pg, ag = to_num(primary.get("grand_total")), to_num(ai.get("grand_total"))
        if abs(pg - ag) > 0.011:
            if words and abs(ag - float(words)) <= 0.51 < abs(pg - float(words)):
                use_ai_amounts = True
            else:
                notes.append(_w("grand_total", "ai_text_disagree", "warn",
                                f"The AI read the total as ₹{ag:,.2f} but the document text says ₹{pg:,.2f}. Please check."))
    elif not p_ok and not a_ok and to_num(ai.get("grand_total")) > 0 and to_num(primary.get("grand_total")) <= 0:
        use_ai_amounts = True
    if use_ai_amounts:
        for k in _AMOUNT_KEYS:
            out[k] = to_num(ai.get(k))
        out["reconciled"] = a_ok
        out["field_confidence"] = {**(primary.get("field_confidence") or {}), "amounts": 0.85 if a_ok else 0.4}
        if ai.get("amount_in_words_value"):
            out["amount_in_words_value"] = ai["amount_in_words_value"]

    # — identifiers / dates: exact text wins, AI fills holes
    for k in ("invoice_no", "invoice_date", "supplier_name", "buyer_name"):
        if not out.get(k) and ai.get(k):
            out[k] = ai[k]
            out.setdefault("ai_filled", []).append(k)
    if ai.get("due_date"):
        out["due_date"] = ai["due_date"]
    if ai.get("place_of_supply"):
        out["place_of_supply"] = ai["place_of_supply"]
    # supplier name from a mere letterhead / label guess loses to a confident AI reading that disagrees
    if primary.get("supplier_name_source") in ("label", "") and ai.get("supplier_name") and name_similarity(out.get("supplier_name", ""), ai["supplier_name"]) < 0.5:
        out["supplier_name"] = ai["supplier_name"]
        out["supplier_name_source"] = "ai"

    # — GSTINs: valid beats invalid; text beats AI when both valid
    for k in ("supplier_gstin", "buyer_gstin"):
        pv, av = (out.get(k) or "").upper(), (ai.get(k) or "").upper()
        if not pv and av:
            out[k] = av
        elif pv and av and pv != av:
            pvv = gstin_is_valid(pv) or is_oidar_id(pv)
            avv = gstin_is_valid(av) or is_oidar_id(av)
            if avv and not pvv:
                out[k] = av
            else:
                notes.append(_w(k, "ai_text_disagree", "info", f"AI read {av}; document text says {pv}."))
    if out.get("supplier_gstin") and out.get("supplier_gstin") == out.get("buyer_gstin"):
        # whichever side disagrees with the other party's GSTIN is the culprit
        alt = (ai.get("supplier_gstin") or "").upper()
        if alt and alt != out["buyer_gstin"]:
            out["supplier_gstin"] = alt

    if (not out.get("document_type") or out["document_type"] == "tax_invoice") and ai.get("document_type") not in (None, "", "tax_invoice"):
        out["document_type"] = ai["document_type"]
    out["all_gstins"] = list(dict.fromkeys([*(out.get("all_gstins") or []), *(ai.get("all_gstins") or [])]))
    base = float(out.get("parse_confidence") or 0.5)
    out["parse_confidence"] = round(min(0.97, max(base, 0.6) + (0.1 if out.get("reconciled") else 0.0)), 2)
    out["merge_notes"] = notes
    return out


# ═════════════════════════════════════════════════════════════════════════════
# Public entry point
# ═════════════════════════════════════════════════════════════════════════════

OCR_DPI = 260
_KEY_FIELDS = ("invoice_no", "invoice_date", "supplier_name")


def _complete(r: Optional[Dict[str, Any]]) -> bool:
    return bool(r) and all(r.get(k) for k in _KEY_FIELDS) and bool(r.get("reconciled"))


def _blank_result(filename: str) -> Dict[str, Any]:
    return {
        "supplier_name": "", "supplier_gstin": "", "buyer_name": "", "buyer_gstin": "", "invoice_no": "",
        "invoice_date": "", "taxable_amount": 0.0, "cgst_amount": 0.0, "sgst_amount": 0.0, "igst_amount": 0.0,
        "cess_amount": 0.0, "total_gst": 0.0, "round_off": 0.0, "grand_total": 0.0, "reconciled": False,
        "document_type": "tax_invoice", "all_gstins": [], "parse_confidence": 0.0, "raw_text_excerpt": "",
    }


async def read_purchase_invoice(contents: bytes, filename: str, known_parties: Optional[List[Dict[str, Any]]] = None,
                                use_ai: bool = True) -> Dict[str, Any]:
    """
    Read one uploaded invoice and return the normalised fields, the way they
    were obtained (`extraction_method`), a confidence, and validation warnings.
    Never raises for unreadable input — returns a blank, fully-warned result so
    the UI can still open the editable preview.
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    method, pages_n = "none", 0
    text = ""
    if ext == "pdf":
        text, pages_n = extract_pdf_text(contents)
    elif ext in ("txt", "csv"):
        text = contents.decode("utf-8", errors="replace")

    parsed: Optional[Dict[str, Any]] = None
    if text.strip():
        parsed = parse_invoice_text(text, known_parties)
        method = "text"

    images: List[Tuple[bytes, str]] = []
    if (not text.strip() or not _complete(parsed)) and ext in ("pdf", "png", "jpg", "jpeg", "webp"):
        if not text.strip():
            images = render_pages(contents, ext, resolution=OCR_DPI)
            pages_n = pages_n or len(images)
            ocr_text = await ocr_pages(images)
            if ocr_text.strip() and ocr_quality(ocr_text) >= 4:
                parsed = parse_invoice_text(ocr_text, known_parties)
                method = "ocr"
            elif ocr_text.strip():
                logger.info("OCR text for %s is too noisy (quality=%s) - not trusting it", filename, ocr_quality(ocr_text))

    ai: Dict[str, Any] = {}
    if use_ai and not _complete(parsed) and ext in ("pdf", "png", "jpg", "jpeg", "webp") and ai_configured():
        if not images:
            images = render_pages(contents, ext)
        ai = await ai_extract(images, known_parties)
        if ai:
            method = f"{method}+ai" if parsed else "ai"

    result = merge_results(parsed, ai) if (parsed or ai) else _blank_result(filename)
    if not result:
        result = _blank_result(filename)

    result.setdefault("due_date", "")
    result.setdefault("place_of_supply", "")
    result["file_name"] = filename
    result["extraction_method"] = method
    result["pages"] = pages_n
    result["ai_used"] = bool(ai)
    result["ocr_available"] = tesseract_available()
    result["ai_available"] = ai_configured()
    warnings = validate_extraction(result)
    warnings.extend(result.pop("merge_notes", []) or [])
    if method == "none":
        why = ("the scan is too faint / not in English and the AI reader could not read it either"
               if result.get("ai_available") else
               "it is a scan or photo and no AI reader is configured (set GEMINI_API_KEY or GROQ_API_KEY)")
        warnings.insert(0, _w("file", "unreadable", "error",
                              f"This file could not be read automatically: {why}. "
                              "Fill the fields by hand while looking at the document shown next to the form."))
    elif method in ("ocr", "ai", "ocr+ai", "text+ai") and result.get("parse_confidence", 0) < 0.8:
        warnings.append(_w("file", "low_confidence", "warn", "Read from a scan — please double-check every figure against the document."))
    result["warnings"] = warnings
    result["needs_review"] = review_needed(warnings, float(result.get("parse_confidence") or 0))
    result["parse_confidence"] = float(result.get("parse_confidence") or 0)
    return result
