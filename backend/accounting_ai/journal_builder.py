"""
Journal Builder — Constructs deterministic, double-entry journal entries.

The builder is deliberately conservative: it never invents a ledger, party,
transaction type, tax amount, or material round-off. Accounting values are
validated in paise before journal lines are returned to the posting engine.
"""

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Dict, Any, List
import logging

from backend.accounting_ai.accounting_controls import (
    AccountingControlError,
    normalize_document_type,
    validate_balanced_lines,
)
from backend.accounting_ai.chart_of_accounts import ChartOfAccountsManager

logger = logging.getLogger("journal_builder")

PAISE = Decimal("0.01")
MAX_AUTOMATIC_ROUNDOFF = Decimal("0.99")
SUPPORTED_JOURNAL_TYPES = {"PURCHASE", "SALE"}


def _money(value: Any, field: str) -> Decimal:
    """Parse a monetary value using Decimal and quantize to Indian paise."""
    try:
        amount = Decimal(str(value if value is not None else "0")).quantize(
            PAISE, rounding=ROUND_HALF_UP
        )
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise AccountingControlError(f"{field} must be a valid monetary amount.") from exc
    if not amount.is_finite():
        raise AccountingControlError(f"{field} must be finite.")
    if amount < 0:
        raise AccountingControlError(f"{field} cannot be negative.")
    return amount


def _require_account(account: Any, category: str) -> Dict[str, Any]:
    """Require a resolved, usable account; never substitute another ledger."""
    if not isinstance(account, dict) or not account.get("id"):
        raise AccountingControlError(
            f"Required {category} account could not be resolved; journal requires review."
        )
    return account


