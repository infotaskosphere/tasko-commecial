"""
backend/trademark_sphere.py
---------------------------
Dual-source trademark scraper:

  Source 1 - QuickCompany  (https://www.quickcompany.in/trademarks/{app_no}-{slug})
             Full HTML page scrape via BeautifulSoup. No login, no OTP.
             Used for: single-mark lookup, auto-add, refresh.

  Source 2 - IP India TMR Public Search
             (https://tmrsearch.ipindia.gov.in/tmrpublicsearch/frmmain.aspx)
             ASP.NET __VIEWSTATE session scrape via requests + BS4.
             Used for: attorney portfolio bulk import.

All FastAPI routes are preserved. Frontend contract bugs fixed:
  - /list  → returns { items, total } + tm_status / class_number / renewal_alert filters
  - /deadlines → returns { upcoming: [...], overdue: [...] }
  - /stats → returns all 6 fields the frontend metric cards need
  - _compute_deadlines() → stores renewal_status + days_until_renewal + renewal_date
"""

import os, re, uuid, time, logging, asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, date, timedelta
from typing import Optional, List, Any, Dict, Tuple
from urllib.parse import quote, urljoin
from zoneinfo import ZoneInfo

import requests as _requests
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query, Response, Body
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.models import User
from backend.pdf_renderer import build_combined_report_pdf

# ── QC availability report modules ────────────────────────────────────────────
from backend.scraper import search_trademarks as _qc_availability_search
from backend.report_engine import build_report
from backend.class_finder import find_classes
from backend.qc_pdf_renderer import build_report_pdf

logger = logging.getLogger(__name__)
router = APIRouter(prefix="", tags=["trademark-sphere"])


def _pdf_filename(brand_name: str, class_filters: Optional[List[int]] = None) -> str:
    """
    Build a safe, brand-name-based PDF filename, e.g. 'Trademark_Krimira_CL16_CL21_CL28.pdf'.

    - Always named after the searched brand (never the internal report/UUID),
      so the file the user gets after "Download PDF" / Ctrl+S matches what
      they searched for.
    - Appends the searched class(es) when known, so multi-class runs and
      per-class reports for the same brand don't overwrite each other.
    - Strips characters that are unsafe in filenames / HTTP headers.
    """
    base = (brand_name or "trademark").strip()
    base = re.sub(r"[^\w\-]+", "_", base, flags=re.UNICODE).strip("_") or "trademark"
    suffix = ""
    if class_filters:
        classes = sorted({int(c) for c in class_filters})
        suffix = "_" + "_".join(f"CL{c}" for c in classes)
    return f"Trademark_{base}{suffix}.pdf"


def _content_disposition(filename: str) -> str:
    """
    RFC 5987-safe Content-Disposition header value: ASCII fallback for
    old clients + UTF-8 filename* for everything else (non-Latin brand names).
    """
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "trademark.pdf"
    return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{quote(filename)}'
IST   = ZoneInfo("Asia/Kolkata")
_pool = ThreadPoolExecutor(max_workers=6)

# ── Site roots ────────────────────────────────────────────────────────────────
QC_BASE    = "https://www.quickcompany.in"
QC_SEARCH  = f"{QC_BASE}/trademarks"           # ?q=...
QC_DETAIL  = f"{QC_BASE}/trademarks"           # /{app_no}-{slug}
QC_ATTY    = f"{QC_BASE}/trademarks/attorney"  # /{agent_code}?page=N

IP_BASE    = "https://tmrsearch.ipindia.gov.in"
IP_MAIN    = f"{IP_BASE}/tmrpublicsearch/frmmain.aspx"
IP_SEARCH  = f"{IP_BASE}/tmrpublicsearch/tmsearch.aspx"

# ── Shared session (persistent cookies, keep-alive) ──────────────────────────
_qc_session: Optional[_requests.Session] = None
_ip_session: Optional[_requests.Session] = None

_COMMON_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection":      "keep-alive",
}

def _qc_sess() -> _requests.Session:
    global _qc_session
    if _qc_session is None:
        s = _requests.Session()
        s.headers.update({
            **_COMMON_HEADERS,
            "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer":                   QC_BASE + "/",
            "sec-ch-ua":                 '"Chromium";v="124", "Google Chrome";v="124"',
            "sec-ch-ua-mobile":          "?0",
            "sec-ch-ua-platform":        '"Windows"',
            "sec-fetch-dest":            "document",
            "sec-fetch-mode":            "navigate",
            "sec-fetch-site":            "same-origin",
            "Upgrade-Insecure-Requests": "1",
            "Cache-Control":             "max-age=0",
        })
        try:
            s.get(QC_BASE + "/", timeout=15)
            time.sleep(0.8)
        except Exception:
            pass
        _qc_session = s
    return _qc_session


def _ip_sess() -> _requests.Session:
    global _ip_session
    if _ip_session is None:
        s = _requests.Session()
        s.headers.update({
            **_COMMON_HEADERS,
            "Accept":  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": IP_MAIN,
        })
        _ip_session = s
    return _ip_session


# ── In-memory caches ──────────────────────────────────────────────────────────
_tm_cache:      Dict[str, Any] = {}
_ip_vs_cache:   Dict[str, str] = {}
_sessions:      Dict[str, Any] = {}
_sync_progress: Dict[str, Any] = {}


# ════════════════════════════════════════════════════════════════════════════
# ── Helpers ──────────────────────────────────────────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

def _clean(v: Any) -> Optional[str]:
    return " ".join(str(v).split()).strip() or None


def _parse_date(s: Any) -> Optional[date]:
    if not s:
        return None
    for fmt in (
        "%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y",
        "%d %b %Y", "%B %d, %Y", "%d-%b-%Y",
        "%d %B %Y", "%b %d, %Y",
    ):
        try:
            return datetime.strptime(str(s).strip(), fmt).date()
        except ValueError:
            pass
    return None


def _status_map(raw: str) -> str:
    if not raw:
        return "Unknown"
    r = raw.strip().lower()
    MAP = {
        "registered":                    "Registered",
        "pending":                       "Pending",
        "formalities chk pass":          "Pending",
        "new application":               "Pending",
        "send back to fo for correction":"Pending",
        "marked for exam":               "Under Examination",
        "under examination":             "Under Examination",
        "examined":                      "Under Examination",
        "objected":                      "Objected",
        "opposed":                       "Opposed",
        "accepted and advertised":       "Accepted & Advertised",
        "accepted & advertised":         "Accepted & Advertised",
        "advertised before acceptance":  "Advertised Before Acceptance",
        "advertised before accepted":    "Advertised Before Acceptance",
        "refused":                       "Refused",
        "abandoned":                     "Abandoned",
        "withdrawn":                     "Withdrawn",
        "removed":                       "Abandoned",
        "expired":                       "Abandoned",
    }
    for k, v in MAP.items():
        if k in r:
            return v
    return raw.strip().title()


def _compute_deadlines(tm: Dict[str, Any]) -> Dict[str, Any]:
    today = date.today()
    dl: Dict[str, Any] = {}

    rd = _parse_date(tm.get("valid_upto") or tm.get("renewal_date") or tm.get("renewal_due"))
    if rd:
        days_left = (rd - today).days
        dl["renewal_due"]         = rd.isoformat()
        dl["renewal_date"]        = rd.isoformat()
        dl["days_until_renewal"]  = days_left
        dl["days_to_renewal"]     = days_left

        if days_left < 0:
            dl["renewal_status"] = "overdue"
        elif days_left <= 30:
            dl["renewal_status"] = "critical"
        elif days_left <= 90:
            dl["renewal_status"] = "warning"
        elif days_left <= 180:
            dl["renewal_status"] = "upcoming"
        else:
            dl["renewal_status"] = "ok"
    return dl


