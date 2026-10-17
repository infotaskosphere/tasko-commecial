"""Finix invoice learning — a per-company memory of confirmed purchase decisions.

What this is (and is not)
-------------------------
This is a *memory of decisions people confirmed or corrected*, not a trained
neural model. Every confirmed purchase bill teaches Finix three things about
that vendor, inside that company only:

  1. which expense ledger and GST rate the vendor's bills end up in,
  2. how that vendor lays out its invoices (the labels next to the invoice
     number, date, taxable value and total, and the shape of its invoice
     numbers) so the next read from that vendor can be helped,
  3. whether Finix's own proposal was right (the straight-through rate).

Guardrails
----------
* Learned memory only *suggests*. Locked periods, the balance check, GST
  rules and posting permissions are enforced elsewhere and are not touched.
* Everything is keyed by ``company_id``; the collections are tenant
  collections, so one company can never see or inherit another's habits.
* Nothing is auto-applied below high confidence (see ``auto_apply``): at
  least ``MIN_CONFIRMS`` confirmations, a clean streak, and a dominant ledger.
* A correction counts for more than an approval, resets the clean streak and
  therefore sends the vendor's next bill back for review.
* The audit log (``finix_learning_events``) is append-only; an admin can reset
  one vendor's memory, and the reset itself is logged.

Nothing in here raises into a posting path: callers wrap learning in
try/except, and every public coroutine here also guards its own failures.
"""
from __future__ import annotations

import logging
import re
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from backend.dependencies import db

logger = logging.getLogger(__name__)

COLL_MEMORY = "finix_vendor_memory"
COLL_EVENTS = "finix_learning_events"

MIN_CONFIRMS = 3              # confirmations before a vendor can be auto-filled
CLEAN_STREAK = 3              # consecutive uncorrected confirmations needed to auto-fill
AUTO_CONFIDENCE = 0.75        # minimum confidence to auto-fill
CORRECTION_WEIGHT = 3.0       # a correction outweighs three plain approvals
STALE_DECAY = 0.25            # on a correction, the ledgers it moved away from keep a quarter of their weight
APPROVAL_WEIGHT = 1.0
BANK_REINFORCE_WEIGHT = 0.5
LAYOUT_MIN_COUNT = 2          # a label must be seen this often before it is used
SHAPE_MIN_SAMPLES = 3
GST_DOMINANT_SHARE = 0.8
GST_SLABS = (0, 0.25, 3, 5, 12, 18, 28)
MIN_BILLS_FOR_VENDOR_STATS = 3
TREND_MIN_BILLS = 5

# The invoice fields a person can correct on the preview form. Edits to anything
# else (company, client, ledger pick…) are not "the reader got the bill wrong".
TRACKED_FIELDS = (
    "supplier_name", "supplier_gstin", "buyer_name", "buyer_gstin", "invoice_no", "invoice_date", "due_date",
    "taxable_amount", "cgst_amount", "sgst_amount", "igst_amount", "cess_amount", "total_gst", "round_off",
    "grand_total", "place_of_supply", "document_type", "currency",
)
LAYOUT_FIELDS = ("invoice_no", "invoice_date", "taxable_amount", "grand_total")
_AMOUNT_LAYOUT = ("taxable_amount", "grand_total")

_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")


# ───────────────────────────── helpers ─────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pr():
    from backend import purchase_reader
    return purchase_reader


def norm_vendor_name(name: str) -> str:
    try:
        return _pr().norm_name(name or "")
    except Exception:
        return " ".join(re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower()).split())


def vendor_key(gstin: str = "", name: str = "") -> str:
    """GSTIN is the identity when we have a valid one; otherwise the normalised name."""
    g = (gstin or "").strip().upper()
    if g and _GSTIN_RE.match(g):
        return f"gstin:{g}"
    n = norm_vendor_name(name)
    return f"name:{n}" if n else ""


def invoice_shape(invoice_no: str) -> str:
    """'INV/23-24/0045' -> 'A/#-#/#' : digits and letters collapsed so numbering style can be compared."""
    s = (invoice_no or "").strip()
    if not s:
        return ""
    out: List[str] = []
    for ch in s:
        c = "#" if ch.isdigit() else ("A" if ch.isalpha() else ch)
        if not out or out[-1] != c:
            out.append(c)
    return "".join(out)


