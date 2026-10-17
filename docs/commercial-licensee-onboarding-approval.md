# Commercial Licensee Onboarding Approval

## What is included

- New **Master Console → Onboarding Approval** tab.
- Public Google Form submissions are stored in the control-plane collection `commercial_onboarding_applications`.
- Platform-owner-only application search, filtering, review, and approve/reject/under-review actions.
- Approval uses the existing commercial licensing generator, including customer record, dedicated tenant database, license, admin placeholder, and invoice.
- Application and review audit records use `commercial_onboarding_applications` and `commercial_onboarding_audit`.

## Google Form bridge

The Apps Script bridge is at `integrations/google-form/Code.gs`.

The provided /exec URL identifies an existing Apps Script deployment; updating this Git repository will not edit or redeploy that Apps Script project by itself. Copy the file above into the script project attached to the Google Form (Extensions → Apps Script) and then install the trigger.

### Backend environment variable

Add a strong random value to the backend deployment environment:

`COMMERCIAL_ONBOARDING_WEBHOOK_SECRET`

Do not put the secret in source control or in the public form.

### Apps Script Project Settings → Script Properties

Set these two properties:

- `ONENEXA_ONBOARDING_ENDPOINT`: the full backend endpoint ending in `/api/commercial-console/onboarding/google-form-submissions`
- `ONENEXA_WEBHOOK_SECRET`: exactly the same secret as `COMMERCIAL_ONBOARDING_WEBHOOK_SECRET`

Then select `installOnboardingSubmitTrigger` and click Run once; approve the Google permissions. Make a test submission and review the Apps Script Executions logs and backend logs.

## Platform-owner approval

The approval page uses the invoice issuer company selected in Company Master. Before approval, confirm the modules/pages, user limit, validity, amount, and issuer company. The backend calls the repository's existing commercial generator rather than creating a parallel license schema.

## Important deployment/test notes

- Use the exact backend API URL configured for this repository's production deployment.
- The Google Form question titles are matched case-insensitively against the title aliases in `forwardOnboardingFormSubmit`. Update mappings there if the live Form labels differ.
- The webhook endpoint fails closed (503) when `COMMERCIAL_ONBOARDING_WEBHOOK_SECRET` is missing and rejects requests with an incorrect header secret.
- A full frontend build, backend import test, and end-to-end Google Form submission have not yet been run in this remote editing session. Do not treat the branch as production-verified until those checks pass.