class JournalBuilder:
    @classmethod
    async def build_journal_lines(
        cls,
        company_id: str,
        doc_type: str,
        extracted_data: Dict[str, Any],
        resolved_ledger_code: str,
        gst_split: Dict[str, float],
        tds_result: Dict[str, Any],
        dimensions: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        """Build and validate deterministic journal lines for a supported event."""
        if not company_id or not str(company_id).strip():
            raise AccountingControlError("company_id is required to build a journal.")
        if not isinstance(extracted_data, dict):
            raise AccountingControlError("extracted_data must be an object.")
        if not isinstance(gst_split, dict):
            raise AccountingControlError("gst_split must be an object.")
        if tds_result is not None and not isinstance(tds_result, dict):
            raise AccountingControlError("tds_result must be an object or null.")
        if dimensions is None:
            dimensions = {}
        if not isinstance(dimensions, dict):
            raise AccountingControlError("dimensions must be an object.")

        event = normalize_document_type(doc_type)
        if event == "UNCLASSIFIED" or event not in SUPPORTED_JOURNAL_TYPES:
            raise AccountingControlError(
                f"Journal construction is not supported for transaction type '{doc_type}'."
            )

        if not resolved_ledger_code or not str(resolved_ledger_code).strip():
            raise AccountingControlError(
                f"No resolved ledger code supplied for {event}; refusing to guess an account."
            )

        taxable_value = _money(extracted_data.get("taxable_value"), "taxable_value")
        total_invoice_value = _money(
            extracted_data.get("total_invoice_value"), "total_invoice_value"
        )
        party_name = str(extracted_data.get("vendor_or_customer_name") or "").strip()
        if not party_name:
            raise AccountingControlError(
                f"{event} journal requires a resolved vendor/customer; refusing 'Unknown Party'."
            )
        invoice_no = str(extracted_data.get("invoice_number") or "").strip()

        # FX conversion is allowed only when a valid positive rate is explicitly
        # supplied. The source values remain unchanged; only the accounting
        # amounts returned by this builder are converted to INR.
        fx = extracted_data.get("fx") or {}
        if not isinstance(fx, dict):
            raise AccountingControlError("fx metadata must be an object when supplied.")
        fx_rate = _money(fx.get("rate_to_inr", 1), "fx.rate_to_inr")
        if fx_rate <= 0:
            raise AccountingControlError("fx.rate_to_inr must be greater than zero.")
        if fx_rate != Decimal("1.00"):
            taxable_value = (taxable_value * fx_rate).quantize(PAISE, rounding=ROUND_HALF_UP)
            total_invoice_value = (total_invoice_value * fx_rate).quantize(PAISE, rounding=ROUND_HALF_UP)

        cgst = _money(gst_split.get("cgst", 0), "gst_split.cgst")
        sgst = _money(gst_split.get("sgst", 0), "gst_split.sgst")
        igst = _money(gst_split.get("igst", 0), "gst_split.igst")
        if fx_rate != Decimal("1.00"):
            cgst = (cgst * fx_rate).quantize(PAISE, rounding=ROUND_HALF_UP)
            sgst = (sgst * fx_rate).quantize(PAISE, rounding=ROUND_HALF_UP)
            igst = (igst * fx_rate).quantize(PAISE, rounding=ROUND_HALF_UP)
        total_tax = cgst + sgst + igst

        # The tax engine's taxable amount plus tax must reconcile to the invoice
        # total before any legitimate invoice-level round-off is considered.
        expected_before_roundoff = taxable_value + total_tax
        source_difference = total_invoice_value - expected_before_roundoff
        if abs(source_difference) > MAX_AUTOMATIC_ROUNDOFF:
            raise AccountingControlError(
                f"Invoice total does not reconcile with taxable value plus GST: "
                f"difference {source_difference}. Journal requires review."
            )

        ar_acct = _require_account(
            await ChartOfAccountsManager.get_default_account_for_category(company_id, "receivable"),
            "receivable",
        )
        ap_acct = _require_account(
            await ChartOfAccountsManager.get_default_account_for_category(company_id, "payable"),
            "payable",
        )
        gst_in_acct = _require_account(
            await ChartOfAccountsManager.get_default_account_for_category(company_id, "gst_input"),
            "GST input",
        )
        gst_out_acct = _require_account(
            await ChartOfAccountsManager.get_default_account_for_category(company_id, "gst_output"),
            "GST output",
        )
        tds_acct = _require_account(
            await ChartOfAccountsManager.get_default_account_for_category(company_id, "tds"),
            "TDS payable",
        )
        roundoff_acct = _require_account(
            await ChartOfAccountsManager.get_default_account_for_category(company_id, "roundoff"),
            "round-off",
        )
        core_acct = _require_account(
            await ChartOfAccountsManager.lookup_by_code(company_id, str(resolved_ledger_code).strip()),
            f"resolved ledger {resolved_ledger_code}",
        )

        lines: List[Dict[str, Any]] = []
        memo_suffix = f" — Inv {invoice_no}" if invoice_no else ""

        def add_line(account: Dict[str, Any], name: str, debit: Decimal, credit: Decimal, memo: str):
            lines.append({
                "account_id": account["id"],
                "account_name": name,
                "debit": float(debit),
                "credit": float(credit),
                "memo": memo,
                **dimensions,
            })

        if event == "PURCHASE":
            add_line(core_acct, core_acct.get("name", "Purchases"), taxable_value, Decimal("0"), f"{party_name}{memo_suffix}")

            if cgst:
                add_line(gst_in_acct, "GST Input Credit (CGST)", cgst, Decimal("0"), f"CGST Input{memo_suffix}")
            if sgst:
                add_line(gst_in_acct, "GST Input Credit (SGST)", sgst, Decimal("0"), f"SGST Input{memo_suffix}")
            if igst:
                add_line(gst_in_acct, "GST Input Credit (IGST)", igst, Decimal("0"), f"IGST Input{memo_suffix}")

            deduction = Decimal("0")
            if tds_result and tds_result.get("applicable"):
                deduction = _money(tds_result.get("deduction_amount"), "tds.deduction_amount")
                if deduction > total_invoice_value:
                    raise AccountingControlError("TDS deduction cannot exceed invoice value.")
                section = str(tds_result.get("section") or "").strip()
                if not section:
                    raise AccountingControlError("Applicable TDS requires a section.")
                add_line(
                    tds_acct,
                    f"TDS Payable Sec {section}",
                    Decimal("0"),
                    deduction,
                    f"TDS deduction Sec {section}{memo_suffix}",
                )

            net_vendor_payable = total_invoice_value - deduction
            add_line(ap_acct, "Accounts Payable", Decimal("0"), net_vendor_payable, f"Payable to {party_name}{memo_suffix}")

        else:  # SALE
            add_line(ar_acct, "Accounts Receivable", total_invoice_value, Decimal("0"), f"Billed to {party_name}{memo_suffix}")
            add_line(core_acct, core_acct.get("name", "Sales / Fee Income"), Decimal("0"), taxable_value, f"Sales revenue{memo_suffix}")

            if cgst:
                add_line(gst_out_acct, "GST Output Payable (CGST)", Decimal("0"), cgst, f"CGST Liability{memo_suffix}")
            if sgst:
                add_line(gst_out_acct, "GST Output Payable (SGST)", Decimal("0"), sgst, f"SGST Liability{memo_suffix}")
            if igst:
                add_line(gst_out_acct, "GST Output Payable (IGST)", Decimal("0"), igst, f"IGST Liability{memo_suffix}")

        # Only an explicit invoice-level paise/rupee rounding difference can be
        # auto-adjusted. A multi-rupee discrepancy is an accounting error, not
        # a round-off opportunity.
        total_debit = sum(_money(line["debit"], "journal debit") for line in lines)
        total_credit = sum(_money(line["credit"], "journal credit") for line in lines)
        diff = (total_debit - total_credit).quantize(PAISE, rounding=ROUND_HALF_UP)

        if diff:
            if abs(diff) > MAX_AUTOMATIC_ROUNDOFF:
                logger.error(
                    "Journal balance discrepancy: company=%s event=%s debit=%s credit=%s",
                    company_id, event, total_debit, total_credit,
                )
                raise AccountingControlError(
                    f"Journal balance mismatch of {diff}; transaction requires review."
                )
            if diff > 0:
                add_line(roundoff_acct, "Round Off", Decimal("0"), diff, "Invoice round-off adjustment")
            else:
                add_line(roundoff_acct, "Round Off", -diff, Decimal("0"), "Invoice round-off adjustment")

        try:
            validate_balanced_lines(lines)
        except Exception as exc:
            raise AccountingControlError(
                f"Journal validation failed for {event}; transaction requires review: {exc}"
            ) from exc

        return lines
