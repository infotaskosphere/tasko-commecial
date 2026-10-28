'use strict';

/**
 * agent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Taskosphere Agent — Main Entry Point (Enterprise Edition)
 *
 * Integrates all modules into a unified agent:
 *
 *   1. EXPRESS SERVER — Local HTTP API (backward compatible with v3)
 *   2. ACTIVITY TRACKER — Active window monitoring (existing)
 *   3. BROWSER TRACKER — Chrome/Edge/Firefox tracking (new)
 *   4. DSC WATCHER — Smart card detection (existing, enhanced)
 *   5. USB MONITOR — Device connect/disconnect events (new)
 *   6. IDLE DETECTOR — User idle time detection (new)
 *   7. PRODUCTIVITY ENGINE — Metrics computation (new)
 *   8. HEALTH MONITOR — Heartbeat and health tracking (new)
 *   9. NOTIFICATION RECEIVER — Backend → Desktop notifications (new)
 *  10. OFFLINE QUEUE — SQLite queue for offline mode (new)
 *  11. AUTO UPDATER — Version check and silent update (new)
 *  12. SYSTEM TRAY — Windows tray icon and menu (new)
 *  13. WINDOWS SERVICE — Auto-start with Windows (new)
 *
 * Design principles:
 *   - Silent background execution
 *   - No console window, no splash, no taskbar
 *   - Low CPU (<2%), Low RAM (<100MB)
 *   - Automatic recovery after crash/sleep/hibernate/reconnect
 *   - All modules independently recoverable
 */

const express         = require('express');
const cors            = require('cors');
const os              = require('os');
const path            = require('path');
const crypto          = require('crypto');

// ── Command-line flag handling (for NSIS installer) ──────────────────────────
const args = process.argv.slice(2);

if (args.includes('--install-service')) {
  console.log('[agent] Installing Windows service...');
  const { execSync } = require('child_process');
  try {
    execSync('node service.js install', { stdio: 'inherit', cwd: __dirname });
    console.log('[agent] Service installed successfully');
    process.exit(0);
  } catch (err) {
    console.error('[agent] Failed to install service:', err.message);
    process.exit(1);
  }
}

if (args.includes('--uninstall-service')) {
  console.log('[agent] Uninstalling Windows service...');
  const { execSync } = require('child_process');
  try {
    execSync('node service.js remove', { stdio: 'inherit', cwd: __dirname });
    console.log('[agent] Service uninstalled successfully');
    process.exit(0);
  } catch (err) {
    console.error('[agent] Failed to uninstall service:', err.message);
    process.exit(1);
  }
}

// ── Existing modules (reused, not replaced) ──────────────────────────────────
const { readCertFromPcSc } = require('./pcscReader');
const dscWatcher           = require('./dscWatcher');
const activityTracker      = require('./activityTracker');
const config               = require('./config');
const apiClient            = require('./apiClient');

// ── New modules ──────────────────────────────────────────────────────────────
const browserTracker       = require('./modules/browserTracker');
const usbMonitor           = require('./modules/usbMonitor');
const idleDetector         = require('./modules/idleDetector');
const productivityEngine   = require('./modules/productivityEngine');
const healthMonitor        = require('./modules/healthMonitor');
const notificationReceiver = require('./modules/notificationReceiver');
const offlineQueue         = require('./modules/offlineQueue');
const autoUpdater          = require('./modules/autoUpdater');
const systemInfo           = require('./modules/systemInfo');
const tray                 = require('./modules/tray');

// ── Constants ────────────────────────────────────────────────────────────────
const PORT         = config.AGENT_PORT;
const AGENT_VERSION = require('./package.json').version;
const AGENT_ID     = crypto
  .createHash('sha256')
  .update(os.hostname() + '|' + os.platform() + '|' + (os.cpus()[0]?.model || ''))
  .digest('hex')
  .slice(0, 16);

// ── Auth state (shared across modules) ───────────────────────────────────────
let authToken = null;
let authUserId = null;

function getToken() { return authToken; }

// ── Sync orchestrator ────────────────────────────────────────────────────────