def snap_gst_rate(taxable: float, total_gst: float) -> Optional[float]:
    """The GST slab a bill is at, or None when it cannot be told (zero value, odd rate)."""
    try:
        taxable, total_gst = float(taxable or 0), float(total_gst or 0)
    except (TypeError, ValueError):
        return None
    if taxable <= 0 or total_gst < 0:
        return None
    raw = total_gst / taxable * 100
    best = min(GST_SLABS, key=lambda s: abs(s - raw))
    # allow a little slack for rounding on small bills, but never invent a slab for an odd rate
    tol = max(0.35, 1.5 / taxable * 100)
    return float(best) if abs(best - raw) <= tol else None


def _rate_key(rate: float) -> str:
    return _enc(f"{rate:g}")


def _enc(key: str) -> str:
    """MongoDB (before 5.0) rejects '.' and a leading '$' in embedded field names; vendor names and
    invoice labels contain both, so they are stored with look-alike characters and decoded for display."""
    k = str(key).replace(".", "\uff0e")
    return ("\uff04" + k[1:]) if k.startswith("$") else k


def _dec(key: str) -> str:
    k = str(key).replace("\uff0e", ".")
    return ("$" + k[1:]) if k.startswith("\uff04") else k


def _clean_edits(edited_fields: Iterable[str]) -> List[str]:
    return sorted({str(f) for f in (edited_fields or []) if str(f) in TRACKED_FIELDS})


def _top(counts: Dict[str, Any]) -> Tuple[Optional[str], float, float]:
    """(key, weight, total_weight) of the heaviest entry; ties go to the most recently seen."""
    best_k, best_w, best_t, total = None, 0.0, "", 0.0
    for k, v in (counts or {}).items():
        w = float(v.get("w", 0)) if isinstance(v, dict) else float(v or 0)
        t = str(v.get("last_at", "")) if isinstance(v, dict) else ""
        total += w
        if w > best_w or (w == best_w and w > 0 and t > best_t):
            best_k, best_w, best_t = k, w, t
    return best_k, best_w, total


# ───────────────────────────── memory access ─────────────────────────────

async def get_memory(company_id: str, gstin: str = "", name: str = "") -> Optional[dict]:
    """The vendor's memory for this company: by GSTIN first, then by name."""
    if not company_id:
        return None
    keys = [k for k in (vendor_key(gstin, ""), vendor_key("", name)) if k]
    for k in keys:
        doc = await db[COLL_MEMORY].find_one({"company_id": company_id, "vendor_key": k}, {"_id": 0})
        if doc:
            return doc
    return None


async def _get_or_create_memory(company_id: str, gstin: str, name: str) -> Optional[dict]:
    key = vendor_key(gstin, name)
    if not key:
        return None
    mem = await get_memory(company_id, gstin, name)
    if mem:
        # a vendor first seen without a GSTIN is promoted to the GSTIN key once one is known
        if key.startswith("gstin:") and mem["vendor_key"] != key:
            await db[COLL_MEMORY].update_one(
                {"company_id": company_id, "vendor_key": mem["vendor_key"]},
                {"$set": {"vendor_key": key, "gstin": (gstin or "").strip().upper(), "updated_at": _now()}})
            mem["vendor_key"], mem["gstin"] = key, (gstin or "").strip().upper()
        return mem
    mem = {
        "id": str(uuid.uuid4()), "company_id": company_id, "vendor_key": key,
        "gstin": (gstin or "").strip().upper() if key.startswith("gstin:") else "",
        "display_name": (name or "").strip(), "names": {},
        "ledger": {}, "gst_rate": {},
        "stats": {"confirmations": 0, "straight_through": 0, "corrections": 0, "clean_streak": 0,
                  "bank_signals": 0, "last_correction_at": "", "last_confirmed_at": ""},
        "layout": {"labels": {f: {} for f in LAYOUT_FIELDS}, "invoice_no_shapes": {}, "samples": 0},
        "created_at": _now(), "updated_at": _now(),
    }
    await db[COLL_MEMORY].insert_one(dict(mem))
    return mem


async def _log(company_id: str, event: str, **fields: Any) -> dict:
    doc = {"id": str(uuid.uuid4()), "company_id": company_id, "event": event, "at": _now(), **fields}
    try:
        await db[COLL_EVENTS].insert_one(dict(doc))
    except Exception as ex:                                   # an audit-log failure must never block a save
        logger.warning("learning event %s not stored: %s", event, ex)
    return doc


# ───────────────────────────── suggestions ─────────────────────────────