async def _gen_reminders(tm_id: str, tm: Dict[str, Any]) -> None:
    if not tm.get("reminders_enabled", True):
        return
    rd = _parse_date(tm.get("valid_upto"))
    if not rd:
        return
    await db.trademark_sphere_reminders.delete_many({"trademark_id": tm_id})
    now  = datetime.now(IST)
    rows = []
    for days in (90, 60, 30, 7):
        ron = rd - timedelta(days=days)
        if ron >= now.date():
            rid = str(uuid.uuid4())
            rows.append({
                "_id": rid, "id": rid,
                "trademark_id":       tm_id,
                "application_number": tm.get("application_number"),
                "word_mark":          tm.get("word_mark"),
                "type":               "renewal",
                "label":              f"Renewal due in {days} days",
                "remind_on":          ron.isoformat(),
                "renewal_date":       rd.isoformat(),
                "days_before":        days,
                "sent":               False,
                "auto_generated":     True,
                "created_at":         now.isoformat(),
            })
    if rows:
        await db.trademark_sphere_reminders.insert_many(rows)


# ════════════════════════════════════════════════════════════════════════════
# ── SOURCE 1: QuickCompany HTML scraper ──────────────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

def _qc_detail_url(app_number: str) -> str:
    return f"{QC_DETAIL}/{app_number.strip()}"


def _qc_parse_detail_page(html: str, app_number: str) -> Dict[str, Any]:
    soup = BeautifulSoup(html, "lxml")

    word_mark = ""
    h1 = soup.find("h1")
    if h1:
        word_mark = _clean(h1.get_text()) or ""

    kv: Dict[str, str] = {}
    for tr in soup.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if len(cells) >= 2:
            key = _clean(cells[0].get_text())
            val = _clean(cells[1].get_text())
            if key and val:
                kv[key.lower()] = val

    section = soup.find("div", string=re.compile(r"Trademark Information", re.I))
    if not section:
        for h in soup.find_all(["h3", "h4"]):
            if "trademark information" in h.get_text().lower():
                section = h.find_parent("div")
                break

    if section:
        labels = section.find_all(["h4", "strong", "dt"])
        for lbl in labels:
            key = _clean(lbl.get_text())
            nxt = lbl.find_next_sibling()
            if nxt:
                val = _clean(nxt.get_text())
                if key and val:
                    kv[key.lower()] = val

    meta_desc = ""
    meta = soup.find("meta", {"name": "description"})
    if meta:
        meta_desc = meta.get("content", "")

    def g(*keys) -> str:
        for k in keys:
            v = kv.get(k, "")
            if v:
                return v
        return ""

    status_raw  = g("status", "tm status", "application status")
    class_no    = g("classes", "class", "class number", "nice class")
    proprietor  = g("proprietor", "applicant", "owner")
    attorney    = g("attorney", "agent", "trademark agent", "trademark attorney")
    filing_date = g("date of application", "filing date", "application date", "filed on", "applied on")
    reg_date    = g("date of registration", "registration date", "registered on")
    valid_upto  = g("valid / upto", "valid upto", "valid till", "expiry date", "renewal date", "validity")
    address     = g("address", "applicant address", "proprietor address")
    gs          = g("description", "goods and services", "goods & services", "specification")
    state       = g("state")
    ip_office   = g("ip office", "office")
    filing_mode = g("filing mode")
    used_since  = g("used since")
    mark_type   = g("type", "mark type")

    if not proprietor:
        h4 = soup.find("h4")
        if h4:
            proprietor = _clean(h4.get_text()) or ""

    if class_no:
        m = re.search(r"\d+", class_no)
        class_no = m.group(0) if m else class_no

    img_url = ""
    img_tag = soup.find("img", src=re.compile(r"quickcompany\.blob|trademarks.*image", re.I))
    if img_tag:
        img_url = img_tag.get("src", "")

    documents: List[Dict] = []
    for tr in soup.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) >= 3:
            doc_name = _clean(cells[1].get_text()) if len(cells) > 1 else ""
            doc_date = _clean(cells[2].get_text()) if len(cells) > 2 else ""
            link_tag = cells[1].find("a") or tr.find("a")
            doc_link = ""
            if link_tag:
                doc_link = urljoin(QC_BASE, link_tag.get("href", ""))
            if doc_name and doc_name not in ("", "—"):
                documents.append({
                    "name": doc_name,
                    "date": doc_date,
                    "pdf_link": doc_link,
                })

    hearings = None
    for tr in soup.find_all("tr"):
        cells = tr.find_all("td")
        row_text = " ".join(c.get_text() for c in cells).lower()
        if "notice" in row_text or "hearing" in row_text:
            date_cell = _clean(cells[-1].get_text()) if cells else ""
            hearings = {"date": date_cell, "officer": ""}
            break

    pr_details = g("pr details", "applicant details")
    applicant_name = proprietor

    return {
        "application_number":  str(app_number).strip(),
        "word_mark":           word_mark,
        "tm_status":           _status_map(status_raw),
        "class_number":        class_no,
        "proprietor":          proprietor,
        "applicant_name":      applicant_name,
        "filing_date":         filing_date,
        "registration_date":   reg_date,
        "valid_upto":          valid_upto,
        "goods_and_services":  gs,
        "address":             address,
        "trademark_image_url": img_url,
        "state":               state,
        "ip_office":           ip_office,
        "filing_mode":         filing_mode,
        "used_since":          used_since,
        "mark_type":           mark_type,
        "attorney":            attorney,
        "documents":           documents,
        "hearings":            hearings,
        "scrape_source":       "quickcompany",
    }


def _qc_search_app_number(app_number: str) -> Optional[str]:
    sess = _qc_sess()
    try:
        r = sess.get(
            f"{QC_SEARCH}",
            params={"q": app_number},
            timeout=20,
        )
        if r.status_code != 200:
            return None
        soup = BeautifulSoup(r.text, "lxml")
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if f"/trademarks/{app_number}" in href or f"/trademarks/{app_number}-" in href:
                return href
        return None
    except Exception as e:
        logger.warning(f"QC search failed for {app_number}: {e}")
        return None


def _qc_fetch_by_app_number(app_number: str) -> Dict[str, Any]:
    app_number = (app_number or "").strip()
    if not app_number:
        raise HTTPException(400, "Application number is required.")

    cache_key = f"qc::{app_number}"
    if cache_key in _tm_cache:
        return _tm_cache[cache_key]

    sess = _qc_sess()

    url = f"{QC_DETAIL}/{app_number}"
    detail_html = ""
    final_url = url

    try:
        r = sess.get(url, timeout=25, allow_redirects=True)
        if r.status_code == 200 and len(r.text) > 500:
            detail_html = r.text
            final_url = r.url
        elif r.status_code == 404:
            slug_path = _qc_search_app_number(app_number)
            if slug_path:
                time.sleep(0.8)
                r2 = sess.get(urljoin(QC_BASE, slug_path), timeout=25)
                if r2.status_code == 200:
                    detail_html = r2.text
                    final_url = r2.url
    except _requests.RequestException as e:
        logger.error(f"QC fetch error for {app_number}: {e}")

    if not detail_html:
        raise HTTPException(
            404,
            f"Trademark {app_number} not found on QuickCompany. "
            "Try adding it manually."
        )

    data = _qc_parse_detail_page(detail_html, app_number)
    _tm_cache[cache_key] = data
    return data


def _qc_attorney_app_numbers(agent_code: str) -> List[str]:
    agent_code = (agent_code or "").strip()
    if not agent_code:
        return []

    sess = _qc_sess()
    seen: set = set()
    nums: List[str] = []

    for page in range(1, 51):
        url = f"{QC_ATTY}/{quote(agent_code)}"
        try:
            r = sess.get(url, params={"page": page}, timeout=20)
            if r.status_code != 200:
                break
            soup = BeautifulSoup(r.text, "lxml")
        except _requests.RequestException as e:
            logger.warning(f"QC attorney page {page} error: {e}")
            break

        added = 0
        for a in soup.find_all("a", href=True):
            href = a["href"]
            m = re.search(r"/trademarks/(\d{5,})(?:[-/]|$)", href)
            if m:
                n = m.group(1)
                if n not in seen:
                    seen.add(n)
                    nums.append(n)
                    added += 1

        if added == 0:
            break
        time.sleep(1.0)

    logger.info(f"QC attorney '{agent_code}': found {len(nums)} application numbers.")
    return nums


