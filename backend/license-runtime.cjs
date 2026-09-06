const fs = require('fs');
const path = require('path');

const LICENSE_ENFORCEMENT = String(process.env.LICENSE_ENFORCEMENT || 'false').toLowerCase() === 'true';
const LICENSE_API_URL = String(process.env.LICENSE_API_URL || 'http://localhost:3100/api').replace(/\/$/, '');
const LICENSE_ACTIVATION_PATH = process.env.LICENSE_ACTIVATION_PATH || path.join(process.cwd(), 'backend', '.data', 'activation.json');
const OFFLINE_GRACE_MINUTES = Math.max(0, Number(process.env.LICENSE_OFFLINE_GRACE_MINUTES || 120));
const CHECK_INTERVAL_MS = Math.max(15000, Number(process.env.LICENSE_CHECK_INTERVAL_SECONDS || 60) * 1000);

function ensureDir() { fs.mkdirSync(path.dirname(LICENSE_ACTIVATION_PATH), { recursive: true }); }
function readState() {
  try { return JSON.parse(fs.readFileSync(LICENSE_ACTIVATION_PATH, 'utf8')); } catch { return null; }
}
function writeState(state) {
  ensureDir();
  const tmp = `${LICENSE_ACTIVATION_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, LICENSE_ACTIVATION_PATH);
}

let cached = readState();
let checking = null;

async function licensingPost(endpoint, body) {
  const response = await fetch(`${LICENSE_API_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.detail || payload.reason || `Licensing server returned ${response.status}`);
  return payload;
}

async function refreshLicense(force = false) {
  if (!LICENSE_ENFORCEMENT) return { valid: true, license: { modules: ['TASKS', 'INVOICING', 'ACCOUNTING', 'HRMS'] } };
  if (!cached) return { valid: false, reason: 'Taskosphere installation is not activated.' };
  const checkedAt = Date.parse(cached.checked_at || cached.activated_at || 0);
  if (!force && cached.status?.valid && Date.now() - checkedAt < CHECK_INTERVAL_MS) return cached.status;
  if (checking) return checking;

  checking = (async () => {
    try {
      const result = await licensingPost('/licensing/heartbeat', {
        license_key: cached.license_key,
        installation_id: cached.installation_id,
      });
      const now = new Date().toISOString();
      cached = { ...cached, checked_at: now, status: { valid: !!result.valid, reason: result.reason, license: result.license, checked_at: now } };
      writeState(cached);
      return cached.status;
    } catch (error) {
      const age = Date.now() - Date.parse(cached.checked_at || cached.activated_at || 0);
      if (cached.status?.valid && OFFLINE_GRACE_MINUTES > 0 && age <= OFFLINE_GRACE_MINUTES * 60000) {
        return { ...cached.status, reason: 'Licensing server temporarily unavailable; offline grace period active.' };
      }
      return { valid: false, reason: error.message || 'Unable to verify license.' };
    } finally {
      checking = null;
    }
  })();
  return checking;
}

function moduleForPath(pathname) {
  const value = String(pathname || '').replace(/^\/api/, '').replace(/^\//, '');
  if (/^(tasks|todos|attendance|reminders|action-center|visits|ai-reader|dashboard)/.test(value)) return 'TASKS';
  if (/^(invoicing|invoices)/.test(value)) return 'INVOICING';
  if (/^(purchase|purchase-invoices|bank-accounts|bank-transactions|chart-of-accounts|journal-entries|accounting-reports|zero-touch-entry|gst-portal-sync|accounting-integrity|day-book|cash-bank-book|cash-flow|outstanding-report|bank-reconciliation|depreciation|tds-tcs|financial-ratios|comparative-report|yearly-report|opening-balances|accounting-audit-trail|bulk-import)/.test(value)) return 'ACCOUNTING';
  if (/^(leave|payroll|hr|recruitment|people-matrix|staff-activity|users)/.test(value)) return 'HRMS';
  return null;
}

function exempt(pathname) {
  const value = String(pathname || '');
  return value === '/health' || value === '/api/health' || value.startsWith('/api/auth/') || value.startsWith('/auth/') || value.startsWith('/api/licensing/') || value.startsWith('/licensing/');
}

function createEnforcementMiddleware() {
  return async function licenseMiddleware(req, res, next) {
    const pathname = req.path || req.originalUrl || '';

    if (exempt(pathname)) return next();
    if (!LICENSE_ENFORCEMENT) return next();

    const module = moduleForPath(pathname);
    if (!module) return next();

    const status = await refreshLicense(false);
    if (!status.valid) {
      return res.status(403).json({
        error: 'LICENSE_REQUIRED',
        detail: status.reason || 'A valid Taskosphere license is required.',
      });
    }

    const modules = Array.isArray(status.license?.modules) ? status.license.modules : [];
    if (!modules.includes(module)) {
      return res.status(403).json({
        error: 'MODULE_NOT_LICENSED',
        module,
        detail: `Your Taskosphere license does not include the ${module} module.`,
      });
    }

    return next();
  };
}

async function handleLocalLicenseRoute(req, res) {
  const pathname = req.path || '';
  if (pathname === '/licensing/installation-activate' && req.method === 'POST') {
    try {
      const licenseKey = String(req.body?.license_key || '').trim().toUpperCase();
      const installationId = String(req.body?.installation_id || '').trim();
      const installationName = String(req.body?.installation_name || 'Taskosphere Installation').trim();
      if (!licenseKey || !installationId) return res.status(400).json({ detail: 'License key and installation ID are required.' });
      const result = await licensingPost('/licensing/activate', { license_key: licenseKey, installation_id: installationId, installation_name: installationName });
      const now = new Date().toISOString();
      cached = {
        license_key: licenseKey,
        installation_id: installationId,
        installation_name: installationName,
        activated_at: now,
        checked_at: now,
        status: { valid: true, license: result.license, checked_at: now },
      };
      writeState(cached);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ detail: error.message || 'Activation failed.' });
    }
  }

  if (pathname === '/licensing/status' && req.method === 'GET') {
    const status = await refreshLicense(true);
    return res.status(status.valid ? 200 : 403).json(status);
  }

  return false;
}

function patchExpress() {
  const modulePath = require.resolve('express');
  const originalExpress = require(modulePath);
  if (originalExpress.__taskosphereLicensePatched) return;

  function wrappedExpress(...args) {
    const app = originalExpress(...args);
    if (!app.__taskosphereLicenseInstalled) {
      const originalUse = app.use.bind(app);
      const middleware = createEnforcementMiddleware();

      app.use = function patchedUse(...useArgs) {
        return originalUse(...useArgs);
      };

      // Install the licensing middleware before the application's own router.
      originalUse(async (req, res, next) => {
        if (req.path === '/api/licensing/installation-activate' || req.path === '/licensing/installation-activate' || req.path === '/api/licensing/status' || req.path === '/licensing/status') {
          const handled = await handleLocalLicenseRoute(req, res);
          if (handled !== false) return;
        }
        return middleware(req, res, next);
      });
      app.__taskosphereLicenseInstalled = true;
    }
    return app;
  }

  Object.assign(wrappedExpress, originalExpress);
  wrappedExpress.__taskosphereLicensePatched = true;
  require.cache[modulePath].exports = wrappedExpress;
}

patchExpress();