def _suggest_from_memory(mem: Optional[dict]) -> dict:
    empty = {"code": "", "name": "", "confidence": 0.0, "auto_apply": False, "requires_review": False,
             "confirmations": 0, "reason": "", "vendor_key": ""}
    if not mem:
        return empty
    st = mem.get("stats") or {}
    n = int(st.get("confirmations") or 0)
    code, w, total = _top(mem.get("ledger") or {})
    if not code or total <= 0 or n <= 0:
        return {**empty, "vendor_key": mem.get("vendor_key", "")}
    share = w / total
    confidence = round(share * (1 - 1 / (n + 1)), 4)
    streak = int(st.get("clean_streak") or 0)
    auto = n >= MIN_CONFIRMS and confidence >= AUTO_CONFIDENCE and streak >= CLEAN_STREAK
    if auto:
        reason = f"Used for your last {streak} bills from this vendor without changes."
    elif n < MIN_CONFIRMS:
        reason = f"Seen {n} confirmed bill(s) from this vendor — Finix needs {MIN_CONFIRMS} before it fills this in by itself."
    elif streak < CLEAN_STREAK and st.get("last_correction_at"):
        reason = "You changed the ledger on this vendor recently, so Finix is asking you to confirm it again."
    else:
        reason = "This vendor's bills have not always gone to the same ledger, so Finix is asking you to confirm."
    return {
        "code": _dec(code), "name": (mem["ledger"][code] or {}).get("name", ""), "confidence": confidence,
        "auto_apply": auto, "requires_review": not auto, "confirmations": n, "reason": reason,
        "vendor_key": mem.get("vendor_key", ""),
    }


async def suggest_ledger(company_id: str, gstin: str = "", name: str = "") -> dict:
    """What this company's own history says about where the vendor's bills go. Never raises."""
    try:
        return _suggest_from_memory(await get_memory(company_id, gstin, name))
    except Exception as ex:
        logger.warning("suggest_ledger failed: %s", ex)
        return _suggest_from_memory(None)


def gst_rate_warning(mem: Optional[dict], taxable: float, total_gst: float) -> Optional[dict]:
    """Warn when this bill's GST rate differs from the rate the vendor nearly always charges."""
    if not mem:
        return None
    rate = snap_gst_rate(taxable, total_gst)
    if rate is None:
        return None
    counts = mem.get("gst_rate") or {}
    code, w, total = _top(counts)
    n = sum(int((v or {}).get("n", 0)) if isinstance(v, dict) else int(v or 0) for v in counts.values())
    if not code or n < MIN_CONFIRMS or total <= 0 or w / total < GST_DOMINANT_SHARE:
        return None
    usual = float(_dec(code))
    if abs(usual - rate) < 0.01:
        return None
    return {"field": "total_gst", "code": "gst_rate_unusual", "severity": "warn",
            "message": f"This bill is at {rate:g}% GST, but this vendor's last {n} bills were at {usual:g}%. Check the tax amounts."}


def invoice_no_warning(mem: Optional[dict], invoice_no: str) -> Optional[dict]:
    """Warn when the invoice number does not look like this vendor's usual numbering."""
    shapes = ((mem or {}).get("layout") or {}).get("invoice_no_shapes") or {}
    total = sum(int(v or 0) for v in shapes.values())
    shape = invoice_shape(invoice_no)
    if not shape or total < SHAPE_MIN_SAMPLES or _enc(shape) in shapes:
        return None
    top = max(shapes.items(), key=lambda kv: kv[1])
    if top[1] / total < GST_DOMINANT_SHARE:
        return None
    return {"field": "invoice_no", "code": "invoice_no_unusual", "severity": "info",
            "message": f"This vendor's invoice numbers usually look like \"{_dec(top[0])}\" and this one does not. Check it was read correctly."}


# ───────────────────────────── layout learning ─────────────────────────────

_LABEL_JUNK = re.compile(r"[^a-z .\-/&']+")


def _clean_label(raw: str) -> str:
    s = (raw or "").lower()
    s = re.sub(r"\d+", " ", s)
    s = _LABEL_JUNK.sub(" ", s)
    s = " ".join(s.split())
    s = s.strip(" .-/&'")
    # keep the last few words — the label sits right next to the value
    words = s.split()
    s = " ".join(words[-4:])
    return s if 3 <= len(s) <= 40 else ""