# ════════════════════════════════════════════════════════════════════════════
# ── SOURCE 2: IP India TMR Public Search (ASPX) ───────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

def _ip_get_viewstate() -> Dict[str, str]:
    sess = _ip_sess()
    try:
        r = sess.get(IP_MAIN, timeout=20)
        if r.status_code != 200:
            raise HTTPException(502, f"IP India returned {r.status_code}")
        soup = BeautifulSoup(r.text, "lxml")
        vs: Dict[str, str] = {}
        for field in ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"):
            inp = soup.find("input", {"name": field}) or soup.find("input", {"id": field})
            if inp:
                vs[field] = inp.get("value", "")
        return vs
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Failed to load IP India search page: {e}")


def _ip_search_by_application_number(app_number: str) -> Dict[str, Any]:
    app_number = (app_number or "").strip()
    sess       = _ip_sess()

    vs = _ip_get_viewstate()

    post_data = {
        "__VIEWSTATE":          vs.get("__VIEWSTATE", ""),
        "__VIEWSTATEGENERATOR": vs.get("__VIEWSTATEGENERATOR", ""),
        "__EVENTVALIDATION":    vs.get("__EVENTVALIDATION", ""),
        "__EVENTTARGET":        "",
        "__EVENTARGUMENT":      "",
        "ctl00$ContentPlaceHolder1$RadioButton1":     "rdApplicationNumber",
        "ctl00$ContentPlaceHolder1$txtApplicationNo": app_number,
        "ctl00$ContentPlaceHolder1$btnSearch":        "Search",
    }

    try:
        r = sess.post(
            IP_SEARCH,
            data=post_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
            allow_redirects=True,
        )
        if r.status_code != 200:
            raise HTTPException(502, f"IP India search returned {r.status_code}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"IP India search POST failed: {e}")

    return _ip_parse_search_results(r.text, app_number)


def _ip_parse_search_results(html: str, app_number: str) -> Dict[str, Any]:
    soup = BeautifulSoup(html, "lxml")

    table = (
        soup.find("table", id=re.compile(r"GridView", re.I))
        or soup.find("table", class_=re.compile(r"result|grid|search", re.I))
        or soup.find("table")
    )

    if not table:
        raise HTTPException(404, f"No results found on IP India for '{app_number}'.")

    rows = table.find_all("tr")
    if len(rows) < 2:
        raise HTTPException(404, f"No trademark data rows on IP India for '{app_number}'.")

    headers = [_clean(th.get_text()) for th in rows[0].find_all(["th", "td"])]

    target_row = None
    for row in rows[1:]:
        cells = row.find_all("td")
        row_text = " ".join(c.get_text() for c in cells)
        if app_number in row_text:
            target_row = cells
            break

    if not target_row:
        if len(rows) >= 2:
            target_row = rows[1].find_all("td")
        else:
            raise HTTPException(404, f"Trademark {app_number} not found in IP India results.")

    kv: Dict[str, str] = {}
    for i, h in enumerate(headers):
        if h and i < len(target_row):
            kv[h.lower()] = _clean(target_row[i].get_text()) or ""

    def g(*keys) -> str:
        for k in keys:
            v = kv.get(k, "")
            if v:
                return v
        return ""

    word_mark   = g("word mark", "trademark", "mark", "trade mark")
    app_no      = g("application no", "application number", "app no") or app_number
    status      = g("status", "tm status", "current status")
    class_no    = g("class", "class no", "nice class")
    proprietor  = g("proprietor name", "proprietor", "applicant name", "applicant")
    address     = g("applicant address", "address", "proprietor address")
    filing_date = g("filing date", "date of application", "application date")
    valid_upto  = g("valid upto", "validity", "renewal date", "expiry")
    attorney    = g("attorney", "agent", "attorney/agent")
    gs          = g("goods and services", "description", "specification")

    if class_no:
        m = re.search(r"\d+", class_no)
        class_no = m.group(0) if m else class_no

    return {
        "application_number":  str(app_no).strip(),
        "word_mark":           word_mark,
        "tm_status":           _status_map(status),
        "class_number":        class_no,
        "proprietor":          proprietor,
        "applicant_name":      proprietor,
        "filing_date":         filing_date,
        "registration_date":   "",
        "valid_upto":          valid_upto,
        "goods_and_services":  gs,
        "address":             address,
        "trademark_image_url": "",
        "attorney":            attorney,
        "documents":           [],
        "hearings":            None,
        "scrape_source":       "ipindia",
    }


def _ip_search_by_wordmark(word_mark: str, class_no: str = "") -> List[Dict[str, Any]]:
    sess = _ip_sess()
    vs   = _ip_get_viewstate()

    post_data = {
        "__VIEWSTATE":          vs.get("__VIEWSTATE", ""),
        "__VIEWSTATEGENERATOR": vs.get("__VIEWSTATEGENERATOR", ""),
        "__EVENTVALIDATION":    vs.get("__EVENTVALIDATION", ""),
        "__EVENTTARGET":        "",
        "__EVENTARGUMENT":      "",
        "ctl00$ContentPlaceHolder1$RadioButton1":  "rdWordMark",
        "ctl00$ContentPlaceHolder1$txtTMName":     word_mark.strip(),
        "ctl00$ContentPlaceHolder1$ddlClass":      class_no or "0",
        "ctl00$ContentPlaceHolder1$btnSearch":     "Search",
    }

    try:
        r = sess.post(
            IP_SEARCH,
            data=post_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
        if r.status_code != 200:
            return []
    except Exception as e:
        logger.warning(f"IP India word-mark search failed: {e}")
        return []

    soup  = BeautifulSoup(r.text, "lxml")
    table = soup.find("table", id=re.compile(r"GridView", re.I)) or soup.find("table")
    if not table:
        return []

    rows    = table.find_all("tr")
    if len(rows) < 2:
        return []
    headers = [_clean(th.get_text()) for th in rows[0].find_all(["th", "td"])]

    results = []
    for row in rows[1:]:
        cells = row.find_all("td")
        if not cells:
            continue
        kv: Dict[str, str] = {}
        for i, h in enumerate(headers):
            if h and i < len(cells):
                kv[h.lower()] = _clean(cells[i].get_text()) or ""

        def g(*keys) -> str:
            for k in keys:
                v = kv.get(k, "")
                if v:
                    return v
            return ""

        app_no  = g("application no", "application number", "app no")
        status  = g("status", "tm status")
        cls     = g("class", "class no")
        if cls:
            m = re.search(r"\d+", cls)
            cls = m.group(0) if m else cls

        results.append({
            "application_number":  app_no,
            "word_mark":           g("word mark", "trademark", "mark"),
            "tm_status":           _status_map(status),
            "class_number":        cls,
            "proprietor":          g("proprietor name", "proprietor", "applicant"),
            "applicant_name":      g("proprietor name", "proprietor", "applicant"),
            "filing_date":         g("filing date", "date of application"),
            "valid_upto":          g("valid upto", "renewal date"),
            "goods_and_services":  g("goods and services", "specification"),
            "address":             g("applicant address", "address"),
            "trademark_image_url": "",
            "attorney":            g("attorney", "agent"),
            "documents":           [],
            "hearings":            None,
            "scrape_source":       "ipindia",
        })
    return results


# ════════════════════════════════════════════════════════════════════════════
# ── Unified scraper: try QC first, fall back to IP India ─────────────────────
# ════════════════════════════════════════════════════════════════════════════

def _scrape_trademark_sync(app_number: str) -> Dict[str, Any]:
    app_number = (app_number or "").strip()
    cache_key  = f"unified::{app_number}"
    if cache_key in _tm_cache:
        return _tm_cache[cache_key]

    try:
        data = _qc_fetch_by_app_number(app_number)
        _tm_cache[cache_key] = data
        return data
    except HTTPException as e:
        if e.status_code == 404:
            logger.info(f"QC 404 for {app_number}, trying IP India…")
        else:
            logger.warning(f"QC error for {app_number}: {e.detail}, trying IP India…")
    except Exception as e:
        logger.warning(f"QC exception for {app_number}: {e}, trying IP India…")

    try:
        data = _ip_search_by_application_number(app_number)
        _tm_cache[cache_key] = data
        return data
    except HTTPException as e:
        raise HTTPException(
            404,
            f"Trademark {app_number} not found on QuickCompany or IP India. "
            f"Please add it manually. ({e.detail})"
        )
    except Exception as e:
        raise HTTPException(502, f"Both scrapers failed for {app_number}: {e}")


async def scrape_trademark(
    app_number: str,
    class_number: Optional[str] = None,
    session_id:   Optional[str] = None,
    otp:          Optional[str] = None,
) -> Dict[str, Any]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_pool, _scrape_trademark_sync, app_number)


async def scrape_documents(
    app_number: str, class_number: Optional[str] = None
) -> Tuple[List[Dict], Optional[Dict]]:
    return [], None


async def scrape_by_attorney_code(
    agent_code: str,
    session_id: Optional[str] = None,
    otp:        Optional[str] = None,
) -> List[str]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_pool, _qc_attorney_app_numbers, agent_code)


