# Taskosphere Commercial Licensing

The `feature/master-console` branch contains the first Master Console foundation for commercial licensing.

## Current packages

- **Taskosphere Essential** — Task Management + Invoicing
- **Taskosphere Professional** — Task Management + Invoicing + HRMS
- **Taskosphere Enterprise** — Task Management + Invoicing + Accounting + HRMS

## Master Console

Open `/master-console` after signing in as an administrator.

The first implementation provides:

- Package-aware license generation
- Customer details
- Random license numbers in `TSO-XXXX-XXXX-XXXX-XXXX` format
- License search
- Active/suspended/revoked controls
- Validity and user/install limits
- Package entitlement display

## Important limitation of this phase

This is the **Master Console UI and licensing foundation**, not yet the production licensing authority. License records are currently persisted in the browser's local storage so the interface can be developed and tested without changing the application's existing persistence layer.

Before commercial launch, the next phase should move license records to a server-side database/service and add:

1. Server-side license generation and validation
2. Activation endpoint and installation registration
3. Customer-side license activation screen
4. Backend module-entitlement enforcement
5. Renewal, upgrade and grace-period logic
6. Audit events
7. Master-admin authentication separate from ordinary customer admins
8. Signed validation responses / secure licensing secret management

Do not use the current local-storage license records as the final production licensing mechanism.
