"""
Posting Rules — Configurable, dynamic rules framework for accounting events.

Safety contract:
- A transaction event must never silently inherit another event's rules.
- Unknown/unclassified events require explicit review unless company-specific
  rules exist for that exact event type.
- Stored rules are validated before they are returned to the posting engine.
- Database failures fail closed instead of falling back to a potentially
  incorrect accounting treatment.
"""

from typing import Dict, Any
import logging

from backend.accounting_ai.accounting_controls import (
    AccountingControlError,
    normalize_document_type,
)
from backend.accounting_ai.posting_storage import PostingStorage

logger = logging.getLogger("posting_rules")

DEFAULT_RULES: Dict[str, Dict[str, Any]] = {
    "PURCHASE": {
        "debit_mapping": [
            {"account_group": "purchases", "ratio": 1.0, "memo_prefix": "Purchase Item"}
        ],
        "credit_mapping": [
            {"account_group": "payable", "ratio": 1.0, "memo_prefix": "Accounts Payable"}
        ],
        "gst_allowed": True,
        "tds_allowed": True,
    },
    "SALE": {
        "debit_mapping": [
            {"account_group": "receivable", "ratio": 1.0, "memo_prefix": "Accounts Receivable"}
        ],
        "credit_mapping": [
            {"account_group": "sales", "ratio": 1.0, "memo_prefix": "Sales / Fee Income"}
        ],
        "gst_allowed": True,
        "tds_allowed": False,
    },
    "EXPENSE": {
        "debit_mapping": [
            {"account_group": "software", "ratio": 1.0, "memo_prefix": "Expense allocation"}
        ],
        "credit_mapping": [
            {"account_group": "payable", "ratio": 1.0, "memo_prefix": "Vendor Payable"}
        ],
        "gst_allowed": True,
        "tds_allowed": True,
    },
    "DEPRECIATION": {
        "debit_mapping": [
            {"account_code": "5300", "ratio": 1.0, "memo_prefix": "Depreciation Expense"}
        ],
        "credit_mapping": [
            {"account_code": "1300", "ratio": 1.0, "memo_prefix": "Accumulated Depreciation"}
        ],
        "gst_allowed": False,
        "tds_allowed": False,
    },
    "PAYROLL": {
        "debit_mapping": [
            {"account_code": "5100", "ratio": 1.0, "memo_prefix": "Salary disbursement"}
        ],
        "credit_mapping": [
            {"account_code": "1010", "ratio": 1.0, "memo_prefix": "Salary Payable / Bank payout"}
        ],
        "gst_allowed": False,
        "tds_allowed": True,
    },
}


def _normalise_event_type(event_type: str) -> str:
    """Return a canonical event key or raise instead of guessing."""
    if event_type is None or not str(event_type).strip():
        raise AccountingControlError(
            "Posting rule lookup requires a transaction event type; refusing to guess."
        )

    event_key = normalize_document_type(event_type)
    if event_key == "UNCLASSIFIED":
        raise AccountingControlError(
            f"Transaction event type '{event_type}' is unclassified; posting rules cannot be inferred."
        )
    return event_key


def _validate_rules(event_key: str, rules: Any) -> Dict[str, Any]:
    """Validate the minimum posting-rule contract before it reaches posting."""
    if not isinstance(rules, dict):
        raise AccountingControlError(
            f"Posting rules for {event_key} are invalid: expected an object."
        )

    debit_mapping = rules.get("debit_mapping")
    credit_mapping = rules.get("credit_mapping")
    if not isinstance(debit_mapping, list) or not debit_mapping:
        raise AccountingControlError(
            f"Posting rules for {event_key} require a non-empty debit_mapping."
        )
    if not isinstance(credit_mapping, list) or not credit_mapping:
        raise AccountingControlError(
            f"Posting rules for {event_key} require a non-empty credit_mapping."
        )

    for side, mappings in (("debit", debit_mapping), ("credit", credit_mapping)):
        for index, mapping in enumerate(mappings):
            if not isinstance(mapping, dict):
                raise AccountingControlError(
                    f"Posting rules for {event_key} have an invalid {side}_mapping[{index}]."
                )
            if not mapping.get("account_id") and not mapping.get("account_code") and not mapping.get("account_group"):
                raise AccountingControlError(
                    f"Posting rules for {event_key} have no account selector in "
                    f"{side}_mapping[{index}]."
                )
            if "ratio" in mapping:
                try:
                    ratio = float(mapping["ratio"])
                except (TypeError, ValueError):
                    raise AccountingControlError(
                        f"Posting rules for {event_key} have a non-numeric ratio in "
                        f"{side}_mapping[{index}]."
                    )
                if ratio <= 0:
                    raise AccountingControlError(
                        f"Posting rules for {event_key} have a non-positive ratio in "
                        f"{side}_mapping[{index}]."
                    )

    for flag in ("gst_allowed", "tds_allowed"):
        if flag in rules and not isinstance(rules[flag], bool):
            raise AccountingControlError(
                f"Posting rules for {event_key} contain a non-boolean {flag} flag."
            )

    return rules


class PostingRulesEvaluator:
    @staticmethod
    async def get_rules_for_event(company_id: str, event_type: str) -> Dict[str, Any]:
        """
        Retrieve rules for the exact event type.

        Resolution order:
        1. Company-specific rules for the exact event.
        2. Built-in rules for that exact event.

        There is deliberately no cross-event fallback. If an event cannot be
        classified, or its rules cannot be safely loaded, the caller receives
        an AccountingControlError and must route the transaction to review.
        """
        if not company_id or not str(company_id).strip():
            raise AccountingControlError("Posting rule lookup requires a company_id.")

        event_key = _normalise_event_type(event_type)

        try:
            stored = await PostingStorage.get_accounting_rules(company_id, event_key)
        except Exception as exc:
            logger.exception(
                "Unable to load posting rules for company=%s event=%s",
                company_id,
                event_key,
            )
            raise AccountingControlError(
                f"Unable to safely load posting rules for {event_key}; transaction requires review."
            ) from exc

        if stored is not None:
            if not isinstance(stored, dict) or "rules" not in stored:
                raise AccountingControlError(
                    f"Stored posting rules for {event_key} are malformed; transaction requires review."
                )
            return _validate_rules(event_key, stored["rules"])

        default_rules = DEFAULT_RULES.get(event_key)
        if default_rules is None:
            raise AccountingControlError(
                f"No posting rules exist for transaction type {event_key}; transaction requires review."
            )

        return _validate_rules(event_key, default_rules)

    @staticmethod
    async def save_custom_rules(company_id: str, event_type: str, rules: Dict[str, Any]):
        """Validate and save company-specific rules for an exact event type."""
        if not company_id or not str(company_id).strip():
            raise AccountingControlError("Saving posting rules requires a company_id.")

        event_key = _normalise_event_type(event_type)
        validated_rules = _validate_rules(event_key, rules)
        await PostingStorage.save_accounting_rules(company_id, event_key, validated_rules)