async def send_otp(email: str) -> str:
    sid = str(uuid.uuid4())
    _sessions[sid] = {"email": email, "noop": True, "created_at": datetime.now(IST).isoformat()}
    return sid


# ════════════════════════════════════════════════════════════════════════════
# ── Pydantic models ───────────────────────────────────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

class SendOtpRequest(BaseModel):
    email: str

class TrademarkAddRequest(BaseModel):
    application_number: str
    class_number:       Optional[str]            = None
    session_id:         Optional[str]            = None
    otp:                Optional[str]            = None
    client_id:          Optional[str]            = None
    client_name:        Optional[str]            = None
    attorney:           Optional[str]            = None
    notes:              Optional[str]            = None
    reminder_emails:    List[str]                = Field(default_factory=list)
    reminders_enabled:  bool                     = True
    manual_data:        Optional[Dict[str, Any]] = None

class TrademarkUpdateRequest(BaseModel):
    attorney:           Optional[str]       = None
    notes:              Optional[str]       = None
    client_id:          Optional[str]       = None
    client_name:        Optional[str]       = None
    reminder_emails:    Optional[List[str]] = None
    reminders_enabled:  Optional[bool]      = None
    valid_upto:         Optional[str]       = None
    word_mark:          Optional[str]       = None
    proprietor:         Optional[str]       = None
    tm_status:          Optional[str]       = None
    filing_date:        Optional[str]       = None
    class_number:       Optional[str]       = None
    goods_and_services: Optional[str]       = None

class TrademarkManualCreate(BaseModel):
    application_number: str
    word_mark:          str
    class_number:       Optional[str] = None
    tm_status:          str           = "Pending"
    proprietor:         Optional[str] = None
    filing_date:        Optional[str] = None
    registration_date:  Optional[str] = None
    valid_upto:         Optional[str] = None
    goods_and_services: Optional[str] = None
    client_id:          Optional[str] = None
    client_name:        Optional[str] = None
    attorney:           Optional[str] = None
    notes:              Optional[str] = None
    reminder_emails:    List[str]     = Field(default_factory=list)
    reminders_enabled:  bool          = True

class AttorneyImportRequest(BaseModel):
    agent_code:         str
    attorney:           Optional[str] = None
    client_id:          Optional[str] = None
    client_name:        Optional[str] = None
    reminder_emails:    List[str]     = Field(default_factory=list)
    reminders_enabled:  bool          = True
    session_id:         Optional[str] = None
    otp:                Optional[str] = None

class PortalSyncRequest(BaseModel):
    agent_code:       str
    session_id:       Optional[str] = None
    otp:              Optional[str] = None
    attorney:         str            = ""
    client_id:        Optional[str]  = None
    reminder_emails:  List[str]      = []
    refresh_existing: bool           = True

class SearchRequest(BaseModel):
    query: str
    limit: int = 25
    search_type: str = "wordmark"
    class_number: str = ""

class IpIndiaSearchRequest(BaseModel):
    query:        str
    search_type:  str = "wordmark"
    class_number: str = ""

# ── QC Availability Report models ─────────────────────────────────────────────

class ReportRequest(BaseModel):
    name: str
    class_filter: Optional[int] = None
    class_filters: Optional[List[int]] = None   # multi-class: scrape all these classes
    device_only: bool = False
    logo_data_url: Optional[str] = None
    footer: str = ""
    tagline: str = ""
    watermark: str = ""
    custom_watermark: str = ""
    client_name: str = ""
    client_mobile: str = ""
    report_date: str = ""
    prepared_by: str = ""

class BulkReportRequest(BaseModel):
    names: List[str]
    class_filter: Optional[int] = None
    class_filters: Optional[List[int]] = None   # multi-class: scrape all these classes
    device_only: bool = False
    logo_data_url: Optional[str] = None
    footer: str = ""
    tagline: str = ""
    watermark: str = ""
    custom_watermark: str = ""
    prepared_by: str = ""
    disclaimer: str = ""
    company_name: str = ""
    client_name: str = ""
    client_mobile: str = ""
    report_date: str = ""
    enable_monitoring: bool = False

class BrandingPrefRequest(BaseModel):
    default_company_id: Optional[str] = None
    default_company_name: Optional[str] = None
    footer: str = ""
    tagline: str = ""
    watermark: str = ""


# ════════════════════════════════════════════════════════════════════════════
# ── Background jobs ───────────────────────────────────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

async def _import_attorney_bg(
    agent_code: str, created_by: str, attorney: Optional[str],
    client_id: Optional[str], client_name: Optional[str],
    reminder_emails: List[str], reminders_enabled: bool,
    session_id: Optional[str] = None, otp: Optional[str] = None,
) -> None:
    try:
        app_numbers = await scrape_by_attorney_code(agent_code)
    except HTTPException as exc:
        logger.error(f"Attorney import failed for {agent_code}: {exc.detail}")
        return

    for app_num in app_numbers:
        if await db.trademark_sphere.find_one({"application_number": app_num}):
            continue
        await asyncio.sleep(1.2)
        try:
            raw = await scrape_trademark(app_num)
        except HTTPException as exc:
            logger.warning(f"Skip {app_num}: {exc.detail}")
            continue
        now = datetime.now(IST)
        tid = str(uuid.uuid4())
        doc = {
            "_id": tid, "id": tid,
            **{k: raw.get(k, "") for k in (
                "application_number", "word_mark", "class_number", "tm_status",
                "proprietor", "applicant_name", "filing_date", "registration_date",
                "valid_upto", "goods_and_services", "trademark_image_url", "address",
            )},
            "attorney":          attorney or raw.get("attorney", ""),
            "notes":             f"Imported via attorney portfolio ({agent_code})",
            "client_id":         client_id or "",
            "client_name":       client_name or "",
            "reminder_emails":   reminder_emails,
            "reminders_enabled": reminders_enabled,
            "last_fetched":      now.isoformat(),
            "created_at":        now.isoformat(),
            "updated_at":        now.isoformat(),
            "created_by":        created_by,
            "raw_data":          raw,
            "scrape_source":     raw.get("scrape_source", "quickcompany"),
            "documents":         raw.get("documents", []),
            "hearings":          raw.get("hearings"),
            **_compute_deadlines(raw),
        }
        await db.trademark_sphere.insert_one(doc)
        await _gen_reminders(tid, doc)


