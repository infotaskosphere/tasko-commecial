# Task-O-Sphere performance update

This bundle contains complete replacement source files based on the uploaded audit. It updates route/data loading and changes the Dashboard from requesting up to 500 full task records to requesting a compact, permission-scoped summary.

## Files to replace or add

Replace these files with the full versions in this bundle:

- `frontend/src/App.jsx` — prefetches route chunks on pointer-down or keyboard focus instead of incidental pointer hover.
- `frontend/src/lib/api.js` — dynamically loads the development mock backend only when the development/offline fallback is needed.
- `frontend/src/pages/Dashboard.jsx` — uses the compact task summary, removes the duplicate rankings request, avoids idle preloading of the Tasks page, and retains the New Task intent preload.
- `backend/server_modules/dashboard_ops.py` — preserves the existing dashboard operations and registers the new summary router.

Add this new backend endpoint and regression test:

- `backend/server_modules/dashboard_task_summary.py`
- `backend/tests/test_dashboard_task_summary_contract.py`

Keep the paths shown above when copying the files into the project. No database migration or new index is included.

## What the summary endpoint does

`GET /api/dashboard/task-summary` returns at most 17 projected task rows for the three Dashboard lists (5 recent, 6 assigned to the signed-in user, and 6 assigned by the signed-in user). MongoDB computes the task counts, personal overdue/completion metrics, team breakdown, today's assignments, and 7-day trend. The endpoint applies the same Tasks module permission and visibility rules as `GET /api/tasks`, adds an explicit company filter, and resolves referenced users/clients through tenant-scoped collections.

## Checks performed

- Python syntax compilation passed for the new endpoint, route wrapper, and regression test.
- `node --check frontend/src/lib/api.js` passed.
- Static checks confirmed the Dashboard no longer requests `/tasks?page=1&page_size=500`.
- Backend tests and the Vite production build were not run in this workspace: the uploaded archive has no installed frontend dependencies, and this environment has no FastAPI/Pytest backend dependencies. Run the project's normal backend test suite and `npm run build` after copying the files.
