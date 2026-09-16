# Finix AI Accounting Merge Plan

This document records the safe integration sequence for Finix AI Accounting after Finix Phase 1 accounting safety was merged into `feature/master-console`.

1. Merge `finix-ai-accounting-upgrade` into `feature/master-console`.
2. Verify the existing accounting posting boundary and party-ledger APIs before enabling AI posting.
3. Register the Finix AI router without changing existing accounting APIs.
4. Add the Finix AI Workspace route and approval/post flow.
5. Make natural-language proposals resolve against the existing company, customer/vendor, ledger, GST, bank and invoice context.
6. Route approved transactions through the existing governed posting/invoice/payment controls.
7. Add regression coverage for interpretation, proposal resolution, approval and posting safeguards.

Existing accounting controls remain authoritative; Finix AI must not bypass them.