async def _portal_sync_bg(
    sync_id: str, agent_code: str, session_id: Optional[str],
    otp: Optional[str], created_by: str, attorney: str,
    client_id: Optional[str], reminder_emails: List[str],
    refresh_existing: bool,
) -> None:
    _sync_progress[sync_id] = {
        "status": "running", "phase": "Fetching application list…",
        "total": 0, "done": 0, "added": 0, "updated": 0, "failed": 0, "errors": [],
    }
    try:
        app_numbers = await scrape_by_attorney_code(agent_code)
    except Exception as exc:
        _sync_progress[sync_id].update({"status": "error", "phase": str(exc)})
        return

    total = len(app_numbers)
    _sync_progress[sync_id]["total"] = total
    _sync_progress[sync_id]["phase"] = f"Processing {total} trademarks…"

    for i, app_num in enumerate(app_numbers, 1):
        _sync_progress[sync_id]["phase"] = f"Processing {app_num} ({i}/{total})…"
        existing = await db.trademark_sphere.find_one({"application_number": app_num})
        await asyncio.sleep(0.8)
        if existing and not refresh_existing:
            _sync_progress[sync_id]["done"] += 1
            continue
        try:
            raw = await scrape_trademark(app_num)
        except Exception:
            _sync_progress[sync_id]["failed"] += 1
            _sync_progress[sync_id]["done"]   += 1
            _sync_progress[sync_id]["errors"].append(app_num)
            continue

        now = datetime.now(IST)
        dl  = _compute_deadlines(raw)
        if existing:
            upd = {
                **{k: raw.get(k) or existing.get(k) for k in (
                    "word_mark", "tm_status", "proprietor", "filing_date",
                    "registration_date", "valid_upto", "goods_and_services",
                    "trademark_image_url",
                )},
                "raw_data":      raw,
                "last_fetched":  now.isoformat(),
                "updated_at":    now.isoformat(),
                "scrape_source": raw.get("scrape_source", "quickcompany"),
                **dl,
            }
            await db.trademark_sphere.update_one(
                {"application_number": app_num}, {"$set": upd}
            )
            await _gen_reminders(existing["id"], {**existing, **upd})
            _sync_progress[sync_id]["updated"] += 1
        else:
            tid = str(uuid.uuid4())
            doc = {
                "_id": tid, "id": tid,
                **{k: raw.get(k, "") for k in (
                    "application_number", "word_mark", "class_number", "tm_status",
                    "proprietor", "applicant_name", "filing_date", "registration_date",
                    "valid_upto", "goods_and_services", "trademark_image_url", "address",
                )},
                "attorney":          attorney or raw.get("attorney", ""),
                "notes":             f"Portal sync ({agent_code})",
                "client_id":         client_id or "",
                "client_name":       "",
                "reminder_emails":   reminder_emails,
                "reminders_enabled": True,
                "last_fetched":      now.isoformat(),
                "created_at":        now.isoformat(),
                "updated_at":        now.isoformat(),
                "created_by":        created_by,
                "raw_data":          raw,
                "scrape_source":     raw.get("scrape_source", "quickcompany"),
                "documents":         raw.get("documents", []),
                "hearings":          raw.get("hearings"),
                **dl,
            }
            await db.trademark_sphere.insert_one(doc)
            await _gen_reminders(tid, doc)
            _sync_progress[sync_id]["added"] += 1
        _sync_progress[sync_id]["done"] += 1

    _sync_progress[sync_id]["status"] = "completed"
    _sync_progress[sync_id]["phase"]  = "Done."


# ════════════════════════════════════════════════════════════════════════════
# ── FastAPI Routes ────────────────────────────────────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

# ── QC Availability Report Routes ─────────────────────────────────────────────
# These power the "Run Report" button on the TrademarkSphere page.
# Endpoints: /report, /bulk, /searches, /check, /class-finder, /branding-preference

@router.post("/report")
async def qc_generate_report(body: ReportRequest, user: User = Depends(get_current_user)):
    """Run a QuickCompany trademark availability report for a brand name."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    try:
        # Use body.class_filters (multi-class array) if provided; otherwise derive from class_filter
        class_filters = body.class_filters or ([body.class_filter] if body.class_filter is not None else None)
        scraped = await _qc_availability_search(name, class_filters=class_filters)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SCRAPER ERROR - {exc}")
    # Pass the FULL class list through so a multi-class run (e.g. CL16+CL21+CL28)
    # analyses and reports on all requested classes combined, not just the first.
    report = build_report(name, scraped, class_filter=body.class_filter, class_filters=class_filters)
    report["logo_data_url"]   = body.logo_data_url
    report["footer"]          = body.footer
    report["tagline"]         = body.tagline
    report["watermark"]       = body.watermark
    report["custom_watermark"]= body.custom_watermark
    report["device_only"]     = body.device_only
    report["client_name"]     = body.client_name
    report["client_mobile"]   = body.client_mobile
    report["report_date"]     = body.report_date
    report["prepared_by"]     = body.prepared_by
    report["class_filter"]    = body.class_filter
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    doc = {
        "_id":        str(uuid.uuid4()),
        "user_id":    user_id,
        "created_at": datetime.utcnow().isoformat(),
        "report":     report,
    }
    await db.trademark_qc_reports.insert_one(doc)
    return {**doc, "id": doc["_id"]}


@router.post("/bulk")
async def qc_bulk_reports(body: BulkReportRequest, user: User = Depends(get_current_user)):
    """Run availability reports for multiple brand names (max 20)."""
    names = [n.strip() for n in (body.names or []) if n.strip()]
    if not names:
        raise HTTPException(status_code=422, detail="names list is required")
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    items = []
    class_filters_bulk = body.class_filters or ([body.class_filter] if body.class_filter is not None else None)
    for name in names[:20]:
        try:
            scraped = await _qc_availability_search(name, class_filters=class_filters_bulk)
            report  = build_report(name, scraped, class_filter=body.class_filter, class_filters=class_filters_bulk)
            report["logo_data_url"]    = body.logo_data_url
            report["footer"]           = body.footer
            report["tagline"]          = body.tagline
            report["watermark"]        = body.watermark
            report["custom_watermark"] = body.custom_watermark
            report["device_only"]      = body.device_only
            report["client_name"]      = body.client_name
            report["client_mobile"]    = body.client_mobile
            report["report_date"]      = body.report_date
            report["prepared_by"]      = body.prepared_by
            report["class_filter"]     = body.class_filter
            doc = {
                "_id":        str(uuid.uuid4()),
                "user_id":    user_id,
                "created_at": datetime.utcnow().isoformat(),
                "report":     report,
            }
            await db.trademark_qc_reports.insert_one(doc)
            items.append({
                **doc,
                "id":             doc["_id"],
                "name":           name,            # FIX: always surface the searched name
                "overall_status": report.get("overall_status"),
                "risk_score":     report.get("risk_score"),
                "headline":       report.get("headline"),
            })
        except Exception as exc:
            items.append({"name": name, "error": str(exc)})

    # Compute portfolio analytics so the frontend can show the summary grid
    from backend.trademark_bulk import enrich_report_with_analytics, compute_portfolio_analytics
    for it in items:
        if not it.get("error") and it.get("report"):
            enrich_report_with_analytics(it["report"], enable_monitoring=body.enable_monitoring)
    analytics = compute_portfolio_analytics(items)

    return {"items": items, "count": len(items), "analytics": analytics}


@router.post("/bulk/export")
async def qc_bulk_export(
    body: BulkReportRequest,
    format: str = "pdf",
    user: User = Depends(get_current_user),
):
    """
    Run availability searches for multiple marks and return a combined
    downloadable report in the requested format (pdf / docx / xlsx).
    This is the endpoint called by the frontend bulkExport() helper.
    """
    from backend.trademark_bulk import (
        build_bulk_dossier_pdf,
        build_bulk_docx,
        build_bulk_xlsx,
        enrich_report_with_analytics,
        compute_portfolio_analytics,
    )

    names = [n.strip() for n in (body.names or []) if n.strip()]
    if not names:
        raise HTTPException(status_code=422, detail="names list is required")

    branding = {
        "logo_data_url":    body.logo_data_url,
        "footer":           body.footer or "",
        "tagline":          body.tagline or "Bulk Trademark Availability Report",
        "watermark":        body.watermark or "",
        "custom_watermark": body.custom_watermark or "",
        "prepared_by":      body.prepared_by or "",
        "disclaimer":       body.disclaimer or "",
        "company_name":     body.company_name or "",
        "client_name":      body.client_name or "",
        "client_mobile":    body.client_mobile or "",
        "report_date":      body.report_date or "",
    }

    items = []
    class_filters_export = body.class_filters or ([body.class_filter] if body.class_filter is not None else None)
    for name in names[:20]:
        try:
            scraped = await _qc_availability_search(name, class_filters=class_filters_export)
            report  = build_report(name, scraped, class_filter=body.class_filter, class_filters=class_filters_export)
            enrich_report_with_analytics(report, enable_monitoring=body.enable_monitoring)
            items.append({
                "name":           name,
                "report":         report,
                "error":          None,
                "overall_status": report.get("overall_status"),
                "risk_score":     report.get("risk_score"),
                "headline":       report.get("headline"),
            })
        except Exception as exc:
            logger.warning("bulk/export scrape failed for %s: %s", name, exc)
            items.append({"name": name, "error": str(exc)})

    analytics = compute_portfolio_analytics(items)
    fmt   = (format or "pdf").lower()
    today = datetime.utcnow().strftime("%Y-%m-%d")
    slug  = "-".join(n.replace(" ", "_")[:12] for n in names[:3])

    try:
        if fmt == "docx":
            content  = build_bulk_docx(items, branding, analytics)
            media    = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            filename = f"{slug}_trademark_report_{today}.docx"
        elif fmt == "xlsx":
            content  = build_bulk_xlsx(items, branding, analytics)
            media    = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            filename = f"{slug}_trademark_report_{today}.xlsx"
        else:
            content  = build_bulk_dossier_pdf(items, branding, analytics)
            media    = "application/pdf"
            filename = f"{slug}_trademark_report_{today}.pdf"
    except ImportError as exc:
        logger.error("bulk/export missing library: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Server is missing a required library for {fmt.upper()} export: {exc}. "
                   "Please contact support or try a different format."
        )
    except Exception as exc:
        logger.exception("bulk/export file generation failed (fmt=%s)", fmt)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate {fmt.upper()} report: {exc}"
        )

    return Response(
        content=content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/searches")
async def qc_list_searches(limit: int = 25, user: User = Depends(get_current_user)):
    """List the user's past trademark availability searches."""
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    cursor = db.trademark_qc_reports.find(
        {"user_id": user_id},
        sort=[("created_at", -1)],
        limit=limit,
    )
    items = []
    async for doc in cursor:
        doc["id"] = str(doc.get("_id", doc.get("id", "")))
        doc.pop("_id", None)
        items.append(doc)
    return {"items": items, "count": len(items)}


