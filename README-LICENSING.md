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

## API-level enforcement

`backend/license-runtime.cjs` is loaded before the Taskosphere application starts. When `LICENSE_ENFORCEMENT=true`, it installs an Express middleware layer and checks the central licensing service before protected Taskosphere API requests are allowed to reach the application's existing routes.

The enforcement layer:

- Rejects an unactivated installation
- Rejects expired, suspended or revoked licenses
- Checks the package's module entitlements server-side
- Blocks Accounting endpoints for packages without `ACCOUNTING`
- Blocks HRMS endpoints for packages without `HRMS`
- Blocks Invoicing endpoints for packages without `INVOICING`
- Blocks Task Management endpoints for packages without `TASKS`
- Registers the installation with the licensing authority during activation
- Performs periodic heartbeat validation
- Supports a configurable offline grace period

This is deliberately server-side; hiding menu items in React is not treated as a security boundary.

## URLs

- Master Console: `/master-console`
- Customer activation: `/activate-license`
- Licensing API: `/api/licensing/...` on the dedicated licensing service

## Environment variables

Copy `.env.example` and configure the licensing service. In production, set a strong random `MASTER_CONSOLE_TOKEN`; do not use the development default.

The frontend uses `VITE_LICENSE_API_URL` to locate the dedicated licensing API. For local development it defaults to `http://localhost:3100/api`.

The Taskosphere application uses `LICENSE_API_URL` to call the central licensing service for activation and heartbeat checks. Configure the licensing URL before enabling enforcement.

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

### Taskosphere application commands

Build:

`npm run build`

Start:

`npm run start`

The normal application start command now preloads the licensing runtime. Enforcement remains disabled unless `LICENSE_ENFORCEMENT=true` is explicitly configured.

## Important production persistence note

The current licensing registry uses a JSON file. This is suitable for development and controlled testing, but a commercial licensing authority should use durable storage or a persistent disk before launch so licenses are not lost during service replacement or redeployment.

## Recommended rollout

1. Deploy the licensing service with `LICENSE_ENFORCEMENT=false`.
2. Configure the Taskosphere application with `LICENSE_API_URL` pointing to the licensing service.
3. Generate a test Essential license from Master Console.
4. Activate a clean Taskosphere installation with that license.
5. Confirm Tasks and Invoicing work.
6. Confirm Accounting and HRMS API calls return `403 MODULE_NOT_LICENSED`.
7. Test suspension, revocation and expiry.
8. Test the configured offline grace period.
9. Only then enable `LICENSE_ENFORCEMENT=true` for customer deployments.