def _norm_inv(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _value_label(field: str, value: Any, lines: List[str]) -> str:
    """The label printed beside `value` in the invoice text, or ''."""
    pr = _pr()
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        start = -1
        if field == "invoice_date":
            iso = str(value or "")[:10]
            for s, _e, d in pr.find_dates(line):
                if d.isoformat() == iso:
                    start = s
                    break
        elif field in _AMOUNT_LAYOUT:
            try:
                target = float(value)
            except (TypeError, ValueError):
                return ""
            # the rightmost match: totals sit at the end of a labelled row
            for v, s, _e, _dec in money_tokens_safe(line):
                if abs(v - target) < 0.005:
                    start = s
        elif field == "invoice_no":
            v = str(value or "").strip()
            if len(v) < 3:
                return ""
            m = re.search(re.escape(v), line, re.I)
            start = m.start() if m else -1
        if start < 0:
            continue
        label = _clean_label(line[:start])
        if not label and i > 0:                                # value alone on its line: label is the line above
            label = _clean_label(lines[i - 1])
        if label:
            return label
    return ""


def money_tokens_safe(line: str):
    try:
        return _pr().money_tokens(line)
    except Exception:
        return []


def extract_layout_signals(raw_text: str, final: Dict[str, Any]) -> Dict[str, Any]:
    """Labels printed next to the confirmed values of this bill (for layout learning)."""
    lines = (raw_text or "").splitlines()[:400]
    labels: Dict[str, str] = {}
    if lines:
        for f in LAYOUT_FIELDS:
            v = final.get(f)
            if v in (None, "", 0, 0.0):
                continue
            try:
                lab = _value_label(f, v, lines)
            except Exception:
                lab = ""
            if lab:
                labels[f] = lab
    return {"labels": labels, "shape": invoice_shape(str(final.get("invoice_no") or ""))}


def apply_layout(mem: Optional[dict], raw_text: str, extracted: Dict[str, Any]) -> Tuple[Dict[str, Any], List[dict]]:
    """Use this vendor's learned labels to fill fields the reader left empty, and to flag disagreements.

    Returns (fills, notes): `fills` is {field: value} for EMPTY fields only; `notes` are warnings.
    The reader's own value is never overwritten.
    """
    fills: Dict[str, Any] = {}
    notes: List[dict] = []
    layout = (mem or {}).get("layout") or {}
    lines = (raw_text or "").splitlines()[:400]
    if not lines or not layout.get("labels"):
        return fills, notes
    pr = _pr()
    for f in LAYOUT_FIELDS:
        cands = sorted(((_dec(lab), int(c or 0)) for lab, c in (layout["labels"].get(f) or {}).items() if int(c or 0) >= LAYOUT_MIN_COUNT),
                       key=lambda t: -t[1])
        if not cands:
            continue
        found: Any = None
        used = ""
        for lab, _c in cands:
            rx = re.compile(r"\b" + r"\s+".join(re.escape(w) for w in lab.split()) + r"\b", re.I)
            for i, line in enumerate(lines):
                m = rx.search(line)
                if not m:
                    continue
                tail = line[m.end():]
                segs = [tail] + ([lines[i + 1]] if i + 1 < len(lines) else [])
                for seg in segs:
                    if f == "invoice_date":
                        ds = pr.find_dates(seg)
                        if ds:
                            found = ds[0][2].isoformat()
                    elif f in _AMOUNT_LAYOUT:
                        toks = [t for t in money_tokens_safe(seg) if t[0] > 0]
                        if toks:
                            found = round(float(toks[-1][0]), 2) if seg is tail else round(float(toks[0][0]), 2)
                    else:
                        mm = re.match(r"[\s:#.\-]*([A-Za-z0-9][A-Za-z0-9/\-_.]{2,29})", seg)
                        if mm and any(ch.isdigit() for ch in mm.group(1)):
                            found = mm.group(1).rstrip(".-/_")
                    if found not in (None, ""):
                        break
                if found not in (None, ""):
                    used = lab
                    break
            if found not in (None, ""):
                break
        if found in (None, ""):
            continue
        current = extracted.get(f)
        empty = current in (None, "", 0, 0.0)
        if empty:
            fills[f] = found
            notes.append({"field": f, "code": "layout_filled", "severity": "info",
                          "message": f"Filled from this vendor's usual layout (\"{used}\"). Check it is right."})
        else:
            same = (str(current)[:10] == str(found)[:10]) if f == "invoice_date" else (
                abs(float(current) - float(found)) < 0.01 if f in _AMOUNT_LAYOUT else _norm_inv(str(current)) == _norm_inv(str(found)))
            if not same and f in ("grand_total", "invoice_no"):
                notes.append({"field": f, "code": "layout_differs", "severity": "info",
                              "message": f"This vendor's usual \"{used}\" row reads {found}, but the bill was read as {current}. Check which is right."})
    return fills, notes


# ───────────────────────────── learning from a confirmed bill ─────────────────────────────

def _decay_others(counts: Dict[str, Any], keep: str) -> None:
    """A correction says the old habit is out of date: shrink every other ledger's weight."""
    for k, v in counts.items():
        if k != keep and isinstance(v, dict):
            v["w"] = round(float(v.get("w", 0)) * STALE_DECAY, 3)


def _bump(counts: Dict[str, Any], key: str, weight: float, *, name: str = "", at: str = "") -> None:
    cur = counts.get(key)
    if not isinstance(cur, dict):
        cur = {"w": float(cur or 0), "n": 0}
    cur["w"] = round(float(cur.get("w", 0)) + weight, 3)
    cur["n"] = int(cur.get("n", 0)) + 1
    cur["last_at"] = at or _now()
    if name:
        cur["name"] = name
    counts[key] = cur


async def learn_from_confirmed_bill(company_id: str, bill: dict, *, proposed: Optional[dict] = None,
                                    edited_fields: Optional[Iterable[str]] = None, user_id: str = "") -> Optional[dict]:
    """Record one confirmed purchase bill. Called AFTER the bill is saved. Never raises.

    `proposed` is what Finix suggested for the ledger: {code, source: 'learned'|'rules', confidence, auto_applied}.
    `edited_fields` are the fields a person changed on the preview form compared with what was read.
    """
    try:
        if not company_id or not bill:
            return None
        gstin, name = bill.get("supplier_gstin") or "", bill.get("supplier_name") or ""
        key = vendor_key(gstin, name)
        if not key:
            return None
        final_code = (bill.get("expense_ledger_code") or "").strip()
        final_name = bill.get("expense_ledger_name") or ""
        proposed = proposed or {}
        prop_code = (proposed.get("code") or "").strip()
        ledger_corrected = bool(prop_code and final_code and prop_code != final_code)
        # Only changing what Finix proposed FROM ITS MEMORY counts against the memory. Overriding a first-time
        # keyword guess just tells Finix the right answer (it is still marked wrong for the accuracy score).
        memory_correction = ledger_corrected and proposed.get("source") == "learned"
        edits = _clean_edits(edited_fields or [])
        read_by_machine = bill.get("source") == "upload"
        straight = bool(read_by_machine and not edits and not ledger_corrected)
        at = _now()

        mem = await _get_or_create_memory(company_id, gstin, name)
        if not mem:
            return None
        st = mem.setdefault("stats", {})
        st["confirmations"] = int(st.get("confirmations") or 0) + 1
        if straight:
            st["straight_through"] = int(st.get("straight_through") or 0) + 1
        st["last_confirmed_at"] = at
        if memory_correction:
            st["corrections"] = int(st.get("corrections") or 0) + 1
            st["clean_streak"] = 0
            st["last_correction_at"] = at
        else:
            st["clean_streak"] = int(st.get("clean_streak") or 0) + 1

        if final_code:
            if memory_correction:
                _decay_others(mem.setdefault("ledger", {}), _enc(final_code))
            _bump(mem.setdefault("ledger", {}), _enc(final_code), CORRECTION_WEIGHT if memory_correction else APPROVAL_WEIGHT,
                  name=final_name, at=at)
        rate = snap_gst_rate(bill.get("taxable_amount"), bill.get("total_gst"))
        if rate is not None:
            _bump(mem.setdefault("gst_rate", {}), _rate_key(rate), APPROVAL_WEIGHT, at=at)
        nm = (name or "").strip()
        if nm:
            _bump(mem.setdefault("names", {}), _enc(nm), 1.0, at=at)
            top_name, _, _ = _top(mem["names"])
            mem["display_name"] = _dec(top_name) if top_name else nm

        # layout: only when we actually have the bill text
        sig = extract_layout_signals(bill.get("raw_text_excerpt") or "", bill)
        layout = mem.setdefault("layout", {"labels": {f: {} for f in LAYOUT_FIELDS}, "invoice_no_shapes": {}, "samples": 0})
        if sig["labels"] or sig["shape"]:
            layout["samples"] = int(layout.get("samples") or 0) + 1
        for f, lab in sig["labels"].items():
            bucket = layout.setdefault("labels", {}).setdefault(f, {})
            bucket[_enc(lab)] = int(bucket.get(_enc(lab), 0)) + 1
        if sig["shape"]:
            sh = layout.setdefault("invoice_no_shapes", {})
            sh[_enc(sig["shape"])] = int(sh.get(_enc(sig["shape"]), 0)) + 1

        mem["updated_at"] = at
        await db[COLL_MEMORY].update_one(
            {"company_id": company_id, "vendor_key": mem["vendor_key"]},
            {"$set": {k: mem[k] for k in ("display_name", "names", "ledger", "gst_rate", "stats", "layout", "updated_at")}})

        await _log(
            company_id, "confirm", vendor_key=mem["vendor_key"], vendor_name=mem.get("display_name") or name,
            bill_id=bill.get("id", ""), user_id=user_id, bill_source=bill.get("source", ""),
            read_by_machine=read_by_machine, edited_fields=edits, edited_count=len(edits),
            ledger_proposed=prop_code, ledger_final=final_code, ledger_corrected=ledger_corrected,
            proposal_source=proposed.get("source", ""), proposal_confidence=float(proposed.get("confidence") or 0),
            auto_applied=bool(proposed.get("auto_applied")), straight_through=straight)
        return {"vendor_key": mem["vendor_key"], "straight_through": straight, "ledger_corrected": ledger_corrected}
    except Exception as ex:
        logger.warning("Finix learning (confirm) skipped: %s", ex)
        return None


async def record_ledger_signal(company_id: str, *, gstin: str = "", name: str = "", to_code: str, to_name: str = "",
                               from_code: str = "", signal: str = "edit", user_id: str = "",
                               ref: str = "", create: bool = False) -> Optional[dict]:
    """A later, post-save signal about a vendor's ledger.

    signal = 'edit'       a person re-pointed a saved bill to another ledger  -> correction
             'adjustment' an Adjustment Note re-posted the bill elsewhere      -> correction
             'bank'       a bank categorisation / match to this vendor         -> confirmation, or a conflict
    `create=False` means no new memory is started from a bank signal alone.
    """
    try:
        if not company_id or not to_code:
            return None
        if ref:
            if await db[COLL_EVENTS].find_one({"company_id": company_id, "event": "ledger_signal", "ref": ref, "signal": signal}):
                return {"duplicate": True}                       # the same bank line / note is never counted twice
        mem = await get_memory(company_id, gstin, name) if not create else await _get_or_create_memory(company_id, gstin, name)
        if not mem:
            return None
        at = _now()
        st = mem.setdefault("stats", {})
        top_code, _, _ = _top(mem.get("ledger") or {})
        agrees = bool(top_code) and _dec(top_code) == to_code
        if signal in ("edit", "adjustment"):
            if from_code and from_code == to_code:
                return None
            outcome = "correction"
            _decay_others(mem.setdefault("ledger", {}), _enc(to_code))
            _bump(mem.setdefault("ledger", {}), _enc(to_code), CORRECTION_WEIGHT, name=to_name, at=at)
            st["corrections"] = int(st.get("corrections") or 0) + 1
            st["confirmations"] = max(int(st.get("confirmations") or 0), 1)   # an explicit decision is evidence
            st["clean_streak"] = 0
            st["last_correction_at"] = at
        else:
            st["bank_signals"] = int(st.get("bank_signals") or 0) + 1
            if agrees:
                outcome = "confirmation"
                _bump(mem.setdefault("ledger", {}), _enc(to_code), BANK_REINFORCE_WEIGHT, name=to_name, at=at)
            else:
                outcome = "conflict"                             # not enough to flip the ledger, enough to ask again
                st["clean_streak"] = 0
                st["last_correction_at"] = at
        mem["updated_at"] = at
        await db[COLL_MEMORY].update_one(
            {"company_id": company_id, "vendor_key": mem["vendor_key"]},
            {"$set": {"ledger": mem.get("ledger", {}), "stats": st, "updated_at": at}})
        await _log(company_id, "ledger_signal", vendor_key=mem["vendor_key"], signal=signal, outcome=outcome,
                   ledger_from=from_code, ledger_to=to_code, user_id=user_id, ref=ref)
        return {"outcome": outcome, "vendor_key": mem["vendor_key"]}
    except Exception as ex:
        logger.warning("Finix learning (%s signal) skipped: %s", signal, ex)
        return None


async def find_vendor_by_text(company_id: str, text: str) -> Optional[dict]:
    """Which learned vendor does a bank line like 'UPI/AWS INDIA/1234' belong to? Name containment only."""
    try:
        hay = " " + norm_vendor_name(text) + " "
        if len(hay.strip()) < 4:
            return None
        best: Optional[dict] = None
        async for m in db[COLL_MEMORY].find({"company_id": company_id}, {"_id": 0}):
            nm = norm_vendor_name(m.get("display_name") or "")
            if len(nm) >= 4 and f" {nm} " in hay and (best is None or len(nm) > len(norm_vendor_name(best.get("display_name") or ""))):
                best = m
        return best
    except Exception as ex:
        logger.warning("find_vendor_by_text failed: %s", ex)
        return None


async def learn_from_bank_categorization(company_id: str, description: str, ledger_code: str, ledger_name: str = "",
                                         *, txn_id: str = "", user_id: str = "") -> Optional[dict]:
    mem = await find_vendor_by_text(company_id, description)
    if not mem:
        return None
    return await record_ledger_signal(company_id, gstin=mem.get("gstin", ""), name=mem.get("display_name", ""),
                                      to_code=ledger_code, to_name=ledger_name, signal="bank", user_id=user_id,
                                      ref=f"bank:{txn_id}" if txn_id else "")


async def learn_from_bank_bill_match(company_id: str, bill: dict, *, txn_id: str = "", user_id: str = "") -> Optional[dict]:
    """A bank payment matched to a purchase bill: the bill (and its ledger) was accepted as real."""
    code = (bill or {}).get("expense_ledger_code") or ""
    if not code:
        return None
    return await record_ledger_signal(company_id, gstin=bill.get("supplier_gstin", ""), name=bill.get("supplier_name", ""),
                                      to_code=code, to_name=bill.get("expense_ledger_name", ""), signal="bank",
                                      user_id=user_id, ref=f"bankbill:{txn_id}:{bill.get('id', '')}" if txn_id else "")


# ───────────────────────────── metrics ─────────────────────────────

def _week_start(iso: str) -> str:
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00")).date()
    except ValueError:
        return ""
    return (d - timedelta(days=d.weekday())).isoformat()


def _rate(a: int, b: int) -> Optional[float]:
    return round(a / b * 100, 1) if b else None


async def accuracy_report(company_id: str, days: int = 90) -> dict:
    """How often Finix got the bill right first time — overall, per vendor, and over time."""
    days = max(7, min(int(days or 90), 730))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    events = await db[COLL_EVENTS].find({"company_id": company_id, "event": "confirm", "at": {"$gte": since}}, {"_id": 0}).to_list(20000)
    signals = await db[COLL_EVENTS].find({"company_id": company_id, "event": "ledger_signal", "at": {"$gte": since}}, {"_id": 0}).to_list(20000)

    read = [e for e in events if e.get("read_by_machine")]
    st_n = sum(1 for e in read if e.get("straight_through"))
    field_edits: Dict[str, int] = defaultdict(int)
    for e in read:
        for f in e.get("edited_fields") or []:
            field_edits[f] += 1

    with_prop = [e for e in events if e.get("ledger_proposed")]
    led_ok = sum(1 for e in with_prop if not e.get("ledger_corrected"))
    by_src: Dict[str, Dict[str, int]] = {"learned": {"n": 0, "ok": 0}, "rules": {"n": 0, "ok": 0}}
    for e in with_prop:
        s = "learned" if e.get("proposal_source") == "learned" else "rules"
        by_src[s]["n"] += 1
        by_src[s]["ok"] += 0 if e.get("ledger_corrected") else 1

    weeks: Dict[str, Dict[str, int]] = defaultdict(lambda: {"n": 0, "st": 0})
    for e in read:
        w = _week_start(e.get("at", ""))
        if w:
            weeks[w]["n"] += 1
            weeks[w]["st"] += 1 if e.get("straight_through") else 0
    trend = [{"week": w, "bills": v["n"], "straight_through": v["st"], "rate": _rate(v["st"], v["n"])} for w, v in sorted(weeks.items())]

    improvement = None
    if trend:
        last_w = datetime.fromisoformat(trend[-1]["week"]).date()
        cut = (last_w - timedelta(weeks=3)).isoformat()
        prior_cut = (last_w - timedelta(weeks=7)).isoformat()
        recent = [t for t in trend if t["week"] >= cut]
        prior = [t for t in trend if prior_cut <= t["week"] < cut]
        rn, rs = sum(t["bills"] for t in recent), sum(t["straight_through"] for t in recent)
        pn, ps = sum(t["bills"] for t in prior), sum(t["straight_through"] for t in prior)
        if rn >= TREND_MIN_BILLS and pn >= TREND_MIN_BILLS:
            improvement = round(rs / rn * 100 - ps / pn * 100, 1)

    per_vendor: Dict[str, dict] = {}
    for e in events:
        v = per_vendor.setdefault(e.get("vendor_key", ""), {"vendor_key": e.get("vendor_key", ""), "vendor_name": e.get("vendor_name", ""),
                                                            "bills": 0, "read": 0, "straight_through": 0, "ledger_checked": 0, "ledger_correct": 0})
        v["bills"] += 1
        v["vendor_name"] = e.get("vendor_name") or v["vendor_name"]
        if e.get("read_by_machine"):
            v["read"] += 1
            v["straight_through"] += 1 if e.get("straight_through") else 0
        if e.get("ledger_proposed"):
            v["ledger_checked"] += 1
            v["ledger_correct"] += 0 if e.get("ledger_corrected") else 1
    mems = {m["vendor_key"]: m async for m in db[COLL_MEMORY].find({"company_id": company_id}, {"_id": 0})}
    vendors = []
    for k, v in per_vendor.items():
        m = mems.get(k)
        sug = _suggest_from_memory(m) if m else None
        vendors.append({**v, "straight_through_rate": _rate(v["straight_through"], v["read"]),
                        "ledger_accuracy": _rate(v["ledger_correct"], v["ledger_checked"]),
                        "auto_fill_active": bool(sug and sug["auto_apply"]),
                        "learned_ledger": (sug or {}).get("name") or (sug or {}).get("code") or ""})
    needs_attention = sorted([v for v in vendors if v["read"] >= MIN_BILLS_FOR_VENDOR_STATS and v["straight_through_rate"] is not None],
                             key=lambda v: (v["straight_through_rate"], -v["read"]))[:5]
    for v in vendors:
        v["needs_attention"] = v in needs_attention and v["straight_through_rate"] < 80

    state = {"vendors_known": len(mems),
             "vendors_auto_filling": sum(1 for m in mems.values() if _suggest_from_memory(m)["auto_apply"]),
             "layouts_learned": sum(1 for m in mems.values() if any(len(b) and max(b.values()) >= LAYOUT_MIN_COUNT
                                                                    for b in ((m.get("layout") or {}).get("labels") or {}).values()))}
    return {
        "window_days": days,
        "bills_reviewed": len(events), "bills_read_by_finix": len(read),
        "straight_through": st_n, "straight_through_rate": _rate(st_n, len(read)),
        "ledger": {"proposals": len(with_prop), "correct": led_ok, "accuracy": _rate(led_ok, len(with_prop)),
                   "learned": {**by_src["learned"], "accuracy": _rate(by_src["learned"]["ok"], by_src["learned"]["n"])},
                   "rules": {**by_src["rules"], "accuracy": _rate(by_src["rules"]["ok"], by_src["rules"]["n"])}},
        "field_edits": dict(sorted(field_edits.items(), key=lambda kv: -kv[1])),
        "trend": trend, "improvement_points": improvement,
        "improvement_note": ("Compares the last 4 weeks with the 4 before." if improvement is not None
                             else f"Not enough bills yet to show a trend (needs {TREND_MIN_BILLS}+ in each 4-week window)."),
        "post_save_signals": {"corrections": sum(1 for s in signals if s.get("outcome") == "correction"),
                              "confirmations": sum(1 for s in signals if s.get("outcome") == "confirmation"),
                              "conflicts": sum(1 for s in signals if s.get("outcome") == "conflict")},
        "state": state,
        "vendors": sorted(vendors, key=lambda v: -v["bills"])[:100],
        "how_it_works": "Finix keeps a memory of the decisions you confirm or correct, per company and per vendor. "
                        "It is not a trained AI model, and it only suggests: posting rules, GST checks and period locks are unchanged.",
    }


async def list_vendor_memory(company_id: str) -> List[dict]:
    out = []
    async for m in db[COLL_MEMORY].find({"company_id": company_id}, {"_id": 0}):
        sug = _suggest_from_memory(m)
        st = m.get("stats") or {}
        gst_top, _, _ = _top(m.get("gst_rate") or {})
        labels = ((m.get("layout") or {}).get("labels") or {})
        out.append({
            "vendor_key": m["vendor_key"], "vendor_name": m.get("display_name") or "", "gstin": m.get("gstin") or "",
            "confirmations": int(st.get("confirmations") or 0), "straight_through": int(st.get("straight_through") or 0),
            "corrections": int(st.get("corrections") or 0), "clean_streak": int(st.get("clean_streak") or 0),
            "ledger_code": sug["code"], "ledger_name": sug["name"], "confidence": sug["confidence"],
            "auto_fill_active": sug["auto_apply"], "reason": sug["reason"],
            "usual_gst_rate": float(_dec(gst_top)) if gst_top else None,
            "layout_labels": {f: _dec(max(b.items(), key=lambda kv: kv[1])[0]) for f, b in labels.items()
                              if b and max(b.values()) >= LAYOUT_MIN_COUNT},
            "last_confirmed_at": st.get("last_confirmed_at", ""), "last_correction_at": st.get("last_correction_at", ""),
        })
    return sorted(out, key=lambda v: -v["confirmations"])


async def reset_vendor(company_id: str, vendor_key_: str, user_id: str = "") -> bool:
    """Forget what was learned about one vendor. The audit log of past events is kept."""
    res = await db[COLL_MEMORY].delete_one({"company_id": company_id, "vendor_key": vendor_key_})
    if getattr(res, "deleted_count", 0):
        await _log(company_id, "reset", vendor_key=vendor_key_, user_id=user_id)
        return True
    return False