@router.get("/searches/{report_id}/pdf")
async def qc_download_pdf_get(
    report_id: str,
    footer:    str = Query(""),
    tagline:   str = Query(""),
    watermark: str = Query(""),
    user: User = Depends(get_current_user),
):
    """Download a PDF for a stored availability report (GET — no logo)."""
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    doc = await db.trademark_qc_reports.find_one({"_id": report_id, "user_id": user_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Report not found")
    if footer or tagline or watermark:
        rep = dict(doc.get("report", {}))
        if footer:    rep["footer"]    = footer
        if tagline:   rep["tagline"]   = tagline
        if watermark: rep["watermark"] = watermark
        doc = {**doc, "report": rep}
    pdf_bytes = build_report_pdf(doc)
    rep_data  = doc.get("report") or {}
    name      = rep_data.get("query", "report")
    filename  = _pdf_filename(name, rep_data.get("class_filters"))
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(filename)},
    )


@router.post("/searches/{report_id}/pdf")
async def qc_download_pdf_post(
    report_id: str,
    body: dict = Body(default={}),
    user: User = Depends(get_current_user),
):
    """Download a PDF with branding (POST — supports logo in request body)."""
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    doc = await db.trademark_qc_reports.find_one({"_id": report_id, "user_id": user_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Report not found")
    rep = dict(doc.get("report", {}))
    for field in (
        "logo_data_url", "footer", "tagline", "watermark", "custom_watermark",
        "client_name", "client_mobile", "report_date", "prepared_by",
    ):
        if body.get(field) is not None:
            rep[field] = body[field]
    doc = {**doc, "report": rep}
    pdf_bytes = build_report_pdf(doc)
    name     = rep.get("query", "report")
    filename = _pdf_filename(name, rep.get("class_filters"))
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(filename)},
    )


@router.get("/searches/{report_id}")
async def qc_get_search(report_id: str, user: User = Depends(get_current_user)):
    """Fetch a single stored availability report."""
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    doc = await db.trademark_qc_reports.find_one({"_id": report_id, "user_id": user_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Report not found")
    doc["id"] = str(doc.get("_id", ""))
    doc.pop("_id", None)
    return doc


@router.delete("/searches/{report_id}")
async def qc_delete_search(report_id: str, user: User = Depends(get_current_user)):
    """Delete a stored report."""
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    result = await db.trademark_qc_reports.delete_one({"_id": report_id, "user_id": user_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"ok": True}


@router.get("/trademark-users")
async def get_trademark_users(
    user: User = Depends(get_current_user),
):
    """Return users who have access to Trademark Sphere (for 'Prepared By' dropdown)."""
    all_users = await db.users.find(
        {"is_active": True},
        {"_id": 0, "id": 1, "full_name": 1, "role": 1, "departments": 1, "permissions": 1}
    ).to_list(1000)

    trademark_users = []
    for u in all_users:
        role = u.get("role", "")
        perms = u.get("permissions", {}) or {}

        # Include admins (always have trademark access) OR users with explicit permission
        if role == "admin":
            trademark_users.append({"id": u["id"], "full_name": u.get("full_name", "Unknown")})
        elif perms.get("can_view_trademark_sphere", False):
            trademark_users.append({"id": u["id"], "full_name": u.get("full_name", "Unknown")})
        else:
            # Also include users in trademark-named departments as fallback
            depts = [d.lower() for d in u.get("departments", [])]
            if any(d in ("trademark", "trademarks", "trademark sphere", "ip") for d in depts):
                trademark_users.append({"id": u["id"], "full_name": u.get("full_name", "Unknown")})

    return trademark_users


@router.get("/check")
async def qc_quick_check(
    name: str = Query(...),
    cls:  Optional[int] = Query(None, alias="class"),
    user: User = Depends(get_current_user),
):
    """Quick availability check — returns verdict without saving."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    try:
        class_filters_check = [cls] if cls is not None else None
        scraped = await _qc_availability_search(name, class_filters=class_filters_check)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SCRAPER ERROR - {exc}")
    report = build_report(name, scraped, class_filter=cls)
    return {
        "query":          report["query"],
        "overall_status": report["overall_status"],
        "risk_score":     report["risk_score"],
        "headline":       report["headline"],
        "summary_counts": report["summary_counts"],
    }


@router.post("/class-finder")
async def qc_class_finder(
    body: dict = Body(default={}),
    user: User = Depends(get_current_user),
):
    """Suggest Nice classification classes from a goods/services description."""
    description = (body.get("description") or "").strip()
    top = int(body.get("top", 5))
    if not description:
        raise HTTPException(status_code=422, detail="description is required")
    results = find_classes(description, top=top)
    return {"classes": results, "query": description}


@router.get("/branding-preference")
async def qc_get_branding(user: User = Depends(get_current_user)):
    """Fetch user's saved default branding preference."""
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    pref = await db.trademark_qc_branding.find_one({"user_id": user_id}) or {}
    return {
        "default_company_id":   pref.get("default_company_id"),
        "default_company_name": pref.get("default_company_name"),
        "footer":    pref.get("footer", ""),
        "tagline":   pref.get("tagline", ""),
        "watermark": pref.get("watermark", ""),
    }


@router.post("/branding-preference")
async def qc_save_branding(body: BrandingPrefRequest, user: User = Depends(get_current_user)):
    """Save user's default branding preference."""
    user_id = str(getattr(user, "id", None) or user.get("_id", ""))
    await db.trademark_qc_branding.update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id":              user_id,
            "default_company_id":   body.default_company_id,
            "default_company_name": body.default_company_name,
            "footer":    body.footer,
            "tagline":   body.tagline,
            "watermark": body.watermark,
            "updated_at": datetime.utcnow().isoformat(),
        }},
        upsert=True,
    )
    return {"ok": True}