async function syncAll() {
  if (!authToken || !authUserId) {
    console.log('[agent] No auth — skipping sync');
    return;
  }

  console.log('[agent] Running full sync...');

  // 1. Activity
  try {
    const actReport = activityTracker.getReport();
    const idleMetrics = idleDetector.getMetrics();
    await apiClient.post('/api/desktop/activity', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      date:         new Date().toISOString().slice(0, 10),
      ...actReport,
      idleSeconds:  idleMetrics.idleSeconds,
      focusSeconds: idleMetrics.activeSeconds,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/activity', {
      agent_id: AGENT_ID, user_id: authUserId, machine_name: os.hostname(),
      ...activityTracker.getReport(),
    }, authToken, 5);
    console.error('[agent] Activity sync failed:', e.message);
  }

  // 2. Browser
  try {
    const browserReport = browserTracker.getReport();
    await apiClient.post('/api/desktop/browser', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      ...browserReport,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/browser', {
      agent_id: AGENT_ID, user_id: authUserId,
      ...browserTracker.getReport(),
    }, authToken, 4);
  }

  // 3. DSC
  try {
    const dscStatus = dscWatcher.getStatus();
    await apiClient.post('/api/desktop/dsc', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      plugged:      dscStatus.plugged,
      cert:         dscStatus.cert,
      reader:       dscStatus.reader,
      connected_at: dscStatus.insertedAt,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/dsc', {
      agent_id: AGENT_ID, user_id: authUserId,
      ...dscWatcher.getStatus(),
    }, authToken, 3);
  }

  // 4. USB
  try {
    const usbEvents = usbMonitor.getPendingEvents();
    if (usbEvents.length > 0) {
      await apiClient.post('/api/desktop/usb', {
        agent_id:     AGENT_ID,
        user_id:      authUserId,
        machine_name: os.hostname(),
        events:       usbEvents,
      }, authToken);
    }
  } catch (e) {
    console.error('[agent] USB sync failed:', e.message);
  }

  // 5. Productivity
  try {
    const actReport    = activityTracker.getReport();
    const browserReport = browserTracker.getReport();
    const prodMetrics  = productivityEngine.computeMetrics(actReport, browserReport);
    await apiClient.post('/api/desktop/productivity', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      ...prodMetrics,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/productivity', {
      agent_id: AGENT_ID, user_id: authUserId,
      ...productivityEngine.computeMetrics(activityTracker.getReport(), browserTracker.getReport()),
    }, authToken, 2);
  }

  // 6. Process offline queue
  try {
    await processOfflineQueue();
  } catch (e) {
    console.error('[agent] Offline queue processing failed:', e.message);
  }

  console.log('[agent] Sync complete');
}

async function processOfflineQueue() {
  const items = offlineQueue.getReadyItems(10);
  for (const item of items) {
    try {
      await apiClient.post(item.endpoint, item.payload, item.token || authToken);
      offlineQueue.markSent(item.dedup_key);
      console.log(`[offline] Synced: ${item.endpoint}`);
    } catch (e) {
      offlineQueue.markFailed(item.dedup_key);
      console.error(`[offline] Retry failed: ${item.endpoint} (attempt ${item.retries + 1})`);
    }
  }
}

// ── Express Server (backward compatible) ─────────────────────────────────────

const app = express();
app.use(express.json());

// Exact allowlist. A wildcard such as *.onrender.com lets ANY site hosted on
// that platform read DSC/activity data from this machine and replace the
// agent's auth token, so only the real Taskosphere frontends are accepted.
// Extra origins: TASKOSPHERE_AGENT_ALLOWED_ORIGINS=https://a.com,https://b.com
const AGENT_ALLOWED_ORIGINS = new Set([
  'https://taskosphere.com',
  'https://www.taskosphere.com',
  'https://tasko-commercial-frontend.vercel.app',
  'https://tasko-commecial-frontend.vercel.app',
  'https://final-taskosphere-frontend.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  ...String(process.env.TASKOSPHERE_AGENT_ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim()).filter(Boolean),
]);

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header = a local process (not a web page); browsers always
    // send Origin on cross-origin requests.
    if (!origin) return callback(null, true);
    if (AGENT_ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    callback(new Error('CORS: origin not allowed: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

// ── Existing endpoints (preserved) ───────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    agent:    'taskosphere-agent',
    version:  AGENT_VERSION,
    agent_id: AGENT_ID,
    features: [
      'dsc-watch', 'dsc-autofill', 'dsc-read',
      'activity-tracking', 'browser-tracking', 'usb-monitor',
      'idle-detection', 'productivity', 'notifications',
      'offline-queue', 'auto-update', 'system-tray',
    ],
    health: healthMonitor.getStatus(),
  });
});

app.get('/dsc-status', (req, res) => {
  res.json(dscWatcher.getStatus());
});

app.get('/dsc-autofill', (req, res) => {
  res.json(dscWatcher.getAutofillFields());
});

