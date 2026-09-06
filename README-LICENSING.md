# Taskosphere Commercial Licensing

The `feature/master-console` branch contains the Master Console and the first server-side licensing control plane.

## Commercial packages

- **Taskosphere Essential** — Task Management + Invoicing
- **Taskosphere Professional** — Task Management + Invoicing + HRMS
- **Taskosphere Enterprise** — Task Management + Invoicing + Accounting + HRMS

## What is now server-side

The browser no longer owns the authoritative license registry. The dedicated `licensing-server.ts` service uses `backend/licensing.ts` to store licenses, customers, packages and installation activations on the server filesystem.

The licensing API supports:

- Server-side license generation
- License validation
- Customer activation
- Installation registration and limits
- Installation heartbeat
- Suspend / revoke / reactivate
- Package upgrades
- Package configuration
- Master Console authentication

## URLs

- Master Console: `/master-console`
- Customer activation: `/activate-license`
- Licensing API: `/api/licensing/...` on the dedicated licensing service

## Environment variables

Copy `.env.example` and configure the licensing service. In production, set a strong random `MASTER_CONSOLE_TOKEN`; do not use the development default.

The frontend uses `VITE_LICENSE_API_URL` to locate the dedicated licensing API. For local development it defaults to `http://localhost:3100/api`.

## Deployment architecture

The repository now contains two deployable Node services:

1. **Taskosphere application** — existing `server.ts`
2. **Taskosphere Licensing** — `licensing-server.ts`

On Render, these can be deployed as separate services from the same repository. Render supports multiple independently deployed services from one repository. The licensing service should normally be the authoritative public API for license activation and the Master Console. urlRender monorepo deployment guidancehttps://render.com/docs/monorepo-support

### Licensing service commands

Build:

`npm run build:licensing`

Start:

`npm run start:licensing`

## Current enforcement status

The licensing authority and activation workflow are now server-side, but **production API module enforcement is intentionally not enabled yet**. `LICENSE_ENFORCEMENT=false` is the safe default while the activation flow is being tested.

The next hardening phase should connect every Taskosphere API request to the licensing authority and enforce:

- TASKS entitlement
- INVOICING entitlement
- ACCOUNTING entitlement
- HRMS entitlement
- User limits
- Expiry / grace periods
- Revoked installation handling
- Offline validation policy
- Audit events

Do not set `LICENSE_ENFORCEMENT=true` in a customer deployment until those API-level checks have been tested end-to-end.