# ── Trademark Tracking Routes ──────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(user: User = Depends(get_current_user)):
    today     = date.today().isoformat()
    soon_90   = (date.today() + timedelta(days=90)).isoformat()
    soon_30   = (date.today() + timedelta(days=30)).isoformat()

    total      = await db.trademark_sphere.count_documents({})
    registered = await db.trademark_sphere.count_documents({"tm_status": "Registered"})
    pending    = await db.trademark_sphere.count_documents(
        {"tm_status": {"$in": ["Pending", "Under Examination", "Accepted & Advertised",
                                "Advertised Before Acceptance"]}}
    )
    expiring   = await db.trademark_sphere.count_documents(
        {"renewal_due": {"$gte": today, "$lte": soon_90}}
    )
    overdue    = await db.trademark_sphere.count_documents(
        {"renewal_due": {"$lt": today}}
    )
    reminders  = await db.trademark_sphere_reminders.count_documents(
        {"sent": False, "remind_on": {"$lte": soon_30}}
    )

    return {
        "total":              total,
        "registered":         registered,
        "pending":            pending,
        "expiring_soon":      expiring,
        "overdue":            overdue,
        "upcoming_reminders": reminders,
    }


@router.get("/list")
async def list_trademarks(
    skip:          int           = Query(0, ge=0),
    limit:         int           = Query(50, ge=1, le=200),
    search:        Optional[str] = Query(None),
    tm_status:     Optional[str] = Query(None),
    class_number:  Optional[str] = Query(None),
    renewal_alert: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
):
    flt: Dict[str, Any] = {}

    if search:
        flt["$or"] = [
            {"application_number": {"$regex": re.escape(search), "$options": "i"}},
            {"word_mark":          {"$regex": re.escape(search), "$options": "i"}},
            {"proprietor":         {"$regex": re.escape(search), "$options": "i"}},
        ]
    if tm_status:
        flt["tm_status"] = tm_status
    if class_number:
        flt["class_number"] = class_number
    if renewal_alert:
        flt["renewal_status"] = renewal_alert

    total = await db.trademark_sphere.count_documents(flt)
    cur   = db.trademark_sphere.find(flt).sort("created_at", -1).skip(skip).limit(limit)
    rows  = [
        {k: v for k, v in d.items() if k not in ("_id", "raw_data")}
        async for d in cur
    ]
    return {"items": rows, "total": total}


@router.get("/deadlines")
async def get_deadlines(
    days: int = Query(180, ge=1, le=730),
    user: User = Depends(get_current_user),
):
    today      = date.today()
    today_str  = today.isoformat()
    cutoff_str = (today + timedelta(days=days)).isoformat()

    overdue_cur  = db.trademark_sphere.find(
        {"renewal_due": {"$exists": True, "$lt": today_str}}
    ).sort("renewal_due", 1)
    upcoming_cur = db.trademark_sphere.find(
        {"renewal_due": {"$exists": True, "$gte": today_str, "$lte": cutoff_str}}
    ).sort("renewal_due", 1)

    def _strip(d):
        return {k: v for k, v in d.items() if k not in ("_id", "raw_data")}

    overdue  = [_strip(d) async for d in overdue_cur]
    upcoming = [_strip(d) async for d in upcoming_cur]

    return {"upcoming": upcoming, "overdue": overdue}


@router.get("/reminders")
async def get_reminders(user: User = Depends(get_current_user)):
    cur = db.trademark_sphere_reminders.find({"sent": False}).sort("remind_on", 1)
    return [{k: v for k, v in d.items() if k != "_id"} async for d in cur]


@router.get("/constants/all")
async def constants(user: User = Depends(get_current_user)):
    return {
        "statuses": [
            "Registered", "Pending", "Under Examination", "Objected", "Opposed",
            "Accepted & Advertised", "Advertised Before Acceptance",
            "Refused", "Abandoned", "Withdrawn", "Unknown",
        ]
    }


@router.get("/{tm_id}")
async def get_tm(tm_id: str, user: User = Depends(get_current_user)):
    d = await db.trademark_sphere.find_one({"id": tm_id})
    if not d:
        raise HTTPException(404, "Not found")
    return {k: v for k, v in d.items() if k != "_id"}


# ── Search routes ─────────────────────────────────────────────────────────────

@router.post("/search")
async def search_trademarks(
    body: SearchRequest,
    user: User = Depends(get_current_user),
):
    """Live search: QC word-mark search OR IP India word-mark search."""
    loop = asyncio.get_event_loop()
    if body.search_type == "application_no":
        data = await scrape_trademark(body.query)
        return {"query": body.query, "count": 1, "results": [data]}
    else:
        results = await loop.run_in_executor(
            _pool, _ip_search_by_wordmark, body.query, body.class_number
        )
        return {"query": body.query, "count": len(results), "results": results[:body.limit]}


@router.post("/search-ipindia")
async def search_ipindia(
    body: IpIndiaSearchRequest,
    user: User = Depends(get_current_user),
):
    """Dedicated IP India search endpoint."""
    loop = asyncio.get_event_loop()
    if body.search_type == "application_no":
        data = await loop.run_in_executor(
            _pool, _ip_search_by_application_number, body.query
        )
        return {"results": [data]}
    else:
        results = await loop.run_in_executor(
            _pool, _ip_search_by_wordmark, body.query, body.class_number
        )
        return {"results": results}


# ── OTP (no-op) ───────────────────────────────────────────────────────────────

@router.post("/send-otp")
async def send_otp_route(body: SendOtpRequest, user: User = Depends(get_current_user)):
    """No-op — neither QC nor IP India public search requires OTP."""
    session_id = await send_otp(body.email)
    return {
        "session_id": session_id,
        "message": "Ready. (No OTP needed — public search sources used.)",
    }


@router.post("/fetch-preview")
async def fetch_preview(body: TrademarkAddRequest, user: User = Depends(get_current_user)):
    """Fetch trademark data for preview before saving."""
    data = await scrape_trademark(body.application_number, body.class_number)
    return {**data, **_compute_deadlines(data)}


# ── CRUD ──────────────────────────────────────────────────────────────────────

