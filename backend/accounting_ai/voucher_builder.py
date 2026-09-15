"""Production voucher numbering and voucher persistence for Finix.

Voucher numbers are business identifiers, not UUIDs.  They are generated from
an atomic MongoDB sequence scoped by company, voucher type and Indian
financial year (April-March).  The UUID remains the immutable database id.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
import uuid
import logging

from backend.dependencies import db
from backend.accounting_ai.accounting_controls import validate_balanced_lines, money
from backend.accounting_ai.posting_storage import PostingStorage

logger = logging.getLogger("voucher_builder")


VOUCHER_PREFIXES = {
    "PURCHASE": "PV",
    "SALE": "SV",
    "JOURNAL": "JV",
    "PAYMENT": "PMT",
    "RECEIPT": "RCPT",
    "CONTRA": "CV",
    "EXPENSE": "EV",
    "PURCHASE_RETURN": "PRV",
    "SALE_RETURN": "SRV",
    "DEBIT_NOTE": "DN",
    "CREDIT_NOTE": "CN",
    "ADVANCE_PAYMENT": "APV",
    "ADVANCE_RECEIPT": "ARV",
    "RCM_PURCHASE": "RCM",
    "FIXED_ASSET": "FAV",
    "PAYROLL": "PAY",
    "DEPRECIATION": "DEP",
    "GST_PAYMENT": "GSTP",
    "TDS_PAYMENT": "TDSP",
    "STOCK_JOURNAL": "STJ",
    "BANK_CHARGE": "BCV",
    "BANK_TRANSFER": "BTV",
}


def _financial_year(value: Optional[Any] = None) -> str:
    """Return the Indian financial year label, e.g. ``2026-27``."""
    if value is None:
        dt = date.today()
    elif isinstance(value, datetime):
        dt = value.date()
    elif isinstance(value, date):
        dt = value
    else:
        text = str(value).strip()
        try:
            dt = date.fromisoformat(text[:10])
        except ValueError as exc:
            raise ValueError(f"Invalid voucher date '{value}'. Expected YYYY-MM-DD.") from exc

    start_year = dt.year if dt.month >= 4 else dt.year - 1
    return f"{start_year}-{str(start_year + 1)[-2:]}"


class VoucherBuilder:
    """Builds immutable business vouchers around already-balanced journals."""

    @staticmethod
    async def _ensure_sequence_index() -> None:
        """Ensure the sequence key is unique before incrementing it.

        The unique index is essential in multi-worker deployments: two API
        workers must never create two sequence documents for the same company,
        voucher type and financial year.
        """
        await db.accounting_sequences.create_index(
            [("company_id", 1), ("voucher_type", 1), ("financial_year", 1)],
            unique=True,
            name="uq_accounting_voucher_sequence",
        )

    @classmethod
    async def next_voucher_number(
        cls,
        company_id: str,
        voucher_type: str,
        voucher_date: Optional[Any] = None,
    ) -> str:
        """Atomically allocate the next voucher number for a business key."""
        normalized_type = str(voucher_type or "JOURNAL").strip().upper()
        prefix = VOUCHER_PREFIXES.get(normalized_type, "VCH")
        financial_year = _financial_year(voucher_date)

        await cls._ensure_sequence_index()

        from pymongo import ReturnDocument

        sequence = await db.accounting_sequences.find_one_and_update(
            {
                "company_id": company_id,
                "voucher_type": normalized_type,
                "financial_year": financial_year,
            },
            {
                "$inc": {"next_number": 1},
                "$set": {"updated_at": datetime.utcnow().isoformat()},
                "$setOnInsert": {
                    "id": str(uuid.uuid4()),
                    "company_id": company_id,
                    "voucher_type": normalized_type,
                    "financial_year": financial_year,
                    "created_at": datetime.utcnow().isoformat(),
                },
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        if not sequence or not sequence.get("next_number"):
            raise RuntimeError(
                f"Unable to allocate voucher sequence for {company_id}/{normalized_type}/{financial_year}."
            )

        number = int(sequence["next_number"])
        return f"{prefix}/{financial_year}/{number:06d}"

    @staticmethod
    def generate_voucher_number(
        company_id: str,
        voucher_type: str,
        count: int = 1,
        voucher_date: Optional[Any] = None,
    ) -> str:
        """Compatibility shim for legacy synchronous callers.

        New posting paths must use :meth:`next_voucher_number`, because a
        synchronous UUID generator cannot provide accounting-grade sequencing.
        """
        normalized_type = str(voucher_type or "JOURNAL").strip().upper()
        prefix = VOUCHER_PREFIXES.get(normalized_type, "VCH")
        financial_year = _financial_year(voucher_date)
        return f"{prefix}/{financial_year}/PENDING"

    @classmethod
    async def create_and_save_voucher(
        cls,
        company_id: str,
        voucher_type: str,
        document_id: str,
        journal_entry_id: str,
        party_name: str,
        total_amount: float,
        journal_lines: List[Dict[str, Any]],
        voucher_date: Optional[Any] = None,
        status: str = "POSTED",
    ) -> Dict[str, Any]:
        """Create and persist a production voucher.

        The voucher is only persisted after the supplied journal lines pass
        deterministic balance validation.  The journal remains the source of
        accounting truth; this document is the business-facing voucher layer.
        """
        if not journal_entry_id:
            raise ValueError("journal_entry_id is required before a voucher can be created.")
        if not document_id:
            raise ValueError("document_id is required before a voucher can be created.")

        debit_total, credit_total = validate_balanced_lines(journal_lines)
        voucher_amount = money(total_amount)
        if voucher_amount <= 0:
            raise ValueError("Voucher amount must be greater than zero.")

        # The voucher total should agree with the journal's balanced amount.
        # A small paise-level tolerance is permitted for presentation values,
        # but a material difference is a posting defect and must be reviewed.
        if abs(voucher_amount - debit_total) > Decimal("0.01"):
            raise ValueError(
                f"Voucher total {voucher_amount} does not match journal total {debit_total}."
            )

        voucher_id = str(uuid.uuid4())
        vch_num = await cls.next_voucher_number(
            company_id=company_id,
            voucher_type=voucher_type,
            voucher_date=voucher_date,
        )

        voucher_data = {
            "voucher_type": str(voucher_type or "JOURNAL").strip().upper(),
            "voucher_number": vch_num,
            "document_id": document_id,
            "journal_entry_id": journal_entry_id,
            "party_name": (party_name or "").strip() or "Unspecified Party",
            "total_amount": float(voucher_amount),
            "details": {
                "journal_lines_count": len(journal_lines),
                "debit_total": float(debit_total),
                "credit_total": float(credit_total),
                "memo_sample": journal_lines[0].get("memo", "") if journal_lines else "",
                "status": str(status or "POSTED").upper(),
            },
        }

        await PostingStorage.save_voucher_history(voucher_id, company_id, voucher_data)
        voucher_data["id"] = voucher_id
        return voucher_data