app.get('/read-dsc', async (req, res) => {
  const pin = (req.query.pin || '').trim();
  if (!pin) return res.status(400).json({ success: false, error: 'PIN is required' });
  try {
    const cert = await readCertFromPcSc(pin);
    res.json({ success: true, cert });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Auto-auth endpoint (called by web app automatically) ─────────────────────
app.post('/api/auth', (req, res) => {
  const { token, user_id } = req.body || {};
  if (!token || !user_id) return res.status(400).json({ success: false, error: 'token and user_id required' });

  console.log(`[agent] Auto-auth received for user: ${user_id}`);

  authToken  = token;
  authUserId = user_id;

  // Propagate to all modules
  activityTracker.setAuth(token, user_id);
  notificationReceiver.setAuth(token, user_id);
  autoUpdater.setAuth(token);

  // Start health monitor (with userId for backend linking)
  try {
    healthMonitor.start(AGENT_ID, os.hostname(), AGENT_VERSION, getToken, () => authUserId, 30000);
  } catch (e) {
    console.warn('[agent] Health monitor could not start:', e.message);
  }

  // Start notification receiver
  try {
    notificationReceiver.start(60000);
  } catch (e) {
    console.warn('[agent] Notification receiver could not start:', e.message);
  }

  // Start auto updater
  try {
    autoUpdater.start(3600000); // check every hour
  } catch (e) {
    console.warn('[agent] Auto updater could not start:', e.message);
  }

  // Push system info immediately
  try {
    const sysInfo = systemInfo.getSystemInfo(AGENT_VERSION);
    apiClient.post('/api/desktop/system', {
      agent_id: AGENT_ID,
      ...sysInfo,
    }, authToken).catch(() => {});
  } catch {}

  console.log('[agent] ✓ All modules started — monitoring active');

  res.json({ success: true, message: 'Agent authenticated and monitoring', agent_id: AGENT_ID });
});

// ── Legacy auth endpoint (backward compatibility) ───────────────────────────
app.post('/activity/auth', (req, res) => {
  const { token, user_id } = req.body || {};
  if (!token || !user_id) return res.status(400).json({ success: false, error: 'token and user_id required' });

  authToken  = token;
  authUserId = user_id;

  // Propagate to all modules
  activityTracker.setAuth(token, user_id);
  notificationReceiver.setAuth(token, user_id);
  autoUpdater.setAuth(token);

  // Start health monitor (with userId for backend linking)
  try {
    healthMonitor.start(AGENT_ID, os.hostname(), AGENT_VERSION, getToken, () => authUserId, 30000);
  } catch (e) {
    console.warn('[agent] Health monitor could not start:', e.message);
  }

  // Start notification receiver
  try {
    notificationReceiver.start(60000);
  } catch (e) {
    console.warn('[agent] Notification receiver could not start:', e.message);
  }

  // Start auto updater
  try {
    autoUpdater.start(3600000); // check every hour
  } catch (e) {
    console.warn('[agent] Auto updater could not start:', e.message);
  }

  // Push system info immediately
  try {
    const sysInfo = systemInfo.getSystemInfo(AGENT_VERSION);
    apiClient.post('/api/desktop/system', {
      agent_id: AGENT_ID,
      ...sysInfo,
    }, authToken).catch(() => {});
  } catch {}

  res.json({ success: true, message: 'Auth set for all modules', agent_id: AGENT_ID });
});

app.get('/activity/report', (req, res) => {
  res.json({ success: true, report: activityTracker.getReport() });
});

app.post('/activity/push', async (req, res) => {
  try {
    await syncAll();
    res.json({ success: true, message: 'Full sync completed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── New endpoints ────────────────────────────────────────────────────────────

app.get('/browser/report', (req, res) => {
  res.json({ success: true, report: browserTracker.getReport() });
});

app.get('/usb/events', (req, res) => {
  res.json({ success: true, events: usbMonitor.getAllEvents() });
});

app.get('/idle/status', (req, res) => {
  res.json({ success: true, ...idleDetector.getMetrics() });
});

app.get('/productivity', (req, res) => {
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const metrics      = productivityEngine.computeMetrics(actReport, browserReport);
  res.json({ success: true, metrics });
});

app.get('/productivity/weekly', (req, res) => {
  // Return weekly aggregate from stored daily data
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const daily        = [productivityEngine.computeMetrics(actReport, browserReport)];
  const weekly       = productivityEngine.computeWeekly(daily);
  res.json({ success: true, weekly });
});

app.get('/productivity/monthly', (req, res) => {
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const daily        = [productivityEngine.computeMetrics(actReport, browserReport)];
  const monthly      = productivityEngine.computeMonthly(daily);
  res.json({ success: true, monthly });
});

app.get('/productivity/export', (req, res) => {
  const format       = req.query.format || 'json';
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const metrics      = productivityEngine.computeMetrics(actReport, browserReport);
  const exported     = productivityEngine.exportReport(metrics, format);
  res.json({ success: true, format, data: exported });
});

app.get('/system/info', (req, res) => {
  res.json({ success: true, info: systemInfo.getSystemInfo(AGENT_VERSION) });
});

app.get('/notifications', (req, res) => {
  res.json({ success: true, message: 'Notifications are received via backend polling' });
});

app.post('/sync', async (req, res) => {
  try {
    await syncAll();
    res.json({ success: true, message: 'Sync completed', pending: offlineQueue.getQueueLength() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/offline/queue', (req, res) => {
  res.json({ success: true, pending: offlineQueue.getQueueLength() });
});

app.get('/update/check', async (req, res) => {
  try {
    const info = await autoUpdater.checkForUpdate();
    res.json({ success: true, ...info });
  } catch (err) {
    res.json({ success: true, update_available: false });
  }
});

// ── Startup ──────────────────────────────────────────────────────────────────

function startAllModules() {
  // 1. Offline queue
  offlineQueue.init();

  // 2. DSC watcher
  try {
    dscWatcher.startWatcher();
  } catch (e) {
    console.warn('[agent] DSC watcher could not start:', e.message);
  }

  // 3. Activity tracker
  try {
    activityTracker.start();
  } catch (e) {
    console.warn('[agent] Activity tracker could not start:', e.message);
  }

  // 4. Browser tracker
  try {
    browserTracker.start();
  } catch (e) {
    console.warn('[agent] Browser tracker could not start:', e.message);
  }

  // 5. USB monitor
  try {
    usbMonitor.start();
  } catch (e) {
    console.warn('[agent] USB monitor could not start:', e.message);
  }

  // 6. Idle detector
  try {
    idleDetector.start(60, 5000);
  } catch (e) {
    console.warn('[agent] Idle detector could not start:', e.message);
  }

  // 7. Health monitor (starts after auth is set)
  // Will be activated by /activity/auth endpoint

  // 8. Notification receiver (starts after auth is set)

  // 9. Auto updater (starts after auth is set)

  // 10. System tray
  try {
    tray.create({
      onDashboard:     () => console.log('[tray] Dashboard requested'),
      onSync:          () => syncAll(),
      onNotifications: () => console.log('[tray] Notifications requested'),
      onSettings:      () => console.log('[tray] Settings requested'),
      onAbout:         () => console.log(`[tray] Taskosphere Agent v${AGENT_VERSION}`),
      onRestart:       () => {
        console.log('[tray] Restarting agent...');
        const exe = process.execPath;
        const { spawn } = require('child_process');
        spawn(exe, process.argv.slice(1), { detached: true, stdio: 'inherit' }).unref();
        process.exit(0);
      },
      onExit: () => {
        console.log('[tray] Exiting...');
        stopAllModules();
        process.exit(0);
      },
    });
  } catch (e) {
    console.warn('[agent] System tray could not start:', e.message);
  }

  // Push system info
  try {
    const info = systemInfo.getSystemInfo(AGENT_VERSION);
    if (authToken) {
      apiClient.post('/api/desktop/system', {
        agent_id: AGENT_ID,
        ...info,
      }, authToken).catch(() => {});
    }
  } catch {}

  console.log('[agent] All modules started');
}

function stopAllModules() {
  activityTracker.stop();
  browserTracker.stop();
  usbMonitor.stop();
  idleDetector.stop();
  healthMonitor.stop();
  notificationReceiver.stop();
  autoUpdater.stop();
  tray.destroy();
}

// ── Start HTTP server and all modules ────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Taskosphere Agent v' + AGENT_VERSION.padEnd(5) + ' — Enterprise Edition              ║');
  console.log('║     Listening on http://127.0.0.1:' + PORT + '                    ║');
  console.log('║                                                              ║');
  console.log('║  Modules:                                                    ║');
  console.log('║    ✓ DSC token auto-detection (all Indian CAs)               ║');
  console.log('║    ✓ Activity tracking → pushed to backend                   ║');
  console.log('║    ✓ Browser tracking (Chrome, Edge, Firefox)                ║');
  console.log('║    ✓ USB device monitoring                                   ║');
  console.log('║    ✓ Idle time detection                                     ║');
  console.log('║    ✓ Productivity engine                                     ║');
  console.log('║    ✓ Health monitor + heartbeat                              ║');
  console.log('║    ✓ Notification receiver                                   ║');
  console.log('║    ✓ Offline queue (auto-sync)                               ║');
  console.log('║    ✓ Auto-update system                                      ║');
  console.log('║    ✓ System tray                                             ║');
  console.log('║                                                              ║');
  console.log(`║  Agent ID: ${AGENT_ID}                              ║`);
  console.log('║  Keep this window open while using Taskosphere.              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  startAllModules();
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down...');
  stopAllModules();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAllModules();
  process.exit(0);
});

// ── Crash recovery ───────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[agent] Uncaught exception:', err.message);
  offlineQueue.addLocalLog('error', 'Uncaught exception: ' + err.message);
  // Don't exit — try to recover
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent] Unhandled rejection:', reason);
  offlineQueue.addLocalLog('error', 'Unhandled rejection: ' + reason);
});

module.exports = { app, AGENT_ID, AGENT_VERSION };