@router.post("/add")
async def add_trademark(
    body: TrademarkAddRequest, bg: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    existing = await db.trademark_sphere.find_one(
        {"application_number": body.application_number.strip()}
    )
    if existing:
        raise HTTPException(409, f"Trademark {body.application_number} is already tracked.")

    raw = body.manual_data or await scrape_trademark(body.application_number, body.class_number)
    dl  = _compute_deadlines(raw)
    now = datetime.now(IST)
    tid = str(uuid.uuid4())
    doc = {
        "_id": tid, "id": tid,
        **{k: raw.get(k, "") for k in (
            "application_number", "word_mark", "class_number", "tm_status",
            "proprietor", "applicant_name", "filing_date", "registration_date",
            "valid_upto", "goods_and_services", "trademark_image_url", "address",
        )},
        "class_number":      raw.get("class_number") or body.class_number or "",
        "attorney":          body.attorney or raw.get("attorney", ""),
        "notes":             body.notes or "",
        "client_id":         body.client_id or "",
        "client_name":       body.client_name or "",
        "reminder_emails":   body.reminder_emails,
        "reminders_enabled": body.reminders_enabled,
        "last_fetched":      now.isoformat(),
        "created_at":        now.isoformat(),
        "updated_at":        now.isoformat(),
        "created_by":        user.id,
        "raw_data":          raw,
        "scrape_source":     raw.get("scrape_source", "quickcompany"),
        "documents":         raw.get("documents", []),
        "hearings":          raw.get("hearings"),
        **dl,
    }
    await db.trademark_sphere.insert_one(doc)
    bg.add_task(_gen_reminders, tid, doc)
    return {k: v for k, v in doc.items() if k not in ("_id", "raw_data")}


@router.post("/add-manual")
async def add_manual(
    body: TrademarkManualCreate, bg: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    existing = await db.trademark_sphere.find_one(
        {"application_number": body.application_number.strip()}
    )
    if existing:
        raise HTTPException(409, f"Trademark {body.application_number} is already tracked.")

    now = datetime.now(IST)
    tid = str(uuid.uuid4())
    raw = body.dict()
    doc = {
        "_id": tid, "id": tid,
        **raw,
        **_compute_deadlines(raw),
        "applicant_name":    raw.get("proprietor", ""),
        "trademark_image_url": "",
        "address":           "",
        "last_fetched":      None,
        "created_at":        now.isoformat(),
        "updated_at":        now.isoformat(),
        "created_by":        user.id,
        "raw_data":          {},
        "scrape_source":     "manual",
        "documents":         [],
        "hearings":          None,
    }
    await db.trademark_sphere.insert_one(doc)
    bg.add_task(_gen_reminders, tid, doc)
    return {k: v for k, v in doc.items() if k not in ("_id", "raw_data")}


@router.post("/import-attorney")
async def import_attorney(
    body: AttorneyImportRequest, bg: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    bg.add_task(
        _import_attorney_bg,
        body.agent_code, user.id, body.attorney, body.client_id,
        body.client_name, body.reminder_emails, body.reminders_enabled,
        body.session_id, body.otp,
    )
    return {
        "message":    f"Attorney portfolio import started for '{body.agent_code}'.",
        "agent_code": body.agent_code,
    }


@router.post("/portal-sync")
async def portal_sync_route(
    body: PortalSyncRequest, bg: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    sync_id = str(uuid.uuid4())
    _sync_progress[sync_id] = {
        "status": "queued", "phase": "Starting…", "total": 0, "done": 0,
    }
    bg.add_task(
        _portal_sync_bg, sync_id, body.agent_code.strip(),
        body.session_id, body.otp, user.id, body.attorney,
        body.client_id, body.reminder_emails, body.refresh_existing,
    )
    return {"sync_id": sync_id, "message": "Portal sync started."}


@router.get("/portal-sync/{sync_id}/status")
async def portal_sync_status(sync_id: str, user: User = Depends(get_current_user)):
    progress = _sync_progress.get(sync_id)
    if not progress:
        raise HTTPException(404, "Sync job not found.")
    return progress


@router.put("/{tm_id}")
async def update_tm(
    tm_id: str, body: TrademarkUpdateRequest, bg: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    upd = {k: v for k, v in body.dict().items() if v is not None}
    upd["updated_at"] = datetime.now(IST).isoformat()
    if "valid_upto" in upd:
        upd.update(_compute_deadlines(upd))

    res = await db.trademark_sphere.update_one({"id": tm_id}, {"$set": upd})
    if res.matched_count == 0:
        raise HTTPException(404, "Not found")
    d = await db.trademark_sphere.find_one({"id": tm_id})
    bg.add_task(_gen_reminders, tm_id, d)
    return {k: v for k, v in d.items() if k != "_id"}


@router.post("/{tm_id}/refresh")
async def refresh_tm(
    tm_id: str, bg: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    d = await db.trademark_sphere.find_one({"id": tm_id})
    if not d:
        raise HTTPException(404, "Not found")

    for prefix in ("qc::", "unified::"):
        _tm_cache.pop(f"{prefix}{d['application_number']}", None)

    raw = await scrape_trademark(d["application_number"])
    dl  = _compute_deadlines(raw)
    now = datetime.now(IST)
    upd = {
        **{k: raw.get(k) or d.get(k) for k in (
            "word_mark", "tm_status", "proprietor", "filing_date",
            "registration_date", "valid_upto", "goods_and_services",
            "trademark_image_url",
        )},
        "documents":     raw.get("documents", d.get("documents", [])),
        "hearings":      raw.get("hearings",  d.get("hearings")),
        "raw_data":      raw,
        "last_fetched":  now.isoformat(),
        "updated_at":    now.isoformat(),
        "scrape_source": raw.get("scrape_source", "quickcompany"),
        **dl,
    }
    await db.trademark_sphere.update_one({"id": tm_id}, {"$set": upd})
    bg.add_task(_gen_reminders, tm_id, {**d, **upd})
    return {k: v for k, v in {**d, **upd}.items() if k != "_id"}


@router.delete("/{tm_id}")
async def delete_tm(tm_id: str, user: User = Depends(get_current_user)):
    res = await db.trademark_sphere.delete_one({"id": tm_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    await db.trademark_sphere_reminders.delete_many({"trademark_id": tm_id})
    return {"deleted": tm_id}


@router.post("/sync/{application_number}")
async def sync_trademark(application_number: str, user: User = Depends(get_current_user)):
    data = await scrape_trademark(application_number)
    return data


@router.get("/health")
async def trademark_health():
    return {
        "status": "running",
        "module": "Trademark Sphere"
    }


@router.post("/watchlist")
async def create_watchlist(payload: dict, user: User = Depends(get_current_user)):
    return {"status": "ok", "message": "Watchlist feature coming soon"}


@router.get("/watchlist")
async def get_watchlists(user: User = Depends(get_current_user)):
    return []


@router.get("/search")
async def search_trademark_get(query: str, user: User = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(_pool, _qc_fetch_by_app_number, query)
    return result


# ── Combined / Bulk PDF ────────────────────────────────────────────────────────

class CombinedPdfItem(BaseModel):
    name: str
    overall_status: str = "UNKNOWN"
    risk_score: int = 0
    headline: str = ""
    class_filter: Optional[int] = None
    error: Optional[str] = None
    all_results: Optional[List[dict]] = []
    class_breakdown: Optional[List[dict]] = []
    summary_counts: Optional[dict] = {}
    recommendations: Optional[List[str]] = []
    alternative_name_suggestions: Optional[List[str]] = []

class CombinedPdfRequest(BaseModel):
    items: List[CombinedPdfItem]
    logo_data_url:    Optional[str] = None
    footer:           Optional[str] = ""
    tagline:          Optional[str] = "Bulk Trademark Availability Report"
    watermark:        Optional[str] = ""
    custom_watermark: Optional[str] = ""
    client_name:      Optional[str] = ""
    client_mobile:    Optional[str] = ""
    report_date:      Optional[str] = ""
    prepared_by:      Optional[str] = ""

@router.post("/combined-pdf")
async def generate_combined_pdf(
    body: CombinedPdfRequest,
    user: User = Depends(get_current_user),
):
    items_data = [it.dict() for it in body.items]
    branding = {
        "logo_data_url":    body.logo_data_url,
        "footer_text":      body.footer or "",
        "tagline":          body.tagline or "Bulk Trademark Availability Report",
        "watermark":        body.watermark or "",
        "custom_watermark": body.custom_watermark or "",
        "client_name":      body.client_name or "",
        "client_mobile":    body.client_mobile or "",
        "report_date":      body.report_date or "",
        "prepared_by":      body.prepared_by or "",
    }
    pdf_bytes = build_combined_report_pdf(items_data, branding)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=bulk_trademark_report.pdf"},
    )
