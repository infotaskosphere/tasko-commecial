# Finix AI Accounting Architecture

## Product goal

Finix should let a non-accountant describe what happened in ordinary language and receive a correct accounting result, while retaining the deterministic controls expected from professional accounting software.

## Architecture

1. **Input layer** — invoice/PDF/image, bank statement, import, form, or natural language.
2. **AI interpretation** — identify transaction event, amount, party, tax clues, payment mode, and missing facts.
3. **Accounting memory** — vendor/customer history, GSTIN, previous approved ledger, cost centre, project and correction history.
4. **Deterministic policy** — canonical voucher type, GST/TDS treatment, period lock, duplicate checks and statutory validations.
5. **Journal builder** — construct double-entry lines using only resolved postable ledgers.
6. **Validation shield** — debit = credit, GST reconciliation, account ownership, duplicate detection and date/lock checks.
7. **Posting** — create journal + voucher atomically/idempotently where possible.
8. **Learning** — capture approved corrections as evidence; never learn from an unapproved proposal.
9. **Reporting** — Trial Balance, P&L, Balance Sheet, Day Book, ledgers, outstanding, cash/bank, GST/TDS and reconciliation all consume the same journal source.

## Layman experience

The user should be able to type examples such as:

- `Paid rent of ₹35,000 to ABC Properties by HDFC Bank.`
- `Received ₹1,20,000 from Sunrise Foods against invoice INV-102.`
- `Bought a laptop for ₹75,000 from Dell on credit.`
- `Transferred ₹50,000 from HDFC to ICICI.`

Finix should respond with:

- what it understood;
- the proposed voucher type;
- the ledgers it intends to use;
- GST/TDS implications when relevant;
- confidence and evidence;
- only the minimum clarification questions required;
- a human-readable explanation;
- a preview before posting whenever confidence/control policy requires it.

## Safety principle

AI is an interpreter and recommender, not the accounting authority. It must never silently invent a ledger, tax treatment, party, amount, or statutory classification. Low-confidence or materially ambiguous transactions go to review.
